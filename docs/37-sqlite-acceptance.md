# 37 · eTeam SQLite 改造验收报告（独立复验）

- 日期：2026-09-04
- 验收人：独立验收（不采信任何开发报告，全部结论基于本报告内的真实命令输出与代码级核对）
- 工作目录：`C:\eTeam`（Windows，bash，Node v24.11.0，node:sqlite）
- 被测对象：当前工作树（三波开发产物，未提交改动即被测面）。工作树中全部代码文件最后修改时间为 17:44 及以前（`src/client/lib/api.ts`），验收期间的冒烟脚本全部位于系统临时目录，仓库内仅新增本文件。

## 一、总体结论

**通过，可以交付。** 8 个门禁全部独立复验通过（门禁 1-3 真实命令 exit 0；门禁 4 冒烟 122 条断言全 PASS；门禁 5/6/7/8 各脚本全 PASS）。验收前通报的 6 处修复逐一以代码行号 + 运行时证据双重确认落地。未发现阻塞问题；发现 1 条一般问题（工具参数类型不一致）与 4 条记录项（文档数字、陈旧注释、语义说明），均不影响交付。

## 二、验收方法与口径

- 构建产物驱动：冒烟脚本 `import { apply } from 'file:///C:/eTeam/lib/index.js'`（构建产物），以 fake 宿主运行时（subagents / agents / tools.register / webServer.register / workspaceRegistry）挂载**真实的**工具面与 web 路由，再以 `node:sqlite` 第二条连接直查 `.eteams/db/eteams.db`（只 SELECT）核对落库事实。
- 临时产物全部在系统 Temp（`C:\Users\epat\AppData\Local\Temp\eteams-acc\*`），每轮脚本 mkdtemp 新建工作区，仓库零污染（文末有说明）。
- 状态根口径：`joinPath` 用 `/` 拼接，脚本同口径取 `workspace + '/.eteams'`。
- 脚本清单（均留存输出）：`p1-flow.out`（门禁 4+7+8）、`p2-restart.out`（门禁 5）、`p3-legacy.out` + `p4-rebuild.out`（门禁 6）、`p5-suspend.out`（§5#11 补充）。

## 二、门禁逐项

### 门禁 1：双 tsconfig typecheck

命令与输出（真实，两次运行一致）：

```
$ npx tsc --noEmit -p tsconfig.host.json
HOST_TSC_EXIT=0            # 无任何错误输出

$ npx tsc --noEmit -p tsconfig.client.json
CLIENT_TSC_EXIT=0          # 无任何错误输出
```

### 门禁 2：构建

```
$ npm run build
✔ Build complete in 1617ms
wrap-client: wrapped lib/client.stage.js -> lib/client.js (atomic) as id "dsh-eteams"
SMOKE OK: id=dsh-eteams, exports=[apply, inject]
BUILD_EXIT=0
```

### 门禁 3：测试

```
$ npx vitest run
 Test Files  23 passed (23)
      Tests  281 passed (281)
VITEST_EXIT=0
```

数量记录：**23 个文件、281 个用例，全绿**（含 lifecycle 离线全流程 3 例、webui 33 例、usage 17 例）。

### 门禁 4：冒烟全流程（122 条断言全 PASS，exit 0）

真实调用 27 个 `eteams_*` 工具与面板路由，SQL 直查核对。关键断言摘录（完整见 `p1-flow.out`）：

