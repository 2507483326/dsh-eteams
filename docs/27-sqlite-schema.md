# 27 SQLite 表结构设计（角色 / 团队 / 任务统一存储）

> 状态：**定案（2026-09-04）——进入执行**。存储真相直接切 SQLite（不做投影过渡），首次启动把现有文件数据一次性导入；缺列已逐条与用户对完账，最终口径：**team 表零新增列（团队只是流程容器：不要目标/阶段/进展，工作目录归 task）；task 表补合同四数组 + idempotency_note + blocked_from + work_dir 七列；member 表是纯模板（无状态无会话），状态与会话锚点全在 task_members**。
>
> 字段基线：[src/host/model/types.ts](../src/host/model/types.ts)——表里每个字段都能在 types.ts 找到对应；两处有出入时以 types.ts 为准。
>
> token 记账不进这个库：token 消耗逐条记在状态根下的 usage.jsonl 里（全局单库下就是全局根那份，用量台账跨工作区合一），读取时现聚合；本库只管角色/团队/任务数据，不设 token 表。（2026-09-05 修订：token 改为入库——`usage_detail` / `usage_daily_total` 两表进本库，usage.jsonl 台账退役；见 §27.5 尾部两表。）
>
> 表上不留外键、CHECK、UNIQUE、触发器——每张表只有列定义、主键、普通索引，规则全部由写入代码保证。
>
> 2026-09-04 用户改版定稿：表精简为 11 张（team / roles / member / task / task_members + attempts / events / mail_messages / decisions / task_status_changes + schema_meta）；**主键 = 每张表自己的编号列，统一整数自增**（team_id / role_id / member_id / task_id / task_member_id / attempt_id / decision_id / seq / change_id；schema_meta 例外，key 即主键）；**每张表最后两列固定 created_time / update_time**，时间相关列一律 `_time` 结尾；**工号 = member.employee_id 列，数据库递增发号**（显示补零，1 → 0001，即 ET-0001）；**库文件放状态根的 `db/` 子目录——状态根 = `<状态根>/db/`，默认配置 `stateDir: C:/Users/epat/.eteams` 为绝对路径即全局单库（2026-09-04 用户定案：所有工作区共用一个 eteams.db、一份成员库；stateDir 配相对路径才是旧口径 per-workspace `<workspace>/.eteams`）**。
>
> 2026-09-06 用户改版定稿（v3，成员=角色）：**member 表并入 roles 角色库表**——去掉 team_id / role_id / model / reasoning_effort，新增 profile（一句话简介列），人设/工号/头像/简介都挂角色行，成员=角色全局一份；**班底另起 team_members 表**（team_member_id / team_id / role_id / model / reasoning_effort），人设/工号/头像经 role_id 松引用解析自角色行；旧 roles 标签登记表删除；task_members 的 role_id 死列移除；工号改在 roles.employee_id 上发号（同人同号）。v2 旧库 getDb 首次连接时单事务迁移：公共行→roles 角色行、班底行→team_members、旧标签行按名补缺。
>
> 2026-09-06 同日增补（v4，班底行角色信息副本）：**team_members 补 role_name / persona_md / profile 三列**——随 roles 角色行同步刷新的副本（真相在 roles），给直查/展示用，不改「人设单一来源」语义：班底成员读人设仍以角色行为准，改角色全局生效。写入路径（快照落库/名册 upsert/成员详情改手册/预设手册升级/旧版导入）落库后统一从 roles 回填镜像，角色删除时引用行刷成 NULL（悬空行，读路径防御性跳过）；v2/v3 旧库 getDb 首次连接时 ALTER 补列 + 回填。
>
> 2026-09-06 同日增补（v5，任务行主会话快照）：**task 补 session_id 列**——建任务时盖章该团队领队行（task_members，`name='项目牧羊人'`、`main_task_id` 为空）锚定的主会话 ID，**快照语义：落库后不变**，领队重锚不回改旧任务；面板/对话工具建任务、旧版团队导入三路同源取值；v4 旧库 getDb 首次连接时 ALTER 补列 + 只对 NULL 行从领队行回填（已盖章行不覆盖）。
>
> 2026-09-07 用户改版定稿（v6，会话列归位）：**主会话 ID 只属于任务行**——`task.session_id` 改名 `main_session_id`（v5 快照语义不变）；`task_members` 只记**本行自己的子代理会话**：`main_session_id` 改名 `session_id`（成员行=成员子会话，领队行=领队子代理），`child_session_id` 列合并消失；team 表不存会话列（team 属于多个 task，团队级锚点按任务行快照 ∪ 心跳派生，建队主会话记进 team.created 事件留痕）。

## 27.1 为什么引入 SQLite

- **跨团队视图缺统一存储**：状态按团队目录分片（每个团队一个 team.json），跨团队的东西（成员库、跨团队统计）只能逐目录读文件再内存拼装，面板每次轮询都重算一遍。
- **看板/任务页的统计在 JSON 上表达不出来**：成员待派统计、任务单进度、状态流转时长、按类型筛事件——这些用 SQL 是一句话，JSON 只能整读 + 内存算，1 秒轮询下反复做。
- **事件日志只能顺序扫**：events.jsonl 能查但不能按维度聚合（按任务/类型/成员过滤要整文件遍历）。
- **单写者保证可以下沉到存储层**：现在靠进程内锁 + 约定；SQLite（WAL）原生提供「单写多读」与事务原子性。
- **token 看板曾是本设计的触发点之一，已定案不进 SQLite**：token 消耗按事件逐条记在独立日志文件（usage.jsonl），读取时聚合、不落日汇总。（2026-09-05 修订：改入 SQLite 两表 `usage_detail` / `usage_daily_total`，台账文件退役。）

**本轮范围**：

| 做 | 不做 |
|---|---|
| 表结构（DDL）、索引、删除规则 | 建库/读写代码、引入依赖 |
| JSON ↔ 表的字段映射与序列化策略 | 从 team.json 导入历史数据 |
| 查询场景预设（验证索引设计） | 改变磁盘真相（文件仍为主） |
| 迁移路线草图（双写/切换/版本号/事务边界） | 修改 docs/ 之外的任何文件 |

