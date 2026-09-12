/**
 * Web surface (docs/12, M4 subset — read-only): loopback HTTP routes under
 * `/eteams-api` served from the durable state files, for the client
 * panel to poll. Registration is lazy: the web server and workspace registry
 * are sibling services that headless profiles never mount and concurrent
 * activations may bind after this plugin, so we try now and retry on each
 * service binding event (`ctx.on('internal/service')`). In a webless profile
 * the plugin stays tool-only and never blocks boot (docs/12.5.1).
 *
 * @module dsh-eteams/host/webui
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ETeamsResolvedConfig } from '../config.js';
import type {
  EventRecord,
  MemberRecord,
  TaskRecord,
  TaskStatus,
  TeamState,
} from '../model/types.js';
import { memberBoxKey, readEventsSync, readMailboxSync, recordEvent } from '../state/events.js';
import { readPendingAsksSync } from '../state/asks.js';
import { boardOverview } from '../state/queries.js';
import { listTeamIds, readTeamSync } from '../state/store.js';
import { joinPath, stateRootFor, type RuntimeContext, type RuntimeEnv } from './base.js';
import { taskDirAbs, taskDirRel } from './docs.js';
import { composeCaptainPersona } from '../prompts/personas/captain.js';
import {
  avatarSeedFor,
  ensurePresetMembers,
  formatEmployeeId,
  LEADER_NAME,
  readRoster,
  removeRosterMember,
  ROLE_BUILDER_NAME,
  taskMemberBadge,
  upsertRosterMember,
} from './roster.js';
import {
  addMember,
  createTeam,
  deleteTeam,
  removeMember,
  setLeaderModel,
  setLeaderRemoved,
  setMemberModel,
  syncMemberToRoster,
  updateMember,
} from './teamOps.js';
import {
  assignTask,
  captainFor,
  createTask,
  deleteTask,
  redeliverAssignment,
  resumeTask,
  startGroupTask,
  suspendGroupTask,
  taskOutcome,
  updateTask,
} from './assignment.js';
import {
  leaderRowOf,
  leaderRouteOf,
  latestInstanceRow,
  teamMainSessionOf,
} from './notifier.js';
import {
  answerBuildInterview,
  cancelBuildSession,
  confirmBuildSession,
  readBuildParentSession,
  readBuildSession,
  reportBuildProgress,
  writeBuildPresence,
  type BuildDraft,
} from './roleBuilder.js';
import { stopBuilderChild, wakeBuilderChild } from './builderPhases.js';
import { clearSessionPersona, setSessionPersona } from './sessionPersona.js';
import {
  clearSessionTeam,
  getSessionTeamBinding,
  getSessionTeamId,
  setSessionTeam,
} from './sessionTeam.js';
import { dispatchCaptainCore } from './captainAgent.js';
import {
  captainCommissionMessage,
  captainCommissionPrompt,
  captainStartMessage,
} from '../prompts/steering/dispatch.js';
import { readUsageCalendar, readAppUsageCalendar } from './usage.js';
import {
  findRosterMemberAcrossWorkspaces,
  locateTeamAcrossWorkspaces,
  workspaceRegistryOf,
} from './workspaces.js';

/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const;

/** Base URL prefix for every eteams route. */
export const ROUTE_PREFIX = '/eteams-api';

/** Minimal structural view of the host web server service. */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: unknown, res: unknown) => void | Promise<void>;
  }): () => void;
}

// ---------- snapshot builders (pure over disk state) ----------

/** One chain station as rendered by the panel. v7：`member` 是站点原始引用
 * （工号数字串或旧名字串——客户端拼链 POST 回写的是它），`memberLabel` 才是
 * 显示标识：工号站点渲染 `T{mainTaskId}-ET{xxxx}（名字）`，旧名字站点原样
 * （legacy）。 */
export interface StationView {
  member: string;
  memberLabel: string;
  stageBrief: string;
  stationStatus: 'done' | 'current' | 'pending';
}

/** 「进行中」态（用户迭代 2026-09-11：精简状态集后又恢复独立 `wait`=待领队
 * 分诊；ready 是待派单列不算进行中）。 */
const ACTIVE_STATUSES: TaskStatus[] = ['start', 'wait', 'paused', 'wait_user'];

/** commission 主题截断长度（描述首行占位主题，完善者收口时回写真主题）。 */
const COMMISSION_SUBJECT_MAX = 24;

/**
 * commission 派发段按团队串行（docs/panelTaskCommission）：建任务后的
 * 「解析父锚 → 派发完善者」段是异步窗口，两次快速提交若无序会并发
 * startContinuable 用同 label 重建领队子代理。按 teamKey 排队，失败不堵队。
 */
