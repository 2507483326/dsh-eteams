# 35 SQLite 落地改造方案（DB-first 一步切换·定案）

> 状态：**已交付（2026-09-04）——开发按模型+持久层 / 运行时 / 面板工具测试三波完成，独立验收通过（报告落 docs/37：双 tsc 0 错、build 通过、vitest 23 文件 281 用例全绿、冒烟 122 断言全过、重启不重复导入、删库重建成功，无阻塞问题）**。
>
> 表结构基线：docs/27 定稿版——11 张表，主键 = 表自己的编号列统一整数自增，表尾 created_time / update_time，时间列一律 `_time` 结尾，表上无外键/CHECK/UNIQUE/触发器。本文第四节是全部确认结论，第五节是由此产生的行为变更，第六节是文件清单与执行流程。

## 一、目标与本轮边界

**本轮做完**：建库（11 张表）→ 一次性导入现有文件数据 → 写路径全部切 SQLite 单事务 → 文件停写（保留备份）→ 状态 13→10 收敛 → 随定案产生的模型简化。

| 本轮做 | 本轮不做 |
|---|---|
| 建库 + 建表 + `db_schema_version = 1` | token/usage 入库（已定案留 usage.jsonl） |
| 现有文件数据一次性导入（同一事务） | rolebuilder.json / captain-persona.yaml 入库 |
| 写路径全部切 SQLite（整存整取） | 归档表（docs/27 待定项） |
| 状态 13→10 收敛（含面板与工具） | 面板大改版（仅状态枚举、任务号、合同字段随之调整） |
| SQL 聚合读端点 `/eteams-api/board`（附带交付） | 跨进程文件锁（单写者场景进程锁已够） |

## 二、架构形态：内存模型保留，只换持久层

写路径现状：`locks.withLock` 内「recordEvent → 改内存 TeamState → writeTeam」。本轮**不改这个形状，只把底下的文件换成 SQLite**：

- `store.ts` / `events.ts` / `roster.ts` 对外函数签名不变，内部从文件改为 SQL；`readTeam` 从表重装 TeamState，`writeTeam` 在一个 `BEGIN IMMEDIATE … COMMIT` 事务内 DELETE 该团队数据 + 带原号重 INSERT（整存整取，崩溃要么整体回滚要么整体生效，不再需要补偿事件）。
- **发号全部来自数据库**：新任务/尝试/决策取号 = 读对应表自增计数 +1；工号 = member 表最大 `employee_id` +1（同一事务内，无计数器文件）。
- 面板轮询读走 WAL 读连接，不再被写锁阻塞。
- docs/27 的条件更新守卫（token / 状态流转 CAS）作为将来多实例场景的优化项，本轮不上（单写者 + 进程锁 + 事务原子已够）。

## 三、定案汇总（12 轮逐条确认的结论）