| 步骤 | 断言 | 证据 |
|---|---|---|
| 建队 | team 行 `has_leader=1`；领队行 `main_session_id='cap-1'` / `status='ready'` / `main_task_id IS NULL` | SQL 行 JSON |
| 选成员 | 3 条 member 模板行、工号整数不重复（3/4/5）；task_members 3 行 `staged`、`child_session_id=''` | SQL 行 JSON |
| 分解 | 任务号整数（1 容器 / 2 子任务）；`member_chain_list` 两站；`work_dir='teams/验收团队/tasks/1-导出功能主任务单/sub/2-调研并实现导出'` 且目录物化 | SQL + existsSync |
| 审批删除 | 工具面 27 个无 `eteams_approve_plan`；team 表仅 5 列（team_id/team_name/has_leader/created_time/update_time），无 goal/phase/plan_review | 工具清单 + PRAGMA |
| 首派 | 任务 `wait`+current_member=Alice；attempts `kind='stage'`/`status='pending_accept'`/`token=''`（claim 才发号）；实例行 `staged→working`+child_session_id 回填+`main_task_id=1`；派发邮件落箱 | SQL 行 JSON |
| claim | attempts `running`+claimed_time+`token` 回填 24 位 hex；任务 `start`；错 token 被拒「token 校验失败」 | SQL + 错误消息 |
| 中间站完成 | `done=false`、回 `ready`、`chain_cursor=0`；attempts `succeeded`+result_output/changed_paths 落列；**领队邮箱收到「下一站 Bob」邮件且被唤醒**（followups +1，修复②证据） | SQL + fake 交付记录 |
| 末站完成 | `chain_cursor=1=chain.length-1`（修复③）；组任务自动 `completed`；末站邮件「任务已全部完成」；领队被唤醒 | SQL |
| 失败重试 | 前 3 次同成员重试落 `wait`（无 retrying 态，返回 retried=true/maxRetries=3）；第 4 次 `wait_decision`+`retry_count=4`；decisions 表 1 行 `open` | SQL 行 JSON |
| 依赖物化 | 下游任务 `wait`+`blocked_from='ready'`（§5#11） | SQL |
| 决策 approve | `eteams_reassign_task` 收口：decisions open 清零、G 回 `wait`（current_member=Carol）；**G 去毒化但未完成时 F 保持物化（还原判据=依赖 completed），G completed 后 F 还原 `ready`+blocked_from 清空（task.unblocked）** | SQL |
| 决策 decline | 4 次失败后 `eteams_cancel_task` → `cancelled`，决策随取消收口（open=0） | SQL |
| remove_member | Carol 全部实例行 `removed`（2 行，两条大任务各一行）、member 模板行保留 1 行 | SQL |
| 领队 remove/restore | 移除：行 `removed`+`has_leader=0`+`leader.removed` 事件；恢复走 `POST /eteams-api/team/<id>/leader/restore` → 行 `ready`+`has_leader=1`+`leader.restored` 事件（修复⑤，removed 领队行放行） | 路由 200 + SQL |
| 事件一致性 | 14 种事件型齐全（team.created/task.created/task.assigned/attempt.claimed/task.stage_completed/task.completed/task.retrying/decision.requested/decision.resolved/member.removed/leader.removed/leader.restored/task.blocked/task.unblocked）；event_id 全库自增且团队内有序；事件 task_id 整数 | SQL |
| delete_team | wait 任务在列时拒绝：「存在未收尾的任务（#7），不能直接删除」；取消后删除：team/task/attempts/events/mail/decisions/task_members/member 班底行全部 0，领队行一并删除，roles 预置行（2 行）与公共模板行保留 | SQL 行数全零 |

（删除前行数留档：`{"team":1,"task":7,"attempts":12,"events":53,"mail":17,"decisions":0,"taskMembers":6,"memberRows":3}`）

### 门禁 5：重启不重复导入（全 PASS，exit 0）

方法：在 p1 结束的同一工作区**故意放置旧格式诱饵文件**（`roster.json` + `fake-legacy-team/team.json|events.jsonl|inbox/`，含可导入的团队/成员/任务），再以新进程重新挂载插件。守卫若失效，诱饵会被导入或行数翻倍。