**选型史**：v0.2 时曾明确放弃 SQLite，理由是「引原生依赖、加迁移负担，收益只在有复杂查询时成立」。现在两个前提变了：① 复杂查询需求成立（跨团队聚合、流转分析）；② Node 内置了 SQLite 模块，「原生依赖」这条顾虑消失。若决定落地，需在 README 决策记录追加一条，并回改旧选型结论。

## 27.2 驱动选型：`node:sqlite`（内置） vs `better-sqlite3`

| 维度 | `node:sqlite`（内置） | `better-sqlite3` |
|---|---|---|
| 依赖 | Node ≥22.13 内置，0 依赖（运行时 dependencies 保持空集） | 原生模块：prebuilt 二进制 + node-gyp/MSVC 兜底，成为插件首个运行时依赖 |
| Windows | 无任何安装步骤 | 需平台二进制匹配 Node ABI；杀软/索引器环境偶发编译问题 |
| 分发 | 内置模块不进 bundle，打包零处理，安装链路不变 | 原生 `.node` 要随包分发或安装期重编译，安装复杂化 |
| API | 同步（`DatabaseSync` / `prepare().run/get/all`、`exec`）；标记实验性（Stability 1.x），仍演进 | 同步，成熟稳定（多年生产验证），类型声明完善 |
| 性能 | 与 better-sqlite3 同数量级（同为同步 C++ 绑定），本量级（单团队 ≤500 任务）绰绰有余 | 最快 |
| 事务 | 显式 `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` | 同左，另有 `db.transaction()` 包装 |
| 备份 | `wal_checkpoint(TRUNCATE)` + 文件拷贝；`backup()` 是较新版本 API，用前按目标 Node 验证 | backup API |
| 兜底切换 | 同一份 DDL 在 better-sqlite3 直接可跑 | — |

**结论：选 `node:sqlite`**，理由：

1. **零依赖是既有工程事实**：当前运行时依赖为空集；better-sqlite3 会把原生模块带入分发链路（npm pack → 插件安装 → pnpm 拉包），Windows 上还要考虑 ABI 匹配与编译兜底。当年放弃 SQLite 的首要顾虑正是「原生依赖」，`node:sqlite` 恰好拆掉这个障碍。
2. **engines 已覆盖**：`"node": "^22.19.0 || >=24"`。`node:sqlite` 自 v22.13.0 / v23.4.0 起免 flag（仍标记实验性，Node 24 运行会打 `ExperimentalWarning`，可按需过滤）——支持区间内全部可用。本机 Node v24 已实测 `DatabaseSync` 可用。
3. **API 形态匹配现状**：同步 prepared statement 与现有「锁内同步事务」风格一致；`BEGIN IMMEDIATE` 事务语义与现有锁内事务一一对应。
4. **DDL 是标准 SQLite 方言**：若日后内置 API 出问题，换 `better-sqlite3` 不动任何表结构与 SQL（数据访问层薄封装即可）。

**放弃 better-sqlite3（保留为兜底）**：成熟度与生态更好，但为此引入首个原生依赖、复杂化打包发布，在当前数据量级下没有可感知的性能收益。**放弃「继续纯 JSON」**：跨团队聚合等查询诉求已在 27.1 列明，JSON 路线只能靠全量加载 + 内存计算，规模增长后不可持续。

## 27.3 库文件布局与共存策略

```
<状态根>/                                # stateDir 绝对路径=全局单库（共用一个根）；
                                         # 相对路径=per-workspace <workspace>/<stateDir>（旧口径）
  db/
    eteams.db                            # SQLite 主库
    eteams.db-wal                        # WAL 前滚日志（journal_mode=WAL 自动出现）
    eteams.db-shm                        # WAL 共享内存索引
  roster.json                            # 旧成员库文件（导入备份，入库后停读写）
  captain-persona.yaml                   # 领队人设覆盖（不入库）
  rolebuilder.json                       # 角色构建会话的活动槽（构建过程的临时文件，不进库）
  usage.jsonl                            # token 消耗台账（逐条事件追加，不进库）
  logs/client.log
  <teamId>/
    team.json                            # 旧磁盘真相（导入备份）
    events.jsonl                         # 旧事件日志（导入备份）
    inbox/*.jsonl                        # 旧邮箱（导入备份）
  archive/<teamId>/                      # 归档团队（已下线，见 27.9）
```

- **库文件集中在 `db/` 子目录**：主库和 -wal/-shm 两个运行文件待在一起，不与 json/yaml 配置混放；杀软排除、备份、gitignore 都只针对这一个目录。原方案放 `.eteams/` 根下，改为独立子目录。
- **全局单库（一个状态根，而非 per team）**（2026-09-04 用户定案，改自原「单库 per workspace」口径）：成员库、跨团队统计天然是全局级的——一个 eteams.db、一份成员库、一份用量台账，任何工作区的会话与面板读写同一个库，跨团队/跨工作区查询零拼接。实现上由 `stateRootFor` 收口：`stateDir` 为绝对路径（盘符/UNC）时所有工作区共用这一个根，相对路径回退 per-workspace。团队用 `team_id` 作分区键；量级（单团队 ≤500 任务）对 SQLite 毫无压力。放弃 per-team 库文件：跨团队聚合要 attach 多库，复杂且无收益。放弃 per-workspace 库（本机实测坑）：成员库固定写首个有状态的工作区，团队可建在别的工作区，加成员时按团队自己的工作区查库就找不到（「成员库中没有「小丑」」即此因）。
- **工号由数据库递增发号**：原来工作区有个 employee-seq.json 计数器文件，现在不再需要——工号列 `roles.employee_id`（v3 起角色行一人一行，插入时取 roles 表最大工号 +1，同人同号；task_members 行带同号副本，见 27.4「发号」）。
- **切换语义（已定案）**：首次启动建库时把现有 team.json / events.jsonl / inbox / roster.json 的数据一次性导入；此后 **SQLite 是唯一真相**，原文件停读写、原样保留作备份。删除 `eteams.db` 不会自动找回数据，恢复靠备份或重新导入旧文件。
- **版本约定**：DB 自带独立的 `db_schema_version`（`schema_meta` 表 + `PRAGMA user_version` 双写同值），**从 1 起步**；与 team.json 的结构版本互不相干；两者都遵循「前向兼容、只进不退」。
- **gitignore**：建议把 `.eteams/` 整目录忽略；若只忽略部分文件，需补 `.eteams/db/`（含 -wal/-shm）。
- **备份**：空闲时 `PRAGMA wal_checkpoint(TRUNCATE)` 后拷贝 `db/eteams.db` 即一致快照；本轮不需要（文件仍是真相）。

