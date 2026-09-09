/**
 * Mailbox delivery + wake (docs/09.1 FR-40 → docs/27 mail_messages 表)：邮件
 * 随团队快照同一同步事务落库（insertMailInTx，seq 由库发号），唤醒是提交后
 * 的最佳努力投递（成员：按实例行 session_id 续投；领队：按任务行快照
 * main_session_id 唤醒，v6 派生，缺时心跳兜底）。收件人不在线时邮件留在库里
 * （持久），下次唤醒随派发消息送达。实例行选行规则见 docs/35 §5#12。
 *
 * @module dsh-eteams/runtime/notifier
 */
import { appendMail, insertMailInTx, memberBoxKey, readMailboxSync } from '../state/events.js';
import type { TeamTx } from '../state/store.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type {
  Actor,
  MailMessage,
  MemberStatus,
  ModelRouteSnapshot,
  TaskMemberRecord,
  TaskRecord,
  TeamState,
} from '../model/types.js';
import { deliverToChild, ETeamsError, PLUGIN_ACTOR, stateRootOf, type RuntimeEnv } from './base.js';
import { registerMemberSession } from './usage.js';
import { readBuildPresence } from './roleBuilder.js';

/** 提交后的最佳努力唤醒动作（事务内登记、COMMIT 后执行）。 */
export type Wake = () => Promise<boolean>;

let mailCounter = 0;

/** Build a mailbox row（seq = 0：由库发号 mail_message_id，docs/27）。 */
export function makeMail(
  from: Actor,
  to: Actor,
  kind: MailMessage['kind'],
  content: string,
  refs: { taskId?: number; attemptId?: number } = {},
): MailMessage {
  return {
    id: `m${Date.now().toString(36)}-${++mailCounter}`,
    seq: 0,
    at: Date.now(),
    from,
    to,
    kind,
    ...(refs.taskId !== undefined ? { taskId: refs.taskId } : {}),
    ...(refs.attemptId !== undefined ? { attemptId: refs.attemptId } : {}),
    content,
  };
}

/** 事务内投递一封邮件（随团队快照同事务落库；返回库发 seq）。 */
export function deliverMailInTx(
  tx: TeamTx,
  teamId: number,
  box: string,
  message: MailMessage,
): number {
  return insertMailInTx(tx, teamId, box, message);
}

// --------------------------------------------------------------------------
// 实例行选行（docs/35 §5#12 + docs/36 建议 4）：领队锚点行 = name=领队名 且
// mainTaskId 为空；任务级操作按任务的大任务锚定；跨任务操作选最近活跃行。
// v7：成员定位一律按工号（同名成员各是一套副本行），名字串退按名（旧链
// 站点/旧数据兼容）。
// --------------------------------------------------------------------------

/** 领队行（领队锚点）：v8 按领队标识定位（is_leader=1 且主持行 mainTaskId
 * 为空），不再按名字匹配。主持行只承担会话锚（session_id）职责。 */
export function leaderRowOf(team: TeamState): TaskMemberRecord | undefined {
  return team.taskMembers.find((r) => r.isLeader === true && r.mainTaskId === null);
}

/**
 * 领队模型路线（v9 统一存储位 = 班底领队行 team_members.is_leader=1 的
 * modelRoute，与成员同表同列——用户手改/查看都在 team_members；此前存
 * task_members 主持行 model 列的 2026-09-04 旧设计废止，旧值经 v9 迁移
 * 一次性搬到班底行）。班底无领队行（领队未就位）返回会话默认（空路线）。
 */
export function leaderRouteOf(team: TeamState): ModelRouteSnapshot {
  const rosterLeader = team.members.find((m) => m.isLeader === true);
  return rosterLeader?.modelRoute ?? { model: '' };
}

/**
 * 领队主持行自愈（用户迭代 2026-09-08「选择模型没保存到表」根因处置）：
 * 实测库中主持行（task_members.is_leader=1 且 main_task_id 为空）可能缺失
 * ——此时 leaderRowOf 为 undefined，领队模型选择/子代理锚落盘等写路径全部
 * 静默 no-op。本助手在写事务内就地补建：从班底领队行（team_members）派生
 * （is_leader=1、mainTaskId=null、sessionId 留空待首派），id=0 走落库发号
 * 回填。班底也没有领队行（领队从未就位）返回 undefined——调用方维持原
 * 静默口径。warn 回调透传宿主日志，自愈发生即留痕。
 */
export function ensureLeaderAnchorRow(
  team: TeamState,
  now: number,
  warn?: (message: string) => void,
): TaskMemberRecord | undefined {
  const existing = leaderRowOf(team);
  if (existing !== undefined) return existing;
  const rosterLeader = team.members.find((m) => m.isLeader === true);
  if (rosterLeader === undefined) return undefined;
  warn?.(
    'eteams: 领队主持行缺失（task_members 无 is_leader=1 且 main_task_id 为空的行）——已从班底领队行自愈补建',
  );
  const row: TaskMemberRecord = {
    id: 0,
    teamId: team.id,
    mainTaskId: null,
    nowTaskId: null,
    name: rosterLeader.name,
    employeeId: rosterLeader.employeeId ?? null,
    sessionId: '',
    status: 'ready',
    isLeader: true,
    createdAt: now,
  };
  team.taskMembers.push(row);
  return row;
}

