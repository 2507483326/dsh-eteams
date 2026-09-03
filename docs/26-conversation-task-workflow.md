# 26 对话调用团队执行任务（对话任务工作流）

用户在对话中把任务交给团队时的完整链路规范（用户迭代 2026-09）。面板侧（[12](12-http-api.md) §7.1 的 `/eteams-api`）与工具侧（[11](11-tools-api.md)）共用同一套任务模型；本文只定义**对话侧**新增的部分：会话-团队绑定、任务单（group）与拆解小任务、面板审阅/批准。

## 26.1 绑定：选择团队 → 会话

输入栏「团队」按钮弹层选中一个团队 → `POST /eteams-api/session-team`（`{sessionId, teamId}`）写入宿主内存绑定（镜像 sessionPersona 模式，[13.8.2](13-ui-design.md)）；取消选择 → `/session-team/clear`。选中是会话级的（localStorage 持久化 + 挂载时重申）。

绑定后该会话智能体的系统提示词多出一段「团队绑定」band（每次组装时**对照活团队现读**，批准/阶段变化无需重绑）。band 按所选团队形态三分支：

| 分支 | 条件 | band 内容 |
|---|---|---|
| 领队主持 | `captainSessionId === 本会话 && !leaderRemoved` | 「你就是该团队的领队」，按工作流主持 |
| 主窗口充当领队 | `leaderRemoved === true` | 「该团队暂无领队——由你（用户主窗口会话）充当领队」，同一工作流 |
| 他队提示 | `captainSessionId !== 本会话` | 团队建在别的对话，领队工具会拒绝；提示用户到那个对话操作，**不做跨会话接管** |

团队被删除后 band 输出失效提示。

## 26.2 工作流（定稿）

1. **提交**：用户给出任务 → 领队调 `eteams_submit_task({subject, description?})` → 立即生成任务 ID（`kind:'group'` 主任务，即**任务单**）+ **专属文件夹**（staged 团队此时即分配 `workDir`，不等批准）→ 面板「团队 → 任务」页「对话任务」区块立即可见。
2. **问询**（FR-37，对话内）：交付形式与受众 / 范围边界与非目标 / 验收偏好 / 风格约束 / 优先级。用户已给全或要求直接开始时跳过。结论经 `eteams_update_task` 写回主任务 `description`，落档任务单 contract.md。
3. **拆解**：对每个小任务调 `eteams_create_task({…, parentTaskId, chain})`——`chain` 站点序列就是该小任务的**成员槽**（可多成员接力，成员必须在团队中）；小任务文件夹落在主任务文件夹 `sub/` 下。
4. **审阅**：面板任务页渲染任务单卡（主题/状态/小任务进度/文件夹路径）+ 嵌套小任务行（成员槽 `员A → 员B` chip + 状态）。用户可**修改**（主题/说明/成员槽，弹窗编辑）与**删除**（确认弹窗）——按 [06.4](06-task-lifecycle.md) 编辑矩阵，仅 `draft`/`ready`（未领取）可改删，领取后合同冻结。主任务卡内可**新增小任务**。
5. **批准**：看板页目标卡出现「批准计划」按钮（`phase==='staged' && planReviewState==='awaiting_review'`）→ `POST /team/:id/approve` → 复用现有 `approvePlan`（workDir 幂等、draft→ready、spawn 全体成员、phase→running）。
6. **执行**：现有机制不动——领队 `eteams_assign_task`/`eteams_advance_task` 按链指派；成员 claim/progress/complete。
7. **收口**：**全部小任务 completed 时插件自动把主任务 ready→completed**（`completeGroupIfDone`，joined outcome 摘要 + `task.completed` 事件，via=subtasks.completed）。group 的这条边不在 [06.2](06-task-lifecycle.md) 迁移表内，是 `applyTransition` 的显式特例；有 cancelled/failed 小任务时组保持打开，由领队在对话中处置。

## 26.3 数据模型增量

`TaskRecord`（[05](05-data-model.md)）增：

| 字段 | 类型 | 语义 |
|---|---|---|
| `kind` | `'group' \| 'task'`（缺省 `'task'`，兼容旧数据） | `group` = 对话提交的主任务容器：不经执行链，**禁止** chain/dependencies/parentTaskId；`task` = 普通/小任务 |
| `parentId` | `string?` | 小任务挂靠的主任务 id；仅 `kind:'task'` 允许，且父必须 `draft/ready` |

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

| 工具 | 变化 |
|---|---|
| `eteams_submit_task`（新，领队专用） | `{subject, description?, questionnaire?}` → 建 `kind:'group'` 主任务；`questionnaire`（问询记录）入 `plan.questionnaire` 事件；返回 `{taskId, folder}` |
| `eteams_create_task` | 增参 `parentTaskId`（拆解小任务挂到任务单）；group 禁 chain/dependencies/parent |
| `eteams_update_task` / `eteams_delete_task` | 口径对齐 06.4 放宽（draft/ready 未领取可改删）；主任务 description = 问询结论 |

提示词：`CAPTAIN_SECTION_SHORT` 常驻一行对话任务工作流；完整七步由「团队绑定」band 按会话注入（`sessionTeamSection`，[11.4](11-tools-api.md)）。