**连接初始化（每进程一次）**：

```sql
PRAGMA journal_mode = WAL;     -- 单写多读：面板轮询读不阻塞写事务
PRAGMA synchronous = NORMAL;   -- WAL 下安全：崩溃最多丢最后一个事务，库不损坏
PRAGMA busy_timeout = 3000;    -- 杀软/索引器短暂持锁时等待而非立即报错
```

不开外键（`foreign_keys` 保持默认 OFF）——本设计不用外键，删除与引用完整性都由写入代码负责（见 27.4、27.5 末尾）。

## 27.4 全局约定

| 约定 | 内容 |
|---|---|
| 命名 | 表/列 snake_case；**时间相关列一律 `_time` 结尾**（created_time / update_time / completed_time / read_time…） |
| 表尾两列 | 每张表最后统一是 `created_time INTEGER NOT NULL`（创建时间）和 `update_time INTEGER NOT NULL`（更新时间） |
| 时间 | Unix 毫秒 INTEGER |
| ID 类型 | **统一 INTEGER 自增**：每张表自己的编号列就是主键——team_id / role_id / team_member_id / task_id / task_member_id / attempt_id / decision_id / events.event_id / mail_messages.mail_message_id / change_id 全部 `INTEGER PRIMARY KEY AUTOINCREMENT`（自增、删行不复用）。所有引用列（parent_id / current_member_id / main_task_id / now_task_id / role_id / attempt_id 等）随之统一为整数 |
| 例外 | `schema_meta` 是键值元数据表，主键就是 `key`（TEXT，全库唯一，写入代码查重）——唯一不用自增的表 |
| 枚举 | TEXT 存枚举字符串，**合法值写在列注释里**，合法性由写入代码校验。表上不放 CHECK：改枚举值不用动表结构 |
| JSON | TEXT 列存 JSON 字符串，格式由写入代码保证（不用 `json_valid()`）；数组字段默认**整体序列化**，仅 attempts 拆表（理由见 27.6.2） |
| 外键 | **不用外键**。删团队/删大任务的级联清理由代码在一个事务里按顺序逐表 DELETE（见 27.5 末尾「删除规则」）；「小任务必须挂在存在的大任务下」这类引用完整性由写入代码保证 |
| 唯一性 | 表上不放 UNIQUE：编号列靠自增天然不重；成员名、角色名、schema_meta key 由写入代码查重；邮箱幂等投递按 message_id 查重 |
| 校验 | 一切规则（枚举合法、JSON 格式、大任务守卫、查重、幂等）都在写入代码里做——与现在 JSON 实现的校验方式同构，表上不留硬约束 |
| append-only | `events` 只插入、不改写（纠错 = 追加补偿事件，不改历史），由写代码纪律保证 |
| 发号 | **编号全部由数据库发，写入代码不再自造计数器**：任务号、尝试号、决策号、事件号、邮件号都是自增主键（取号 = 读该表自增计数 +1）；**工号 = roles.employee_id**（v3 起角色行一人一行），插入角色行时取 roles 表当前最大工号 +1（task_members 行带同号副本），显示时补零（1 → 0001，带前缀即 ET-0001） |
| 写事务 | 一律 `BEGIN IMMEDIATE`（写锁前置）；面板只读连接不加锁 |

## 27.5 完整建表 DDL

以下 SQL 可整段执行（SQLite ≥3.35；已在 Node 24 内置 SQLite 上验证）。共 13 张表。

