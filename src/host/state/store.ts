/**
 * Team state store (docs/09 → docs/27/35)：SQLite 整存整取持久层。读端
 * （readTeam/listTeams）从 11 张表重装 TeamState；写端（writeTeam）在一个
 * `BEGIN IMMEDIATE … COMMIT` 同步事务里 DELETE 该团队行 + 带原号重 INSERT
 * （崩溃要么整体回滚要么整体生效）。文件时代的目录布局助手（teamDir/
 * snapshotFile/eventsFile/inboxFile）与 atomicWriteText 暂留导出——波次 2/3
 * 的调用方切换数据源后删除。
 *
 * @module dsh-eteams/state/store
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { sanitizeKey } from '../model/taskMachine.js';
import type {
  AttemptRecord,
  ChainStation,
  DecisionRecord,
  MemberRecord,
  TaskMemberRecord,
  TaskRecord,
  TaskStatus,
  TeamState,
} from '../model/types.js';
import {
  avatarFromJson,
  avatarToJson,
  getDb,
  LEADER_NAME,
  personaFromMd,
  personaToMd,
  routeFromColumns,
  routeToColumns,
} from './db.js';
import { ensureWorkspaceReady } from './import.js';

/** Windows rename hazards that trigger the retry-then-degrade protocol. */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);

let tmpSeq = 0;

/**
 * Atomic text write (docs/09.2): same-directory temp file + rename; on the
 * documented Windows hazards retry ≤3× (50ms) then degrade to a direct
 * overwrite. A total failure throws and the caller rolls back in memory.
 */
