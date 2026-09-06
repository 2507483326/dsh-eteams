/**
 * SQLite 连接层（docs/27/35 定案）：`<workspace>/.eteams/db/eteams.db` 单库
 * per workspace，连接按状态根缓存（同进程单连接，同步 API 与现有锁内事务
 * 风格一致）；WAL + synchronous=NORMAL + busy_timeout 构成「单写多读」。
 * 本文件只管连接、DDL、库版本号与持久层序列化助手——表读写分别在
 * store.ts / events.ts / roster.ts。
 *
 * @module dsh-eteams/state/db
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AvatarRecord, ModelRouteSnapshot, PersonaRecord } from '../model/types.js';
import { contractMdFromLegacyArrays } from '../model/contract.js';
import { fallbackExecutionPrompt, PERSONA_FRAMEWORK_VERSION } from '../prompts/personas/framework.js';

/** Current db schema version (docs/27：与 team.json 结构版本互不相干，从 1 起步).
 * v2（十六轮 DA29）：task 合同四数组列合并为 contract_md 单列。
 * v3（成员=角色合并）：member 表精简改名成 roles 角色库表，班底另起
 * team_members 表，旧 roles 标签登记表删除（旧库 getDb 迁移回填）。 */
export const DB_SCHEMA_VERSION = 3;

/**
 * 领队保留名（docs/27）：task_members 领队行 `name` 固定值，领队行查找
 * 统一按 `team_id = ? AND name = 领队名 AND main_task_id IS NULL`。
 */
export const LEADER_NAME = '项目牧羊人';

/** 库文件目录：`<stateRoot>/db/`（主库与 -wal/-shm 同目录，与 json 配置分开放）。 */
export function dbDirOf(stateRoot: string): string {
  return join(stateRoot, 'db');
}

/** 库文件绝对路径。 */
export function dbFileOf(stateRoot: string): string {
  return join(dbDirOf(stateRoot), 'eteams.db');
}

// --------------------------------------------------------------------------
// node:sqlite 的 ExperimentalWarning 进程级过滤（只拦 SQLite 一条，不动全局
// warning 行为）。Node 24 起 node:sqlite 在模块加载与每次开连接时都会打一
// 条，宿主日志里全是噪音——过滤器在本模块加载时就位（先于 createRequire
// 的 node:sqlite 晚加载），连首条也一并拦下；其余 warning 原样放行。
// --------------------------------------------------------------------------
let warningFilterInstalled = false;