const commissionQueues = new Map<string, Promise<void>>();
function withCommissionLock<T>(teamKey: string, run: () => Promise<T>): Promise<T> {
  const tail = (commissionQueues.get(teamKey) ?? Promise.resolve()).catch(() => undefined);
  const next = tail.then(run);
  commissionQueues.set(
    teamKey,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** Station status for chain index `i` given the task state. */
function stationStatusOf(
  status: TaskStatus,
  chainLength: number,
  cursor: number,
  i: number,
): StationView['stationStatus'] {
  void chainLength;
  if (i <= cursor) return 'done';
  if (i === cursor + 1 && (ACTIVE_STATUSES.includes(status) || status === 'ready'))
    return 'current';
  return 'pending';
}

/**
 * 任务成员显示标识（v7 对外口径 `T{mainTaskId}-ET{xxxx}` + 名字）：工号 ref
 * 先查该任务的副本行取名，缺了退班底行；旧链站点（名字串）原样显示
 * （legacy 兼容，渲染层不标注也无法标注）。
 */
function taskMemberLabel(team: TeamState, mainTaskId: number, ref: string | number): string {
  const trimmed = typeof ref === 'string' ? ref.trim() : '';
  const numeric = typeof ref === 'number' ? ref : Number.parseInt(trimmed, 10);
  if (!Number.isFinite(numeric) || (typeof ref === 'string' && String(numeric) !== trimmed)) {
    // 非数字串 = 旧名字站点，原样。
    return typeof ref === 'string' ? ref : formatEmployeeId(ref);
  }
  const name =
    team.taskMembers.find((r) => r.mainTaskId === mainTaskId && r.employeeId === numeric)?.name ??
    team.members.find((m) => m.employeeId === numeric)?.name;
  const badge = taskMemberBadge(mainTaskId, numeric);
  return name !== undefined ? `${badge}（${name}）` : badge;
}

/**
 * 按引用定位班底成员（R4 成员作用域路由口径）：路由段收工号（数字串）；
 * 旧客户端/手工调用传名字串则回退按名——「同名按号找人，名字只作显示」
 * 的服务端兜底。
 */
function rosterMemberByRef(team: TeamState, ref: string): MemberRecord | undefined {
  const trimmed = ref.trim();
  const numeric = Number.parseInt(trimmed, 10);
  if (Number.isFinite(numeric) && String(numeric) === trimmed) {
    return team.members.find((m) => m.employeeId === numeric);
  }
  return team.members.find((m) => m.name === trimmed);
}

/** Per-member view row (docs/12.2; avatar/persona editors land in M6/M5).
 * 人设经 role_id 装自 roles 角色行（v3 成员=角色，成员详情与角色详情同源），
 * 会话锚点按工号聚合副本行（v7：同名成员各聚合各的）。 */
function memberView(team: TeamState, m: MemberRecord) {
  // 当前任务按该成员副本行的最近 attempt 归属（v7 副本并行，assignee 名字
  // 只作显示——同名成员不能互相当成「当前任务」）。
  const rowIds = new Set(
    team.taskMembers
      .filter((r) => m.employeeId !== undefined && r.employeeId === m.employeeId)
      .map((r) => r.id),
  );
  const currentTask = team.tasks.find((t) => {
    const last = t.attempts.at(-1);
    if (last === undefined) return t.assignee === m.name;
    const mine =
      last.taskMemberId !== undefined ? rowIds.has(last.taskMemberId) : last.member === m.name;
    // 「当前任务」= 该成员手里有在办/待接取尝试的任务（用户迭代 2026-09-11：
    // 派发不改状态，不能再按 ACTIVE_STATUSES 筛——已派发待接取的任务是
    // ready，仍是他的手头活；paused 已吊销 attempt、wait_user 的 attempt 已
    // 失败，都不算在办）。
    return mine && (last.status === 'pending_accept' || last.status === 'running');
  });
  const row = latestInstanceRow(team, m.employeeId ?? m.name);
  return {
    name: m.name,
    /** 工号 (docs/21)：格式化显示串（ET-0001）；null for legacy members. */
    employeeId: m.employeeId !== undefined ? formatEmployeeId(m.employeeId) : null,
    role: m.role,
    profile: m.persona.profile ?? null,
    // 成员手册：装自 roles 角色行（v3 人设单一来源）；/persona 改写即改
    // 角色行（全局生效）。personaMd 为空（旧成员）时客户端按结构字段合成骨架。
    personaMd: m.persona.personaMd ?? null,
    duty: m.persona.duty,
    style: m.persona.style,
    skills: m.persona.skills,
    rules: m.persona.rules,
    executionPrompt: m.persona.executionPrompt,
    model: m.modelRoute.model,
    // 覆盖路线的目录 provider（v9 回归）：客户端显示按 provider+model 精确
    // 定位目录行（同 id 模型跨提供方时按 id 反查会命中错误条目）。
    provider: m.modelRoute.provider ?? null,
    reasoningEffort: m.modelRoute.reasoningEffort ?? null,
    currentTaskId: currentTask?.id ?? null,
    childId: row?.sessionId ? row.sessionId : null,
    avatar: m.avatar ?? null,
  };
}

/**
 * 容器（大任务）的有效状态（用户迭代 2026-09-11「没有正在执行的小任务，主任务
 * 应该也是待开始状态，没有同步过来」）：容器的 `start` 只应由「有在办小任务」
 * 支撑，容器 `start` 但有小任务挂起时应报 `paused`。写入侧由
 * `assignment.syncGroupStatusInTx` 在每次小任务变动后维护同一不变量；本函数是
 * **读取侧兜底**——历史构建里中断未同步留下的陈旧 start 在展示层回落 ready /
 * paused（面板不再出现「执行中但没有任何小任务在跑」，也不漏「小任务已挂起」
 * ——用户迭代「小任务挂起之后，主任务也同步挂起」），不落盘。显式 paused 容器
 * 保持 paused（用户显式挂起的语义不被读取侧冲掉）。
 */
function containerStatusOf(t: TaskRecord, team: TeamState): TaskStatus {
  if (t.parentId !== null) return t.status;
  if (t.status !== 'start' && t.status !== 'paused') return t.status;
  const subs = team.tasks.filter((s) => s.parentId === t.id);
  const active = subs.some(
    (s) =>
      s.status === 'start' ||
      s.attempts.some((a) => a.status === 'pending_accept' || a.status === 'running'),
  );
  if (active) return 'start';
  if (t.status === 'paused') return 'paused';
  return subs.some((s) => s.status === 'paused') ? 'paused' : 'ready';
}

/** Per-task view row with chain station marks and a compact attempt summary.
 * @param groupOutcomes 组容器的收口产出（docs/26）：组自身没有 attempts，
 * 产出由 completeGroupIfDoneInTx 聚合进 task.completed 事件
 * （payload.via='subtasks.completed'）——面板按事件反查，小任务仍走
 * attempts 反查（docs/35 §5#10 产出不落列）。 */
function taskView(t: TaskRecord, team: TeamState, groupOutcomes?: Map<number, string>) {
  // 末站完成即 completed（chainCursor 不再推进，docs/35 §5#10）——完成态
  // 按满进度口径显示站点。
  const stationStatus = (i: number): StationView['stationStatus'] =>
    t.status === 'completed' ? 'done' : stationStatusOf(t.status, t.chain.length, t.chainCursor, i);
  return {
    taskId: t.id,
    subject: t.subject,
    // 任务单（group 容器）判据：无父且有子任务，或创建中占位（子任务未落库
    // 时详情页也要走编排分支——罗列条/任务列表/新增小任务全程可见，
    // docs/panelTaskCommission）（旧 kind 列已砍，docs/35 §3）。
    kind:
      t.parentId === null &&
      (t.status === 'creating' || team.tasks.some((x) => x.parentId === t.id))
        ? 'group'
        : 'task',
    parentId: t.parentId ?? null,
    folder: taskDirRel(team, t),
    description: t.description ?? null,
    // 合同 MD 全文（十六轮 DA29：原四数组合并为一篇 Markdown）+ 幂等说明
    // （docs/35 §3#7）。
    contractMd: t.contractMd ?? null,
    idempotencyNote: t.idempotencyNote ?? null,
    // 依赖阻塞不再物化（用户迭代 2026-09-11「就 ready 等待就行」）：
    // blocked/blockedFrom 快照字段随 wait 撤销退役，依赖由派发口校验。
    statusNote: t.statusNote ?? null,
    workDir: t.workDir ?? null,
    // 主会话 ID 快照（task.main_session_id，v5 落列 v6 改名）：建任务时登记
    // 的主会话（增量字段，客户端可选消费）。
    sessionId: t.mainSessionId ?? null,
    status: containerStatusOf(t, team),
    assignee: t.assignee ?? null,
    dependencies: t.dependencies,
    chain: t.chain.map((s, i): StationView => ({
      // 站点 ref 原样下发（工号数字串/旧名字串——客户端拼链要原样 POST 回写），
      // 显示标识单列 memberLabel。
      member: typeof s.member === 'number' ? String(s.member) : s.member,
      memberLabel: taskMemberLabel(team, t.parentId ?? t.id, s.member),
      stageBrief: s.stageBrief,
      stationStatus: stationStatus(i),
    })),
    chainCursor: t.chainCursor,
    chainLength: t.chain.length,
    retryCount: t.retryCount,
    // 产出不落列（docs/35 §5#10）：反查 attempts 最新成功行。
    currentAttemptId: t.attempts.at(-1)?.id ?? null,
    outcome: taskOutcome(t) ?? groupOutcomes?.get(t.id) ?? null,
    attemptSummary: t.attempts.slice(-3).map((a) => ({
      id: a.id,
      member: a.member,
      kind: a.kind,
      status: a.status,
      startedAt: a.claimedAt ?? a.createdAt,
      endedAt: a.endedAt ?? null,
      lastEventText: a.progress.at(-1)?.text ?? a.error ?? a.result?.output ?? null,
      eventCount: a.progress.length,
    })),
    updatedAt: t.updatedAt,
  };
}

/** Build the full panel snapshot for one team (docs/12.2 TeamSnapshot). */
export function teamSnapshot(
  team: TeamState,
  workspacePath: string,
  config: ETeamsResolvedConfig,
): Record<string, unknown> {
  // 状态根统一走 stateRootFor（用户迭代 2026-09-04 全局单库：stateDir 绝对
  // 路径时所有工作区共用一个根；相对路径保持 per-workspace）。
  const stateRoot = stateRootFor(config, workspacePath);
  // The captain (项目牧羊人) is rendered as the leader card on the 团队 page;
  // it is not a roster member, so it travels with the snapshot instead. v7：
  // 领队工号 = 班底领队行自增主键（表自增，建队即入班底领号），异常缺行
  // 按 1 号兜底。
  const captainPersona = composeCaptainPersona(stateRoot);
  // 领队识别一律按 is_leader 标识（v8）：角色库条目按 roles.is_leader，班底
  // 行按 team_members.is_leader——不再按保留名匹配。
  const rosterLeader = readRoster(stateRoot).find((m) => m.isLeader === true);
  const leader = leaderRowOf(team);
  const leaderRoute = leaderRouteOf(team);
  const leaderBadge =
    team.members.find((m) => m.isLeader === true)?.employeeId ?? leader?.employeeId ?? 1;
  // 组收口产出（docs/26）：task.completed 事件 payload.via='subtasks.completed'
  // 的聚合文本按 taskId 收敛，同任务多次收口取最新一条（Map 覆盖写）。
  const events = readEventsSync(stateRoot, team.id);
  const groupOutcomes = new Map<number, string>();
  for (const e of events) {
    if (e.type !== 'task.completed' || e.taskId === undefined) continue;
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    if (payload.via !== 'subtasks.completed' || typeof payload.outcome !== 'string') continue;
    groupOutcomes.set(e.taskId, payload.outcome);
  }
  return {
    teamId: team.id,
    name: team.name,
    // 领队移出 = 班底配置开关（v8+ 主持行取消）：hasLeader false 即移出态。
    leaderRemoved: !team.hasLeader,
    // docs/27 §27.9#4：goal / phase / planReviewState / version / workDir /
    // leaderModelRoute 已随审批重构与成员模型收敛砍掉——面板不再消费。
    // docs/26：任务单（group 容器）不计入进度——进度只反映真实小任务。
    progress: (() => {
      // 创建中的容器（面板手动建任务占位）不计进度分母（docs/panelTaskCommission）。
      const real = team.tasks.filter(
        (t) => t.status !== 'creating' && !team.tasks.some((x) => x.parentId === t.id),
      );
      return {
        completed: real.filter((t) => t.status === 'completed').length,
        total: real.length,
        cancelled: real.filter((t) => t.status === 'cancelled').length,
        active: real.filter((t) => ACTIVE_STATUSES.includes(t.status)).length,
      };
    })(),
    captain: {
      name: '项目牧羊人',
      // 工号格式化显示串：班底领队行（v7）。
      employeeId: formatEmployeeId(leaderBadge),
      role: captainPersona.role,
      duty: captainPersona.duty,
      style: captainPersona.style,
      skills: captainPersona.skills,
      personaMd: captainPersona.personaMd ?? null,
      // 头像（用户迭代 2026-09-03）：优先名册领队条目——面板「随机头像」
      // 换脸后团队页领队卡同步；缺省回落固定 (hashName, 7)。
      avatar: rosterLeader?.avatar ?? { seed: avatarSeedFor('项目牧羊人'), salt: 7 },
      // 模型路线（用户迭代 2026-09-04 恢复领队模型选择；v9 存班底领队行
      // leaderRouteOf——provider/model/effort 整组），空 model = 会话默认。
      model: leaderRoute.model,
      provider: leaderRoute.provider ?? null,
      reasoningEffort: leaderRoute.reasoningEffort ?? null,
    },
    // 成员 = 班底行（v7）。领队也是班底一行，但领队卡单独走 captain 段，
    // 成员列表跳过它避免重复出卡。
    members: team.members.filter((m) => m.isLeader !== true).map((m) => memberView(team, m)),
    tasks: team.tasks.map((t) => taskView(t, team, groupOutcomes)),
    pendingDecisions: team.pendingDecisions
      .filter((d) => d.status === 'open')
      .map((d) => ({
        id: d.id,
        taskId: d.taskId,
        error: d.error,
        retryCount: d.retryCount,
        createdAt: d.createdAt,
      })),
    // 子代理待问答（2026-09-10 统一：就地弹窗也落行）：面板「待问答」徽标
    // 数据源；askingSessionId 供后续深链到提问子对话。
    pendingAsks: readPendingAsksSync(stateRoot, team.id).map((a) => ({
      askId: a.askId,
      askingName: a.askingName,
      askingKind: a.askingKind,
      askingSessionId: a.askingSessionId,
      questionCount: a.questions.length,
      createdAt: a.createdAt,
    })),
    latestEvents: events.slice(-30).map((e) => ({
      seq: e.seq,
      at: e.at,
      actor: e.actor.name ?? e.actor.kind,
      actorKind: e.actor.kind,
      type: e.type,
      taskId: e.taskId ?? null,
      text: summarizeEvent(e),
    })),
  };
}

/** One-line human summary of an event for the 动态 view. */
export function summarizeEvent(e: EventRecord): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const task = e.taskId !== undefined ? `#${e.taskId}` : '';
  switch (e.type) {
    case 'team.created':
      return `创建团队「${String(p.name ?? '')}」`;
    case 'plan.questionnaire':
      return `问询完成（${String(p.count ?? '?')} 问）`;
    case 'member.added':
      return `成员「${String(p.name ?? '')}」加入`;
    case 'member.removed':
      return `成员「${String(p.name ?? '')}」移除`;
    case 'leader.removed':
      return '领队已移出团队';
    case 'leader.restored':
      return '领队回到团队';
    case 'task.created':
      return `新建任务 ${task}`;
    case 'task_commissioned':
      // 面板手动建任务（docs/panelTaskCommission）：派发失败也如实展示。
      return p.dispatched === true
        ? `面板创建任务 ${task}，已交${p.hasLeader === true ? '领队' : '主会话'}完善`
        : `面板创建任务 ${task}（创建中），完善者未送达：${String(p.reason ?? '')}`;
    case 'task.assigned':
      return `${task} 指派给 ${String(p.member ?? '')}`;
    case 'task.claimed':
      return `${String(p.member ?? '')} 接取 ${task}`;
    case 'task.progress':
      return `${task} 进度：${String(p.text ?? '')}`;
    case 'task.stage_completed':
      return `${task} 站点完成，下一站 ${String(p.next ?? '?')}`;
    case 'task.completed':
      return `${task} 已完成`;
    case 'task.failed':
      return `${task} 失败：${String(p.error ?? '')}`;
    case 'task.retried':
      return `${task} 第 ${String(p.retry ?? '?')} 次重试`;
    case 'chain.deviated':
      return `${task} 偏离执行链：${String(p.note ?? '')}`;
    case 'task.suspended':
      return `${task} 已挂起`;
    case 'task.resumed':
      return `${task} 已恢复`;
    case 'task.cancelled':
      return `${task} 已取消`;
    case 'decision.requested':
      return `${task} 待用户处理：${String(p.error ?? '')}`;
    case 'mail.queued':
      return `邮件入箱 → ${String(p.to ?? '')}`;
    default:
      return e.type;
  }
}

/**
 * Read every unarchived team across all registered workspaces. 全局单库
 * （用户迭代 2026-09-04，stateDir 绝对路径）下所有工作区解析到同一个状态
 * 根——按根去重、每个根只收一遍（否则同一团队按工作区数重复出现在面板），
 * 并记住每个根的代表工作区供 teamSnapshot 用。
 */
function collectRoots(
  ctx: Context,
  config: ETeamsResolvedConfig,
): { root: string; workspacePath: string }[] {
  const registry = workspaceRegistryOf(ctx);
  if (!registry) return [];
  const byRoot = new Map<string, string>();
  for (const workspace of registry.list()) {
    const root = stateRootFor(config, workspace.path);
    if (!byRoot.has(root)) byRoot.set(root, workspace.path);
  }
  return [...byRoot].map(([root, workspacePath]) => ({ root, workspacePath }));
}

async function collectTeams(
  ctx: Context,
  config: ETeamsResolvedConfig,
): Promise<Record<string, unknown>[]> {
  const snapshots: Record<string, unknown>[] = [];
  for (const { root, workspacePath } of collectRoots(ctx, config)) {
    for (const teamId of await listTeamIds(root)) {
      const team = readTeamSync(root, teamId);
      if (team) snapshots.push(teamSnapshot(team, workspacePath, config));
    }
  }
  return snapshots;
}

// ---------- subagent session identity (用户迭代 2026-09-10 子代理身份面) ----------

/** One session's resolved eteams subagent identity (GET /session-identity body). */
export interface SessionIdentityView {
  kind: 'member' | 'captain' | 'builder';
  name: string;
  teamId: string | null;
  teamName: string | null;
  avatar: { seed: number; salt: number } | null;
}

/**
 * 子代理会话身份面（用户迭代 2026-09-10「子代理隐藏团队按钮」）：把一个会话
 * id 解析成 eteams 子代理身份——成员子代理（任务副本行）、领队子代理（领队
 * 副本行/主持行）、角色构建师子代理（构建会话文件的 builderChildId）。其余
 * 会话（未绑定主对话、无关子代理、身份已失效的离职子代理）返回 undefined =
 * 客户端把团队按钮整个隐藏。
 *
 * 只认**磁盘真相**（快照构建器同口径，重启/冷恢复免疫）：成员/领队副本行的
 * session_id 随 spawn 同流回填（members.ts / captainAgent.ts），构建子代理
 * 的 builderChildId 落构建会话文件；运行时注册表（usage/captainAgent）不
 * 兜底——它的条目不随删任务/离职清理，兜底会让已失效的会话借尸还魂。判定
 * 与 tools/identity.resolveCaller 同源：is_leader 行 → 领队（不滤 removed，
 * leaderRowOf 冷恢复同口径）；成员行滤离职（status=removed 或工牌已删 →
 * undefined，工面失效按钮同隐）。
 */
export async function sessionIdentityOf(
  ctx: Context,
  config: ETeamsResolvedConfig,
  sessionId: string,
): Promise<SessionIdentityView | undefined> {
  if (sessionId === '') return undefined;
  // 1) 构建子代理：各根构建会话文件的 builderChildId 即身份凭证（单槽，一读
  //    一文件；confirmed/cancelled 后子代理会话仍在，脸面照常成立）。
  for (const { root } of collectRoots(ctx, config)) {
    const build = readBuildSession(root);
    if (build !== null && build.builderChildId === sessionId) {
      const entry = readRoster(root).find((m) => m.name === ROLE_BUILDER_NAME);
      return {
        kind: 'builder',
        name: ROLE_BUILDER_NAME,
        teamId: null,
        teamName: null,
        avatar: entry?.avatar ?? { seed: avatarSeedFor(ROLE_BUILDER_NAME), salt: 7 },
      };
    }
  }
  // 2) 团队副本行扫描（跨工作区）：sessionId 精确锚一行副本行，命中即出身份。
  for (const { root } of collectRoots(ctx, config)) {
    for (const teamId of await listTeamIds(root)) {
      const team = readTeamSync(root, teamId);
      if (team === undefined) continue;
      const row = team.taskMembers.find((r) => r.sessionId === sessionId);
      if (row === undefined) continue;
      if (row.isLeader === true) {
        // 领队子代理：脸面对齐团队快照 captain 段（名册领队头像 → 固定兜底）。
        const rosterLeader = readRoster(root).find((m) => m.isLeader === true);
        return {
          kind: 'captain',
          name: LEADER_NAME,
          teamId: String(team.id),
          teamName: team.name,
          avatar: rosterLeader?.avatar ?? { seed: avatarSeedFor(LEADER_NAME), salt: 7 },
        };
      }
      // 成员副本行：resolveCaller 同判据的离职截断——工牌不在的存活会话
      // 工面失效，身份面同判据隐藏（视为离职，不是成员了）。
      if (row.employeeId !== null && !team.members.some((m) => m.employeeId === row.employeeId)) {
        return undefined;
      }
      // 头像随班底行（memberView 同源，roles 实时值）；副本行冻结值兜底，
      // 都没有按名字色相生成（teamSnapshot 领队兜底同款 salt=7 约定）。
      const template = team.members.find((m) => m.employeeId === row.employeeId);
      return {
        kind: 'member',
        name: row.name,
        teamId: String(team.id),
        teamName: team.name,
        avatar: template?.avatar ?? row.avatar ?? { seed: avatarSeedFor(row.name), salt: 7 },
      };
    }
  }
  return undefined;
}

// ---------- lazy route installation ----------

function webServerOf(ctx: Context): WebServerLike | undefined {
  const get = (ctx as unknown as { get?: (key: string) => unknown }).get;
  if (typeof get !== 'function') return undefined;
  return (get.call(ctx, WEB_SERVER_KEYS[0]) ?? get.call(ctx, WEB_SERVER_KEYS[1])) as
    WebServerLike | undefined;
}

function sendJson(res: unknown, status: number, body: unknown): void {
  const r = res as {
    writeHead: (code: number, headers: Record<string, string>) => void;
    end: (data?: string) => void;
  };
  r.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  r.end(JSON.stringify(body));
}

function sendError(res: unknown, status: number, error: string, hint?: string): void {
  sendJson(res, status, { error, ...(hint ? { hint } : {}) });
}

async function readBody(req: unknown): Promise<string> {
  const r = req as { on: (event: string, cb: (chunk?: Buffer) => void) => void };
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    r.on('data', (chunk) => {
      if (chunk)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as string));
    });
    r.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    r.on('error', reject);
  });
}

