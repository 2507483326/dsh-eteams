/**
 * Append-only journals (docs/09.1): the team event log and the per-actor
 * mailboxes. Both are JSONL — one JSON object per line, never rewritten;
 * a torn trailing line (crash mid-append) is truncated defensively on read.
 *
 * @module dsh-eteams/state/events
 */
import { existsSync, readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Actor, EventRecord, MailMessage } from '../model/types.js';
import { atomicWriteText, eventsFile, inboxFile } from './store.js';

/**
 * Parse a JSONL file tolerantly: a torn last line (no newline, invalid JSON)
 * is truncated away per docs/09.7; valid lines always win.
 */
export function parseJsonl<T>(raw: string): T[] {
  const rows: T[] = [];
  let start = 0;
  while (start < raw.length) {
    let end = raw.indexOf('\n', start);
    const hasNewline = end !== -1;
    if (!hasNewline) end = raw.length;
    const line = raw.slice(start, end).trim();
    start = hasNewline ? end + 1 : end;
    if (line === '') continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      break; // torn tail: everything after the last good line is dropped
    }
  }
  return rows;
}

/** Read the team event log (oldest first). */
export function readEventsSync(stateRoot: string, teamId: string): EventRecord[] {
  const file = eventsFile(stateRoot, teamId);
  if (!existsSync(file)) return [];
  return parseJsonl<EventRecord>(readFileSync(file, 'utf8'));
}

/** Highest event seq, or 0 for an empty log (docs/09.4). */
export function lastEventSeq(stateRoot: string, teamId: string): number {
  const events = readEventsSync(stateRoot, teamId);
  return events.length > 0 ? (events[events.length - 1]?.seq ?? 0) : 0;
}

/** Append one event line; must be called inside the team lock. */
export async function appendEvent(
  stateRoot: string,
  teamId: string,
  event: EventRecord,
): Promise<void> {
  const file = eventsFile(stateRoot, teamId);
  await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
}

/** Convenience builder + append used by the runtime. */
export async function recordEvent(
  stateRoot: string,
  teamId: string,
  actor: Actor,
  type: string,
  refs: { taskId?: string; attemptId?: string; payload?: Record<string, unknown> } = {},
): Promise<EventRecord> {
  const event: EventRecord = {
    seq: lastEventSeq(stateRoot, teamId) + 1,
    at: Date.now(),
    actor,
    type,
    taskId: refs.taskId,
    attemptId: refs.attemptId,
    payload: refs.payload,
  };
  await appendEvent(stateRoot, teamId, event);
  return event;
}

/** Read one mailbox (oldest first). */
export function readMailboxSync(stateRoot: string, teamId: string, box: string): MailMessage[] {
  const file = inboxFile(stateRoot, teamId, box);
  if (!existsSync(file)) return [];
  return parseJsonl<MailMessage>(readFileSync(file, 'utf8'));
}

/** Append one mailbox message; must be called inside the team lock. */
export async function appendMail(
  stateRoot: string,
  teamId: string,
  box: string,
  message: MailMessage,
): Promise<void> {
  await appendFile(inboxFile(stateRoot, teamId, box), `${JSON.stringify(message)}\n`, 'utf8');
}

/**
 * Truncate a journal to its last complete line (docs/09.7) — used by the
 * recovery flow when a torn tail is detected; a no-op on clean files.
 */
export async function truncateTornTail(file: string): Promise<void> {
  if (!existsSync(file)) return;
  const raw = readFileSync(file, 'utf8');
  if (raw === '' || raw.endsWith('\n')) return;
  const lastNewline = raw.lastIndexOf('\n');
  const clean = lastNewline === -1 ? '' : raw.slice(0, lastNewline + 1);
  if (clean !== raw) await atomicWriteText(file, clean);
}

/** Absolute archive root under a state dir. */
export function archiveRoot(stateRoot: string): string {
  return join(stateRoot, 'archive');
}
