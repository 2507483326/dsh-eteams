/**
 * capability_gaps / routing_memos 读写（v16）：子代理**能力缺口**（被拒之后的
 * 结构化上报）与**常设路线**（一次结构决定的沉淀）。
 *
 * 位置说明（docs/subagentCapabilityGap.md）：子代理撞到「换做法也过不去」的
 * 拒绝时落一行缺口，供领队做**结构性**决定（代执行 / 放宽后重派 / 拆站），而
 * 不是为单次操作求许可——DSH 的审批策略对 in-process 子代理钉死 `never`，任何
 * 消息都注入不进 `allowed-once`，所以「求许可」这条路不存在，只有「别人来干」。
 *
 * 两条硬纪律（安全相关，改动前先读 docs/subagentCapabilityGap.md）：
 * 1. **`high` 风险缺口永不落表、永不升级。** 涉及把当前信任边界内的数据送出去
 *    的操作一律 `refuse`，不请人类拍板（写入层兜底拒绝，见 assertStorable）。
 * 2. **路线备忘不是授权。** 它只回答「这类活儿以后谁干」，执行侧读到它的动作是
 *    「按既定路线转交」而非「放行」；`operation_class` 只能由
 *    {@link operationClassOf} 归一产出，不接受模型自由书写的通配串。
 *
 * 写路径两形态（同 events.ts）：随动写走 `*InTx` 并入调用方的 `withTeamTx`
 * （「改派 + 记路线」必须原子），独立事务走 `*Sync` 直写助手。本表的行**不随
 * TeamState 整存整取重写**（缺口是执行期随时产生的，不能连坐团队写）。
 *
 * @module dsh-eteams/state/gaps
 */
import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { ensureWorkspaceReady } from './import.js';
import type { TeamTx } from './store.js';

// --------------------------------------------------------------------------
// 词汇（与分级提示词同源：改这里要同步改分级口径的落点）
// --------------------------------------------------------------------------

/** 风险分级：`high` 一律 refuse——绝不落表、绝不升级。 */
export type GapRisk = 'medium' | 'high';

/**
 * 结构性路线。**只有前两种能让活儿真正干成**；第三种是循环型工作（构建/测试）
 * 的正解——把整个循环挪到有权限的一侧，而不是逐次代执行（往返成本会吃掉收益）。
 */
export type GapRoute = 'main-executes' | 'widen-and-redelegate' | 'split-stage';

/** 全部合法路线（校验用）。 */
export const GAP_ROUTES: readonly GapRoute[] = [
  'main-executes',
  'widen-and-redelegate',
  'split-stage',
];

/** 缺口生命周期：open → routed → resolved | refused | expired（后三者为终态）。 */
export type GapStatus = 'open' | 'routed' | 'resolved' | 'refused' | 'expired';

/** 路线决定者：领队自定（不必问人）或用户拍板。 */
export type GapDecidedBy = 'captain' | 'user';

/**
 * 操作块。**分「给人读的说明」与「可执行的精确命令」两栏**——两栏都由上报方
 * 填写，宿主的职责是把它们分开存、分开用：
 *
 * - `summary` / `writes` 只给人读（面板、问询的选项描述），**绝不**参与构造命令；
 * - `argv` / `cwd` 是结构化、可原样交给执行侧的命令与环境，也是路线键归一的输入。
 *
 * 为什么必须分开（混淆代理防线）：子代理不能靠一段**说明**让宽权限的一侧执行任意
 * 串。执行侧看到的是这条精确命令本身，可以据此判断「这能不能做」；若只有一段散文，
 * 判断就退化成「相信子代理的描述」。
 *
 * 注意口径：宿主只校验这两个字段的**形状**（非空、无换行），**不校验真伪**——
 * 它们是上报方填的。此处保证的是「精确、可原样执行、可审计」，不是「可信」。
 */
