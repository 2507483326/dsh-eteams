/**
 * ask_questions 表读写（v11；2026-09-10 统一问答后语义）：eteams_ask_user 的
 * 审计/回收表——子代理弹窗前先落一行 pending（面板「待问答」徽标的数据源），
 * 弹窗拿到答案后宿主落行 answered。独立行
 * CRUD（不随 TeamState 整存整取重写，events.ts 同型：随动写走 *InTx，独立
 * 事务走直写助手）。ask_id 由调用方生成（uuid）——主键即幂等键。
 *
 * @module dsh-eteams/state/asks
 */
import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { ensureWorkspaceReady } from './import.js';

/** 问答单里的一道选择题（与 ctx.userQuestions 的请求形状对齐）。 */
export interface AskQuestion {
  id: string;
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  /** 允许多选（缺省单选）。 */
  multiSelect?: boolean;
}

/** 一道题的答案：selected=所选项 label（多选以「、」连接的单一字符串），
 * custom=用户自填文本（单选自填时 selected 为空）。入库前统一归一化
 * （弹窗服务的串数组答案折算成「、」连接串）。 */
export interface AskAnswer {
  id: string;
  selected: string;
  custom?: string;
}

/** 问答单生命周期：pending → answered | expired | cancelled。 */
export type AskStatus = 'pending' | 'answered' | 'expired' | 'cancelled';

/** 一张问答单（ask_questions 行的内存形状）。 */
export interface AskRecord {
  askId: string;
  teamId: number;
  /** 提问子代理会话 ID（面板定位用）。 */
  askingSessionId: string;
  /** 提问者展示名（成员名 / '领队' / '角色构建师'；面板文案用）。 */
  askingName: string;
  /** 提问者类型。 */
  askingKind: 'captain' | 'member' | 'conversation';
  /** 相关大任务 ID（可选）。 */
  mainTaskId?: number;
  questions: AskQuestion[];
  answers?: AskAnswer[];
  status: AskStatus;
  /** 弹窗所在会话 ID（2026-09-10 统一后恒等于提问会话自身，审计留档）。 */
  relaySessionId?: string;
  /** 弹窗**实际落在**的会话 ID（v14；看板「决策面板」跳转目标）。 */
  deliverySessionId?: string;
  /** 落点是否为主对话（v14）：true=主对话 / false=提问子会话 / 缺省=未知。 */
  deliveryIsMain?: boolean;
  createdAt: number;
  answeredAt?: number;
  updatedAt: number;
}

/** Fresh ask_id（uuid；调用方生成后随 insert 落库）。 */
export function newAskId(): string {
  return randomUUID();
}

/** 入参答案容错归一（弹窗服务的串数组 selected 折算成「、」连接串）；
 * 缺 id 的条目丢弃返回 undefined。工具入参与弹窗服务回包共用。 */
export function normalizeAskAnswer(raw: unknown): AskAnswer | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const id = typeof o['id'] === 'string' ? o['id'] : '';
  if (id === '') return undefined;
  let selected = '';
  if (typeof o['selected'] === 'string') selected = o['selected'];
  else if (Array.isArray(o['selected'])) {
    selected = o['selected'].filter((s): s is string => typeof s === 'string').join('、');
  }
  return {
    id,
    selected,
    ...(typeof o['custom'] === 'string' && o['custom'] !== '' ? { custom: o['custom'] } : {}),
  };
}