```
PASS db_schema_version=1 保持
PASS 诱饵队未导入（旧文件探测被版本号挡住）  n=0
PASS 诱饵成员未进入 member 表              n=0
PASS team 2→2 / member 5→5 / task 4→4 / task_members 5→5 / attempts 2→2
PASS events 11→11 / mail_messages 2→2 / decisions 0→0 / task_status_changes 0→0 / roles 2→2
PASS eteams_list_teams 读到 2 支团队
PASS 重启后写入正常（新工号 = MAX+1）        employeeId=6
PASS member 表仅 +1（无重复种子）           5 → 6
PASS 公共模板行无重复（seed 幂等）
```

### 门禁 6：旧文件导入 + 删库重建（全 PASS，exit 0）

**前半（p3，全新工作区预置旧布局 → 挂载即导入）**，旧文件覆盖 13 态映射、t/a/d 文本号、ET 工号、依赖、open/resolved 决策、组容器父子、邮箱、事件：

```
PASS db_schema_version=1 / user_version=1（导入收尾写入）
PASS t1→1 completed；awaiting_decision→wait_decision；blocked(blockedFrom=ready)→wait+blocked_from='ready'
PASS 依赖 t1/t2 → 整数 [1]/[2]；父子 t5.parent_id=t4.task_id
PASS 旧目录字面路径不迁移：teams/旧团队/tasks/t4-组容器/sub/t5-组内小任务
PASS attempt a1→1（产出/凭证/progress 保留）、attempt.taskId 换算
PASS open 决策 d1→1 导入；resolved d2 不入库（decisions 只存 open）
PASS 工号 'ET-0001' → 1；modelRoute override → model 列 deepseek-chat
PASS 领队行导入（captainSessionId='cap-old-1' 落领队行 main_session_id）
PASS 成员实例行 child_session_id 保留；无子会话成员只留模板行
PASS 事件 3 条（per-team seq 丢弃换全库 event_id）；payload 内 taskId/attemptId 换算、正文「正文 t1 不换」不换
PASS 邮件 2 封（message_id 原样保留、文件名→box_key、未知 kind 归 notice）
PASS 备份字节不变 ×4（team.json / events.jsonl / inbox/Alice.jsonl / roster.json，逐字节 Buffer.compare）
PASS 导入后工具面可用（list_teams / task_board）
```

**后半（p4，同一工作区删除 eteams.db/-wal/-shm → 新进程重新挂载 → 从旧备份重新导入）**：

```
deleted eteams.db（-wal/-shm 不存在）
PASS 重建后 user_version=1 / db_schema_version=1
PASS 行数与导入后完全一致 ×10（team 1 / member 4 / task 5 / task_members 2 / attempts 2 / events 3 / mail 2 / decisions 1 / task_status_changes 0 / roles 2）
PASS 换算语义完整复现（t3 wait+blocked_from='ready'，depend_tasks=[2]，领队行 main_session_id 保留）
PASS list_teams / task_board（5 条任务）/ mailbox 可读（readTeamSync 重装内存模型）
PASS 备份字节不变 ×4（重建不改写旧文件）
```

### 门禁 7：面板无回归（并入 p1 步骤 16-18）

```
PASS GET /eteams-api/state 200；快照无 "phase"/"goal"/planReviewState/approve 残留（字符串级检查）
PASS 快照任务号整数 [8,9]；leaderRemoved / progress 字段在
PASS GET /eteams-api/board 聚合 2 团队；五态列齐 [wait,start,paused,wait_decision,wait_user]
PASS ready 待派单列（B 队面板建队 1 任务）
PASS 成员列表含班底+领队行、按名去重
PASS wait 列含已派任务 [10,8]，不重复出现在其它列
PASS GET /eteams-api/team/<id>/events?afterSeq=0 全量；afterSeq=61 增量全部 >61 且行数严格少于全量（event_id 增量口径）
```

