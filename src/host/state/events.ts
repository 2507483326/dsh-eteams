/**
 * Append-only journals (docs/09.1 → docs/27)：审计事件（events 表）与邮箱
 * （mail_messages 表，按 box_key 分箱）。两者只插入不改写；event_id /
 * mail_message_id 全库自增（内存 EventRecord.seq = event_id，MailMessage.seq
 * = mail_message_id）。文件时代事件号是团队内自算的行号，入库后换全库号。
 *
 * @module dsh-eteams/state/events
 */
import type { Actor, EventRecord, MailMessage } from '../model/types.js';
import { getDb } from './db.js';
import { ensureWorkspaceReady } from './import.js';
import type { TeamTx, TeamKey } from './store.js';
import { resolveTeamId, withTeamTx } from './store.js';

/**
 * Parse a JSONL file tolerantly: a torn last line (no newline, invalid JSON)
 * is truncated away per docs/09.7; valid lines always win. 文件时代的日志
 * 读取助手，保留给导入器（import.ts）解析旧 events.jsonl / inbox 文件。
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

// --------------------------------------------------------------------------
// 事件（events 表，只插入不改写；event_id 全库自增即内存 seq）。
// --------------------------------------------------------------------------

/**
 * 事务内同步插入一条事件（docs/35 §3#14：recordEvent 并入同一同步事务）。
 * seq = 0 表示由库发号，插入后回填；已有 seq（导入）则带原号写入。
 * @returns 该事件最终的 event_id。
 */
export function insertEventInTx(tx: TeamTx, teamId: number, event: EventRecord): number {
  const assigned = event.seq > 0 ? event.seq : null;
  const info = tx.db
    .prepare(
      'INSERT INTO events (event_id, team_id, event_time, actor_kind, actor_name, type, ' +
        'task_id, attempt_id, payload, created_time, update_time) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      assigned,
      teamId,
      event.at,
      event.actor.kind,
      event.actor.name ?? null,
      event.type,
      event.taskId ?? null,
      event.attemptId ?? null,
      event.payload !== undefined ? JSON.stringify(event.payload) : null,
      event.at,
      event.at,
    );
  const seq = assigned ?? Number(info.lastInsertRowid);
  event.seq = seq;
  return seq;
}

/** Read the team event log (event_id 升序；afterSeq 增量拉取起点). */
export function readEventsSync(
  stateRoot: string,
  teamId: TeamKey,
  afterSeq = 0,
): EventRecord[] {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const id = resolveTeamId(db, teamId);
  if (id === undefined) return [];
  const rows = db
    .prepare(
      'SELECT event_id, event_time, actor_kind, actor_name, type, task_id, attempt_id, payload ' +
        'FROM events WHERE team_id = ? AND event_id > ? ORDER BY event_id',
    )
    .all(id, afterSeq) as Array<{
    event_id: number;
    event_time: number;
    actor_kind: Actor['kind'];
    actor_name: string | null;
    type: string;
    task_id: number | null;
    attempt_id: number | null;
    payload: string | null;
  }>;
  return rows.map((row) => {
    let payload: Record<string, unknown> | undefined;
    if (row.payload !== null) {
      try {
        const parsed = JSON.parse(row.payload) as unknown;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        payload = undefined;
      }
    }
    return {
      seq: row.event_id,
      at: row.event_time,
      actor: { kind: row.actor_kind, ...(row.actor_name !== null ? { name: row.actor_name } : {}) },
      type: row.type,
      ...(row.task_id !== null ? { taskId: row.task_id } : {}),
      ...(row.attempt_id !== null ? { attemptId: row.attempt_id } : {}),
      ...(payload !== undefined ? { payload } : {}),
    };
  });
}

/** Highest event seq, or 0 for an empty log (docs/09.4). */
export function lastEventSeq(stateRoot: string, teamId: TeamKey): number {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const id = resolveTeamId(db, teamId);
  if (id === undefined) return 0;
  const row = db
    .prepare('SELECT COALESCE(MAX(event_id), 0) AS seq FROM events WHERE team_id = ?')
    .get(id) as { seq: number };
  return Number(row.seq);
}