/** Ring cap for the persisted client log (lines). */
const CLIENT_LOG_MAX_LINES = 400;

/**
 * Persist renderer-reported diagnostics to `<stateDir>/logs/client.log`
 * (JSON lines, head-truncated ring). Prefers a workspace that already has
 * eteams state; never throws — a broken log sink must not break the route.
 */
function appendClientLog(ctx: Context, config: ETeamsResolvedConfig, raw: string): number {
  const registry = workspaceRegistryOf(ctx);
  if (!registry) return 0;
  const list = registry.list();
  if (list.length === 0) return 0;
  let root = stateRootFor(config, list[0]!.path);
  for (const ws of list) {
    const candidate = stateRootFor(config, ws.path);
    if (existsSync(candidate)) {
      root = candidate;
      break;
    }
  }
  let parsed: { version?: unknown; entries?: unknown };
  try {
    parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
  } catch {
    return 0;
  }
  const batch = Array.isArray(parsed.entries) ? parsed.entries : [];
  let written = 0;
  try {
    const dir = joinPath(root, 'logs');
    mkdirSync(dir, { recursive: true });
    const file = joinPath(dir, 'client.log');
    const prev = existsSync(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .filter((l) => l !== '')
      : [];
    const lines: string[] = [...prev];
    for (const item of batch) {
      lines.push(
        JSON.stringify({
          at: Date.now(),
          version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
          entry: item,
        }),
      );
      written += 1;
    }
    while (lines.length > CLIENT_LOG_MAX_LINES) lines.shift();
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    if (written > 0) {
      const logger = (ctx as unknown as { logger?: { warn?: (msg: string) => void } }).logger;
      if (typeof logger?.warn === 'function')
        logger.warn(`eteams: client diagnostics +${written} → ${file}`);
    }
  } catch {
    // sink failure is swallowed by design
  }
  return written;
}

/**
 * host.log 诊断（用户迭代 2026-09-03 排障）：client.log 全部来自渲染端上报，
 * 宿主自身无痕——「改完代码重启后行为没变」只能靠猜。这里补两条宿主侧
 * 留痕（`<stateDir>/logs/host.log`，JSON lines 环形上限，写失败静默）：
 * 1. Web 面装载即写 host-boot 一行，module/builtAt 取宿主 bundle 自身路径
 *    与 mtime——运行中的代码到底是哪个构建，磁盘可查；
 * 2. POST /roster 保存时写 roster-save 一行，含是否收到 avatar——「随机
 *    头像保存无效」一眼定位：客户端发没发（client 端 fetch 打桩复现）/
 *    宿主有没有透传（本行）。
 */
const HOST_LOG_MAX_LINES = 100;

/** Boot marker is per-process: dedupe across installWebSurface retries. */
let hostBootLogged = false;

function appendHostLog(
  ctx: Context,
  config: ETeamsResolvedConfig,
  entry: Record<string, unknown>,
): void {
  try {
    const registry = workspaceRegistryOf(ctx);
    if (registry === undefined) return;
    const list = registry.list();
    if (list.length === 0) return;
    let root = stateRootFor(config, list[0]!.path);
    for (const ws of list) {
      const candidate = stateRootFor(config, ws.path);
      if (existsSync(candidate)) {
        root = candidate;
        break;
      }
    }
    const dir = joinPath(root, 'logs');
    mkdirSync(dir, { recursive: true });
    const file = joinPath(dir, 'host.log');
    const prev = existsSync(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .filter((l) => l !== '')
      : [];
    const lines: string[] = [...prev, JSON.stringify({ at: Date.now(), ...entry })];
    while (lines.length > HOST_LOG_MAX_LINES) lines.shift();
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    // sink failure is swallowed by design
  }
}

/**
 * One-time host-boot marker: records the running module's own path and
 * mtime — i.e. which build is actually executing. Answers「磁盘上明明是新
 * 构建、行为却是旧的」这类排障（用户迭代 2026-09-03）：宿主 bundle 由
 * 应用启动时加载一次，重建不热生效。
 */
function logHostBoot(ctx: Context, config: ETeamsResolvedConfig): void {
  if (hostBootLogged) return;
  hostBootLogged = true;
  let builtAt = '';
  let module = '';
  try {
    module = fileURLToPath(import.meta.url);
    builtAt = statSync(module).mtime.toISOString();
  } catch {
    // bundler without import.meta.url / stat failure — marker still written
  }
  appendHostLog(ctx, config, { kind: 'host-boot', module, builtAt });
}

/**
 * Web-surface options（十二轮 DA25 注入点）：测试注入假 openFolder，避免
 * 单测真的拉起系统文件管理器。
 */
export interface WebSurfaceOptions {
  /** 任务文件夹打开器：默认按平台 spawn 文件管理器（defaultOpenFolder）。 */
  openFolder?: (dir: string) => void | Promise<void>;
}

/**
 * 默认任务文件夹打开器（十二轮 DA25）：按平台拉系统文件管理器——win32
 * explorer / darwin open / 其余 xdg-open。detached + unref 不阻塞宿主；
 * spawn 的异步失败（命令不存在等）吞掉——打开失败不致崩宿主，客户端侧
 * 靠目录存在性 400 先行拦截。
 */
function defaultOpenFolder(dir: string): void {
  const command =
    process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [dir], { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}

/**
 * Install the eteams web surface (idempotent): registers one prefix route
 * covering every read endpoint and returns whether it bound this call.
 */
export function installWebSurface(
  ctx: Context,
  config: ETeamsResolvedConfig,
  options: WebSurfaceOptions = {},
): boolean {
  const openFolder = options.openFolder ?? defaultOpenFolder;
  const webServer = webServerOf(ctx);
  const workspaceRegistry = workspaceRegistryOf(ctx);
  if (webServer === undefined || workspaceRegistry === undefined) return false;
  logHostBoot(ctx, config);

  ctx.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (rawReq, rawRes) => {
          const req = rawReq as { method?: string; url?: string | undefined };
          const res = rawRes;
          try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const path = url.pathname.slice(ROUTE_PREFIX.length) || '/';
            // Decode once here: pathname arrives percent-encoded for non-ASCII
            // team ids / member names (CJK slugs are the norm, docs/09).
            const segments = path
              .split('/')
              .filter((s) => s !== '')
              .map((s) => {
                try {
                  return decodeURIComponent(s);
                } catch {
                  return s;
                }
              });
            if (req.method === 'POST' && segments[0] === 'client-log' && segments.length === 1) {
              const raw = await readBody(req);
              const written = appendClientLog(ctx, config, raw);
              sendJson(res, 200, { ok: true, written });
              return;
            }
            // ---------- panel writes (M5 first slice) ----------
            // POST /session-persona — the panel's member selection (docs/13.8.2):
            // the session agent's system prompt gains a persona band evaluated per
            // assembly (sessionPersona.ts). No conversation message is involved.
            if (
              req.method === 'POST' &&
              segments[0] === 'session-persona' &&
              segments.length === 1
            ) {
              const body = parseJsonObject(await readBody(req));
              const sessionId = str(body.sessionId, '');
              const name = str(body.name, '');
              if (sessionId === '' || name === '') {
                sendError(res, 400, 'sessionId / name 均不能为空');
                return;
              }
              setSessionPersona(sessionId, {
                name,
                ...(body.role !== undefined ? { role: str(body.role) } : {}),
                ...(body.duty !== undefined ? { duty: str(body.duty) } : {}),
                ...(body.personaMd !== undefined ? { personaMd: str(body.personaMd) } : {}),
              });
              sendJson(res, 200, { ok: true });
              return;
            }
            // POST /session-persona/clear — deselect (back to the default agent voice).
            if (
              req.method === 'POST' &&
              segments[0] === 'session-persona' &&
              segments[1] === 'clear' &&
              segments.length === 2
            ) {
              const body = parseJsonObject(await readBody(req));
              const sessionId = str(body.sessionId, '');
              if (sessionId === '') {
                sendError(res, 400, 'sessionId 不能为空');
                return;
              }
              clearSessionPersona(sessionId);
              sendJson(res, 200, { ok: true });
              return;
            }
            // POST /session-team — the composer's 团队 selection (docs/26):
            // binds the conversation to a team; the session agent's prompt
            // gains a 团队绑定 band (sessionTeam.ts) with the conversation
            // task workflow and the leadership branch (领队 / 主窗口充当
            // 领队 / 团队建在他会话的可行动提示).
            //
            // 锁定守卫（用户迭代 2026-09-10「1 个主对话只能有 1 个团队」）：
            // 会话已绑定其他健在团队 → 409 拒绝；同队重绑放行（刷新名字/
            // 时间）；旧队已删除放行（删队清绑定 + 客户端徽章解锁后的重选
            // 逃生口）。
            if (req.method === 'POST' && segments[0] === 'session-team' && segments.length === 1) {
              const body = parseJsonObject(await readBody(req));
              const sessionId = str(body.sessionId, '');
              const teamId = str(body.teamId, '');
              if (sessionId === '' || teamId === '') {
                sendError(res, 400, 'sessionId / teamId 均不能为空');
                return;
              }
              const located = locateTeam(ctx, config, teamId);
              if (located === undefined) {
                sendError(res, 404, `团队「${teamId}」不存在`);
                return;
              }
              const existing = getSessionTeamBinding(sessionId);
              if (existing !== undefined && existing.teamId !== teamId) {
                const current = locateTeam(ctx, config, existing.teamId);
                if (current !== undefined) {
                  sendError(
                    res,
                    409,
                    `本对话已固定为团队「${current.team.name}」——一个对话只能绑定一个团队`,
                  );
                  return;
                }
              }
              setSessionTeam(sessionId, { teamId, name: located.team.name, boundAt: Date.now() });
              sendJson(res, 200, { ok: true });
              return;
            }
            // GET /session-team?sessionId=… — the composer button's mount-time
            // 对账：宿主绑定是锁定真相源，客户端徽章据此刷面（localStorage
            // 只是离线镜像；宿主重启后查空 → 客户端走本地镜像 POST 重申自愈）。
            if (req.method === 'GET' && segments[0] === 'session-team' && segments.length === 1) {
              const sessionId = url.searchParams.get('sessionId') ?? '';
              const binding = sessionId !== '' ? getSessionTeamBinding(sessionId) : undefined;
              if (binding === undefined) {
                sendJson(res, 200, { empty: true });
                return;
              }
              sendJson(res, 200, { teamId: binding.teamId, name: binding.name });
              return;
            }
            // GET /session-identity?sessionId=… — 子代理会话身份（用户迭代
            // 2026-09-10「子代理隐藏团队按钮」）：输入栏团队按钮对已寻址子代理
            // 会话降级——eteams 成员/领队/构建师子代理渲染只读身份面（头像 +
            // 名字），无关子代理整个按钮隐藏。主会话不查此端点（选择/锁定交互
            // 照旧）；只读磁盘真相，无副作用。
            if (
              req.method === 'GET' &&
              segments[0] === 'session-identity' &&
              segments.length === 1
            ) {
              const sessionId = url.searchParams.get('sessionId') ?? '';
              const identity = await sessionIdentityOf(ctx, config, sessionId);
              if (identity === undefined) {
                sendJson(res, 200, { empty: true });
                return;
              }
              sendJson(res, 200, { empty: false, ...identity });
              return;
            }
            // POST /session-team/clear — deselect (plain conversation again).
            if (
              req.method === 'POST' &&
              segments[0] === 'session-team' &&
              segments[1] === 'clear' &&
              segments.length === 2
            ) {
              const body = parseJsonObject(await readBody(req));
              const sessionId = str(body.sessionId, '');
              if (sessionId === '') {
                sendError(res, 400, 'sessionId 不能为空');
                return;
              }
              clearSessionTeam(sessionId);
              sendJson(res, 200, { ok: true });
              return;
            }
            if (req.method === 'POST' && segments[0] === 'roster' && segments.length === 1) {
              const body = parseJsonObject(await readBody(req));
              // 用户迭代 2026-09-03：面板显式保存（名称/头像/手册一体）——
              // allowLeader 放行领队编辑；avatar 从详情页「随机头像」透传
              // （此前该路由丢弃 avatar，落库永远沿用旧头像）。
              const bodyAvatar = readAvatarPair(body.avatar);
              // 排障留痕：收到保存请求即记一行（客户端发没发 avatar、宿主
              // 收没收到，两端证据各占一边）。
              appendHostLog(ctx, config, {
                kind: 'roster-save',
                name: str(body.name, ''),
                hasAvatar: bodyAvatar !== undefined,
                avatar: bodyAvatar ?? null,
              });
              const stored = await upsertRosterMember(
                rootForWrites(ctx, config),
                {
                  name: str(body.name, ''),
                  role: str(body.role, ''),
                  ...(body.profile !== undefined ? { profile: str(body.profile) } : {}),
                  ...(body.duty !== undefined ? { duty: str(body.duty) } : {}),
                  ...(body.style !== undefined ? { style: str(body.style) } : {}),
                  ...(body.skills !== undefined ? { skills: str(body.skills) } : {}),
                  ...(Array.isArray(body.rules) ? { rules: body.rules.map((r) => str(r)) } : {}),
                  ...(body.executionPrompt !== undefined
                    ? { executionPrompt: str(body.executionPrompt) }
                    : {}),
                  ...(body.personaMd !== undefined ? { personaMd: str(body.personaMd) } : {}),
                  ...(bodyAvatar !== undefined ? { avatar: bodyAvatar } : {}),
                },
                { allowLeader: true, allowRoot: true },
              );
              sendJson(res, 200, { ok: true, member: stored });
              return;
            }
            if (req.method === 'POST' && segments[0] === 'team' && segments.length === 1) {
              const body = parseJsonObject(await readBody(req));
              const name = str(body.name, '');
              const sessionId = str(body.sessionId, '');
              if (name === '' || sessionId === '') {
                sendError(res, 400, 'name / sessionId 均不能为空');
                return;
              }
              // 建队即生效（docs/35 §5#1：审批环节下线，目标在对话中确认）。
              const workspace = writeWorkspacePath(ctx, config);
              const team = await createTeam(envFor(ctx, config, workspace), agentFor(sessionId), {
                name,
                via: 'panel',
              });
              sendJson(res, 200, { ok: true, teamId: team.id, name: team.name });
              return;
            }
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 3 &&
              segments[2] === 'member'
            ) {
              const body = parseJsonObject(await readBody(req));
              const name = str(body.name, '');
              if (name === '') {
                sendError(res, 400, 'name 不能为空');
                return;
              }
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, `团队 ${segments[1]} 不存在`);
                return;
              }
              const { team, workspacePath } = located;
              // sourceName: add a copy of a roster role under a new name
              // (user iteration 2026-09: multiple same roles per team).
              // 成员库跨工作区兜底（用户迭代 2026-09-04）：角色库固定落在
              // writeWorkspacePath（注册表首个有状态的工作区），团队却可能
              // 建在别的工作区——团队本区没有该条目时按注册表逐区查找。
              const wanted = str(body.sourceName, '') || name;
              const { entry } =
                findRosterMemberAcrossWorkspaces(ctx, config, wanted, workspacePath) ?? {};
              if (body.fromRoster === true && !entry) {
                sendError(res, 404, `成员库中没有「${name}」`);
                return;
              }
              let result;
              try {
                result = await addMember(envFor(ctx, config, workspacePath), captainAgentOf(team), {
                  // 面板路由已按 id 定位团队：显式传 teamId 走 requireTeamById
                  // （无任务团队锚点为空串时按合成代理放行，docs/51）。
                  teamId: team.id,
                  name,
                  role: str(body.role, entry?.role ?? 'member'),
                  ...(body.executionPrompt !== undefined
                    ? { executionPrompt: str(body.executionPrompt) }
                    : entry?.executionPrompt !== undefined
                      ? { executionPrompt: entry.executionPrompt }
                      : {}),
                  ...(body.duty !== undefined
                    ? { duty: str(body.duty) }
                    : entry?.duty !== undefined
                      ? { duty: entry.duty }
                      : {}),
                  ...(body.style !== undefined
                    ? { style: str(body.style) }
                    : entry?.style !== undefined
                      ? { style: entry.style }
                      : {}),
                  ...(body.skills !== undefined
                    ? { skills: str(body.skills) }
                    : entry?.skills !== undefined
                      ? { skills: entry.skills }
                      : {}),
                  ...(Array.isArray(body.rules)
                    ? { rules: body.rules.map((r) => str(r)) }
                    : entry?.rules !== undefined
                      ? { rules: entry.rules }
                      : {}),
                  ...(body.personaMd !== undefined
                    ? { personaMd: str(body.personaMd) }
                    : entry?.personaMd !== undefined
                      ? { personaMd: entry.personaMd }
                      : {}),
                  ...(entry?.avatar !== undefined ? { avatar: entry.avatar } : {}),
                  via: 'panel',
                });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, {
                ok: true,
                teamId: team.id,
                member: {
                  name: result.member.name,
                  role: result.member.role,
                  employeeId: result.member.employeeId ?? null,
                },
              });
              return;
            }
            // POST /roster/<name>/remove — delete a roster member (领队除外).
            if (
              req.method === 'POST' &&
              segments[0] === 'roster' &&
              segments.length === 3 &&
              segments[2] === 'remove'
            ) {
              if (segments[1] === LEADER_NAME) {
                sendError(res, 400, '领队成员不可删除');
                return;
              }
              try {
                await removeRosterMember(rootForWrites(ctx, config), segments[1]!);
              } catch (e) {
                sendError(res, 404, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, { ok: true, removed: segments[1] });
              return;
            }
            // POST /team/<id>/member/<ref>/remove — move a member out of a team.
            // <ref> 收工号（R4 成员作用域路由按号定位；名字串旧口径回退）。
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 5 &&
              segments[2] === 'member' &&
              segments[4] === 'remove'
            ) {
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, `团队 ${segments[1]} 不存在`);
                return;
              }
              const { team, workspacePath } = located;
              const member = rosterMemberByRef(team, segments[3]!);
              if (member === undefined) {
                sendError(res, 404, `成员 ${segments[3]} 不存在`);
                return;
              }
              try {
                await removeMember(
                  envFor(ctx, config, workspacePath),
                  captainAgentOf(team),
                  member.name,
                  team.id,
                  member.employeeId,
                );
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, { ok: true, removed: member.name });
              return;
            }
            // POST /team/<id>/member/<ref>/model - set the member's model
            // route (user iteration 2026-09: model select on the member
            // card). Empty body resets to inherited. <ref> 按工号定位（R4）。
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 5 &&
              segments[2] === 'member' &&
              segments[4] === 'model'
            ) {
              const body = parseJsonObject(await readBody(req));
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, '团队 ' + segments[1] + ' 不存在');
                return;
              }
              const { team, workspacePath } = located;
              const member = rosterMemberByRef(team, segments[3]!);
              if (member === undefined) {
                sendError(res, 404, `成员 ${segments[3]} 不存在`);
                return;
              }
              try {
                await setMemberModel(envFor(ctx, config, workspacePath), captainAgentOf(team), {
                  teamId: team.id,
                  name: member.name,
                  ...(member.employeeId !== undefined ? { employeeId: member.employeeId } : {}),
                  ...(str(body.provider, '') !== '' ? { provider: str(body.provider) } : {}),
                  ...(str(body.model, '') !== '' ? { model: str(body.model) } : {}),
                  ...(str(body.reasoningEffort, '') !== ''
                    ? { reasoningEffort: str(body.reasoningEffort) }
                    : {}),
                });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, { ok: true });
              return;
            }
            // POST /team/<id>/member/<ref>/persona - save the member's own
            // handbook copy (用户迭代 2026-09 四: member detail is separate
            // from the role detail; only the member record is written).
            // <ref> 按工号定位（R4）。
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 5 &&
              segments[2] === 'member' &&
              segments[4] === 'persona'
            ) {
              const body = parseJsonObject(await readBody(req));
              const personaMd = str(body.personaMd, '');
              if (personaMd.trim() === '') {
                sendError(res, 400, 'personaMd 不能为空');
                return;
              }
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, '团队 ' + segments[1] + ' 不存在');
                return;
              }
              const { team, workspacePath } = located;
              const member = rosterMemberByRef(team, segments[3]!);
              if (member === undefined) {
                sendError(res, 404, `成员 ${segments[3]} 不存在`);
                return;
              }
              try {
                await updateMember(envFor(ctx, config, workspacePath), captainAgentOf(team), {
                  teamId: team.id,
                  name: member.name,
                  ...(member.employeeId !== undefined ? { employeeId: member.employeeId } : {}),
                  personaMd,
                });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, { ok: true });
              return;
            }
            // POST /team/<id>/member/<ref>/sync-roster - push the member's
            // handbook copy back to its roster role (用户迭代 2026-09 四:
            // 同步到该角色; creates the roster entry for copy members).
            // <ref> 按工号定位（R4）。
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 5 &&
              segments[2] === 'member' &&
              segments[4] === 'sync-roster'
            ) {
              const body = parseJsonObject(await readBody(req));
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, '团队 ' + segments[1] + ' 不存在');
                return;
              }
              const { team, workspacePath } = located;
              const member = rosterMemberByRef(team, segments[3]!);
              if (member === undefined) {
                sendError(res, 404, `成员 ${segments[3]} 不存在`);
                return;
              }
              try {
                await syncMemberToRoster(envFor(ctx, config, workspacePath), captainAgentOf(team), {
                  teamId: team.id,
                  name: member.name,
                  ...(member.employeeId !== undefined ? { employeeId: member.employeeId } : {}),
                  ...(str(body.personaMd, '') !== '' ? { personaMd: str(body.personaMd) } : {}),
                });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, { ok: true });
              return;
            }
            // POST /team/<id>/leader/<remove|restore> - move the leader out
            // of / back into the team member roster (user iteration 2026-09:
            // the leader is deletable and re-addable).
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 4 &&
              segments[2] === 'leader' &&
              (segments[3] === 'remove' || segments[3] === 'restore')
            ) {
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, '团队 ' + segments[1] + ' 不存在');
                return;
              }
              const { team, workspacePath } = located;
              try {
                await setLeaderRemoved(envFor(ctx, config, workspacePath), captainAgentOf(team), {
                  teamId: team.id,
                  removed: segments[3] === 'remove',
                });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, { ok: true });
              return;
            }
            // POST /team/<id>/leader/model - set the leader's model route
            // (用户迭代 2026-09-04 恢复领队模型选择：领队卡模型二级菜单写
            // task_members 领队行，领队子代理派发按它解析). Empty model
            // resets to 会话默认.
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 4 &&
              segments[2] === 'leader' &&
              segments[3] === 'model'
            ) {
              const body = parseJsonObject(await readBody(req));
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, '团队 ' + segments[1] + ' 不存在');
                return;
              }
              const { team, workspacePath } = located;
              try {
                await setLeaderModel(envFor(ctx, config, workspacePath), captainAgentOf(team), {
                  teamId: team.id,
                  ...(str(body.provider, '') !== '' ? { provider: str(body.provider) } : {}),
                  ...(str(body.model, '') !== '' ? { model: str(body.model) } : {}),
                  ...(str(body.reasoningEffort, '') !== ''
                    ? { reasoningEffort: str(body.reasoningEffort) }
                    : {}),
                });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, { ok: true });
              return;
            }
            // POST /team/<id>/delete — permanently remove a team directory
            // (deleteTeam rejects teams with active tasks; cancel or finish
            // them first). 团队列表小卡片「删除」按钮（用户迭代 2026-09 七）。
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 3 &&
              segments[2] === 'delete'
            ) {
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, `团队 ${segments[1]} 不存在`);
                return;
              }
              const { team, workspacePath } = located;
              try {
                await deleteTeam(envFor(ctx, config, workspacePath), captainAgentOf(team), team.id);
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, { ok: true });
              return;
            }
            // ---------- conversation task workflow (docs/26) ----------
            // POST /team/<id>/task — panel 小任务 CRUD（docs/26 审阅步骤）：
            // 用户在任务页修改/删除拆解出的小任务、新增小任务；任务一经领取
            // （updateTask/deleteTask 校验 creating/ready）即冻结。
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 3 &&
              segments[2] === 'task'
            ) {
              const body = parseJsonObject(await readBody(req));
              const subject = str(body.subject, '');
              if (subject === '') {
                sendError(res, 400, 'subject 不能为空');
                return;
              }
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, `团队 ${segments[1]} 不存在`);
                return;
              }
              const { team, workspacePath } = located;
              const chain = readChainParam(body.chain);
              const parentTaskId = readTaskIdParam(body.parentTaskId);
              // 二十七轮 DA40：建卡补收 dependencies（与 update 路由同参数
              // 口径——小任务执行顺序 = 兄弟依赖链，链式接力按它排发棒序）。
              const dependencies = readDependenciesParam(body.dependencies);
              // v6 主会话快照：客户端从活跃对话上报 sessionId（与心跳
              // buildPresence 同源），面板建任务即登记主会话——落库后不变。
              const mainSessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
              try {
                const task = await createTask(
                  envFor(ctx, config, workspacePath),
                  { teamId: team.id, actor: { kind: 'user', name: '用户' } },
                  {
                    subject,
                    ...(body.description !== undefined
                      ? { description: str(body.description) }
                      : {}),
                    ...(parentTaskId !== undefined ? { parentTaskId } : {}),
                    ...(chain !== undefined ? { chain } : {}),
                    ...(dependencies !== undefined ? { dependencies } : {}),
                    ...(mainSessionId !== '' ? { mainSessionId } : {}),
                  },
                );
                sendJson(res, 200, { ok: true, taskId: task.id, status: task.status });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
              }
              return;
            }
            // POST /team/<id>/task/commission — 面板手动创建主任务容器
            // （docs/panelTaskCommission）：用户填任务描述（+选团队）→ 建
            // 「创建中」容器（mainSessionId 记主会话快照）→ 交完善者完善：
            // 有领队 = 持续领队子代理（captainFor 父锚 + dispatchCaptainCore
            // ——与对话派发同一链路）；无领队 = 主会话直接完善（captainFor
            // 唤醒，wakeCaptain 同款 followup；主会话经任务行快照判为
            // captain，root 作用域领队工具可用）。完善者未送达不回滚——任务
            // 留在创建中（可删除重试），detail 带原因。
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 4 &&
              segments[2] === 'task' &&
              segments[3] === 'commission'
            ) {
              const body = parseJsonObject(await readBody(req));
              const description = str(body.description, '');
              if (description === '') {
                sendError(res, 400, 'description 不能为空');
                return;
              }
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, `团队 ${segments[1]} 不存在`);
                return;
              }
              const { team, workspacePath } = located;
              const env = envFor(ctx, config, workspacePath);
              // v6 主会话快照：客户端从活跃对话上报 sessionId——无领队路径
              // 的唤醒目标与任务行快照都靠它（整页覆盖层无 sessionId 时退
              // captainFor 的心跳/冷恢复梯度）。
              const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
              // 绑定守卫：会话已绑定其他团队 → resolveCaller 绑定优先会错配
              // caller.team，完善者调 eteams_* 必报「任务不存在」。提前变成
              // 可诊断的明确失败（任务仍创建，留在创建中可删）。
              const boundTeam = sessionId !== '' ? getSessionTeamId(sessionId) : undefined;
              // 主题 = 描述首行截断占位（完善者收口时回写真主题；「创建中」
              // 期间卡片可读）。
              const firstLine =
                description.split(/\r?\n/).find((line) => line.trim() !== '') ?? description;
              const subject = firstLine.trim().slice(0, COMMISSION_SUBJECT_MAX) || '未命名任务';
              let task: TaskRecord;
              try {
                task = await createTask(
                  env,
                  { teamId: team.id, actor: { kind: 'user', name: '用户' } },
                  {
                    subject,
                    description,
                    kind: 'group',
                    status: 'creating',
                    ...(sessionId !== '' ? { mainSessionId: sessionId } : {}),
                  },
                );
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              // 派发段按团队串行；任何失败都只落 detail（任务已入册不回滚）。
              const dispatchNote = await withCommissionLock(String(team.id), async () => {
                if (boundTeam !== undefined && boundTeam !== String(team.id)) {
                  return '该会话已绑定其他团队，完善指令无法投递（任务保留为创建中，可删除后重试）';
                }
                const anchor = await captainFor(env, team, task);
                if (anchor === undefined) {
                  return '未找到主会话锚点（会话不在线且无法冷恢复；在对应团队对话中绑定后重试）';
                }
                if (team.hasLeader) {
                  try {
                    // 有领队：完善指令走回合 sidecar，子代理经
                    // eteams_captain_guide 自取（可见 prompt 一句话领规程）。
                    await dispatchCaptainCore(env, config, anchor, team, task.id, {
                      kind: 'commission',
                      message: captainCommissionMessage(task.id, task.subject, description),
                    });
                    return '';
                  } catch (e) {
                    return `领队子代理派发失败：${e instanceof Error ? e.message : String(e)}`;
                  }
                }
                try {
                  // 无领队：完善指令直接进主对话（主会话不在 guide 工具的
                  // 收件人语义里，保留自取现状指令的完整 prompt）。
                  anchor.followup(
                    createUserMessage({
                      content: [
                        { type: 'text', text: captainCommissionPrompt(task.id, task.subject, description) },
                      ],
                      source: { kind: 'plugin', plugin: 'dsh-eteams' },
                    }),
                  );
                  return '';
                } catch (e) {
                  return `主会话唤醒失败：${e instanceof Error ? e.message : String(e)}`;
                }
              });
              // 事件如实记派发结果（动态视图 summarizeEvent 消费）。
              try {
                await recordEvent(
                  stateRootFor(config, workspacePath),
                  team.id,
                  { kind: 'user', name: '用户' },
                  'task_commissioned',
                  {
                    taskId: task.id,
                    payload: {
                      hasLeader: team.hasLeader,
                      dispatched: dispatchNote === '',
                      ...(dispatchNote !== '' ? { reason: dispatchNote } : {}),
                    },
                  },
                );
              } catch (e) {
                // 计量/事件绝不影响响应（失败只留日志）。
                const logger = (ctx as unknown as { logger?: { warn?: (msg: string) => void } })
                  .logger;
                if (typeof logger?.warn === 'function') {
                  logger.warn(`eteams: commission event failed: ${String(e)}`);
                }
              }
              sendJson(res, 200, {
                ok: true,
                taskId: task.id,
                dispatched: dispatchNote === '',
                ...(dispatchNote !== '' ? { detail: dispatchNote } : {}),
              });
              return;
            }
            // POST /team/<id>/task/<taskId>/update — 修改未领取小任务（主题/
            // 说明/成员槽）。二十八轮 DA41：补收 contractMd **raw 透传**（绕
            // 开 str() 的 trim——MD 正文首尾空白属内容，面板就地编辑把「说明 +
            // 合同」并读后的整篇 Markdown 原样发回）。
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 5 &&
              segments[2] === 'task' &&
              segments[4] === 'update'
            ) {
              const body = parseJsonObject(await readBody(req));
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, `团队 ${segments[1]} 不存在`);
                return;
              }
              const { team, workspacePath } = located;
              const chain = readChainParam(body.chain);
              const dependencies = readDependenciesParam(body.dependencies);
              const taskId = Number.parseInt(segments[3] ?? '', 10);
              try {
                const task = await updateTask(
                  envFor(ctx, config, workspacePath),
                  { teamId: team.id, actor: { kind: 'user', name: '用户' } },
                  {
                    taskId,
                    ...(str(body.subject, '') !== '' ? { subject: str(body.subject) } : {}),
                    ...(body.description !== undefined
                      ? { description: str(body.description) }
                      : {}),
                    // DA41：contractMd raw 透传（不走 str() 的 trim，MD 正文
                    // 首尾空白属内容）。
                    ...(typeof body.contractMd === 'string' ? { contractMd: body.contractMd } : {}),
                    ...(chain !== undefined ? { chain } : {}),
                    ...(dependencies !== undefined ? { dependencies } : {}),
                  },
                );
                sendJson(res, 200, { ok: true, taskId: task.id });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
              }
              return;
            }
            // POST /team/<id>/task/<taskId>/delete — 删除未领取任务（主任务
            // 级联删除全部小任务并清任务文件夹）。
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 5 &&
              segments[2] === 'task' &&
              segments[4] === 'delete'
            ) {
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, `团队 ${segments[1]} 不存在`);
                return;
              }
              const { team, workspacePath } = located;
              const deleteTaskId = Number.parseInt(segments[3] ?? '', 10);
              if (!Number.isFinite(deleteTaskId)) {
                sendError(res, 400, `任务号无效：${segments[3]}`);
                return;
              }
              try {
                await deleteTask(
                  envFor(ctx, config, workspacePath),
                  { teamId: team.id, actor: { kind: 'user', name: '用户' } },
                  deleteTaskId,
                );
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, { ok: true });
              return;
            }
            // POST /team/<id>/task/<taskId>/start — 面板开始任务（二十四轮
            // DA37，用户拍板「卡片加上开始按钮」）：把 ready 任务派发给执行
            // 链下一站（复用 assignTask 派发核——起子会话 + 投递指派信 +
            // ready→wait 待接取）。空链 400「需要选择成员」（用户拍板「如果
            // 有任务没有成员，则提示需要选择成员就行」——客户端对空链卡不
            // 渲染按钮，此处兜底）；链已到末站无下一站同闸另文。依赖未完成/
            // 执行者占用/领队不在线等由派发核原样拒绝（400 透出）。二十五轮
            // DA38：主任务（容器）走整体开始分支（逐个派发 ready 小任务，
            // 跳过卡回传原因）。
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 5 &&
              segments[2] === 'task' &&
              segments[4] === 'start'
            ) {
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, `团队 ${segments[1]} 不存在`);
                return;
              }
              const { team, workspacePath } = located;
              const startTaskId = Number.parseInt(segments[3] ?? '', 10);
              if (!Number.isFinite(startTaskId)) {
                sendError(res, 400, `任务号无效：${segments[3]}`);
                return;
              }
              const task = team.tasks.find((t) => t.id === startTaskId);
              if (task === undefined) {
                sendError(res, 404, `任务 #${startTaskId} 不存在`);
                return;
              }
              // 有领队：开始/继续交领队主持（用户 2026-09-12 拍板「静默唤醒主
              // 对话，然后走领队」）——宿主静默解析/复活主会话锚点（captainFor，
              // 无用户可见消息），再把本大任务的领队子代理唤醒
              // （dispatchCaptainCore，turn=start），由领队按执行链指派；不再由
              // 宿直接把成员派出去而绕过领队。无领队团队保持下方宿主直派路径
              // 不变（承载「需要选择成员」等就地跳过反馈）。
              if (team.hasLeader) {
                const leaderEnv = envFor(ctx, config, workspacePath);
                const rootTaskId = task.parentId ?? task.id;
                const anchor = await captainFor(leaderEnv, team, task);
                if (anchor === undefined) {
                  sendError(res, 400, '未找到主会话锚点（领队派发父锚），无法把开始交给领队');
                  return;
                }
                try {
                  await dispatchCaptainCore(leaderEnv, config, anchor, team, rootTaskId, {
                    kind: 'start',
                    message: captainStartMessage(
                      task.id,
                      task.subject,
                      rootTaskId,
                      task.status === 'paused',
                    ),
                  });
                } catch (e) {
                  sendError(res, 400, e instanceof Error ? e.message : String(e));
                  return;
                }
                sendJson(res, 200, { ok: true, started: 0, skipped: [] });
                return;
              }
              // 二十五轮 DA38：主任务（容器）分支——「开始」= 逐个派发全部
              // ready 小任务（用户拍板「主任务启动就代表着小任务需要逐个
              // 开始执行了」）。每卡独立走派发核，无链（「需要选择成员」）/
              // 依赖未满/占用/起会话失败的卡跳过并回传原因（200 + skipped，
              // 面板行内就地提示）；非主任务走下方单任务链派发路径不变。
              if (task.parentId === null && team.tasks.some((x) => x.parentId === task.id)) {
                try {
                  const result = await startGroupTask(
                    envFor(ctx, config, workspacePath),
                    { teamId: team.id, actor: { kind: 'user', name: '用户' } },
                    startTaskId,
                  );
                  sendJson(res, 200, {
                    ok: true,
                    started: result.started,
                    skipped: result.skipped,
                  });
                } catch (e) {
                  sendError(res, 400, e instanceof Error ? e.message : String(e));
                }
                return;
              }
              // 用户迭代 2026-09-11：挂起（成员回合被中断）的任务点「开始」=
              // 恢复——resumeTask 按上一次尝试的成员续跑（站号 = chainCursor+1），
              // 与 startGroupTask 的挂起卡分支同口径；不再撞「只能指派 ready 任务」。
              if (task.status === 'paused') {
                try {
                  await resumeTask(
                    envFor(ctx, config, workspacePath),
                    { teamId: team.id, actor: { kind: 'user', name: '用户' } },
                    startTaskId,
                  );
                } catch (e) {
                  sendError(res, 400, e instanceof Error ? e.message : String(e));
                  return;
                }
                sendJson(res, 200, { ok: true });
                return;
              }
              const next = task.chain[task.chainCursor + 1];
              if (next === undefined) {
                sendError(
                  res,
                  400,
                  task.chain.length === 0
                    ? '需要选择成员'
                    : `任务 #${startTaskId} 执行链已到末站，无下一站可派发`,
                );
                return;
              }
              try {
                // 僵尸指派（ready + 待接取尝试）幂等重发——成员回合被中断后
                // 尝试停在待接取、任务留在 ready，防重复派发闸会把「开始」拒死
                // （用户迭代 2026-09-11 回归：任务 27 点开始没反应）。重发直接
                // 重投指派信+唤醒，不新开 attempt；无僵尸指派才走正常派发。
                const redelivered = await redeliverAssignment(
                  envFor(ctx, config, workspacePath),
                  { teamId: team.id, actor: { kind: 'user', name: '用户' } },
                  startTaskId,
                );
                if (redelivered === undefined) {
                  await assignTask(
                    envFor(ctx, config, workspacePath),
                    { teamId: team.id, actor: { kind: 'user', name: '用户' } },
                    { taskId: startTaskId, member: next.member },
                  );
                }
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, { ok: true });
              return;
            }
            // POST /team/<id>/task/<taskId>/pause — 面板暂停任务（用户迭代
            // 2026-09-11：主任务开始后按钮应变为「暂停」）：容器挂起全部在跑
            // 小任务 + 容器本身；单任务走 suspendTask。再点「开始」由
            // startGroupTask / resumeTask 续跑。
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 5 &&
              segments[2] === 'task' &&
              segments[4] === 'pause'
            ) {
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, `团队 ${segments[1]} 不存在`);
                return;
              }
              const { team, workspacePath } = located;
              const pauseTaskId = Number.parseInt(segments[3] ?? '', 10);
              if (!Number.isFinite(pauseTaskId)) {
                sendError(res, 400, `任务号无效：${segments[3]}`);
                return;
              }
              if (!team.tasks.some((t) => t.id === pauseTaskId)) {
                sendError(res, 404, `任务 #${pauseTaskId} 不存在`);
                return;
              }
              try {
                await suspendGroupTask(
                  envFor(ctx, config, workspacePath),
                  { teamId: team.id, actor: { kind: 'user', name: '用户' } },
                  pauseTaskId,
                );
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, { ok: true });
              return;
            }
            // DA25：列表卡文件夹路径可点击，系统文件管理器中打开）。目录由
            // workspacePath + 任务 work_dir 现算（taskDirAbs），缺失 400；
            // 打开器可经 WebSurfaceOptions 注入（测试不真拉 explorer）。
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 6 &&
              segments[2] === 'task' &&
              segments[4] === 'folder' &&
              segments[5] === 'open'
            ) {
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, `团队 ${segments[1]} 不存在`);
                return;
              }
              const { team, workspacePath } = located;
              const openTaskId = Number.parseInt(segments[3] ?? '', 10);
              if (!Number.isFinite(openTaskId)) {
                sendError(res, 400, `任务号无效：${segments[3]}`);
                return;
              }
              const task = team.tasks.find((t) => t.id === openTaskId);
              if (task === undefined) {
                sendError(res, 404, `任务 #${openTaskId} 不存在`);
                return;
              }
              const dir = taskDirAbs(workspacePath, team, task);
              if (!existsSync(dir)) {
                sendError(res, 400, `任务文件夹不存在：${dir}`);
                return;
              }
              try {
                await openFolder(dir);
              } catch (e) {
                sendError(
                  res,
                  500,
                  `打开文件夹失败：${e instanceof Error ? e.message : String(e)}`,
                );
                return;
              }
              sendJson(res, 200, { ok: true, dir });
              return;
            }
            // docs/35 §5#1：批准环节下线（POST /team/<id>/approve 路由与
            // 'plan.approved' 事件分支随之删除）——计划在对话内确认，任务
            // 就绪后由领队直接指派执行。
            // ---------- role-builder build session (docs/19.6, D18) ----------
            // GET /rolebuilder — the single build-session slot; {empty:true}
            // when no session exists yet. 会话存在时附带 parentOnline（用户反馈
            // 2026-09-05 第二批）：发起构建的 /eteam 父会话是否在线——面板据
            // 此决定「已放弃本次构建」卡是否渲染（父不在线时继续构建无从
            // 派发，卡不显示，避免死按钮）。只挂响应、不落盘。
            if (req.method === 'GET' && segments[0] === 'rolebuilder' && segments.length === 1) {
              const root = rootForWrites(ctx, config);
              const session = readBuildSession(root);
              if (session === null) {
                sendJson(res, 200, { empty: true });
                return;
              }
              const parentSessionId = readBuildParentSession(root);
              const parent =
                parentSessionId !== null
                  ? (ctx as unknown as RuntimeContext).agents?.get(parentSessionId)
                  : undefined;
              sendJson(res, 200, {
                empty: false,
                session,
                parentOnline: parent !== undefined,
              });
              return;
            }
            // POST /rolebuilder/confirm — the user-confirmed draft lands in
            // the roster and the session flips to confirmed in one host-side
            // operation (D18-6, 确认前零落库的唯一写点).
            if (
              req.method === 'POST' &&
              segments[0] === 'rolebuilder' &&
              segments.length === 2 &&
              segments[1] === 'confirm'
            ) {
              const current = readBuildSession(rootForWrites(ctx, config));
              if (current === null || current.status !== 'awaiting_confirmation') {
                sendError(res, 409, '没有待确认的构建草稿（状态非 awaiting_confirmation）');
                return;
              }
              const body = parseJsonObject(await readBody(req));
              const draft: BuildDraft = {
                name: str(body.name, ''),
                role: str(body.role, ''),
                ...(body.profile !== undefined ? { profile: str(body.profile) } : {}),
                ...(body.duty !== undefined ? { duty: str(body.duty) } : {}),
                ...(body.style !== undefined ? { style: str(body.style) } : {}),
                ...(body.skills !== undefined ? { skills: str(body.skills) } : {}),
                ...(Array.isArray(body.rules) ? { rules: body.rules.map((r) => str(r)) } : {}),
                ...(body.executionPrompt !== undefined
                  ? { executionPrompt: str(body.executionPrompt) }
                  : {}),
                ...(body.personaMd !== undefined ? { personaMd: str(body.personaMd) } : {}),
                ...(isAvatarPair(body.avatar) ? { avatar: body.avatar } : {}),
                ...(body.model !== undefined ? { model: str(body.model) } : {}),
                ...(body.reasoningEffort !== undefined
                  ? { reasoningEffort: str(body.reasoningEffort) }
                  : {}),
              };
              if (draft.name === '' || draft.role === '') {
                sendError(res, 400, 'name / role 均不能为空');
                return;
              }
              try {
                const root = rootForWrites(ctx, config);
                const { session, memberName } = await confirmBuildSession(root, draft);
                // 不再代收子代理（docs/19.17.1）：子代理上报待确认草稿后已收束
                // 回合，确认入库由宿主直接落库，无须唤醒或代收。
                sendJson(res, 200, {
                  ok: true,
                  status: session.status,
                  name: memberName,
                  role: draft.role,
                });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
              }
              return;
            }
            // POST /rolebuilder/cancel — abandon the current build session（docs/19.16
            // 持续构建子代理）：终态落盘后 interrupt 当前回合（durable 会话
            // 保留——恢复经 followup 或冷恢复重建续聊）；父离线退 user 权限，
            // 目标缺失是可接受 no-op，绝不阻塞放弃本身。
            if (
              req.method === 'POST' &&
              segments[0] === 'rolebuilder' &&
              segments.length === 2 &&
              segments[1] === 'cancel'
            ) {
              try {
                const root = rootForWrites(ctx, config);
                const session = await cancelBuildSession(root);
                const cancelParentSessionId = readBuildParentSession(root);
                void stopBuilderChild({
                  ctx: { subagents: (ctx as unknown as RuntimeContext).subagents },
                  parent:
                    cancelParentSessionId !== null
                      ? (ctx as unknown as RuntimeContext).agents?.get(cancelParentSessionId)
                      : undefined,
                  stateRoot: root,
                  mode: 'interrupt',
                  logger: (ctx as unknown as RuntimeContext).logger,
                });
                sendJson(res, 200, { ok: true, status: session.status });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
              }
              return;
            }
            // POST /rolebuilder/resume — continue a cancelled build（docs/19.16
            // 持续构建子代理）：父会话在线闸前置（不在线诚实 409——followup
            // 唤醒必然拿不到父代理），翻转 cancelled→active 在单构建锁内由
            // wakeBuilderChild 完成（双入口竞态只有第一个生效），随后宿主
            // followup 唤醒同一持续子代理（失败冷恢复重建，再失败回滚
            // cancelled——不留无代理的 active 会话卡门禁）。
            if (
              req.method === 'POST' &&
              segments[0] === 'rolebuilder' &&
              segments.length === 2 &&
              segments[1] === 'resume'
            ) {
              try {
                const root = rootForWrites(ctx, config);
                const pre = readBuildSession(root);
                if (pre === null) {
                  sendError(res, 400, '没有可恢复的构建会话');
                  return;
                }
                if (pre.status !== 'cancelled') {
                  sendError(res, 409, `仅已放弃的构建可恢复（当前状态：${pre.status}）`);
                  return;
                }
                // 父会话在线性前置校验（先于恢复）：不在线就不改状态、诚实
                // 报错——否则恢复成 active 后没有代理续跑，面板再次假卡死。
                const parentSessionId = readBuildParentSession(root);
                const parent =
                  parentSessionId !== null
                    ? (ctx as unknown as RuntimeContext).agents?.get(parentSessionId)
                    : undefined;
                if (parent === undefined) {
                  sendError(
                    res,
                    409,
                    `父会话（${parentSessionId ?? '未知'}）当前不在线——构建未恢复。请先打开发起 /eteam 的对话，再点「继续构建」。`,
                  );
                  return;
                }
                await wakeBuilderChild({
                  ctx: { subagents: (ctx as unknown as RuntimeContext).subagents },
                  config,
                  parent,
                  stateRoot: root,
                  kind: 'resume',
                  logger: (ctx as unknown as RuntimeContext).logger,
                  onSpawnFailure: () => {
                    // 唤醒与重建都失败 → 回滚成 cancelled，别让无子代理的
                    // active 会话卡住下一次「继续构建」。
                    void cancelBuildSession(root, '构建恢复失败——请稍后重试').catch(
                      () => undefined,
                    );
                  },
                });
                sendJson(res, 200, { ok: true, status: 'active' });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
              }
              return;
            }
            // POST /rolebuilder/restart — 手动重启构建代理（用户迭代，docs/19.16
            // 持续构建子代理）：宿主 followup 唤醒同一持续子代理重新核查
            // （followup 失败冷恢复重建——仍是同一构建，没有第二个代理）。
            // 前置校验 + 10s 防抖（updatedAt 被写走即天然占用），避免与提交
            // 答案/重复点击竞态。
            if (
              req.method === 'POST' &&
              segments[0] === 'rolebuilder' &&
              segments.length === 2 &&
              segments[1] === 'restart'
            ) {
              try {
                const root = rootForWrites(ctx, config);
                const current = readBuildSession(root);
                if (current === null) {
                  sendError(res, 400, '没有进行中的构建会话');
                  return;
                }
                if (current.status !== 'active') {
                  sendError(res, 409, `仅进行中的构建可重启（当前：${current.status}）`);
                  return;
                }
                if (current.interview === undefined || current.interview.answers !== undefined) {
                  sendError(
                    res,
                    409,
                    '当前没有待回答的意图访谈——代理可能正在工作中，请等其收工（草稿就绪/再次出题）后再试',
                  );
                  return;
                }
                if (Date.now() - current.updatedAt < 10_000) {
                  sendError(res, 429, '刚有构建代理更新过会话——请等 10 秒后再重启');
                  return;
                }
                const parentSessionId = readBuildParentSession(root);
                const parent =
                  parentSessionId !== null
                    ? (ctx as unknown as RuntimeContext).agents?.get(parentSessionId)
                    : undefined;
                if (parent === undefined) {
                  sendError(
                    res,
                    409,
                    `父会话（${parentSessionId ?? '未知'}）当前不在线——请先打开发起 /eteam 的对话，再重启。`,
                  );
                  return;
                }
                await reportBuildProgress(root, {
                  status: 'active',
                  step: '重启核查',
                  note: '已手动重启构建代理——重新核查进度与访谈',
                });
                await wakeBuilderChild({
                  ctx: { subagents: (ctx as unknown as RuntimeContext).subagents },
                  config,
                  parent,
                  stateRoot: root,
                  kind: 'restart',
                  logger: (ctx as unknown as RuntimeContext).logger,
                  onSpawnFailure: () => {
                    // 唤醒与重建都失败 → 回滚成 cancelled 并留可读出路，
                    // 别让无代理的 active 假死。
                    void cancelBuildSession(root, '构建唤醒失败——可稍后点「继续构建」重试').catch(
                      () => undefined,
                    );
                  },
                });
                sendJson(res, 200, { ok: true, status: 'active' });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
              }
              return;
            }
            // POST /rolebuilder/interview — user answered the intent interview
            // in the workbench (panel bypass entry; 2026-09-10 unified ask made
            // eteams_ask_user the primary pop path with host-side auto-persist):
            // store the answers, then followup-wake the SAME continuable builder
            // child to draft with the full session snapshot（唤醒去重在单构建
            // 锁内，双入口竞态时后者跳过）。
            if (
              req.method === 'POST' &&
              segments[0] === 'rolebuilder' &&
              segments.length === 2 &&
              segments[1] === 'interview'
            ) {
              try {
                const root = rootForWrites(ctx, config);
                const body = parseJsonObject(await readBody(req));
                const rawAnswers = Array.isArray(body.answers) ? body.answers : [];
                const answers = rawAnswers
                  .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
                  .map((a) => ({ id: str(a.id), choice: str(a.choice) }))
                  .filter((a) => a.id !== '' && a.choice !== '');
                if (answers.length === 0) {
                  sendError(res, 400, 'answers 不能为空');
                  return;
                }
                // 父会话在线性前置校验（先于落盘）：父不在线时 followup 唤醒
                // 必然失败——诚实报错并保留原访谈，而不是存了答案后静默卡死。
                const parentSessionId = readBuildParentSession(root);
                const parent =
                  parentSessionId !== null
                    ? (ctx as unknown as RuntimeContext).agents?.get(parentSessionId)
                    : undefined;
                if (parent === undefined) {
                  sendError(
                    res,
                    409,
                    `父会话（${parentSessionId ?? '未知'}）当前不在线——答案未保存。请切到发起 /eteam 的对话（打开即可）后重新提交；或先放弃本次构建再重新发起。`,
                  );
                  return;
                }
                const session = await answerBuildInterview(root, answers);
                await wakeBuilderChild({
                  ctx: { subagents: (ctx as unknown as RuntimeContext).subagents },
                  config,
                  parent,
                  stateRoot: root,
                  kind: 'continue',
                  logger: (ctx as unknown as RuntimeContext).logger,
                  onSpawnFailure: () => {
                    // followup 与冷恢复重建都失败 → 回滚成 cancelled 并留
                    // 可读出路（点「继续构建」= resume 唤醒同一子代理），
                    // 别让无代理的 active 假死。
                    void cancelBuildSession(root, '构建唤醒失败——可稍后点「继续构建」重试').catch(
                      () => undefined,
                    );
                  },
                });
                sendJson(res, 200, { ok: true, status: session.status });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
              }
              return;
            }
            // POST /presence — 活跃会话心跳（用户迭代：兜底弹窗 steer 到用户
            // 正在看的对话）：客户端从活跃对话的输入栏按钮上报 sessionId，
            // 宿主记 last-writer-wins，兜底 steer 前读取定位。fire-and-forget
            // 信号——坏了不影响主流程（退回父会话路径）。
            if (req.method === 'POST' && segments[0] === 'presence' && segments.length === 1) {
              try {
                const root = rootForWrites(ctx, config);
                const body = parseJsonObject(await readBody(req));
                const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
                if (sessionId === '') {
                  sendError(res, 400, 'sessionId 不能为空');
                  return;
                }
                await writeBuildPresence(root, sessionId);
                sendJson(res, 200, { ok: true });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
              }
              return;
            }
            if (req.method !== 'GET') {
              sendError(res, 405, 'M4 只读面板：仅支持 GET（写路由除外）');
              return;
            }
            if (segments[0] === 'roster' && segments.length === 1) {
              // Preset members (agency-agents-zh) appear on first access.
              await ensurePresetMembers(rootForWrites(ctx, config));
              sendJson(res, 200, { members: readRoster(rootForWrites(ctx, config)) });
              return;
            }
            if (segments[0] === 'board' && segments.length === 1) {
              // 跨团队聚合面板（docs/35 §6：Q1/Q3/Q4/Q5/Q9，纯只读 SQL）。
              // 根去重同 collectRoots（全局单库下多工作区一个根，不重复聚合）。
              const teams: unknown[] = [];
              for (const { root } of collectRoots(ctx, config)) {
                try {
                  teams.push(...boardOverview(root));
                } catch (e) {
                  const logger = (ctx as unknown as { logger?: { warn?: (m: string) => void } })
                    .logger;
                  if (typeof logger?.warn === 'function')
                    logger.warn(`eteams: board aggregation skipped a workspace: ${String(e)}`);
                }
              }
              sendJson(res, 200, { teams, serverTime: Date.now() });
              return;
            }
            if (segments[0] === 'state' && segments.length === 1) {
              sendJson(res, 200, {
                teams: await collectTeams(ctx, config),
                maxMembers: config.maxMembers,
                serverTime: Date.now(),
              });
              return;
            }
            // GET /usage/calendar?year=<y> — app-wide daily token calendar
            // (2026-09-05 user iteration: the board card shows the whole app's
            // daily consumption — no team/role filter; the workspace bucket
            // (plain conversations, one-shot build subagents) counts too).
            // collectRoots merges ledgers across workspaces (one root under the
            // global stateDir); year validation mirrors the team route.
            if (segments[0] === 'usage' && segments[1] === 'calendar' && segments.length === 2) {
              const yearParam = url.searchParams.get('year');
              const year =
                yearParam === null || yearParam === ''
                  ? new Date().getFullYear()
                  : Number(yearParam);
              if (!Number.isInteger(year) || year < 2000 || year > 2999) {
                sendError(res, 400, `year 参数无效（需 2000-2999 的整数）：${String(yearParam)}`);
                return;
              }
              const roots = collectRoots(ctx, config).map((located) => located.root);
              const calendar = readAppUsageCalendar(roots, year);
              sendJson(res, 200, {
                year,
                teamId: null,
                serverTime: Date.now(),
                days: calendar.days,
                totals: calendar.totals,
              });
              return;
            }
            // GET /session-route 已随子会话模型徽章改读客户端会话投影一并
            // 退役（用户迭代 2026-09-09 方案 A：modelSelection 持久投影 +
            // subagentAddress 全在客户端会话绑定上，进程内存登记本机制撤销）。
            // /team/<id>/... scoped reads resolve the team on any workspace.
            if (segments[0] === 'team' && segments.length >= 2) {
              const teamId = segments[1]!;
              const located = locateTeam(ctx, config, teamId);
              if (!located) {
                sendError(res, 404, `团队 ${teamId} 不存在`);
                return;
              }
              const { team, root, workspacePath } = located;
              if (segments.length === 2) {
                sendJson(res, 200, teamSnapshot(team, workspacePath, config));
                return;
              }
              if (segments[2] === 'events') {
                const afterSeq = Number(url.searchParams.get('afterSeq') ?? '0') || 0;
                const events = readEventsSync(root, team.id).filter((e) => e.seq > afterSeq);
                sendJson(res, 200, { events, serverTime: Date.now() });
                return;
              }
              // GET /team/<id>/agentactivity 已随「成员没有状态」一并退役
              // （用户迭代 2026-09-10：成员卡活动点撤，面板不再轮询本路由）。
              if (segments[2] === 'task' && segments[4] === 'track') {
                const taskId = Number.parseInt(segments[3] ?? '', 10);
                const task = Number.isFinite(taskId)
                  ? team.tasks.find((t) => t.id === taskId)
                  : undefined;
                if (!task) {
                  sendError(res, 404, `任务 #${segments[3]} 不存在`);
                  return;
                }
                const decision =
                  team.pendingDecisions.filter((d) => d.taskId === task.id).at(-1) ?? null;
                sendJson(res, 200, {
                  taskId: task.id,
                  attempts: task.attempts,
                  decision,
                  // 产出不落列（docs/35 §5#10）：反查 attempts 最新成功行。
                  outcome: taskOutcome(task) ?? null,
                  contract: {
                    subject: task.subject,
                    description: task.description ?? null,
                    contractMd: task.contractMd ?? null,
                    idempotencyNote: task.idempotencyNote ?? null,
                    chain: task.chain,
                  },
                });
                return;
              }
              if (segments[2] === 'member' && segments[4] === 'dialog') {
                // R4：对话框按工号定位成员（名字串旧口径回退）。
                const member = rosterMemberByRef(team, segments[3]!);
                if (member === undefined) {
                  sendError(res, 404, `成员 ${segments[3]} 不存在`);
                  return;
                }
                const after = Number(url.searchParams.get('after') ?? '0') || 0;
                sendJson(res, 200, memberDialog(root, team, member, after));
                return;
              }
              // GET /team/<id>/usage/calendar?year=<y> — 每日 Token 消耗日历
              // （docs/28.4）：读取时聚合 usage.jsonl + 归档，全年零填充日格
              // （未来年同构返回零格，不 404）。year 缺省当年；非法值 400。
              if (segments[2] === 'usage' && segments[3] === 'calendar' && segments.length === 4) {
                const yearParam = url.searchParams.get('year');
                const year =
                  yearParam === null || yearParam === ''
                    ? new Date().getFullYear()
                    : Number(yearParam);
                if (!Number.isInteger(year) || year < 2000 || year > 2999) {
                  sendError(res, 400, `year 参数无效（需 2000-2999 的整数）：${String(yearParam)}`);
                  return;
                }
                const calendar = readUsageCalendar(root, String(team.id), year);
                sendJson(res, 200, {
                  teamId: team.id,
                  year,
                  serverTime: Date.now(),
                  days: calendar.days,
                  totals: calendar.totals,
                });
                return;
              }
            }
            sendError(res, 404, `未知路由：${path}`);
          } catch (error) {
            sendError(res, 500, `面板路由内部错误：${String(error)}`);
          }
        },
      }),
    'eteams: web routes',
  );
  return true;
}

