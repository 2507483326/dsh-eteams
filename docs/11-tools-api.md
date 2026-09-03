# 11 模型侧工具 API（eteams_*）

面向领队与成员的 `defineTool` 契约（[04](04-architecture.md) 边界）。命名空间 `eteams_*`；参数用 schemastery 风格声明；所有工具 `execute(args, exec)` 从 `exec.agent` 识别调用者身份，非授权调用一律报错。工具描述同时承担「协议教学」职责（模型只看描述也能正确协作）。

## 11.1 可见性矩阵

| 工具 | 领队 | 成员 | 说明 |
|---|---|---|---|
| eteams_create_team / edit_team / switch_team / archive_team / delete_team / resume_team | ✔ | ✘ | 团队管理 |
| eteams_add_member / remove_member / update_member | ✔ | ✘ | 成员管理 |
| eteams_submit_task | ✔ | ✘ | 对话任务入口（docs/26）：建任务单 group |
| eteams_dispatch_captain | ✔ | ✘ | 对话任务转交（docs/26.1）：派发一次性领队子代理主持（提交/弹窗问询/拆解/指派），透传其最终汇报 |
| eteams_create_task / update_task / delete_task | ✔ | ✘ | 任务清单（运行中编辑 D5） |
| eteams_approve_plan | ✘（用户） | ✘ | 仅 UI/批准路由可调（防领队自批） |
| eteams_assign_task / reassign_task | ✔ | ✘ | 指派（D4；含偏离说明） |
| eteams_advance_task | ✔ | ✘ | 执行链一键推进（D11） |
| eteams_resolve_decision | ✔ | ✘ | 升级决策（08） |
| eteams_suspend_task / resume_task / cancel_task | ✔ | ✘ | 任务控制 |
| eteams_send_message | ✔ | ✔ | 点对点消息 |
| eteams_team_status | ✔ | ✔(本团队只读) | 快照 |
| eteams_task_board | ✔ | ✔ | 全队任务板（FR-15） |
| eteams_claim_task / decline_task | ✘ | ✔ | 接取/拒接 |
| eteams_append_progress | ✘ | ✔ | 执行线路进度 |
| eteams_complete_task / fail_task | ✘ | ✔ | 终态汇报 |

> 领队工具在成员子代理的工具面被隐藏（参考实现的 registerContinuableSetup 过滤模式反向使用）；成员工具对领队隐藏。均通过 `exec.agent` 二次校验。

## 11.2 工具契约（核心字段）

### 团队管理

```
eteams_create_team({ name, goal, approval: 'required'|'automatic' = 'required' })
  -> { team_id, phase: 'staged'|'running', state_dir }
  行为：per-captain 锁校验「一会话一活动团队」；默认 staged（等待用户批准）。

eteams_switch_team({ team_id })     # 当前团队->paused，目标->running（D3）
eteams_archive_team({ team_id })    # 非 running 才可归档
eteams_resume_team({ reason })      # halted -> running（用户停止后的恢复）
eteams_delete_team({ team_id })     # 归档团队的显式删除（二次确认在 UI）
```

### 成员管理

```
eteams_add_member({ name, role, persona?, provider?, model?, reasoning_effort? })
  行为：staged 阶段仅落占位记录；running 阶段立即派生子代理。
  persona 未传 -> 按角色套用默认人设模板（D13 固定框架，[05](05-data-model.md) PersonaRecord）。
  模型路由：未传 provider/model -> 快照领队当前路由（source=inherited，FR-08）；
  传入 -> 校验宿主模型目录存在该路由（source=override）。
  reasoning_effort 同参考实现语义：同路由继承领队档位；换路由用目标默认档；显式传则强制。

eteams_update_member({ name, persona? })
  行为：字段级更新人设（框架字段固定校验）；staged 与运行中均可；下次唤醒生效（FR-39）。

eteams_remove_member({ name })
  行为：吊销其活动 attempt（任务回 ready）；成员子代理会话保留（审计），状态 removed。
```

### 任务清单（staged + 运行中，D5）