export interface GapOperation {
  /** 给人读：一句话说明想做什么（不参与构造命令）。 */
  summary: string;
  /** 可执行：精确 argv（代执行**只**按它构造命令；路线键也由它归一）。 */
  argv: string[];
  /** 可执行：执行时的工作目录。 */
  cwd: string;
  /** 给人读：预期副作用（参考，不作授权依据）。 */
  writes?: string[];
  /** 拒绝来源标记（approval / sandbox / tool）。 */
  reason: string;
}

/** 一条能力缺口（capability_gaps 行的内存形状）。 */
export interface CapabilityGapRecord {
  gapId: string;
  teamId: number;
  taskId?: number;
  attemptId?: number;
  /** 上报子代理会话 ID（来源，面板定位）。 */
  askingSessionId: string;
  askingName: string;
  /** 执行链站点下标（领队据此判「这一站的固定需求」还是偶发）。 */
  stationIndex?: number;
  risk: GapRisk;
  operation: GapOperation;
  /** 挂钩哪条验收标准（未挂钩不入库——否则「我觉得需要」会变成特权的滑坡）。 */
  why: string;
  /** 已试替代（分级判 self-resolvable 失败后的残余）。 */
  tried?: string[];
  /** 模型建议路线（领队/人类可推翻）。 */
  suggestedRoute?: GapRoute;
  status: GapStatus;
  route?: GapRoute;
  routeNote?: string;
  decidedBy?: GapDecidedBy;
  decidedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** 一次结构决定（写入路由栏的那组字段）。 */
export interface GapRouteDecision {
  route: GapRoute;
  /** 决定理由 / 用户原话。 */
  note?: string;
  decidedBy: GapDecidedBy;
  /** 决定时刻（缺省用当前时刻）。 */
  decidedAt?: number;
}

/** 一条常设路线备忘（routing_memos 行的内存形状）。 */
export interface RoutingMemoRecord {
  memoId: number;
  teamId: number;
  /** 相关任务；undefined = 团队级路线（作用域更宽，命中时优先级更低）。 */
  taskId?: number;
  /** 宿主归一的操作类（`<workspaceRoot>::<base>::<args>`）。 */
  operationClass: string;
  route: GapRoute;
  note?: string;
  decidedBy: GapDecidedBy;
  /** 来源缺口（可追溯「谁在什么时候定的」）。 */
  gapId?: string;
  createdAt: number;
  /** 到期时刻；undefined = 不自动过期（随任务收口清理）。 */
  expiresAt?: number;
  updatedAt: number;
}

// --------------------------------------------------------------------------
// 操作类归一（安全关键：路线键只能由这里产出，绝不接受模型自由书写的模式串）
// --------------------------------------------------------------------------

/**
 * 会执行任意代码的基命令：这类命令的路线键取**精确 argv**，不给「基命令 + 首
 * 参数」的前缀（`npm run build` 与 `npm run test` 是两个不同的键——脚本内容是
 * 任意的，前缀会把它放大成一批操作的通行证）。与 Claude Code 的
 * 「bases that run arbitrary code persist the exact command, not a prefix」同口径。
 */
const ARBITRARY_CODE_BASES: ReadonlySet<string> = new Set([
  'bash',
  'bun',
  'cargo',
  'cmd',
  'curl',
  'deno',
  'docker',
  'dotnet',
  'go',
  'java',
  'make',
  'node',
  'npm',
  'npx',
  'perl',
  'php',
  'pip',
  'pip3',
  'pnpm',
  'podman',
  'powershell',
  'pwsh',
  'python',
  'python3',
  'ruby',
  'scp',
  'sh',
  'ssh',
  'wget',
  'yarn',
  'zsh',
]);

/**
 * 工作区根归一（宿主口径）：反斜杠折成正斜杠、去尾斜杠、整体小写。同一工程下
 * 从不同子目录发起的同一操作必须落同一个键，否则路线会因 cwd 差异而漏命中。
 */
export function normalizeWorkspaceRoot(root: string): string {
  const slashed = root.trim().replace(/\\/g, '/');
  const trimmed = slashed.endsWith('/') ? slashed.slice(0, -1) : slashed;
  return trimmed.toLowerCase();
}

/** 取 argv[0] 的基命令名：剥路径、剥扩展名、小写。 */
function commandBase(program: string): string {
  const withoutPath = program.replace(/\\/g, '/').split('/').pop() ?? program;
  const withoutExt = withoutPath.replace(/\.(exe|cmd|bat|ps1|com)$/i, '');
  return withoutExt.toLowerCase();
}

/**
 * 把一次精确调用归一成路线键：`<workspaceRoot>::<base>::<argsKey>`。
 * `argsKey` 对任意代码基命令取完整 argv（含归一后的基命令名），其余取首个
 * 非选项参数。
 *
 * 归一而非原样：`C:/tools/Node.EXE x` 与 `node x` 必须落同一个键，否则同一
 * 条命令换个调用路径就漏命中，路线等于白记。
 *
 * 唯一入口——调用方**只**传宿主已知的 argv 与工作区根，模型无从提供模式串。
 */
export function operationClassOf(argv: readonly string[], workspaceRoot: string): string {
  const base = commandBase(argv[0] ?? '');
  const argsKey = ARBITRARY_CODE_BASES.has(base)
    ? [base, ...argv.slice(1)].join(' ')
    : (argv.slice(1).find((a) => !a.startsWith('-')) ?? '');
  return `${normalizeWorkspaceRoot(workspaceRoot)}::${base}::${argsKey}`;
}

/** 路线键形状守卫：非空、含三段分隔、无通配符（防手工行或未来代码路径注入模式）。 */
export function isNormalizedOperationClass(value: string): boolean {
  return value !== '' && value.includes('::') && !/[*?[\]]/.test(value);
}

// --------------------------------------------------------------------------
// 缺口写入
// --------------------------------------------------------------------------

/** Fresh gap_id（uuid；调用方生成后随 insert 落库，主键即幂等键）。 */
export function newGapId(): string {
  return randomUUID();
}

/**
 * 落表前的兜底闸：`high` 风险与未挂钩验收标准的缺口一律拒绝入库。
 * 分级提示词已经这么要求，这里再拦一道——提示词是模型行为，这里是代码行为。
 */
function assertStorable(record: CapabilityGapRecord): void {
  if (record.risk === 'high') {
    throw new Error('high 风险缺口不得落表：一律 refuse，不请人类授权外泄类操作');
  }
  if (record.why.trim() === '') {
    throw new Error('缺口必须挂钩验收标准（why 非空）——未挂钩的「我觉得需要」不上报');
  }
  if (record.operation.argv.length === 0) {
    throw new Error('缺口必须带可执行的精确 argv（代执行只按它构造命令）');
  }
}

function insertGapSql(db: TeamTx['db'], record: CapabilityGapRecord, now: number): void {
  db.prepare(
    'INSERT INTO capability_gaps (gap_id, team_id, task_id, attempt_id, asking_session_id, ' +
      'asking_name, station_index, risk, operation, why, tried, suggested_route, status, ' +
      'route, route_note, decided_by, decided_time, created_time, update_time) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    record.gapId,
    record.teamId,
    record.taskId ?? null,
    record.attemptId ?? null,
    record.askingSessionId,
    record.askingName,
    record.stationIndex ?? null,
    record.risk,
    JSON.stringify(record.operation),
    record.why,
    record.tried !== undefined ? JSON.stringify(record.tried) : null,
    record.suggestedRoute ?? null,
    record.status,
    record.route ?? null,
    record.routeNote ?? null,
    record.decidedBy ?? null,
    record.decidedAt ?? null,
    record.createdAt,
    now,
  );
}

/** 事务内落一条缺口（随动写：并入调用方的 withTeamTx）。 */
export function insertGapInTx(tx: TeamTx, record: CapabilityGapRecord): void {
  assertStorable(record);
  insertGapSql(tx.db, record, tx.now);
}

/** 独立事务落一条缺口（缺省由调用方生成 gap_id / createdAt）。 */
export function insertGapSync(stateRoot: string, record: CapabilityGapRecord): void {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  assertStorable(record);
  insertGapSql(db, record, Date.now());
}

/**
 * 路由栏写入（open → routed）：`WHERE status = 'open'` 保证**先决者胜**——
 * 领队自定路线与用户弹窗作答可能同时到达，第二个写入静默落空（同
 * answerAskSync 的竞态口径）。
 *
 * 两个形态都**返回是否赢下这一格**。调用方必须看返回值再决定后续动作（例如
 * 「赢了才去沉淀常设路线」）——否则输家也会写出一条与缺口不符的路线。
 */
const ROUTE_COLUMNS = 'route = ?, route_note = ?, decided_by = ?, decided_time = ?, status = ?';

/** 事务内下路线决定（open → routed；「改派 + 记路线」必须同事务时用）。
 * @returns 是否赢下这一格（false = 已被别人处置）。 */
export function setGapRouteInTx(tx: TeamTx, gapId: string, decision: GapRouteDecision): boolean {
  const info = tx.db
    .prepare(
      `UPDATE capability_gaps SET ${ROUTE_COLUMNS}, update_time = ? WHERE gap_id = ? AND status = 'open'`,
    )
    .run(
      decision.route,
      decision.note ?? null,
      decision.decidedBy,
      decision.decidedAt ?? tx.now,
      'routed',
      tx.now,
      gapId,
    );
  return Number(info.changes) > 0;
}

/** 独立事务下路线决定。@returns 是否赢下这一格（false = 已被别人处置）。 */
export function setGapRouteSync(
  stateRoot: string,
  gapId: string,
  decision: GapRouteDecision,
): boolean {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const now = Date.now();
  const info = db
    .prepare(
      `UPDATE capability_gaps SET ${ROUTE_COLUMNS}, update_time = ? WHERE gap_id = ? AND status = 'open'`,
    )
    .run(
      decision.route,
      decision.note ?? null,
      decision.decidedBy,
      decision.decidedAt ?? now,
      'routed',
      now,
      gapId,
    );
  return Number(info.changes) > 0;
}

/** 终态收尾（routed/open → resolved | refused | expired；终态不可再迁移）。 */
export function setGapEndedSync(
  stateRoot: string,
  gapId: string,
  status: Extract<GapStatus, 'resolved' | 'refused' | 'expired'>,
  note?: string,
): void {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  db.prepare(
    'UPDATE capability_gaps SET status = ?, route_note = COALESCE(?, route_note), update_time = ? ' +
      "WHERE gap_id = ? AND status IN ('open', 'routed')",
  ).run(status, note ?? null, Date.now(), gapId);
}

// --------------------------------------------------------------------------
// 缺口读取
// --------------------------------------------------------------------------

const GAP_SELECT =
  'SELECT gap_id, team_id, task_id, attempt_id, asking_session_id, asking_name, station_index, ' +
  'risk, operation, why, tried, suggested_route, status, route, route_note, decided_by, ' +
  'decided_time, created_time, update_time FROM capability_gaps';

/** 坏 JSON 容错读（读端永不炸；operation 解析失败按空操作块装回）。 */
function rowToGap(row: Record<string, unknown>): CapabilityGapRecord {
  let operation: GapOperation = { summary: '', argv: [], cwd: '', reason: '' };
  try {
    const parsed = JSON.parse(String(row['operation'])) as unknown;
    if (parsed !== null && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>;
      operation = {
        summary: typeof o['summary'] === 'string' ? o['summary'] : '',
        argv: Array.isArray(o['argv'])
          ? o['argv'].filter((a): a is string => typeof a === 'string')
          : [],
        cwd: typeof o['cwd'] === 'string' ? o['cwd'] : '',
        ...(Array.isArray(o['writes'])
          ? { writes: o['writes'].filter((w): w is string => typeof w === 'string') }
          : {}),
        reason: typeof o['reason'] === 'string' ? o['reason'] : '',
      };
    }
  } catch {
    // 保持空操作块
  }
  let tried: string[] | undefined;
  if (row['tried'] !== null && row['tried'] !== undefined) {
    try {
      const parsed = JSON.parse(String(row['tried'])) as unknown;
      if (Array.isArray(parsed)) tried = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      tried = undefined;
    }
  }
  const num = (key: string): number | undefined =>
    row[key] !== null && row[key] !== undefined ? Number(row[key]) : undefined;
  const str = (key: string): string | undefined =>
    row[key] !== null && row[key] !== undefined ? String(row[key]) : undefined;
  return {
    gapId: String(row['gap_id']),
    teamId: Number(row['team_id']),
    ...(num('task_id') !== undefined ? { taskId: num('task_id') } : {}),
    ...(num('attempt_id') !== undefined ? { attemptId: num('attempt_id') } : {}),
    askingSessionId: String(row['asking_session_id']),
    askingName: String(row['asking_name']),
    ...(num('station_index') !== undefined ? { stationIndex: num('station_index') } : {}),
    risk: row['risk'] as GapRisk,
    operation,
    why: String(row['why']),
    ...(tried !== undefined ? { tried } : {}),
    ...(str('suggested_route') !== undefined
      ? { suggestedRoute: str('suggested_route') as GapRoute }
      : {}),
    status: row['status'] as GapStatus,
    ...(str('route') !== undefined ? { route: str('route') as GapRoute } : {}),
    ...(str('route_note') !== undefined ? { routeNote: str('route_note') } : {}),
    ...(str('decided_by') !== undefined ? { decidedBy: str('decided_by') as GapDecidedBy } : {}),
    ...(num('decided_time') !== undefined ? { decidedAt: num('decided_time') } : {}),
    createdAt: Number(row['created_time']),
    updatedAt: Number(row['update_time']),
  };
}

/** 按 gap_id 读一条（缺失返回 undefined）。 */
export function readGapSync(stateRoot: string, gapId: string): CapabilityGapRecord | undefined {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const row = db.prepare(`${GAP_SELECT} WHERE gap_id = ?`).get(gapId) as
    Record<string, unknown> | undefined;
  return row !== undefined ? rowToGap(row) : undefined;
}

/** 团队内待处置缺口（status='open'，创建升序；看板「能力缺口」数据源）。 */
export function readOpenGapsSync(stateRoot: string, teamId: number): CapabilityGapRecord[] {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const rows = db
    .prepare(`${GAP_SELECT} WHERE team_id = ? AND status = 'open' ORDER BY created_time, gap_id`)
    .all(teamId) as Array<Record<string, unknown>>;
  return rows.map(rowToGap);
}

/**
 * 某任务的缺口（含已定路线者——领队判「同一站点反复出同类缺口」要看历史，
 * 只看 open 会漏掉刚被处置的那些）。
 */
export function readGapsByTaskSync(
  stateRoot: string,
  teamId: number,
  taskId: number,
): CapabilityGapRecord[] {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const rows = db
    .prepare(`${GAP_SELECT} WHERE team_id = ? AND task_id = ? ORDER BY created_time, gap_id`)
    .all(teamId, taskId) as Array<Record<string, unknown>>;
  return rows.map(rowToGap);
}

/** 全库待处置缺口（诊断/运维读端）。 */
export function readAllOpenGapsSync(stateRoot: string): CapabilityGapRecord[] {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const rows = db
    .prepare(`${GAP_SELECT} WHERE status = 'open' ORDER BY created_time, gap_id`)
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToGap);
}