```sql
-- =====================================================================
-- ETeams SQLite schema v6（db_schema_version = 6；v3 成员=角色合并：member
-- 表精简改名成 roles 角色库表（去 team_id/role_id/model/reasoning_effort，
-- 新增 profile），班底另起 team_members 表，旧 roles 标签登记表删除；
-- v4 班底行补 role_name/persona_md/profile 角色信息副本列；v5 task 补
-- 会话快照列（session_id）；v6 会话列归位：task.session_id 改名
-- main_session_id，task_members 两列会话合并成 session_id（本行自己的子
-- 代理会话），team 行不存会话；v2/v3/v4/v5 旧库经 getDb 迁移回填）
-- 主键 = 每张表自己的编号列，统一 INTEGER 自增（schema_meta 例外：key 即主键）
-- 时间列一律 *_time 结尾（Unix 毫秒）；每张表末尾 created_time / update_time
-- 枚举 = TEXT（合法值写在列注释里）；JSON = TEXT 存 JSON 字符串
-- 表上没有外键、CHECK、UNIQUE、触发器——规则全部由写入代码保证
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. schema_meta —— 元数据（库版本号等键值对；key 即主键，唯一例外）
-- ---------------------------------------------------------------------
CREATE TABLE schema_meta (
  key            TEXT PRIMARY KEY,             -- 元数据键，如 'db_schema_version' / 'db_created_at'
  value          TEXT NOT NULL,                -- 统一 TEXT 存放，数值由读取方解析
  created_time   INTEGER NOT NULL,             -- 创建时间
  update_time    INTEGER NOT NULL              -- 更新时间
);

-- ---------------------------------------------------------------------
-- 1. team —— 团队
-- ---------------------------------------------------------------------
CREATE TABLE team (
  team_id        INTEGER PRIMARY KEY AUTOINCREMENT,  -- 团队 ID，自增（展示名见 team_name）
  team_name      TEXT NOT NULL,                -- 展示名（原文本团队 ID 转为普通列，由写入代码查重）
  has_leader     INTEGER NOT NULL DEFAULT 0,   -- 是否包含领队（0/1）；领队会话锚点在 task_members 的领队行上
  created_time   INTEGER NOT NULL,             -- 创建时间
  update_time    INTEGER NOT NULL              -- 更新时间
);

CREATE INDEX idx_team_update_time ON team (update_time DESC);

-- ---------------------------------------------------------------------
-- 2. roles —— 角色库（原 member 公共模板行并成角色表；成员=角色，全局一份）
--    代码里的预置角色首次启动写入；角色构建师确认的新角色、面板/工具加
--    成员时的新名字也写进来。人设/工号/头像都挂在角色行上。
-- ---------------------------------------------------------------------
CREATE TABLE roles (
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
--    工号/头像经 role_id 松引用解析自 roles；role_name/persona_md/profile
--    是随角色行同步刷新的副本列（v4，真相在 roles）；执行实例（状态/会话/
--    当前任务）在 task_members）
-- ---------------------------------------------------------------------
CREATE TABLE team_members (
  team_member_id   INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键（内存新建行 0 落库发号）
  team_id          INTEGER NOT NULL,    -- 属于哪个团队（team.team_id）
  role_id          INTEGER,             -- 角色 ID（roles.role_id，松引用；人设/工号/头像都在角色行上）
  role_name        TEXT,                -- 角色名副本（写入时随 roles.role_name 同步刷新；悬空行 NULL；直查/展示用）
  persona_md       TEXT,                -- 角色手册副本（写入时随 roles.persona_md 同步刷新；真相在 roles）
  profile          TEXT,                -- 一句话简介副本（写入时随 roles.profile 同步刷新；真相在 roles）
  model            TEXT,                -- 该队派发路线；NULL=会话默认（settings agent-default-model），有值=覆盖（provider 派发时按配置解析）
  reasoning_effort TEXT,                -- 模型思考强度
  created_time     INTEGER NOT NULL,    -- 创建时间
  update_time      INTEGER NOT NULL     -- 更新时间
);

CREATE INDEX idx_team_members_team ON team_members (team_id);

-- ---------------------------------------------------------------------
-- 4. task —— 任务（parent_id 为空就是大任务，不为空就是小任务）
-- ---------------------------------------------------------------------
CREATE TABLE task (
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
  main_session_id   TEXT,                -- 主会话 ID 快照（v5 落列 v6 改名：建任务时登记的主会话 ID，落库后不变；直查/展示用）
  retry_count       INTEGER NOT NULL DEFAULT 0,  -- 当前执行人连续失败次数（换人清零）
  status_note       TEXT,                -- 当前状态说明（挂起原因等也并在这列）
  acceptance        TEXT,                -- 验收标准（JSON 字符串数组，如 ["登录返回 200 和 token"]）
  in_scope          TEXT,                -- 范围内（JSON 字符串数组，如 ["src/api/login.ts 及其测试"]）
  out_of_scope      TEXT,                -- 范围外（JSON 字符串数组，防越界）
  deliverables      TEXT,                -- 交付物（JSON 字符串数组）
  idempotency_note  TEXT,                -- 幂等说明（重跑安全的前提，派发提示词渲染）
  blocked_from      TEXT,                -- 阻塞前的状态（10 态之一）；解除阻塞时还原到它，NULL=未阻塞
  work_dir          TEXT,                -- 任务工作目录（相对工作区；建任务时分配，分配后固定——撞名 -N 后缀有状态，不可重推导）
  completed_time    INTEGER,             -- 完成时间
  created_time      INTEGER NOT NULL,    -- 创建时间
  update_time       INTEGER NOT NULL     -- 更新时间（主键 task_id 已在列级声明，表上不再写 PRIMARY KEY）
  -- 大任务（parent_id 为空）不带执行链/依赖：由写入代码校验
);

CREATE INDEX idx_task_status  ON task (team_id, status);
CREATE INDEX idx_task_parent  ON task (team_id, parent_id);
CREATE INDEX idx_task_current ON task (team_id, current_member) WHERE current_member IS NOT NULL;
CREATE INDEX idx_task_update  ON task (team_id, update_time DESC);

-- ---------------------------------------------------------------------
-- 5. task_members —— 任务成员（执行实例：有状态、有会话锚点；人设/工号/
--    头像的模板本体在 roles，班底路线在 team_members）
--    领队也是一行：name='项目牧羊人'、main_task_id 为空（团队级主持行）。
-- ---------------------------------------------------------------------
CREATE TABLE task_members (
  task_member_id   INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
  team_id          INTEGER NOT NULL,    -- 属于哪个团队（team.team_id，写入代码维护；领队行也带，删除/统计/领队行定位都按它过滤）
  main_task_id     INTEGER,             -- 实例行所属大任务 ID（task.task_id；独立无链任务=自身 id）；NULL=团队级行（领队主持行）
  now_task_id      INTEGER,             -- 当前执行任务 ID（task.task_id）
  name             TEXT NOT NULL,       -- 成员名（与 roles.role_name 同名，写入代码查重）
  employee_id      INTEGER,             -- 工号副本（引用 roles.employee_id，松引用）
  session_id       TEXT NOT NULL DEFAULT '',  -- 本行自己的子代理会话 ID（v6：成员行=成员子会话，领队行=领队子代理会话）；还没启动时是空串
  status           TEXT NOT NULL DEFAULT 'staged',
                   -- 成员状态：staged / ready / working / paused / removed
  persona_md       TEXT,                -- 执行时的人设手册（沿用 roles 角色行的手册，可按任务微调）
  model            TEXT,                -- 执行时采用的模型（沿用 team_members 班底路线；NULL=跟随）。领队行同列 = 团队默认路线（用户迭代 2026-09-04 恢复领队模型选择，领队子代理派发按它解析）
  reasoning_effort TEXT,                -- 模型思考强度
  avatar           TEXT,                -- 头像
  created_time     INTEGER NOT NULL,    -- 创建时间
  update_time      INTEGER NOT NULL     -- 更新时间
);

CREATE INDEX idx_task_members_team ON task_members (team_id);
CREATE INDEX idx_task_members_main ON task_members (main_task_id);

-- ---------------------------------------------------------------------
-- 6. attempts —— 执行尝试（一行一次尝试）
-- ---------------------------------------------------------------------
CREATE TABLE attempts (
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

CREATE INDEX idx_attempts_task   ON attempts (team_id, task_id, created_time);
CREATE INDEX idx_attempts_member ON attempts (team_id, member, created_time DESC);
CREATE INDEX idx_attempts_token  ON attempts (team_id, token) WHERE token <> '';
CREATE INDEX idx_attempts_status ON attempts (team_id, status)
                 WHERE status IN ('pending_accept','running');

-- ---------------------------------------------------------------------
-- 7. events —— 审计事件（只插入，不改写）
-- ---------------------------------------------------------------------
CREATE TABLE events (
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

CREATE INDEX idx_events_time ON events (team_id, event_time DESC);
CREATE INDEX idx_events_type ON events (team_id, type, event_id);
CREATE INDEX idx_events_task ON events (team_id, task_id, event_id) WHERE task_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 8. mail_messages —— 邮箱消息（按收件箱分箱；至少一次投递）
-- ---------------------------------------------------------------------
CREATE TABLE mail_messages (
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

CREATE INDEX idx_mail_unread     ON mail_messages (team_id, box_key, mail_message_id) WHERE read_time IS NULL;
CREATE INDEX idx_mail_message_id ON mail_messages (team_id, box_key, message_id);

-- ---------------------------------------------------------------------
-- 9. decisions —— 升级决策（任务失败超限后，等领队/用户拍板）
-- ---------------------------------------------------------------------
CREATE TABLE decisions (
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

CREATE INDEX idx_decisions_open ON decisions (team_id, created_time) WHERE status = 'open';

-- ---------------------------------------------------------------------
-- 10. task_status_changes —— 状态流转记录（何时从什么变成什么，供分析卡点）
-- ---------------------------------------------------------------------
CREATE TABLE task_status_changes (
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

CREATE INDEX idx_status_changes_task ON task_status_changes (team_id, task_id, change_time);
CREATE INDEX idx_status_changes_time ON task_status_changes (team_id, change_time);

-- ---------------------------------------------------------------------
-- 11. usage_detail —— Token 消耗明细（一行 = 一次带 usage 的模型回复步）
--     DB 即唯一存储（2026-09-05 简化版定案：无文件台账、无对账、历史不回补）；
--     写入 = 本表 INSERT + usage_daily_total 增量 upsert（单事务）。
-- ---------------------------------------------------------------------
CREATE TABLE usage_detail (
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

CREATE INDEX idx_usage_detail_session ON usage_detail (session_id, seq);
CREATE INDEX idx_usage_detail_day     ON usage_detail (day);
CREATE INDEX idx_usage_detail_team    ON usage_detail (team_key, day) WHERE team_key IS NOT NULL;

-- ---------------------------------------------------------------------
-- 12. usage_daily_total —— 每日消耗总和（一行 = 一天，全应用口径）
--     写入按事件增量 upsert（不强一致：精确口径随时可 GROUP BY
--     usage_detail 重查，团队口径即如此直查明细表）。
-- ---------------------------------------------------------------------
CREATE TABLE usage_daily_total (
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
```

