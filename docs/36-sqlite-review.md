# 36 SQLite 落地改造审核报告

> 审核对象：docs/27-sqlite-schema.md（11 表 DDL 定稿版）+ docs/35-sqlite-execution-plan.md（定案）。
> 审核方法：DDL 用 Node 24 `node:sqlite` 实建库验证（脚本放系统 Temp，仓库零污染）；每条结论逐条对照 src/host、src/client、tests 源码，给 file:line 证据。日期 2026-09-04。

## 结论：需修订后开工

五项阻塞，修订量约半天（DDL 两行修复 + task_members 加一列 + 三个拍板），修订后按 docs/35 §7 流程开工。逐条如下。

---

## 一、阻塞（必须先修订）

### 阻塞 1 DDL 原文不可执行：task 表双主键 + 悬空逗号

docs/27:209-210 的 task 表尾部：`update_time INTEGER NOT NULL,` 带尾随逗号，下一行是表级 `PRIMARY KEY (task_id)`，而列级已有 `task_id INTEGER PRIMARY KEY AUTOINCREMENT`。Node 24 实测建库报错：

```
table "task" has more than one primary key
```

docs/27:112 声称「已在 Node 24 内置 SQLite 上验证」，与事实不符——这个 DDL 从未整段跑通过。

**修复（已实测验证）**：删掉表级 `PRIMARY KEY (task_id)` 一行，并把上一行 `update_time INTEGER NOT NULL,` 的逗号去掉（注意 `-- 更新时间` 注释在同一行，只去逗号）。修复后：11 表 + 19 索引全部建成，11 表冒烟插入 OK，Q1–Q11 全部 prepare OK，两段守卫 UPDATE prepare OK。`schema.sql` 必须用修好的版本，不能照抄 docs/27 现文。

### 阻塞 2 task_members 缺 team_id，四处功能写不出来

task_members 只有 main_task_id / now_task_id / name / employee_id，没有 team_id。后果：

1. **删团队规则不可执行**（docs/27:361）：「task_members 按 main_task_id 属于这些任务删，main_task_id 为空的领队行不在此列，随团队一起删」——领队行 main_task_id 为 NULL、now_task_id 也常为 NULL，库中**没有任何列**把它和所属团队关联；两个团队的领队行都叫 `name='项目牧羊人'`，无法区分。「随团队一起删」这句话在现 schema 下写不成 SQL，只能靠代码先查 team 再猜行——而猜的依据不存在。
2. **Q5 成员待派统计跨团队泄漏**（docs/27:456-460）：`FROM task_members tm WHERE tm.status <> 'removed'` 无 team 过滤（task.team_id 过滤只作用于子查询）。实测 EXPLAIN QUERY PLAN：`SCAN tm` + `USE TEMP B-TREE FOR ORDER BY`——全表扫描且把别的团队的成员行混进本队统计。
3. **领队会话解析没有定位路径**（docs/35 §5#2）：「重启后去 task_members 找领队行」——按什么找？没有 team_id 就只能按 name 全库扫，多个团队各有领队行时结果不唯一。
4. **身份解析同因失效**：resolveCaller（src/host/tools/identity.ts:96）、locateAgentTeam（src/host/runtime/workspaces.ts:143）现在靠 `captainSessionId === sessionId` 定团队；重构后改查领队行，同样需要 team 维度。

**修复**：task_members 加 `team_id INTEGER NOT NULL`（写入代码维护，与全库「无外键」口径一致）；Q5 改 `WHERE tm.team_id = ?1 AND tm.status <> 'removed'`；删除规则按 team_id 删全部实例行（含领队行，main_task_id 条件只用于区分行类型）；领队行查找统一为 `team_id = ? AND name = '项目牧羊人' AND main_task_id IS NULL`。

### 阻塞 3 team.goal 砍掉，但 11 处消费点没有去向

docs/27:383 与 docs/35 §3#6 把 goal 随 phase 一起砍掉，team 表也没有 goal 列；docs/35 §5 行为变更清单 8 条里没有 goal 的任何条目。但 goal 是活的：