/** 内存行 → 列值包（insert/update 共用）。 */
function askColumns(record: AskRecord): {
  askId: string;
  teamId: number;
  askingSessionId: string;
  askingName: string;
  askingKind: string;
  mainTaskId: number | null;
  questions: string;
  answers: string | null;
  status: string;
  relaySessionId: string | null;
  deliverySessionId: string | null;
  deliveryIsMain: number | null;
  createdAt: number;
  answeredTime: number | null;
  updateTime: number;
} {
  return {
    askId: record.askId,
    teamId: record.teamId,
    askingSessionId: record.askingSessionId,
    askingName: record.askingName,
    askingKind: record.askingKind,
    mainTaskId: record.mainTaskId ?? null,
    questions: JSON.stringify(record.questions),
    answers: record.answers !== undefined ? JSON.stringify(record.answers) : null,
    status: record.status,
    relaySessionId: record.relaySessionId ?? null,
    deliverySessionId: record.deliverySessionId ?? null,
    deliveryIsMain:
      record.deliveryIsMain === undefined ? null : record.deliveryIsMain ? 1 : 0,
    createdAt: record.createdAt,
    answeredTime: record.answeredAt ?? null,
    updateTime: record.updatedAt,
  };
}

/** 行 → 内存形状（坏 JSON 容错：questions 解析失败按空单处理——读端永不炸）。 */
function rowToRecord(row: Record<string, unknown>): AskRecord {
  let questions: AskQuestion[] = [];
  try {
    const parsed = JSON.parse(String(row['questions'])) as unknown;
    if (Array.isArray(parsed)) questions = parsed as AskQuestion[];
  } catch {
    questions = [];
  }
  let answers: AskAnswer[] | undefined;
  if (row['answers'] !== null && row['answers'] !== undefined) {
    try {
      const parsed = JSON.parse(String(row['answers'])) as unknown;
      if (Array.isArray(parsed)) answers = parsed as AskAnswer[];
    } catch {
      answers = undefined;
    }
  }
  return {
    askId: String(row['ask_id']),
    teamId: Number(row['team_id']),
    askingSessionId: String(row['asking_session_id'] ?? ''),
    askingName: String(row['asking_name'] ?? ''),
    askingKind: row['asking_kind'] as AskRecord['askingKind'],
    ...(row['main_task_id'] !== null && row['main_task_id'] !== undefined
      ? { mainTaskId: Number(row['main_task_id']) }
      : {}),
    questions,
    ...(answers !== undefined ? { answers } : {}),
    status: row['status'] as AskStatus,
    ...(row['relay_session_id'] !== null && row['relay_session_id'] !== undefined
      ? { relaySessionId: String(row['relay_session_id']) }
      : {}),
    ...(row['delivery_session_id'] !== null && row['delivery_session_id'] !== undefined
      ? { deliverySessionId: String(row['delivery_session_id']) }
      : {}),
    ...(row['delivery_is_main'] !== null && row['delivery_is_main'] !== undefined
      ? { deliveryIsMain: Number(row['delivery_is_main']) !== 0 }
      : {}),
    createdAt: Number(row['created_time']),
    ...(row['answered_time'] !== null && row['answered_time'] !== undefined
      ? { answeredAt: Number(row['answered_time']) }
      : {}),
    updatedAt: Number(row['update_time']),
  };
}

const SELECT_COLS =
  'ask_id, team_id, asking_session_id, asking_name, asking_kind, main_task_id, questions, ' +
  'answers, status, relay_session_id, delivery_session_id, delivery_is_main, ' +
  'created_time, answered_time, update_time';

/** Insert one ask row（独立事务；幂等键冲突整体失败——ask_id 唯一）。 */
export function insertAskSync(stateRoot: string, record: AskRecord): void {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const c = askColumns(record);
  db.prepare(
    'INSERT INTO ask_questions (ask_id, team_id, asking_session_id, asking_name, asking_kind, ' +
      'main_task_id, questions, answers, status, relay_session_id, delivery_session_id, ' +
      'delivery_is_main, created_time, answered_time, update_time) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    c.askId,
    c.teamId,
    c.askingSessionId,
    c.askingName,
    c.askingKind,
    c.mainTaskId,
    c.questions,
    c.answers,
    c.status,
    c.relaySessionId,
    c.deliverySessionId,
    c.deliveryIsMain,
    c.createdAt,
    c.answeredTime,
    c.updateTime,
  );
}

/**
 * 回写弹窗**实际落点**（v14）：runAskUser 先按意图落 delivery（面板在待答
 * 期间即可跳转），若主对话弹窗被拒、退回提问子会话成功，则用本函数把落点
 * 更正为提问会话。仅改落点两列，不动问答单状态。
 */
