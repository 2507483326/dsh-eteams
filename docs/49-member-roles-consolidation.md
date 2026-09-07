# 49 成员=角色合并：member 表并入 roles + 新增 team_members 班底表（DB v2→v3）

> 状态：**定案（2026-09-06 用户定稿）——已实施，typecheck 与 382 用例全绿**。
> 同日 v4 增补（team_members 补角色信息副本列，用户：团队成员表补上 role_name、persona_md 和 profile）见 §49.6。
> 一句话：旧 `member` 表身兼「全局角色库」与「团队班底」两职，与旧 `roles` 标签登记表内容大量重复、人设存两份；v3 把 member 精简改名成 **roles 角色库表**（成员=角色，全局一份），班底另起 **team_members** 表，旧 roles 标签登记表删除，`DB_SCHEMA_VERSION` 2→3。

## 49.1 动机

v2 现状里两张表分工拧巴：

- `member` 表身兼两职：`team_id` 为空 = 全局公共角色模板行（成员库），`team_id` 非空 = 各团队班底模板行；工号、人设手册、头像、模型路线都在这张表上。
- `roles` 表只是角色标签登记处：role_id 解析 + persona_md / description / source，与 member 行内容大量重复。

痛点：

1. **人设存两份**：member 行和 roles 行各有 persona_md，改一处要靠「同步到该角色」兜底，写路径多一步、易漂移。
2. **字段重复**：employee_id、avatar、role_name 两张表各一份；roles.description 宿主从未读、roles.source 只在播种时写过。
3. **概念负担**：「成员模板」与「角色标签」两个概念并存，而用户心智本就是**成员=角色，全局一份**——一个名字就是一个角色，人设/工号/头像都挂在这个角色上。

用户定稿目标模型：**成员=角色，全局一份**。

## 49.2 新模型（v3 DDL）

`schema.sql` 与 `db.ts` 内嵌 `SCHEMA_SQL` 逐字一致，以下为两张变更表（其余表不动）：

```sql
-- 2. roles —— 角色库（原 member 公共模板行并成角色表；成员=角色，全局一份）
CREATE TABLE IF NOT EXISTS roles (
  role_id        INTEGER PRIMARY KEY AUTOINCREMENT,  -- 角色 ID，自增（team_members.role_id 引用它）
  role_name      TEXT NOT NULL,                -- 角色名（成员名=角色名；全库唯一，写入代码查重）
  employee_id    INTEGER,                      -- 工号：插入角色行时取 roles 表最大工号 +1，同人同号；显示补零 1 → 0001
  persona_md     TEXT,                         -- 完整角色手册（Markdown 全文；duty/style/skills 等结构字段写入时烘进手册）
  profile        TEXT,                         -- 一句话简介（列表卡片/详情头展示；独立成列，不再烘进 persona_md）
  avatar         TEXT,                         -- 头像
  created_time   INTEGER NOT NULL,
  update_time    INTEGER NOT NULL
);

-- 3. team_members —— 班底（团队 × 角色：一行一个在队成员 + 该队派发路线）
CREATE TABLE IF NOT EXISTS team_members (
  team_member_id   INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键（内存新建行 0 落库发号）
  team_id          INTEGER NOT NULL,    -- 属于哪个团队（team.team_id）
  role_id          INTEGER,             -- 角色 ID（roles.role_id，松引用；人设/工号/头像都在角色行上）
  model            TEXT,                -- 该队派发路线；NULL=会话默认（settings agent-default-model），有值=覆盖
  reasoning_effort TEXT,                -- 模型思考强度
  created_time     INTEGER NOT NULL,
  update_time      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members (team_id);
```

归一与语义决定（均按库内惯例/用户拍板）：

