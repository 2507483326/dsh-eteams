/**
 * 跨团队只读聚合查询（docs/27 §27.7 查询场景 / docs/35 §6 面板附带交付）：
 * 纯 SELECT，走 WAL 读连接（`getDb`，面板 1 秒轮询不被写事务阻塞），不碰
 * 任何写路径与权限模型——GET /eteams-api/board 的唯一数据来源。
 *
 * 落地的 Q（docs/27 §27.7 编号）：
 * - Q1 团队列表（idx_team_update_time，update_time DESC）；
 * - Q3 大任务进度（idx_task_parent：每条大任务 N 个小任务 / 完成 M）；
 * - Q4 看板按状态分列（idx_task_status：五列 wait/start/paused/
 *   wait_decision/wait_user；ready 就绪待派单列一栏，不进五列）；
 * - Q5 成员待派统计（idx_task_members_team，带 tm.team_id 过滤；同一人
 *   每条大任务一行实例行——聚合按名去重，行数不当人数，docs/35 §5#12）；
 * - Q9 待决策横幅（idx_decisions_open，status='open'）。
 *
 * @module dsh-eteams/state/queries
 */
import type { DatabaseSync } from 'node:sqlite';
import { getDb, LEADER_NAME } from './db.js';
import { ensureWorkspaceReady } from './import.js';

/** 看板五列（Q4；ready 单列待派，不入本列）。 */
export type BoardColumnStatus = 'wait' | 'start' | 'paused' | 'wait_decision' | 'wait_user';

/** 看板列头顺序（Q4 的 IN 列表顺序）。 */
export const BOARD_COLUMNS: readonly BoardColumnStatus[] = [
  'wait',
  'start',
  'paused',
  'wait_decision',
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

/** 一行成员待派（Q5 按名聚合后的口径）。 */
export interface BoardMemberRow {
  name: string;
  /** 聚合成员状态（任一实例行 working 即 working，其次 paused）。 */
  status: string;
  /** 该成员当前承担的活跃任务数（wait/start/paused/wait_decision/wait_user）。 */
  activeTasks: number;
  /** 是否领队行（项目牧羊人）。 */
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
        "FROM task WHERE team_id = ?1 AND status IN ('ready','wait','start','paused','wait_decision','wait_user') " +
        'ORDER BY update_time DESC',
    )
    .all(teamId) as Array<Parameters<typeof taskRowOf>[0]>;
  const ready: BoardTaskRow[] = [];
  const columns: Record<BoardColumnStatus, BoardTaskRow[]> = {
    wait: [],
    start: [],
    paused: [],
    wait_decision: [],
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
  // Q5（带 tm.team_id 过滤）：一行 = 一个实例行（同一人每条大任务一行）——
  // 按名去重聚合：状态取「working 优先，其次 paused，再次首行」。活跃任务数
  // 与行解耦（行数不当人数，docs/35 §5#12）：按 current_member 一次分组计数，
  // 去重行直接查表——若把按名子查询随行累加，多行成员会被行数放大。
  const memberRows = db
    .prepare(
      'SELECT tm.name, tm.status FROM task_members tm ' +
        'WHERE tm.team_id = ?1 AND tm.status <> ?2 ORDER BY tm.name',
    )
    .all(teamId, 'removed') as Array<{ name: string; status: string }>;
  const activeByName = new Map<string, number>();
  for (const row of db
    .prepare(
      "SELECT current_member AS name, COUNT(*) AS active_tasks FROM task " +
        "WHERE team_id = ?1 AND current_member IS NOT NULL " +
        "AND status IN ('wait','start','paused','wait_decision','wait_user') GROUP BY current_member",
    )
    .all(teamId) as Array<{ name: string; active_tasks: number }>) {
    activeByName.set(String(row.name), Number(row.active_tasks) || 0);
  }
  const members: BoardMemberRow[] = [];
  for (const row of memberRows) {
    const existing = members.find((m) => m.name === row.name);
    if (existing === undefined) {
      members.push({
        name: row.name,
        status: row.status,
        activeTasks: activeByName.get(row.name) ?? 0,
        isLeader: row.name === LEADER_NAME,
      });
    } else {
      if (row.status === 'working' && existing.status !== 'working') existing.status = 'working';
      else if (row.status === 'paused' && existing.status !== 'working' && existing.status !== 'paused')
        existing.status = 'paused';
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