export async function atomicWriteText(file: string, content: string): Promise<void> {
  const dir = join(file, '..');
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${file.slice(dir.length + 1)}.${process.pid}.${++tmpSeq}.tmp`);
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await writeFile(tmp, content, 'utf8');
      await rename(tmp, file);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException)?.code ?? '';
      if (!RENAME_RETRY_CODES.has(code)) throw error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      // Retries exhausted (docs/09.2): degrade to a direct overwrite, the
      // same strategy as the reference implementation.
      await writeFile(file, content, 'utf8');
      await rm(tmp, { force: true });
      return;
    }
  }
  throw lastError;
}

/** Absolute team directory for a state root. */
export function teamDir(stateRoot: string, teamId: string): string {
  return join(stateRoot, teamId);
}

/** Absolute snapshot path. */
export function snapshotFile(stateRoot: string, teamId: string): string {
  return join(teamDir(stateRoot, teamId), 'team.json');
}

/** Absolute events log path. */
export function eventsFile(stateRoot: string, teamId: string): string {
  return join(teamDir(stateRoot, teamId), 'events.jsonl');
}

/** Absolute mailbox path for one inbox key (`captain` or member key). */
export function inboxFile(stateRoot: string, teamId: string, box: string): string {
  return join(teamDir(stateRoot, teamId), 'inbox', `${sanitizeKey(box)}.jsonl`);
}

/** Serialize a snapshot to its on-disk JSON form (legacy file-era export). */
export function serializeTeam(state: TeamState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

// --------------------------------------------------------------------------
// 同步事务助手（docs/35 §3#14）：锁内 BEGIN IMMEDIATE … COMMIT 之间不得出现
// await；recordEvent 等随动写通过 insertEventInTx 并入同一事务。嵌套调用
// 禁止——事务内改用 writeTeamInTx / insertEventInTx，不要叠 withTeamTx。
// --------------------------------------------------------------------------

/** 一个打开的团队写事务句柄（teamId 未知时——如建队——传 undefined）。 */
export interface TeamTx {
  db: DatabaseSync;
  /** 事务所属团队（建队等发号场景为 undefined）。 */
  teamId?: number;
  /** 事务开始时刻（同一事务内所有 update_time 用它，保持一致）。 */
  now: number;
}

/**
 * Run `fn` inside one synchronous BEGIN IMMEDIATE … COMMIT transaction.
 * Anything thrown inside triggers ROLLBACK and rethrows; `fn` must not await.
 */
export function withTeamTx<T>(
  stateRoot: string,
  teamId: number | undefined,
  fn: (tx: TeamTx) => T,
): T {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn({ db, teamId, now: Date.now() });
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 事务已自动回滚：清理动作本身失败不必掩盖原异常
    }
    throw error;
  }
}

/** roles 表按角色名解析 role_id（松引用；无该角色行时 NULL）。 */
function roleIdOf(db: DatabaseSync, role: string): number | null {
  const row = db
    .prepare('SELECT role_id FROM roles WHERE role_name = ?')
    .get(role) as { role_id: number } | undefined;
  return row?.role_id ?? null;
}

/**
 * 新建团队行（docs/35 §5#2）：在调用方事务内 INSERT，返回自增 team_id；
 * 领队 task_members 行由调用方（teamOps.createTeam，波次 2）紧接着写。
 */
export function insertTeamRow(tx: TeamTx, name: string, hasLeader: boolean, now: number): number {
  const info = tx.db
    .prepare(
      'INSERT INTO team (team_name, has_leader, created_time, update_time) VALUES (?, ?, ?, ?)',
    )
    .run(name, hasLeader ? 1 : 0, now, now);
  return Number(info.lastInsertRowid);
}

/**
 * 插入一条执行实例行（task_members）：内存新建行 id = 0，落库时交给自增
 * 发号并把发下的号回填进内存（docs/27 §27.4）；已有号则带原号写入。
 * 返回该行最终 id。领队行（mainTaskId 为空）与任务实例行同走这里。
 */
export function insertTaskMemberRow(tx: TeamTx, row: TaskMemberRecord): number {
  const assigned = row.id > 0 ? row.id : null;
  const info = tx.db
    .prepare(
      'INSERT INTO task_members (task_member_id, team_id, main_task_id, now_task_id, name, ' +
        'employee_id, main_session_id, child_session_id, role_id, status, persona_md, model, ' +
        'reasoning_effort, avatar, created_time, update_time) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      assigned,
      row.teamId,
      row.mainTaskId,
      row.nowTaskId,
      row.name,
      row.employeeId ?? null,
      row.mainSessionId,
      row.childSessionId,
      row.roleId ?? null,
      row.status,
      row.personaMd ?? null,
      row.model !== undefined && row.model !== '' ? row.model : null,
      row.reasoningEffort !== undefined && row.reasoningEffort !== '' ? row.reasoningEffort : null,
      avatarToJson(row.avatar),
      row.createdAt,
      tx.now,
    );
  const id = assigned ?? Number(info.lastInsertRowid);
  row.id = id;
  return id;
}

// --------------------------------------------------------------------------
// 读端：从 11 张表重装 TeamState（docs/35 §2 整存整取的读半边）。
// --------------------------------------------------------------------------

/** 团队定位键：数字 = team_id；文本先按 team_name 精确匹配，再试整数串。 */
export type TeamKey = string | number;

/** team 表行的读取形状。 */
interface TeamRow {
  team_id: number;
  team_name: string;
  has_leader: number;
  created_time: number;
  update_time: number;
}

/** 按键定位 team 行（找不到返回 undefined）。 */
function selectTeamRow(db: DatabaseSync, key: TeamKey): TeamRow | undefined {
  if (typeof key === 'number') {
    return db
      .prepare('SELECT team_id, team_name, has_leader, created_time, update_time FROM team WHERE team_id = ?')
      .get(key) as TeamRow | undefined;
  }
  const byName = db
    .prepare('SELECT team_id, team_name, has_leader, created_time, update_time FROM team WHERE team_name = ?')
    .get(key) as TeamRow | undefined;
  if (byName !== undefined) return byName;
  if (/^\d+$/.test(key)) {
    return db
      .prepare('SELECT team_id, team_name, has_leader, created_time, update_time FROM team WHERE team_id = ?')
      .get(Number(key)) as TeamRow | undefined;
  }
  return undefined;
}

/** 团队键 → 数字 team_id（events.ts 等随动写方用；未知键返回 undefined）。 */
export function resolveTeamId(db: DatabaseSync, key: TeamKey): number | undefined {
  return selectTeamRow(db, key)?.team_id;
}

/** member 表行（班底；TeamState.members 只装 team_id = 本队的行）。 */
function loadMembers(db: DatabaseSync, teamId: number): MemberRecord[] {
  const rows = db
    .prepare(
      'SELECT m.member_id, m.role_name, r.role_name AS role_label, m.employee_id, m.persona_md, ' +
        'm.model, m.reasoning_effort, m.avatar, m.created_time ' +
        'FROM member m LEFT JOIN roles r ON r.role_id = m.role_id ' +
        'WHERE m.team_id = ? ORDER BY m.member_id',
    )
    .all(teamId) as Array<{
    member_id: number;
    role_name: string;
    role_label: string | null;
    employee_id: number | null;
    persona_md: string | null;
    model: string | null;
    reasoning_effort: string | null;
    avatar: string | null;
    created_time: number;
  }>;
  return rows.map((row) => ({
    memberId: row.member_id,
    name: row.role_name,
    ...(row.employee_id !== null ? { employeeId: row.employee_id } : {}),
    role: row.role_label ?? row.role_name,
    persona: personaFromMd(row.persona_md ?? '', row.role_name, row.role_label ?? row.role_name),
    modelRoute: routeFromColumns(row.model, row.reasoning_effort),
    avatar: avatarFromJson(row.avatar) ?? { seed: 0, salt: 0 },
    createdAt: row.created_time,
  }));
}

/** task_members 实例行（含领队主持行），按 task_member_id 升序装回。 */
function loadTaskMembers(db: DatabaseSync, teamId: number): TaskMemberRecord[] {
  const rows = db
    .prepare(
      'SELECT task_member_id, team_id, main_task_id, now_task_id, name, employee_id, ' +
        'main_session_id, child_session_id, role_id, status, persona_md, model, ' +
        'reasoning_effort, avatar, created_time FROM task_members WHERE team_id = ? ' +
        'ORDER BY task_member_id',
    )
    .all(teamId) as Array<{
    task_member_id: number;
    team_id: number;
    main_task_id: number | null;
    now_task_id: number | null;
    name: string;
    employee_id: number | null;
    main_session_id: string;
    child_session_id: string;
    role_id: number | null;
    status: TaskMemberRecord['status'];
    persona_md: string | null;
    model: string | null;
    reasoning_effort: string | null;
    avatar: string | null;
    created_time: number;
  }>;
  return rows.map((row) => ({
    id: row.task_member_id,
    teamId: row.team_id,
    mainTaskId: row.main_task_id,
    nowTaskId: row.now_task_id,
    name: row.name,
    employeeId: row.employee_id,
    mainSessionId: row.main_session_id,
    childSessionId: row.child_session_id,
    roleId: row.role_id,
    status: row.status,
    ...(row.persona_md !== null ? { personaMd: row.persona_md } : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.reasoning_effort !== null ? { reasoningEffort: row.reasoning_effort } : {}),
    ...(row.avatar !== null ? { avatar: avatarFromJson(row.avatar) } : {}),
    createdAt: row.created_time,
  }));
}

/** attempts 表行按 task_id 分组装回（docs/27 §27.6.2 唯一拆表数组）。 */
function loadAttempts(db: DatabaseSync, teamId: number): Map<number, AttemptRecord[]> {
  const rows = db
    .prepare(
      'SELECT attempt_id, task_id, kind, member, status, token, station_index, progress, ' +
        'result_output, result_changed_paths, error, claimed_time, ended_time, created_time ' +
        'FROM attempts WHERE team_id = ? ORDER BY attempt_id',
    )
    .all(teamId) as Array<{
    attempt_id: number;
    task_id: number;
    kind: AttemptRecord['kind'];
    member: string;
    status: AttemptRecord['status'];
    token: string;
    station_index: number;
    progress: string;
    result_output: string | null;
    result_changed_paths: string | null;
    error: string | null;
    claimed_time: number | null;
    ended_time: number | null;
    created_time: number;
  }>;
  const byTask = new Map<number, AttemptRecord[]>();
  for (const row of rows) {
    let progress: AttemptRecord['progress'] = [];
    try {
      const parsed = JSON.parse(row.progress) as unknown;
      if (Array.isArray(parsed)) progress = parsed as AttemptRecord['progress'];
    } catch {
      progress = [];
    }
    let changedPaths: string[] | undefined;
    if (row.result_changed_paths !== null) {
      try {
        const parsed = JSON.parse(row.result_changed_paths) as unknown;
        if (Array.isArray(parsed)) changedPaths = parsed.map(String);
      } catch {
        changedPaths = undefined;
      }
    }
    const attempt: AttemptRecord = {
      id: row.attempt_id,
      taskId: row.task_id,
      kind: row.kind,
      member: row.member,
      status: row.status,
      token: row.token,
      stationIndex: row.station_index,
      createdAt: row.created_time,
      ...(row.claimed_time !== null ? { claimedAt: row.claimed_time } : {}),
      ...(row.ended_time !== null ? { endedAt: row.ended_time } : {}),
      progress,
      ...(row.result_output !== null
        ? { result: { output: row.result_output, ...(changedPaths !== undefined ? { changedPaths } : {}) } }
        : {}),
      ...(row.error !== null ? { error: row.error } : {}),
    };
    const bucket = byTask.get(row.task_id);
    if (bucket === undefined) byTask.set(row.task_id, [attempt]);
    else bucket.push(attempt);
  }
  return byTask;
}

/** task + decisions 表行重装（attempts 已分组按 task_id 装回）。 */
function loadTasks(
  db: DatabaseSync,
  teamId: number,
  attemptsByTask: Map<number, AttemptRecord[]>,
): { tasks: TaskRecord[]; pendingDecisions: DecisionRecord[] } {
  const taskRows = db
    .prepare(
      'SELECT task_id, parent_id, subject, description, depend_tasks, member_chain_list, ' +
        'chain_cursor, status, current_member, retry_count, status_note, contract_md, ' +
        'idempotency_note, blocked_from, work_dir, completed_time, ' +
        'created_time, update_time FROM task WHERE team_id = ? ORDER BY task_id',
    )
    .all(teamId) as Array<{
    task_id: number;
    parent_id: number | null;
    subject: string;
    description: string | null;
    depend_tasks: string;
    member_chain_list: string;
    chain_cursor: number;
    status: TaskStatus;
    current_member: string | null;
    retry_count: number;
    status_note: string | null;
    contract_md: string | null;
    idempotency_note: string | null;
    blocked_from: string | null;
    work_dir: string | null;
    completed_time: number | null;
    created_time: number;
    update_time: number;
  }>;
  const tasks: TaskRecord[] = taskRows.map((row) => {
    let dependencies: number[] = [];
    let chain: ChainStation[] = [];
    try {
      const deps = JSON.parse(row.depend_tasks) as unknown;
      if (Array.isArray(deps)) dependencies = deps.map(Number);
    } catch {
      dependencies = [];
    }
    try {
      const stations = JSON.parse(row.member_chain_list) as unknown;
      if (Array.isArray(stations)) chain = stations as ChainStation[];
    } catch {
      chain = [];
    }
    return {
      id: row.task_id,
      subject: row.subject,
      parentId: row.parent_id,
      ...(row.description !== null ? { description: row.description } : {}),
      ...(row.contract_md !== null ? { contractMd: row.contract_md } : {}),
      ...(row.idempotency_note !== null ? { idempotencyNote: row.idempotency_note } : {}),
      dependencies,
      chain,
      chainCursor: row.chain_cursor,
      status: row.status,
      ...(row.current_member !== null ? { assignee: row.current_member } : {}),
      attempts: attemptsByTask.get(row.task_id) ?? [],
      retryCount: row.retry_count,
      ...(row.blocked_from !== null ? { blockedFrom: row.blocked_from as TaskStatus } : {}),
      ...(row.status_note !== null ? { statusNote: row.status_note } : {}),
      ...(row.work_dir !== null ? { workDir: row.work_dir } : {}),
      createdAt: row.created_time,
      updatedAt: row.update_time,
      ...(row.completed_time !== null ? { completedAt: row.completed_time } : {}),
    };
  });
  const decisionRows = db
    .prepare(
      'SELECT decision_id, task_id, attempt_id, error, retry_count, choice, note, resolved_time, created_time ' +
        'FROM decisions WHERE team_id = ? AND status = ? ORDER BY decision_id',
    )
    .all(teamId, 'open') as Array<{
    decision_id: number;
    task_id: number;
    attempt_id: number | null;
    error: string;
    retry_count: number;
    choice: string | null;
    note: string | null;
    resolved_time: number | null;
    created_time: number;
  }>;
  const pendingDecisions: DecisionRecord[] = decisionRows.map((row) => ({
    id: row.decision_id,
    taskId: row.task_id,
    ...(row.attempt_id !== null ? { attemptId: row.attempt_id } : {}),
    error: row.error,
    retryCount: row.retry_count,
    status: 'open' as const,
    createdAt: row.created_time,
    ...(row.resolved_time !== null ? { resolvedAt: row.resolved_time } : {}),
    ...(row.choice !== null ? { choice: row.choice as DecisionRecord['choice'] } : {}),
    ...(row.note !== null ? { note: row.note } : {}),
  }));
  return { tasks, pendingDecisions };
}

/** 一张 team 行 + 各表行 → TeamState（读写两端共用的重装逻辑）。 */
function assembleTeam(db: DatabaseSync, row: TeamRow): TeamState {
  const attemptsByTask = loadAttempts(db, row.team_id);
  const { tasks, pendingDecisions } = loadTasks(db, row.team_id, attemptsByTask);
  return {
    id: row.team_id,
    name: row.team_name,
    hasLeader: row.has_leader === 1,
    createdAt: row.created_time,
    updatedAt: row.update_time,
    taskMembers: loadTaskMembers(db, row.team_id),
    members: loadMembers(db, row.team_id),
    tasks,
    pendingDecisions,
  };
}

/**
 * Read one team's rows and reassemble TeamState; `undefined` when no such
 * team（键可以是 team_id 数字、team_name 或整数串）。
 */
export async function readTeam(
  stateRoot: string,
  teamId: TeamKey,
): Promise<TeamState | undefined> {
  return readTeamSync(stateRoot, teamId);
}

/** Synchronous read used inside continuable setup hooks (must not await). */
export function readTeamSync(stateRoot: string, teamId: TeamKey): TeamState | undefined {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const row = selectTeamRow(db, teamId);
  if (row === undefined) return undefined;
  return assembleTeam(db, row);
}

// --------------------------------------------------------------------------
// 写端：一个同步事务里 DELETE 团队行 + 带原号重 INSERT（docs/35 §2）。
// 只重写 TeamState 支撑的 6 张表——events / mail_messages /
// task_status_changes 只插入不改写，不属于快照。
// --------------------------------------------------------------------------

/** 快照全量落库（供 withTeamTx 内调用；勿在其外叠层开启事务）。 */
export function writeTeamInTx(tx: TeamTx, state: TeamState): void {
  const { db } = tx;
  const now = tx.now;
  state.updatedAt = now;
  const teamId = state.id;
  db.prepare('DELETE FROM team WHERE team_id = ?').run(teamId);
  db.prepare(
    'INSERT INTO team (team_id, team_name, has_leader, created_time, update_time) VALUES (?, ?, ?, ?, ?)',
  ).run(teamId, state.name, state.hasLeader ? 1 : 0, state.createdAt, now);

  // member 模板：只重写班底行（team_id = 本队）；工作区公共模板行
  // （team_id 为空）不属于任何 TeamState，不经快照重写（见 loadMembers）。
  db.prepare('DELETE FROM member WHERE team_id = ?').run(teamId);
  const insMember = db.prepare(
    'INSERT INTO member (member_id, team_id, role_id, role_name, employee_id, persona_md, model, ' +
      'reasoning_effort, avatar, created_time, update_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const m of state.members) {
    const route = routeToColumns(m.modelRoute);
    insMember.run(
      m.memberId,
      teamId,
      roleIdOf(db, m.role),
      m.name,
      m.employeeId ?? null,
      personaToMd(m.persona, m.name),
      route.model,
      route.effort,
      avatarToJson(m.avatar),
      m.createdAt,
      now,
    );
  }

  // task：带原号重插（发号已由 wave-2 的分配步骤经 nextAutoincrementId 完成）；
  // current_member_id 暂不维护（内存模型无此字段，docs/27 松引用列）。
  db.prepare('DELETE FROM task WHERE team_id = ?').run(teamId);
  const insTask = db.prepare(
    'INSERT INTO task (task_id, team_id, parent_id, subject, description, depend_tasks, ' +
      'member_chain_list, chain_cursor, status, current_member, current_member_id, retry_count, ' +
      'status_note, contract_md, idempotency_note, ' +
      'blocked_from, work_dir, completed_time, created_time, update_time) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const t of state.tasks) {
    insTask.run(
      t.id,
      teamId,
      t.parentId,
      t.subject,
      t.description ?? null,
      JSON.stringify(t.dependencies),
      JSON.stringify(t.chain),
      t.chainCursor,
      t.status,
      t.assignee ?? null,
      t.retryCount,
      t.statusNote ?? null,
      t.contractMd ?? null,
      t.idempotencyNote ?? null,
      t.blockedFrom ?? null,
      t.workDir ?? null,
      t.completedAt ?? null,
      t.createdAt,
      t.updatedAt,
    );
  }

  // task_members 实例行（含领队行）：带原号；内存新建行（id = 0）发号回填。
  db.prepare('DELETE FROM task_members WHERE team_id = ?').run(teamId);
  for (const row of state.taskMembers) insertTaskMemberRow(tx, row);

  // attempts：任务执行的审计链，随任务一起整存整取。
  db.prepare('DELETE FROM attempts WHERE team_id = ?').run(teamId);
  const insAttempt = db.prepare(
    'INSERT INTO attempts (attempt_id, team_id, task_id, kind, member, status, token, ' +
      'station_index, progress, result_output, result_changed_paths, error, claimed_time, ' +
      'ended_time, created_time, update_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const t of state.tasks) {
    for (const a of t.attempts) {
      insAttempt.run(
        a.id,
        teamId,
        t.id,
        a.kind,
        a.member,
        a.status,
        a.token,
        a.stationIndex,
        JSON.stringify(a.progress),
        a.result?.output ?? null,
        a.result?.changedPaths !== undefined ? JSON.stringify(a.result.changedPaths) : null,
        a.error ?? null,
        a.claimedAt ?? null,
        a.endedAt ?? null,
        a.createdAt,
        a.endedAt ?? a.createdAt,
      );
    }
  }

  // decisions：只存 open 行（resolved 的处置结论已并入任务状态与事件流）。
  db.prepare('DELETE FROM decisions WHERE team_id = ?').run(teamId);
  const insDecision = db.prepare(
    'INSERT INTO decisions (decision_id, team_id, task_id, attempt_id, error, retry_count, ' +
      'status, choice, note, resolved_time, created_time, update_time) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const d of state.pendingDecisions) {
    insDecision.run(
      d.id,
      teamId,
      d.taskId,
      d.attemptId ?? null,
      d.error,
      d.retryCount,
      d.status,
      d.choice ?? null,
      d.note ?? null,
      d.resolvedAt ?? null,
      d.createdAt,
      d.resolvedAt ?? now,
    );
  }
}

/**
 * Persist the full snapshot in one transaction (DELETE + re-INSERT with the
 * original ids). Callers already inside `withTeamLock` that also record
 * events should open one `withTeamTx` and use `writeTeamInTx` + the events
 * in-transaction insert instead of stacking transactions.
 */
export async function writeTeam(stateRoot: string, state: TeamState): Promise<void> {
  withTeamTx(stateRoot, state.id, (tx) => writeTeamInTx(tx, state));
}

// --------------------------------------------------------------------------
// 发现端：团队列表 / 领队会话反查（docs/35 §5#2：领队锚点在 task_members
// 领队行上，has_leader 只作班底标记）。
// --------------------------------------------------------------------------

/** All team ids in the db (unsorted by name; id 升序稳定输出). */
export async function listTeamIds(stateRoot: string): Promise<number[]> {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const rows = db.prepare('SELECT team_id FROM team ORDER BY team_id').all() as Array<{
    team_id: number;
  }>;
  return rows.map((row) => row.team_id);
}

/** Load every team (UI listing; 最新更新在前，走 idx_team_update_time). */
export async function listTeams(stateRoot: string): Promise<TeamState[]> {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const rows = db
    .prepare('SELECT team_id FROM team ORDER BY update_time DESC')
    .all() as Array<{ team_id: number }>;
  const teams: TeamState[] = [];
  for (const row of rows) {
    const team = readTeamSync(stateRoot, row.team_id);
    if (team !== undefined) teams.push(team);
  }
  return teams;
}

/** The team currently led by one captain session, if any. */
export async function findTeamByCaptain(
  stateRoot: string,
  captainSessionId: string,
): Promise<TeamState | undefined> {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const row = db
    .prepare(
      'SELECT team_id FROM task_members WHERE name = ? AND main_task_id IS NULL ' +
        "AND main_session_id = ? AND status <> 'removed' LIMIT 1",
    )
    .get(LEADER_NAME, captainSessionId) as { team_id: number } | undefined;
  if (row === undefined) return undefined;
  return readTeamSync(stateRoot, row.team_id);
}