/**
 * 成员引用 → 定位键（v7）：纯十进制数字串/数字 = 工号；其余 = 成员名
 * （旧链站点名字串兼容，展示原样）。
 */
export function memberRefId(ref: string | number): { employeeId?: number; name?: string } {
  if (typeof ref === 'number') return { employeeId: ref };
  const trimmed = ref.trim();
  const numeric = Number.parseInt(trimmed, 10);
  if (Number.isFinite(numeric) && numeric > 0 && String(numeric) === trimmed) {
    return { employeeId: numeric };
  }
  return { name: trimmed };
}

/** 两行是否同一成员（v7）：工号优先，缺号退按名（legacy 宽容）。 */
export function sameMemberOf(
  a: Pick<TaskMemberRecord, 'employeeId' | 'name'>,
  b: Pick<TaskMemberRecord, 'employeeId' | 'name'>,
): boolean {
  if (a.employeeId !== null && b.employeeId !== null) return a.employeeId === b.employeeId;
  return a.name === b.name;
}

/** 成员引用按定位键过滤出的非 removed 副本行（含领队主持行）。 */
function rowsByRef(team: TeamState, ref: string | number): TaskMemberRecord[] {
  const key = memberRefId(ref);
  return team.taskMembers.filter((r) =>
    key.employeeId !== undefined
      ? r.employeeId === key.employeeId && r.status !== 'removed'
      : r.name === key.name && r.status !== 'removed',
  );
}

/**
 * 任务级实例行定位：先找锚定在本任务大任务上的行；没有锚定行时退回未锚
 * 定的团队级行（legacy staged 行，main_task_id 为空）；两皆无 = 未入职。
 */
export function findInstanceRow(
  team: TeamState,
  ref: string | number,
  mainTaskId: number,
): TaskMemberRecord | undefined {
  const rows = rowsByRef(team, ref);
  return rows.find((r) => r.mainTaskId === mainTaskId) ?? rows.find((r) => r.mainTaskId === null);
}

/**
 * 跨任务选行（§5#12）：非 removed、已起会话（session_id 非空）的最近活跃
 * 行。TaskMemberRecord 内存不带 update_time（docs/27 库列），以 createdAt/id
 * 最大行近似「最近活跃」。
 */
export function latestInstanceRow(
  team: TeamState,
  ref: string | number,
): TaskMemberRecord | undefined {
  const rows = rowsByRef(team, ref)
    .filter((r) => r.sessionId !== '')
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  return rows[0];
}

/** 在册判定：该成员（工号/名）名下存在非 removed 实例行（领队行同样算在册）。 */
export function requireMember(team: TeamState, ref: string | number): TaskMemberRecord {
  const rows = rowsByRef(team, ref);
  if (rows.length === 0) {
    throw new ETeamsError(`成员「${String(ref)}」不存在`, '用 eteams_team_status 查看在册成员');
  }
  return rows[rows.length - 1]!;
}

/**
 * 成员聚合状态（团队视图/看板口径）：任一实例行 working 即 working，其次
 * paused；没有实例行 = staged（只有班底行、未铺任务副本）。
 */
export function memberStatusOf(team: TeamState, ref: string | number): MemberStatus {
  const rows = rowsByRef(team, ref);
  if (rows.length === 0) return 'staged';
  if (rows.some((r) => r.status === 'working')) return 'working';
  if (rows.some((r) => r.status === 'paused')) return 'paused';
  return rows[0]!.status;
}

// --------------------------------------------------------------------------
// 邮箱分箱（v7）：成员箱 = 工号十进制串（(team_id, employee_id) 定箱，同名
// 不串箱）；领队箱 = 'captain'；legacy 无号行退按名分箱（仅显示兜底）。
// --------------------------------------------------------------------------

/** 成员行的收件箱（v7）：工号箱 + 落库 employee_id；无号退按名。 */
export function memberBoxOf(row: TaskMemberRecord): { box: string; employeeId?: number } {
  return row.employeeId !== null
    ? { box: memberBoxKey(row.employeeId), employeeId: row.employeeId }
    : { box: row.name };
}

/**
 * 团队主会话锚点（v6 派生值，不再落列）：按任务行快照取——同队任务由同一
 * 领队会话创建（建队去重约束），按 task_id 升序取首个非空快照。无任务或
 * 未盖章返回空串（调用方再用心跳/在线注册表兜底）。
 */
export function teamMainSessionOf(team: TeamState): string {
  const hit = team.tasks.find((t) => t.mainSessionId !== undefined && t.mainSessionId !== '');
  return hit?.mainSessionId ?? '';
}

/** 任务所属大任务 id（独立无链任务 = 自身 id；§5#12 实例行锚定粒度）。 */
export function rootTaskIdOf(task: Pick<TaskRecord, 'id' | 'parentId'>): number {
  return task.parentId ?? task.id;
}

