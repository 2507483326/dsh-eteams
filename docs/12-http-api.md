# 12 Web 接口（/eteams-api/*）

服务端 HTTP 路由契约。读路由供面板轮询，写路由（ops）供 UI 操作（D10 的 UI 指派等）。信任模型与参考实现一致：回环暴露（宿主 `networkExposure: loopback`）、会话归属校验、无跨源凭证。

> **前缀变更（2026-08-28 事故，见 18 §7.1）**：基前缀由 `/plugins/dsh-eteams` 迁至 **`/eteams-api`**。`/plugins` 命名空间归 client-modules 独占（bundle URL `/plugins/<包名>/client.js`），插件不得在其下注册任何路由。

## 12.1 通用约定

- 基前缀：`/eteams-api`
- 路径段按 URL 解码后匹配（团队 id / 成员名允许 CJK）
- 所有响应 `content-type: application/json; charset=utf-8`、`cache-control: no-store`
- 错误格式：`{ "error": string, "hint"?: string }` + 恰当 HTTP 码（400 参数 / 404 不存在 / 409 状态冲突 / 405 方法 / 500 内部）
- 会话标识：读路由用 `?session=<sessionId>`；写路由 body 带 `sessionId`，服务端校验「该会话是否团队领队/所属会话」后执行（与团队状态同锁）。

## 12.2 读路由

### GET `/roster` ✅

返回 `{ members: RosterMember[] }`（D16 成员库，见 5.11）。

### GET `/state?session=<id>`

面板主轮询（1s；无团队 5s 探测）。返回该会话可见的全部团队快照：

```jsonc
{
  "activeTeam": TeamSnapshot | null,
  "teams": TeamSnapshot[],        // 含 paused/halted/completed（未归档）
  "archivedTeams": TeamSummary[], // 归档摘要（轻量）
  "serverTime": 1710000000000
}
```

`TeamSnapshot`（完整渲染所需）：

```jsonc
{
  "teamId": "…", "name": "…", "goal": "…", "phase": "running",
  "captainSessionId": "…", "version": 42, "workDir": "teams/竞品报告/",
  "progress": { "completed": 3, "total": 8, "cancelled": 1 },
  "planReviewState": "approved",
  "members": [{
    "name": "研究员", "role": "researcher", "status": "working",
    "model": "glm-5.3", "provider": "hs",
    "currentAttemptId": "a5", "currentTaskId": "t3",
    "avatar": AvatarRecord,          // option 直出，客户端渲染
    "persona": PersonaRecord,        // 人设（D13，编辑器数据）
    "childId": "…"                   // 会话记录跳转用
  }],
  "tasks": [{
    "taskId": "t3", "subject": "…", "status": "in_progress",
    "assignee": "研究员", "dependencies": ["t1"],
    "chain": [{ "member": "研究员", "stageBrief": "调研", "stationStatus": "done" },
              { "member": "工程师", "stageBrief": "实现", "stationStatus": "current" }],
    "chainCursor": 0,
    "retryCount": 1, "createdBy": "captain",
    "attemptSummary": [{ "id": "a5", "memberName": "研究员", "kind": "retry",
      "status": "running", "startedAt": 0, "endedAt": null,
      "lastEventText": "导出接口草稿", "eventCount": 6 }],
    "updatedAt": 0
  }],
  "pendingDecisions": DecisionSummary[],
  "latestEvents": TeamEvent[]       // 最近 30 条（动态视图首屏）
}
```

> 任务详情的**完整执行线路**不进轮询（体积控制）：`attemptSummary` 每尝试一行 + 最后事件；展开详情用 12.3 懒加载。

### GET `/team/<teamId>/task/<taskId>/track?session=<id>`

单任务完整执行线路（详情抽屉用）：`{ attempts: AttemptRecord[], decision?: DecisionRecord }`。

### GET `/team/<teamId>/events?session=<id>&afterSeq=<n>`

事件流增量（动态视图滚动加载）。

### GET `/team/<teamId>/plan?session=<id>`

staged 计划编辑器数据（成员草案 + 人设 + 任务 DAG + 执行链 + 模型目录快照）。

### GET `/team/<teamId>/docs?session=<id>&task=<taskId|all>`

任务文档只读预览（FR-40）：`{ workDir, files: [{ path, markdown }] }`（README / contract / notes；只读）。

### GET `/team/<teamId>/member/<name>/dialog?session=<id>&after=<seq>`

成员对话框时间线（D15/FR-42）：`{ memberStatus, items: [...] }`——双向邮箱消息 + 该成员进度事件按时间合并；`after` 增量拉取。