/** Resolve one team across all workspaces; returns it with its root paths. */
export function locateTeam(
  ctx: Context,
  config: ETeamsResolvedConfig,
  teamId: string,
): { team: TeamState; root: string; workspacePath: string } | undefined {
  return locateTeamAcrossWorkspaces(ctx, config, teamId);
}

// ---------- panel-write helpers (M5 first slice) ----------

/**
 * The workspace panel writes target: prefer one with existing eteams state.
 * 全局单库（stateDir 绝对路径）下各工作区的状态根都归一到同一处，这里照常
 * 返回注册表首个工作区即可——rootForWrites 再经 stateRootFor 归一。
 */
function writeWorkspacePath(ctx: Context, config: ETeamsResolvedConfig): string {
  const registry = workspaceRegistryOf(ctx);
  const list = registry?.list() ?? [];
  if (list.length === 0) throw new Error('没有可用工作区（workspaceRegistry 未就绪）');
  for (const workspace of list) {
    if (existsSync(stateRootFor(config, workspace.path))) return workspace.path;
  }
  return list[0]!.path;
}

/** State root for roster reads/writes (same resolution as writeWorkspacePath). */
export function rootForWrites(ctx: Context, config: ETeamsResolvedConfig): string {
  return stateRootFor(config, writeWorkspacePath(ctx, config));
}

