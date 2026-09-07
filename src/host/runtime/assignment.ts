/**
 * Task lifecycle operations (docs/06, 07.3, D11): assignment with chain
 * discipline, claim/token handshake, progress, completion with 完成即续派
 * notifications, failure with immediate same-member retry, and captain
 * interventions.
 *
 * SQLite 一步切换（docs/35 §3#14）：变更帧 = 锁 → 读快照 → 同步事务（发号/
 * 状态/事件/邮件同事务）→ 提交后异步收尾（文档渲染、唤醒）。指派路径特殊
 * （首派要起子会话，异步 I/O 必须在事务外），走 {@link dispatchCore} 帧。
 *
 * @module dsh-eteams/runtime/assignment
 */
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type {
  Actor,
  AttemptKind,
  AttemptRecord,
  ChainStation,
  DecisionRecord,
  MailMessage,
  TaskMemberRecord,
  TaskRecord,
  TeamState,
} from '../model/types.js';
import {
  applyTransition,
  hasUpcomingStation,
  nextChainStation,
  refreshDependencyStatus,
  taskSlug,
  unsatisfiedDependencies,
  wouldCycle,
} from '../model/taskMachine.js';
import { insertEventInTx } from '../state/events.js';
import { nextAutoincrementId } from '../state/db.js';
import {
  readTeamSync,
  withTeamTx,
  writeTeamInTx,
  type TeamKey,
  type TeamTx,
} from '../state/store.js';
import { locks, teamLockKey } from '../state/lock.js';
import { ETeamsError, generateToken, memberActor, stateRootOf, type RuntimeEnv } from './base.js';
import {
  findInstanceRow,
  latestInstanceRow,
  leaderRowOf,
  notifyCaptainInTx,
  queueNoticeInTx,
  readBox,
  requireMember,
  rootTaskIdOf,
  teamMainSessionOf,
  wakeMember,
  type Wake,
} from './notifier.js';
import { renderTeamDocs, taskDirAbs, teamWorkDirRel } from './docs.js';
import { sendAssignmentInTx, spawnMember } from './members.js';
import { readBuildPresence } from './roleBuilder.js';
import {
  cancelledNotice,
  declineMail,
  reportCompletedMail,
  reportFailedMail,
  suspendedNotice,
} from '../prompts/handoff/mails.js';
import { ensureTaskWorkDir, rmTree, withTeam } from './teamOps.js';

/** 空唤醒动作（收件人不存在/未起会话时的占位）。 */
const noWake: Wake = () => Promise.resolve(false);

/**
 * 事务内事件落笔（docs/35 §3#14）：seq = 0 由库发号 event_id；插入后回填。
 */
function emit(
  tx: TeamTx,
  teamId: number,
  actor: Actor,
  type: string,
  refs: { taskId?: number; attemptId?: number; payload?: Record<string, unknown> } = {},
): void {
  insertEventInTx(tx, teamId, {
    seq: 0,
    at: tx.now,
    actor,
    type,
    ...(refs.taskId !== undefined ? { taskId: refs.taskId } : {}),
    ...(refs.attemptId !== undefined ? { attemptId: refs.attemptId } : {}),
    ...(refs.payload !== undefined ? { payload: refs.payload } : {}),
  });
}

/** 提交后依次执行唤醒动作（失败互不拖累——邮箱里已落库，下轮轮询仍可见）。 */
async function runWakes(wakes: Wake[]): Promise<void> {
  for (const wake of wakes) {
    try {
      await wake();
    } catch {
      // 唤醒失败不回滚状态（docs/07.2）：成员下一轮轮询时仍会看到邮件。
    }
  }
}

/**
 * 领队/主会话锚点（起会话/唤醒用）。三级梯度（二十五轮 DA38 / 二十七轮
 * DA40 / 三十七轮 DA50；v6 锚点派生自任务行快照，docs/51）：
 * ① 本任务登记的主会话（缺时退同队首个任务快照，teamMainSessionOf）仍在
 *    册就用它；
 * ② 不在册则用客户端活跃会话心跳（POST /presence 落盘，60s 内有效）定位
 *    用户正在看的对话——用领队视角看，主会话窗口永远在线，不存在「领队会
 *    话离线」这个需要报错的状态；
 * ③ 快照记得主会话 ID 但两锚都不在册时冷恢复（DA50，用户拍板「直接跳到
 *    这个会话启动任务」）：agents.resume 按持久化会话 ID 无窗复活主会话
 *    （不跑任何回合，只当派发父锚；句柄不 dispose——复活会话像用户开着的
 *    窗口一样常驻到进程回收），起人/接力不再要求用户先开窗口。运行时版本
 *    门控与恢复失败都落回 undefined（ensureSpawned 报错提示）。
 * 返回的可能是「非快照」的主会话锚点（②心跳锚点）——调用方（ensureSpawned）
 * 在用它起人前补章未登记的任务行快照；①③ 与快照同 ID，补章是 no-op。
 */
async function captainFor(
  env: RuntimeEnv,
  team: TeamState,
  task: TaskRecord,
): Promise<Agent | undefined> {
  const mainSession = (task.mainSessionId ?? '') || teamMainSessionOf(team);
  if (mainSession !== '') {
    const live = env.ctx.agents.get(mainSession);
    if (live !== undefined) return live;
  }
  const presence = readBuildPresence(stateRootOf(env));
  if (presence !== null) {
    const live = env.ctx.agents.get(presence.sessionId);
    if (live !== undefined) return live;
  }
  // 三十七轮 DA50（用户「直接跳到这个会话启动任务」）：快照与心跳都不在册
  // 但任务行记得主会话 ID 时冷恢复——agents.resume 按持久化会话 ID 无窗复活
  // 主会话（不跑回合只当父锚；句柄不 dispose）。运行时版本门控（resume 缺
  // 失）与恢复失败（会话记录被回收）都落 undefined 走原报错。
  if (mainSession !== '') {
    try {
      const handle = await env.ctx.agents.resume?.({
        resumeSessionId: mainSession as unknown as SessionId,
        signal: env.signal,
      });
      if (handle !== undefined) {
        env.ctx.logger.warn(`eteams: 主会话锚点离线，已按任务行快照冷恢复主会话（${mainSession}）`);
        return handle.agent;
      }
    } catch (error) {
      env.ctx.logger.warn(`eteams: 主会话冷恢复失败（${mainSession}）：${String(error)}`);
    }
  }
  return undefined;
}

/**
 * Create a task with contract + optional execution chain (docs/07.3.1).
 * docs/26：`kind:'group'` 即对话提交的主任务容器（不经执行链、无依赖）；小
 * 任务声明 `parentTaskId` 挂到组下——chain 站点即成员槽（可多成员接力），
 * 文件夹嵌套在组文件夹 sub/ 下。建队即可用（docs/35 §5#1，无计划期）：新
 * 任务一律 ready；建任务即分配 work_dir 并物化文档树。
 */
