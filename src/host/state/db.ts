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
 * team_members 表，旧 roles 标签登记表删除（旧库 getDb 迁移回填）。
 * v4（班底行角色信息副本）：team_members 补 role_name/persona_md/profile
 * 副本列，真相在 roles，写入路径同步刷新（旧库 getDb ALTER + 回填）。
 * v5（任务行主会话快照）：task 补 session_id 列，建任务时盖章领队行锚定的
 * 主会话 ID（快照，落库后不变；旧库 getDb ALTER + 从领队行回填）。
 * v6（会话列归位）：主会话快照只在 task 行；task_members 只记本行自己的
 * 子代理会话。
 * v7（工号挪到班底，表自增）：工号 = team_members 行的自增主键
 * （AUTOINCREMENT 只增不复用；roles.employee_id 弃用——列保留不读写，DROP
 * 是单向门会炸旧版 lib 回滚）；mail_messages 补 employee_id 分箱列；attempts
 * 补 task_member_id 副本行列；存量队补建领队班底行、存量容器任务按班底全员
 * 补建副本行，副本/邮箱/链站按名 join 重键（旧库 getDb 迁移回填）。
 * v8（领队标识列）：roles/team_members/task_members 补 is_leader（项目牧羊人
 * =1 其余=0）——领队行查找按标识不按名（旧库 getDb 迁移回填）。
 * v9（路线 provider 列）：team_members/task_members 补 provider——同 id 模型
 * 跨提供方时模型 id 有歧义，显示与 spawn 都需要目录 provider（用户迭代
 * 2026-09-08「选的是 glm1 显示的是 glm-5.3-free」；旧库 getDb 迁移回填）。
 * v10（班底头像副本列）：team_members 补 avatar——角色修改保存后按 role_id
 * 随 roles.avatar 同步刷新（role_name/profile/persona_md 之外补齐头像；
 * 角色删除不进行同步；旧库 getDb 迁移回填）。
 * v11（子代理用户问答单）：新增 ask_questions 表——eteams_ask_user 的路由
 * 状态（用户在本会话就地弹/不在则转交主会话弹出）。独立行 CRUD 不随
 * TeamState 整存整取重写；纯新表由 DDL IF NOT EXISTS 直接建（旧库同享），
 * 无需 ALTER/回填，迁移仅版本号推进。
 * v12（主对话注入角色）：roles 补 is_root（保留角色 system=1 其余=0）——
 * system 的 persona_md 存注入主对话 system 提示词的原文（默认空），读端按
 * 标识取行；旧库 getDb 迁移回填。
 * v13（任务状态精简，用户迭代 2026-09-11）：11 态 → 7 态——draft/ready/wait
 * 并入 ready，wait_decision/failed 并入 wait_user（存量行状态回填）；
 * blocked_from 列弃用不再读写（不 DROP）；task.status 列默认值改 ready。
 * 注：随后用户迭代又恢复独立 `wait`=待领队分诊（8 态，语义与旧 wait 不同），
 * 纯 TEXT 枚举无结构变更——本迁移只在 version < 13 的旧库执行一次，不会
 * 触碰新语义的 wait 行。
 * v14（问答弹窗落点列）：ask_questions 补 delivery_session_id（弹窗实际落在
 * 的会话 ID）与 delivery_is_main（1=主对话 / 0=提问子会话）——看板「决策面板」
 * 据此精确跳转到作答会话（旧库 getDb ALTER + 按提问会话回填）。 */
export const DB_SCHEMA_VERSION = 14;

/**
 * 领队保留名（docs/27）：task_members 领队行 `name` 固定值。v8 起领队身份
 * 落 is_leader 标识列（写入层由本名派生，读端按标识取领队）；本名仍作
 * 保留名守卫（upsert/删除保护）与写入层派生源。
 */
export const LEADER_NAME = '项目牧羊人';

/** 领队标识派生（v8 写入口径）：领队保留名 → 1，其余 → 0。所有三表
 * is_leader 列的写入一律经它，保证「项目牧羊人=1 其余=0」不变量。 */
export function leaderFlagOf(name: string): 0 | 1 {
  return name === LEADER_NAME ? 1 : 0;
}

/**
 * 主对话注入角色的保留名（v12）：角色库中 `role_name = system` 且
 * `is_root = 1` 的保留行——它的 persona_md 是注入主对话 system 提示词的
 * 原文（默认空；与普通角色不同，不烘 personaToMd 结构脚手架）。本名作
 * 保留名守卫（upsert 需面板显式 allowRoot、删除/入团拒绝）与写入层派生源。
 */
export const ROOT_ROLE_NAME = 'system';

/** 主对话注入角色标识派生（v12 写入口径）：保留名 system → 1，其余 → 0。
 * 所有 roles.is_root 列的写入一律经它，保证「system=1 其余=0」不变量。 */
export function rootFlagOf(name: string): 0 | 1 {
  return name === ROOT_ROLE_NAME ? 1 : 0;
}

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
  migrateTeamMemberRoleColumnsV4(db);
  migrateTaskSessionIdV5(db);
  migrateTaskSessionColumnsV6(db);
  migrateMemberBadgeV7(db);
  migrateLeaderFlagV8(db);
  migrateRouteProviderV9(db);
  migrateTeamMemberAvatarV10(db);
  migrateRootFlagV12(db);
  migrateTaskStatusV13(db);
  migrateAskDeliveryV14(db);
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
      // v7 表自增：team_members 无 employee_id 列（工号 = 行自增主键）——旧
      // member 行的号不再搬进班底（roles.employee_id 弃用列已留档）；存量
      // 副本/邮箱/链站点的换号重键由 migrateMemberBadgeV7 按名 join 完成。
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
    // v4 副本列回填：本次迁移新落的 team_members 行也带上三列镜像（DDL 已是
    // v4 形状，三列现值为 NULL；与后续 migrateTeamMemberRoleColumnsV4 同口径）
    db.exec(TEAM_MEMBER_MIRROR_BACKFILL_SQL);
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