| 消费点 | 位置 |
|---|---|
| 成员欢迎提示词「团队目标：」 | src/host/prompts/member.ts:37 |
| 会话横幅 `team.goal || '（待完善）'` | src/host/runtime/sessionTeam.ts:90 |
| 领队协议提示词入参 | src/host/prompts/captain.ts（captainProtocolFull 接 goal） |
| 团队 README「目标：」行 | src/host/runtime/docs.ts:54 |
| createTeam 收 goal / 写 TeamState | src/host/runtime/teamOps.ts:93、111、678 |
| eteams_create_team 参数与团队列表快照 | src/host/tools/captainTools.ts:182、1212 |
| webui teamSnapshot / 建队路由 body.goal | src/host/runtime/webui.ts:202、359、706 |
| 面板：建队卡 goal 展示、卡片 title、目标行 | src/client/pages/eteamsCard.tsx:152、254；src/client/pages/teamsButton.tsx:662；src/client/pages/teamsView/teamTab.tsx:503 |
| 客户端快照类型 | src/client/lib/monitor.ts（TeamSnapshot.goal） |

关键点：改造后 TeamState 由表重装（docs/35 §2），表里没有 goal，重启后 goal 必为空——领队上下文和会话横幅直接断粮，这不是「砍展示」而是「砍数据源」。

**修复（二选一，需拍板）**：
- a. team 表加 `goal TEXT` 列（推翻「team 表零新增列」措辞，需定案人重确认；推荐——goal 是提示词与横幅的实料）。
- b. 真砍：docs/35 §5 补一条行为变更，逐点列上表 11 处的删除/改写（建队参数 goal 去留、欢迎词改口头交代、横幅/README/面板全部去 goal），eteamsCard 建队卡的 goal 输入同步下线。

### 阻塞 4 POISON 集未随 13→10 收敛更新，paused 语义冲突

src/host/model/taskMachine.ts:97-102：`POISON = { suspended, failed, awaiting_decision, needs_user }`。注意 **'paused' 不在其中**（成员主动暂停不毒化下游），**'suspended' 在其中**（队长挂起毒化下游）。方案 A 把 suspended 并入 paused（docs/35 §4）后二者必选其一：

- paused 算毒化 → 成员主动暂停开始毒化下游（行为变化，docs/35 §5 未列）；
- paused 不算毒化 → 队长挂起不再毒化下游（行为变化，同上）。

消费点：refreshDependencyStatus（taskMachine.ts:131-149）、refreshDependents（assignment.ts:1012 起，poisoningDependencies 判定）。

**修复**：拍板写入 docs/35 §4。建议：毒化保留（挂起/失败/待决策/待用户的「流程卡住」语义一致），接受「成员主动暂停也毒化下游」这一简化——如需区分，用 status_note 里的挂起标记判，但那会把语义藏进文本，不建议。

### 阻塞 5 phase 砍掉后归档/删除门控失效，archive 目录与库无对应

- archiveTeam 门控 `phase === 'completed' || 'halted'`（src/host/runtime/teamOps.ts:724-725）；deleteTeam 门控 staged/completed/halted（teamOps.ts:772）；findTeamByCaptain 用 `phase !== 'completed'` 排除已完成团队（src/host/state/store.ts:133 起）。phase 删除后这三处门控失去输入，删除变成完全无门控。
- 归档现状是目录级：archiveTeam 把团队目录改名进 archive/，webui collectArchivedTeams 用 `readTeamSync(archive, …)` 读（webui.ts:354），events.ts archiveRoot 同理。DB 化后没有目录可改名，team 表又没有 archived 列（docs/27:526 明写「待定」）——不解决则归档团队照常出现在团队列表，归档功能整体失效。

**修复（最小）**：team 表补 `archived_time INTEGER`，archiveTeam 改写列；Q1 与团队列表按 `archived_time IS NULL` 过滤；completed 判定改为派生（该团队全部大任务 completed）。若本轮明确不做归档，则 docs/35 §5 必须写死：archiveTeam 与 webui 归档页下线、deleteTeam 改对话内确认，且 docs/27:526 的待定项同步销掉。无论选哪边，这是 docs/35「确认点全部拍板」漏掉的一个确认点。

---

## 二、建议（修订时一并处理）

### 建议 1 blocked_from 重写方案（13→10 收敛的核心语义）

现状事实链：blocked 只从 ready 物化（taskMachine.ts:136-142 只对 `status === 'ready'` 触发）；blockedFrom 记录的只可能是 `'ready'`（applyTransition taskMachine.ts:67-71；唯一另一处入口是 suspendTask 的 ready→blocked「搭车」，assignment.ts:522-523）；退出走 restoreBlocked（taskMachine.ts:82-94，target = blockedFrom ?? 'ready'，target 为 ready 且依赖未满足则不退）；resumeTask 对带 suspendNote 的 blocked 硬编码回 'ready'（assignment.ts:552-556）；refreshDependents 过滤 `ready || blocked`（assignment.ts:1012-1020）。