// --------------------------------------------------------------------------
// 常设路线（routing_memos）
// --------------------------------------------------------------------------

/** 路线写入前的兜底闸：路线合法、键已归一、决定者必须有出处。 */
function assertMemoStorable(memo: RoutingMemoRecord): void {
  if (!GAP_ROUTES.includes(memo.route)) {
    throw new Error(`非法路线「${String(memo.route)}」：只接受 ${GAP_ROUTES.join(' / ')}`);
  }
  if (!isNormalizedOperationClass(memo.operationClass)) {
    throw new Error(
      `路线键必须由 operationClassOf 归一产出（含 :: 分隔、无通配）：${memo.operationClass}`,
    );
  }
  if (memo.decidedBy !== 'captain' && memo.decidedBy !== 'user') {
    throw new Error('路线必须有出处（decidedBy = captain / user）');
  }
}

/**
 * 事务内 upsert 一条路线。唯一性 (team_id, task_id, operation_class) 由本函数
 * 保证（本设计不用 UNIQUE 约束，且 task_id 可空——NULL 在 SQL 里互不相等，
 * 交给约束也不可靠）。
 */
export function upsertRoutingMemoInTx(tx: TeamTx, memo: RoutingMemoRecord): number {
  assertMemoStorable(memo);
  const existing = findMemoRow(tx.db, memo);
  if (existing !== undefined) {
    tx.db
      .prepare(
        'UPDATE routing_memos SET route = ?, note = ?, decided_by = ?, gap_id = ?, ' +
          'expire_time = ?, update_time = ? WHERE memo_id = ?',
      )
      .run(
        memo.route,
        memo.note ?? null,
        memo.decidedBy,
        memo.gapId ?? null,
        memo.expiresAt ?? null,
        tx.now,
        existing,
      );
    return existing;
  }
  const info = tx.db
    .prepare(
      'INSERT INTO routing_memos (team_id, task_id, operation_class, route, note, decided_by, ' +
        'gap_id, created_time, expire_time, update_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      memo.teamId,
      memo.taskId ?? null,
      memo.operationClass,
      memo.route,
      memo.note ?? null,
      memo.decidedBy,
      memo.gapId ?? null,
      memo.createdAt,
      memo.expiresAt ?? null,
      tx.now,
    );
  return Number(info.lastInsertRowid);
}