- 引用列名取 **`role_id`**（用户原话 roles_id——与 task_members 既有列及命名惯例一致归一）；时间列按惯例 **`created_time` / `update_time`**（原话 create_time 归一）。
- roles 表**不带**旧 `description / source` 列：宿主从未读 description，source 只在播种时写过。
- **profile 一句话简介独立成列**：写路径（personaToMd）不再烘 `- 简介：` 行；读路径（personaFromMd）保留旧行解析作回退，读端一律列值优先。
- **人设单一来源**：班底成员的 persona 读 = roles 角色行（成员详情与角色详情从此同源）；改成员手册 = 改角色定义，**全局生效**。执行实例行 `task_members` 的 persona_md / model / reasoning_effort / avatar 列保持不动——建行时快照语义，角色行编辑默认不回填存量实例行。
- **task_members.role_id 列删除**：宿主代码恒写 null 的死列。
- **工号 = roles.employee_id，同人同号**：班底不再各自带工号列；给成员显式指定工号 = 改写角色行的工号（全局 redefine）。加成员即入库：添加成员时写入代码在同一事务里确保角色行存在（缺则按名自建，带人设/简介/头像/工号），已有行做缺号回填与显式改号。
- **删除守卫**：角色名下还有非 removed 的 task_members 实例行（在队成员）时，删除角色被拒绝（「先从团队移除再删除」）；实例行全 removed 的休眠班底行不挡删除，删队后悬空的 team_members 行由读路径防御性跳过。

## 49.3 迁移（v2 旧库 → v3）

`getDb` 首次连接时执行 `migrateMemberRolesV3`，形状检测（member 表存在才做），单事务：

| 步骤 | 内容 |
|---|---|
| 1 | 旧表改名：`roles` → `roles_legacy`、`member` → `member_legacy` |
| 2 | 跑 v3 DDL：新建新形状 `roles` / `team_members` |
| 3 | member 公共行（`team_id` NULL）→ roles 角色行：工号/手册/头像原样，`profile` 用 personaFromMd 从手册 `- 简介：` 行提取；旧 roles 标签行按 role_name **补缺**（同名不覆盖）——发新号不显式复用原 role_id（roles_legacy 与 member_legacy 两套自增序列同号起步，显式复用会撞新表主键；role_id 本就是松引用，发新号无碍） |
| 4 | member 团队行（班底）→ team_members 行：`team_member_id` = 原 member_id；`role_id` 按名解析，缺则从该班底行**自建**角色行（工号/头像/手册一并带上）；`model / reasoning_effort` 搬列 |
| 5 | `DROP TABLE member_legacy / roles_legacy`；`ALTER TABLE task_members DROP COLUMN role_id`（列存在才做） |

- 全新库（无 member 表）直接跳过，DDL 即新形状、迁移零操作。
- 旧库 schema_meta 版本号不回写（随 v1→v2 迁移先例）。
- 幂等：关连接重开（迁移重入）不再改写、不报错。

## 49.4 行为变化（面板/宿主视角）

| 场景 | v2 | v3 |
|---|---|---|
| 名册页（角色库） | 读 member 公共行 + roles 标签表两处 | 直读 roles 表一条 SELECT；条目模型去 model/reasoningEffort（路线归班底） |
| 名册页改角色 | 改 member 行 + 「同步到该角色」兜底写 roles | 改 roles 行一处，全局生效 |
| 加成员（面板/领队） | 班底行 + 可能漏角色行（另查名册） | **加成员即入库**：同一事务确保角色行存在 |
| 显式指定工号 | 班底行各自带工号 | 改写角色行工号（同人同号全局生效）；同名复制不再继承显式号 |
| 成员详情改手册 | 改班底模板 + 手动同步 | 改手册即改角色定义（全局生效） |
| 模型路线 | member 模板行带 model/effort | 落 team_members（每队一条）；成员模板无路线概念 |
| 删除角色 | 直接删行 | 在队（非 removed 实例行存在）拒绝删除；移出后可删 |
| 删团队 | 清 member 班底行 | 清 team_members 班底行；roles 角色行不动（全局共享） |
| 团队页成员视图 | memberView | 形状不变，增量加 `profile` 字段 |
| 客户端 API | RosterMember/NewMemberInput 带 model/reasoningEffort | 两类型去 model/reasoningEffort；详情保存不再重发路线 |

## 49.5 验收

