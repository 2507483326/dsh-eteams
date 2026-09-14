# 弱顺序执行链：成员如何进任务 / 进执行链

**背景（用户 2026-09-13）**：领队收到 BUG 需要修复时，要先把「要指派的成员」落到任务上——不在任务花名册（`task_members` 副本行）就补一行，不在执行链卡槽就追加到链尾；这件事应该由**代码一次做完**，而不是让模型跑几轮消息去整链替换、再验证。同时执行链从「硬游标严格接力」降为**弱约束**：链上成员可任意顺序执行、大体从前往后；某成员完成后任务继续把链上尚未成功执行过的站点跑完，全部站点都有成功尝试才收口。

本文自含本次变更的全部口径与代码落点，不依赖旧文档。

---

## 一、数据模型（三个层次）

| 层 | 表 / 字段 | 说明 |
| --- | --- | --- |
| 角色库 | `roles` | 人设手册（MD）、工号来源之外的角色定义；全局一份。 |
| 团队班底 | `team_members` | 团队花名册；工号 = 自增主键（`ET-0007`）。领队也是一行（`is_leader=1`）。 |
| 任务副本 | `task_members` | **按大任务粒度**的执行实例行：`main_task_id`（锚定哪个大任务）、`now_task_id`（当前在办任务）、`session_id`（本行自己的子会话）。同一成员跨任务各一行、各一个子会话。 |
| 执行链 | `task.chain` | 站点数组 `{member, stageBrief}`（`member` 记工号数字）。面板上就是任务卡里的「成员卡槽」。 |

**建任务即全员在册**：建根任务（`parentId === null`）时把整班班底（含领队）整行抄进 `task_members`（`src/host/runtime/assignment.ts:310` `createTask`）；之后团队加新人，同样补铺进**全部现存大任务**（`src/host/runtime/teamOps.ts:292` `addMember`）。所以「成员是否已在任务花名册」通常为真，代码只需保证幂等、不重复创建。

---

## 二、成员如何进执行链：旧协作 vs 新协作

### 2.1 旧协作（模型侧多步、且执行中不可改）

模型要往任务链上放人只有两条路，且都是**整链写入**：

- `eteams_create_task`（带 `parentTaskId`）——只能在建任务时定链；
- `eteams_update_task`（带 `chain`）——**整链替换**，且只允许 `creating`/`ready`（`updateTask` 状态闸，一旦指派即冻结）。

面板拖拽卡槽也是同一条：`TaskAssignDropBox` → `updateTeamTask({chain})`（整链重发）。执行中（`start`/`wait`）的任务**根本改不了链**；改派不在链上的成员只能靠 `eteams_reassign_task` + `deviationNote` 留痕，而**留痕并不把人写进链**。`eteams_add_member` 只补花名册副本行，不碰链。结果：BUG 修复这类「加个人上链再跑」的动作，模型只能靠多轮整链替换/绕路完成。

### 2.2 新协作（一次指派，代码自动入链）

**指派/改派即入链**（`eteams_assign_task` / `eteams_reassign_task` 共用派发核）：

1. `resolveAssigneeRow`（`assignment.ts:1019`）先按「工号 + 本大任务」定位副本行，没有才补建（**幂等，不重复**）；
2. `ensureChainStation`（`assignment.ts:1005`）判断成员是否**已在链上**：不在就追加 `{member: 工号（无号退按名）, stageBrief: ''}` 到**链尾**，返回其站下标；已在链上则复用既有下标——**不会重复追加**；
3. 不再要求 `deviationNote`（D11 的偏离硬闸撤除）；带 `deviationNote` 时仍记进 `task.assigned` 事件 payload 作审计；
4. 无链任务（`chain.length === 0`）维持单站点自由指派，不建链。

入口不变，仍是两个工具：

- `eteams_assign_task`：`ready` 任务首派/改派（`assignment.ts:718`）；
- `eteams_reassign_task`：`ready`/`start`/`wait`/`paused`/`wait_user` 改派（`assignment.ts:1222`）——**BUG 分诊从 `wait` 重新派人就走这条**。

模型侧只需说清「任务号 + 成员」，代码负责补副本行、追加链站点、起会话、投指派信。**派发本身仍不改任务状态**：任务留 `ready`，成员 `eteams_claim_task` 领取才 `ready → start`。

---

## 三、弱顺序链：站号与推进（frontier）

### 3.1 站号贴在实际站位