```
eteams_dispatch_captain({ message })   # 对话任务转交（docs/26.1，领队会话专用）
  行为：派发一次性「领队子代理」（构建代理同款 one-shot：subagents.start →
        run.result → dispose）主持当前步骤——prompt =【团队现状】快照
        （teamView JSON）+ message（用户原话/答复/通知要点），persona =
        CAPTAIN_CHILD_PERSONA，spawn deny 队长级工具（建队/删队/构建/访谈/
        再派发，含递归守卫）。子代理的 eteams_* 调用按该团队领队解析
        （内存注册表，含跨工作区重指）；「团队绑定」band 对其静默。
  返回：{ ok, relayed }——relayed = 子代理最终文本，主会话原样展示（简短
        确认，不复述）；stopReason ≠ completed 时 ok:false（异常结束注记）。

eteams_submit_task({ subject, description?, questionnaire?: string[] })   # 对话任务入口（docs/26）
  行为：建 kind:'group' 主任务（任务单）+ 立即分配团队 workDir 与专属文件夹
        （staged 不等批准）；questionnaire 记问询事件；面板任务页立即可见。
  返回：{ taskId, folder }。

eteams_create_task({ subject, description, dependencies: string[], chain?,
                     acceptance?, inScope?, deliverables?, idempotencyNote?,
                     parentTaskId? })
  chain: Array<{ member: string; stageBrief: string }>  # 执行链（D11）= 对话小任务的成员槽（可多成员接力）
  parentTaskId: 挂到主任务（任务单）下（docs/26 拆解）；父须为 group 且 draft/ready。
  行为：staged -> draft；running -> ready（依赖满足时）。写入即查环（06.5）。
        group 主任务是容器：不接受 chain/dependencies/parentTaskId。
  idempotencyNote：幂等纪律栏（10.6）--副作用风险与核对命令。

eteams_update_task({ task_id, subject?, description?, dependencies?, acceptance?, chain? })
  行为：按 06.4 编辑矩阵校验（06.4 放宽：draft|ready 未领取可改；chain 编辑规则见 6.4 补充：
        未开始可改，开始后仅追加）；dependencies 变更触发下游刷新。
        主任务 description = 问询结论（docs/26）。

eteams_delete_task({ task_id })     # 按 06.4：draft/ready(未领取)；组任务级联删全部小任务（须全部未领取）
```

### 指派与控制

```
eteams_assign_task({ task_id, member, deviation_note? })
  前置：task=ready 且依赖满足；member=ready；team=running。
  行为：task->assigned + attempt(initial|stage, pending_accept) + 指派消息投递（07.3.1）。
  member 非执行链下一站时 deviation_note 必填（06.7 偏离留痕）。

eteams_advance_task({ task_id })
  行为：按执行链一键推进--默认指派 chain[chainCursor+1]（无链任务报错提示改用 assign）。
  偏离场景请改用 eteams_assign_task + deviation_note。

eteams_reassign_task({ task_id, member, reason })
  行为：吊销现 attempt -> task->assigned(新成员, kind=reassign)；retryCount 清零（08.4.2）。

eteams_suspend_task({ task_id, note? })    # -> suspended，下游物化 blocked
eteams_resume_task({ task_id, member? })   # -> ready（可同时指派）
eteams_cancel_task({ task_id, reason })    # 任意非终态；进行中先吊销+interrupt+通知
```

### 升级决策（08）

```
eteams_resolve_decision({ decision_id, choice: 'suspend'|'reassign'|'notify_user',
                          member?, note? })
  行为：reassign 必须带 member；notify_user 后任务->needs_user，
        领队须在同一轮向用户呈现决策请求（协议要求）。
```

### 消息与状态

```
eteams_send_message({ to, content, task_id? })   # to = 'captain' | 成员名
eteams_team_status()   # 团队快照：phase/进度/成员/任务摘要/待决策
eteams_task_board()    # 成员可调；紧凑任务板（id/主题/状态/负责人/最近线路事件）
```

### 成员执行工具

```
eteams_claim_task({ task_id, attempt_id })
  前置：attempt 归属本成员且 pending_accept。返回：attempt_token + 合同 + 交接包（reassign/retry 时）。
  行为：task->in_progress；执行线路 claimed 事件。

eteams_decline_task({ attempt_id, reason })
eteams_append_progress({ attempt_id, text })       # ≤200字；线路 progress 事件
eteams_complete_task({ attempt_id, output, changedPaths? })
  行为：attempt->succeeded；末站 -> task->completed（下游解锁）；
        中间站 -> task->ready + chainCursor+1 + task.stage_completed（06.7）；
        report 通知领队（含下一站建议与空闲续派提示，07.3.4 模板）。
eteams_fail_task({ attempt_id, error, retryable = true })
  行为：attempt->failed；retryable -> 重试阶梯（08.2）；否则直接 awaiting_decision。
```

**attemptToken 规则**：claim 下发；此后 progress/complete/fail 必须携带；任何吊销（改派/重试/取消/接管）使旧 token 失效；迟到调用收到明确错误（「attempt 已吊销，所有权已变更」）。

## 11.3 输出渲染

每个工具定义 `output.render`：成功返回人类可读摘要（对话流可见）；错误统一 `{error, hint}` 双段（hint 告诉模型下一步该做什么，如「任务依赖未满足，先检查 t1 状态」）。工具输出同时是 UI 卡片的数据源之一（卡片数据以轮询快照为准，渲染文本仅对话流用）。

## 11.4 系统提示词注入

- 一段「领队人设与协议」（[07](07-scheduling.md) 7.7），仅在存在活动团队或激活意图时展开完整版（分段按需注入，控制 token）；用户覆盖经 captain-persona.yaml 合成。
- 成员人设 + 协议（7.8）在 spawn 注入全文；每次唤醒消息头部附人设摘要（FR-39）。
- 注入策略复用参考实现模式：常驻简版（触发词+边界）+ 激活时全文。

## 11.5 Slash 命令

```
/eteams <目标>        # 等价自然语言激活：原文进对话 + 协议确定性激活
/eteams --profile <名> <目标>   # v0.2 预留（团队模板，见 17 开放问题）
```

命令管线认领后按普通用户消息送入主会话（与参考实现一致），协议由注入边界激活。