- **四绿门**：`npm run typecheck`（host + client）全绿；`npm test`（vitest）28 个文件 / 380 用例全部通过。
- **迁移锁**（tests/store.test.ts 新增 v2→v3 describe，仿 v1→v2 形状检测模式）：旧 member+roles 表带数据 → 断言新 roles（公共行工号/手册/头像原样、profile 从 `- 简介：` 行提取、旧标签行补缺且不撞新表主键、班底行自建角色行带工号手册）、team_members（班底行搬表、role_id 按名解析、model/effort 搬列）、旧表已删、task_members 的 role_id 列移除且行数不丢、迁移幂等（重开连接零改写）。
- **行为锁**：captainDispatch 用例改断言 v3 自愈式角色入库（不再预插 roles 行）；webui 用例断言直加成员进名册（加成员即入库）且显式工号改写角色行、同名复制拿新号。
- **面板手工链路未验证声明**：名册页增删改（profile 列生效）→ 建队加成员 → 成员详情改手册同步角色库 → 改模型路线重启读回 → 在队角色删除被拒/移出后可删 → 删队后 team_members 清空——待装机 GUI 冒烟。
- **本轮不动**：`src/host/tools/captainTools.ts` 与 `src/host/index.ts`（其调用方收口由并行修复线程承担）。

## 49.6 v4 增补（2026-09-06 同日）：班底行补角色信息副本列

用户追加需求：**团队成员表（team_members）补上 role_name、persona_md、profile**。定案口径：三列是**随 roles 角色行同步刷新的副本**，真相仍在 roles——不回退到 v2 的「人设存两份」，改角色依旧全局生效；副本列只服务**直查/展示**（不 JOIN 就能拿角色名/手册/简介），`DB_SCHEMA_VERSION` 3→4。

```sql
-- v4 的 team_members（真相在 roles；三列副本写入时随角色行同步刷新）
CREATE TABLE IF NOT EXISTS team_members (
  team_member_id   INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键（内存新建行 0 落库发号）
  team_id          INTEGER NOT NULL,    -- 属于哪个团队（team.team_id）
  role_id          INTEGER,             -- 角色 ID（roles.role_id，松引用；人设/工号/头像都在角色行上）
  role_name        TEXT,                -- 角色名副本（写入时随 roles.role_name 同步刷新；悬空行 NULL；直查/展示用）
  persona_md       TEXT,                -- 角色手册副本（写入时随 roles.persona_md 同步刷新；真相在 roles）
  profile          TEXT,                -- 一句话简介副本（写入时随 roles.profile 同步刷新；真相在 roles）
  model            TEXT,                -- 该队派发路线；NULL=会话默认（settings agent-default-model），有值=覆盖（provider 派发时按配置解析）
  reasoning_effort TEXT,                -- 模型思考强度
  created_time     INTEGER NOT NULL,
  update_time      INTEGER NOT NULL
);
```

**同步口径（写路径落库后统一从 roles 反查回填，不从内存 persona 取值——同源语义：已有角色行优先，避免把内存快照烘进库）**：

| 写路径 | 副本刷新动作 |
|---|---|
| 快照落库（writeTeamInTx，含加成员） | 本队班底行插入后按 team_id 全量刷新 |
| 名册 upsert / 预设手册升级（roster.ts） | 按 roles.role_id 刷新引用行 |
| 成员详情改手册（teamOps.updateMember） | 按 roles.role_id 刷新 |
| 角色删除（removeRosterMember） | 删行后引用它的班底行三列置 NULL（悬空行） |
| 旧版团队导入（import.ts） | 本队班底行落库后按 team_id 刷新 |

- 副本刷新不碰 `update_time`（镜像同步不算行变更）；悬空行刷 NULL 与 loadMembers 防御性跳过同口径；读端（loadMembers）仍走 LEFT JOIN roles 以角色行为准，副本列不参与判定。
- **迁移（v3→v4）**：`getDb` 首次连接时 `migrateTeamMemberRoleColumnsV4`——形状检测（PRAGMA table_info 缺哪列补哪列）ALTER 三列 + 相关子查询从 roles 回填（悬空 role_id 行刷 NULL）；v3 迁移（v2→v3）事务内新落的班底行也在 COMMIT 前跑同一条回填。幂等：已补列的库重开只重复回填（自愈，不报错）。
- **验收**：typecheck 全绿；vitest 28 文件 / **382 用例**全过——新增 v3→v4 迁移用例（补列 + 引用行回填 + 悬空行 NULL + 重开幂等）、v2→v3 迁移用例追加镜像断言、快照用例追加「写路径回填 + 同名角色行不被内存 persona 覆盖」断言；schema.sql 与 db.ts 内嵌 SCHEMA_SQL 程序化 diff 逐字一致。旧 v3 库（含用户现库）重启宿主后自动 ALTER + 回填，无需手工操作。