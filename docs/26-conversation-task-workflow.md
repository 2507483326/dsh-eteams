# 26 对话调用团队执行任务（对话任务工作流）

用户在对话中把任务交给团队时的完整链路规范（用户迭代 2026-09）。面板侧（[12](12-http-api.md) §7.1 的 `/eteams-api`）与工具侧（[11](11-tools-api.md)）共用同一套任务模型；本文只定义**对话侧**新增的部分：会话-团队绑定、任务单（group）与拆解小任务、面板审阅/批准。

## 26.1 绑定：选择团队 → 会话（主窗口只转交）

输入栏「团队」按钮弹层选中一个团队 → `POST /eteams-api/session-team`（`{sessionId, teamId}`）写入宿主内存绑定（镜像 sessionPersona 模式，[13.8.2](13-ui-design.md)）；取消选择 → `/session-team/clear`。选中是会话级的（localStorage 持久化 + 挂载时重申）。

绑定后该会话智能体的系统提示词多出一段「团队绑定」band（每次组装时**对照活团队现读**，批准/阶段变化无需重绑）。

**主窗口只转交，领队子代理主持**（用户迭代 2026-09-03「既然团队有领队，就应该创建子代理由领队来完成这件事」）：绑定了团队的会话**不再自己扮演领队**——提交、问询、拆解、指派、汇报全部由一次性**领队子代理**承担（构建代理同款 one-shot 模式，`subagents.start` → `run.result` → `dispose`，见 [19.16](19-role-builder.md) 的派发模式）。主会话只做两件事：调 `eteams_dispatch_captain`（[11](11-tools-api.md)）把用户任务/答复/通知转交，并把子代理返回的汇报**原样展示**给用户。分工同时收掉两个实际痛点：

- 问询不再依赖主会话模型的文本行为——子代理用 `ask_user_question` **确定性弹窗**问询（构建代理同机制），不再出现「宣布问询后断头等下一轮」；
- 领队工作流的长上下文（band、任务状态、工具面）从主会话剥离，主会话只保留简短的转交分工。

每次 dispatch = 全新一次性子代理：团队状态全部落在 eteams 文件（team/tasks/问卷），子代理按 dispatch prompt 携带的【团队现状】快照（`teamView` JSON）续步——无持久子代理会话，无跨轮上下文丢失。子代理的 eteams_* 调用按该团队领队解析：内存注册表（`captainChildTeamOf`，[captainAgent.ts](../src/host/runtime/captainAgent.ts)）+ `resolveCaller` 领队子代理分支 + `envForAgent` 同一 fallback（**跨工作区重指对子代理同样生效**）；「团队绑定」band 对领队子代理静默（它自己就是领队，不能看到「转交」指示）。子代理 spawn 时 deny 队长级工具（建队/删队/构建/访谈/再派发，`CAPTAIN_CHILD_DENIED_TOOLS`——每项必须是已注册工具名，loud-deny）。

**绑定即可驱动**（用户迭代 2026-09-03「选中团队后没有使用团队能力，直接开始执行任务了」）：凡绑定了团队的会话，工具层 `resolveCaller`（[05.8](05-data-model.md)）**按该团队的领队身份解析**，绑定优先于创建者 `captainSessionId` 匹配（一个会话既领队 A 队又绑定 B 队时，工具作用于 B——弹层选择即最新意图）；团队建在哪个对话不再重要，原「他队」死路分支已撤。band 两分支：

| 分支   | 条件            | band 内容                                                                                                                                                                                                |
| ------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 生效中 | 团队健在        | **领队子代理主持**工作流；本会话只转交：任务/答复/面板通知到达时调 `eteams_dispatch_captain`，工具结果即领队汇报（原样展示、简短确认、不复述）；**不要**直接调用其它 eteams_* 工具，也不要自己动手执行用户交给团队的任务（问答/闲聊不受限） |
| 失效   | 团队被删除/归档 | 提示用户在输入栏「团队」弹层取消选择或换一个团队；不要对已删除的团队调用任何 eteams_* 工具                                                                                                               |