补充说明（§5#8 徽标载体）：阻塞徽标落在团队页任务列表——`teamSnapshot` 每行输出 `blocked`/`blockedFrom`（webui.ts:170-172），客户端 `tasksTab.tsx:77-81/301/399` 渲染「阻塞中 · 前置 #N」Pill；看板 tab（boardTab.tsx）已重构为「待决策横幅+日历+动态」页，无看板列视图，故徽标无列载体——「找回 blocked 独立列可见性」的意图在任务列表达成。

### 门禁 8：数据一致性抽验（并入 p1 步骤 19 + schema.sql 比对）

```
PASS 表数=11（实测 sqlite_master 11）
PASS 索引数=20（实测；见问题 R-2 的文档差异说明）
PASS 11 表名齐：attempts,decisions,events,mail_messages,member,roles,schema_meta,task,task_members,task_status_changes,team
PASS 六个部分索引在列：idx_task_current / idx_attempts_token / idx_attempts_status / idx_events_task / idx_mail_unread / idx_decisions_open
PASS db_schema_version=1（schema_meta）；PRAGMA user_version=1（双写同值）
PASS task 表 23 列 / task_members 16 列 / attempts 16 列与 docs/27 DDL 逐列一致（列名逐字比对）
PASS team 表 5 列，无 goal/phase/plan_review 列
PASS DDL 无 FOREIGN KEY / CHECK / UNIQUE / 触发器（sqlite_master.sql 全文正则）
PASS journal_mode=wal（实测）
PASS SCHEMA_SQL（db.ts 内嵌）与 src/host/state/schema.sql 逐字一致（13891 字节，normalized 全等比对）
```

索引 20 条逐条（schema.sql）：idx_team_update_time、idx_member_team、idx_task_status/parent/current/update（4）、idx_task_members_team/main（2）、idx_attempts_task/member/token/status（4）、idx_events_time/type/task（3）、idx_mail_unread/message_id（2）、idx_decisions_open、idx_status_changes_task/time（2）。

## 三、六处修复的独立复验

| # | 修复 | 代码证据（file:line） | 运行时证据 |
|---|---|---|---|
| ① | 领队子代理拒绝工具面删除 `eteams_archive_team` | `src/host/runtime/captainAgent.ts:75-82`：CAPTAIN_CHILD_DENIED_TOOLS 恰为 create_team/delete_team/dispatch_captain/build_dispatch/build_report/interview_answer 六项，无 archive | 工具面无 archive 类工具（p1 步骤 4 全量清单） |
| ② | completeTask/declineTask/failTask 的 Wake 收进 wakes 并 runWakes | `src/host/runtime/assignment.ts:1113-1125`（notifyCaptainInTx 返回值 push 进 wakes）、`:1133`（`await runWakes(out.wakes)`）；failTask/cancelTask 同型（`:885/:928` 等） | p1 步骤 7/8：领队 `followups` 数组 +1 且内容含成员汇报——成员回合内完成即唤醒领队会话 |
| ③ | 链任务终站 `chainCursor=chain.length-1` | `src/host/runtime/assignment.ts:1104`（`task.chainCursor = task.chain.length - 1`） | p1 步骤 8：两站链末站完成后 `chain_cursor=1`，组收口 completed |
| ④ | avatar 双重编码修复（单次 JSON 编码） | `src/host/state/db.ts:509` avatarToJson 单次 `JSON.stringify`；导入/写入共用 | p1/p2/p3 落库 `avatar='{"seed":988,"salt":494}'` 单层 JSON；p3 旧 avatar {seed:11,salt:22} 正常导入 |
| ⑤ | `requireTeamById` 放行 removed 领队行 | `src/host/runtime/teamOps.ts:675-689`（注释明示 removed 行放行，身份按 main_session_id 锚定） | p1 步骤 13：领队移除后 `POST /team/<id>/leader/restore` 200，行回 ready、has_leader=1、leader.restored 事件 |
| ⑥ | webui POST /roster 删 provider 透传 | `src/host/runtime/webui.ts:650-687`：字段恰为 name/role/duty/style/skills/rules/executionPrompt/personaMd/model/reasoningEffort/avatar，无 provider | 类型检查通过；面板路由挂载执行无回归（p1 步骤 16-17 走 POST /team、/member、/leader/restore） |