| # | 事项 | 结论 |
|---|---|---|
| 1 | 切换方式 | 一步切换真相（DB-first），不做只读投影/双写过渡；导入后旧文件停读写、保留备份 |
| 2 | 架构形态 | 内存模型保留，只换持久层（整存整取） |
| 3 | ID 类型 | 任务/尝试/决策/事件号从文本号（`t1`/`a1`）连内存模型一起改自增整数，面板显示「任务 #N」 |
| 4 | persona 存法 | persona_md 只存手册全文（结构字段不单独存；旧数据导入时把六字段渲染成全文；编辑把改动烘进全文再存） |
| 5 | 模型路线 | 只存 model + reasoning_effort 两列；provider 派发时按 `config.memberProvider` 解析；model 空=会话默认（修订 2026-09-04 用户迭代：settings agent-default-model 即时快照，原「继承领队会话模型」口径作废），有值=覆盖 |
| 6 | 团队级字段 | goal / phase / planReviewState / captainSessionId / captainChildId **砍掉**：团队只是定执行流程的容器；goal 的 11 处消费点（欢迎词/横幅/README/建队工具/面板等）一并删除（定案：真砍）。修订（2026-09-04 用户迭代）：leaderModelRoute 不砍——落 task_members 领队行 model/reasoning_effort，领队子代理派发按它解析 |
| 7 | 审批环节 | 「staged 草稿→批准→运行」的团队级状态门砍掉；开跑确认是**对话内纪律**（用户选队 → 领队分解任务选成员 → 用户确认 → 派任务开跑），不落团队级状态列 |
| 8 | 领队锚点 | team 表只留 `has_leader`；领队也是 task_members 一行（`name='项目牧羊人'`、`main_task_id` 空），会话锚点在那行，重启后去 task_members 找 |
| 9 | 成员模型 | **member = 纯模板**（一人一行，无状态无会话，`team_id` 空=公共模板/非空=班底；工号 `employee_id` 独立发号保留；班底同名复用模板行，不重开行）；**task_members = 执行实例**（状态/子会话/当前任务都在这）；实例行**按大任务粒度建**（同一人每条大任务一行、各绑独立子会话——定案），选行规则见 §5#12 |
| 10 | task 补列 | 合同四数组（acceptance/in_scope/out_of_scope/deliverables，JSON）+ idempotency_note + blocked_from + **work_dir（工作目录归任务，不归团队）** 共 7 列 |
| 11 | 反查/并入 | outcome 反查 attempts 最新成功行；decisionId/currentAttemptId 反查 decisions/attempts；suspendNote 并入 status_note；kind 不补列（parent_id 空=大任务）；maxRetries 用全局配置；activeSwitch 删 |
| 12 | 状态收敛 | 10 态 + 映射方案 A（见第四节）；**毒化集：paused/failed/wait_decision/wait_user 毒化下游**（旧 suspended 毒化、paused 不毒化，合并后 paused 也毒化——定案） |
| 13 | 归档 | **下线**（定案）：archiveTeam 与面板归档页删除，删团队走对话内确认 + 库事务删除；archive/ 目录不导入 |
| 14 | 事务形态 | `withTeamTx` 同步事务助手：锁内 BEGIN IMMEDIATE … COMMIT 之间**不得出现 await**，recordEvent 并入同一同步事务（审核实测：整队重写 15ms / 全量插入 31ms，量级无忧） |

## 四、状态 13→10 收敛映射（方案 A，已定案）

| 旧（13 态） | 新（10 态） | 说明 |
|---|---|---|
| draft / ready / paused / completed / failed / cancelled | 原名保留 | 6 态不动 |
| awaiting_decision / needs_user | wait_decision / wait_user | 仅改名 |
| assigned | wait | 已派待接取 = 等待 |
| in_progress | start | 执行中 |
| retrying | wait | 重试 = 重新排队等接取 |
| suspended | paused | 挂起 = 暂停，原因进 status_note |
| blocked | wait | 等上游；blocked_from 列记恢复目标，解除时还原 |

涉及面：taskMachine 转移表、assignment.ts 状态引用、webui ACTIVE_STATUSES（wait/start/paused/wait_decision/wait_user 五态）、client 看板分组与标签、工具描述文案。**毒化集**：POISON = {paused, failed, wait_decision, wait_user}（旧 suspended 毒化、paused 不毒化，合并后 paused 也毒化——定案）。

## 五、行为变更清单（随定案产生，开发时落实）

