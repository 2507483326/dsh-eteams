/**
 * Mailbox delivery + wake (docs/09.1, FR-40): at-least-once append to the
 * durable inbox, then a best-effort live delivery (member: subagent
 * followup; captain: agent-registry wake). A stranded mailbox (recipient
 * not live) stays durable and is re-delivered on the next wake.
 *
 * @module dsh-eteams/runtime/notifier
 */
import type { Actor, MailMessage, MemberRecord, TeamState } from '../model/types.js';
import { appendMail, readMailboxSync } from '../state/events.js';
import { inboxFile } from '../state/store.js';
import { existsSync } from 'node:fs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { ETeamsError, PLUGIN_ACTOR, stateRootOf, type RuntimeEnv } from './base.js';

let mailCounter = 0;

/** Build a mailbox row (seq allocation happens on append below). */
function makeMail(from: Actor, to: Actor, kind: MailMessage['kind'], content: string, refs: { taskId?: string; attemptId?: string }): MailMessage {
  return {
    id: `m${Date.now().toString(36)}-${++mailCounter}`,
    seq: 0,
    at: Date.now(),
    from,
    to,
    kind,
    taskId: refs.taskId,
    attemptId: refs.attemptId,
    content,
  };
}

/** Append to one durable inbox (seq = file-local next). */
export async function deliverMail(env: RuntimeEnv, team: TeamState, box: string, message: MailMessage): Promise<MailMessage> {
  const root = stateRootOf(env);
  const existing = readMailboxSync(root, team.id, box);
  const row: MailMessage = { ...message, seq: existing.length + 1 };
  await appendMail(root, team.id, box, row);
  return row;
}

/**
 * Wake one member as its next FIFO turn. Best effort: offline members keep
 * the message in their durable inbox (stranded → re-delivered next wake;
 * here the next assignment followup re-sends it).
 */
export async function wakeMember(env: RuntimeEnv, team: TeamState, member: MemberRecord, text: string): Promise<boolean> {
  const root = stateRootOf(env);
  const box = inboxFile(root, team.id, member.name);
  if (!existsSync(box)) return false;
  if (!member.id) return false; // staged member: mail stays stranded until spawn
  const captain = env.ctx.agents.get(team.captainSessionId);
  if (!captain) {
    env.ctx.logger.warn(`eteams: captain ${team.captainSessionId} not live; mail for ${member.name} stays queued`);
    return false;
  }
  try {
    await env.ctx.subagents.followup(
      captain,
      member.id as SessionId,
      [{ type: 'text', text }],
      { source: { kind: 'plugin', plugin: 'dsh-eteams' }, signal: env.signal },
    );
    return true;
  } catch (error) {
    env.ctx.logger.warn(`eteams: followup to member ${member.name} failed: ${String(error)}`);
    return false;
  }
}

/**
 * Notify the captain: durable mail + in-session wake. The captain's own
 * followup keeps it in its conversation (plugin-source user message).
 */
export async function notifyCaptain(env: RuntimeEnv, team: TeamState, content: string, refs: { taskId?: string; attemptId?: string } = {}): Promise<boolean> {
  await deliverMail(env, team, 'captain', makeMail(PLUGIN_ACTOR, { kind: 'captain', name: '领队' }, 'report', content, refs));
  const captain = env.ctx.agents.get(team.captainSessionId);
  if (!captain) {
    env.ctx.logger.warn(`eteams: captain ${team.captainSessionId} not live; report stays in mailbox`);
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

/** Send a plain notice mail to one box without a live wake. */
export async function queueNotice(env: RuntimeEnv, team: TeamState, box: string, content: string, refs: { taskId?: string } = {}): Promise<void> {
  await deliverMail(env, team, box, makeMail(PLUGIN_ACTOR, { kind: 'member', name: box }, 'notice', content, refs));
}

/** Assignment delivery: durable mail + wake; throws only on state errors. */
export async function deliverAssignment(
  env: RuntimeEnv,
  team: TeamState,
  member: MemberRecord,
  content: string,
  refs: { taskId: string; attemptId: string },
): Promise<void> {
  await deliverMail(env, team, member.name, makeMail({ kind: 'captain', name: '领队' }, { kind: 'member', name: member.name }, 'assignment', content, refs));
  await wakeMember(env, team, member, content);
}

/** Read one member's mailbox (tool render). */
export function readBox(env: RuntimeEnv, teamId: string, box: string): MailMessage[] {
  return readMailboxSync(stateRootOf(env), teamId, box);
}

/** Guard used by send_message target resolution. */
export function requireMember(team: TeamState, name: string): MemberRecord {
  const member = team.members.find((m) => m.name === name && m.status !== 'removed');
  if (!member) throw new ETeamsError(`成员「${name}」不存在`, '用 eteams_team_status 查看在册成员');
  return member;
}