/** 独立事务 upsert 一条路线。 */
export function upsertRoutingMemoSync(stateRoot: string, memo: RoutingMemoRecord): number {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  assertMemoStorable(memo);
  const existing = findMemoRow(db, memo);
  const now = Date.now();
  if (existing !== undefined) {
    db.prepare(
      'UPDATE routing_memos SET route = ?, note = ?, decided_by = ?, gap_id = ?, ' +
        'expire_time = ?, update_time = ? WHERE memo_id = ?',
    ).run(
      memo.route,
      memo.note ?? null,
      memo.decidedBy,
      memo.gapId ?? null,
      memo.expiresAt ?? null,
      now,
      existing,
    );
    return existing;
  }
  const info = db
    .prepare(
      'INSERT INTO routing_memos (team_id, task_id, operation_class, route, note, decided_by, ' +
        'gap_id, created_time, expire_time, update_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      memo.teamId,
      memo.taskId ?? null,
      memo.operationClass,
      memo.route,
      memo.note ?? null,
      memo.decidedBy,
      memo.gapId ?? null,
      memo.createdAt,
      memo.expiresAt ?? null,
      now,
    );
  return Number(info.lastInsertRowid);
}

/** 查同作用域同键的既有行（唯一性由代码保证，见 upsert 注释）。 */
function findMemoRow(db: TeamTx['db'], memo: RoutingMemoRecord): number | undefined {
  const row = db
    .prepare(
      'SELECT memo_id FROM routing_memos WHERE team_id = ? AND operation_class = ? ' +
        'AND task_id IS ? LIMIT 1',
    )
    .get(memo.teamId, memo.operationClass, memo.taskId ?? null) as { memo_id: number } | undefined;
  return row !== undefined ? Number(row.memo_id) : undefined;
}

