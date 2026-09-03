/**
 * Task lifecycle operations (docs/06, 07.3, D11): assignment with chain
 * discipline, claim/token handshake, progress, completion with 完成即续派
 * notifications, failure with immediate same-member retry (M1; backoff and
 * decision resolution arrive in M2), and captain interventions.
 *
 * @module dsh-eteams/runtime/assignment
 */
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Actor,
  AttemptRecord,
  DecisionRecord,
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
import { recordEvent } from '../state/events.js';
import { writeTeam } from '../state/store.js';
import { ETeamsError, generateToken, memberActor, type RuntimeEnv } from './base.js';
import { notifyCaptain, queueNotice, readBox, wakeMember } from './notifier.js';
import { renderTeamDocs, taskDirAbs } from './docs.js';
import { sendAssignment } from './members.js';
import { declineMail, reportCompletedMail, reportFailedMail } from '../prompts/handoff.js';
import { requireMember } from './notifier.js';
import { ensureWorkDir, rmTree, withTeam } from './teamOps.js';

/** Active member statuses that block a new assignment. */
const MEMBER_BUSY = new Set(['working']);

/**
 * Create a task with contract + optional execution chain (docs/07.3.1).
 * docs/26：`kind:'group'` 即对话提交的主任务容器（不经执行链、无依赖）；小
 * 任务声明 `parentTaskId` 挂到组下——chain 站点即成员槽（可多成员接力），
 * 文件夹嵌套在组文件夹 `sub/` 下。staged 团队首次建任务即分配 workDir 并
 * 物化文档树（不等批准）。
 */
