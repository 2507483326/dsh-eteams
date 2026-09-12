/**
 * 跨团队只读聚合查询（docs/27 §27.7 查询场景 / docs/35 §6 面板附带交付）：
 * 纯 SELECT，走 WAL 读连接（`getDb`，面板 1 秒轮询不被写事务阻塞），不碰
 * 任何写路径与权限模型——GET /eteams-api/board 的唯一数据来源。
 *
 * 落地的 Q（docs/27 §27.7 编号）：
 * - Q1 团队列表（idx_team_update_time，update_time DESC）；
 * - Q3 大任务进度（idx_task_parent：每条大任务 N 个小任务 / 完成 M）；
 * - Q4 看板按状态分列（idx_task_status：四列 start/wait/paused/wait_user；
 *   ready 就绪待派单列一栏，不进四列——用户迭代 2026-09-11：精简后又恢复
 *   独立 wait（待领队分诊））；
 * - Q5 成员待派统计（idx_task_members_team，带 tm.team_id 过滤；v7 副本行
 *   建任务即全员在——聚合按工号成组，行数不当人数）；
 * - Q9 待决策横幅（idx_decisions_open，status='open'）。
 *
 * @module dsh-eteams/state/queries
 */
import type { DatabaseSync } from 'node:sqlite';
import { getDb } from './db.js';
import { ensureWorkspaceReady } from './import.js';

/** 看板列（Q4；ready 单列待派，不入本列）。用户迭代 2026-09-11：精简状态集
 * 后又恢复独立 `wait`（待领队分诊）——进看板列。 */
export type BoardColumnStatus = 'start' | 'wait' | 'paused' | 'wait_user';

/** 看板列头顺序（Q4 的 IN 列表顺序）。 */
export const BOARD_COLUMNS: readonly BoardColumnStatus[] = [
  'start',
  'wait',
  'paused',
  'wait_user',
];

/** 一行看板任务（Q4 SELECT 的 camelCase 投影）。 */
export interface BoardTaskRow {
  taskId: number;
  subject: string;
  status: string;
  /** 当前执行成员（task.current_member，松引用）。 */
  currentMember: string | null;
  /** 执行链站点数（member_chain_list 长度；无链任务 0）。 */
  chainLength: number;
  /** 链游标（-1=没开始；k=第 k 站完成）。 */
  chainCursor: number;
  updatedAt: number;
}

/** 一条大任务进度（Q3）。 */
export interface BoardGroupProgress {
  taskId: number;
  subject: string;
  /** 已完成小任务数。 */
  done: number;
  /** 小任务总数。 */
  total: number;
}

/** 一行成员待派（Q5 按工号聚合后的口径）。 */
export interface BoardMemberRow {
  name: string;
  /** 班底工号（v7 身份键；孤儿副本行 NULL——按名兜底成组）。 */
  employeeId: number | null;
  /** 该成员当前承担的活跃任务数（start/wait/paused/wait_user）。 */
  activeTasks: number;
  /** 是否领队（v8 按标识：组内含 is_leader=1 的行——不再按主持行判据）。 */
  isLeader: boolean;
}

/** 一行待决策（Q9）。 */
export interface BoardDecisionRow {
  decisionId: number;
  taskId: number;
  error: string;
  retryCount: number;
  createdAt: number;
}

/** 一支团队的面板聚合视图（GET /eteams-api/board 的每团队行）。 */
export interface BoardTeamSummary {
  teamId: number;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 就绪待派单列（Q4 注：ready 不进看板五列；任务单容器行不进本列——
   * 容器不可派单，进度走 groups）。 */
  ready: BoardTaskRow[];
  /** 看板五列（Q4）。 */
  columns: Record<BoardColumnStatus, BoardTaskRow[]>;
  /** 大任务进度列表（Q3，逐条大任务）。 */
  groups: BoardGroupProgress[];
  /** 成员待派统计（Q5，按名去重；领队行含其中并带 isLeader 标记）。 */
  members: BoardMemberRow[];
  /** 开放决策（Q9，created_time 升序）。 */
  decisions: BoardDecisionRow[];
}

/** task 行 → 看板任务行（member_chain_list JSON 解析只取长度）。 */
function taskRowOf(row: {
  task_id: number;
  subject: string;
  status: string;
  current_member: string | null;
  member_chain_list: string;
  chain_cursor: number;
  update_time: number;
}): BoardTaskRow {
  let chainLength = 0;
  try {
    const chain: unknown = JSON.parse(row.member_chain_list);
    if (Array.isArray(chain)) chainLength = chain.length;
  } catch {
    // 坏 JSON 按无链处理（写入代码保证合法，此处只兜底）
  }
  return {
    taskId: row.task_id,
    subject: row.subject,
    status: row.status,
    currentMember: row.current_member,
    chainLength,
    chainCursor: row.chain_cursor,
    updatedAt: row.update_time,
  };
}

/** 大任务进度计数（Q3 原文：N 个小任务 / 完成 M）。 */
export function groupProgress(
  db: DatabaseSync,
  teamId: number,
  parentId: number,
): { done: number; total: number } {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS total, COALESCE(SUM(status = 'completed'), 0) AS done " +
        'FROM task WHERE team_id = ?1 AND parent_id = ?2',
    )
    .get(teamId, parentId) as { total: number; done: number };
  return { done: Number(row.done) || 0, total: Number(row.total) || 0 };
}

