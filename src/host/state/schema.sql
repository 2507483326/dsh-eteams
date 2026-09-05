-- =====================================================================
-- ETeams SQLite schema v2（db_schema_version = 2；docs/27 定稿版 + 十六轮
-- DA29 合同合并：task 四数组列 → contract_md 单列，旧库经 getDb 迁移回填）
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
-- 2. roles —— 角色定义（角色标签背后的内容）
--    代码里的预置角色首次启动写入；角色构建师确认的新角色也写进来。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
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
-- 3. member —— 成员模板（一人一行，纯模板：无状态、无会话锚点；
--    执行实例（状态/会话/当前任务）在 task_members）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member (
  member_id        INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键（行号；工号见 employee_id）
  team_id          INTEGER,               -- 属于哪个团队（team.team_id）；NULL=工作区公共成员模板
  role_id          INTEGER,               -- 角色 ID（roles.role_id，松引用）
  role_name        TEXT NOT NULL,         -- 成员名就是角色名
  employee_id      INTEGER,               -- 工号：独立发号（插入成员模板时取 member 表最大工号 +1），同人跨团队同号；显示补零 1 → 0001
  persona_md       TEXT,                  -- 完整角色手册（Markdown 全文；duty/style/skills 等结构字段不单独存，写入时烘进手册）
  model            TEXT,                  -- 采用的模型；NULL=跟随（派发时子会话继承领队会话模型），有值=覆盖（provider 派发时按配置解析）
  reasoning_effort TEXT,                  -- 模型思考强度
  avatar           TEXT,                  -- 头像
  created_time     INTEGER NOT NULL,      -- 创建时间
  update_time      INTEGER NOT NULL       -- 更新时间
);

CREATE INDEX IF NOT EXISTS idx_member_team ON member (team_id);

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
  current_member_id INTEGER,             -- 当前执行成员 ID（member.member_id）
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
-- 5. task_members —— 任务成员（执行实例：有状态、有会话锚点；模板本体在 member）
--    领队也是一行：name='项目牧羊人'、main_task_id 为空（团队级主持行）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_members (
  task_member_id   INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
  team_id          INTEGER NOT NULL,    -- 属于哪个团队（team.team_id，写入代码维护；领队行也带，删除/统计/领队行定位都按它过滤）
  main_task_id     INTEGER,             -- 实例行所属大任务 ID（task.task_id；独立无链任务=自身 id）；NULL=团队级行（领队主持行）
  now_task_id      INTEGER,             -- 当前执行任务 ID（task.task_id）
  name             TEXT NOT NULL,       -- 成员名（与 member.role_name 同名，写入代码查重）
  employee_id      INTEGER,             -- 工号（引用 member.employee_id，松引用）
  main_session_id  TEXT NOT NULL DEFAULT '',  -- 主代理会话 ID；还没启动时是空串（领队行存领队会话）
  child_session_id TEXT NOT NULL DEFAULT '',  -- 子代理会话 ID；还没启动时是空串
  role_id          INTEGER,             -- 角色 ID（roles.role_id，松引用）
  status           TEXT NOT NULL DEFAULT 'staged',
                   -- 成员状态：staged / ready / working / paused / removed
  persona_md       TEXT,                -- 执行时的人设手册（沿用 member 模板的手册，可按任务微调）
  model            TEXT,                -- 执行时采用的模型（沿用模板值；NULL=跟随）
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
);