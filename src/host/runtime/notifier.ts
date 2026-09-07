/**
 * Mailbox delivery + wake (docs/09.1 FR-40 → docs/27 mail_messages 表)：邮件
 * 随团队快照同一同步事务落库（insertMailInTx，seq 由库发号），唤醒是提交后
 * 的最佳努力投递（成员：按实例行 session_id 续投；领队：按任务行快照
 * main_session_id 唤醒，v6 派生，缺时心跳兜底）。收件人不在线时邮件留在库里
 * （持久），下次唤醒随派发消息送达。实例行选行规则见 docs/35 §5#12。
 *
 * @module dsh-eteams/runtime/notifier
 */
import { appendMail, insertMailInTx, readMailboxSync } from '../state/events.js';
import { LEADER_NAME } from '../state/db.js';
import type { TeamTx } from '../state/store.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type {
  Actor,
  MailMessage,
  MemberStatus,
  TaskMemberRecord,
  TaskRecord,
  TeamState,
} from '../model/types.js';
import { ETeamsError, PLUGIN_ACTOR, stateRootOf, type RuntimeEnv } from './base.js';
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
// --------------------------------------------------------------------------

/** 领队行（领队锚点，docs/36 建议 3 统一判据）。 */
export function leaderRowOf(team: TeamState): TaskMemberRecord | undefined {
  return team.taskMembers.find((r) => r.name === LEADER_NAME && r.mainTaskId === null);
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

/**
 * 任务级实例行定位：先找锚定在本任务大任务上的行；没有锚定行时退回未锚
 * 定的团队级行（addMember 建的 staged 行，main_task_id 为空）；两皆无 =
 * 未入职。
 */
export function findInstanceRow(
  team: TeamState,
  name: string,
  mainTaskId: number,
): TaskMemberRecord | undefined {
  const rows = team.taskMembers.filter((r) => r.name === name && r.status !== 'removed');
  return rows.find((r) => r.mainTaskId === mainTaskId) ?? rows.find((r) => r.mainTaskId === null);
}

/**
 * 跨任务选行（§5#12）：非 removed、已起会话（session_id 非空）的最
 * 近活跃行。TaskMemberRecord 内存不带 update_time（docs/27 库列），以
 * createdAt/id 最大行近似「最近活跃」。
 */
export function latestInstanceRow(team: TeamState, name: string): TaskMemberRecord | undefined {
  const rows = team.taskMembers
    .filter((r) => r.name === name && r.status !== 'removed' && r.sessionId !== '')
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  return rows[0];
}

/** 在册判定：该成员名下存在非 removed 实例行（领队行同样算在册）。 */
export function requireMember(team: TeamState, name: string): TaskMemberRecord {
  const rows = team.taskMembers.filter((r) => r.name === name && r.status !== 'removed');
  if (rows.length === 0) {
    throw new ETeamsError(`成员「${name}」不存在`, '用 eteams_team_status 查看在册成员');
  }
  return rows[rows.length - 1]!;
}

/**
 * 成员聚合状态（团队视图/看板口径）：任一实例行 working 即 working，其次
 * paused；没有实例行 = staged（只有班底模板行）。
 */
export function memberStatusOf(team: TeamState, name: string): MemberStatus {
  const rows = team.taskMembers.filter((r) => r.name === name && r.status !== 'removed');
  if (rows.length === 0) return 'staged';
  if (rows.some((r) => r.status === 'working')) return 'working';
  if (rows.some((r) => r.status === 'paused')) return 'paused';
  return rows[0]!.status;
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
    await env.ctx.subagents.followup(
      captain,
      row.sessionId as unknown as SessionId,
      [{ type: 'text', text }],
      { source: { kind: 'plugin', plugin: 'dsh-eteams' }, signal: env.signal },
    );
    return true;
  } catch (error) {
    env.ctx.logger.warn(`eteams: followup to member ${row.name} failed: ${String(error)}`);
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

/** 事务内入队一封通知邮件（无唤醒；提交后由派发/唤醒路径补投）。 */
export function queueNoticeInTx(
  tx: TeamTx,
  teamId: number,
  box: string,
  content: string,
  refs: { taskId?: number } = {},
): void {
  insertMailInTx(
    tx,
    teamId,
    box,
    makeMail(PLUGIN_ACTOR, { kind: 'member', name: box }, 'notice', content, refs),
  );
}

/** Send a plain notice mail to one box without a live wake（独立事务版）。 */
export async function queueNotice(
  env: RuntimeEnv,
  teamId: number | string,
  box: string,
  content: string,
  refs: { taskId?: number } = {},
): Promise<void> {
  await appendMail(
    stateRootOf(env),
    teamId,
    box,
    makeMail(PLUGIN_ACTOR, { kind: 'member', name: box }, 'notice', content, refs),
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