export async function createTask(
  env: RuntimeEnv,
  who: OpActor,
  params: {
    subject: string;
    /** docs/26：主任务容器（eteams_submit_task / 面板新建任务单）。 */
    kind?: 'group' | 'task';
    /** docs/26：拆解小任务、挂到对应组任务下（成员槽 = chain 站点）。 */
    parentTaskId?: number;
    description?: string;
    /** 合同 MD 全文（十六轮 DA29：原四数组合并为一篇 Markdown）。 */
    contractMd?: string;
    idempotencyNote?: string;
    dependencies?: number[];
    chain?: { member: string; stageBrief: string }[];
    /** v6 主会话快照显式源（面板路由透传 body.sessionId；导入传旧值）。 */
    mainSessionId?: string;
  },
): Promise<TaskRecord> {
  const { subject } = params;
  if (!subject || subject.trim() === '') throw new ETeamsError('任务主题不能为空');
  const out = await withTeam(env, who.teamId, (team, _root, tx) => {
    const deps = params.dependencies ?? [];
    const chain = params.chain ?? [];
    for (const station of chain) {
      if (station.stageBrief.trim() === '')
        throw new ETeamsError(`站点「${station.member}」的 stageBrief 不能为空`);
    }
    // docs/26 validation: groups are containers (no chain/deps/parent); a
    // subtask's parent must be a live group task (parent_id 空 = 大任务).
    const kind = params.kind ?? 'task';
    if (
      kind === 'group' &&
      (chain.length > 0 || deps.length > 0 || params.parentTaskId !== undefined)
    ) {
      throw new ETeamsError(
        '主任务（任务单）是容器：不接受执行链、依赖或父任务',
        '拆解小任务时用 parentTaskId 挂到主任务下',
      );
    }
    let parent: TaskRecord | undefined;
    if (params.parentTaskId !== undefined) {
      parent = team.tasks.find((t) => t.id === params.parentTaskId);
      if (parent === undefined || parent.parentId !== null)
        throw new ETeamsError(`父任务 ${params.parentTaskId} 不存在或不是主任务（任务单）`);
      if (!['draft', 'ready'].includes(parent.status))
        throw new ETeamsError(`主任务 ${parent.id} 处于 ${parent.status}，不能再挂小任务`);
    }
    for (const dep of deps) {
      if (!team.tasks.some((t) => t.id === dep))
        throw new ETeamsError(`依赖任务 ${dep} 不存在`, '先创建被依赖任务，或检查任务 id');
    }
    for (const station of chain) {
      if (!team.members.some((m) => m.name === station.member)) {
        throw new ETeamsError(
          `执行链成员「${station.member}」不在团队中`,
          '先 eteams_add_member，或修正成员名',
        );
      }
    }
    // 发号（全库自增，docs/27）：id 在事务内取号后再判环（判环要把 id 放进
    // 依赖图，旧实现 map 全替换 id 是个 bug——现在直接用真号判）。
    const id = nextAutoincrementId(tx.db, 'task');
    if (wouldCycle(team.tasks, id, deps)) {
      throw new ETeamsError('依赖构成循环', '重新规划任务顺序');
    }
    const task: TaskRecord = {
      id,
      parentId: parent !== undefined ? parent.id : null,
      subject: subject.trim(),
      description: params.description,
      contractMd: params.contractMd,
      idempotencyNote: params.idempotencyNote,
      dependencies: deps,
      chain,
      chainCursor: -1,
      status: 'ready',
      // v6 主会话快照：建任务调用方会话（工具路径 = envForAgent 注入的
      // env.sessionId；面板路由显式透传；导入传旧值），落库后不变。
      mainSessionId: params.mainSessionId ?? env.sessionId,
      attempts: [],
      retryCount: 0,
      createdAt: tx.now,
      updatedAt: tx.now,
    };
    team.tasks.push(task);
    // work_dir 归任务（docs/35 §3#8）：建任务即分配，撞名 -N 后缀。
    task.workDir = ensureTaskWorkDir(env, team, task);
    emit(tx, team.id, who.actor, 'task.created', {
      taskId: task.id,
      payload: {
        subject: task.subject,
        deps,
        chain: chain.map((s) => s.member),
        status: task.status,
        workDir: task.workDir,
      },
    });
    return { team, task };
  });
  renderTeamDocs(env.workspace, out.team, (msg) => env.ctx.logger.warn(msg));
  return out.task;
}

/** Update an unclaimed task（draft/ready 可改，合同冻结后只读 — docs/06.4）。 */
export async function updateTask(
  env: RuntimeEnv,
  who: OpActor,
  params: {
    taskId: number;
    subject?: string;
    description?: string;
    /** 合同 MD 全文（十六轮 DA29：原四数组合并为一篇 Markdown）。 */
    contractMd?: string;
    idempotencyNote?: string;
    dependencies?: number[];
    chain?: { member: string; stageBrief: string }[];
  },
): Promise<TaskRecord> {
  const out = await withTeam(env, who.teamId, (team, _root, tx) => {
    const task = requireTask(team, params.taskId);
    if (!['draft', 'ready'].includes(task.status)) {
      throw new ETeamsError(
        `任务 ${task.id} 处于 ${task.status}，合同已冻结`,
        '未开始（draft/ready）的任务才可修改；执行期变更先取消后重建',
      );
    }
    if (params.dependencies !== undefined) {
      for (const dep of params.dependencies) {
        if (dep === task.id) throw new ETeamsError('任务不能依赖自身');
        if (!team.tasks.some((t) => t.id === dep)) throw new ETeamsError(`依赖任务 ${dep} 不存在`);
      }
      if (wouldCycle(team.tasks, task.id, params.dependencies))
        throw new ETeamsError('依赖构成循环');
    }
    if (params.chain !== undefined) {
      for (const station of params.chain) {
        if (!team.members.some((m) => m.name === station.member)) {
          throw new ETeamsError(`执行链成员「${station.member}」不在团队中`);
        }
      }
    }
    const oldDir = task.workDir;
    if (params.dependencies !== undefined) task.dependencies = params.dependencies;
    if (params.chain !== undefined) task.chain = params.chain;
    if (params.subject !== undefined && params.subject.trim() !== '')
      task.subject = params.subject.trim();
    if (params.description !== undefined) task.description = params.description;
    if (params.contractMd !== undefined) task.contractMd = params.contractMd;
    if (params.idempotencyNote !== undefined) task.idempotencyNote = params.idempotencyNote;
    task.updatedAt = tx.now;
    emit(tx, team.id, who.actor, 'task.updated', {
      taskId: task.id,
      payload: { fields: Object.keys(params).filter((k) => k !== 'taskId') },
    });
    // 改主题会改目录名（work_dir 归任务，docs/35 §3#8）：重算目标路径并改名，
    // 随本次快照一并落库；小任务目录在父目录 sub/ 下。
    renameTaskFolder(env, team, task, oldDir);
    return { team, task };
  });
  renderTeamDocs(env.workspace, out.team, (msg) => env.ctx.logger.warn(msg));
  return out.task;
}

/**
 * 改主题后的任务目录改名（work_dir 归任务，docs/35 §3#8）：按新主题重算
 * work_dir，与旧路径不同即 renameSync（中文路径安全）；父任务改名时 sub/
 * 下小任务的 work_dir 前缀一并更新。目标路径已被其他任务占用（主题改回
 * 历史名等）或旧目录未物化时静默跳过——文档渲染会在新路径补齐。渲染不
 * 阻塞状态（docs/07.2），失败只留旧目录孤儿。
 */
function renameTaskFolder(
  env: RuntimeEnv,
  team: TeamState,
  task: TaskRecord,
  oldDir: string | undefined,
): void {
  const parentDir =
    task.parentId !== null ? team.tasks.find((t) => t.id === task.parentId)?.workDir : undefined;
  if (task.parentId !== null && parentDir === undefined) return; // 父目录未物化，无从改名
  const nextDir =
    parentDir !== undefined
      ? `${parentDir}/sub/${taskSlug(task)}`
      : `${teamWorkDirRel(team)}/tasks/${taskSlug(task)}`;
  if (nextDir === oldDir) return;
  if (team.tasks.some((t) => t.id !== task.id && t.workDir === nextDir)) return;
  task.workDir = nextDir;
  if (oldDir === undefined || !existsSync(join(env.workspace, oldDir))) return;
  try {
    renameSync(join(env.workspace, oldDir), join(env.workspace, nextDir));
  } catch (error) {
    env.ctx.logger.warn(`eteams: 任务文件夹重命名失败（不阻塞状态）：${String(error)}`);
    return;
  }
  // 父任务整体改名：sub/ 下小任务的 work_dir 前缀一并更新（docs/26）。
  for (const sub of team.tasks) {
    if (sub.parentId === task.id && sub.workDir?.startsWith(`${oldDir}/sub/`)) {
      sub.workDir = `${nextDir}/sub/${sub.workDir.slice(oldDir.length + 5)}`;
    }
  }
}

/**
 * Delete an unclaimed task（draft/ready 未开始可删，docs/06.4）：组任务级联
 * 删除全部小任务（要求全部未开始）；任务文件夹一并移除（rmTree 手动递归，
 * 规避本机 rmSync 对中文路径的静默失效）。
 */