function memoRowToRecord(row: Record<string, unknown>): RoutingMemoRecord {
  const str = (key: string): string | undefined =>
    row[key] !== null && row[key] !== undefined ? String(row[key]) : undefined;
  const taskId =
    row['task_id'] !== null && row['task_id'] !== undefined ? Number(row['task_id']) : undefined;
  const expiresAt =
    row['expire_time'] !== null && row['expire_time'] !== undefined
      ? Number(row['expire_time'])
      : undefined;
  return {
    memoId: Number(row['memo_id']),
    teamId: Number(row['team_id']),
    ...(taskId !== undefined ? { taskId } : {}),
    operationClass: String(row['operation_class']),
    route: row['route'] as GapRoute,
    ...(str('note') !== undefined ? { note: str('note') } : {}),
    decidedBy: row['decided_by'] as GapDecidedBy,
    ...(str('gap_id') !== undefined ? { gapId: str('gap_id') } : {}),
    createdAt: Number(row['created_time']),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    updatedAt: Number(row['update_time']),
  };
}

const MEMO_SELECT =
  'SELECT memo_id, team_id, task_id, operation_class, route, note, decided_by, gap_id, ' +
  'created_time, expire_time, update_time FROM routing_memos';

/**
 * 命中常设路线：同团队 + 同操作类，作用域取「本任务」或「团队级」两者，未过期。
 * 任务级优先于团队级（作用域更紧的先赢），同级取最近写入。
 *
 * **返回值的含义是「按这条路线转交」，不是「放行」**——调用方不得据此跳过任何
 * 权限判断（本表不携带、也无法授予任何权限）。
 */