## 四、docs/35 §5 行为变更 1-12 逐条符合性

| # | 行为变更 | 结论 | 证据 |
|---|---|---|---|
| 1 | 审批环节重构（approvePlan/planReviewState/phase 删除；建队即生效；确认走对话纪律） | 符合 | 工具面 27 个无 approve（p1 步骤 4）；team 表 5 列无该三列；建队后直接 assign（p1 步骤 5） |
| 2 | 领队会话解析重构（领队行锚点全面换源） | 符合 | 建队写领队行（p1 步骤 1）；restore 走通（步骤 13）；identity.resolveCaller/notifier.leaderRowOf/webui.captainAgentOf 全部按领队行（代码级：identity.ts:99-103、notifier.ts:67-69、webui.ts:1592-1594）；导入落 captainSessionId（p3） |
| 3 | 成员起会话时机（staged→首派 spawn→working） | 符合 | add_member 只建 staged 行（p1 步骤 2）；首派起会话 child_session_id 回填+working（步骤 5） |
| 4 | spawnMember 模型解析简化 | 符合（代码级） | `src/host/runtime/members.ts`：member.model 有值 → agentOptions（provider=config.memberProvider），空 → 不带 agentOptions；导入侧 model 列仅存 override（p3：inherited 不落列） |
| 5 | workDir 归任务（逐任务分配、撞名 -N、存量字面路径） | 符合 | `teams/验收团队/tasks/1-导出功能主任务单/sub/2-调研并实现导出`（p1 步骤 3，目录物化）；p3 旧目录 `tN-` 字面路径不迁移 |
| 6 | maxRetries 全局 | 符合 | failTask 返回 maxRetries=3（config 值）；4 次失败第 4 次落 wait_decision（p1 步骤 9） |
| 7 | 任务号显示与参数整数化 | 符合 | taskId/employeeId/attemptId/decisionId 全整数；taskSlug `1-导出功能主任务单`（新）/`t1-调研`（旧不迁移）；面板快照整数号（p1 步骤 16） |
| 8 | 面板（去审批 chip、10 态分组、outcome 反查、合同四数组、阻塞徽标、事件增量 event_id） | 符合 | 快照无 approve/goal/phase（步骤 16）；五态+ready 单列（步骤 17）；blocked/blockedFrom 落快照行（webui.ts:170-172）+ tasksTab 阻塞中 Pill（tasksTab.tsx:77-81/301/399）；事件增量按 event_id（步骤 18）；outcome 反查 attempts 展示（p1 步骤 7 attempts result 列 + taskDrawer 契约） |
| 9 | goal 真砍（11 处消费点） | 符合 | team 表 5 列；快照字符串级无 "goal"；createTeam 无 goal 参数（captainTools.ts:168-188 建队参数仅 name/questionnaire/via）；client typecheck 0 错（goal 输入/展示已删） |
| 10 | 归档下线（archiveTeam 与归档页删除；deleteTeam 对话内确认） | 符合 | 无 eteams_archive_team（修复①）；hasLegacyFiles 跳过 archive/ 目录（import.ts:378-396）；deleteTeam 事务删除（p1 步骤 15） |
| 11 | blocked_from 四处必改 | 符合 | 物化 wait+blocked_from='ready'（p1 步骤 9、p5 步骤 1）；restoreBlocked 按 blockedFrom 还原（p1 步骤 10：依赖 completed 后 ready+清空；p5 步骤 2：resume 还原+清 status_note）；refreshDependents 过滤 `ready \|\| blocked_from 非空`（assignment.ts:1343）与 task.blocked/unblocked 事件（p1 步骤 14）；suspendTask 搭车分支 wait+blockedFrom+status_note（p5 步骤 1）；重试落 wait 无 retrying 态（p1 步骤 9） |
| 12 | 实例行粒度与选行（每大任务一行；跨任务取最近活跃） | 符合 | Carol 两条大任务各一行（remove 时 2 行全部 removed，p1 步骤 12）；实例行 main_task_id=根大任务（步骤 5）；notifier.rootTaskIdOf/latestInstanceRow（代码级：notifier.ts:71-79）；导入按最近活跃任务锚定（p3：main_task_id=2） |