// --------------------------------------------------------------------------
// 唤醒（提交后调用；不落库、失败只告警）。
// --------------------------------------------------------------------------

/**
 * Wake one member: 按任务行快照/心跳派生的领队代理向该成员实例行的
 * sessionId 续投消息。staged（session_id 为空）不唤醒——邮件留在邮箱，
 * 起会话后随派发消息送达。
 */
export async function wakeMember(
  env: RuntimeEnv,
  team: TeamState,
  row: TaskMemberRecord,
  text: string,
): Promise<boolean> {
  if (row.sessionId === '') return false;
  // 主会话锚点（v6 派生）：任务行快照，缺时用心跳定位用户正在看的对话。
  const anchorId = teamMainSessionOf(team) || readBuildPresence(stateRootOf(env))?.sessionId || '';
  const captain = anchorId !== '' ? env.ctx.agents.get(anchorId) : undefined;
  if (!captain) {
    env.ctx.logger.warn(
      `eteams: 领队会话不在线（${anchorId || '未登记'}），成员 ${row.name} 的邮件留在邮箱`,
    );
    return false;
  }
  try {
    // 归属重登记（harness 0.1.2 起 continuable setup hook 被移除——成员身份
    // 注册表改由 spawn/唤醒两个点维护，冷恢复的会话随唤醒补齐）。
    registerMemberSession(row.sessionId, {
      teamId: String(row.teamId),
      memberName: row.name,
      employeeId: row.employeeId,
      parentSessionId: String(captain.id),
    });
    await deliverToChild(
      env.ctx.subagents,
      captain,
      row.sessionId as unknown as SessionId,
      [{ type: 'text', text }],
      env.signal,
    );
    return true;
  } catch (error) {
    env.ctx.logger.warn(`eteams: wake to member ${row.name} failed: ${String(error)}`);
    return false;
  }
}

/** 领队唤醒（纯会话侧 followup；邮件落库由调用方负责）。 */
function wakeCaptain(env: RuntimeEnv, team: TeamState, content: string): boolean {
  const anchorId = teamMainSessionOf(team) || readBuildPresence(stateRootOf(env))?.sessionId || '';
  const captain = anchorId !== '' ? env.ctx.agents.get(anchorId) : undefined;
  if (!captain) {
    env.ctx.logger.warn('eteams: 领队会话不在线，汇报留在领队邮箱');
    return false;
  }
  try {
    captain.followup(
      createUserMessage({
        content: [{ type: 'text', text: content }],
        source: { kind: 'plugin', plugin: 'dsh-eteams' },
      }),
    );
    return true;
  } catch (error) {
    env.ctx.logger.warn(`eteams: captain wake failed: ${String(error)}`);
    return false;
  }
}

/**
 * Notify the captain（独立事务版，锁外随动用）：durable mail + in-session
 * wake。事务内版本见 {@link notifyCaptainInTx}。
 */
export async function notifyCaptain(
  env: RuntimeEnv,
  team: TeamState,
  content: string,
  refs: { taskId?: number; attemptId?: number } = {},
): Promise<boolean> {
  await appendMail(
    stateRootOf(env),
    team.id,
    'captain',
    makeMail(PLUGIN_ACTOR, { kind: 'captain', name: '领队' }, 'report', content, refs),
  );
  return wakeCaptain(env, team, content);
}

/** 事务内落库给领队的通知邮件；返回提交后的唤醒动作。 */
export function notifyCaptainInTx(
  tx: TeamTx,
  env: RuntimeEnv,
  team: TeamState,
  content: string,
  refs: { taskId?: number; attemptId?: number } = {},
): Wake {
  insertMailInTx(
    tx,
    team.id,
    'captain',
    makeMail(PLUGIN_ACTOR, { kind: 'captain', name: '领队' }, 'report', content, refs),
  );
  return () => Promise.resolve(wakeCaptain(env, team, content));
}

/** 事务内入队一封通知邮件（无唤醒；提交后由派发/唤醒路径补投）。displayName
 * 是收件展示名（v7 箱键是工号串，展示仍用成员名）。 */
export function queueNoticeInTx(
  tx: TeamTx,
  teamId: number,
  box: string,
  content: string,
  refs: { taskId?: number } = {},
  displayName?: string,
): void {
  insertMailInTx(
    tx,
    teamId,
    box,
    makeMail(PLUGIN_ACTOR, { kind: 'member', name: displayName ?? box }, 'notice', content, refs),
  );
}

/** Send a plain notice mail to one box without a live wake（独立事务版）。 */
export async function queueNotice(
  env: RuntimeEnv,
  teamId: number | string,
  box: string,
  content: string,
  refs: { taskId?: number } = {},
  displayName?: string,
): Promise<void> {
  await appendMail(
    stateRootOf(env),
    teamId,
    box,
    makeMail(PLUGIN_ACTOR, { kind: 'member', name: displayName ?? box }, 'notice', content, refs),
  );
}

/** Read one member's mailbox (tool render; mail_message_id 升序). */
export function readBox(
  env: RuntimeEnv,
  teamId: number | string,
  box: string,
): MailMessage[] {
  return readMailboxSync(stateRootOf(env), teamId, box);
}