`prepareAssignment`（`assignment.ts:927`）把 `ensureChainStation` 的结果放进 `AssignmentPlan.stationIndex`；`applyAssignment`（`assignment.ts:1136`）用它写 `attempt.stationIndex` 与 `task.assigned.payload.station`，并让指派信「第 n/N 站」与真实站位一致。乱序/追加派发也贴在正确站点上。

### 3.2 收口 = 链上所有站点都有成功尝试

三个纯函数（`src/host/model/taskMachine.ts`，可单测）：

- `chainIndexOfStation`（:149）：成员在链上的下标（找不到 = `undefined`）；
- `chainDoneStations`（:162）：逐站「是否有成功尝试」（`stationIndex === i && status === 'succeeded'`；越界下标忽略）；
- `chainFrontier`（:181）：**最靠前、尚无成功尝试的站点下标**；全部成功（或无链）→ `chainLength` = 可收口。

`completeTask`（`assignment.ts:1826`）据此推进：

- `frontier < chainLength` → 中间站：`chainCursor = frontier - 1`（使 `nextChainStation` = 链上最靠前的未跑站），任务回 `ready`，通知领队「下一站」；
- 否则 → 终站：`chainCursor = chainLength - 1`，任务 `completed`。

顺序接力场景与旧的「下一站」口径**逐位一致**；乱序/追加场景不会误收口，而是**继续把剩余站点跑完**。

`failTask` / `resumeTask` / `redeliverAssignment` 也统一沿用「本次尝试自己的站号」（重试、恢复、重发都不会串站），`startGroupTask` 的「下一站」取 `chain[chainCursor + 1]`（= frontier）。

### 3.3 面板展示

`webui.ts` 的 `stationStatusOf`（:163）除游标外，还按 `chainDoneStations`（`taskView` :319）把「已有成功尝试」的站点标 `done`——乱序完成时后段站点不再错显为 `pending`；「正在执行」的站点改由 `chainActiveStations`（有 `pending_accept`/`running` 在办尝试的站）反查（用户 2026-09-14），乱序/跳站派发时不再按 `chainCursor + 1`（那只是 frontier）把未跑的站错标为「执行中」；无任何在办尝试时才退回 frontier 口径。

---

## 四、BUG 修复与任务顺序（提示词纪律，用户 2026-09-13）

代码负责「入链」，**怎么修**由领队判断（模型面，不再加机器闸）：

- **优先在当前任务内消化**：复用链上成员，或补一个成员上链（代码自动入链）；小 bug 走 `eteams_reassign_task` loop（可同人续跑或换人，无需 `deviation_note`）；
- **特别复杂、需多成员协同的修复**才**新增小任务**（`eteams_create_task(parentTaskId=当前主任务)` 增补）；
- **任务顺序定死**：不回跳重跑更早（已完成）的任务；链内成员顺序是弱约束、可任意调整；
- 一般继续把链上剩余站点跑完，领队判断是否收口；允许任务内循环（如修复→测试→再修），但避免链内无限回环；
- 流程/环境问题仍走 `eteams_escalate_task` 升级「待用户」。

### 4.1 派发口径：按链来（用户 2026-09-14）

派发（开跑/续派）**一律按执行链当前站**——先 `eteams_task_board` 读出每张卡的 `chain.next`（最靠前的未跑站），再用 `eteams_advance_task` 按链推进（自动按链取人）。**没有特殊情况**：不跳站、不越过当前站、不凭建任务时的计划或自己的判断另指他人；要换人/调序先改执行链（卡槽）再按链派；只有**无执行链**的任务才用 `eteams_assign_task` 自由指派。这里的「弱顺序」只是宿主对乱序/续跑的**容错**（用户改链、续跑恢复），不是派发时挑人的许可。

触发实况：用户给 #72 的执行链前面加了「需求明确大师」，领队开跑时仍按建任务时的旧计划把 `eteams_assign_task(member=前端开发者)` 派了出去——该成员在链上已有站位（站 1），于是首站被跳过、站 1 先跑。根因是领队没重读当前链（未调 `eteams_task_board`；guide 快照只带链**长度**不带站点成员）。

落点：`src/host/prompts/spawn/captainChild.ts`（`执行·按链来` / `指派纪律` / 回合决策表 `start` 分支 / `开跑与建任务判别`）、`src/host/prompts/personas/captain.ts`（`指派纪律` / `完成即续派` / `任务/非任务判别`）、`src/host/prompts/steering/dispatch.ts`（`captainStartMessage`）、`src/host/prompts/system/captain.ts`（执行期）、`src/host/prompts/system/sessionTeam.ts`（无领队主会话主持分支）、工具描述 `captainTools.ts`（assign / advance）。

