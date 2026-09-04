# 27 SQLite 表结构设计（角色 / 团队 / 任务统一存储）

> 状态：**设计稿（2026-09-04）——只设计，未实施**。本轮不建库、不写迁移代码、不改任何现有文件；`team.json` / `events.jsonl` / `roster.json` 仍是磁盘真相。
>
> 字段基线：[src/host/model/types.ts](../src/host/model/types.ts)——表里每个字段都能在 types.ts 找到对应；两处有出入时以 types.ts 为准。
>
> token 记账不进这个库：token 消耗逐条记在工作区的事件日志文件 usage.jsonl 里，读取时现聚合；本库只管角色/团队/任务数据，不设 token 表。
>
> 表上不留外键、CHECK、UNIQUE、触发器——每张表只有列定义、主键、普通索引，规则全部由写入代码保证。
>
> 2026-09-04 用户改版定稿：表精简为 11 张（team / roles / member / task / task_members + attempts / events / mail_messages / decisions / task_status_changes + schema_meta）；**主键 = 每张表自己的编号列，统一整数自增**（team_id / role_id / member_id / task_id / task_member_id / attempt_id / decision_id / seq / change_id；schema_meta 例外，key 即主键）；**每张表最后两列固定 created_time / update_time**，时间相关列一律 `_time` 结尾；**工号 = member.member_id 自增**（显示补零成 0001）；**库文件放 `<workspace>/.eteams/db/` 子目录**。

## 27.1 为什么引入 SQLite