任务书里问的「wait 同时是 assigned 和 blocked 的归宿，解除时会不会错还原」——**不会**，前提是还原判据从 `status === 'blocked'` 换成 `blocked_from IS NOT NULL`：普通 assigned-wait 的 blocked_from 为 NULL，还原逻辑不碰它；物化过的 wait 有 blocked_from，还原到 blocked_from（实践中只有 'ready'）。'wait' 本身三义（已派待接取 / 重试重新排队 / 阻塞等上游）由 blocked_from 与 status_note 区分。

必须改的四处：
1. refreshDependencyStatus：入口 `task.status === 'blocked'` 改为 `task.blocked_from !== undefined`；物化动作改为「status 置 wait + blocked_from = 'ready'」——blocked 不在 10 态里，物化不再走 applyTransition（或在 applyTransition 加可选参数），EDGES.ready 需要新增 'wait' 边。
2. restoreBlocked：入口判 blocked_from；恢复目标 = blocked_from；守卫不变；解除后清空 blocked_from。
3. resumeTask（assignment.ts:552-556）：`status === 'blocked' && suspendNote` 分支改 `blocked_from !== undefined && status_note` 分支，恢复目标用 blocked_from，不硬编码 'ready'（今天恰好相等，重构后不得依赖巧合）。
4. refreshDependents（assignment.ts:1012）：过滤条件改 `t.status === 'ready' || t.blocked_from !== undefined`；task.blocked / task.unblocked 事件（assignment.ts:1020）的触发判据同步。

随动：failTask 重试路径（assignment.ts:845-851）retrying→assigned 改成一落 wait；suspendTask ready 搭车分支（assignment.ts:522-523）改 wait + blocked_from + status_note。

真正的新问题是**显示混淆**：wait 列同时装「已派待接取」与「阻塞等上游」（旧 blocked 是独立列）。建议面板对 `blocked_from` 非空的 wait 行打「阻塞中」徽标，把旧可见性找回来。

### 建议 2 13 态字符串引用点清单（docs/35 §4 涉及面的补全）

除 §4 已列的 taskMachine 转移表 / assignment.ts / webui ACTIVE_STATUSES / client 分组外，逐点补：

- src/host/runtime/teamOps.ts:572-574：removeMember 打回 ready 的三态列表（assigned/in_progress/retrying）→（wait/start）。
- src/host/tools/memberTools.ts:242：boardTool currentTask 四态过滤（assigned/in_progress/retrying/paused）→（wait/start/paused）。
- src/host/runtime/webui.ts:95-102：ACTIVE_STATUSES 六态 → 五态（wait/start/paused/wait_decision/wait_user）；webui.ts:113、121、217、1728 四处消费随动。
- src/host/prompts/handoff.ts:112：awaiting_decision 文案 → wait_decision；handoff.ts:103-107 与 assignment.ts failTask（842 起）的 maxRetries 改读全局配置。
- src/host/prompts/captain.ts:12、15、32、33、71、74：审批红线文案（§5#1 范畴，但 §6 文件清单没列 prompts/）。
- tests/：13 个文件合计约 100 处 13 态/砍掉字段引用（taskDisplayStatus.test.ts 23、model.test.ts 16、lifecycle 与 webui.test.ts 各 13、workspaces.test.ts 8、sessionTeam.test.ts 6 等）。§6 文件清单完全没提 tests/，验收门禁也没有 vitest——补进 §6 与门禁。
- src/client/features/tasks/taskDisplayStatus.ts 全文件（13 态词表 STATUS_LABELS / 6 桶 DISPLAY_STATUS_TABLE / STATUS_GROUPS）按 10 态重写。

### 建议 3 领队锚点重构落地清单（docs/35 §5#2 的调用点级展开）

现状锚点读取点（全部要换数据源到领队行）：