**删除规则（由代码在一个事务里按顺序执行，表上不设级联）**：

- **删团队**：一个事务里逐表清——task / attempts / events / mail_messages / decisions / task_status_changes / task_members（**含领队行**）/ team_members（班底行）按 `team_id` 删（roles 角色库行全局共享，不随队删），最后删 team 行。要么全删要么全留。
- **删大任务（parent_id 为空）**：先删它名下的小任务及其 attempts/decisions，再删大任务行；关联的 task_members（实例行）一并清。
- **删单个任务**：同时删它的 attempts/decisions；events 和 mail_messages 里指向它的行**保留**（审计和邮箱历史不跟着任务蒸发）。
- **task_members 实例行一般不删**：status 置 removed，行保留供查历史。
- **roles 角色行**：从角色库删除角色 = 删行，但该角色名下还有非 removed 的 task_members 实例行（在队成员）时写入代码拒绝删除（先从团队移除再删）；工号已发出不重发，AUTOINCREMENT 主键不受影响。

要点：

- **13 张表**：`schema_meta`、`team`、`roles`、`team_members`、`task`、`task_members`、`attempts`、`events`、`mail_messages`、`decisions`、`task_status_changes`、`usage_detail`、`usage_daily_total`。每张表只有列定义、自增主键、普通索引——没有外键、CHECK、UNIQUE、触发器。
- **成员=角色（v3）**：`roles` 角色库表一人一行（人设手册/工号/头像/一句话简介都挂角色行，全局一份）；`team_members` 班底表一行 = 团队 × 角色 + 该队派发路线（model / reasoning_effort），人设/工号/头像经 role_id 松引用解析；`task_members` 仍是执行实例（状态/会话锚点/当前任务），其人设/模型/头像列是建行时的快照。加成员即入库：面板/领队添加成员时，写入代码在同一事务里确保角色行存在（缺则按名自建）。
- **班底行角色信息副本（v4）**：`team_members` 上另有 role_name / persona_md / profile 三列，是随 roles 角色行同步刷新的**副本**（真相在 roles）——每次角色行写入路径（名册 upsert、成员详情改手册、预设手册升级、快照落库、旧版导入）落库后统一从 roles 反查回填，角色删除时引用行刷成 NULL（悬空行，读路径防御性跳过）；副本刷新不碰 update_time。读端（loadMembers）仍走 LEFT JOIN roles 以角色行为准，副本列只服务直查/展示，不参与「人设单一来源」的判定。
- **任务行主会话快照（v5，v6 改名）**：`task.main_session_id` 一列（v5 名 `session_id`），建任务/派发补章时登记该团队领队主会话 ID——面板建任务、领队工具建任务、旧版团队导入三路同源取值，随快照整存整取。**快照语义**：落库后不变，领队重锚不回改旧任务（和 work_dir 同款「分配后固定」）；v4 旧库 getDb 首次连接时 ALTER 补列 + 只对 NULL 行回填（已盖章行不覆盖，幂等自愈）。**团队级锚点按任务行派生**：同队任务由同一领队会话创建，取首个非空快照即领队锚；无任务团队退建队事件留痕（team.created 的 captainSession 字段）。
- **会话列归位（v6）**：`task_members.session_id` = 本行自己的子代理会话（成员行=成员子会话，领队行=领队子代理冷恢复凭证），未起会话空串；旧 `main_session_id`（领队主会话锚）与 `child_session_id` 两列合并丢弃——主会话快照已随 v5 迁移回填进任务行，成员行要主会话按 task_id 反查任务行。
- **主键 = 表自己的编号列，统一整数自增**：team_id / role_id / team_member_id / task_id / task_member_id / attempt_id / decision_id / events.event_id / mail_messages.mail_message_id / change_id 都是 `INTEGER PRIMARY KEY AUTOINCREMENT`（删行不复用）；`schema_meta` 键值表与 `usage_daily_total` 日行表是例外，`key` / `day` 即主键。所有引用列随之统一为整数。
- **工号 = roles.employee_id**：独立发号（插入角色行时取 roles 表最大工号 +1）、显示补零（1 → 0001，即 ET-0001）、同人同号；team_member_id 只是班底行号。不再需要计数器文件。
- **不再需要发号器**：任务号/尝试号/决策号/事件号/邮件序号全部数据库自增——写入代码只负责成员名/角色名查重和邮箱幂等键生成（message_id 是内容键，不是计数器）。
- 引用完整性（小任务挂在存在的大任务下、成员名/角色名存在）同样由写入代码保证——和现在 JSON 实现的校验方式一样，表上不留硬约束。
- 索引为查询场景（27.7）反推：前缀列一律 `team_id`，时间列 DESC 支持最新优先；三处**部分索引**（未读邮件、进行中尝试、已派任务）覆盖高频读路径。