## 12.3 写路由（ops，全部 POST）

> **实现状态**：M5 首切片已于 M4 后提前交付——`/roster`、`/team`（新建）、`/team/<id>/member`（入库添加）；其余仍为 M5 计划契约。已实现路由的工作区解析：优先已存在 `.eteams` 的工作区，否则第一个注册工作区。

统一 body：`{ "sessionId": "…", … }`。语义与 11 的工具一一对应（复用同一状态机实现，防两套逻辑漂移）：

| 路由 | 状态 | body 附加字段 | 行为 |
|---|---|---|---|
| `/roster` | ✅ 已实现 | `{ name, role, duty?, style?, skills?, rules?, executionPrompt?, provider?, model?, reasoningEffort? }` | 成员库 upsert（D16；按 name 键） |
| `/team` | ✅ 已实现 | `{ name, goal, sessionId }` | 新建 staged 团队并绑定领队会话（events 记 via=panel） |
| `/team/<id>/member` | ✅ 已实现 | `{ name, fromRoster: true, …覆盖字段? }` | 添加成员；fromRoster 时从成员库采纳人设（显式字段覆盖），events 记 via=panel |
| `/team/<id>/plan/approve` | 计划（M5） | - | 批准计划（唯一批准入口；领队工具无此能力） |
| `/team/<id>/plan/return` | `{ message? }` | 退回修改（终止规划轮次，注入修改指令） |
| `/team/<id>/plan/discard` | - | 放弃草案（二次确认在 UI） |
| `/team/<id>/tasks` | `{ subject, description, dependencies, chain?, acceptance? }` | 新增任务（D5；running 时 createdBy=user；chain 见 11） |
| `/team/<id>/task/<tid>` | PATCH 语义（POST 更新）`{ subject?, description?, dependencies?, acceptance?, chain? }` | 按 06.4 矩阵编辑（chain 规则同 11） |
| `/team/<id>/task/<tid>/delete` | - | 删除（06.4 矩阵） |
| `/team/<id>/task/<tid>/assign` | `{ member, deviation_note? }` | 指派/改派（D10；偏离时必填 note；领队收系统通知） |
| `/team/<id>/task/<tid>/advance` | - | 按执行链推进下一站（D11；无链任务 409） |
| `/team/<id>/task/<tid>/cancel` | `{ reason? }` | 取消 |
| `/team/<id>/task/<tid>/resume` | `{ member? }` | 解除挂起（可选直接指派） |
| `/team/<id>/decision/<did>/resolve` | `{ choice, member?, note? }` | 代答决策（用户侧，08.6） |
| `/team/<id>/switch` | - | 切换为活动团队（D3） |
| `/team/<id>/archive` | - | 归档 |
| `/team/<id>/halt` | - | 停止团队（成员全部停驻；二次确认在 UI） |
| `/team/<id>/member/<name>/avatar/reroll` | - | 头像重摇（换 salt，落盘新 option） |
| `/team/<id>/member/<name>/avatar` | `{ option }` | 头像编辑保存（简化编辑器产物） |
| `/team/<id>/member/<name>/persona` | `{ persona }` | 成员人设保存（D13；下次唤醒生效） |
| `/team/<id>/captain-persona` | `{ persona }` | 领队人设保存（写 .eteams/captain-persona.yaml） |
| `/team/<id>/member/<name>/message` | `{ content }` | 用户直发成员（D15；空闲即唤醒，执行中排队；不做状态变更） |

所有写路由成功返回 `{ ok: true, version: <newVersion> }`；失败返回错误体（前端回弹 + 提示 hint）。

## 12.4 轮询与性能策略（客户端配合，见 13）

- 引用计数监控目标（哪些团队被当前视图需要）-> 单一轮询循环；活跃 1s / 探测 5s / 无目标休眠（复用参考实现的节奏模型）。
- 快照带 `version`：客户端可先发 `If-None-Match` 式轻查询（v0.2 简化：直接全量，300KB 预算内可接受；version 字段为将来 304 优化预留）。

## 12.5 安全边界

1. 路由仅在 webServer + workspaceRegistry 可用时注册（headless 不挂）。
2. 会话校验：state/ops 均要求 `session` 属主匹配 `captainSessionId`（或归档只读放开到本机任意会话）。
3. 不接受任意路径参数读写文件；所有路由操作映射到状态机动作，无原始文件访问面。
4. 与宿主 Web 服务同回环绑定；无新增监听。