| 调用点 | 现状用法 | 重构后 |
|---|---|---|
| store.ts:133 findTeamByCaptain | captainSessionId 匹配 && phase !== 'completed' | 领队行 main_session_id 匹配 && status !== 'removed'（phase 门控随阻塞 5 一并定） |
| identity.ts:96 resolveCaller 第 3 优先级 | `t.captainSessionId === sessionId` | 领队行 main_session_id 匹配（需阻塞 2 的 team_id） |
| workspaces.ts:143-147 locateAgentTeam | captainSessionId 匹配 / `m.id === agentId` | 领队行 main_session_id / 实例行 child_session_id 匹配 |
| notifier.ts:61 wakeMember | `agents.get(team.captainSessionId)` + `member.id` | `agents.get(领队行.main_session_id)` + 实例行 child_session_id |
| members.ts:240-241 setup hook | readTeamSync + `captainSessionId === parentSession` 校验 | 领队行 main_session_id 校验（readTeamSync 重装时把领队行带回 TeamState 即可） |
| webui agentFor / agentactivity | listChildren(team.captainSessionId)（webui.ts:1509 一带） | listChildren(领队行.main_session_id) |
| captainDispatch.ts:82-95、166 | persistCaptainChildId 锁内写 team.captainChildId；previous = captainChildId → followup | 锁内 UPDATE 领队行 child_session_id；previous 读领队行 |
| usage.ts resolveIdentity | listTeams 按 captainSessionId 识别队长 | 同上换领队行 |

可行：全部是「换数据源」级改动，没有结构性障碍。领队行生命周期：createTeam 写入（has_leader=1 + 领队行 main_session_id=当前会话 id，child_session_id 空串）；captainDispatch 首次派发回填 child_session_id；leader remove/restore 改行 status + has_leader（docs/27:387 的 leaderRemoved→has_leader 映射成立，但 restore 流要补：恢复 = has_leader 置 1 + 领队行 status removed→ready，行若已删则重建）。
persona 关系（captainDispatch.ts:76-77）：重构后手册来源 = member 表领队模板行 persona_md ?? composeCaptainPersona（captain-persona.yaml）；yaml 仍按文件走（docs/35 §1 已定不入库），优先级与现状一致，代码里保持即可。
导入：存量 captainSessionId/captainChildId → 领队行 main_session_id/child_session_id；leaderTaken（leaderRemoved=true）团队导入为 status='removed' 领队行 + has_leader=0。

### 建议 4 成员模板/执行实例的使用点核对（docs/35 §3#9 的落地面）

- requireMember（按 name + status !== 'removed'）→ 查 task_members (team_id, name)；wakeMember 的 `if (!member.id) return false` staged 判断（notifier.ts:57）→ `!row.child_session_id`。
- spawnMember 模型解析（members.ts:86-90 的 leaderModelRoute 分支）删除，与 §5#4 一致；spawn 时插 task_members 行（staged → working）并回填 child_session_id。修订（2026-09-04 用户迭代）：空路线分支恢复但语义改为「会话默认」（settings agent-default-model 即时快照）；领队模型选择同时恢复——task_members 领队行 model/reasoning_effort 即团队默认路线，领队子代理派发按它解析。
- addMember 在 phase running 时立即 spawn（teamOps.ts:302）——phase 删掉后该分支没了，建议统一为「首次派任务时起会话」（与 §5#3 一致），addMember 只建模板/实例行。
- 链推进 advanceTask / reassignTask / sendMessage / freeMember：member.currentAttemptId 改实例行字段或反查 attempts（docs/27:389 已写反查，代码面等价替换）。
- 多并行任务多实例行的选行问题 → 见待确认 1。

### 建议 5 审批移除调用点清单（docs/35 §5#1 的补全）

- approvePlan 本体：teamOps.ts:156-186（内含 ensureWorkDir 分配、spawnTeamMembers 一次起全员、phase 迁移）。
- 面板链路：webui.ts:1177-1193 POST /team/<id>/approve；src/client/lib/api.ts:371-372 approveTeamPlan；src/client/pages/teamsView/boardTab.tsx:59-66、108-119 审批横幅与对话框；webui.ts:41 一带 approvePlan 导出；webui.ts:271 'plan.approved' 事件分支。
- 状态展示随砍：createTeam 的 planReviewState:'awaiting_review'（teamOps.ts:96）；teamView（teamOps.ts:680）；monitor.ts:138 planReviewState；boardTab/eteamsCard/teamsButton/teamTab 的 PHASE_LABELS/PHASE_TONES 消费；sessionTeam 横幅 phase 行；docs.ts:55 README 状态行。
- 「批准后一次起全员 → 首派按链起人」（§5#3）落在 assignTask：派发时检查链上成员的实例行，staged 则 spawn。注意 assignTask 的 MEMBER_BUSY 检查基于 member.currentAttemptId（assignment.ts:440-460 一带），改实例行后逻辑等价。
- ensureWorkDir（teamOps.ts:140-152，-N 后缀对比其他团队 workDir）改 ensureTaskWorkDir：逐任务在 createTask（assignment.ts:148-149 原团队级分配点）分配 task.work_dir，-N 逻辑保留但对比集改为其他任务的 work_dir 与目录存在性。