补：**依赖不再是派发闸门**（用户 2026-09-14「闸门拦住去掉吧，不然任意调度时会出问题」）——`dependencies` 只作排布提示（面板执行序 `subExecutionOrder` / `executionOrderOf` 仍按兄弟依赖拓扑排），派发核 `prepareAssignment` 不再按依赖拒绝（`unsatisfiedDependencies` / `dependenciesSatisfied` 随之删除）；是否等前置由领队按链判断。

### 4.2 队伍留言板（用户 2026-09-14）

主任务文件夹根下一块 `留言板.md`（`teams/<团队>/tasks/<主任务号>-<slug>/留言板.md`），由宿主在文档树物化时 **create-only** 落盘（`renderTeamDocs`）；同一大任务的**领队与全部成员共用一块板**（小任务成员经 `boardFileAbs` 上溯到主任务根）。

- **读**：领队**每次派发/推进前先读**（`eteams_captain_guide` 快照带 `boardFile` 绝对路径）；成员**开工前先读**（成员简报 `## 队伍留言板` 段带绝对路径）。
- **写**：每做完一步在末尾**追加一行**「- [时间] 名字：做了什么（结论/交接物）」——领队记编排动作（拆解收口 / 派发某站 / 分诊决定 / 整体收口），成员记本站产出。

读/写是**提示词纪律**（宿主只保证文件存在、不解析内容）；落点：`runtime/docs.ts`（落盘 + `boardFileAbs` / `renderBoardFile`）、`prompts/spawn/member.ts`（简报段 + `MEMBER_RULES`）、`prompts/spawn/captainChild.ts`（领队纪律）、`prompts/steering/dispatch.ts`（开跑批准正文第 1/4 条）、`tools/captainTools.ts`（guide 快照 `boardFile`）。

---

## 五、代码面 / 模型面分工一览

| 事项 | 谁做 | 落点 |
| --- | --- | --- |
| 补 `task_members` 副本行（幂等） | 代码 | `resolveAssigneeRow`（assignment.ts:1019） |
| 成员不在链上 → 追加链尾 | 代码 | `ensureChainStation`（assignment.ts:1005） |
| 站号贴合实际站位 | 代码 | `prepareAssignment` / `applyAssignment`（assignment.ts:927 / :1136） |
| 完成后继续跑剩余站点、收口 | 代码 | `chainFrontier` + `completeTask`（taskMachine.ts:181 / assignment.ts:1826） |
| 面板站点完成/执行中标记 | 代码 | `webui.ts` `stationStatusOf` + `chainDoneStations` / `chainActiveStations`（:163 / :319） |
| 派发按链当前站推进 / 何时派、是否收口 | 模型（纪律 §4.1） | `eteams_advance_task`（自动按链取人；无链任务才 `eteams_assign_task`），改派 `eteams_reassign_task` |
| BUG 在当前任务修还是新增任务 | 模型（纪律） | `captainChild.ts` / `personas/captain.ts` |

---

## 六、关联文件与测试

- 纯模型：`src/host/model/taskMachine.ts`（`chainIndexOfStation` / `chainDoneStations` / `chainFrontier`），单测 `tests/model.test.ts`（「弱顺序链：站点定位与 frontier 推进」）。
- 运行时：`src/host/runtime/assignment.ts`（`prepareAssignment` / `ensureChainStation` / `applyAssignment` / `completeTask` / `failTask` / `resumeTask` / `redeliverAssignment`）、`members.ts`（指派信透传 `stationIndex`）。
- 面板：`src/host/runtime/webui.ts`。
- 测试：`tests/lifecycle.test.ts`（主流程「自动入链 + 继续跑剩余站点」用例；「弱顺序链：不在链上的成员自动入链（幂等）」用例）。

## 已知边界（记录在案）

- 客户端卡槽编辑窗口仍是 `ready && chainCursor === -1`（`src/client/features/tasks/taskAssignCore.ts:38`）；指派不改游标，追加站点后该窗口仍可整链替换——本轮不改门闸。
- 链站点「已取代 / 已跳过」无持久状态：某站若始终无人跑，任务不会自动收口，需领队改派或调整链。
- 自动追加的站点 `stageBrief` 为空（原因走 `deviationNote` 审计 / 指派信 `handoff`）。
