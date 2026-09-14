-- =====================================================================
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
CREATE INDEX IF NOT EXISTS idx_ask_questions_team   ON ask_questions (team_id, status);