配套：`eteams_create_team` 成功即清除本会话的旧绑定（resolveCaller 绑定优先，旧绑定会遮蔽刚建的新队）。

**跨工作区定位**（用户迭代 2026-09-03：团队建在主工作区、会话开在别的项目目录时，band 显示「生效中」而工具报「当前会话不在任何 eteams 团队中」）：团队状态是工作区本地的（`<workspace>/.eteams/<teamId>/`，[09](09-persistence.md)），而面板与 band 用工作区注册表**全工作区**定位（`locateTeam`）。工具层对齐同一套解析：`envForAgent`（[05.8](05-data-model.md)）按「绑定 → 领队子代理 → 领队 → 成员」优先级在全部注册工作区定位本会话身份对应的团队，命中别的工作区即把工具环境**重指到团队所在工作区**（状态根、团队文档渲染、workDir 全部以团队为准）；`resolveCaller` 随后在重指后的根上解析。成员子会话派生自驱动会话（工作区无法覆盖），成员侧靠同一机制以 durable child session id 跨工作区命中（[workspaces.ts](../src/host/runtime/workspaces.ts)）。

## 26.2 工作流（定稿；主持者 = 领队子代理）

以下步骤全部由**领队子代理**在其一次性 run 内完成（主窗口只见 dispatch 转交与最终汇报文本）：

1. **提交**：主任务未提交时，子代理调 `eteams_submit_task({subject, description?})` → 立即生成任务 ID（`kind:'group'` 主任务，即**任务单**）+ **专属文件夹**（staged 团队此时即分配 `workDir`，不等批准）→ 面板「团队 → 任务」页「对话任务」区块立即可见；已提交则直接续步，不重复提交。
2. **问询**（FR-37，弹窗）：子代理用 `ask_user_question` 一次问全（≤5 问：交付形式与受众 / 范围边界与非目标 / 验收偏好 / 风格约束 / 优先级，推荐项放首位）；用户已给全或要求直接开始时跳过。结论经 `eteams_update_task` 写回主任务 `description`，落档任务单 contract.md。**问询必须走弹窗，不要把问题只写在文本里等用户回复**；用户的作答由主会话再次 dispatch 转交。
3. **拆解**：对每个小任务调 `eteams_create_task({…, parentTaskId, chain})`——`chain` 站点序列就是该小任务的**成员槽**（可多成员接力，成员必须在团队中，未就绪先 `eteams_add_member`）；小任务文件夹落在主任务文件夹 `sub/` 下。拆解完成的最终输出：「计划已就绪（N 个小任务）——可在面板任务页修改/删除，在目标卡点批准计划」。
4. **审阅**：面板任务页渲染任务单卡（主题/状态/小任务进度/文件夹路径）+ 嵌套小任务行（成员槽 `员A → 员B` chip + 状态）。用户可**修改**（主题/说明/成员槽，弹窗编辑）与**删除**（确认弹窗）——按 [06.4](06-task-lifecycle.md) 编辑矩阵，仅 `draft`/`ready`（未领取）可改删，领取后合同冻结。主任务卡内可**新增小任务**。
5. **批准**：看板页目标卡出现「批准计划」按钮（`phase==='staged' && planReviewState==='awaiting_review'`）→ `POST /team/:id/approve` → 复用现有 `approvePlan`（workDir 幂等、draft→ready、spawn 全体成员、phase→running）；批准成功后插件 `notifyCaptain` 唤醒领队会话（「计划已批准——请转交领队按链指派执行」；会话不在线时邮件滞留邮箱、下次唤醒补投），主会话 band 指示其再次 dispatch 转交。
6. **执行**：现有机制不动——领队子代理（经 dispatch）`eteams_task_board` 看进度、`eteams_assign_task`/`eteams_advance_task` 按链就绪即派、完成即续派；成员 claim/progress/complete。失败超限三选一：`eteams_reassign_task` 换人 / 挂起待料 / 把问题写进最终输出问用户。
7. **收口**：**全部小任务 completed 时插件自动把主任务 ready→completed**（`completeGroupIfDone`，joined outcome 摘要 + `task.completed` 事件，via=subtasks.completed）。group 的这条边不在 [06.2](06-task-lifecycle.md) 迁移表内，是 `applyTransition` 的显式特例；有 cancelled/failed 小任务时组保持打开，由领队子代理在对话中处置。