export async function createTask(
  env: RuntimeEnv,
  who: OpActor,
  params: {
    subject: string;
    /** docs/26：主任务容器（eteams_submit_task / 面板新建任务单）。 */
    kind?: 'group' | 'task';
    /** docs/26：拆解小任务、挂到对应组任务下（成员槽 = chain 站点）。 */
    parentTaskId?: string;
    description?: string;
    acceptance?: string[];
    inScope?: string[];
    outOfScope?: string[];
    deliverables?: string[];
    idempotencyNote?: string;
    dependencies?: string[];
    chain?: { member: string; stageBrief: string }[];
  },
): Promise<TaskRecord> {
  const { subject } = params;
  if (!subject || subject.trim() === '') throw new ETeamsError('任务主题不能为空');
  return withTeam(env, who.teamId, async (team, root) => {
    const deps = params.dependencies ?? [];
    for (const dep of deps) {
      if (dep === subject) throw new ETeamsError('任务不能依赖自身');
    }
    const ids = new Set(team.tasks.map((t) => t.id));
    for (const dep of deps) {
      if (!ids.has(dep))
        throw new ETeamsError(`依赖任务 ${dep} 不存在`, '先创建被依赖任务，或检查任务 id');
    }
    const id = `t${team.taskSeq + 1}`;
    if (
      wouldCycle(
        team.tasks.map((t) => ({ ...t, id })),
        id,
        deps,
      )
    ) {
      throw new ETeamsError('依赖构成循环', '重新规划任务顺序');
    }
    const chain = params.chain ?? [];
    for (const station of chain) {
      const member = team.members.find((m) => m.name === station.member && m.status !== 'removed');
      if (!member)
        throw new ETeamsError(
          `执行链成员「${station.member}」不在团队中`,
          '先 eteams_add_member，或修正成员名',
        );
      if (station.stageBrief.trim() === '')
        throw new ETeamsError(`站点「${station.member}」的 stageBrief 不能为空`);
    }
    // docs/26 validation: groups are containers (no chain/deps/parent); a
    // subtask's parent must be a live group task.
    const kind = params.kind ?? 'task';
    if (kind === 'group' && (chain.length > 0 || deps.length > 0 || params.parentTaskId)) {
      throw new ETeamsError(
        '主任务（任务单）是容器：不接受执行链、依赖或父任务',
        '拆解小任务时用 parentTaskId 挂到主任务下',
      );
    }
    let parent: TaskRecord | undefined;
    if (params.parentTaskId) {
      parent = team.tasks.find((t) => t.id === params.parentTaskId);
      if (!parent || parent.kind !== 'group')
        throw new ETeamsError(`父任务 ${params.parentTaskId} 不存在或不是主任务（任务单）`);
      if (!['draft', 'ready'].includes(parent.status))
        throw new ETeamsError(`主任务 ${parent.id} 处于 ${parent.status}，不能再挂小任务`);
    }
    const now = Date.now();
    const task: TaskRecord = {
      id,
      ...(kind === 'group' ? { kind } : {}),
      ...(parent ? { parentId: parent.id } : {}),
      subject: subject.trim(),
      description: params.description,
      acceptance: params.acceptance,
      inScope: params.inScope,
      outOfScope: params.outOfScope,
      deliverables: params.deliverables,
      idempotencyNote: params.idempotencyNote,
      dependencies: deps,
      chain,
      chainCursor: -1,
      status: team.phase === 'staged' ? 'draft' : 'ready',
      attempts: [],
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    team.taskSeq += 1;
    team.tasks.push(task);
    await recordEvent(root, team.id, who.actor, 'task.created', {
      taskId: id,
      payload: {
        subject: task.subject,
        deps,
        chain: chain.map((s) => s.member),
        status: task.status,
      },
    });
    // docs/26：staged 团队首次建任务即分配 workDir 并物化文档树（D12 前置）。
    if (!team.workDir) team.workDir = await ensureWorkDir(env, team);
    await writeTeam(root, team);
    renderTeamDocs(env.workspace, team, (msg) => env.ctx.logger.warn(msg));
    return task;
  });
}

/** Update an unclaimed task（draft/ready 可改，合同冻结后只读 — docs/06.4）。 */
export async function updateTask(
  env: RuntimeEnv,
  who: OpActor,
  params: {
    taskId: string;
    subject?: string;
    description?: string;
    acceptance?: string[];
    inScope?: string[];
    outOfScope?: string[];
    deliverables?: string[];
    idempotencyNote?: string;
    dependencies?: string[];
    chain?: { member: string; stageBrief: string }[];
  },
): Promise<TaskRecord> {
  return withTeam(env, who.teamId, async (team, root) => {
    const task = requireTask(team, params.taskId);
    if (!['draft', 'ready'].includes(task.status)) {
      throw new ETeamsError(
        `任务 ${task.id} 处于 ${task.status}，合同已冻结`,
        '未领取（draft/ready）的任务才可修改；执行期变更先取消后重建',
      );
    }
    // 改主题会改文件夹名（taskSlug）：记住旧目录名，落盘后重命名。
    const oldSlug = taskSlug(task);
    if (params.dependencies) {
      for (const dep of params.dependencies) {
        if (dep === task.id) throw new ETeamsError('任务不能依赖自身');
        if (!team.tasks.some((t) => t.id === dep && t.id !== task.id))
          throw new ETeamsError(`依赖任务 ${dep} 不存在`);
      }
      if (wouldCycle(team.tasks, task.id, params.dependencies))
        throw new ETeamsError('依赖构成循环');
      task.dependencies = params.dependencies;
    }
    if (params.chain) {
      for (const station of params.chain) {
        if (!team.members.some((m) => m.name === station.member && m.status !== 'removed')) {
          throw new ETeamsError(`执行链成员「${station.member}」不在团队中`);
        }
      }
      task.chain = params.chain;
    }
    if (params.subject !== undefined && params.subject.trim() !== '')
      task.subject = params.subject.trim();
    if (params.description !== undefined) task.description = params.description;
    if (params.acceptance !== undefined) task.acceptance = params.acceptance;
    if (params.inScope !== undefined) task.inScope = params.inScope;
    if (params.outOfScope !== undefined) task.outOfScope = params.outOfScope;
    if (params.deliverables !== undefined) task.deliverables = params.deliverables;
    if (params.idempotencyNote !== undefined) task.idempotencyNote = params.idempotencyNote;
    task.updatedAt = Date.now();
    await recordEvent(root, team.id, who.actor, 'task.updated', {
      taskId: task.id,
      payload: { fields: Object.keys(params).filter((k) => k !== 'taskId') },
    });
    await writeTeam(root, team);
    renameTaskFolder(env.workspace, team, oldSlug, task);
    renderTeamDocs(env.workspace, team, (msg) => env.ctx.logger.warn(msg));
    return task;
  });
}

/**
 * 改主题后的任务文件夹改名（docs/26）：旧目录存在且与新目录不同即
 * renameSync（中文路径安全）。组任务改名时 sub/ 下的全部小任务目录随父
 * 目录整体移动；目录缺失（staged 未物化）静默跳过，renderTeamDocs 会在
 * 新路径补齐。渲染视图不阻塞状态（docs/07.2）——失败只留旧目录孤儿。
 */
function renameTaskFolder(
  workspace: string,
  team: TeamState,
  oldSlug: string,
  task: TaskRecord,
): void {
  const target = taskDirAbs(workspace, team, task);
  const parts = target.split(/[\\/]/);
  parts.pop();
  const oldDir = join(...parts, oldSlug);
  if (!existsSync(oldDir) || oldDir === target) return;
  try {
    renameSync(oldDir, target);
  } catch (error) {
    console.warn(`eteams: 任务文件夹重命名失败（不阻塞状态）：${String(error)}`);
  }
}

/**
 * Delete an unclaimed task（draft/ready 未领取可删，docs/06.4）：组任务级联
 * 删除全部小任务（要求全部未领取）；任务文件夹一并移除（rmTree 手动递归，
 * 规避本机 rmSync 对中文路径的静默失效）。
 */
export async function deleteTask(env: RuntimeEnv, who: OpActor, taskId: string): Promise<void> {
  return withTeam(env, who.teamId, async (team, root) => {
    const task = requireTask(team, taskId);
    if (!['draft', 'ready'].includes(task.status))
      throw new ETeamsError(
        `任务 ${task.id} 处于 ${task.status}，只能删除未领取（draft/ready）任务`,
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
    const dir = taskDirAbs(env.workspace, team, task);
    team.tasks = team.tasks.filter((t) => !doomedIds.has(t.id));
    if (existsSync(dir)) {
      try {
        rmTree(dir);
      } catch (error) {
        env.ctx.logger.warn(`eteams: 任务文件夹删除失败（不阻塞状态）：${String(error)}`);
      }
    }
    await recordEvent(root, team.id, who.actor, 'task.deleted', {
      taskId: task.id,
      payload: {
        subject: task.subject,
        ...(doomed.length > 1 ? { cascade: doomed.map((t) => t.id) } : {}),
      },
    });
    await writeTeam(root, team);
    renderTeamDocs(env.workspace, team, (msg) => env.ctx.logger.warn(msg));
  });
}

/** Actor wrapper passed by the tool layer. */
export interface OpActor {
  teamId: string;
  actor: Actor;
}

/** Assign a ready task to one member (chain deviation enforced, D11). */
export async function assignTask(
  env: RuntimeEnv,
  who: OpActor,
  params: { taskId: string; member: string; deviationNote?: string; handoff?: string },
): Promise<{ team: TeamState; task: TaskRecord; attempt: AttemptRecord }> {
  return withTeam(env, who.teamId, async (team, root) => {
    const result = await assignUnlocked(env, team, root, who.actor, params);
    await writeTeam(root, team);
    renderTeamDocs(env.workspace, team, (msg) => env.ctx.logger.warn(msg));
    return { team, ...result };
  });
}

/** Unlocked assignment core (also used by advance/retry/resume). */
async function assignUnlocked(
  env: RuntimeEnv,
  team: TeamState,
  root: string,
  actor: Actor,
  params: {
    taskId: string;
    member: string;
    deviationNote?: string;
    handoff?: string;
    kind?: AttemptRecord['kind'];
  },
): Promise<{ task: TaskRecord; attempt: AttemptRecord }> {
  const task = requireTask(team, params.taskId);
  if (task.status !== 'ready') {
    throw new ETeamsError(
      `任务 ${task.id} 处于 ${task.status}，只能指派 ready 任务`,
      task.status === 'draft'
        ? '团队仍处计划期，先批准计划'
        : '检查任务状态或用 eteams_reassign_task',
    );
  }
  const unsat = unsatisfiedDependencies(team.tasks, task);
  if (unsat.length > 0) {
    throw new ETeamsError(`任务 ${task.id} 的依赖未完成：${unsat.join('、')}`, '先推进依赖任务');
  }
  const member = requireMember(team, params.member);
  if (MEMBER_BUSY.has(member.status) || member.currentAttemptId) {
    const busy = team.tasks.find(
      (t) => t.currentAttemptId && t.assignee === member.name && t.status !== 'completed',
    );
    throw new ETeamsError(
      `成员「${member.name}」正在执行 ${busy?.id ?? '其他任务'}`,
      '完成即续派：同一成员同一时刻只持有一个活动任务',
    );
  }
  const planned = nextChainStation(task);
  const isStation = task.chain.length > 0;
  if (isStation && planned && params.member !== planned.member) {
    if (!params.deviationNote || params.deviationNote.trim() === '') {
      throw new ETeamsError(
        `任务 ${task.id} 执行链下一站是「${planned.member}」，指派给「${params.member}」需要 deviation_note`,
        '偏离执行链必须留痕（D11）：说明改派原因，或改派链上成员',
      );
    }
    await recordEvent(root, team.id, actor, 'chain.deviated', {
      taskId: task.id,
      payload: {
        planned: planned.member,
        actual: params.member,
        note: params.deviationNote.trim(),
        station: task.chainCursor + 1,
      },
    });
  }
  const attempt = makeAttempt(team, task, {
    kind: params.kind ?? (isStation ? 'stage' : 'initial'),
    member: member.name,
    stationIndex: isStation ? task.chainCursor + 1 : 0,
  });
  applyTransition(task, 'assigned', Date.now());
  task.assignee = member.name;
  task.currentAttemptId = attempt.id;
  member.status = 'working';
  member.currentAttemptId = attempt.id;
  await recordEvent(root, team.id, actor, 'task.assigned', {
    taskId: task.id,
    attemptId: attempt.id,
    payload: {
      member: member.name,
      kind: attempt.kind,
      station: attempt.stationIndex,
      deviation:
        isStation && planned && params.member !== planned.member
          ? params.deviationNote?.trim()
          : undefined,
    },
  });
  await sendAssignment(env, team, member, task, attempt.id, {
    stageBrief: isStation ? planned?.stageBrief : undefined,
    handoff: params.handoff,
  });
  return { task, attempt };
}

/** Advance a chain task to its next station (docs/06.7, FR-36). */
export async function advanceTask(
  env: RuntimeEnv,
  who: OpActor,
  taskId: string,
  handoff?: string,
): Promise<{ team: TeamState; task: TaskRecord; attempt: AttemptRecord }> {
  return withTeam(env, who.teamId, async (team, root) => {
    const task = requireTask(team, taskId);
    if (task.chain.length === 0) {
      throw new ETeamsError(`任务 ${task.id} 没有执行链`, '单站点任务直接 eteams_assign_task 指派');
    }
    if (!hasUpcomingStation(task)) {
      throw new ETeamsError(
        `任务 ${task.id} 已无后续站点`,
        '检查 chainCursor：链已走完或尚未完成首站',
      );
    }
    if (task.status !== 'ready') {
      throw new ETeamsError(
        `任务 ${task.id} 处于 ${task.status}，站点完成后才能推进`,
        '等当前站点 complete_task 后再 advance',
      );
    }
    const planned = nextChainStation(task)!;
    const result = await assignUnlocked(env, team, root, who.actor, {
      taskId,
      member: planned.member,
      handoff,
      kind: 'stage',
    });
    await writeTeam(root, team);
    renderTeamDocs(env.workspace, team, (msg) => env.ctx.logger.warn(msg));
    return { team, ...result };
  });
}

/** Reassign an in-flight/awaiting task (revokes the live token). */
export async function reassignTask(
  env: RuntimeEnv,
  who: OpActor,
  params: { taskId: string; member?: string; deviationNote?: string },
): Promise<{ team: TeamState; task: TaskRecord; attempt: AttemptRecord }> {
  return withTeam(env, who.teamId, async (team, root) => {
    const task = requireTask(team, params.taskId);
    const current = task.attempts.find((a) => a.id === task.currentAttemptId);
    const revocable =
      current !== undefined && ['pending_accept', 'running', 'paused'].includes(current.status);
    if (
      !revocable &&
      ![
        'ready',
        'assigned',
        'in_progress',
        'awaiting_decision',
        'needs_user',
        'paused',
        'retrying',
      ].includes(task.status)
    ) {
      throw new ETeamsError(`任务 ${task.id} 处于 ${task.status}，无法改派`);
    }
    const oldMemberName = task.assignee;
    const now = Date.now();
    if (current && revocable) {
      current.status = 'revoked';
      current.endedAt = now;
      await recordEvent(root, team.id, who.actor, 'attempt.revoked', {
        taskId: task.id,
        attemptId: current.id,
        payload: { reason: 'reassign' },
      });
    }
    if (oldMemberName) {
      const oldMember = team.members.find((m) => m.name === oldMemberName);
      if (oldMember && oldMember.currentAttemptId === task.currentAttemptId) {
        oldMember.status = 'ready';
        oldMember.currentAttemptId = undefined;
      }
    }
    task.currentAttemptId = undefined;
    task.assignee = undefined;
    if (task.status !== 'ready' && task.status !== 'assigned') {
      applyTransition(task, 'assigned', now);
    }
    const target = params.member ?? oldMemberName;
    if (!target) throw new ETeamsError('未指定改派目标成员');
    const result = await assignUnlocked(env, team, root, who.actor, {
      taskId: params.taskId,
      member: target,
      deviationNote: params.deviationNote,
      kind: 'reassign',
      handoff: current?.result?.output,
    });
    const decision = team.pendingDecisions.find((d) => d.status === 'open' && d.taskId === task.id);
    if (decision) {
      decision.status = 'resolved';
      decision.resolvedAt = now;
      decision.choice = 'reassign';
      await recordEvent(root, team.id, who.actor, 'decision.resolved', {
        taskId: task.id,
        payload: { decisionId: decision.id, choice: 'reassign' },
      });
    }
    await writeTeam(root, team);
    renderTeamDocs(env.workspace, team, (msg) => env.ctx.logger.warn(msg));
    return { team, ...result };
  });
}

/** Suspend a task (captain decision; docs/06.4). */
export async function suspendTask(
  env: RuntimeEnv,
  who: OpActor,
  taskId: string,
  note?: string,
): Promise<TaskRecord> {
  return withTeam(env, who.teamId, async (team, root) => {
    const task = requireTask(team, taskId);
    if (!['assigned', 'in_progress', 'retrying', 'ready'].includes(task.status)) {
      throw new ETeamsError(`任务 ${task.id} 处于 ${task.status}，无法挂起`);
    }
    const now = Date.now();
    if (task.status === 'ready') {
      applyTransition(task, 'blocked', now); // captain-suspended ready tasks ride blocked
      task.suspendNote = note;
    } else {
      revokeCurrentAttempt(team, root, who.actor, task, 'suspend', now);
      applyTransition(task, 'paused', now);
      task.suspendNote = note;
      freeMember(team, task);
      await notifyMemberSuspended(env, team, task, note);
    }
    await recordEvent(root, team.id, who.actor, 'task.suspended', {
      taskId: task.id,
      payload: { note },
    });
    refreshDependents(team, root, who.actor, task.id, now);
    await writeTeam(root, team);
    renderTeamDocs(env.workspace, team, (msg) => env.ctx.logger.warn(msg));
    return task;
  });
}

/** Resume a suspended task: fresh attempt for the same member. */
export async function resumeTask(
  env: RuntimeEnv,
  who: OpActor,
  taskId: string,
): Promise<{ team: TeamState; task: TaskRecord; attempt?: AttemptRecord }> {
  return withTeam(env, who.teamId, async (team, root) => {
    const task = requireTask(team, taskId);
    const memberName = task.assignee;
    if (task.status === 'blocked' && task.suspendNote) {
      // captain-suspended ready task: restore to ready (no attempt involved)
      applyTransition(task, 'ready', Date.now());
      task.suspendNote = undefined;
      await recordEvent(root, team.id, who.actor, 'task.resumed', { taskId: task.id });
      await writeTeam(root, team);
      return { team, task, attempt: task.attempts[task.attempts.length - 1] };
    }
    if (task.status !== 'paused')
      throw new ETeamsError(`任务 ${task.id} 处于 ${task.status}，无法恢复`);
    const now = Date.now();
    const target = memberName ?? thrower('挂起任务缺少执行成员记录');
    applyTransition(task, 'assigned', now);
    const member = requireMember(team, target);
    const attempt = makeAttempt(team, task, {
      kind: 'reassign',
      member: member.name,
      stationIndex: task.chain.length > 0 ? task.chainCursor + 1 : 0,
    });
    task.currentAttemptId = attempt.id;
    member.status = 'working';
    member.currentAttemptId = attempt.id;
    await recordEvent(root, team.id, who.actor, 'task.resumed', {
      taskId: task.id,
      attemptId: attempt.id,
      payload: { member: member.name },
    });
    await sendAssignment(env, team, member, task, attempt.id, {
      stageBrief: nextChainStation(task)?.stageBrief,
    });
    await writeTeam(root, team);
    renderTeamDocs(env.workspace, team, (msg) => env.ctx.logger.warn(msg));
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
  taskId: string,
  reason?: string,
): Promise<TaskRecord> {
  return withTeam(env, who.teamId, async (team, root) => {
    const task = requireTask(team, taskId);
    const now = Date.now();
    if (['assigned', 'in_progress', 'retrying', 'paused'].includes(task.status)) {
      revokeCurrentAttempt(team, root, who.actor, task, 'cancel', now);
      freeMember(team, task);
      await notifyMemberCancelled(env, team, task, reason);
    }
    applyTransition(task, 'cancelled', now);
    task.updatedAt = now;
    const decision = team.pendingDecisions.find((d) => d.status === 'open' && d.taskId === task.id);
    if (decision) {
      decision.status = 'resolved';
      decision.resolvedAt = now;
      decision.choice = 'suspend';
      decision.note = 'task cancelled';
    }
    await recordEvent(root, team.id, who.actor, 'task.cancelled', {
      taskId: task.id,
      payload: { reason },
    });
    refreshDependents(team, root, who.actor, task.id, now);
    await writeTeam(root, team);
    renderTeamDocs(env.workspace, team, (msg) => env.ctx.logger.warn(msg));
    return task;
  });
}

/** Member claims the assigned attempt → token handshake (docs/06.3). */
export async function claimTask(
  env: RuntimeEnv,
  team: TeamState,
  member: { name: string },
  taskId: string,
): Promise<{ attempt: AttemptRecord; token: string; task: TaskRecord; inboxPreview: string[] }> {
  return withTeam(env, team.id, async (fresh, root) => {
    const task = requireTask(fresh, taskId);
    if (task.assignee !== member.name) {
      throw new ETeamsError(
        `任务 ${task.id} 未指派给你（当前：${task.assignee ?? '无'}）`,
        '用 eteams_task_board 查看你的任务',
      );
    }
    const attempt = task.attempts.find((a) => a.id === task.currentAttemptId);
    if (!attempt || attempt.status !== 'pending_accept') {
      throw new ETeamsError(
        `任务 ${task.id} 没有待接取的指派`,
        'attempt 可能已被吊销；等待领队重新指派',
      );
    }
    const memberRec = requireMember(fresh, member.name);
    const token = generateToken();
    attempt.status = 'running';
    attempt.token = token;
    attempt.claimedAt = Date.now();
    applyTransition(task, 'in_progress', Date.now());
    memberRec.status = 'working';
    await recordEvent(root, fresh.id, memberActor(memberRec), 'attempt.claimed', {
      taskId: task.id,
      attemptId: attempt.id,
    });
    const box = readBoxQuiet(env, fresh.id, member.name);
    const inboxPreview = box.slice(-5).map((m) => `[${m.kind}] ${m.content.slice(0, 160)}`);
    await writeTeam(root, fresh);
    renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
    return { attempt, token, task, inboxPreview };
  });
}

/** Member declines: attempt revoked, task back to ready, captain notified. */
export async function declineTask(
  env: RuntimeEnv,
  team: TeamState,
  member: { name: string },
  taskId: string,
  reason: string,
): Promise<TaskRecord> {
  return withTeam(env, team.id, async (fresh, root) => {
    const task = requireTask(fresh, taskId);
    if (task.assignee !== member.name) throw new ETeamsError(`任务 ${task.id} 未指派给你`);
    const attempt = task.attempts.find((a) => a.id === task.currentAttemptId);
    if (!attempt || attempt.status !== 'pending_accept') {
      throw new ETeamsError(
        `任务 ${task.id} 没有可婉拒的指派`,
        '已接取的任务用 fail_task 上报失败',
      );
    }
    const now = Date.now();
    attempt.status = 'revoked';
    attempt.endedAt = now;
    applyTransition(task, 'ready', now);
    task.assignee = undefined;
    task.currentAttemptId = undefined;
    const memberRec = requireMember(fresh, member.name);
    memberRec.status = 'ready';
    memberRec.currentAttemptId = undefined;
    await recordEvent(root, fresh.id, memberActor(memberRec), 'attempt.declined', {
      taskId: task.id,
      attemptId: attempt.id,
      payload: { reason },
    });
    await notifyCaptain(env, fresh, declineMail(task, member.name, reason), {
      taskId: task.id,
      attemptId: attempt.id,
    });
    await writeTeam(root, fresh);
    renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
    return task;
  });
}

/** Member records progress (≤200 chars, docs/06.3). */
export async function appendProgress(
  env: RuntimeEnv,
  team: TeamState,
  member: { name: string },
  params: { taskId: string; attemptId: string; token: string; text: string },
): Promise<void> {
  return withTeam(env, team.id, async (fresh, root) => {
    const { task, attempt } = requireLiveAttempt(fresh, member.name, params);
    const text = params.text.trim();
    if (text === '') throw new ETeamsError('进度内容不能为空');
    const clipped = text.length > 200 ? `${text.slice(0, 197)}…` : text;
    attempt.progress.push({ at: Date.now(), text: clipped });
    await recordEvent(
      root,
      fresh.id,
      memberActor(requireMember(fresh, member.name)),
      'attempt.progress',
      {
        taskId: task.id,
        attemptId: attempt.id,
        payload: { text: clipped },
      },
    );
    await writeTeam(root, fresh);
  });
}

/** Member completes the current station (D11 chain logic + FR-36 notify). */
export async function completeTask(
  env: RuntimeEnv,
  team: TeamState,
  member: { name: string },
  params: {
    taskId: string;
    attemptId: string;
    token: string;
    output: string;
    changedPaths?: string[];
  },
): Promise<{ task: TaskRecord; done: boolean }> {
  return withTeam(env, team.id, async (fresh, root) => {
    const { task, attempt } = requireLiveAttempt(fresh, member.name, params);
    const output = params.output.trim();
    if (output === '')
      throw new ETeamsError('完成产出说明不能为空', 'output 写清做了什么、改了哪些文件、如何验证');
    const now = Date.now();
    attempt.status = 'succeeded';
    attempt.endedAt = now;
    attempt.result = { output, changedPaths: params.changedPaths };
    const memberRec = requireMember(fresh, member.name);
    memberRec.status = 'ready';
    memberRec.currentAttemptId = undefined;
    task.currentAttemptId = undefined;
    const isStation = task.chain.length > 0;
    const final = isStation && !hasUpcomingStation(task);
    // Intermediate station iff the completed station (cursor+1) is not the last.
    if (isStation && task.chainCursor + 2 < task.chain.length) {
      task.chainCursor += 1; // station at old cursor+1 is now complete
      const next = nextChainStation(task)!;
      applyTransition(task, 'ready', now);
      task.assignee = undefined;
      await recordEvent(root, fresh.id, memberActor(memberRec), 'task.stage_completed', {
        taskId: task.id,
        attemptId: attempt.id,
        payload: { station: task.chainCursor, next: next.member },
      });
      await notifyCaptain(
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
      );
      await writeTeam(root, fresh);
      renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
      return { task, done: false };
    }
    // Final station or chainless: task completed.
    applyTransition(task, 'completed', now);
    task.outcome = output;
    await recordEvent(root, fresh.id, memberActor(memberRec), 'task.completed', {
      taskId: task.id,
      attemptId: attempt.id,
      payload: { output, changedPaths: params.changedPaths, isStation, final: final || !isStation },
    });
    refreshDependents(fresh, root, memberActor(memberRec), task.id, now);
    // docs/26：组任务收口——末个小任务完成且全组 completed 时自动落组状态。
    await completeGroupIfDone(fresh, root, memberActor(memberRec), task, now);
    await notifyCaptain(
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
    );
    await writeTeam(root, fresh);
    renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
    return { task, done: true };
  });
}

/** Member reports failure: same-member immediate retry, else escalation. */
export async function failTask(
  env: RuntimeEnv,
  team: TeamState,
  member: { name: string },
  params: { taskId: string; attemptId: string; token: string; error: string },
): Promise<{ task: TaskRecord; retried: boolean; retryCount: number; maxRetries: number }> {
  return withTeam(env, team.id, async (fresh, root) => {
    const { task, attempt } = requireLiveAttempt(fresh, member.name, params);
    const now = Date.now();
    attempt.status = 'failed';
    attempt.endedAt = now;
    attempt.error = params.error.trim();
    const memberRec = requireMember(fresh, member.name);
    memberRec.status = 'ready';
    memberRec.currentAttemptId = undefined;
    task.currentAttemptId = undefined;
    task.retryCount += 1;
    const willRetry = task.retryCount <= fresh.maxRetries;
    if (willRetry) {
      // M1: immediate same-member retry (backoff timers arrive with M2).
      applyTransition(task, 'retrying', now);
      await recordEvent(root, fresh.id, memberActor(memberRec), 'task.retrying', {
        taskId: task.id,
        attemptId: attempt.id,
        payload: { retryCount: task.retryCount, maxRetries: fresh.maxRetries },
      });
      applyTransition(task, 'assigned', now);
      const retry = makeAttempt(fresh, task, {
        kind: 'retry',
        member: memberRec.name,
        stationIndex: task.chain.length > 0 ? task.chainCursor + 1 : 0,
      });
      task.currentAttemptId = retry.id;
      memberRec.status = 'working';
      memberRec.currentAttemptId = retry.id;
      await sendAssignment(env, fresh, memberRec, task, retry.id, {
        stageBrief: nextChainStation(task)?.stageBrief,
        handoff: `重试 ${task.retryCount}/${fresh.maxRetries}。上次失败：${attempt.error}`,
      });
      await writeTeam(root, fresh);
      renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
      return { task, retried: true, retryCount: task.retryCount, maxRetries: fresh.maxRetries };
    }
    // Retries exhausted → awaiting_decision + DecisionRecord (docs/08).
    applyTransition(task, 'awaiting_decision', now);
    const decision: DecisionRecord = {
      id: `d${fresh.pendingDecisions.length + 1}`,
      taskId: task.id,
      attemptId: attempt.id,
      error: attempt.error,
      retryCount: task.retryCount,
      status: 'open',
      createdAt: now,
    };
    fresh.pendingDecisions.push(decision);
    task.decisionId = decision.id;
    await recordEvent(root, fresh.id, memberActor(memberRec), 'task.awaiting_decision', {
      taskId: task.id,
      attemptId: attempt.id,
      payload: { decisionId: decision.id, retryCount: task.retryCount },
    });
    await recordEvent(root, fresh.id, memberActor(memberRec), 'decision.requested', {
      taskId: task.id,
      attemptId: attempt.id,
      payload: { decisionId: decision.id },
    });
    refreshDependents(fresh, root, memberActor(memberRec), task.id, now);
    await notifyCaptain(
      env,
      fresh,
      reportFailedMail(task, {
        member: member.name,
        attemptId: attempt.id,
        error: attempt.error,
        willRetry: false,
        retryCount: task.retryCount,
        maxRetries: fresh.maxRetries,
      }),
      { taskId: task.id, attemptId: attempt.id },
    );
    await writeTeam(root, fresh);
    renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
    return { task, retried: false, retryCount: task.retryCount, maxRetries: fresh.maxRetries };
  });
}

// ---------- internal helpers ----------

function requireTask(team: TeamState, taskId: string): TaskRecord {
  const task = team.tasks.find((t) => t.id === taskId);
  if (!task) throw new ETeamsError(`任务 ${taskId} 不存在`, '用 eteams_task_board 查看任务列表');
  return task;
}

function makeAttempt(
  team: TeamState,
  task: TaskRecord,
  spec: { kind: AttemptRecord['kind']; member: string; stationIndex: number },
): AttemptRecord {
  team.attemptSeq += 1;
  const attempt: AttemptRecord = {
    id: `a${team.attemptSeq}`,
    taskId: task.id,
    kind: spec.kind,
    member: spec.member,
    status: 'pending_accept',
    token: '',
    stationIndex: spec.stationIndex,
    createdAt: Date.now(),
    progress: [],
  };
  task.attempts.push(attempt);
  return attempt;
}

/** Token-guarded live attempt resolution (docs/06.4 revocation semantics). */
function requireLiveAttempt(
  team: TeamState,
  memberName: string,
  params: { taskId: string; attemptId: string; token: string },
): { task: TaskRecord; attempt: AttemptRecord } {
  const task = requireTask(team, params.taskId);
  if (task.assignee !== memberName) {
    throw new ETeamsError(`任务 ${task.id} 未指派给你`, '只操作自己被指派的任务');
  }
  const attempt = task.attempts.find((a) => a.id === params.attemptId);
  if (!attempt || task.currentAttemptId !== params.attemptId) {
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

function revokeCurrentAttempt(
  team: TeamState,
  root: string,
  actor: Actor,
  task: TaskRecord,
  reason: string,
  now: number,
): void {
  const attempt = task.attempts.find((a) => a.id === task.currentAttemptId);
  if (attempt && ['pending_accept', 'running', 'paused'].includes(attempt.status)) {
    attempt.status = 'revoked';
    attempt.endedAt = now;
    void recordEvent(root, team.id, actor, 'attempt.revoked', {
      taskId: task.id,
      attemptId: attempt.id,
      payload: { reason },
    }).catch(() => undefined);
  }
}

function freeMember(team: TeamState, task: TaskRecord): void {
  if (!task.assignee) return;
  const member = team.members.find((m) => m.name === task.assignee);
  if (member && member.currentAttemptId === task.currentAttemptId) {
    member.status = 'ready';
    member.currentAttemptId = undefined;
  }
  task.assignee = undefined;
  task.currentAttemptId = undefined;
}

/** Materialize/refresh dependency-derived blocked on dependents (docs/05.9). */
async function refreshDependents(
  team: TeamState,
  root: string,
  actor: Actor,
  taskId: string,
  now: number,
): Promise<void> {
  for (const dependent of team.tasks.filter(
    (t) => t.dependencies.includes(taskId) && (t.status === 'ready' || t.status === 'blocked'),
  )) {
    const before = dependent.status;
    if (refreshDependencyStatus(team.tasks, dependent, now) && before !== dependent.status) {
      await recordEvent(
        root,
        team.id,
        actor,
        before === 'blocked' ? 'task.unblocked' : 'task.blocked',
        {
          taskId: dependent.id,
          payload: { by: taskId, status: dependent.status },
        },
      );
    }
  }
}

/**
 * 对话任务组收口（docs/26）：小任务完成时检查父组——组内小任务全部
 * completed 即把组任务 ready→completed（applyTransition 的 group 特例边），
 * outcome 汇总各小任务产出；有子任务取消/失败则组保持现状，交领队处理。
 */
async function completeGroupIfDone(
  team: TeamState,
  root: string,
  actor: Actor,
  subtask: TaskRecord,
  now: number,
): Promise<void> {
  if (!subtask.parentId) return;
  const parent = team.tasks.find((t) => t.id === subtask.parentId);
  if (!parent || parent.kind !== 'group' || parent.status === 'completed') return;
  const subs = team.tasks.filter((t) => t.parentId === parent.id);
  if (subs.length === 0 || !subs.every((t) => t.status === 'completed')) return;
  applyTransition(parent, 'completed', now);
  parent.outcome = subs
    .map((t) => `${t.id} ${t.subject}：${t.outcome ?? '（无产出说明）'}`)
    .join('\n');
  await recordEvent(root, team.id, actor, 'task.completed', {
    taskId: parent.id,
    payload: { via: 'subtasks.completed', children: subs.map((t) => t.id) },
  });
}

async function notifyMemberSuspended(
  env: RuntimeEnv,
  team: TeamState,
  task: TaskRecord,
  note?: string,
): Promise<void> {
  const member = team.members.find((m) => m.name === task.assignee);
  if (!member) return;
  const text = `【挂起】任务 ${task.id} ${task.subject} 已被领队挂起${note ? `：${note}` : ''}。停止工作，等待恢复指派。`;
  await queueNotice(env, team, member.name, text, { taskId: task.id });
  await wakeMember(env, team, member, text);
}

async function notifyMemberCancelled(
  env: RuntimeEnv,
  team: TeamState,
  task: TaskRecord,
  reason?: string,
): Promise<void> {
  const member = team.members.find((m) => m.name === task.assignee);
  if (!member) return;
  const text = `【取消】任务 ${task.id} ${task.subject} 已被取消${reason ? `：${reason}` : ''}。停止相关工作，保持空闲。`;
  await queueNotice(env, team, member.name, text, { taskId: task.id });
  await wakeMember(env, team, member, text);
}

function readBoxQuiet(env: RuntimeEnv, teamId: string, box: string) {
  try {
    return readBox(env, teamId, box);
  } catch {
    return [];
  }
}