export async function deleteTask(env: RuntimeEnv, who: OpActor, taskId: number): Promise<void> {
  const out = await withTeam(env, who.teamId, (team, _root, tx) => {
    const task = requireTask(team, taskId);
    if (!['draft', 'ready'].includes(task.status))
      throw new ETeamsError(
        `任务 ${task.id} 处于 ${task.status}，只能删除未开始（draft/ready）任务`,
      );
    const doomed = [task, ...team.tasks.filter((t) => t.parentId === task.id)];
    for (const sub of doomed.slice(1)) {
      if (!['draft', 'ready'].includes(sub.status))
        throw new ETeamsError(
          `小任务 ${sub.id} 处于 ${sub.status}，主任务不能级联删除`,
          '先处理（删除）该小任务，或等它完成',
        );
    }
    const doomedIds = new Set(doomed.map((t) => t.id));
    for (const other of team.tasks) {
      if (doomedIds.has(other.id)) continue;
      if (other.dependencies.some((dep) => doomedIds.has(dep))) {
        throw new ETeamsError(`任务 ${task.id} 被其他任务依赖`, '先移除下游任务的依赖');
      }
    }
    // 被删任务的开放决策随任务作废（docs/27 decisions 只存 open 行）。
    for (const decision of team.pendingDecisions) {
      if (decision.status === 'open' && doomedIds.has(decision.taskId)) {
        decision.status = 'resolved';
        decision.resolvedAt = tx.now;
        decision.note = 'task deleted';
      }
    }
    // 指向被删任务的实例行 now_task_id 清空（working 行一并松绑）。
    for (const row of team.taskMembers) {
      if (row.nowTaskId !== null && doomedIds.has(row.nowTaskId)) {
        row.nowTaskId = null;
        if (row.status === 'working') row.status = 'ready';
      }
    }
    const dir = taskDirAbs(env.workspace, team, task);
    team.tasks = team.tasks.filter((t) => !doomedIds.has(t.id));
    emit(tx, team.id, who.actor, 'task.deleted', {
      taskId: task.id,
      payload: {
        subject: task.subject,
        ...(doomed.length > 1 ? { cascade: doomed.map((t) => t.id) } : {}),
      },
    });
    if (existsSync(dir)) {
      try {
        rmTree(dir);
      } catch (error) {
        env.ctx.logger.warn(`eteams: 任务文件夹删除失败（不阻塞状态）：${String(error)}`);
      }
    }
    return team;
  });
  renderTeamDocs(env.workspace, out, (msg) => env.ctx.logger.warn(msg));
}

/** Actor wrapper passed by the tool layer. */
export interface OpActor {
  teamId: number;
  actor: Actor;
}

/** 一次派发的准备结果（prepare 阶段产出，apply 阶段落笔）。 */
interface AssignmentPlan {
  task: TaskRecord;
  /** 执行者实例行（已起会话或本次首派起会话成功）。 */
  row: TaskMemberRecord;
  /** 任务有执行链（站点派发）。 */
  isStation: boolean;
  /** 链的下一站（isStation 时）。 */
  planned?: ChainStation;
  /** 链偏离留痕（D11）——有值即本次派发偏离了执行链。 */
  deviation?: string;
  kind: AttemptKind;
}

/**
 * 派发帧（docs/35 §3#14 + §5#3）：指派路径不能走 withTeam 帧——首派要起
 * 子会话（异步 I/O，必须在写事务外）。帧序：锁 → 读快照 → prepare（校验
 * + staged 起会话，只改内存快照）→ 同步事务 apply（发号/转移/事件/邮件，
 * fn 内不得 await）→ 提交后渲染文档 + 依次执行唤醒。任一步抛错快照即弃，
 * 库不留半步。
 */
async function dispatchCore(
  env: RuntimeEnv,
  teamId: TeamKey,
  actor: Actor,
  /** 派发锚任务：captainFor 按本任务行快照解析主会话（v6，docs/51）。 */
  anchorTaskId: number,
  prepare: (team: TeamState, captain: Agent | undefined) => Promise<AssignmentPlan>,
  apply: (
    team: TeamState,
    tx: TeamTx,
    plan: AssignmentPlan,
    wakes: Wake[],
  ) => {
    task: TaskRecord;
    attempt: AttemptRecord;
  },
): Promise<{ team: TeamState; task: TaskRecord; attempt: AttemptRecord }> {
  const root = stateRootOf(env);
  return locks.withLock(teamLockKey(root, String(teamId)), async () => {
    const team = readTeamSync(root, teamId);
    if (team === undefined) {
      throw new ETeamsError(
        `团队「${String(teamId)}」不存在`,
        '用 eteams_team_status 查看当前团队，或先 eteams_create_team',
      );
    }
    const anchorTask = team.tasks.find((t) => t.id === anchorTaskId);
    const plan = await prepare(
      team,
      anchorTask === undefined ? undefined : await captainFor(env, team, anchorTask),
    );
    const wakes: Wake[] = [];
    const result = withTeamTx(root, team.id, (tx) => {
      const out = apply(team, tx, plan, wakes);
      writeTeamInTx(tx, team);
      return out;
    });
    renderTeamDocs(env.workspace, team, (msg) => env.ctx.logger.warn(msg));
    await runWakes(wakes);
    return { team, ...result };
  });
}

/** Assign a ready task to one member (chain deviation enforced, D11). */
export async function assignTask(
  env: RuntimeEnv,
  who: OpActor,
  params: { taskId: number; member: string; deviationNote?: string; handoff?: string },
): Promise<{ team: TeamState; task: TaskRecord; attempt: AttemptRecord }> {
  return dispatchCore(
    env,
    who.teamId,
    who.actor,
    params.taskId,
    (team, captain) => prepareAssignment(env, team, captain, params),
    (team, tx, plan, wakes) =>
      applyAssignment(env, tx, team, who.actor, plan, { handoff: params.handoff }, wakes),
  );
}

/** 主任务整体开始的结果（二十五轮 DA38）：started = 成功派发的小任务数；
 * skipped = 未能派发的小任务（无链/依赖未满/占用/起会话失败等，原因随卡
 * 透出，面板行内就地提示）。 */
export interface GroupStartResult {
  started: number;
  skipped: { taskId: number; subject: string; reason: string }[];
}

/**
 * 组内执行序（客户端 executionOrderOf 同口径的宿主侧最小实现）：兄弟依赖
 * 拓扑序（被依赖者在前），同层保持建序（快照序）稳定；组外依赖不算排序
 * 约束（真实约束由派发核 prepareAssignment 兜）。二十七轮 DA40 链式接力
 * 的发棒顺序。
 */
function subExecutionOrder(subs: TaskRecord[]): TaskRecord[] {
  const siblingIds = new Set(subs.map((s) => s.id));
  const ordered: TaskRecord[] = [];
  const emitted = new Set<number>();
  let progress = true;
  while (ordered.length < subs.length && progress) {
    progress = false;
    for (const sub of subs) {
      if (emitted.has(sub.id)) continue;
      if (sub.dependencies.every((dep) => !siblingIds.has(dep) || emitted.has(dep))) {
        emitted.add(sub.id);
        ordered.push(sub);
        progress = true;
      }
    }
  }
  // 依赖环兜底（建库侧 wouldCycle 已防）：剩余卡按快照序补齐，不丢卡。
  for (const sub of subs) {
    if (!emitted.has(sub.id)) ordered.push(sub);
  }
  return ordered;
}

/**
 * Start a group task（二十五轮 DA38，用户拍板「主任务需要加开始按钮……
 * 主任务启动就代表着小任务需要逐个开始执行了」）：主任务是容器（无链、
 * 无依赖、不进执行）。
 *
 * 二十七轮 DA40（用户「整体开始，所有小任务链式执行」+ DA38「逐个开始
 * 执行」）：「开始」= **链式接力**——按组内执行序（subExecutionOrder：兄
 * 弟依赖拓扑序，同层建序）只派发**第一张**可跑的 ready 小任务，余下 ready
 * 卡以「等待链式接力」记入 skipped（等前棒完成由 {@link completeTask} 尾
 * 的续派自动交棒，不需要用户逐张点）。无链卡跳过（reason「需要选择成
 * 员」），派发被拒的卡按卡跳过（原因透出）后继续找下一棒。终态组
 * （completed/cancelled）整体开始直接报错，续派同样不会续终态组。
 */