## 26.3 数据模型增量

`TaskRecord`（[05](05-data-model.md)）增：

| 字段       | 类型                                             | 语义                                                                                                       |
| ---------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `kind`     | `'group' \| 'task'`（缺省 `'task'`，兼容旧数据） | `group` = 对话提交的主任务容器：不经执行链，**禁止** chain/dependencies/parentTaskId；`task` = 普通/小任务 |
| `parentId` | `string?`                                        | 小任务挂靠的主任务 id；仅 `kind:'task'` 允许，且父必须 `draft/ready`                                       |

文件夹布局（[09](09-persistence.md) 的任务文档树按层级扩展）：

```
<workDir>/
  tasks/
    t1-<主任务slug>/            ← 任务单（group）文件夹：contract.md（含问询结论+小任务清单）、notes.md
      sub/
        t2-<小任务slug>/       ← 小任务 contract.md / notes.md
        t3-…/
```

- 主任务**改主题** → 父目录整体 rename（`sub/` 随移；`renameSync` 对中文路径安全）；**删除** → 级联删除全部小任务（要求全部未领取）并 `rmTree`（手写 unlinkSync/rmdirSync 递归——本机 Node v24 win32 `rmSync` 对中文路径静默失效，见 [09](09-persistence.md)）。
- 06.4 编辑矩阵放宽：`updateTask`/`deleteTask` 放行 `draft | ready`（原为仅 draft）——「未领取可改删」按 D5 口径。

## 26.4 面板与路由

- `/state` 快照 `taskView` 增 `kind`、`parentId`、`description`、`folder`（工作区相对路径，未分配 workDir 时 null）；`progress` 只统计 `kind!=='group'` 的任务。
- 新路由（actor = `{kind:'user', name:'用户'}`）：`POST /team/:id/task`（`{subject, description?, parentTaskId?, chain?}`）、`POST /team/:id/task/:taskId/update`、`POST /team/:id/task/:taskId/delete`（主任务级联）、`POST /team/:id/approve`、`POST /session-team`（绑定/清绑定）。chain 入参逐字段收紧（`{member, stageBrief}`，面板数据不可信）。
- 客户端（docs/21 栈）：`TasksTab` 顶部「对话任务」区块 + 小任务行「修改/删除」按钮 + 成员槽编辑弹窗；`BoardTab` 目标卡「批准计划」确认弹窗；`teamsButton` 选中团队时 `setSessionTeam` / 取消时 `clearSessionTeam`（恢复选中时重申）。

## 26.5 工具层

| 工具                                        | 变化                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eteams_dispatch_captain`（新，领队会话专用） | `{message}` → 派发一次性领队子代理（【团队现状】快照 + message，persona=领队子代理人格，deny 队长级工具）→ 透传子代理最终文本 `{ok, relayed}`；成员报错「只有团队领队会话可以转交」 |
| `eteams_submit_task`（新，领队专用）        | `{subject, description?, questionnaire?}` → 建 `kind:'group'` 主任务；`questionnaire`（问询记录）入 `plan.questionnaire` 事件；返回 `{taskId, folder}` |
| `eteams_create_task`                        | 增参 `parentTaskId`（拆解小任务挂到任务单）；group 禁 chain/dependencies/parent                                                                        |
| `eteams_update_task` / `eteams_delete_task` | 口径对齐 06.4 放宽（draft/ready 未领取可改删）；主任务 description = 问询结论                                                                          |

提示词：`CAPTAIN_SECTION_SHORT` 常驻一段（对话任务行 = dispatch 转交口径，创建者领队会话与绑定会话行为一致）；对话工作流的完整主持纪律由**领队子代理人格**（`CAPTAIN_CHILD_PERSONA`，dispatch 时以 request.persona 注入）携带；「团队绑定」band 按会话注入转交分工（`sessionTeamSection`，[11.4](11-tools-api.md)），对领队子代理静默。