/** Convenience builder + append used by the runtime（独立事务；随动写请用 insertEventInTx）. */
export async function recordEvent(
  stateRoot: string,
  teamId: TeamKey,
  actor: Actor,
  type: string,
  refs: { taskId?: number; attemptId?: number; payload?: Record<string, unknown> } = {},
): Promise<EventRecord> {
  const event: EventRecord = {
    seq: 0,
    at: Date.now(),
    actor,
    type,
    taskId: refs.taskId,
    attemptId: refs.attemptId,
    payload: refs.payload,
  };
  withTeamTx(stateRoot, undefined, (tx) => {
    const id = resolveTeamId(tx.db, teamId);
    if (id === undefined) throw new Error(`recordEvent：找不到团队 ${String(teamId)}`);
    insertEventInTx(tx, id, event);
  });
  return event;
}

// --------------------------------------------------------------------------
// 邮箱（mail_messages 表，按 box_key 分箱；v7：成员箱 = 工号十进制串——
// (team_id, employee_id) 定箱，同名成员不串箱；领队箱 = 'captain'；
// message_id 幂等键，接收方按它去重）。
// --------------------------------------------------------------------------

/** 成员收件箱箱键（v7：工号十进制串；迁移解析不到的旧名字箱仅显示兜底）。 */
export function memberBoxKey(employeeId: number): string {
  return String(employeeId);
}

/** 事务内同步插入一封邮件（同 recordEvent 的随动写入口）。 */
export function insertMailInTx(
  tx: TeamTx,
  teamId: number,
  box: string,
  message: MailMessage,
  employeeId?: number | null,
): number {
  const assigned = message.seq > 0 ? message.seq : null;
  const info = tx.db
    .prepare(
      'INSERT INTO mail_messages (mail_message_id, team_id, message_id, box_key, employee_id, from_kind, ' +
        'from_name, to_kind, to_name, kind, task_id, attempt_id, content, read_time, ' +
        'created_time, update_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      assigned,
      teamId,
      message.id,
      box,
      employeeId ?? null,
      message.from.kind,
      message.from.name ?? null,
      message.to.kind,
      message.to.name ?? null,
      message.kind,
      message.taskId ?? null,
      message.attemptId ?? null,
      message.content,
      message.readAt ?? null,
      message.at,
      message.readAt ?? tx.now,
    );
  const seq = assigned ?? Number(info.lastInsertRowid);
  message.seq = seq;
  return seq;
}

/** Read one mailbox (mail_message_id 升序 = 投递顺序). */
export function readMailboxSync(
  stateRoot: string,
  teamId: TeamKey,
  box: string,
): MailMessage[] {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const id = resolveTeamId(db, teamId);
  if (id === undefined) return [];
  const rows = db
    .prepare(
      'SELECT mail_message_id, message_id, from_kind, from_name, to_kind, to_name, kind, ' +
        'task_id, attempt_id, content, read_time, created_time FROM mail_messages ' +
        'WHERE team_id = ? AND box_key = ? ORDER BY mail_message_id',
    )
    .all(id, box) as Array<{
    mail_message_id: number;
    message_id: string;
    from_kind: Actor['kind'];
    from_name: string | null;
    to_kind: Actor['kind'];
    to_name: string | null;
    kind: MailMessage['kind'];
    task_id: number | null;
    attempt_id: number | null;
    content: string;
    read_time: number | null;
    created_time: number;
  }>;
  return rows.map((row) => ({
    id: row.message_id,
    seq: row.mail_message_id,
    at: row.created_time,
    from: { kind: row.from_kind, ...(row.from_name !== null ? { name: row.from_name } : {}) },
    to: { kind: row.to_kind, ...(row.to_name !== null ? { name: row.to_name } : {}) },
    kind: row.kind,
    ...(row.task_id !== null ? { taskId: row.task_id } : {}),
    ...(row.attempt_id !== null ? { attemptId: row.attempt_id } : {}),
    content: row.content,
    ...(row.read_time !== null ? { readAt: row.read_time } : {}),
  }));
}

/** Append one mailbox message (must be called inside the team lock；独立事务，随动写用 insertMailInTx). */
export async function appendMail(
  stateRoot: string,
  teamId: TeamKey,
  box: string,
  message: MailMessage,
  employeeId?: number | null,
): Promise<void> {
  withTeamTx(stateRoot, undefined, (tx) => {
    const id = resolveTeamId(tx.db, teamId);
    if (id === undefined) throw new Error(`appendMail：找不到团队 ${String(teamId)}`);
    insertMailInTx(tx, id, box, message, employeeId);
  });
}