/**
 * v4 班底行角色信息副本回填：三列一律从 roles 按名刷新（相关子查询，悬空
 * role_id 行刷成 NULL，与读路径防御性跳过同口径）。幂等自愈，不碰
 * update_time（副本刷新不算行变更）。迁移与写入路径共用同一条 SQL——db.ts
 * 不依赖 store.ts，这里留一份内联副本。
 */
const TEAM_MEMBER_MIRROR_BACKFILL_SQL =
  'UPDATE team_members SET ' +
  'role_name = (SELECT r.role_name FROM roles r WHERE r.role_id = team_members.role_id), ' +
  'persona_md = (SELECT r.persona_md FROM roles r WHERE r.role_id = team_members.role_id), ' +
  'profile = (SELECT r.profile FROM roles r WHERE r.role_id = team_members.role_id)';

/**
 * v4 迁移（班底行角色信息副本）：team_members 补 role_name/persona_md/profile
 * 三列。全新库的 DDL 已是新形状（table_info 检测到三列，只跑回填兜底）；
 * v2/v3 旧库 ALTER 补列后按 roles 角色行回填。幂等：已补列的库重开只重复
 * 回填（自愈，不报错）。随 migrateTaskContractMd 先例不显式开事务。
 */
function migrateTeamMemberRoleColumnsV4(db: DatabaseSync): void {
  const columns = (
    db.prepare('PRAGMA table_info(team_members)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (columns.length === 0) return; // team_members 都不存在：不会发生（防御）
  if (!columns.includes('role_name')) {
    db.exec('ALTER TABLE team_members ADD COLUMN role_name TEXT;');
  }
  if (!columns.includes('persona_md')) {
    db.exec('ALTER TABLE team_members ADD COLUMN persona_md TEXT;');
  }
  if (!columns.includes('profile')) {
    db.exec('ALTER TABLE team_members ADD COLUMN profile TEXT;');
  }
  db.exec(TEAM_MEMBER_MIRROR_BACKFILL_SQL);
}

/**
 * v5 迁移（任务行主会话快照）：task 补 session_id 列，旧库已有任务行从
 * task_members 领队行（`name=领队名 AND main_task_id IS NULL`）锚定的
 * main_session_id 回填——与建任务时盖章同一条口径。快照语义：只补 NULL 行
 * （已盖章行不随领队重锚改写）；无领队行/未锚定的任务保持 NULL（悬空
 * NULL，与 v4 副本列同口径）。幂等：已补列的库重开只重复补 NULL（自愈，
 * 不报错）。随 migrateTaskContractMd 先例不显式开事务。
 */
const TASK_SESSION_BACKFILL_SQL =
  'UPDATE task SET session_id = (' +
  `SELECT tm.main_session_id FROM task_members tm WHERE tm.team_id = task.team_id AND tm.name = '${LEADER_NAME}' ` +
  'AND tm.main_task_id IS NULL) WHERE session_id IS NULL';

function migrateTaskSessionIdV5(db: DatabaseSync): void {
  const columns = (
    db.prepare('PRAGMA table_info(task)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (columns.length === 0) return; // task 表都不存在：不会发生（防御）
  if (!columns.includes('session_id')) {
    // v6 库（task 列已是 main_session_id）直接跳过：v5 只服务旧形状。
    if (columns.includes('main_session_id')) return;
    db.exec('ALTER TABLE task ADD COLUMN session_id TEXT;');
  }
  // 回填判据：task_members 领队行的 main_session_id 列还在（v5 前旧形状）。
  // v6 库该列已合并丢弃、残缺库（仅 task 表）由 SCHEMA_SQL 补建的新形状
  // task_members（无该列）也不回填——v6 迁移随后接管。
  const tmColumns = (
    db.prepare('PRAGMA table_info(task_members)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (tmColumns.includes('main_session_id')) {
    db.exec(TASK_SESSION_BACKFILL_SQL);
  }
}

/**
 * v6 迁移（会话列归位，docs/51）：主会话 ID 只落在 task 行——session_id 改名
 * main_session_id（v5 快照语义不变）；task_members 只记本行自己的子代理会话：
 * main_session_id + child_session_id 合并成 session_id（成员行=成员子会话，
 * 领队行=领队子代理会话），领队主会话锚点列随合并丢弃（v5 迁移已把全部任务行
 * 按它回填过；锚点消费点改按任务行快照 + 心跳派生，见 docs/51）。team 表不存
 * 会话列。幂等：各步按 table_info 形状检测，已迁移的库逐步跳过；随 v4/v5 先例
 * 不显式开事务。
 */
function migrateTaskSessionColumnsV6(db: DatabaseSync): void {
  const taskColumns = (
    db.prepare('PRAGMA table_info(task)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (taskColumns.length === 0) return; // task 表都不存在：不会发生（防御）
  if (!taskColumns.includes('main_session_id')) {
    if (taskColumns.includes('session_id')) {
      db.exec('ALTER TABLE task RENAME COLUMN session_id TO main_session_id;');
    } else {
      db.exec('ALTER TABLE task ADD COLUMN main_session_id TEXT;');
    }
  }
  const tmColumns = (
    db.prepare('PRAGMA table_info(task_members)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (tmColumns.length === 0) return; // task_members 都不存在：不会发生（防御）
  if (!tmColumns.includes('session_id')) {
    db.exec("ALTER TABLE task_members ADD COLUMN session_id TEXT NOT NULL DEFAULT '';");
    // 本行自己的子代理会话：成员行=成员子会话；领队行=领队子代理（持久领队
    // 子代理的冷恢复凭证，captainDispatch 落盘）。旧 main_session_id 列是
    // v5 前的领队主会话锚点，任务行已按它回填过，随合并丢弃。
    if (tmColumns.includes('child_session_id')) {
      db.exec('UPDATE task_members SET session_id = child_session_id');
    }
    if (tmColumns.includes('main_session_id')) {
      db.exec('ALTER TABLE task_members DROP COLUMN main_session_id;');
    }
    if (tmColumns.includes('child_session_id')) {
      db.exec('ALTER TABLE task_members DROP COLUMN child_session_id;');
    }
  }
}

/**
 * v7 迁移（工号挪到班底，表自增口径）：工号 = team_members 行的自增主键
 * （AUTOINCREMENT 只增不复用），班底/团队表不需要任何新列；迁移只做补列与
 * 数据重键——mail_messages 补 employee_id 分箱列、attempts 补 task_member_id
 * 副本行列；存量队补建领队班底行（v6 领队不入班底）；现存容器任务按班底
 * 全员补建副本行（终审 B3——副本行只锚定大任务，小任务共享容器的副本行，
 * 不为它们补建）；副本行/邮箱/执行链按名 join 班底行重键到新号（解析不到
 * 的保留旧值/名字，渲染端标 legacy）。
 * 单事务：中途抛错整体回滚；重入按形状检测跳过（幂等）。
 */
function migrateMemberBadgeV7(db: DatabaseSync): void {
  const columnsOf = (table: string): string[] =>
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((c) => c.name);
  if (columnsOf('team_members').length === 0) return; // 表不存在：不会发生（防御）
  const mailColumns = columnsOf('mail_messages');
  const addMailEmployeeId = mailColumns.length > 0 && !mailColumns.includes('employee_id');
  const attemptColumns = columnsOf('attempts');
  const addAttemptRowId = attemptColumns.length > 0 && !attemptColumns.includes('task_member_id');
  // 全新库（DDL 已是 v7 形状）或已迁移库：无事可做
  if (!addMailEmployeeId && !addAttemptRowId) return;
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    // 步骤 1：补列（形状检测，缺哪列补哪列）
    if (addMailEmployeeId) {
      db.exec('ALTER TABLE mail_messages ADD COLUMN employee_id INTEGER;');
    }
    if (addAttemptRowId) {
      db.exec('ALTER TABLE attempts ADD COLUMN task_member_id INTEGER;');
    }

    // 步骤 2：团队级 staged 实例行删除（v7 副本只随任务建）
    db.exec(`DELETE FROM task_members WHERE main_task_id IS NULL AND name != '${LEADER_NAME}'`);

    // 步骤 3（验收 M1）：存量队领队班底行补建——v6 领队不入班底，v7 领队也
    // 是普通成员（建队即入拿号）。工号 = 新班底行的自增主键（表自增续编），
    // 主持行同步此号（R7 口径：主持行不是工牌）。主持行整行不存在的队跳过
    // （领队已删干净，加回时走 setLeaderRemoved 的续号路径自会补齐）。角色
    // 行被删的队同样跳过——读端按 roles join 解析名字，无角色行的班底行不可
    // 见（写端 ensureRolesRowInTx 自愈）。须在步骤 4 之前：副本补建按班底
    // 全员（含领队）铺。
    const leaderRole = db
      .prepare('SELECT role_id FROM roles WHERE role_name = ?')
      .get(LEADER_NAME) as { role_id: number } | undefined;
    if (leaderRole !== undefined) {
      const anchors = db
        .prepare(
          'SELECT task_member_id, team_id FROM task_members WHERE main_task_id IS NULL AND name = ?',
        )
        .all(LEADER_NAME) as Array<{ task_member_id: number; team_id: number }>;
      const hasLeaderRoster = db.prepare(
        'SELECT 1 FROM team_members WHERE team_id = ? AND role_name = ?',
      );
      const insertLeaderRoster = db.prepare(
        'INSERT INTO team_members (team_id, role_id, role_name, created_time, update_time) ' +
          'VALUES (?, ?, ?, ?, ?)',
      );
      const syncAnchor = db.prepare(
        'UPDATE task_members SET employee_id = ? WHERE task_member_id = ?',
      );
      const seenTeams = new Set<number>();
      for (const anchor of anchors) {
        const teamId = Number(anchor.team_id);
        if (seenTeams.has(teamId) || hasLeaderRoster.get(teamId, LEADER_NAME) !== undefined) {
          continue;
        }
        seenTeams.add(teamId);
        const info = insertLeaderRoster.run(teamId, leaderRole.role_id, LEADER_NAME, now, now);
        // 工号即主键：主持行同步班底行刚领到的自增号
        syncAnchor.run(Number(info.lastInsertRowid), Number(anchor.task_member_id));
      }
    }

    // 步骤 4（终审 B3）：每个现存容器任务按班底全员补建副本行——工号抄班底
    // 行自增主键、session_id 空；该成员该任务已有行（含 removed 锚定行）保持
    // 原状跳过。小任务不补：副本行只锚定大任务，小任务共享容器的副本行
    // （findInstanceRow 按根任务定位）。
    db.prepare(
      "INSERT INTO task_members (team_id, main_task_id, now_task_id, name, employee_id, " +
        "session_id, created_time, update_time) " +
        'SELECT tm.team_id, t.task_id, NULL, tm.role_name, tm.team_member_id, ?, ?, ? ' +
        'FROM task t JOIN team_members tm ON tm.team_id = t.team_id ' +
        'WHERE t.parent_id IS NULL AND tm.role_name IS NOT NULL ' +
        'AND NOT EXISTS (SELECT 1 FROM task_members x WHERE x.team_id = tm.team_id ' +
        'AND x.main_task_id = t.task_id AND x.name = tm.role_name)',
    ).run('', now, now);

    // 步骤 5：任务锚定副本行按名 join 本队班底行重键工号（v6 号来自 roles
    // 全局序列，v7 工号 = 班底主键）——join 不到的孤儿保留旧号（EXISTS 守卫
    // 防把它刷成 NULL）；领队主持行已在步骤 3 同步。
    db.exec(
      'UPDATE task_members SET employee_id = ' +
        '(SELECT tm.team_member_id FROM team_members tm ' +
        'WHERE tm.team_id = task_members.team_id AND tm.role_name = task_members.name) ' +
      'WHERE main_task_id IS NOT NULL AND EXISTS (' +
        'SELECT 1 FROM team_members tm WHERE tm.team_id = task_members.team_id ' +
        'AND tm.role_name = task_members.name)',
    );

    if (addMailEmployeeId) {
      // 步骤 6：旧邮件按收件成员名 join 班底行重键分箱工号，并把箱键改写成
      // 工号串（v7 按 (team_id, employee_id) 定箱——可解析的旧行换新箱，旧
      // 任务邮件按号送达）；解析不到的旧行保留名字分箱（仅显示兜底）
      db.exec(
        'UPDATE mail_messages SET ' +
          'employee_id = (SELECT tm.team_member_id FROM team_members tm ' +
          'WHERE tm.team_id = mail_messages.team_id AND tm.role_name = mail_messages.box_key), ' +
          "box_key = CAST((SELECT tm.team_member_id FROM team_members tm WHERE tm.team_id = mail_messages.team_id AND tm.role_name = mail_messages.box_key) AS TEXT) " +
          "WHERE box_key != 'captain' AND EXISTS (" +
          'SELECT 1 FROM team_members tm WHERE tm.team_id = mail_messages.team_id ' +
          'AND tm.role_name = mail_messages.box_key)',
      );
    }

    if (addAttemptRowId) {
      // 步骤 7：存量尝试按 task_id + 成员名 join 副本行回填（副本行挂根任务
      // ——task 的根 = parent_id ?? task_id）；解析不到保留 NULL，判定退按名
      db.exec(
        'UPDATE attempts SET task_member_id = ' +
          '(SELECT x.task_member_id FROM task_members x ' +
          'WHERE x.team_id = attempts.team_id AND x.name = attempts.member ' +
          'AND x.main_task_id = ' +
          '(SELECT COALESCE(t.parent_id, t.task_id) FROM task t WHERE t.task_id = attempts.task_id)) ' +
          'WHERE task_member_id IS NULL',
      );
    }

    // 步骤 8：执行链名字站点改工号站点（按本队班底按名解析；解析不到的
    // 站点保留名字，渲染时标注 legacy）
    const rosterByName = new Map<number, Map<string, number>>();
    for (const row of db
      .prepare(
        'SELECT team_id, role_name, team_member_id FROM team_members ' +
          'WHERE role_name IS NOT NULL ORDER BY team_member_id',
      )
      .all() as Array<{ team_id: number; role_name: string; team_member_id: number }>) {
      const byName = rosterByName.get(Number(row.team_id)) ?? new Map<string, number>();
      // v7 允许同名多行：首行（team_member_id 序）优先——legacy 名字站点
      // 只能解析到唯一命中，后续同名行不覆盖。
      if (!byName.has(row.role_name)) byName.set(row.role_name, Number(row.team_member_id));
      rosterByName.set(Number(row.team_id), byName);
    }
    const taskRows = db
      .prepare('SELECT task_id, team_id, member_chain_list FROM task')
      .all() as Array<{ task_id: number; team_id: number; member_chain_list: string }>;
    const writeChain = db.prepare('UPDATE task SET member_chain_list = ? WHERE task_id = ?');
    for (const row of taskRows) {
      let changed = false;
      try {
        const parsed = JSON.parse(row.member_chain_list) as unknown;
        if (!Array.isArray(parsed)) continue;
        const byName = rosterByName.get(Number(row.team_id));
        const stations = parsed.map((station) => {
          if (station === null || typeof station !== 'object') return station;
          const record = station as { member?: unknown };
          if (typeof record.member !== 'string') return station;
          const resolved = byName?.get(record.member);
          if (resolved === undefined) return station;
          changed = true;
          return { ...record, member: resolved };
        });
        if (changed) writeChain.run(JSON.stringify(stations), Number(row.task_id));
      } catch {
        continue; // 坏 JSON 由读端兜底（按无链处理），迁移不碰
      }
    }

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

/**
 * v8 迁移（领队标识列）：roles/team_members/task_members 三表补 is_leader
 * 列（项目牧羊人=1 其余=0，领队行查找按标识不按名）。全新库的 DDL 已是新
 * 形状（table_info 检测到三列，跳过 ALTER）；旧库 ALTER 补列后按保留名
 * 回填——roles/班底按角色名（role_name 副本悬空时经 roles join 兜底），
 * task_members 按成员名（领队主持行与领队任务副本行同置 1）。幂等：已补
 * 列的库重开只重复回填（自愈，不报错）。随 v4/v5 先例不显式开事务。
 */
function migrateLeaderFlagV8(db: DatabaseSync): void {
  const columnsOf = (table: string): string[] =>
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((c) => c.name);
  const rolesColumns = columnsOf('roles');
  const rosterColumns = columnsOf('team_members');
  const taskMemberColumns = columnsOf('task_members');
  // 三表都缺列 = 全新库 DDL 未跑（不会发生，防御）；任一表存在即继续。
  if (
    rolesColumns.length === 0 &&
    rosterColumns.length === 0 &&
    taskMemberColumns.length === 0
  ) {
    return;
  }
  if (rolesColumns.length > 0 && !rolesColumns.includes('is_leader')) {
    db.exec('ALTER TABLE roles ADD COLUMN is_leader INTEGER NOT NULL DEFAULT 0;');
  }
  if (rosterColumns.length > 0 && !rosterColumns.includes('is_leader')) {
    db.exec('ALTER TABLE team_members ADD COLUMN is_leader INTEGER NOT NULL DEFAULT 0;');
  }
  if (taskMemberColumns.length > 0 && !taskMemberColumns.includes('is_leader')) {
    db.exec('ALTER TABLE task_members ADD COLUMN is_leader INTEGER NOT NULL DEFAULT 0;');
  }
  // 回填（幂等自愈）：领队保留名 → 1，其余行保持 0。
  if (rolesColumns.length > 0) {
    db.exec(`UPDATE roles SET is_leader = 1 WHERE role_name = '${LEADER_NAME}'`);
  }
  if (rosterColumns.length > 0) {
    db.exec(
      `UPDATE team_members SET is_leader = 1 WHERE role_name = '${LEADER_NAME}' OR role_id IN ` +
        `(SELECT role_id FROM roles WHERE role_name = '${LEADER_NAME}')`,
    );
  }
  if (taskMemberColumns.length > 0) {
    db.exec(`UPDATE task_members SET is_leader = 1 WHERE name = '${LEADER_NAME}'`);
  }
}

/**
 * v9 迁移（路线 provider 列）：team_members/task_members 补 provider TEXT 列
 * （可空）。同 id 模型跨提供方（用户实测 tokenrouter 与 tr-test 都定义了
 * `z-ai/glm-5.3-free`、显示名不同）时，只存模型 id 无法区分用户选的是哪个
 * 提供方的目录项——显示按 id 反查会命中错误条目，spawn 也无法把正确的
 * provider 传给 agentOptions。全新库 DDL 已是新形状（列存在即跳过）；旧库
 * ALTER 补列，存量行保持 NULL（语义=跟随/旧数据，读端按目录反查兜底）。
 * 幂等：已补列的库重开无事可做。随 v4/v5/v8 先例不显式开事务。
 */
function migrateRouteProviderV9(db: DatabaseSync): void {
  const columnsOf = (table: string): string[] =>
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((c) => c.name);
  const rosterColumns = columnsOf('team_members');
  if (rosterColumns.length > 0 && !rosterColumns.includes('provider')) {
    db.exec('ALTER TABLE team_members ADD COLUMN provider TEXT;');
  }
  const taskMemberColumns = columnsOf('task_members');
  if (taskMemberColumns.length > 0 && !taskMemberColumns.includes('provider')) {
    db.exec('ALTER TABLE task_members ADD COLUMN provider TEXT;');
  }
  // 领队路线存储位搬迁（一次性，schema_meta 标记防重）：v9 起领队路线统一
  // 存班底领队行（team_members.is_leader=1，与成员同表同列——用户手改/
  // 查看都在 team_members），主持行只留会话锚。只搬班底行 model 为空的
  // （不覆盖用户更新）。
  if (rosterColumns.length === 0 || taskMemberColumns.length === 0) return;
  const marker = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'v9_leader_route_migrated'")
    .get() as { value: string } | undefined;
  if (marker !== undefined) return;
  const now = Date.now();
  db.prepare(
    "INSERT INTO schema_meta (key, value, created_time, update_time) VALUES (?, '1', ?, ?)",
  ).run('v9_leader_route_migrated', now, now);
  db.exec(
    `UPDATE team_members SET ` +
      `model = (SELECT tm.model FROM task_members tm WHERE tm.team_id = team_members.team_id ` +
      `AND tm.is_leader = 1 AND tm.main_task_id IS NULL LIMIT 1), ` +
      `provider = (SELECT tm.provider FROM task_members tm WHERE tm.team_id = team_members.team_id ` +
      `AND tm.is_leader = 1 AND tm.main_task_id IS NULL LIMIT 1), ` +
      `reasoning_effort = (SELECT tm.reasoning_effort FROM task_members tm WHERE tm.team_id = team_members.team_id ` +
      `AND tm.is_leader = 1 AND tm.main_task_id IS NULL LIMIT 1) ` +
      `WHERE is_leader = 1 AND model IS NULL`,
  );
}

/**
 * v10 迁移（班底头像副本列）：team_members 补 avatar TEXT 列——角色修改
 * 保存后按 role_id 随 roles.avatar 同步刷新（用户迭代：team_members 要有
 * 最新的角色信息，role_name/persona_md/profile 之外补齐头像；角色删除不
 * 进行同步）。全新库 DDL 已是新形状（列存在即跳过）；旧库 ALTER 补列后
 * 按 roles 回填（悬空 role_id 行刷成 NULL，与 v4 副本列同口径）。幂等：
 * 已补列的库重开只重复回填（自愈，不报错）。随 v4/v5/v8/v9 先例不显式
 * 开事务。
 */
const TEAM_MEMBER_AVATAR_BACKFILL_SQL =
  'UPDATE team_members SET ' +
  'avatar = (SELECT r.avatar FROM roles r WHERE r.role_id = team_members.role_id)';

function migrateTeamMemberAvatarV10(db: DatabaseSync): void {
  const columns = (
    db.prepare('PRAGMA table_info(team_members)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (columns.length === 0) return; // team_members 都不存在：不会发生（防御）
  if (!columns.includes('avatar')) {
    db.exec('ALTER TABLE team_members ADD COLUMN avatar TEXT;');
  }
  db.exec(TEAM_MEMBER_AVATAR_BACKFILL_SQL);
}

/**
 * v12 迁移（主对话注入角色标识列）：roles 补 is_root 列（保留角色
 * system=1 其余=0，注入行查找按标识不按名）。全新库的 DDL 已是新形状
 * （table_info 检测到列，跳过 ALTER）；旧库 ALTER 补列后按保留名回填——
 * 旧库不会有 system 行（播种随 ensureWorkspaceReady/ensurePresetMembers
 * 补上），UPDATE 幂等无行可改也自愈。随 v4/v5/v8 先例不显式开事务。
 */
function migrateRootFlagV12(db: DatabaseSync): void {
  const columns = (
    db.prepare('PRAGMA table_info(roles)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (columns.length === 0) return; // roles 不存在：不会发生（防御）
  if (!columns.includes('is_root')) {
    db.exec('ALTER TABLE roles ADD COLUMN is_root INTEGER NOT NULL DEFAULT 0;');
  }
  // 回填（幂等自愈）：保留名 system → 1，其余行保持 0。
  db.exec(`UPDATE roles SET is_root = 1 WHERE role_name = '${ROOT_ROLE_NAME}'`);
}

/**
 * v13 迁移（任务状态精简，用户迭代 2026-09-11）：11 态存量行回填到新 7 态
 * ——`draft`/`wait` → `ready`（草稿与就绪同义、等待派发并入 start 语义），
 * `wait_decision`/`failed` → `wait_user`（等用户统一）。blocked_from 列弃用，
 * 存量物化标记一并清空（列保留在库里，不 DROP——DROP 是单向门）。纯 UPDATE，
 * 不显式开事务（随 v4/v5 先例）。
 *
 * **必须一次性**（2026-09-11 回归修复）：`wait` 随后被重新引入（语义变为
 * 「待领队分诊」），若本迁移继续每次开库无条件执行，会把新语义的 wait 行
 * 洗成 ready——实测症状为任务失败落 wait 后一重启宿主就变回 ready、领队
 * 分诊入口消失。故按 v9 先例在 schema_meta 落一次性标记
 * `v13_task_status_migrated`，只跑一次；旧 wait 已在本标记写入前的那一轮
 * 处理完，新 wait 此后不再被触碰。
 */
function migrateTaskStatusV13(db: DatabaseSync): void {
  const columns = (
    db.prepare('PRAGMA table_info(task)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (columns.length === 0) return; // task 不存在：不会发生（防御）
  const marker = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'v13_task_status_migrated'")
    .get() as { value: string } | undefined;
  if (marker !== undefined) return;
  db.exec("UPDATE task SET status = 'ready' WHERE status IN ('draft','wait')");
  db.exec("UPDATE task SET status = 'wait_user' WHERE status IN ('wait_decision','failed')");
  if (columns.includes('blocked_from')) {
    db.exec('UPDATE task SET blocked_from = NULL WHERE blocked_from IS NOT NULL');
  }
  const now = Date.now();
  db.prepare(
    "INSERT INTO schema_meta (key, value, created_time, update_time) VALUES (?, '1', ?, ?)",
  ).run('v13_task_status_migrated', now, now);
}

/**
 * v14 迁移（问答弹窗落点列）：ask_questions 补 delivery_session_id（弹窗实际
 * 落在的会话 ID）与 delivery_is_main（1=主对话 / 0=提问子会话）——看板「决策
 * 面板」据此精确跳转到作答会话。全新库的 DDL 已是新形状（table_info 检测到
 * 列，跳过 ALTER）；旧库 ALTER 补列后把存量行的落点回填为提问会话自身
 * （历史行没有记录落点，只能退化为提问会话；is_main 保持 NULL=未知）。随
 * v4/v5/v10 先例不显式开事务、重开重跑=自愈。
 */
function migrateAskDeliveryV14(db: DatabaseSync): void {
  const columns = (
    db.prepare('PRAGMA table_info(ask_questions)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (columns.length === 0) return; // ask_questions 不存在：不会发生（防御）
  if (!columns.includes('delivery_session_id')) {
    db.exec('ALTER TABLE ask_questions ADD COLUMN delivery_session_id TEXT;');
  }
  if (!columns.includes('delivery_is_main')) {
    db.exec('ALTER TABLE ask_questions ADD COLUMN delivery_is_main INTEGER;');
  }
  db.exec(
    'UPDATE ask_questions SET delivery_session_id = asking_session_id ' +
      'WHERE delivery_session_id IS NULL',
  );
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
-- ETeams SQLite schema v14（db_schema_version = 14；v3 成员=角色合并：member
-- 表精简改名成 roles 角色库表（去 team_id/role_id/model/reasoning_effort，
-- 新增 profile），班底另起 team_members 表，旧 roles 标签登记表删除；
-- v4 班底行补 role_name/persona_md/profile 角色信息副本列；v5 任务行补主
-- 会话快照列（session_id）；v6 会话列归位：task.session_id 改名
-- main_session_id，task_members 两列会话合并成 session_id（本行自己的子
-- 代理会话）；v7 工号挪到班底（表自增）：工号 = team_members 行的自增主键
-- （AUTOINCREMENT 只增不复用），班底/团队表不加新列；roles.employee_id 弃用
-- ——列保留不读写；mail_messages 补 employee_id 分箱列、attempts 补
-- task_member_id 副本行列；v8 领队标识列：roles/team_members/task_members
-- 补 is_leader（项目牧羊人=1 其余=0，领队行查找按标识不按名；旧库经 getDb
-- 迁移回填）；v9 班底/任务成员补 provider 路线列；v10 班底行补 avatar 头像
-- 副本列（角色修改保存后随 roles.avatar 按 role_id 同步刷新，角色删除不
-- 进行同步；旧库经 getDb 迁移回填）；v11 子代理用户问答单：新增
-- ask_questions 表（子代理向用户弹问答的路由状态——用户在本会话就地弹/
-- 不在则转交主会话弹出；独立行 CRUD，不随 TeamState 整存整取重写；纯新表
-- 由 DDL IF NOT EXISTS 直接建，无需 ALTER/回填）；v12 主对话注入角色：
-- roles 补 is_root（保留角色 system=1 其余=0——system 的 persona_md 存注入
-- 主对话 system 提示词的原文，默认空；旧库经 getDb 迁移回填）；v13 任务状态
-- 精简（用户迭代 2026-09-11）：11 态 → 7 态——draft/ready/wait 并入 ready，
-- wait_decision/failed 并入 wait_user（旧库经 getDb 迁移回填状态值）；随后
-- 又恢复独立 wait=待领队分诊（8 态，语义与旧 wait 不同：失败自动重试超限落
-- wait，领队分诊后 loop 回 ready 或升级 wait_user——TEXT 枚举无结构变更）；
-- task.blocked_from 列弃用不再读写（列保留不 DROP），status 列默认值改 ready；
-- v14 问答弹窗落点列：ask_questions 补 delivery_session_id（弹窗实际落在的
-- 会话 ID）与 delivery_is_main（1=主对话 / 0=提问子会话）——看板「决策面板」
-- 据此精确跳转到作答会话（旧库经 getDb ALTER + 按提问会话回填）
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
  has_leader     INTEGER NOT NULL DEFAULT 0,   -- 是否包含领队（0/1）；主会话快照在 task 行（main_session_id），领队子代理会话在 task_members 领队行
  created_time   INTEGER NOT NULL,             -- 创建时间
  update_time    INTEGER NOT NULL              -- 更新时间
);

CREATE INDEX IF NOT EXISTS idx_team_update_time ON team (update_time DESC);

-- ---------------------------------------------------------------------
-- 2. roles —— 角色库（原 member 公共模板行并成角色表；成员=角色，全局一份）
--    代码里的预置角色首次启动写入；角色构建师确认的新角色、面板/工具加
--    成员时的新名字也写进来。人设/头像挂在角色行上；工号 v7 起挪到
--    team_members 班底行（表自增主键即工号）——本表 employee_id 列弃用：
--    列保留、全链路不再读写（DROP 是单向门，旧版 lib 打新库会 no such column）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  role_id        INTEGER PRIMARY KEY AUTOINCREMENT,  -- 角色 ID，自增（team_members.role_id 引用它）
  role_name      TEXT NOT NULL,                -- 角色名（成员名=角色名；全库唯一，写入代码查重）
  employee_id    INTEGER,                      -- 【v7 弃用】工号已挪到 team_members（表自增主键即工号）；列保留不读写，旧库回滚兼容
  is_leader      INTEGER NOT NULL DEFAULT 0,   -- 领队标识（v8）：项目牧羊人=1 其余=0；写入层由保留名派生，读端按标识取领队
  is_root        INTEGER NOT NULL DEFAULT 0,   -- 主对话注入角色标识（v12）：保留角色 system=1 其余=0；写入层由保留名派生，读端按标识取行
  persona_md     TEXT,                         -- 完整角色手册（Markdown 全文；duty/style/skills 等结构字段写入时烘进手册）
  profile        TEXT,                         -- 一句话简介（列表卡片/详情头展示；独立成列，不再烘进 persona_md）
  avatar         TEXT,                         -- 头像
  created_time   INTEGER NOT NULL,             -- 创建时间
  update_time    INTEGER NOT NULL              -- 更新时间
);

-- ---------------------------------------------------------------------
-- 3. team_members —— 班底（团队 × 角色：一行一个在队成员 + 该队派发路线；
--    v7 起是工牌发放处：工号 = 本表自增主键（AUTOINCREMENT 只增不复用，
--    全机器唯一），允许同名同角色多行，人员身份键 = 工号；人设/头像经
--    role_id 松引用解析自 roles；role_name/persona_md/profile/avatar 是随角色行
--    同步刷新的副本列（v4/v10，真相在 roles）；执行实例（状态/会话/当前任务）
--    在 task_members）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS team_members (
  team_member_id   INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键 = 工号（v7 表自增；显示补零 1 → 0001；内存新建行 0 落库发号）
  team_id          INTEGER NOT NULL,    -- 属于哪个团队（team.team_id）
  role_id          INTEGER,             -- 角色 ID（roles.role_id，松引用；人设/头像在角色行上）
  role_name        TEXT,                -- 角色名副本（写入时随 roles.role_name 同步刷新；悬空行 NULL；直查/展示用）
  persona_md       TEXT,                -- 角色手册副本（写入时随 roles.persona_md 同步刷新；真相在 roles）
  profile          TEXT,                -- 一句话简介副本（写入时随 roles.profile 同步刷新；真相在 roles）
  avatar           TEXT,                -- 头像副本（v10：写入时随 roles.avatar 按 role_id 同步刷新；真相在 roles；悬空行 NULL）
  model            TEXT,                -- 该队派发路线：模型 id；NULL=会话默认（settings agent-default-model），有值=覆盖
  provider         TEXT,                -- 覆盖路线的目录 provider（v9 同 id 模型跨提供方歧义，用户迭代 2026-09-08）；NULL=跟随/旧数据
  reasoning_effort TEXT,                -- 模型思考强度
  is_leader        INTEGER NOT NULL DEFAULT 0,  -- 领队标识（v8）：班底领队行=1 其余=0；写入层由保留名派生，读端按标识取领队
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
  member_chain_list TEXT NOT NULL DEFAULT '[]',  -- 执行链站点列表（JSON 数组：[{member, stageBrief}]；v7 站点 member 写工号数字，迁移解析不到班底行的旧站点保留名字字符串并在渲染时标注 legacy）
  chain_cursor      INTEGER NOT NULL DEFAULT -1, -- -1=没开始；k=第 k 站完成；末站完成→completed
  status            TEXT NOT NULL DEFAULT 'ready',
                    -- creating / ready / start / wait / paused / wait_user /
                    -- completed / cancelled（用户迭代 2026-09-11：精简为 7 态后
                    -- 又恢复独立 wait=待领队分诊 = 8 态；大任务 completed 可回 ready）
  current_member    TEXT,                -- 当前执行成员名（松引用：成员移除也不影响这列）
  current_member_id INTEGER,             -- 当前执行成员 ID（v2 的 member.member_id 口径随 v3 合并废弃；写入代码恒置 NULL，物理残留列）
  main_session_id   TEXT,                -- 主会话 ID 快照（v5 落列 v6 改名：建任务时登记的主会话 ID，落库后不变；直查/展示用）
  retry_count       INTEGER NOT NULL DEFAULT 0,  -- 当前执行人连续失败次数（换人清零）
  status_note       TEXT,                -- 当前状态说明（挂起原因等也并在这列）
  contract_md       TEXT,                -- 任务合同全文（Markdown，十六轮 DA29：原 acceptance/in_scope/out_of_scope/deliverables 四数组列合并——验收标准/允许改动/禁止改动/交付物统一写在这篇 MD 里；旧库由 getDb 迁移 ALTER + 回填，旧四列物理残留不再读写）
  idempotency_note  TEXT,                -- 幂等说明（重跑安全的前提，派发提示词渲染）
  blocked_from      TEXT,                -- 阻塞前的状态（11 态之一）；解除阻塞时还原到它，NULL=未阻塞
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
-- 5. task_members —— 任务成员副本（有会话锚点；v7：建任务/加成员
--    时从班底整行复制，工号抄班底行自增主键，行生命周期跟随
--    所属大任务——删任务→副本级联删）
--    领队也是一行：name='项目牧羊人'、main_task_id 为空（团队级主持行，
--    不是工牌——领队子会话的锚 + has_leader 载体）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_members (
  task_member_id   INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
  team_id          INTEGER NOT NULL,    -- 属于哪个团队（team.team_id，写入代码维护；领队行也带，删除/统计/领队行定位都按它过滤）
  main_task_id     INTEGER,             -- 实例行所属大任务 ID（task.task_id；独立无链任务=自身 id）；NULL=团队级行（领队主持行）
  now_task_id      INTEGER,             -- 当前执行任务 ID（task.task_id）
  name             TEXT NOT NULL,       -- 成员名（显示用；允许同名，身份判定按工号/行 id）
  employee_id      INTEGER,             -- 工号（v7 表自增：建任务/加成员时抄自班底行 team_member_id；主持行同步班底领队行）
  session_id       TEXT NOT NULL DEFAULT '',  -- 本行自己的子代理会话 ID（v6：成员行=成员子会话，领队行=领队子代理会话）；还没启动时是空串
  status           TEXT NOT NULL DEFAULT 'staged',
                   -- 【弃用】成员状态枚举已随「成员没有状态」迭代全链路下线
                   -- （列保留不读写，同 roles.employee_id 口径——DROP 是单向门）；
                   -- 写入端不再落该列（恒为 DDL 默认），旧库残留值不再被读
  persona_md       TEXT,                -- 执行时的人设手册（沿用 roles 角色行的手册，可按任务微调）
  model            TEXT,                -- 执行时采用的模型（沿用 team_members 班底路线；NULL=跟随）
  provider         TEXT,                -- 覆盖路线的目录 provider（v9，同班底行口径；NULL=跟随/旧数据）
  reasoning_effort TEXT,                -- 模型思考强度
  avatar           TEXT,                -- 头像
  is_leader        INTEGER NOT NULL DEFAULT 0,  -- 领队标识（v8）：领队行（含副本）=1 其余=0；写入层由保留名派生，读端按标识取领队
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
  member        TEXT NOT NULL,        -- 执行成员名（显示保留；归属判定按 task_member_id 副本行，v7）
  task_member_id INTEGER,             -- 执行副本行 id（v7：task_members.task_member_id——claim/汇报按它定行，同名成员不串 attempt；旧数据 NULL 时判定退按名兜底）
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
  box_key      TEXT NOT NULL,        -- 收件箱键（v7：成员=工号十进制串、领队='captain'；旧库行=收件成员名，仅显示兜底）
  employee_id  INTEGER,              -- 收件成员工号（v7 分箱真相：(team_id, employee_id) 定箱，同名不串箱；领队箱与解析不到的旧行 NULL）
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
);

-- ---------------------------------------------------------------------
-- 13. ask_questions —— 子代理用户问答单（v11；eteams_ask_user 的路由状态）
--     提问子代理（领队/成员）需要用户决策时：用户正在看本会话（presence
--     心跳）就地弹；否则转交主会话弹出，提问方阻塞轮询本表等答案。ask_id
--     由调用方生成（uuid），不走自增——主键即幂等键，重复提交按 id 去重。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ask_questions (
  ask_id         TEXT PRIMARY KEY,     -- 问答单 ID（uuid，调用方生成）
  team_id        INTEGER NOT NULL,     -- 属于哪个团队（team.team_id）
  asking_session_id TEXT NOT NULL,     -- 提问子代理会话 ID（答案回流对账）
  asking_name    TEXT NOT NULL,        -- 提问者展示名（成员名 / '领队'；主会话转弹时向用户说明来源）
  asking_kind    TEXT NOT NULL,        -- 提问者类型：captain / member / conversation（绑定主会话）
  main_task_id   INTEGER,              -- 相关大任务 ID（task.task_id，松引用）
  questions      TEXT NOT NULL,        -- 问题列表（JSON：[{id, question, header?, options:[{label, description?}], multiSelect?}]）
  answers        TEXT,                 -- 答案列表（JSON：[{id, selected, custom?}]）；NULL=未答
  status         TEXT NOT NULL DEFAULT 'pending',
                 -- pending=待作答 / answered=已答 / expired=超时 / cancelled=中断
  relay_session_id TEXT,                -- 转交目标主会话 ID（就地弹=提问会话自身，旧字段，审计用）
  delivery_session_id TEXT,             -- 弹窗实际落点会话 ID（v14；看板「决策面板」跳转目标）
  delivery_is_main INTEGER,             -- 1=落点为主对话 / 0=提问子会话 / NULL=未知（v14）
  created_time   INTEGER NOT NULL,     -- 创建时间
  answered_time  INTEGER,              -- 作答时刻；NULL=未答
  update_time    INTEGER NOT NULL      -- 更新时间
);

CREATE INDEX IF NOT EXISTS idx_ask_questions_status ON ask_questions (status);
CREATE INDEX IF NOT EXISTS idx_ask_questions_team   ON ask_questions (team_id, status);`;
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

/**
 * 剥除手册开头的 YAML frontmatter 围栏（仅识别文档首块的成对 `---`，
 * CRLF 兼容；无围栏原样返回）。
 *
 * persona_md 只存正文：frontmatter（name/description/emoji/color）不落库。
 * 它没有任何消费方，而写进去只会坏渲染——读侧宿主 MarkdownText 无
 * frontmatter 扩展（`---` 变分隔线、后面几行被末尾 `---` 吞成 setext 标题），
 * 编辑侧 MDXEditor 又把它变成不可见的弹窗节点。写库时剥掉，读路径按普通
 * Markdown 原样读出，两端都不必再做「这段是不是 frontmatter」的判断。
 */
const FRONTMATTER_FENCE_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
export function stripFrontmatter(md: string): string {
  return md.replace(FRONTMATTER_FENCE_RE, '');
}

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
  // 手册开头的 frontmatter 不落库（见 stripFrontmatter）：剥完为空则整本
  // 只剩结构摘要。
  const manual =
    persona.personaMd === undefined ? '' : stripFrontmatter(persona.personaMd.trim()).trim();
  const playbook =
    manual !== '' ? `${summary}\n\n---\n\n# 角色手册\n\n${manual}` : summary;
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

/** 内存模型路线（model 空 = 跟随）→ member/task_members 三列（v9 加 provider）。 */
export function routeToColumns(
  route: ModelRouteSnapshot,
): { model: string | null; provider: string | null; effort: string | null } {
  return {
    model: route.model === '' ? null : route.model,
    // provider 只在有覆盖模型时有意义（会话默认整体跟随，provider 随默认走）。
    provider:
      route.model === '' || route.provider === undefined || route.provider === ''
        ? null
        : route.provider,
    effort:
      route.reasoningEffort === undefined || route.reasoningEffort === ''
        ? null
        : route.reasoningEffort,
  };
}

/** member/task_members 三列 → 内存模型路线（provider NULL/旧数据缺省 = 未记录）。 */
export function routeFromColumns(
  model: string | null,
  provider: string | null,
  effort: string | null,
): ModelRouteSnapshot {
  return {
    model: model ?? '',
    ...(model !== null && model !== '' && provider !== null && provider !== ''
      ? { provider }
      : {}),
    ...(effort !== null && effort !== '' ? { reasoningEffort: effort } : {}),
  };
}