## 27.6 与现有 JSON 结构的映射

### 27.6.1 表 ↔ 代码字段对照

| 代码（types.ts） | 去向 |
|---|---|
| TeamState 的 id / name | `team.team_id`（自增整数）/ `team_name`（文本目录名不入库，目录映射由写入代码按 team_name 推导查重） |
| TeamState 的 goal / phase / planReviewState | **砍掉**（定案：团队只是流程容器，不要目标/阶段/进展；「批准后开跑」是对话内确认，不落团队级状态） |
| TeamState 的 captainSessionId / captainChildId | **砍掉**——主会话快照在 task 行的 `main_session_id`（团队级锚按任务行快照 ∪ 心跳 ∪ 建队事件派生）；领队子代理会话在 task_members 领队行（`name='项目牧羊人'`、`main_task_id` 为空）的 `session_id` 上，重启后去 task_members 找；team 表只留 `has_leader` |
| TeamState 的 leaderModelRoute / maxRetries / activeSwitch | leaderModelRoute **回队**（用户迭代 2026-09-04 恢复领队模型选择）：落在 task_members 领队行的 `model / reasoning_effort` 列上（领队子代理派发按它解析；空 = 会话默认），不需要 team 表列；maxRetries 重试上限用全局配置；activeSwitch 是死字段 |
| TeamState 的 workDir | **`task.work_dir`**（定案：工作目录归任务，逐任务分配） |
| TeamState 的 leaderRemoved / version / taskSeq·attemptSeq·mailSeq | `has_leader`；version 不存（进程锁 + 事务已够）；三个序号被自增主键取代，删 |
| MemberRecord（班底模板行） | 班底 = `team_members` 行：memberId → team_member_id、modelRoute（model + reasoning_effort）落班底列；人设/工号/头像经 `role_id` 松引用解析自 `roles` 角色行（role_name / employee_id / persona_md / profile / avatar）；provider 不存（派发时按配置解析）；**status、子会话 id、当前尝试不在班底表**。v4：team_members 行上另有 role_name / persona_md / profile 副本列，随角色行同步刷新（真相在 roles），读端仍走 JOIN 以角色行为准 |
| MemberRecord 的 status / id（子会话）/ currentAttemptId / removedAt | `task_members.status / session_id / now_task_id`；当前尝试反查 attempts；removedAt 用 update_time |
| TaskRecord 任务号/父子/标题/正文/依赖/执行链/状态/执行人/重试/完成时间 | `task` 表同名列（编号整数自增；depend_tasks 存整数任务号）；v5 落列 v6 改名：sessionId 盖章进 `main_session_id` 列（建任务时登记的主会话快照，落库后不变） |
| TaskRecord 合同（acceptance/inScope/outOfScope/deliverables/idempotencyNote） | `task` 表 `acceptance / in_scope / out_of_scope / deliverables`（JSON 数组）+ `idempotency_note`（已定补列） |
| TaskRecord 的 blockedFrom / suspendNote / decisionId / currentAttemptId / outcome / kind / workDir | `blocked_from` 列；suspendNote 并入 status_note；decisionId / currentAttemptId 反查 decisions / attempts；outcome 反查 attempts 最新成功行；kind 由 parent_id 为空表达；`work_dir` 列 |
| `attempts[]` / `pendingDecisions[]` | `attempts` / `decisions` 表 |
| `roster.json`（旧成员库文件） | `roles` 表（角色库行：成员=角色，全局一份，导入时按名建行）；团队班底另入 `team_members` 行 |
| 预置角色模板 + 角色构建师产物 | `roles` 表（首次启动写预置；确认构建时写入；面板/领队加成员时新名字也确保入库——加成员即入库） |
| `events.jsonl` | `events` 表；actor 拍平 `actor_kind / actor_name`，事件号全库自增 |
| `inbox/*.jsonl` | `mail_messages` 表；from/to 拍平四列 + `box_key` 分箱，邮件号全库自增 |

### 27.6.2 数组字段的存法

| 字段 | 存法 | 理由 |
|---|---|---|
| task 的执行尝试 | **拆表**（唯一拆出的数组） | 行数最大（100 任务 × 5 尝试）、凭证/状态要按行改、要按成员/任务查 |
| `task.member_chain_list` | JSON 一列 | 站点数少、整读整写、没有按列查的需求；将来真要按成员跨任务找链站点再拆表 |
| `task.depend_tasks` | JSON 一列 | 环检测由写入代码做；将来要 SQL 级查环/关键路径再拆边表 |
| `attempts.progress` / `result_changed_paths` | JSON 一列 | 只追加 / 随行整读 |
| `events.payload` | JSON 一列 | 各事件自定义载荷 |
| `mail.from / to` | 拍平 `*_kind / *_name` 四列 | 收件箱按 box_key + read_time 查询，拍平才能建索引 |
| `event.actor` | 拍平 `actor_kind / actor_name` | 按 actor 过滤事件流 |