export async function startGroupTask(
  env: RuntimeEnv,
  who: OpActor,
  taskId: number,
): Promise<GroupStartResult> {
  const team = readTeamSync(stateRootOf(env), who.teamId);
  if (team === undefined) {
    throw new ETeamsError(`团队「${String(who.teamId)}」不存在`);
  }
  const group = requireTask(team, taskId);
  if (group.parentId !== null || !team.tasks.some((t) => t.parentId === group.id)) {
    throw new ETeamsError(`任务 #${taskId} 不是主任务，无法整体开始`);
  }
  // 二十七轮 DA40：终态组（全部小任务完成收口 / 取消）不再整体开始。
  if (['completed', 'cancelled'].includes(group.status)) {
    throw new ETeamsError(
      `主任务 ${taskId} 已${group.status === 'completed' ? '完成' : '取消'}，无法整体开始`,
    );
  }
  const result: GroupStartResult = { started: 0, skipped: [] };
  for (const sub of subExecutionOrder(team.tasks.filter((t) => t.parentId === group.id))) {
    // 三十六轮 DA49（用户「任务点击开始没有反应」）：draft 小任务同进发棒
    // 序（DA37 待开始语义闭环——派发核会把 draft 晋升 ready 后派发，旧库
    // draft 小任务此前被静默跳过，点开始零反馈）。
    if (!['draft', 'ready'].includes(sub.status)) continue;
    const next = sub.chain[sub.chainCursor + 1];
    if (next === undefined) {
      result.skipped.push({
        taskId: sub.id,
        subject: sub.subject,
        reason: sub.chain.length === 0 ? '需要选择成员' : '执行链已到末站',
      });
      continue;
    }
    // 链式接力：一次只发一棒；已发过棒的余下 ready 卡进接力队列。
    if (result.started > 0) {
      result.skipped.push({
        taskId: sub.id,
        subject: sub.subject,
        reason: '等待链式接力（前一小任务完成后自动开始）',
      });
      continue;
    }
    try {
      await assignTask(env, who, { taskId: sub.id, member: next.member });
      result.started += 1;
    } catch (e) {
      result.skipped.push({
        taskId: sub.id,
        subject: sub.subject,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return result;
}

/**
 * 派发前置（docs/35 §5#3 首派按链起人）：校验任务状态/依赖/占用/链纪律，
 * staged（session_id 空）实例行先起子会话；成功置 working、锚定到
 * 大任务、回填 session_id，随本次写事务落库。只改内存快照，失败即
 * 整帧作废。改派路径（forReassign）目标任务可以在 wait/start/paused 等
 * 非 ready 态——合法性由调用方（reassignTask）校验。
 */
async function prepareAssignment(
  env: RuntimeEnv,
  team: TeamState,
  captain: Agent | undefined,
  params: {
    taskId: number;
    member: string;
    deviationNote?: string;
    kind?: AttemptKind;
    forReassign?: boolean;
  },
): Promise<AssignmentPlan> {
  const task = requireTask(team, params.taskId);
  const isStation = task.chain.length > 0;
  if (params.forReassign !== true) {
    // 三十六轮 DA49（用户「任务点击开始没有反应」）：draft 小任务派发即就绪
    // （draft→ready 合法边，依赖/占用校验随下方原样兜）——DA37 起 draft/ready
    // 面板同显「待开始」，旧库导入的 draft 小任务面板又没有晋升钮，状态闸
    // 再挡 ready 就是永久开不了、整体开始还零反馈。
    if (task.status === 'draft') applyTransition(task, 'ready', Date.now());
    if (task.status !== 'ready') {
      throw new ETeamsError(
        `任务 ${task.id} 处于 ${task.status}，只能指派 ready 任务`,
        task.status === 'wait' && task.blockedFrom !== undefined
          ? '任务被上游依赖阻塞：先推进依赖任务'
          : '检查任务状态，或用 eteams_reassign_task 改派',
      );
    }
    const unsat = unsatisfiedDependencies(team.tasks, task);
    if (unsat.length > 0) {
      throw new ETeamsError(`任务 ${task.id} 的依赖未完成：${unsat.join('、')}`, '先推进依赖任务');
    }
  }
  const row = resolveAssigneeRow(team, task, params.member);
  // 占用判定（实例行语义）：改派回原执行者时本任务自己的占用不算忙。
  assertNotBusy(team, row.name, params.forReassign === true ? task.id : undefined);
  const planned = nextChainStation(task);
  if (
    isStation &&
    planned !== undefined &&
    planned.member !== params.member &&
    (params.deviationNote ?? '').trim() === ''
  ) {
    throw new ETeamsError(
      `任务 ${task.id} 执行链下一站是「${planned.member}」，指派给「${params.member}」需要 deviation_note`,
      '偏离执行链必须留痕（D11）：说明改派原因，或改派链上成员',
    );
  }
  await ensureSpawned(env, team, row, task, captain);
  return {
    task,
    row,
    isStation,
    kind: params.kind ?? (isStation ? 'stage' : 'initial'),
    ...(planned !== undefined ? { planned } : {}),
    ...((params.deviationNote ?? '').trim() !== ''
      ? { deviation: params.deviationNote!.trim() }
      : {}),
  };
}

/**
 * 派发对象实例行（docs/35 §5#12 任务级操作按任务的大任务根选行）：先锚定
 * 行、退团队级行；都没有则按班底模板补一行 staged（旧数据兼容），模板也
 * 没有才报「不在团队中」。
 */
function resolveAssigneeRow(team: TeamState, task: TaskRecord, name: string): TaskMemberRecord {
  const root = rootTaskIdOf(task);
  const found = findInstanceRow(team, name, root);
  if (found !== undefined) return found;
  const template = team.members.find((m) => m.name === name);
  if (template === undefined) {
    throw new ETeamsError(`执行链成员「${name}」不在团队中`, '先 eteams_add_member，或修正成员名');
  }
  const row: TaskMemberRecord = {
    id: 0, // 落库时按 task_members 自增号发号（writeTeamInTx 回填）
    teamId: team.id,
    mainTaskId: root,
    nowTaskId: task.id,
    name,
    employeeId: template.employeeId ?? null,
    sessionId: '',
    status: 'staged',
    createdAt: Date.now(),
  };
  team.taskMembers.push(row);
  return row;
}

/** 占用判定（实例行语义，docs/35 §5#12）：该成员还有其他 working 实例行
 *  或未完结尝试即拒绝；exceptTaskId 用于改派回原执行者。 */
function assertNotBusy(team: TeamState, name: string, exceptTaskId?: number): void {
  const busyRow = team.taskMembers.find(
    (r) =>
      r.name === name &&
      r.status === 'working' &&
      (exceptTaskId === undefined || r.nowTaskId !== exceptTaskId),
  );
  const busyTask =
    busyRow !== undefined
      ? team.tasks.find(
          (t) =>
            t.id !== exceptTaskId &&
            t.assignee === name &&
            t.status !== 'completed' &&
            liveAttemptOf(t) !== undefined,
        )
      : undefined;
  if (busyRow === undefined && busyTask === undefined) return;
  throw new ETeamsError(
    `成员「${name}」正在执行 ${
      busyTask !== undefined ? `任务 ${busyTask.id} ${busyTask.subject}` : '其他任务'
    }`,
    '完成即续派：同一成员同一时刻只持有一个活动任务',
  );
}

/**
 * 首派起会话（docs/35 §5#3）：实例行 session_id 为空时由领队代理起
 * 持续子会话——异步 I/O，只能在写事务之前；成功后该行置 working、锚定到
 * 大任务并回填会话 id，随本次写事务落库。spawn 失败整帧作废（快照丢弃，
 * 库无半步残留）。
 */
async function ensureSpawned(
  env: RuntimeEnv,
  team: TeamState,
  row: TaskMemberRecord,
  task: TaskRecord,
  captain: Agent | undefined,
): Promise<void> {
  row.nowTaskId = task.id;
  if (row.mainTaskId === null) row.mainTaskId = rootTaskIdOf(task);
  if (row.sessionId !== '') {
    row.status = 'working';
    return;
  }
  if (captain === undefined) {
    // 三十七轮 DA50：到这里的只剩「无锚可恢复」（任务行未登记主会话）、
    // 旧运行时无 resume、恢复失败（会话记录被回收）三种——文案对齐三级
    // 梯度（快照/心跳/冷恢复都落空）。
    throw new ETeamsError(
      `成员「${row.name}」尚未起会话，主会话锚点不可用（不在线且无法冷恢复）`,
      '打开团队主会话窗口（在线即锚点回线），或把团队对话开着让客户端心跳定位主会话',
    );
  }
  // v6 补章（二十七轮 DA40 重锚的替身）：任务行未登记主会话时以本次派发
  // 锚点补登（面板旧客户端/无心跳建卡的场景）——已登记不改写（快照语义：
  // 落库后不变），①③ 与快照同 ID 时 no-op。只改内存快照，随本次派发写
  // 事务一并落库（帧内 spawn 失败即整帧作废）。
  if ((task.mainSessionId ?? '') === '') {
    task.mainSessionId = String(captain.id);
  }
  try {
    row.sessionId = await spawnMember(env, team, row, captain);
  } catch (error) {
    throw new ETeamsError(
      `成员「${row.name}」启动失败：${String(error)}`,
      '检查成员模型路线/子代理配置后重试指派',
    );
  }
  row.status = 'working';
}

/**
 * 派发落笔（写事务内）：发号尝试 → 转移 wait（已派待接取）→ 占用实例行 →
 * 事件 + 派发邮件（返回唤醒动作，提交后由 dispatchCore 执行）。
 */
function applyAssignment(
  env: RuntimeEnv,
  tx: TeamTx,
  team: TeamState,
  actor: Actor,
  plan: AssignmentPlan,
  opts: { handoff?: string },
  wakes: Wake[],
): { task: TaskRecord; attempt: AttemptRecord } {
  const { task, row, isStation } = plan;
  const attempt = makeAttempt(tx, task, {
    kind: plan.kind,
    member: row.name,
    stationIndex: isStation ? task.chainCursor + 1 : 0,
  });
  applyTransition(task, 'wait', tx.now);
  task.assignee = row.name;
  row.status = 'working';
  row.nowTaskId = task.id;
  emit(tx, team.id, actor, 'task.assigned', {
    taskId: task.id,
    attemptId: attempt.id,
    payload: {
      member: row.name,
      kind: attempt.kind,
      station: attempt.stationIndex,
      ...(plan.deviation !== undefined ? { deviation: plan.deviation } : {}),
    },
  });
  wakes.push(
    sendAssignmentInTx(env, tx, team, row, task, attempt.id, {
      ...(plan.planned !== undefined ? { stageBrief: plan.planned.stageBrief } : {}),
      ...(opts.handoff !== undefined ? { handoff: opts.handoff } : {}),
    }),
  );
  return { task, attempt };
}

/** Advance a chain task to its next station (docs/06.7, FR-36). */
export async function advanceTask(
  env: RuntimeEnv,
  who: OpActor,
  taskId: number,
  handoff?: string,
): Promise<{ team: TeamState; task: TaskRecord; attempt: AttemptRecord }> {
  return dispatchCore(
    env,
    who.teamId,
    who.actor,
    taskId,
    (team, captain) => {
      const task = requireTask(team, taskId);
      if (task.chain.length === 0) {
        throw new ETeamsError(
          `任务 ${task.id} 没有执行链`,
          '单站点任务直接 eteams_assign_task 指派',
        );
      }
      if (!hasUpcomingStation(task)) {
        throw new ETeamsError(
          `任务 ${task.id} 已无后续站点`,
          '检查 chainCursor：链已走完或尚未完成首站',
        );
      }
      return prepareAssignment(env, team, captain, {
        taskId,
        member: nextChainStation(task)!.member,
        kind: 'stage',
      });
    },
    (team, tx, plan, wakes) => applyAssignment(env, tx, team, who.actor, plan, { handoff }, wakes),
  );
}

/** Reassign an in-flight/awaiting task (revokes the live token). */
export async function reassignTask(
  env: RuntimeEnv,
  who: OpActor,
  params: { taskId: number; member?: string; deviationNote?: string },
): Promise<{ team: TeamState; task: TaskRecord; attempt: AttemptRecord }> {
  return dispatchCore(
    env,
    who.teamId,
    who.actor,
    params.taskId,
    (team, captain) => {
      const task = requireTask(team, params.taskId);
      const current = liveAttemptOf(task) ?? task.attempts.find((a) => a.status === 'paused');
      if (
        current === undefined &&
        !['ready', 'wait', 'start', 'paused', 'wait_decision', 'wait_user'].includes(task.status)
      ) {
        throw new ETeamsError(`任务 ${task.id} 处于 ${task.status}，无法改派`);
      }
      if (task.status === 'wait' && task.blockedFrom !== undefined && current === undefined) {
        // 阻塞物化（wait + blockedFrom）不是「已派待接取」：改派无意义。
        throw new ETeamsError(
          `任务 ${task.id} 被上游依赖阻塞，改派无意义`,
          '先推进依赖任务解除阻塞，或 eteams_update_task 调整依赖',
        );
      }
      const target = params.member ?? task.assignee;
      if (target === undefined) throw new ETeamsError('未指定改派目标成员');
      return prepareAssignment(env, team, captain, {
        taskId: task.id,
        member: target,
        deviationNote: params.deviationNote,
        kind: 'reassign',
        forReassign: true,
      });
    },
    (team, tx, plan, wakes) => applyReassignment(env, tx, team, who.actor, plan, wakes),
  );
}

/**
 * 改派落笔（写事务内）：吊销在办尝试 → 归位 wait（离开物化态即清
 * blockedFrom）→ 释放原执行者 → 开放决策收口 → 走通用派发落笔。
 */
function applyReassignment(
  env: RuntimeEnv,
  tx: TeamTx,
  team: TeamState,
  actor: Actor,
  plan: AssignmentPlan,
  wakes: Wake[],
): { task: TaskRecord; attempt: AttemptRecord } {
  const task = plan.task;
  revokeCurrentAttempt(tx, team, actor, task, 'reassign');
  if (task.status !== 'ready') applyTransition(task, 'wait', tx.now);
  freeMember(team, task);
  const decision = team.pendingDecisions.find((d) => d.status === 'open' && d.taskId === task.id);
  if (decision !== undefined) {
    decision.status = 'resolved';
    decision.resolvedAt = tx.now;
    decision.choice = 'reassign';
    emit(tx, team.id, actor, 'decision.resolved', {
      taskId: task.id,
      payload: { decisionId: decision.id, choice: 'reassign' },
    });
  }
  return applyAssignment(env, tx, team, actor, plan, { handoff: lastOutputOf(task) }, wakes);
}

/** 最近一次成功尝试的产出（改派交接用；无则 undefined）。 */
function lastOutputOf(task: TaskRecord): string | undefined {
  const succeeded = task.attempts.filter((a) => a.status === 'succeeded');
  return succeeded[succeeded.length - 1]?.result?.output;
}

/** Suspend a task (captain decision; docs/06.4). */
export async function suspendTask(
  env: RuntimeEnv,
  who: OpActor,
  taskId: number,
  note?: string,
): Promise<TaskRecord> {
  const out = await withTeam(env, who.teamId, (team, _root, tx) => {
    const task = requireTask(team, taskId);
    if (!['wait', 'start', 'ready'].includes(task.status)) {
      throw new ETeamsError(`任务 ${task.id} 处于 ${task.status}，无法挂起`);
    }
    const wakes: Wake[] = [];
    if (task.status === 'ready') {
      // 就绪任务挂起搭车物化（docs/36 建议 1）：wait + blockedFrom='ready' +
      // status_note，resume 按 blockedFrom 还原。status_note 必写——它是与
      // 「依赖阻塞物化」的区分判据。
      applyTransition(task, 'wait', tx.now);
      task.blockedFrom = 'ready';
      task.statusNote = note ?? '领队挂起（未留说明）';
    } else {
      // 释放前留档执行者：freeMember 会清 assignee，通知按它投递。
      const assignee = task.assignee;
      revokeCurrentAttempt(tx, team, who.actor, task, 'suspend');
      applyTransition(task, 'paused', tx.now);
      task.statusNote = note;
      freeMember(team, task);
      wakes.push(notifyMemberSuspendedInTx(env, tx, team, task, assignee, note));
    }
    emit(tx, team.id, who.actor, 'task.suspended', {
      taskId: task.id,
      payload: { note },
    });
    refreshDependentsInTx(tx, team, who.actor, task.id);
    return { team, task, wakes };
  });
  renderTeamDocs(env.workspace, out.team, (msg) => env.ctx.logger.warn(msg));
  await runWakes(out.wakes);
  return out.task;
}

/**
 * Resume a suspended task: 挂起的就绪任务（wait + blockedFrom + status_note）
 * 按 blockedFrom 还原并清说明；paused 任务给原执行者开新一轮尝试。
 */
export async function resumeTask(
  env: RuntimeEnv,
  who: OpActor,
  taskId: number,
): Promise<{ team: TeamState; task: TaskRecord; attempt?: AttemptRecord }> {
  return locks.withLock(teamLockKey(stateRootOf(env), String(who.teamId)), async () => {
    const root = stateRootOf(env);
    const team = readTeamSync(root, who.teamId);
    if (team === undefined) {
      throw new ETeamsError(
        `团队「${String(who.teamId)}」不存在`,
        '用 eteams_team_status 查看当前团队，或先 eteams_create_team',
      );
    }
    const task = requireTask(team, taskId);
    if (task.blockedFrom !== undefined && task.statusNote !== undefined) {
      // 挂起的就绪任务（suspendTask 的 ready 搭车物化）：还原到 blockedFrom。
      const out = withTeamTx(root, team.id, (tx) => {
        const target = task.blockedFrom;
        if (target === undefined) throw new ETeamsError(`任务 ${task.id} 无恢复目标`);
        applyTransition(task, target, tx.now);
        task.statusNote = undefined;
        emit(tx, team.id, who.actor, 'task.resumed', { taskId: task.id });
        writeTeamInTx(tx, team);
        return task.attempts[task.attempts.length - 1];
      });
      renderTeamDocs(env.workspace, team, (msg) => env.ctx.logger.warn(msg));
      return { team, task, ...(out !== undefined ? { attempt: out } : {}) };
    }
    if (task.status !== 'paused')
      throw new ETeamsError(`任务 ${task.id} 处于 ${task.status}，无法恢复`);
    // 挂起时执行者已释放（assignee 清空）：按最近一次尝试的成员恢复。
    const last = task.attempts[task.attempts.length - 1];
    const memberName = task.assignee ?? last?.member ?? thrower('挂起任务缺少执行成员记录');
    const row = resolveAssigneeRow(team, task, memberName);
    await ensureSpawned(env, team, row, task, await captainFor(env, team, task));
    const wakes: Wake[] = [];
    const attempt = withTeamTx(root, team.id, (tx) => {
      const fresh = makeAttempt(tx, task, {
        kind: 'reassign',
        member: row.name,
        stationIndex: task.chain.length > 0 ? task.chainCursor + 1 : 0,
      });
      applyTransition(task, 'wait', tx.now);
      task.assignee = row.name;
      row.status = 'working';
      row.nowTaskId = task.id;
      emit(tx, team.id, who.actor, 'task.resumed', {
        taskId: task.id,
        attemptId: fresh.id,
        payload: { member: row.name },
      });
      wakes.push(
        sendAssignmentInTx(env, tx, team, row, task, fresh.id, {
          ...(nextChainStation(task) !== undefined
            ? { stageBrief: nextChainStation(task)!.stageBrief }
            : {}),
        }),
      );
      writeTeamInTx(tx, team);
      return fresh;
    });
    renderTeamDocs(env.workspace, team, (msg) => env.ctx.logger.warn(msg));
    await runWakes(wakes);
    return { team, task, attempt };
  });
}

function thrower(message: string): never {
  throw new ETeamsError(message);
}

/** Cancel a task (captain; any non-terminal status). */
export async function cancelTask(
  env: RuntimeEnv,
  who: OpActor,
  taskId: number,
  reason?: string,
): Promise<TaskRecord> {
  const out = await withTeam(env, who.teamId, (team, _root, tx) => {
    const task = requireTask(team, taskId);
    const wakes: Wake[] = [];
    if (['wait', 'start', 'paused'].includes(task.status)) {
      // 释放前留档执行者：freeMember 会清 assignee，通知按它投递。
      const assignee = task.assignee;
      revokeCurrentAttempt(tx, team, who.actor, task, 'cancel');
      freeMember(team, task);
      wakes.push(notifyMemberCancelledInTx(env, tx, team, task, assignee, reason));
    }
    applyTransition(task, 'cancelled', tx.now);
    task.updatedAt = tx.now;
    const decision = team.pendingDecisions.find((d) => d.status === 'open' && d.taskId === task.id);
    if (decision !== undefined) {
      decision.status = 'resolved';
      decision.resolvedAt = tx.now;
      decision.choice = 'suspend';
      decision.note = 'task cancelled';
    }
    emit(tx, team.id, who.actor, 'task.cancelled', {
      taskId: task.id,
      payload: { reason },
    });
    refreshDependentsInTx(tx, team, who.actor, task.id);
    return { team, task, wakes };
  });
  renderTeamDocs(env.workspace, out.team, (msg) => env.ctx.logger.warn(msg));
  await runWakes(out.wakes);
  return out.task;
}

/** Member claims the assigned attempt → token handshake (docs/06.3). */
export async function claimTask(
  env: RuntimeEnv,
  team: TeamState,
  member: { name: string },
  taskId: number,
): Promise<{ attempt: AttemptRecord; token: string; task: TaskRecord; inboxPreview: string[] }> {
  const out = await withTeam(env, team.id, (fresh, _root, tx) => {
    const task = requireTask(fresh, taskId);
    if (task.assignee !== member.name) {
      throw new ETeamsError(
        `任务 ${task.id} 未指派给你（当前：${task.assignee ?? '无'}）`,
        '用 eteams_task_board 查看你的任务',
      );
    }
    const attempt = task.attempts.find(
      (a) => a.status === 'pending_accept' && a.member === member.name,
    );
    if (attempt === undefined) {
      throw new ETeamsError(
        `任务 ${task.id} 没有待接取的指派`,
        'attempt 可能已被吊销；等待领队重新指派',
      );
    }
    const row = requireMember(fresh, member.name);
    const token = generateToken();
    attempt.status = 'running';
    attempt.token = token;
    attempt.claimedAt = tx.now;
    applyTransition(task, 'start', tx.now);
    row.status = 'working';
    row.nowTaskId = task.id;
    emit(tx, fresh.id, memberActor(row), 'attempt.claimed', {
      taskId: task.id,
      attemptId: attempt.id,
    });
    const box = readBoxQuiet(env, fresh.id, member.name);
    const inboxPreview = box.slice(-5).map((m) => `[${m.kind}] ${m.content.slice(0, 160)}`);
    return { team: fresh, attempt, token, task, inboxPreview };
  });
  renderTeamDocs(env.workspace, out.team, (msg) => env.ctx.logger.warn(msg));
  return { attempt: out.attempt, token: out.token, task: out.task, inboxPreview: out.inboxPreview };
}

/** Member declines: attempt revoked, task back to ready, captain notified. */
export async function declineTask(
  env: RuntimeEnv,
  team: TeamState,
  member: { name: string },
  taskId: number,
  reason: string,
): Promise<TaskRecord> {
  const out = await withTeam(env, team.id, (fresh, _root, tx) => {
    const task = requireTask(fresh, taskId);
    if (task.assignee !== member.name) throw new ETeamsError(`任务 ${task.id} 未指派给你`);
    const attempt = task.attempts.find(
      (a) => a.status === 'pending_accept' && a.member === member.name,
    );
    if (attempt === undefined) {
      throw new ETeamsError(
        `任务 ${task.id} 没有可婉拒的指派`,
        '已接取的任务用 fail_task 上报失败',
      );
    }
    attempt.status = 'revoked';
    attempt.endedAt = tx.now;
    applyTransition(task, 'ready', tx.now);
    freeMember(fresh, task);
    const row = requireMember(fresh, member.name);
    emit(tx, fresh.id, memberActor(row), 'attempt.declined', {
      taskId: task.id,
      attemptId: attempt.id,
      payload: { reason },
    });
    const wakes: Wake[] = [
      notifyCaptainInTx(tx, env, fresh, declineMail(task, member.name, reason), {
        taskId: task.id,
        attemptId: attempt.id,
      }),
    ];
    return { team: fresh, task, wakes };
  });
  renderTeamDocs(env.workspace, out.team, (msg) => env.ctx.logger.warn(msg));
  await runWakes(out.wakes);
  return out.task;
}

/** Member records progress (≤200 chars, docs/06.3). */
export async function appendProgress(
  env: RuntimeEnv,
  team: TeamState,
  member: { name: string },
  params: { taskId: number; attemptId: number; token: string; text: string },
): Promise<void> {
  return withTeam(env, team.id, (fresh, _root, tx) => {
    const { task, attempt } = requireLiveAttempt(fresh, member.name, params);
    const text = params.text.trim();
    if (text === '') throw new ETeamsError('进度内容不能为空');
    const clipped = text.length > 200 ? `${text.slice(0, 197)}…` : text;
    attempt.progress.push({ at: tx.now, text: clipped });
    emit(tx, fresh.id, memberActor(requireMember(fresh, member.name)), 'attempt.progress', {
      taskId: task.id,
      attemptId: attempt.id,
      payload: { text: clipped },
    });
  });
}

/**
 * Member completes the current station (D11 chain logic + FR-36 notify).
 * 二十七轮 DA40 链式执行：小任务终站收口即续派组内就绪小任务（见函数尾）。
 */
export async function completeTask(
  env: RuntimeEnv,
  team: TeamState,
  member: { name: string },
  params: {
    taskId: number;
    attemptId: number;
    token: string;
    output: string;
    changedPaths?: string[];
  },
): Promise<{ task: TaskRecord; done: boolean }> {
  const out = await withTeam(env, team.id, (fresh, _root, tx) => {
    const { task, attempt } = requireLiveAttempt(fresh, member.name, params);
    const output = params.output.trim();
    if (output === '')
      throw new ETeamsError('完成产出说明不能为空', 'output 写清做了什么、改了哪些文件、如何验证');
    attempt.status = 'succeeded';
    attempt.endedAt = tx.now;
    attempt.result = { output, changedPaths: params.changedPaths };
    const row = requireMember(fresh, member.name);
    freeMember(fresh, task);
    const isStation = task.chain.length > 0;
    const wakes: Wake[] = [];
    // Intermediate station iff the completed station (cursor+1) is not the last.
    if (isStation && task.chainCursor + 2 < task.chain.length) {
      task.chainCursor += 1; // station at old cursor+1 is now complete
      const next = nextChainStation(task)!;
      applyTransition(task, 'ready', tx.now);
      emit(tx, fresh.id, memberActor(row), 'task.stage_completed', {
        taskId: task.id,
        attemptId: attempt.id,
        payload: { station: task.chainCursor, next: next.member },
      });
      wakes.push(
        notifyCaptainInTx(
          tx,
          env,
          fresh,
          reportCompletedMail(task, {
            member: member.name,
            attemptId: attempt.id,
            isFinalStation: false,
            output,
            changedPaths: params.changedPaths,
            nextStation: next.member,
            nextStageBrief: next.stageBrief,
          }),
          { taskId: task.id, attemptId: attempt.id },
        ),
      );
      return { team: fresh, task, done: false, wakes, actor: memberActor(row) };
    }
    // Final station or chainless: task completed (docs/35 §5#10：产出不落列，
    // 反查 attempts 最新成功行)。
    const final = isStation && !hasUpcomingStation(task);
    // 终站完成：cursor 记末站下标（进度口径 cursor+1 = 全长；docs/26 链语义）。
    if (isStation) task.chainCursor = task.chain.length - 1;
    applyTransition(task, 'completed', tx.now);
    task.completedAt = tx.now;
    emit(tx, fresh.id, memberActor(row), 'task.completed', {
      taskId: task.id,
      attemptId: attempt.id,
      payload: { output, changedPaths: params.changedPaths, isStation, final: final || !isStation },
    });
    refreshDependentsInTx(tx, fresh, memberActor(row), task.id);
    // docs/26：组任务收口——末个小任务完成且全组 completed 时自动落组状态。
    completeGroupIfDoneInTx(tx, fresh, memberActor(row), task);
    wakes.push(
      notifyCaptainInTx(
        tx,
        env,
        fresh,
        reportCompletedMail(task, {
          member: member.name,
          attemptId: attempt.id,
          isFinalStation: true,
          output,
          changedPaths: params.changedPaths,
        }),
        { taskId: task.id, attemptId: attempt.id },
      ),
    );
    return { team: fresh, task, done: true, wakes, actor: memberActor(row) };
  });
  renderTeamDocs(env.workspace, out.team, (msg) => env.ctx.logger.warn(msg));
  // 二十七轮 DA40 链式执行（用户「整体开始，所有小任务链式执行」）：小任务
  // 完成（终站收口）即以完成成员名义续派组内下一棒（复用整体开始同一派发
  // 核——一次只发一棒，按组内执行序找下一张可跑 ready 小任务），失败只记
  // 日志，不回滚也不吞掉成员的完成应答。组在本帧已收口（全组 completed）
  // 时不再续（终态守卫也拦，这里直接免调用）。
  if (out.done && out.task.parentId !== null) {
    const parent = out.team.tasks.find((t) => t.id === out.task.parentId);
    if (
      parent !== undefined &&
      parent.parentId === null &&
      !['completed', 'cancelled'].includes(parent.status)
    ) {
      try {
        await startGroupTask(env, { teamId: team.id, actor: out.actor }, out.task.parentId);
      } catch (error) {
        env.ctx.logger.warn(`链式续派失败：${String(error)}`);
      }
    }
  }
  await runWakes(out.wakes);
  return { task: out.task, done: out.done };
}

/** Member reports failure: same-member immediate retry, else escalation. */
export async function failTask(
  env: RuntimeEnv,
  team: TeamState,
  member: { name: string },
  params: { taskId: number; attemptId: number; token: string; error: string },
): Promise<{ task: TaskRecord; retried: boolean; retryCount: number; maxRetries: number }> {
  const out = await withTeam(env, team.id, (fresh, _root, tx) => {
    const { task, attempt } = requireLiveAttempt(fresh, member.name, params);
    const wakes: Wake[] = [];
    attempt.status = 'failed';
    attempt.endedAt = tx.now;
    attempt.error = params.error.trim();
    const row = requireMember(fresh, member.name);
    freeMember(fresh, task);
    task.retryCount += 1;
    // 重试上限读全局配置（docs/35 §3#3：maxRetries 不再随队）。
    const maxRetries = env.config.maxRetries;
    if (task.retryCount <= maxRetries) {
      // 立即同成员重试（docs/35 §5#8）：单次落 wait（已派待接取）。
      const retry = makeAttempt(tx, task, {
        kind: 'retry',
        member: row.name,
        stationIndex: task.chain.length > 0 ? task.chainCursor + 1 : 0,
      });
      applyTransition(task, 'wait', tx.now);
      task.assignee = row.name;
      row.status = 'working';
      row.nowTaskId = task.id;
      emit(tx, fresh.id, memberActor(row), 'task.retrying', {
        taskId: task.id,
        attemptId: attempt.id,
        payload: { retryCount: task.retryCount, maxRetries },
      });
      wakes.push(
        sendAssignmentInTx(env, tx, fresh, row, task, retry.id, {
          ...(nextChainStation(task) !== undefined
            ? { stageBrief: nextChainStation(task)!.stageBrief }
            : {}),
          handoff: `重试 ${task.retryCount}/${maxRetries}。上次失败：${attempt.error}`,
        }),
      );
      return { team: fresh, task, retried: true, retryCount: task.retryCount, maxRetries, wakes };
    }
    // Retries exhausted → wait_decision + DecisionRecord (docs/08).
    applyTransition(task, 'wait_decision', tx.now);
    const decision: DecisionRecord = {
      id: nextAutoincrementId(tx.db, 'decisions'),
      taskId: task.id,
      attemptId: attempt.id,
      error: attempt.error,
      retryCount: task.retryCount,
      status: 'open',
      createdAt: tx.now,
    };
    fresh.pendingDecisions.push(decision);
    emit(tx, fresh.id, memberActor(row), 'task.wait_decision', {
      taskId: task.id,
      attemptId: attempt.id,
      payload: { decisionId: decision.id, retryCount: task.retryCount },
    });
    emit(tx, fresh.id, memberActor(row), 'decision.requested', {
      taskId: task.id,
      attemptId: attempt.id,
      payload: { decisionId: decision.id },
    });
    refreshDependentsInTx(tx, fresh, memberActor(row), task.id);
    wakes.push(
      notifyCaptainInTx(
        tx,
        env,
        fresh,
        reportFailedMail(task, {
          member: member.name,
          attemptId: attempt.id,
          error: attempt.error,
          willRetry: false,
          retryCount: task.retryCount,
          maxRetries,
        }),
        { taskId: task.id, attemptId: attempt.id },
      ),
    );
    return {
      team: fresh,
      task,
      retried: false,
      retryCount: task.retryCount,
      maxRetries,
      wakes,
    };
  });
  renderTeamDocs(env.workspace, out.team, (msg) => env.ctx.logger.warn(msg));
  await runWakes(out.wakes);
  return {
    task: out.task,
    retried: out.retried,
    retryCount: out.retryCount,
    maxRetries: out.maxRetries,
  };
}

// ---------- internal helpers ----------

/** 任务的在办尝试（pending_accept/running；docs/35 §5#10：current_attempt_id
 *  不落列，在办按状态反查）。 */
function liveAttemptOf(task: TaskRecord): AttemptRecord | undefined {
  return task.attempts.find((a) => a.status === 'pending_accept' || a.status === 'running');
}

function requireTask(team: TeamState, taskId: number): TaskRecord {
  const task = team.tasks.find((t) => t.id === taskId);
  if (task === undefined)
    throw new ETeamsError(`任务 ${taskId} 不存在`, '用 eteams_task_board 查看任务列表');
  return task;
}

/** 事务内发号一次执行尝试（attempts.attempt_id 全库自增，docs/27）。 */
function makeAttempt(
  tx: TeamTx,
  task: TaskRecord,
  spec: { kind: AttemptKind; member: string; stationIndex: number },
): AttemptRecord {
  const attempt: AttemptRecord = {
    id: nextAutoincrementId(tx.db, 'attempts'),
    taskId: task.id,
    kind: spec.kind,
    member: spec.member,
    status: 'pending_accept',
    token: '',
    stationIndex: spec.stationIndex,
    createdAt: tx.now,
    progress: [],
  };
  task.attempts.push(attempt);
  return attempt;
}

/** Token-guarded live attempt resolution (docs/06.4 revocation semantics). */
function requireLiveAttempt(
  team: TeamState,
  memberName: string,
  params: { taskId: number; attemptId: number; token: string },
): { task: TaskRecord; attempt: AttemptRecord } {
  const task = requireTask(team, params.taskId);
  if (task.assignee !== memberName) {
    throw new ETeamsError(`任务 ${task.id} 未指派给你`, '只操作自己被指派的任务');
  }
  const attempt = task.attempts.find((a) => a.id === params.attemptId);
  if (attempt === undefined || attempt.member !== memberName) {
    throw new ETeamsError(
      `attempt ${params.attemptId} 不属于任务 ${task.id} 的当前执行`,
      'attempt 已吊销或不存在；重新查看 eteams_task_board',
    );
  }
  if (attempt.status !== 'running') {
    throw new ETeamsError(
      `attempt ${attempt.id} 状态为 ${attempt.status}，无法上报`,
      'attempt 已被吊销（改派/取消/挂起），所有权已变更；停止操作并等待新指派',
    );
  }
  if (attempt.token === '' || params.token !== attempt.token) {
    throw new ETeamsError(
      'token 校验失败',
      'attempt 已吊销，所有权已变更；用 eteams_task_board 确认状态并等待领队指令',
    );
  }
  return { task, attempt };
}

/** 吊销任务的在办尝试（挂起/取消/改派共用；含遗留 paused 尝试）。 */
function revokeCurrentAttempt(
  tx: TeamTx,
  team: TeamState,
  actor: Actor,
  task: TaskRecord,
  reason: string,
): void {
  const attempt = liveAttemptOf(task) ?? task.attempts.find((a) => a.status === 'paused');
  if (attempt === undefined) return;
  attempt.status = 'revoked';
  attempt.endedAt = tx.now;
  emit(tx, team.id, actor, 'attempt.revoked', {
    taskId: task.id,
    attemptId: attempt.id,
    payload: { reason },
  });
}

/** 释放执行者：任务松绑 + 实例行回 ready（now_task_id 清空）。 */
function freeMember(team: TeamState, task: TaskRecord): void {
  if (task.assignee === undefined) return;
  const row =
    team.taskMembers.find(
      (r) => r.name === task.assignee && r.status !== 'removed' && r.nowTaskId === task.id,
    ) ?? team.taskMembers.find((r) => r.name === task.assignee && r.status === 'working');
  if (row !== undefined) {
    row.status = 'ready';
    row.nowTaskId = null;
  }
  task.assignee = undefined;
}

/**
 * 依赖物化（docs/35 §5#11）：任务状态落定后刷新其依赖方——ready 依赖方在
 * 上游未齐时物化为 wait + blockedFrom，已物化依赖方在上游齐后还原到
 * blockedFrom。事件按方向分型：原已物化 → task.unblocked，原就绪 →
 * task.blocked。
 */
function refreshDependentsInTx(tx: TeamTx, team: TeamState, actor: Actor, taskId: number): void {
  for (const dependent of team.tasks.filter(
    (t) => t.dependencies.includes(taskId) && (t.status === 'ready' || t.blockedFrom !== undefined),
  )) {
    const wasMaterialized = dependent.blockedFrom !== undefined;
    if (refreshDependencyStatus(team.tasks, dependent, tx.now)) {
      emit(tx, team.id, actor, wasMaterialized ? 'task.unblocked' : 'task.blocked', {
        taskId: dependent.id,
        payload: { by: taskId, status: dependent.status },
      });
    }
  }
}

/**
 * 对话任务组收口（docs/26）：小任务完成时检查父组——组内小任务全部
 * completed 即把组任务 ready→completed（applyTransition 的大任务特例边）；
 * 产出汇总各小任务的 attempts 最新成功行（{@link taskOutcome}，不落列）。
 * 有子任务取消/失败则组保持现状，交领队处理。
 */
function completeGroupIfDoneInTx(
  tx: TeamTx,
  team: TeamState,
  actor: Actor,
  subtask: TaskRecord,
): void {
  if (subtask.parentId === null) return;
  const parent = team.tasks.find((t) => t.id === subtask.parentId);
  if (parent === undefined || parent.status === 'completed' || parent.parentId !== null) return;
  const subs = team.tasks.filter((t) => t.parentId === parent.id);
  if (subs.length === 0 || !subs.every((t) => t.status === 'completed')) return;
  applyTransition(parent, 'completed', tx.now);
  parent.completedAt = tx.now;
  emit(tx, team.id, actor, 'task.completed', {
    taskId: parent.id,
    payload: {
      via: 'subtasks.completed',
      children: subs.map((t) => t.id),
      outcome: subs
        .map((t) => `${t.id} ${t.subject}：${taskOutcome(t) ?? '（无产出说明）'}`)
        .join('\n'),
    },
  });
}

/** 任务产出（docs/35 §5#10：outcome 反查 attempts 最新成功行，不落列）。 */
export function taskOutcome(task: TaskRecord): string | undefined {
  for (let i = task.attempts.length - 1; i >= 0; i -= 1) {
    const attempt = task.attempts[i];
    if (attempt?.status === 'succeeded' && attempt.result !== undefined) {
      return attempt.result.output;
    }
  }
  return undefined;
}

/** 挂起通知（事务内入箱；提交后唤醒，成员不在线则下轮轮询可见）。 */
function notifyMemberSuspendedInTx(
  env: RuntimeEnv,
  tx: TeamTx,
  team: TeamState,
  task: TaskRecord,
  name: string | undefined,
  note?: string,
): Wake {
  if (name === undefined) return noWake;
  const text = suspendedNotice(task, note);
  queueNoticeInTx(tx, team.id, name, text, { taskId: task.id });
  const row = latestInstanceRow(team, name) ?? requireMember(team, name);
  return () => wakeMember(env, team, row, text);
}

/** 取消通知（事务内入箱；提交后唤醒）。 */
function notifyMemberCancelledInTx(
  env: RuntimeEnv,
  tx: TeamTx,
  team: TeamState,
  task: TaskRecord,
  name: string | undefined,
  reason?: string,
): Wake {
  if (name === undefined) return noWake;
  const text = cancelledNotice(task, reason);
  queueNoticeInTx(tx, team.id, name, text, { taskId: task.id });
  const row = latestInstanceRow(team, name) ?? requireMember(team, name);
  return () => wakeMember(env, team, row, text);
}

function readBoxQuiet(env: RuntimeEnv, teamId: number, box: string): MailMessage[] {
  try {
    return readBox(env, teamId, box);
  } catch {
    return [];
  }
}