export function resolveRoutingMemoSync(
  stateRoot: string,
  teamId: number,
  taskId: number | undefined,
  operationClass: string,
): RoutingMemoRecord | undefined {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const now = Date.now();
  // 过期过滤交给 SQL（expire_time IS NULL = 不自动过期）；作用域匹配在代码里做，
  // 免得踩 SQL 里 NULL 互不相等的坑。
  const rows = db
    .prepare(
      `${MEMO_SELECT} WHERE team_id = ? AND operation_class = ? ` +
        'AND (expire_time IS NULL OR expire_time > ?)',
    )
    .all(teamId, operationClass, now) as Array<Record<string, unknown>>;
  const hits = rows
    .map(memoRowToRecord)
    .filter((m) => m.taskId === undefined || m.taskId === taskId);
  if (hits.length === 0) return undefined;
  hits.sort((a, b) => {
    const aTask = a.taskId !== undefined ? 0 : 1;
    const bTask = b.taskId !== undefined ? 0 : 1;
    if (aTask !== bTask) return aTask - bTask;
    return b.memoId - a.memoId;
  });
  return hits[0];
}

/** 团队内全部未过期路线（面板展示「既定路线」用）。 */
export function readRoutingMemosSync(stateRoot: string, teamId: number): RoutingMemoRecord[] {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const rows = db
    .prepare(
      `${MEMO_SELECT} WHERE team_id = ? AND (expire_time IS NULL OR expire_time > ?) ` +
        'ORDER BY memo_id',
    )
    .all(teamId, Date.now()) as Array<Record<string, unknown>>;
  return rows.map(memoRowToRecord);
}

/**
 * 任务收口时的路线清理：任务级路线随任务终态失效（不做永久环境特权）。
 * 团队级路线（task_id IS NULL）不在此列。
 */
export function expireRoutingMemosForTaskSync(
  stateRoot: string,
  teamId: number,
  taskId: number,
  at?: number,
): number {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const now = at ?? Date.now();
  const info = db
    .prepare(
      'UPDATE routing_memos SET expire_time = ?, update_time = ? WHERE team_id = ? AND task_id = ?',
    )
    .run(now, now, teamId, taskId);
  return Number(info.changes);
}