export function recordAskDeliverySync(
  stateRoot: string,
  askId: string,
  deliverySessionId: string,
  deliveryIsMain: boolean,
): void {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  db.prepare(
    'UPDATE ask_questions SET delivery_session_id = ?, delivery_is_main = ?, update_time = ? ' +
      'WHERE ask_id = ?',
  ).run(deliverySessionId, deliveryIsMain ? 1 : 0, Date.now(), askId);
}

/** Read one ask row by id（缺失返回 undefined）。 */
export function readAskSync(stateRoot: string, askId: string): AskRecord | undefined {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const row = db
    .prepare(`SELECT ${SELECT_COLS} FROM ask_questions WHERE ask_id = ?`)
    .get(askId) as Record<string, unknown> | undefined;
  return row !== undefined ? rowToRecord(row) : undefined;
}

/** Pending asks of one team（ask_id 升序；面板「待问答」徽标用）。 */
export function readPendingAsksSync(stateRoot: string, teamId: number): AskRecord[] {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM ask_questions WHERE team_id = ? AND status = 'pending' ORDER BY ask_id`,
    )
    .all(teamId) as Array<Record<string, unknown>>;
  return rows.map(rowToRecord);
}

/**
 * 最近已结束问答单（answered/cancelled/expired；结束时刻降序、最新在前，
 * limit 限量）。历史全量留库，读端只回看最近 N 条——看板「决策面板」
 * 『已决策』历史数据源（pending 单走 {@link readPendingAsksSync}）。
 */
export function readRecentAsksSync(
  stateRoot: string,
  teamId: number,
  limit: number,
): AskRecord[] {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM ask_questions WHERE team_id = ? AND status != 'pending' ` +
        'ORDER BY COALESCE(answered_time, update_time) DESC LIMIT ?',
    )
    .all(teamId, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToRecord);
}

/** 全库 pending 问答单（ask_id 升序；跨团队含 teamId=0 构建桶——诊断/
 * 运维读端）。 */
export function readAllPendingAsksSync(stateRoot: string): AskRecord[] {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const rows = db
    .prepare(`SELECT ${SELECT_COLS} FROM ask_questions WHERE status = 'pending' ORDER BY ask_id`)
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToRecord);
}

/**
 * Submit answers to a pending ask（问答单只能答一次：status 仍是 pending 才
 * 写——先答者胜，双入口竞态（弹窗提交 vs 面板/对话补答）不去重会互相覆盖）。
 * @returns 落库后的问答单。
 * @throws 该单不存在 / 已不是 pending（已答/超时/中断）时抛错，调用方原样
 * 回给提交会话（换问答单再提交或告知用户已超时）。
 */
export function answerAskSync(
  stateRoot: string,
  askId: string,
  answers: AskAnswer[],
): AskRecord {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const existing = readAskSync(stateRoot, askId);
  if (existing === undefined) {
    throw new Error(`问答单 ${askId} 不存在——请核对 askId 后重试`);
  }
  if (existing.status !== 'pending') {
    throw new Error(`问答单已结束（${existing.status}），答案不再接收`);
  }
  const now = Date.now();
  db.prepare(
    'UPDATE ask_questions SET answers = ?, status = ?, answered_time = ?, update_time = ? ' +
      'WHERE ask_id = ? AND status = ?',
  ).run(JSON.stringify(answers), 'answered', now, now, askId, 'pending');
  return { ...existing, answers, status: 'answered', answeredAt: now, updatedAt: now };
}

/** Mark an ask cancelled（调用方 abort/弹窗失败；仅 pending 可迁移）。 */
export function cancelAskSync(stateRoot: string, askId: string): void {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  db.prepare(
    "UPDATE ask_questions SET status = 'cancelled', update_time = ? WHERE ask_id = ? AND status = 'pending'",
  ).run(Date.now(), askId);
}