/** Runtime env for a panel-driven mutation in one workspace. */
function envFor(ctx: Context, config: ETeamsResolvedConfig, workspace: string): RuntimeEnv {
  return { ctx: ctx as unknown as RuntimeContext, config, workspace };
}

/** Synthesize the captain Agent identity from a session id (staged ops only need id). */
function agentFor(sessionId: string): Agent {
  return { id: sessionId } as unknown as Agent;
}

/** 领队身份锚点（v6 派生）：面板写操作以任务行主会话快照充当队长代理；无快照（无任务/未盖章）合成空 id，requireTeamById 按 '' 放行。 */
function captainAgentOf(team: TeamState): Agent {
  return agentFor(teamMainSessionOf(team));
}

/**
 * Tighten a client-supplied chain (成员槽) param into station pairs — panel
 * payloads are untrusted, so every entry is coerced field-by-field (same
 * treatment as the tool layer's chain mapping). Non-array = undefined
 * (caller omits the field); a present-but-empty array clears the chain.
 */
function readChainParam(value: unknown): { member: string; stageBrief: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => {
    const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    return { member: str(record.member, ''), stageBrief: str(record.stageBrief, '') };
  });
}

/**
 * Coerce a client-supplied task id (主任务挂靠 parentTaskId 等) into a finite
 * number — JSON 发 number、字符串数字都收，其余（空串/缺省/非数）一律 undefined。
 * 七轮修复：此前走 str() 只收字符串，客户端发的 JSON number 被静默丢弃，
 * 小任务全部落到顶层（挂靠失败）。
 */