1. **审批环节重构**：approvePlan / planReviewState / phase 一套删除；createTeam 后团队即可用；领队在对话里等用户确认后才派任务（提示词纪律，不落状态）。
2. **领队会话解析重构**：requireCaptainTeam / notifyCaptain / 派发续聊改从 task_members 领队行（`team_id = ? AND name='项目牧羊人' AND main_task_id IS NULL`）取 `main_session_id / child_session_id`；has_leader 只标记班底里是否含领队；领队行由 createTeam 写入、captainDispatch 回填 child_session_id、leader 移除/恢复改行 status + has_leader。涉及调用点：store.findTeamByCaptain、tools/identity.resolveCaller、workspaces.locateAgentTeam、notifier.wakeMember、members setup hook、webui agentFor/agentactivity、captainDispatch、usage.resolveIdentity（全部换数据源，无结构性障碍——审核建议 3）。
3. **成员起会话时机**：不再「批准后一次性起全员」——首次派任务时按执行链起对应成员（task_members 行 staged → spawn → working）。
4. **spawnMember 模型解析**：member.model 有值 → agentOptions（provider = config.memberProvider）；空 → 会话默认（修订 2026-09-04 用户迭代：固定到 settings agent-default-model 即时快照；服务未挂退回不带 agentOptions，原「继承领队会话模型」口径作废）。
5. **workDir 归任务**：ensureWorkDir 改为逐任务分配 `task.work_dir`（撞名 -N 后缀逻辑保留，对比集改为其他任务的 work_dir 与目录存在性）；存量任务目录以字面路径导入（该列语义就是分配后固定，旧目录不改名）。
6. **maxRetries 全局**：每团队上限改为 config.maxRetries 统一（handoff.ts 与 failTask 同步）。
7. **任务号显示**：`t1` → `#N` 整数；工具参数（taskId 等）整数化（webui 路由段解析 parseInt）；taskSlug 变 `1-login` 格式，旧目录不迁移；领队提示词文案同步。
8. **面板**：计划审批 chip 移除；看板 10 态分组；任务抽屉 outcome 反查 attempts 展示；合同四数组/幂等说明展示；wait 列对 `blocked_from` 非空行打「阻塞中」徽标（找回旧 blocked 独立列的可见性）；事件增量拉取 `e.seq > afterSeq` 改 `event_id > afterSeq`。
9. **goal 真砍（定案）**：11 处消费点全部删除/改写——prompts/member.ts:37 欢迎词目标行、sessionTeam.ts:90 横幅、prompts/captain.ts 协议入参、docs.ts:54 README 目标行、teamOps.createTeam goal 参数与 TeamState、captainTools.ts:182 建队参数、webui teamSnapshot/建队路由、src/client 建队卡 goal 输入与展示（eteamsCard/teamsButton/teamTab）、monitor.ts 类型。
10. **归档下线（定案）**：archiveTeam 与 webui 归档页（collectArchivedTeams）删除；deleteTeam 改对话内确认；store.archiveRoot / archive/ 目录不再使用。
11. **blocked_from 四处必改**（审核建议 1）：refreshDependencyStatus（入口 `blocked_from !== undefined`，物化=置 wait + blocked_from='ready'，EDGES.ready 新增 wait 边）、restoreBlocked（入口判 blocked_from，恢复目标=blocked_from，解除清空）、resumeTask（`blocked_from !== undefined && status_note` 分支，恢复目标用 blocked_from 不硬编码 ready）、refreshDependents（过滤 `ready || blocked_from 非空`，task.blocked/unblocked 事件判据同步）；随动 failTask 重试路径 retrying→assigned 改落 wait、suspendTask 搭车分支改 wait + blocked_from + status_note。
12. **实例行粒度与选行（定案：每大任务独立会话）**：实例行唯一键 = (team_id, name, main_task_id)，main_task_id = 任务的根大任务（独立无链任务=自身 id）；任务级操作（派发/链推进/唤醒/进度）按「task 的根」定位行；跨任务操作（sendMessage 按名发信、requireMember）无任务上下文，选**最近活跃**实例行（status 非 removed、child_session_id 非空、update_time 最新）。

## 六、改造文件清单

**新增 3 个：**

| 文件 | 职责 |
|---|---|
| `src/host/state/db.ts` | 连接缓存 + PRAGMA（WAL / synchronous=NORMAL / busy_timeout=3000）+ DDL 执行 + `db_schema_version` 读写 + 首次建库判断 |
| `src/host/state/schema.sql` | 11 张表 DDL 全文（docs/27 定稿版逐字） |
| `src/host/state/import.ts` | 首次启动导入器：库里无 `db_schema_version` 且旧文件存在 → 同一事务导入 team.json / events.jsonl / inbox / roster.json，文本号换算整数号，persona 六字段渲染成手册全文，完成写版本号；旧文件不存在 → 空库起步；已有版本号 → 跳过。**导入细则**：events.payload 与 mail 字段里的旧文本号（t1/a1/d1）按映射换算（正文不换）；inbox 文件名 → box_key，MailMessage.id 原样保留为 message_id，箱内 seq 丢弃换全库号；存量任务的旧目录字面路径直接存 task.work_dir；archive/ 目录跳过；employeeId `ET-0001` → 整数回填；employee-seq.json 不导入（新号 = member 最大工号 +1）；首次建库同时写 roles 预置 + ensurePresetMembers 对应的公共模板行 |