原则：**能整读整写、不参与查询的数组保持 JSON**（少一次 join、写入路径与现实现一致）；需要按行更新或作为查询维度的才拆表。

## 27.7 查询场景预设

看板/任务页的典型查询（括号内为所用索引）。token 消耗的聚合查询走用量侧两张表（usage_detail / usage_daily_total，2026-09-05 入库），不在这组预设里。

```sql
-- Q1 面板团队列表                                            (idx_team_update_time)
SELECT team_id, team_name, created_time, update_time
  FROM team
 ORDER BY update_time DESC;

-- Q2 任务页：任务树（大任务在前、小任务随后）                 (idx_task_update + 结果集内排序)
SELECT task_id, parent_id, subject, status, current_member, member_chain_list, chain_cursor, update_time
  FROM task
 WHERE team_id = ?1
 ORDER BY (parent_id IS NULL) DESC, created_time;

-- Q3 大任务进度（N 个小任务 / 完成 M）                        (idx_task_parent)
SELECT COUNT(*) AS total, COALESCE(SUM(status = 'completed'), 0) AS done
  FROM task
 WHERE team_id = ?1 AND parent_id = ?2;

-- Q4 看板按状态分列（五列：等待/执行/暂停/待决策/待用户）      (idx_task_status)
SELECT task_id, subject, status, current_member, member_chain_list, chain_cursor, update_time
  FROM task
 WHERE team_id = ?1 AND status IN ('wait','start','paused','wait_decision','wait_user')
 ORDER BY update_time DESC;
-- ready（就绪待派）单列一栏，不进看板五列

-- Q5 成员待派统计（每成员当前承担的任务数）                    (idx_task_members_team)
SELECT tm.name, tm.status,
       (SELECT COUNT(*) FROM task t
         WHERE t.team_id = ?1 AND t.current_member = tm.name
           AND t.status IN ('wait','start','paused','wait_decision','wait_user')) AS active_tasks
  FROM task_members tm
 WHERE tm.team_id = ?1 AND tm.status <> 'removed'
 ORDER BY tm.name;

-- Q6 收件箱补投未读（唤醒先补投）                             (idx_mail_unread)
SELECT message_id, mail_message_id, created_time, from_kind, from_name, kind, task_id, attempt_id, content
  FROM mail_messages
 WHERE team_id = ?1 AND box_key = ?2 AND read_time IS NULL
 ORDER BY mail_message_id;

-- Q7 动态视图：最近事件流                                    (主键 event_id 排序 + 团队过滤)
SELECT * FROM events WHERE team_id = ?1 ORDER BY event_id DESC LIMIT 50;

-- Q8 动态视图：单任务时间线                                  (idx_events_task)
SELECT event_time, actor_kind, actor_name, type, payload
  FROM events
 WHERE team_id = ?1 AND task_id = ?2
 ORDER BY event_id;

-- Q9 待决策横幅                                              (idx_decisions_open)
SELECT decision_id, task_id, error, retry_count, created_time
  FROM decisions
 WHERE team_id = ?1 AND status = 'open'
 ORDER BY created_time;

-- Q10 成员详情：执行线路（按成员回溯）                        (idx_attempts_member)
SELECT attempt_id, task_id, kind, status, station_index, created_time, claimed_time, ended_time, error
  FROM attempts
 WHERE team_id = ?1 AND member = ?2
 ORDER BY created_time DESC
 LIMIT 50;

-- Q11 状态流转分析（流转时长 / 卡点）                         (idx_status_changes_time)
SELECT task_id, from_status, to_status, change_time, actor_kind, note
  FROM task_status_changes
 WHERE team_id = ?1 AND change_time BETWEEN ?2 AND ?3
 ORDER BY change_time;
```

写路径的两条关键守卫（替代现实现的内存校验；编号列已全局唯一，条件更新不再带 team_id）：

```sql
-- 凭证守卫：接活与后续更新按 token + 状态条件更新（防迟到请求/防伪造）
UPDATE attempts SET status = 'running', claimed_time = ?3
 WHERE attempt_id = ?1 AND token = ?2 AND status = 'pending_accept';
-- changes = 0 → token 失效 / 已被别人接取，调用方拒绝

-- 状态流转守卫：只有当前状态匹配才允许流转（防并发乱序；本轮不上，多实例时启用）
UPDATE task SET status = 'start', update_time = ?2
 WHERE task_id = ?1 AND status = 'wait';
-- changes = 0 → 状态已被别人改过，拒绝写
```

## 27.8 切换路线（已定案：一步切换）

不做「只读投影 / 双写」过渡（用户定案 2026-09-04）：本轮直接把真相切到 SQLite。