- **跨团队视图缺统一存储**：状态按团队目录分片（每个团队一个 team.json），跨团队的东西（成员库、跨团队统计）只能逐目录读文件再内存拼装，面板每次轮询都重算一遍。
- **看板/任务页的统计在 JSON 上表达不出来**：成员待派统计、任务单进度、状态流转时长、按类型筛事件——这些用 SQL 是一句话，JSON 只能整读 + 内存算，1 秒轮询下反复做。
- **事件日志只能顺序扫**：events.jsonl 能查但不能按维度聚合（按任务/类型/成员过滤要整文件遍历）。
- **单写者保证可以下沉到存储层**：现在靠进程内锁 + 约定；SQLite（WAL）原生提供「单写多读」与事务原子性。
- **token 看板曾是本设计的触发点之一，已定案不进 SQLite**：token 消耗按事件逐条记在独立日志文件（usage.jsonl），读取时聚合、不落日汇总。

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
<workspace>/.eteams/                      # 状态根目录（可配置）
  db/
    eteams.db                             # SQLite 主库（本轮不创建；规划中的新真相源）
    eteams.db-wal                         # WAL 前滚日志（journal_mode=WAL 自动出现）
    eteams.db-shm                         # WAL 共享内存索引
  roster.json                             # 现行工作区成员库（共存期不变；入库后由 member / task_members 承担）
  captain-persona.yaml                    # 领队人设覆盖（本轮不入库）
  rolebuilder.json                        # 角色构建会话的活动槽（构建过程的临时文件，不进库）
  usage.jsonl                             # token 消耗台账（逐条事件追加，不进库）
  logs/client.log
  <teamId>/
    team.json                             # 现行磁盘真相（共存期不变）
    events.jsonl                          # 现行事件日志（共存期不变）
    inbox/*.jsonl                         # 现行邮箱（共存期不变）
  archive/<teamId>/                       # 归档团队（暂不入库，见 27.9）
```

- **库文件集中在 `db/` 子目录**：主库和 -wal/-shm 两个运行文件待在一起，不与 json/yaml 配置混放；杀软排除、备份、gitignore 都只针对这一个目录。原方案放 `.eteams/` 根下，改为独立子目录。
- **单库 per workspace（而非 per team）**：成员库、跨团队统计天然是工作区级的；跨团队查询要求单库。团队用 `team_id` 作分区键；量级（单团队 ≤500 任务）对 SQLite 毫无压力。放弃 per-team 库文件：跨团队聚合要 attach 多库，复杂且无收益。
- **工号不再单独计数**：原来工作区有个 employee-seq.json 计数器文件，入库后工号直接用 member 表的自增主键 member_id（见 27.4「发号」），这个文件不再需要。
- **共存语义**：文件仍是磁盘真相，SQLite 是规划中的新真相源。迁移完成前删除 `eteams.db` 不丢失任何数据（可随时从 team.json/events.jsonl 全量重建，见 27.8 阶段 1）。
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
| ID 类型 | **统一 INTEGER 自增**：每张表自己的编号列就是主键——team_id / role_id / member_id / task_id / task_member_id / attempt_id / decision_id / events.seq / mail.seq / change_id 全部 `INTEGER PRIMARY KEY AUTOINCREMENT`（自增、删行不复用）。所有引用列（parent_id / current_member_id / main_task_id / now_task_id / role_id / attempt_id 等）随之统一为整数 |
| 例外 | `schema_meta` 是键值元数据表，主键就是 `key`（TEXT，全库唯一，写入代码查重）——唯一不用自增的表 |
| 枚举 | TEXT 存枚举字符串，**合法值写在列注释里**，合法性由写入代码校验。表上不放 CHECK：改枚举值不用动表结构 |
| JSON | TEXT 列存 JSON 字符串，格式由写入代码保证（不用 `json_valid()`）；数组字段默认**整体序列化**，仅 attempts 拆表（理由见 27.6.2） |
| 外键 | **不用外键**。删团队/删大任务的级联清理由代码在一个事务里按顺序逐表 DELETE（见 27.5 末尾「删除规则」）；「小任务必须挂在存在的大任务下」这类引用完整性由写入代码保证 |
| 唯一性 | 表上不放 UNIQUE：编号列靠自增天然不重；成员名、角色名、schema_meta key 由写入代码查重；邮箱幂等投递按 message_id 查重 |
| 校验 | 一切规则（枚举合法、JSON 格式、大任务守卫、查重、幂等）都在写入代码里做——与现在 JSON 实现的校验方式同构，表上不留硬约束 |
| append-only | `events` 只插入、不改写（纠错 = 追加补偿事件，不改历史），由写代码纪律保证 |
| 发号 | **全部由数据库自增，写入代码不再发号**：任务号、尝试号、决策号、事件号、邮件序号都是自增主键；工号 = member.member_id 自增，显示时补零（1 → 0001） |
| 写事务 | 一律 `BEGIN IMMEDIATE`（写锁前置）；面板只读连接不加锁 |

## 27.5 完整建表 DDL

以下 SQL 可整段执行（SQLite ≥3.35；已在 Node 24 内置 SQLite 上验证）。共 11 张表。

```sql
-- =====================================================================
-- ETeams SQLite schema v1（db_schema_version = 1）
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
  has_leader     INTEGER NOT NULL DEFAULT 0,   -- 是否有领队（0/1）
  created_time   INTEGER NOT NULL,             -- 创建时间
  update_time    INTEGER NOT NULL              -- 更新时间
);

CREATE INDEX idx_team_update_time ON team (update_time DESC);

-- ---------------------------------------------------------------------
-- 2. roles —— 角色定义（角色标签背后的内容）
--    代码里的预置角色首次启动写入；角色构建师确认的新角色也写进来。
-- ---------------------------------------------------------------------
CREATE TABLE roles (
  role_id        INTEGER PRIMARY KEY AUTOINCREMENT,  -- 角色 ID，自增
  role_name      TEXT NOT NULL,                -- 角色名（全库唯一，写入代码查重）
  persona_md     TEXT,                         -- 完整角色手册（Markdown 全文）
  description    TEXT,                         -- 描述
  avatar         TEXT,                         -- 头像
  source         TEXT,                         -- 角色来源：preset=代码预置 / ai=角色构建师做的 / user=手工加的
  created_time   INTEGER NOT NULL,             -- 创建时间
  update_time    INTEGER NOT NULL              -- 更新时间
);

-- ---------------------------------------------------------------------
-- 3. member —— 团队成员（一个团队里每个成员一行）
-- ---------------------------------------------------------------------
CREATE TABLE member (
  member_id        INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键，即工号（显示补零：1 → 0001）
  team_id          INTEGER NOT NULL,      -- 属于哪个团队（team.team_id）
  role_id          INTEGER,               -- 角色 ID（roles.role_id，松引用）
  role_name        TEXT NOT NULL,         -- 成员名就是角色名
  persona_md       TEXT,                  -- 完整角色手册（Markdown 全文）
  model            TEXT,                  -- 采用的模型
  reasoning_effort TEXT,                  -- 模型思考强度
  avatar           TEXT,                  -- 头像
  created_time     INTEGER NOT NULL,      -- 创建时间
  update_time      INTEGER NOT NULL       -- 更新时间
);

CREATE INDEX idx_member_team ON member (team_id);

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
  current_member_id INTEGER,             -- 当前执行成员 ID（member.member_id）
  retry_count       INTEGER NOT NULL DEFAULT 0,  -- 当前执行人连续失败次数（换人清零）
  status_note       TEXT,                -- 当前状态说明
  completed_time    INTEGER,             -- 完成时间
  created_time      INTEGER NOT NULL,    -- 创建时间
  update_time       INTEGER NOT NULL,    -- 更新时间
  PRIMARY KEY (task_id)
  -- 大任务（parent_id 为空）不带执行链/依赖：由写入代码校验
);

CREATE INDEX idx_task_status  ON task (team_id, status);
CREATE INDEX idx_task_parent  ON task (team_id, parent_id);
CREATE INDEX idx_task_current ON task (team_id, current_member) WHERE current_member IS NOT NULL;
CREATE INDEX idx_task_update  ON task (team_id, update_time DESC);

-- ---------------------------------------------------------------------
-- 5. task_members —— 任务成员（参与任务的成员，带会话锚点与执行状态）
-- ---------------------------------------------------------------------
CREATE TABLE task_members (
  task_member_id   INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
  main_task_id     INTEGER,             -- 主任务 ID（task.task_id）
  now_task_id      INTEGER,             -- 当前执行任务 ID（task.task_id）
  name             TEXT NOT NULL,       -- 成员名（全库唯一，写入代码查重）
  employee_id      TEXT,                -- 工号（= member.member_id 补零）
  main_session_id  TEXT NOT NULL DEFAULT '',  -- 主代理会话 ID；还没启动时是空串
  child_session_id TEXT NOT NULL DEFAULT '',  -- 子代理会话 ID；还没启动时是空串
  role_id          INTEGER,             -- 角色 ID（roles.role_id，松引用）
  status           TEXT NOT NULL DEFAULT 'staged',
                   -- 成员状态：staged / ready / working / paused / removed
  persona_md       TEXT,                -- 完整角色手册（在此编辑）
  model            TEXT,                -- 采用的模型
  reasoning_effort TEXT,                -- 模型思考强度
  avatar           TEXT,                -- 头像
  created_time     INTEGER NOT NULL,    -- 创建时间
  update_time      INTEGER NOT NULL     -- 更新时间
);

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
CREATE INDEX idx_events_type ON events (team_id, type, seq);
CREATE INDEX idx_events_task ON events (team_id, task_id, seq) WHERE task_id IS NOT NULL;

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

CREATE INDEX idx_mail_unread     ON mail_messages (team_id, box_key, seq) WHERE read_time IS NULL;
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
```

**删除规则（由代码在一个事务里按顺序执行，表上不设级联）**：

- **删团队**：先记下该团队全部任务 ID，然后一个事务里逐表清——task / attempts / events / mail_messages / decisions / task_status_changes 按 `team_id` 删，task_members 按 `main_task_id` 属于这些任务删，member 按 `team_id` 删，最后删 team 行。要么全删要么全留。
- **删大任务（parent_id 为空）**：先删它名下的小任务及其 attempts/decisions，再删大任务行；关联的 task_members 一并清。
- **删单个任务**：同时删它的 attempts/decisions；events 和 mail_messages 里指向它的行**保留**（审计和邮箱历史不跟着任务蒸发）。
- **成员一般不删行**：status 置 removed，行保留供查历史。

要点：

- **11 张表**：`schema_meta`、`team`、`roles`、`member`、`task`、`task_members`、`attempts`、`events`、`mail_messages`、`decisions`、`task_status_changes`。每张表只有列定义、自增主键、普通索引——没有外键、CHECK、UNIQUE、触发器。
- **主键 = 表自己的编号列，统一整数自增**：team_id / role_id / member_id / task_id / task_member_id / attempt_id / decision_id / events.seq / mail.seq / change_id 都是 `INTEGER PRIMARY KEY AUTOINCREMENT`（删行不复用）；`schema_meta` 是唯一例外，`key` 即主键。所有引用列随之统一为整数。
- **工号 = member.member_id**：自增、删行不复用、显示补零成 0001；不再需要计数器文件，也没有单独的工号列。
- **不再需要发号器**：任务号/尝试号/决策号/事件号/邮件序号全部数据库自增——写入代码只负责成员名/角色名查重和邮箱幂等键生成（message_id 是内容键，不是计数器）。
- 引用完整性（小任务挂在存在的大任务下、成员名/角色名存在）同样由写入代码保证——和现在 JSON 实现的校验方式一样，表上不留硬约束。
- 索引为查询场景（27.7）反推：前缀列一律 `team_id`，时间列 DESC 支持最新优先；三处**部分索引**（未读邮件、进行中尝试、已派任务）覆盖高频读路径。

## 27.6 与现有 JSON 结构的映射

### 27.6.1 表 ↔ 代码字段对照

| 代码（types.ts） | 去向 |
|---|---|
| TeamState 的 id / name | `team.team_id`（**本库改为自增整数**，原文本 id 转 `team_name` 之外的普通列由代码查重）/ `team_name` |
| 领队是否在团队名册 | `team.has_leader` |
| 成员名 / 人设手册 / 模型路线 / 头像 | `member.role_name / persona_md / model + reasoning_effort / avatar` |
| 成员的会话锚点与执行状态 | `task_members.main_session_id / child_session_id / status` |
| 工号（employeeId） | `member.member_id` 自增即工号，显示补零——不再需要 employee-seq.json |
| TaskRecord 的任务号/父子/标题/正文/依赖/执行链/状态/执行人/重试/完成时间 | `task` 表同名列（任务号 task_id 为自增整数；depend_tasks 数组存任务 ID） |
| TaskRecord 的合同数组（acceptance/inScope/outOfScope/deliverables 等） | **本版暂不入库**（继续由 team.json 承担，见 27.9-4） |
| `attempts[]` | `attempts` 表一行一次尝试 |
| `pendingDecisions[]` | `decisions` 表 |
| 预置角色模板 + 角色构建师确认的新角色 | `roles` 表（首次启动写入预置；确认构建时写入新角色） |
| `roster.json`（工作区成员库） | `task_members`（工号/会话锚点/人设/模型/状态） |
| `events.jsonl` | `events` 表；actor 拍平 `actor_kind / actor_name`，seq 改全库自增 |
| `inbox/*.jsonl` | `mail_messages` 表；from/to 拍平四列 + `box_key` 分箱，seq 改全库自增 |

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

看板/任务页的典型查询（括号内为所用索引）。token 记账不在这里——token 消耗记在独立日志文件里，本库没有 token 相关查询。

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

-- Q4 看板按状态分列                                           (idx_task_status)
SELECT task_id, subject, status, current_member, member_chain_list, chain_cursor, update_time
  FROM task
 WHERE team_id = ?1 AND status IN ('ready','wait','start','paused')
 ORDER BY update_time DESC;

-- Q5 成员待派统计（每成员当前承担的任务数）
SELECT tm.name, tm.status,
       (SELECT COUNT(*) FROM task t
         WHERE t.team_id = ?1 AND t.current_member = tm.name
           AND t.status IN ('wait','start','paused','wait_decision','wait_user')) AS active_tasks
  FROM task_members tm
 WHERE tm.status <> 'removed'
 ORDER BY tm.name;

-- Q6 收件箱补投未读（唤醒先补投）                             (idx_mail_unread)
SELECT message_id, seq, created_time, from_kind, from_name, kind, task_id, attempt_id, content
  FROM mail_messages
 WHERE team_id = ?1 AND box_key = ?2 AND read_time IS NULL
 ORDER BY seq;

-- Q7 动态视图：最近事件流                                    (主键 seq 排序 + 团队过滤)
SELECT * FROM events WHERE team_id = ?1 ORDER BY seq DESC LIMIT 50;

-- Q8 动态视图：单任务时间线                                  (idx_events_task)
SELECT event_time, actor_kind, actor_name, type, payload
  FROM events
 WHERE team_id = ?1 AND task_id = ?2
 ORDER BY seq;

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

-- 状态流转守卫：只有当前状态匹配才允许流转（防并发乱序）
UPDATE task SET status = 'start', update_time = ?2
 WHERE task_id = ?1 AND status = 'ready';
-- changes = 0 → 状态已被别人改过，拒绝写
```

## 27.8 迁移路线（仅设计）

三阶段切换，每阶段可独立回退；`db_schema_version` 从 1 起步，随表结构变更递增（`schema_meta` + `PRAGMA user_version` 双写，只进不退）。

| 阶段 | 形态 | 说明 |
|---|---|---|
| 0（本轮） | 纯设计 | 不建库、不引依赖；文件是磁盘真相 |
| 1 只读投影 | DB = 看板读模型 | 每次写完 team.json 后异步把数据投影进 DB（或启动时全量重建）；DB 随时可删可重建，真相仍是文件。看板聚合查询先落地（27.7 Q5） |
| 2 双写 | 文件 + DB 同事务写 | 锁内顺序「事件 → 快照 → DB 事务」；DB 失败则回滚内存态 + 补偿事件 |
| 3 切换真相 | DB-first | 写路径改为单 SQLite 事务（事件 + 状态 + 邮箱 + 决策同一事务，天然原子）；team.json / events.jsonl 降级为导出物（供人工检视与旧工具兼容）或停写 |

**事务边界与锁的演进**：

- 现状：进程内 Promise 链锁 + 「先日志后快照」两步写 + 补偿事件。阶段 3 后，整个领队操作单元（如派任务：改任务 + 发尝试 + 写邮箱 + 记事件）落在一个 `BEGIN IMMEDIATE … COMMIT` 内，崩溃要么整体回滚，不再需要补偿语义。
- WAL 下读者（面板 1 秒轮询）不被写事务阻塞——比现在「读快照也要等锁」更顺；单写者由数据库保证而非约定。
- **乐观版本**：本版 team 表没有 version 列；阶段 2 双写前需补一列，用 `UPDATE … WHERE team_id=? AND version=?` 把跨进程冲突检测变成一行条件更新（`changes = 0` 即「状态被别人改了」）。
- **Windows 注意**：`-wal/-shm` 在 `.eteams/db/` 子目录，与 team.json 不同目录，受杀软/索引器/OneDrive 同类干扰的面更小；`busy_timeout` + 空闲时定期 `wal_checkpoint(TRUNCATE)` 缓解。若后续用 `backup()`，同样按 Node 版本验证。

**schemaVersion 管理**：每次**表结构**变更（加列、加表、加索引）= 新版本号 + 编号迁移脚本（`migrations/0002_add_xxx.sql`），启动时按 `schema_meta` 里的版本号顺序执行。**表上没有 CHECK，改枚举值不需要动表结构**——这是把校验放应用层换来的直接好处。

## 27.9 开放问题

1. **token 记账——已定案（2026-09-04）**：采集点 = 会话事件流（插件收到全进程所有会话的事件），存储 = 工作区下 usage.jsonl 逐条追加、读取时聚合、不落日汇总。本库不设 token 表；若以后要做 token 投影表，行模型必须按事件行对齐，不得回退日聚合表。
2. **「天」的时区口径——已定案**：token 记账的 day 在记录时按宿主本地日界折算（与用户日历一致）；本库无 day 列。
3. **枚举校验放哪——已定案（2026-09-04 用户定案）**：表上不放 CHECK，枚举合法性由写入代码校验，改枚举值零迁移。
4. **本版精简未入库的字段**：团队阶段/目标/计划审阅、领队会话锚点、乐观版本号、任务合同数组、归档时间、成员人设细分字段（rules/execution_prompt 等）暂不入库，继续由 team.json 承担；阶段 2 双写前按 types.ts 补列。
5. **depend_tasks / member_chain_list 是否拆表**：现在写入代码查环够用；若任务页要 SQL 级 DAG 查询（上游阻塞传播、关键路径），再拆依赖边表与链站点表。
6. **events 表与 events.jsonl 的最终关系**：阶段 3 后 events.jsonl 是停写（表为唯一真相）还是继续并存（文件供人工审计）？影响恢复重放是否改为 SQL 重放。
7. **归档形态**：本版 team 表没有归档列；要支持「删团队默认先归档」时补 `archived_time` 列（面板只读），还是归档行迁独立表，待定。
8. **角色/人设配置的入库范围——部分定案**：预置角色模板与角色构建师产物进 `roles` 表（已定）；领队人设覆盖（captain-persona.yaml）是否入库待定。
9. **邮箱序号——已定案**：seq 全库自增（数据库发号），箱内顺序按 seq 排；message_id 只做幂等键。
10. **member 与 task_members 的分工**：两张表都存人设/模型列——member 是团队名册行，task_members 是任务参与行；同名成员在两边的一致性同步口径待定。
11. **docs/05 与 types.ts 的字段漂移**：任务文档里的 createdBy/cancelReason 字段、邮件类型清单、尝试类型（含 resume）与 types.ts 对不上；建表前先统一，口径按 types.ts。
12. **多实例并发**：两个进程打开同一工作区时，WAL 允许多连接但写互斥——乐观 version（补列后）够不够，还是需要进程级文件锁兜底。
13. **node:sqlite 稳定性**：仍标记实验性（Node 24 打警告）；个别 API（`backup()` 等）按目标 Node 版本验证。若遇 API 缺口，按 27.2 兜底换 better-sqlite3（同一份 DDL）。