function readTaskIdParam(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Coerce a client-supplied dependencies array (小任务执行顺序 = 兄弟依赖链,
 * 七轮 DA20) into number[] — 元素收 number 或数字串，非数组 = undefined
 * （调用方省略该字段）；含任何非法元素整包拒绝（undefined），避免半改写。
 */
function readDependenciesParam(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: number[] = [];
  for (const entry of value) {
    const id = readTaskIdParam(entry);
    if (id === undefined) return undefined;
    ids.push(id);
  }
  return ids;
}

/** Parse a JSON object body; throws on non-object payloads. */
/** Type-guard for a client-supplied avatar pair (docs/14). */
function isAvatarPair(value: unknown): value is { seed: number; salt: number } {
  if (typeof value !== 'object' || value === null) return false;
  const pair = value as Record<string, unknown>;
  return (
    typeof pair.seed === 'number' &&
    Number.isFinite(pair.seed) &&
    typeof pair.salt === 'number' &&
    Number.isFinite(pair.salt)
  );
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

/** Coerce one JSON value to a trimmed string with a fallback. */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

/**
 * 用户迭代 2026-09-03「随机头像」：校验请求体里的 avatar 对（seed/salt 必须都是
 * 有限数）。非法/缺失一律 undefined——upsert 落库时自然回落到旧头像，畸形
 * 请求不产生半写。
 */
function readAvatarPair(value: unknown): { seed: number; salt: number } | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const seed = (value as { seed?: unknown }).seed;
  const salt = (value as { salt?: unknown }).salt;
  if (typeof seed !== 'number' || !Number.isFinite(seed)) return undefined;
  if (typeof salt !== 'number' || !Number.isFinite(salt)) return undefined;
  return { seed, salt };
}

/** Member dialog timeline (D15 read-only): mailbox rows + member events merged.
 * v7：邮箱按工号分箱（box_key = String(工号)，同名成员各收各箱）；进度按
 * 该成员副本行的 attempt 归属（attempt.task_member_id，旧行退按名）。 */
function memberDialog(
  root: string,
  team: TeamState,
  member: MemberRecord,
  after: number,
): Record<string, unknown> {
  // 分箱键与写端 memberBoxKey 同口径：无号（异常/旧数据）退名字箱。
  const box = member.employeeId !== undefined ? memberBoxKey(member.employeeId) : member.name;
  const rowIds = new Set(
    team.taskMembers
      .filter((r) => member.employeeId !== undefined && r.employeeId === member.employeeId)
      .map((r) => r.id),
  );
  type Item = { at: number; kind: string; text: string; taskId?: number; from?: string };
  const items: Item[] = [];
  for (const m of readMailboxSync(root, team.id, box)) {
    if (m.seq <= after) continue;
    items.push({
      at: m.at,
      kind: m.kind,
      text: m.content,
      taskId: m.taskId,
      from: m.from.name ?? m.from.kind,
    });
  }
  for (const task of team.tasks) {
    for (const attempt of task.attempts) {
      const mine =
        attempt.taskMemberId !== undefined
          ? rowIds.has(attempt.taskMemberId)
          : attempt.member === member.name;
      if (!mine) continue;
      for (const note of attempt.progress) {
        if (note.at <= after) continue;
        items.push({
          at: note.at,
          kind: 'progress',
          text: note.text,
          taskId: task.id,
          from: member.name,
        });
      }
    }
  }
  items.sort((a, b) => a.at - b.at);
  const currentTask = team.tasks.find((t) => {
    if (!ACTIVE_STATUSES.includes(t.status)) return false;
    const last = t.attempts.at(-1);
    if (last === undefined) return t.assignee === member.name;
    return last.taskMemberId !== undefined
      ? rowIds.has(last.taskMemberId)
      : last.member === member.name;
  });
  return {
    currentTaskId: currentTask?.id ?? null,
    items,
    serverTime: Date.now(),
  };
}