**修改：**

| 文件 | 改动 |
|---|---|
| `src/host/state/store.ts` | readTeam / writeTeam / listTeams 改 SQL；`withTeamTx` 同步事务助手（BEGIN…COMMIT 无 await）；findTeamByCaptain 换领队行；archiveRoot 删除 |
| `src/host/state/events.ts` | recordEvent / readEventsSync / appendMail / readMailboxSync 改 SQL（并入同步事务） |
| `src/host/runtime/roster.ts` | 成员模板读写改 SQL（member / roles 表）；employee-seq.json 弃用删除 |
| `src/host/model/types.ts` | TaskStatus 10 态；ID 整数化；TeamState 精简（goal/phase/planReviewState/captainSessionId/captainChildId/leaderModelRoute/maxRetries/activeSwitch/taskSeq 系删除）；新增 TaskMemberRecord（执行实例：status/会话锚点）；TaskRecord 增合同字段 |
| `src/host/model/taskMachine.ts` | 状态机收敛 10 态；POISON 更新；blocked_from 四处必改（§5#11） |
| `src/host/runtime/assignment.ts` | 发号改 DB 取号、状态引用 10 态、任务号整数化、workDir 逐任务、refreshDependents 判据 |
| `src/host/runtime/teamOps.ts` | createTeam 精简（删审批/phase/goal）、领队锚点重构、addMember 模板化、maxRetries 全局、archiveTeam 删除 |
| `src/host/runtime/notifier.ts` | wakeMember / readBox 会话与邮箱走 task_members 行 + SQL；实例行选行规则（§5#12） |
| `src/host/runtime/members.ts` | spawnMember 模型解析简化、按实例行找会话、首派按链起人 |
| `src/host/runtime/docs.ts` | README 去 goal/phase 行；taskDirRel 重构（task.work_dir）；归档读删 |
| `src/host/runtime/workspaces.ts` | locateAgentTeam 换领队行/实例行 |
| `src/host/runtime/sessionTeam.ts` | 横幅去 goal/phase |
| `src/host/runtime/usage.ts` | resolveIdentity 队长识别换领队行 |
| `src/host/runtime/webui.ts` | teamSnapshot 经 store API；ACTIVE_STATUSES 五态；审批 chip 移除；任务号 `#N`；合同字段展示；归档页删除；事件增量 event_id |
| `src/host/prompts/*`（captain.ts / member.ts / handoff.ts） | captain 审批红线文案去 phase、member 去 goal、handoff 状态词与 maxRetries |
| `src/host/tools/*`（captainTools / memberTools 等） | 任务号参数整数化、审批工具下线、提示词文案同步 |
| `src/client/*` | 状态标签/看板分组 10 态（features/tasks/taskDisplayStatus 全文件重写）；任务号显示；任务抽屉 outcome 反查；建队卡去 goal |
| `tests/*` | 13 个文件约 100 处 13 态/被砍字段引用随改造更新 |

**附带交付**：`src/host/state/queries.ts` + `GET /eteams-api/board`（跨团队聚合：团队列表 + 大任务进度 + 按状态分列 + 成员待派 + 待决策）。

**验收门禁**：`npm run build` 通过；vitest 全绿；冒烟走通「建队 → 分解任务 → 选成员 → 派发 → 汇报 → 完成」全流程（对话内确认开跑）；重启不重复导入；删库后从备份文件可重新导入；面板无回归。

## 七、执行流程（既定分阶段子代理流程）

docs/27 已定稿 → **审核**（独立子代理核查定案与代码映射，报告落 docs/36）→ **开发**（按第六节清单实现，大文件串行）→ **验收**（build + 冒烟 + 重启导入 + 删库重建，报告落 docs/37）→ 修订归档。