## 五、问题分级

**阻塞：无。**

### 一般（建议修，不阻塞交付）

- **G-1 工具参数类型不一致**：`eteams_remove_member`（captainTools.ts:704）与 `eteams_update_member`（captainTools.ts:733）的 `teamId` 参数声明为 `str`，而 create_team 返回的 teamId 与其余全部工具（add_member:207、update_member 内层、delete_team:1224 等）均为 `int`。领队把建队返回的整数 teamId 直接传给这两个工具会被 dsh-tools 参数校验拒绝（实测报 `"teamId" must be a string`），必须手动传字符串数字。建议统一为 `int`（冒烟中已按字符串绕过，行为本身正确）。

### 记录项（不改代码）

- **R-1 陈旧注释**：`tests/lifecycle.test.ts:322-324` 注释仍称「completeTask/failTask 丢弃 notifyCaptainInTx 返回的 Wake，领队会话不被唤醒」——修复②落地后与代码不符（现收集并 runWakes）。测试断言无负向依赖，仅注释过时。
- **R-2 索引数文档差异**：docs/36 与验收门禁文字写「索引 19」，docs/27 DDL 实为 20 条（建库实测 sqlite_master 亦 20，六个部分索引齐全）。以 DDL/实测为准，建议后续把 docs/36 的 19 更正为 20。
- **R-3 删除门控语义**：deleteTeam 的活跃守卫覆盖 wait/start/paused/wait_decision/wait_user（teamOps.ts:827-840），**ready 任务可随团队直接删除**——与 docs/27 删除规则一致，属设计口径（冒烟已实测守卫拒绝与取消后删除两条路径）。
- **R-4 领队 restore 唯一入口**：领队加回只能走面板 `POST /team/<id>/leader/restore`（teamOps.setLeaderRemoved），领队工具面无 restore（addMember 会以「只有该团队的领队可以添加成员」拒绝，实测）。与 §5#2「leader 移除/恢复改行 status + has_leader」一致，属设计口径，报告留痕防止误判为缺陷。
- **R-5 外键 pragma 口径**：docs/27「表上无外键」指 DDL 无 FOREIGN KEY 子句（已验证）。node:sqlite 连接默认打开 `PRAGMA foreign_keys=ON`（验证连接实测 `{foreign_keys:1}`），因 DDL 无外键声明不产生任何约束效果，无需处理。

## 六、临时产物与仓库零污染

- 冒烟脚本与输出：`C:\Users\epat\AppData\Local\Temp\eteams-acc\`（p1-flow.mjs/.out、p2-restart.mjs/.out、p3-legacy.mjs/.out、p4-rebuild.mjs/.out、p5-suspend.mjs/.out、counts-p1.json、counts-p3.json）；全部冒烟工作区在 Temp 下（`eteams-acc-*`、`eteams-acc-legacy-*`、`eteams-acc-susp-*`）。
- 仓库内唯一新增：本文件 `docs/37-sqlite-acceptance.md`。验收期间对 `src/`、`tests/`、`package.json` 等零写入；写完本报告后复跑 `npx tsc --noEmit -p tsconfig.host.json` 确认 exit 0（见下）。

## 七、收尾复跑

```
$ npx tsc --noEmit -p tsconfig.host.json
HOST_TSC_EXIT=0
```

（报告撰写未触碰任何代码文件；工作树代码与验收时一致。）