| 步骤 | 内容 |
|---|---|
| 建库 | 首次启动：`db/eteams.db` 不存在（或缺 `db_schema_version`）时执行 DDL 建表 |
| 一次性导入 | 同一事务把现有 team.json / events.jsonl / inbox/*.jsonl / roster.json 全部导入（见 27.6 映射）；文本号 `t1`/`a1` 换算成自增整数号；导入完成写 `db_schema_version = 1` |
| 切真相 | 此后写路径全部是 SQLite：整个领队操作单元（改任务 + 发尝试 + 写邮箱 + 记事件）落在一个 `BEGIN IMMEDIATE … COMMIT` 内，崩溃要么整体回滚、要么整体生效，不再需要补偿事件 |
| 旧文件 | 停读写、原样保留作导入备份；usage.jsonl / rolebuilder.json / captain-persona.yaml 继续按文件走（已定案不进库） |

**事务边界与锁**：

- 写形态是**整存整取**：`readTeam` 从 11 张表重装出内存里的 TeamState，`writeTeam` 在一个事务内把该团队数据整队重写（DELETE + 带原号 INSERT，编号不变）。单团队 ≤500 任务，重写毫秒级。并发安全由「进程锁串行 + 事务原子」共同保证——与现在 JSON 实现的校验方式同构，规则仍在写代码里。
- WAL 下读者（面板 1 秒轮询）不被写事务阻塞——比现在「读快照也要等锁」更顺；单写者由数据库保证而非约定。
- **乐观版本**：team 表要不要补 `version` 列（`UPDATE … WHERE version=?` 检测跨进程冲突）在确认清单里定；单进程单写者场景下进程锁已够。
- **Windows 注意**：`-wal/-shm` 在 `.eteams/db/` 子目录，与 team.json 不同目录，受杀软/索引器/OneDrive 同类干扰的面更小；`busy_timeout` + 空闲时定期 `wal_checkpoint(TRUNCATE)` 缓解。若后续用 `backup()`，同样按 Node 版本验证。

**schemaVersion 管理**：每次**表结构**变更（加列、加表、加索引）= 新版本号 + 编号迁移脚本（`migrations/0002_add_xxx.sql`），启动时按 `schema_meta` 里的版本号顺序执行。**表上没有 CHECK，改枚举值不需要动表结构**——这是把校验放应用层换来的直接好处。

## 27.9 开放问题

1. **token 记账——已定案（2026-09-04）**：采集点 = 会话事件流（插件收到全进程所有会话的事件），存储 = 状态根下 usage.jsonl 逐条追加（全局单库下即全局根一份，跨工作区台账合一）、读取时聚合、不落日汇总。本库不设 token 表；若以后要做 token 投影表，行模型必须按事件行对齐，不得回退日聚合表。（2026-09-05 修订：改为入库——`usage_detail` 明细一行 = 一次带 usage 的模型回复步 + `usage_daily_total` 每日总和增量 upsert，DB 即唯一存储，无文件台账、无对账、历史不回补；行模型仍按事件行对齐。）
2. **「天」的时区口径——已定案**：token 记账的 day 在记录时按宿主本地日界折算（与用户日历一致）；本库无 day 列。
3. **枚举校验放哪——已定案（2026-09-04 用户定案）**：表上不放 CHECK，枚举合法性由写入代码校验，改枚举值零迁移。
4. **暂未入库的代码字段——已定案（2026-09-04 逐条对账）**：goal / phase / planReviewState / captainSessionId / captainChildId 砍掉（审批转对话内确认、领队锚点转 task_members）；activeSwitch 删；maxRetries 用全局配置；version 不存；workDir 归 `task.work_dir`；task 补合同四数组（acceptance/in_scope/out_of_scope/deliverables）+ idempotency_note + blocked_from；suspendNote 并入 status_note；decisionId / currentAttemptId / outcome 反查 attempts / decisions；member 模板化（状态/会话在 task_members）。修订（2026-09-04 用户迭代）：leaderModelRoute 恢复，落 task_members 领队行 model/reasoning_effort 列；成员 model 空 = 会话默认（settings agent-default-model 即时快照），不再继承领队会话模型。
5. **depend_tasks / member_chain_list 是否拆表**：现在写入代码查环够用；若任务页要 SQL 级 DAG 查询（上游阻塞传播、关键路径），再拆依赖边表与链站点表。
6. **events.jsonl / inbox 的最终关系——已定案**：停写（表为唯一真相），原文件保留作导入备份。
7. **归档形态——已定案（2026-09-04）**：归档下线。archiveTeam 与面板归档页删除，删团队走对话内确认 + 数据库事务删除；archive/ 目录不导入。
8. **角色/人设配置的入库范围——部分定案**：预置角色模板与角色构建师产物进 `roles` 表（已定）；领队人设覆盖（captain-persona.yaml）是否入库待定。
9. **邮箱序号——已定案**：邮件号（mail_message_id）全库自增（数据库发号），箱内顺序按它排；message_id 只做幂等键。
10. **member 与 task_members 的分工——已定案**：member = 成员模板（一人一行，无状态无会话，`team_id` 空=全局公共模板（成员库）、非空=该团队班底，工号在此发号）；task_members = 任务成员执行实例（状态/会话锚点/当前任务都在这），**按大任务粒度建行（同一人每条大任务一行、各绑一个子会话，用户定案）**，领队也是一行（`name='项目牧羊人'`、`main_task_id` 空）。实例行的人设/模型沿用模板值；模板编辑是否回填存量实例行默认不回填。**修订（2026-09-06 v3，成员=角色）**：member 表并入 roles 角色库表（成员=角色全局一份，工号/人设/头像/简介都挂角色行），班底另起 team_members 表（team_member_id / team_id / role_id / model / reasoning_effort）；task_members 仍为执行实例（role_id 死列移除），实例行的人设/模型/头像列保持建行时快照，角色行编辑全局生效、默认不回填存量实例行。**增补（2026-09-06 v4）**：team_members 补 role_name / persona_md / profile 副本列随角色行同步刷新（真相在 roles，写入路径落库后统一回填、删除角色刷 NULL），班底行不再依赖 JOIN 也能直查角色名/手册/简介；「改角色全局生效、副本不反向覆盖角色行」的单一来源语义不变。
11. **任务状态枚举——已定案（10 态 + 映射方案 A）**：draft / ready / wait / start / paused / wait_decision / wait_user / completed / failed / cancelled；代码从 13 态收敛：assigned→wait、in_progress→start、retrying→wait（重试=重新排队）、suspended→paused（原因进 status_note）、blocked→wait（记 blocked_from，解除时还原）。**毒化集随收敛更新：paused / failed / wait_decision / wait_user 毒化下游依赖任务（旧 suspended 毒化、paused 不毒化，合并后 paused 也毒化——用户定案）**。
12. **多实例并发**：两个进程打开同一工作区时，WAL 允许多连接但写互斥——单写者场景进程锁已够；若将来多实例，再补乐观 version 列。
13. **node:sqlite 稳定性**：仍标记实验性（Node 24 打警告）；个别 API（`backup()` 等）按目标 Node 版本验证。若遇 API 缺口，按 27.2 兜底换 better-sqlite3（同一份 DDL）。