/** 一支团队的面板聚合（Q3/Q4/Q5/Q9；只读连接）。 */
export function boardTeam(db: DatabaseSync, teamId: number): BoardTeamSummary {
  const team = db
    .prepare('SELECT team_id, team_name, created_time, update_time FROM team WHERE team_id = ?1')
    .get(teamId) as
    | { team_id: number; team_name: string; created_time: number; update_time: number }
    | undefined;
  if (team === undefined) throw new Error(`团队 ${teamId} 不存在`);
  // Q4 + ready 单列：两查一排（update_time DESC），按状态归桶。
  const rows = db
    .prepare(
      "SELECT task_id, subject, status, current_member, member_chain_list, chain_cursor, update_time " +
        "FROM task WHERE team_id = ?1 AND status IN ('ready','start','wait','paused','wait_user') " +
        'ORDER BY update_time DESC',
    )
    .all(teamId) as Array<Parameters<typeof taskRowOf>[0]>;
  const ready: BoardTaskRow[] = [];
  const columns: Record<BoardColumnStatus, BoardTaskRow[]> = {
    start: [],
    wait: [],
    paused: [],
    wait_user: [],
  };
  // Q3：逐条大任务聚合（大任务行 + 各自的小任务进度计数）。先取容器行
  // （有子任务的大任务行——独立无子任务也是 parent_id 空，但它是可派单
  // 任务，不排除），分列时排除容器行——任务单（group 容器）不可派单，
  // 进 Q3 进度卡即可，不占 ready/五列看板位。
  const parents = db
    .prepare(
      'SELECT task_id, subject FROM task WHERE team_id = ?1 AND parent_id IS NULL ORDER BY created_time',
    )
    .all(teamId) as Array<{ task_id: number; subject: string }>;
  const containers = new Set(
    (
      db
        .prepare(
          'SELECT DISTINCT parent_id AS pid FROM task WHERE team_id = ?1 AND parent_id IS NOT NULL',
        )
        .all(teamId) as Array<{ pid: number }>
    ).map((r) => Number(r.pid)),
  );
  for (const row of rows) {
    if (containers.has(Number(row.task_id))) continue;
    const view = taskRowOf(row);
    if (view.status === 'ready') ready.push(view);
    else if (BOARD_COLUMNS.includes(view.status as BoardColumnStatus))
      columns[view.status as BoardColumnStatus].push(view);
  }
  const groups: BoardGroupProgress[] = parents.map((p) => ({
    taskId: Number(p.task_id),
    subject: p.subject,
    ...groupProgress(db, teamId, Number(p.task_id)),
  }));
  // Q5（带 tm.team_id 过滤）：v7 副本行建任务即全员在、且允许同名成员——
  // 按工号成组（孤儿副本无号按名兜底）；活跃任务数与行解耦：按副本行 id
  // 归属（attempts.task_member_id）对活跃状态任务一次分组计数，成组行直接
  // 查表——若按名字统计，同名成员会互相放大。领队判定按 is_leader 标识
  // （v8：领队行=1，不再按主持行判据）。
  const memberRows = db
    .prepare(
      'SELECT tm.task_member_id AS rid, tm.employee_id AS eid, tm.name, tm.is_leader AS isldr ' +
        'FROM task_members tm ' +
        'WHERE tm.team_id = ?1 ORDER BY tm.task_member_id',
    )
    .all(teamId) as Array<{
    rid: number;
    eid: number | null;
    name: string;
    isldr: number;
  }>;
  const activeByRow = new Map<number, number>();
  for (const row of db
    .prepare(
      "SELECT a.task_member_id AS rid, COUNT(DISTINCT a.task_id) AS active_tasks FROM attempts a " +
        "JOIN task t ON t.task_id = a.task_id " +
        "WHERE a.team_id = ?1 AND a.task_member_id IS NOT NULL " +
        "AND t.status IN ('start','wait','paused','wait_user') " +
        'GROUP BY a.task_member_id',
    )
    .all(teamId) as Array<{ rid: number; active_tasks: number }>) {
    activeByRow.set(Number(row.rid), Number(row.active_tasks) || 0);
  }
  const members: BoardMemberRow[] = [];
  const groupKeyOf = (eid: number | null, name: string): string =>
    eid !== null ? `et:${eid}` : `name:${name}`;
  for (const row of memberRows) {
    const key = groupKeyOf(row.eid === null ? null : Number(row.eid), row.name);
    const existing = members.find((m) => groupKeyOf(m.employeeId, m.name) === key);
    if (existing === undefined) {
      members.push({
        name: row.name,
        ...(row.eid !== null ? { employeeId: Number(row.eid) } : { employeeId: null }),
        activeTasks: activeByRow.get(Number(row.rid)) ?? 0,
        isLeader: row.isldr === 1,
      });
    } else {
      if (row.isldr === 1) existing.isLeader = true;
      existing.activeTasks += activeByRow.get(Number(row.rid)) ?? 0;
    }
  }
  // Q9：开放决策横幅。
  const decisions = (
    db
      .prepare(
        "SELECT decision_id, task_id, error, retry_count, created_time FROM decisions " +
          "WHERE team_id = ?1 AND status = 'open' ORDER BY created_time",
      )
      .all(teamId) as Array<{
      decision_id: number;
      task_id: number;
      error: string;
      retry_count: number;
      created_time: number;
    }>
  ).map((d) => ({
    decisionId: d.decision_id,
    taskId: d.task_id,
    error: d.error,
    retryCount: d.retry_count,
    createdAt: d.created_time,
  }));
  return {
    teamId: team.team_id,
    name: team.team_name,
    createdAt: team.created_time,
    updatedAt: team.update_time,
    ready,
    columns,
    groups,
    members,
    decisions,
  };
}

/** Q1 团队列表（update_time DESC）→ 逐团队聚合（boardTeam）。 */
export function boardOverview(stateRoot: string): BoardTeamSummary[] {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const ids = db
    .prepare('SELECT team_id FROM team ORDER BY update_time DESC')
    .all() as Array<{ team_id: number }>;
  return ids.map((row) => boardTeam(db, Number(row.team_id)));
}