### 建议 6 导入映射补漏（docs/27 §27.6/505 + docs/35 §6 import.ts 的文件级展开）

docs/27:505 只列了文件名。逐文件：

- **team.json**：team_name/has_leader → team 行；members → member 模板行（team_id 非空）+ task_members 实例行；tasks → task 行（`t1` → 整数重排，parent_id/depend_tasks 换算）；attempts → attempts（`a1` → 整数，task_id 换算）；pendingDecisions → decisions（`d1` → 整数，task_id/attempt_id 换算）；captainSessionId/captainChildId → 领队行；workDir → 转 task.work_dir（见下）；maxRetries 弃用（全局配置）；version/taskSeq/attemptSeq/mailSeq 弃用（mailSeq 现已无写入方，仅 types.ts:250 与 teamOps.ts:102 初始化——直接删）；goal/phase/planReviewState 按阻塞 3 的决定处理。
- **events.jsonl**：按序导入，event_id 全库自增（per-team seq 丢弃）；actor 拍平 actor_kind/actor_name。**payload 里的 taskId/attemptId/decisionId（如 assignment.ts:500 的 payload.decisionId）是旧文本号，必须按映射表换算**——docs/27:407 只说 payload 存 JSON 一列，没提换算。
- **inbox/*.jsonl**：文件名 → box_key；MailMessage.id 原样保留为 message_id；per-box seq 丢弃，换 mail_message_id 全库自增；taskId/attemptId 字段换算。**content 正文里的「任务 t1」文本不换算**（无法可靠改写）——面板显示 #N 与旧文本混排，可接受但要知道。
- **roster.json**：六字段（role/duty/style/skills/rules/executionPrompt）烘进 persona_md 全文；employeeId `'ET-0001'` → 整数 1 回填（DDL 里 employee_id 是 INTEGER）；employee-seq.json 无需导入（新号 = member 表最大 employee_id + 1，docs/27 已定）。
- **archive/ 目录**：跳过不导入（归档团队不进库）——docs/27 §27.6 没写这条，补上，并与阻塞 5 的归档决定对齐。
- **task.work_dir 导入**：存量任务的目录是旧 slug 格式 `teams/<slug>/tasks/t1-xxx`。把字面路径直接存进 task.work_dir（该列语义就是「分配后固定，不可重推导」），旧目录不做改名迁移；新任务才用整数号分配新目录。
- 首次建库还要写 roles 表预置 + ensurePresetMembers 对应的公共模板行（roster.ts:238 逻辑平移）。

### 建议 7 写路径与锁（实测数据）

- 整存整取代价实测（Node 24，:memory:）：500 任务 + 2500 尝试 + 500 事件 + 3000 邮件单事务插入 31ms；整队 DELETE + 带原号重插 15ms。≤500 任务规模毫无压力，docs/27:511「重写毫秒级」成立。
- readTeamSync 同步调用点（members.ts:240 setup hook、workspaces.ts:81/95、webui 各 handler、sessionTeam 装配、webui.ts:248/1505 轮询读）在 DatabaseSync 下天然成立，函数签名不用改。
- 真正要注意的是 withTeam 锁内的事务体：BEGIN IMMEDIATE 与 COMMIT 之间不得出现 await。现状 writeTeam 前有多次 `await recordEvent`（assignment.ts 各处）——切 SQL 后 recordEvent 必须并入同一同步事务，否则要么中间态被读连接看到，要么异常路径漏 ROLLBACK。建议 store 层提供同步事务助手（如 `withTeamTx(fn)`），把 recordEvent + mutation + writeTeam 收敛为一次 BEGIN…COMMIT；lock.ts 的 promise 链互斥保持外层不变（实测：同句柄事务跨 await 能跑，但会拉长写锁窗口，仍按同步体做）。
- 事件增量拉取 webui.ts:1505 `e.seq > afterSeq` 改 `event_id > afterSeq`（全局自增单调，客户端 afterSeq 语义照用）；boardTab latestEvents 以 e.seq 为键同步改。

### 建议 8 docs/35 §6 文件清单补全

遗漏且必改：src/host/runtime/docs.ts（README goal/phase 行、taskDirRel 重构）、src/host/runtime/workspaces.ts:143-147、src/host/runtime/sessionTeam.ts:90、src/host/runtime/usage.ts（resolveIdentity 队长识别）、src/host/prompts/*（captain.ts 红线、member.ts goal、handoff.ts 状态词与 maxRetries）、approvePlan 的模块出口导出、tests/（13 文件）。§6 已列的文件无虚列。

### 建议 9 docs/27 查询块内在不一致

- Q4（docs/27:434-437）看板列 `IN ('ready','wait','start','paused')` 与 docs/35 §4 的 ACTIVE_STATUSES 五态（wait/start/paused/wait_decision/wait_user）不一致：Q4 多 ready、少 wait_decision/wait_user。定一个（建议看板 = 五态，ready 单列为「待派」）。
- 守卫示例（docs/27 第三段 sql 块）`UPDATE task SET status='start' WHERE status='ready'`：10 态里接取是 wait→start，示例按旧 13 态写的。docs/35 §2 已定本轮不上 CAS 守卫，示例仅文档性质，但建议改成 wait→start 免得开发照抄。

### 建议 10 任务号整数化的外溢

- taskSlug（taskMachine.ts:178-181）变 `1-login` 格式，新任务目录名随之；旧目录不迁移（建议 6 的 work_dir 字面路径方案覆盖）。
- 工具参数 taskId 整数化：memberTools / captainTools 的 string 校验、webui 路由 /task/<taskId>/update|delete 的段解析改 parseInt。
- client tasksTab/taskDrawer 的任务号显示 `#N` 与 STATUS_GROUPS 改造覆盖（§6 已列 src/client/*，此处确认范围）。

---

## 三、待确认（开发前问定案人）

1. **同一成员并行多任务时 wakeMember 找哪一行**：若 task_members 按「成员 × 大任务」建实例行，同一人两条并行链 = 两行两个 child_session_id，wakeMember（notifier.ts:55 起）/ advanceTask / requireMember 都没有「哪一行」的判据，docs/35 未写。**推荐：实例行唯一键 (team_id, name)**——每人每队一行，main_task_id 记首次 spawn 所属大任务（纯记录），now_task_id 由链推进更新，并行任务共享同一子会话（与现状 member.id 单会话语义一致，改动最小）。若产品想要「每大任务独立会话」，须先定 child_session_id 多行语义与 wakeMember 选行规则（按 now_task_id 还是 main_task_id）——这是模型分叉点，不要在开发中顺手决定。
2. **班底成员与公共模板同名**：复用一行（team_id 从 NULL 变团队）还是各建一行？影响 addMember 工号分配（max+1 会跳号）与 docs/27:388「同人跨团队同号」。建议同名即复用模板行（工号唯一），班底只是 team_id 标记 + task_members 实例行。
3. **roles 表与 member.persona_md 的分工**：roles 存模板全文、persona_md 存实例手册？还是 roles 只做目录？rolebuilder 确认产物写哪（docs/27:395 说写 roles，docs/35 §1 说 rolebuilder.json 不入库——不矛盾但职责没切干净）。
4. **归档形态**（阻塞 5 的最终选择）：archived_time 列 vs 归档表 vs 本轮下线归档。
5. **goal 去向**（阻塞 3 的 a/b 选择）。

---

## 四、验证记录（Node 24 node:sqlite，脚本在系统 Temp，仓库零污染）

- 原 DDL：`CREATE TABLE task` 报 `table "task" has more than one primary key`（阻塞 1）。
- 修复后：11 表 + 19 索引全建成（idx_task_current / idx_attempts_token / idx_attempts_status / idx_events_task / idx_mail_unread / idx_decisions_open 六个部分索引在列）；11 表冒烟插入 OK；Q1–Q11 prepare OK；两段守卫 UPDATE prepare OK。
- Q5 现文 EXPLAIN QUERY PLAN：`SCAN tm` + `USE TEMP B-TREE FOR ORDER BY`——阻塞 2 的直接证据。
- 性能：500 任务 + 2500 尝试 + 500 事件 + 3000 邮件 31ms；整队 DELETE + 带原号重插 15ms（建议 7）。
- node:sqlite 警告：Node 24 运行打 ExperimentalWarning，与 docs/27:48 一致，无碍。

---

## 五、结论复核

修订阻塞 1-5（半天量级：DDL 两行修复、task_members 加一列、goal / POISON / 归档三个拍板，全部落在 docs/27 与 docs/35 的文本修订），然后按 docs/35 §7 流程开工。建议 1-10 与待确认 1-5 并入开发前最后一次文档修订即可，不构成第二轮全面审核的理由。