function installSqliteWarningFilter(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  const original = process.emitWarning;
  const filtered = function filteredEmitWarning(
    warning: string | Error,
    ...rest: unknown[]
  ): void {
    const text = typeof warning === 'string' ? warning : String(warning?.message ?? warning);
    const type = rest[0];
    if (
      (type === 'ExperimentalWarning' || text.includes('ExperimentalWarning')) &&
      text.includes('SQLite')
    ) {
      return;
    }
    (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
}

// node:sqlite 晚加载：先装过滤器再触发 builtin 编译，首条 ExperimentalWarning
// 也不漏网。类型走 import type（编译期擦除，不加载模块）。
installSqliteWarningFilter();
const DatabaseSyncCtor = createRequire(import.meta.url)('node:sqlite')
  .DatabaseSync as typeof DatabaseSync;

// --------------------------------------------------------------------------
// 连接缓存：同进程每个状态根一条连接（单写者 + 全同步调用，语句不会交错）。
// --------------------------------------------------------------------------
const connections = new Map<string, DatabaseSync>();

/**
 * 取（或建）该状态根的连接：首次调用建目录、开库、设 PRAGMA 并执行 DDL
 * （全部 `IF NOT EXISTS`，重复执行幂等）；此后直接复用。
 */
export function getDb(stateRoot: string): DatabaseSync {
  const cached = connections.get(stateRoot);
  if (cached !== undefined) return cached;
  mkdirSync(dbDirOf(stateRoot), { recursive: true });
  const db = new DatabaseSyncCtor(dbFileOf(stateRoot));
  // 连接初始化（docs/27 §27.3）：WAL 单写多读 / NORMAL 崩溃最多丢最后一个
  // 事务 / 短暂持锁（杀软、索引器）时等待而非立即报错。外键保持默认 OFF
  // ——本设计不用外键，级联与引用完整性由写入代码负责。
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 3000;');
  // v3 迁移先行：旧库把 roles/member 改名让位后，下方 DDL 才能建出新形状
  // 的 roles/team_members（迁移内部自己再跑一遍 DDL 并回填数据）。
  migrateMemberRolesV3(db);
  db.exec(loadSchemaSql());
  migrateTaskContractMd(db);
  connections.set(stateRoot, db);
  return db;
}

/**
 * v1→v2 迁移（十六轮 DA29）：合同四数组列合并为 contract_md 单列。全新库
 * 的 DDL 已是新形状（table_info 首列即存在，跳过）；v1 旧库 ALTER 补列后
 * 把旧四列的数据回填进 contract_md（合成一篇 MD；四列物理残留、此后不再
 * 读写）。幂等：contract_md 已存在的库只补 NULL 行，已回填行不重写。
 */
function migrateTaskContractMd(db: DatabaseSync): void {
  const columns = (
    db.prepare('PRAGMA table_info(task)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (columns.length === 0) return; // task 表都不存在：全新库 DDL 尚未建表（不会发生，防御）
  if (!columns.includes('contract_md')) {
    db.exec('ALTER TABLE task ADD COLUMN contract_md TEXT;');
  }
  const legacyColumns = ['acceptance', 'in_scope', 'out_of_scope', 'deliverables'].filter((n) =>
    columns.includes(n),
  );
  if (legacyColumns.length === 0) return; // 全新库（v2 DDL）：无旧列可回填
  const rows = db
    .prepare(
      `SELECT task_id, ${legacyColumns.join(', ')} FROM task WHERE contract_md IS NULL`,
    )
    .all() as Array<Record<string, string | number | null>>;
  const parseArray = (raw: string | null | undefined): string[] | undefined => {
    if (raw === null || raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : undefined;
    } catch {
      return undefined;
    }
  };
  const backfill = db.prepare('UPDATE task SET contract_md = ? WHERE task_id = ?');
  for (const row of rows) {
    const md = contractMdFromLegacyArrays({
      acceptance: parseArray(row['acceptance'] as string | null | undefined),
      inScope: parseArray(row['in_scope'] as string | null | undefined),
      outOfScope: parseArray(row['out_of_scope'] as string | null | undefined),
      deliverables: parseArray(row['deliverables'] as string | null | undefined),
    });
    if (md !== undefined) backfill.run(md, row.task_id as number);
  }
}

/**
 * v2→v3 迁移（成员=角色合并）：member 表精简改名成 roles 角色库表（去
 * team_id/role_id/model/reasoning_effort，新增 profile），各团队班底行搬进
 * 新表 team_members，旧 roles 标签登记表删除。全新库（无 member 表，DDL 已
 * 是新形状）直接跳过。单事务：中途抛错整体回滚；提交后 member 表已不存在，
 * 重入按形状检测跳过（幂等）。回填规则：
 * - member 公共行（team_id 为空）→ roles 行：role_id 沿原 member_id，工号/
 *   手册/头像原样；profile 从 persona_md 烘文提取（v2 简介烘在 `- 简介：`
 *   行，v3 起独立成列）。
 * - 旧 roles 标签行按 role_name 补缺（同名以公共行为准，不覆盖）。
 * - member 团队行 → team_members：team_member_id 沿原 member_id，role_id 按
 *   角色名解析（缺则从该班底行自建 roles 行，工号/手册/头像一并带上），
 *   model/reasoning_effort 搬列。
 * - task_members 的 role_id 物理列随迁移移除（v2 宿主代码恒写 null）。
 */
function migrateMemberRolesV3(db: DatabaseSync): void {
  const tables = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name),
  );
  if (!tables.has('member')) return; // 全新库或已迁移：DDL 已是新形状
  db.exec('BEGIN IMMEDIATE');
  try {
    if (tables.has('roles')) db.exec('ALTER TABLE roles RENAME TO roles_legacy;');
    db.exec('ALTER TABLE member RENAME TO member_legacy;');
    // 旧表让位后跑一遍 DDL：建出新形状的 roles/team_members（其余 IF NOT EXISTS 幂等跳过）
    db.exec(loadSchemaSql());
    // 1) 公共模板行（工作区角色库本体）→ roles 行
    const publicRows = db
      .prepare(
        'SELECT member_id, role_name, employee_id, persona_md, avatar, created_time, update_time ' +
          'FROM member_legacy WHERE team_id IS NULL ORDER BY member_id',
      )
      .all() as Array<{
      member_id: number;
      role_name: string;
      employee_id: number | null;
      persona_md: string | null;
      avatar: string | null;
      created_time: number;
      update_time: number;
    }>;
    const insertRoleFull = db.prepare(
      'INSERT INTO roles (role_id, role_name, employee_id, persona_md, profile, avatar, created_time, update_time) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const row of publicRows) {
      insertRoleFull.run(
        row.member_id,
        row.role_name,
        row.employee_id,
        row.persona_md,
        profileFromLegacyMd(row.persona_md),
        row.avatar,
        row.created_time,
        row.update_time,
      );
    }
    // 2) 旧 roles 标签行补缺（纯标签行/孤儿行也保留成角色条目）。role_id
    // 不沿原号——roles_legacy 与 member_legacy 两套自增序列同号起步，显式
    // 复用会撞新表主键；role_id 本就是松引用（team_members 按名解析），发新号无碍。
    const legacyRoles = db
      .prepare(
        'SELECT role_name, persona_md, avatar, created_time, update_time FROM roles_legacy',
      )
      .all() as Array<{
      role_name: string;
      persona_md: string | null;
      avatar: string | null;
      created_time: number;
      update_time: number;
    }>;
    const haveRole = db.prepare('SELECT role_id FROM roles WHERE role_name = ?');
    const insertRoleLabel = db.prepare(
      'INSERT INTO roles (role_name, employee_id, persona_md, profile, avatar, created_time, update_time) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const row of legacyRoles) {
      if (haveRole.get(row.role_name) !== undefined) continue;
      insertRoleLabel.run(
        row.role_name,
        null,
        row.persona_md,
        profileFromLegacyMd(row.persona_md),
        row.avatar,
        row.created_time,
        row.update_time,
      );
    }
    // 3) 团队班底行 → team_members（缺角色行时从班底行自建）
    const teamRows = db
      .prepare(
        'SELECT member_id, team_id, role_name, employee_id, persona_md, model, reasoning_effort, ' +
          'avatar, created_time, update_time FROM member_legacy WHERE team_id IS NOT NULL ORDER BY member_id',
      )
      .all() as Array<{
      member_id: number;
      team_id: number;
      role_name: string;
      employee_id: number | null;
      persona_md: string | null;
      model: string | null;
      reasoning_effort: string | null;
      avatar: string | null;
      created_time: number;
      update_time: number;
    }>;
    const insertRoleBare = db.prepare(
      'INSERT INTO roles (role_name, employee_id, persona_md, profile, avatar, created_time, update_time) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertTeamMember = db.prepare(
      'INSERT INTO team_members (team_member_id, team_id, role_id, model, reasoning_effort, created_time, update_time) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const row of teamRows) {
      const known = haveRole.get(row.role_name) as { role_id: number } | undefined;
      const roleId =
        known?.role_id ??
        Number(
          insertRoleBare.run(
            row.role_name,
            row.employee_id,
            row.persona_md,
            profileFromLegacyMd(row.persona_md),
            row.avatar,
            row.created_time,
            row.update_time,
          ).lastInsertRowid,
        );
      insertTeamMember.run(
        row.member_id,
        row.team_id,
        roleId,
        row.model,
        row.reasoning_effort,
        row.created_time,
        row.update_time,
      );
    }
    db.exec('DROP TABLE member_legacy;');
    db.exec('DROP TABLE roles_legacy;');
    const tmColumns = (
      db.prepare('PRAGMA table_info(task_members)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (tmColumns.includes('role_id')) db.exec('ALTER TABLE task_members DROP COLUMN role_id;');
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 事务已自动回滚：清理动作本身失败不必掩盖原异常
    }
    throw error;
  }
}

/** v2 烘文里的一句话简介（`- 简介：` 行）→ profile 列初值（无则 NULL）。 */
function profileFromLegacyMd(md: string | null | undefined): string | null {
  if (md === null || md === undefined) return null;
  return personaFromMd(md, '', '').profile ?? null;
}

/** 关闭并丢弃该状态根的缓存连接（测试收尾 / 状态根失效时用）。 */
export function closeDb(stateRoot: string): void {
  const db = connections.get(stateRoot);
  if (db === undefined) return;
  connections.delete(stateRoot);
  try {
    db.close();
  } catch {
    // 已关闭/损坏的连接视为清理成功
  }
}

/**
 * schema.sql 的运行时读取：开发态（源码目录）直接读文件，单文件 bundle 里
 * 读不到同目录资产时退回内嵌副本。两份必须逐字一致（见 schema.sql 头注）。
 */
function loadSchemaSql(): string {
  try {
    return readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  } catch {
    return SCHEMA_SQL;
  }
}

// === SCHEMA_SQL BEGIN（由 schema.sql 生成，逐字一致） ===
const SCHEMA_SQL = `-- =====================================================================
-- ETeams SQLite schema v3（db_schema_version = 3；成员=角色合并：member 表
-- 精简改名成 roles 角色库表（去 team_id/role_id/model/reasoning_effort，
-- 新增 profile），班底另起 team_members 表，旧 roles 标签登记表删除；
-- v2 旧库经 getDb 迁移回填）
-- 主键 = 每张表自己的编号列，统一 INTEGER 自增（schema_meta 例外：key 即主键）
-- 时间列一律 *_time 结尾（Unix 毫秒）；每张表末尾 created_time / update_time
-- 枚举 = TEXT（合法值写在列注释里）；JSON = TEXT 存 JSON 字符串
-- 表上没有外键、CHECK、UNIQUE、触发器——规则全部由写入代码保证
--
-- 注意：本文件与 src/host/state/db.ts 内嵌的 SCHEMA_SQL 常量必须逐字一致
-- （db.ts 在单文件 bundle 里读不到同目录资产，故内嵌一份；schema.sql 是
-- 审核/校验用的对照副本）。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. schema_meta —— 元数据（库版本号等键值对；key 即主键，唯一例外）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_meta (
  key            TEXT PRIMARY KEY,             -- 元数据键，如 'db_schema_version' / 'db_created_at'
  value          TEXT NOT NULL,                -- 统一 TEXT 存放，数值由读取方解析
  created_time   INTEGER NOT NULL,             -- 创建时间
  update_time    INTEGER NOT NULL              -- 更新时间
);

-- ---------------------------------------------------------------------
-- 1. team —— 团队
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS team (
  team_id        INTEGER PRIMARY KEY AUTOINCREMENT,  -- 团队 ID，自增（展示名见 team_name）
  team_name      TEXT NOT NULL,                -- 展示名（原文本团队 ID 转为普通列，由写入代码查重）
  has_leader     INTEGER NOT NULL DEFAULT 0,   -- 是否包含领队（0/1）；领队会话锚点在 task_members 的领队行上
  created_time   INTEGER NOT NULL,             -- 创建时间
  update_time    INTEGER NOT NULL              -- 更新时间
);

CREATE INDEX IF NOT EXISTS idx_team_update_time ON team (update_time DESC);

-- ---------------------------------------------------------------------
-- 2. roles —— 角色库（原 member 公共模板行并成角色表；成员=角色，全局一份）
--    代码里的预置角色首次启动写入；角色构建师确认的新角色、面板/工具加
--    成员时的新名字也写进来。人设/工号/头像都挂在角色行上。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  role_id        INTEGER PRIMARY KEY AUTOINCREMENT,  -- 角色 ID，自增（team_members.role_id 引用它）
  role_name      TEXT NOT NULL,                -- 角色名（成员名=角色名；全库唯一，写入代码查重）
  employee_id    INTEGER,                      -- 工号：插入角色行时取 roles 表最大工号 +1，同人同号；显示补零 1 → 0001
  persona_md     TEXT,                         -- 完整角色手册（Markdown 全文；duty/style/skills 等结构字段写入时烘进手册）
  profile        TEXT,                         -- 一句话简介（列表卡片/详情头展示；独立成列，不再烘进 persona_md）
  avatar         TEXT,                         -- 头像
  created_time   INTEGER NOT NULL,             -- 创建时间
  update_time    INTEGER NOT NULL              -- 更新时间
);

-- ---------------------------------------------------------------------
-- 3. team_members —— 班底（团队 × 角色：一行一个在队成员 + 该队派发路线；
--    人设/工号/头像经 role_id 松引用解析自 roles；执行实例（状态/会话/
--    当前任务）在 task_members）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS team_members (
  team_member_id   INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键（内存新建行 0 落库发号）
  team_id          INTEGER NOT NULL,    -- 属于哪个团队（team.team_id）
  role_id          INTEGER,             -- 角色 ID（roles.role_id，松引用；人设/工号/头像都在角色行上）
  model            TEXT,                -- 该队派发路线；NULL=会话默认（settings agent-default-model），有值=覆盖（provider 派发时按配置解析）
  reasoning_effort TEXT,                -- 模型思考强度
  created_time     INTEGER NOT NULL,    -- 创建时间
  update_time      INTEGER NOT NULL     -- 更新时间
);

CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members (team_id);

-- ---------------------------------------------------------------------
-- 4. task —— 任务（parent_id 为空就是大任务，不为空就是小任务）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task (
  task_id           INTEGER PRIMARY KEY AUTOINCREMENT,  -- 任务号，自增（面板显示「任务 #12」）
  team_id           INTEGER NOT NULL,    -- 属于哪个团队（team.team_id）
  parent_id         INTEGER,             -- 父任务 ID：小任务挂靠的父任务；NULL=大任务（task.task_id）
  subject           TEXT NOT NULL,       -- 标题（非空）
  description       TEXT,                -- 正文
  depend_tasks      TEXT NOT NULL DEFAULT '[]',  -- 依赖前置任务 ID 列表（JSON 数组；环检测由写入代码做）
  member_chain_list TEXT NOT NULL DEFAULT '[]',  -- 执行人员序列列表（JSON 数组）
  chain_cursor      INTEGER NOT NULL DEFAULT -1, -- -1=没开始；k=第 k 站完成；末站完成→completed
  status            TEXT NOT NULL DEFAULT 'draft',
                    -- draft / ready / wait / start / paused /
                    -- wait_decision / wait_user / completed / failed / cancelled
  current_member    TEXT,                -- 当前执行成员名（松引用：成员移除也不影响这列）
  current_member_id INTEGER,             -- 当前执行成员 ID（v2 的 member.member_id 口径随 v3 合并废弃；写入代码恒置 NULL，物理残留列）
  retry_count       INTEGER NOT NULL DEFAULT 0,  -- 当前执行人连续失败次数（换人清零）
  status_note       TEXT,                -- 当前状态说明（挂起原因等也并在这列）
  contract_md       TEXT,                -- 任务合同全文（Markdown，十六轮 DA29：原 acceptance/in_scope/out_of_scope/deliverables 四数组列合并——验收标准/允许改动/禁止改动/交付物统一写在这篇 MD 里；旧库由 getDb 迁移 ALTER + 回填，旧四列物理残留不再读写）
  idempotency_note  TEXT,                -- 幂等说明（重跑安全的前提，派发提示词渲染）
  blocked_from      TEXT,                -- 阻塞前的状态（10 态之一）；解除阻塞时还原到它，NULL=未阻塞
  work_dir          TEXT,                -- 任务工作目录（相对工作区；建任务时分配，分配后固定——撞名 -N 后缀有状态，不可重推导）
  completed_time    INTEGER,             -- 完成时间
  created_time      INTEGER NOT NULL,    -- 创建时间
  update_time       INTEGER NOT NULL     -- 更新时间（主键 task_id 已在列级声明，表上不再写 PRIMARY KEY）
  -- 大任务（parent_id 为空）不带执行链/依赖：由写入代码校验
);

CREATE INDEX IF NOT EXISTS idx_task_status  ON task (team_id, status);
CREATE INDEX IF NOT EXISTS idx_task_parent  ON task (team_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_task_current ON task (team_id, current_member) WHERE current_member IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_update  ON task (team_id, update_time DESC);

-- ---------------------------------------------------------------------
-- 5. task_members —— 任务成员（执行实例：有状态、有会话锚点；人设/工号/
--    头像的模板本体在 roles，班底路线在 team_members）
--    领队也是一行：name='项目牧羊人'、main_task_id 为空（团队级主持行）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_members (
  task_member_id   INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
  team_id          INTEGER NOT NULL,    -- 属于哪个团队（team.team_id，写入代码维护；领队行也带，删除/统计/领队行定位都按它过滤）
  main_task_id     INTEGER,             -- 实例行所属大任务 ID（task.task_id；独立无链任务=自身 id）；NULL=团队级行（领队主持行）
  now_task_id      INTEGER,             -- 当前执行任务 ID（task.task_id）
  name             TEXT NOT NULL,       -- 成员名（与 roles.role_name 同名，写入代码查重）
  employee_id      INTEGER,             -- 工号副本（引用 roles.employee_id，松引用）
  main_session_id  TEXT NOT NULL DEFAULT '',  -- 主代理会话 ID；还没启动时是空串（领队行存领队会话）
  child_session_id TEXT NOT NULL DEFAULT '',  -- 子代理会话 ID；还没启动时是空串
  status           TEXT NOT NULL DEFAULT 'staged',
                   -- 成员状态：staged / ready / working / paused / removed
  persona_md       TEXT,                -- 执行时的人设手册（沿用 roles 角色行的手册，可按任务微调）
  model            TEXT,                -- 执行时采用的模型（沿用 team_members 班底路线；NULL=跟随）
  reasoning_effort TEXT,                -- 模型思考强度
  avatar           TEXT,                -- 头像
  created_time     INTEGER NOT NULL,    -- 创建时间
  update_time      INTEGER NOT NULL     -- 更新时间
);

CREATE INDEX IF NOT EXISTS idx_task_members_team ON task_members (team_id);
CREATE INDEX IF NOT EXISTS idx_task_members_main ON task_members (main_task_id);

-- ---------------------------------------------------------------------
-- 6. attempts —— 执行尝试（一行一次尝试）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id    INTEGER PRIMARY KEY AUTOINCREMENT,  -- 尝试号，自增
  team_id       INTEGER NOT NULL,     -- 属于哪个团队（team.team_id）
  task_id       INTEGER NOT NULL,     -- 属于哪个任务（task.task_id）
  kind          TEXT NOT NULL,        -- initial=首发 / stage=链站点 / retry=重试 / reassign=换人
  member        TEXT NOT NULL,        -- 执行成员名（松引用，与链站点同键）
  status        TEXT NOT NULL DEFAULT 'pending_accept',
                -- pending_accept / running / paused / succeeded / failed / revoked
  token         TEXT NOT NULL DEFAULT '',  -- 一次性凭证：接活时校验，换人/重试/接管即作废
  station_index INTEGER NOT NULL DEFAULT -1, -- 执行的链站点下标；无链任务 -1
  progress      TEXT NOT NULL DEFAULT '[]',  -- 进度记录（JSON 数组：[{at, text}]，只追加，单条 ≤200 字）
  result_output TEXT,                  -- 成功汇报正文
  result_changed_paths TEXT,           -- 声明的变更文件列表（JSON 数组）
  error         TEXT,                  -- 失败原因
  claimed_time  INTEGER,               -- 接活时刻
  ended_time    INTEGER,               -- 结束时刻
  created_time  INTEGER NOT NULL,      -- 创建时间
  update_time   INTEGER NOT NULL       -- 更新时间
);

CREATE INDEX IF NOT EXISTS idx_attempts_task   ON attempts (team_id, task_id, created_time);
CREATE INDEX IF NOT EXISTS idx_attempts_member ON attempts (team_id, member, created_time DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_token  ON attempts (team_id, token) WHERE token <> '';
CREATE INDEX IF NOT EXISTS idx_attempts_status ON attempts (team_id, status)
                 WHERE status IN ('pending_accept','running');

-- ---------------------------------------------------------------------
-- 7. events —— 审计事件（只插入，不改写）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  event_id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- 事件号，自增（全库递增；团队内排序也按它）
  team_id     INTEGER NOT NULL,    -- 属于哪个团队（team.team_id）
  event_time  INTEGER NOT NULL,    -- 发生时刻
  actor_kind  TEXT NOT NULL,       -- 谁做的：captain / member / user / plugin / system
  actor_name  TEXT,                -- 成员名 / '领队' / '用户'；system 可空
  type        TEXT NOT NULL,       -- 事件类型，如 'task.assigned'（开放集合，不限定）
  task_id     INTEGER,             -- 相关任务（task.task_id，松引用：任务删了事件还在）
  attempt_id  INTEGER,             -- 相关尝试（attempts.attempt_id，松引用）
  payload     TEXT,                -- 事件附加数据（JSON）
  created_time INTEGER NOT NULL,   -- 创建时间（= event_time）
  update_time INTEGER NOT NULL     -- 更新时间（追加即写）
);

CREATE INDEX IF NOT EXISTS idx_events_time ON events (team_id, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (team_id, type, event_id);
CREATE INDEX IF NOT EXISTS idx_events_task ON events (team_id, task_id, event_id) WHERE task_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 8. mail_messages —— 邮箱消息（按收件箱分箱；至少一次投递）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_messages (
  mail_message_id          INTEGER PRIMARY KEY AUTOINCREMENT,  -- 邮件序号，自增（全库递增；箱内顺序按它排）
  team_id      INTEGER NOT NULL,     -- 属于哪个团队（team.team_id）
  message_id   TEXT NOT NULL,        -- 消息幂等键（接收方按它去重；同箱不重由写入代码保证）
  box_key      TEXT NOT NULL,        -- 收件箱：收件成员名；领队='captain'
  from_kind    TEXT NOT NULL,        -- 发件人类型：captain / member / user / plugin / system
  from_name    TEXT,                 -- 发件人名；plugin/system 可空
  to_kind      TEXT NOT NULL,        -- 收件人类型（同上五值）
  to_name      TEXT,
  kind         TEXT NOT NULL,        -- 消息类型：assignment / report / question / notice / user_message
  task_id      INTEGER,              -- 相关任务（task.task_id，松引用：任务删了邮件历史还在）
  attempt_id   INTEGER,              -- 相关尝试（attempts.attempt_id，松引用）
  content      TEXT NOT NULL,        -- 正文（assignment 附合同、report 附汇报）
  read_time    INTEGER,              -- 已读时刻；NULL=未读（唤醒先补投）
  created_time INTEGER NOT NULL,     -- 创建时间
  update_time  INTEGER NOT NULL      -- 更新时间
);

CREATE INDEX IF NOT EXISTS idx_mail_unread     ON mail_messages (team_id, box_key, mail_message_id) WHERE read_time IS NULL;
CREATE INDEX IF NOT EXISTS idx_mail_message_id ON mail_messages (team_id, box_key, message_id);

-- ---------------------------------------------------------------------
-- 9. decisions —— 升级决策（任务失败超限后，等领队/用户拍板）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decisions (
  decision_id   INTEGER PRIMARY KEY AUTOINCREMENT,  -- 决策号，自增
  team_id       INTEGER NOT NULL,     -- 属于哪个团队（team.team_id）
  task_id       INTEGER NOT NULL,     -- 触发决策的任务（task.task_id）
  attempt_id    INTEGER,              -- 触发决策的失败尝试（可空）
  error         TEXT NOT NULL,        -- 失败原因
  retry_count   INTEGER NOT NULL DEFAULT 0,  -- 已重试次数
  status        TEXT NOT NULL DEFAULT 'open',  -- open=待处置 / resolved=已处置
  choice        TEXT,                 -- 处置：suspend=挂起 / reassign=换人 / notify_user=通知用户
  note          TEXT,                 -- 处置备注
  resolved_time INTEGER,              -- 处置时刻
  created_time  INTEGER NOT NULL,     -- 创建时间
  update_time   INTEGER NOT NULL      -- 更新时间
);

CREATE INDEX IF NOT EXISTS idx_decisions_open ON decisions (team_id, created_time) WHERE status = 'open';

-- ---------------------------------------------------------------------
-- 10. task_status_changes —— 状态流转记录（何时从什么变成什么，供分析卡点）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_status_changes (
  change_id    INTEGER PRIMARY KEY AUTOINCREMENT,  -- 流转记录号，自增
  team_id      INTEGER NOT NULL,     -- 属于哪个团队（team.team_id）
  task_id      INTEGER NOT NULL,     -- 哪个任务（task.task_id，松引用）
  from_status  TEXT,                 -- 原状态；NULL=创建时的初始态
  to_status    TEXT NOT NULL,        -- 新状态
  actor_kind   TEXT NOT NULL,        -- 谁改的：captain / member / user / plugin / system
  actor_name   TEXT,
  note         TEXT,                 -- 挂起原因 / 决策摘要等
  change_time  INTEGER NOT NULL,     -- 流转时刻
  created_time INTEGER NOT NULL,     -- 创建时间
  update_time  INTEGER NOT NULL      -- 更新时间
);

CREATE INDEX IF NOT EXISTS idx_status_changes_task ON task_status_changes (team_id, task_id, change_time);
CREATE INDEX IF NOT EXISTS idx_status_changes_time ON task_status_changes (team_id, change_time);

-- ---------------------------------------------------------------------
-- 11. usage_detail —— Token 消耗明细（一行 = 一次带 usage 的模型回复步）
--     DB 即唯一存储（docs/40，2026-09-05 简化版：无文件台账、无对账）；
--     写入 = 本表 INSERT + usage_daily_total 增量 upsert（单事务）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_detail (
  usage_detail_id    INTEGER PRIMARY KEY AUTOINCREMENT,  -- 明细行号，自增
  day                TEXT NOT NULL,     -- 消耗日 'yyyy-MM-dd'（记录时按宿主本地时区折算）
  event_time         INTEGER NOT NULL,  -- 事件发生时刻（Unix 毫秒）
  session_id         TEXT NOT NULL,     -- 会话 ID
  seq                INTEGER NOT NULL,  -- 会话内事件序号（同会话内单调）
  team_key           TEXT,              -- 归属团队的台账文本 ID；NULL=工作区桶（普通对话、持续构建子代理）；松引用，不校验存在
  member_name        TEXT,              -- 归属成员名；非成员为 NULL
  role_kind          TEXT NOT NULL,     -- 归属类别：captain / captain-child / member / conversation / workspace
  provider           TEXT,              -- 模型路线快照：provider 名
  model              TEXT,              -- 模型路线快照：模型 ID
  input_tokens       INTEGER NOT NULL DEFAULT 0,   -- 不含缓存的输入
  output_tokens      INTEGER NOT NULL DEFAULT 0,   -- 输出
  cache_read_tokens  INTEGER,           -- 缓存读；未上报为 NULL
  cache_write_tokens INTEGER,           -- 缓存写；未上报为 NULL
  reasoning_tokens   INTEGER,           -- 思考 token；不计入 total_tokens；未上报为 NULL
  total_tokens       INTEGER NOT NULL,  -- input + output + cache_read + cache_write
  created_time       INTEGER NOT NULL,  -- 入库时刻
  update_time        INTEGER NOT NULL   -- 明细行只插不改，= created_time
);

CREATE INDEX IF NOT EXISTS idx_usage_detail_session ON usage_detail (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_usage_detail_day     ON usage_detail (day);
CREATE INDEX IF NOT EXISTS idx_usage_detail_team    ON usage_detail (team_key, day) WHERE team_key IS NOT NULL;

-- ---------------------------------------------------------------------
-- 12. usage_daily_total —— 每日消耗总和（一行 = 一天，全应用口径）
--     写入按事件增量 upsert（不强一致：精确口径随时可 GROUP BY
--     usage_detail 重查，团队口径即如此直查明细表）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_daily_total (
  day                TEXT PRIMARY KEY,  -- 消耗日 'yyyy-MM-dd'（行即主键，仿 schema_meta 例外）
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,  -- 明细 total_tokens 之和（增量累计）
  calls              INTEGER NOT NULL DEFAULT 0,  -- 明细行数（= 调用次数）
  created_time       INTEGER NOT NULL,  -- 首次写入该日行
  update_time        INTEGER NOT NULL   -- 最近一次增量
);`;
// === SCHEMA_SQL END ===

// --------------------------------------------------------------------------
// 库版本号：schema_meta + PRAGMA user_version 双写同值（docs/27 §27.3）。
// --------------------------------------------------------------------------

/** 读取 db_schema_version；未写入（全新/未导入库）返回 undefined。 */
export function readSchemaVersion(db: DatabaseSync): number | undefined {
  const row = db
    .prepare('SELECT value FROM schema_meta WHERE key = ?')
    .get('db_schema_version') as { value: string } | undefined;
  if (row === undefined) return undefined;
  const parsed = Number(row.value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 写入 db_schema_version（schema_meta 行 + user_version 双写同值）。 */
export function writeSchemaVersion(db: DatabaseSync, now: number): void {
  db.prepare(
    'INSERT INTO schema_meta (key, value, created_time, update_time) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, update_time = excluded.update_time',
  ).run('db_schema_version', String(DB_SCHEMA_VERSION), now, now);
  db.exec(`PRAGMA user_version = ${DB_SCHEMA_VERSION};`);
}

// --------------------------------------------------------------------------
// 发号（docs/27 §27.4）：编号全部来自数据库自增——取号 = 读 sqlite_sequence
// 计数 +1（表尚无任何插入时 sqlite_sequence 不存在，按 0 计）。
// --------------------------------------------------------------------------

/** 读一张自增表的下一个编号（= sqlite_sequence 计数 + 1）。 */
export function nextAutoincrementId(db: DatabaseSync, table: string): number {
  try {
    const row = db
      .prepare('SELECT seq FROM sqlite_sequence WHERE name = ?')
      .get(table) as { seq: number | bigint } | undefined;
    const seq = row === undefined ? 0 : Number(row.seq);
    return (Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0) + 1;
  } catch {
    return 1; // sqlite_sequence 尚未创建：该表还没有任何自增插入
  }
}

/** 下一工号 = roles 表最大 employee_id + 1（docs/27；成员=角色，同人同号）。 */
export function nextEmployeeId(db: DatabaseSync): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(employee_id), 0) AS max FROM roles')
    .get() as { max: number | null };
  return (row.max ?? 0) + 1;
}

/** Stable avatar seed from a name（旧 roster.hashName 同式，头像种子）。 */
export function hashName(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) | 0;
  return Math.abs(h) % 997;
}

// --------------------------------------------------------------------------
// persona 序列化（docs/35 §3#4）：持久层只存 persona_md 手册全文；结构字段
// 写入时烘进全文、读取时从全文解析回来（内存渲染用）。文本格式与
// prompts/personas/framework.renderPersonaBlock 一致——解析结果经它再渲染
// 可逐字还原。
// --------------------------------------------------------------------------

/** 把 PersonaRecord 烘成 persona_md 全文（六字段 + 可选手册一体）。 */
export function personaToMd(persona: PersonaRecord, name: string): string {
  // 简介（v3）独立成 roles.profile 列，不再烘进手册——persona_md 只烘
  // spawn 语境需要的字段；旧库烘过的 `- 简介：` 行由 personaFromMd 兼容解析。
  const summary = [
    `# 人设 · ${name}`,
    `- 角色：${persona.role}`,
    `- 职责边界：${persona.duty}`,
    `- 工作风格：${persona.style}`,
    `- 能力：${persona.skills}`,
    `- 工作纪律：`,
    ...persona.rules.map((r) => `  - ${r}`),
    `- 执行提示：${persona.executionPrompt}`,
  ].join('\n');
  const playbook = persona.personaMd !== undefined && persona.personaMd.trim() !== ''
    ? `${summary}\n\n---\n\n# 角色手册\n\n${persona.personaMd.trim()}`
    : summary;
  return playbook;
}

/** 从 persona_md 全文解析回结构字段（非本层格式的文本整体视作角色手册）。 */
export function personaFromMd(md: string, name: string, roleFallback: string): PersonaRecord {
  let role: string | undefined;
  let profile: string | undefined;
  let duty: string | undefined;
  let style: string | undefined;
  let skills: string | undefined;
  let executionPrompt: string | undefined;
  const rules: string[] = [];
  let inRules = false;
  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const field = (prefix: string): string | undefined =>
      line.startsWith(prefix) ? line.slice(prefix.length).trim() : undefined;
    const picked =
      field('- 角色：') ??
      field('- 简介：') ??
      field('- 职责边界：') ??
      field('- 工作风格：') ??
      field('- 能力：') ??
      field('- 执行提示：');
    if (line.trim() === '- 工作纪律：') {
      inRules = true;
      continue;
    }
    if (inRules && line.startsWith('  - ')) {
      rules.push(line.slice(4).trim());
      continue;
    }
    inRules = false;
    if (picked === undefined || picked === '') continue;
    if (line.startsWith('- 角色：')) role = picked;
    else if (line.startsWith('- 简介：')) profile = picked;
    else if (line.startsWith('- 职责边界：')) duty = picked;
    else if (line.startsWith('- 工作风格：')) style = picked;
    else if (line.startsWith('- 能力：')) skills = picked;
    else executionPrompt = picked;
  }
  const marker = '# 角色手册';
  const markerAt = md.indexOf(marker);
  const playbook =
    markerAt >= 0 && md.slice(markerAt + marker.length).trim() !== ''
      ? md.slice(markerAt + marker.length).trim()
      : undefined;
  return {
    frameworkVersion: PERSONA_FRAMEWORK_VERSION,
    role: role ?? roleFallback,
    ...(profile !== undefined && profile !== '' ? { profile } : {}),
    duty: duty ?? '',
    style: style ?? '',
    skills: skills ?? '',
    rules,
    ...(playbook !== undefined ? { personaMd: playbook } : {}),
    executionPrompt: executionPrompt ?? fallbackExecutionPrompt(name, roleFallback),
  };
}

// --------------------------------------------------------------------------
// 头像 / 模型路线（JSON 列的编解码）。
// --------------------------------------------------------------------------

/** AvatarRecord → avatar 列 JSON（NULL=未生成）。 */
export function avatarToJson(avatar: AvatarRecord | undefined): string | null {
  return avatar === undefined ? null : JSON.stringify(avatar);
}

/** avatar 列 JSON → AvatarRecord（坏值按未生成处理）。 */
export function avatarFromJson(raw: string | null): AvatarRecord | undefined {
  if (raw === null || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<AvatarRecord>;
    return typeof parsed.seed === 'number' && typeof parsed.salt === 'number'
      ? { seed: parsed.seed, salt: parsed.salt }
      : undefined;
  } catch {
    return undefined;
  }
}

/** 内存模型路线（model 空 = 跟随）→ member/task_members 两列。 */
export function routeToColumns(
  route: ModelRouteSnapshot,
): { model: string | null; effort: string | null } {
  return {
    model: route.model === '' ? null : route.model,
    effort:
      route.reasoningEffort === undefined || route.reasoningEffort === ''
        ? null
        : route.reasoningEffort,
  };
}

/** member/task_members 两列 → 内存模型路线。 */
export function routeFromColumns(model: string | null, effort: string | null): ModelRouteSnapshot {
  return {
    model: model ?? '',
    ...(effort !== null && effort !== '' ? { reasoningEffort: effort } : {}),
  };
}