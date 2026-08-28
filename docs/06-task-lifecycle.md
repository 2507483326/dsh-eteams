# 06 任务状态与生命周期

本文是任务状态机的规范文档（FR-11~15、20、21、24 的行为依据），也是 [07 调度](07-scheduling.md)、[08 重试升级](08-retry-escalation.md)、[10 断点续行](10-checkpoint-recovery.md) 的共同引用。

## 6.1 状态全图

```
                     ┌────────────────────────── 用户/领队删除（仅 draft/ready 未领取）────────┐
                     │                                                                      │
  (staged 计划)      ▼                                                                      │
  draft ──批准──▶ ready ──领队指派──▶ assigned ──成员接取──▶ in_progress ──成功──▶ completed ✔
   │                ▲  │                  │                    │      ▲                ▲
   │                │  │                  │成员拒接(附理由)      │失败   │自动重试          │换人重试
   │                │  │                  └──────回到 ready ◀──┘      │(同成员)          │(决策后)
   │                │  │                                              ▼                  │
   │                │  │                                         retrying ──恢复执行─────┘
   │                │  │                                              │仍失败(第N次)
   │                │  │                                              ▼
   │                │  │                                     awaiting_decision ◀────┐
   │                │  │                                       │    │    │        │决策再失败
   │                │  │                      挂起(suspend)────┘    │    └─通知用户 │(循环回到此)
   │                │  │                        ▼                   ▼         ▼
   │                │  └─领队解除挂起── suspended ◀────────── reassign→assigned   needs_user
   │                │                     │                        (换人重试)      │用户答复
   │                │                     │解除挂起失败放弃                         │
   │                │                     ▼                                        │
   │                │                 failed ✘◀────────────────────────────────────┘
   │                │
   │                └◀── 改派(reassign)：assigned/in_progress/paused → 撤销attempt → assigned(新成员)
   │
   └─ staged 阶段：draft 可任意编辑/删除；批准时 draft→ready（依赖满足者）

  任意非终态 ──用户取消──▶ cancelled ✘（进行中需先吊销 attempt 并通知成员停止）
  ready/assigned ──依赖被挂起/失败/待决策传染──▶ blocked ──上游恢复──▶ 回原状态
```

## 6.2 状态定义与迁移表

| 状态 | 含义 | 进入动作（副作用） | 允许迁出 |
|---|---|---|---|
| `draft` | staged 计划中的任务草案 | 无（仅存在于 staged 团队） | ready(批准), cancelled |
| `ready` | 依赖满足、待领队指派（含链中间站：上一站已完成，默认下一站见 6.7） | 批准时物化；上游 completed 时刷新；站点完成时推进（stage_completed） | assigned, blocked, cancelled |
| `assigned` | 领队已指派给成员 M，等 M 接取 | 生成 attempt(pending_accept, token)；向 M 投递指派消息 | in_progress(接取), ready(拒接/收回), assigned(改派), blocked, cancelled |
| `in_progress` | M 已接取并执行中 | attempt→running；执行线路 `claimed` 事件 | retrying(失败), completed(末站成功), ready(中间站成功，链推进 6.7), awaiting_decision, paused, assigned(改派), cancelled |
| `retrying` | 同成员自动重试排队（短暂态） | 记录 retry_scheduled 事件 + backoff 后自动唤醒 M 续 attempt | in_progress(重试开始, 新 attempt) |
| `paused` | attempt 停驻（用户打断/异常） | attempt→paused；成员上下文与 token 保留 | in_progress(resume 同 attempt), assigned(改派), cancelled |
| `awaiting_decision` | 重试超限，等领队三选一（D6） | 生成 DecisionRecord；通知领队 | assigned(reassign), suspended, needs_user |
| `needs_user` | 领队升级给用户 | 对话内提问 + 面板横幅；任务暂停等待 | assigned(用户答复后领队指派), failed, cancelled |
| `suspended` | 领队挂起；无依赖任务继续（D6/FR-24） | 下游依赖者物化为 blocked | ready(解除挂起), failed, cancelled |
| `blocked` | 依赖被挂起/失败/待决策传染 | 物化状态 + 原因记录 | 回到进入前的状态(上游恢复)， cancelled |
| `completed` ✔ | 成功终态；附 outcome | 通知领队（FR-17）；下游 ready 刷新 | 终态，仅可（v0.2 不可）重开 |
| `failed` ✘ | 领队明确放弃的终态 | 通知领队；下游保持 blocked（除非领队再处理） | 终态 |
| `cancelled` ✘ | 用户/领队取消 | 吊销活动 attempt；成员收到停止通知 | 终态 |

迁移表实现为纯函数 `canTransition(from, to, ctx)` + `applyTransition()`（见 [04](04-architecture.md) 模块 `model/task-machine.ts`）；非法迁移一律抛 `transitionError`，由工具层转成可行动的中文错误提示。

## 6.3 执行线路（Attempt 链）规范

**每个任务的执行线路 = attempts 数组按时间序渲染的时间线。**

1. **生成时机**：`assigned` 即生成 attempt（`kind` 标明来源：initial / stage / retry / reassign / resume）。
2. **凭证**：attempt 携带一次性 `attemptToken`；成员侧所有更新（进度/完成/失败）必须携带；吊销后更新被拒绝（防迟到写，NFR-01）。
3. **事件追加**：接取、进度备注、暂停/恢复、重试调度、成功/失败、吊销都追加为 `AttemptEvent`；文本字段由成员/领队填写，服务端不改写。
4. **进度备注频率**：成员协议要求「每个有意义的阶段节点」追加一次 progress（如：方案确定、关键文件完成、验证通过），而不是每步工具调用都记（避免噪声）；单条建议 ≤200 字。
5. **终态 outcome**：succeeded 必须有 `output`（结论/产物说明）与可选 `changedPaths`；failed 必须有 `error`（人类可读失败原因）。
6. **渲染映射**（UI，详见 [13](13-ui-design.md)）：一行一尝试（成员头像 + kind 徽标 + 起止 + 状态色点），展开看事件流。

示例（执行线路渲染）：

```
任务 t3「实现导出模块」
▶ a2 ●retry   成员B  14:02-14:11  失败(第2次)：测试 test_export 断言失败 … [展开事件]
▶ a1 ●initial 成员B  13:40-13:58  失败(第1次)：依赖版本冲突 … [展开事件]
```

## 6.4 编辑权限矩阵（D5 的精确化）

| 当前状态 | 用户新增同任务 | 修改内容 | 删除任务 | 取消任务 | 指派/改派 | 重试 |
|---|---|---|---|---|---|---|
| draft | ✔ | ✔（全部字段） | ✔ | - | - | - |
| ready | ✔ | ✔（含依赖，重算 DAG） | ✔ | ✔ | ✔（指派） | - |
| assigned | ✔ | ✔（仅描述/验收等合同字段；不改依赖） | ✘（先收回） | ✔ | ✔（改派=先吊销） | - |
| in_progress | ✔ | ✘（只读） | ✘ | ✔（吊销+通知成员停止） | ✔（改派） | - |
| retrying/paused | ✔ | ✘ | ✘ | ✔ | ✔ | - |
| awaiting_decision | ✔ | ✘ | ✘ | ✔ | ✔（=决策 reassign） | - |
| needs_user | ✔ | ✘ | ✘ | ✔ | ✔（答复后由领队执行） | - |
| suspended | ✔ | ✔（合同字段） | ✔（挂起任务可删） | ✔ | ✔ | ✔（重新指派） |
| blocked | ✔ | ✔（合同字段；改依赖可解除） | ✔ | ✔ | ✘（先解决依赖） | - |
| completed/failed/cancelled | ✔ | ✘ | ✘（历史不可毁） | - | - | - |

规则来源：D5「未开始/未被领取可改可删；进行中只能查看或取消」。assigned 视为「已被领取前的锁定」，合同字段（描述/验收）仍可改，依赖与指派关系不可改。

**执行链编辑规则**：`draft` / `ready`（chainCursor=-1，未被领取）可整体编辑执行链；执行开始后链不可改（特殊情况走 6.7 的偏离机制，不修改预规划链）；`ready` 中间站仅允许追加后续站点（不可撤销已完成站点）。

## 6.5 依赖与 DAG 规则

1. 写入（新增/修改 dependencies）时做**拓扑校验**：出现环 → 拒绝并返回环路径。
2. 依赖只能引用**同团队、非 cancelled** 的任务；引用 completed 任务等效满足。
3. 上游状态变化时刷新下游：
   - 上游 → completed：下游 blocked → 原状态（若原本 ready 保持 ready）。
   - 上游 → suspended / failed / awaiting_decision / needs_user：下游（含传递闭包，排除 cancelled/completed/failed 自身）→ blocked，记录原因。
4. 删除任务前若有依赖者：拒绝并提示「先解除 N 个下游依赖」。
5. v0.2 不支持条件依赖/动态加边（运行中改依赖允许，但只影响未开始任务）。

## 6.6 重试计数语义（与 08 详述呼应）

- `retryCount` 随失败递增；同成员自动重试直到 `retryCount >= maxRetries`（默认 3，D6）。
- 「重试 3 次」的精确口径：**初次执行 + 至多 3 次自动重试**，即最多 4 个 attempt（initial + 3×retry）后进入 awaiting_decision。
- 换成员（reassign）→ `retryCount` 清零并记录事件（新视角值得全新预算）；同成员 resume（paused 恢复）不清零。
- 站点推进（成功换站，6.7）同样清零 `retryCount`（新执行人新预算）。
- 用户可在团队配置改 `maxRetries`（0 = 失败立即升级）。

## 6.7 执行链与站点推进（D11）

任务可携带执行链（站点序列：成员 + 阶段说明，[05](05-data-model.md) ChainStation）。链是**预规划的默认分配路线**，不是强制合约：无特殊情况沿链推进；特殊情况领队显式偏离并留痕。

```
站点1(研究员·调研) 完成 → 任务回 ready、链游标+1 → 领队按链指派站点2(工程师·实现) → … → 末站完成 → completed（下游解锁）
                                        │
                                        └─ 特殊情况（成员不可用/重试超限/用户指定）→ 领队偏离指派（chain.deviated 事件，附原因）
```

1. **推进**：站点 attempt 成功且非末站 -> 任务转 `ready`、`chainCursor+1`、事件 `task.stage_completed`；汇报中直接给出下一站建议（默认动作 `eteams_advance_task`）。末站成功 -> `completed`；**依赖解锁只看 completed**（中间站完成不解锁下游）。
2. **默认指派**：ready 任务默认指派 `chain[chainCursor+1].member`；`eteams_advance_task(task_id)` 一键推进（`eteams_assign_task` 可显式指派/偏离）。
3. **偏离**：指定非链成员或跳站必须附偏离说明；记 `chain.deviated`（偏离站、原站成员、原因）。预规划链不改（留档），实际路线由执行线路完整呈现。
4. **站点内重试/换人**：重试=同成员（[08](08-retry-escalation.md)）；站点换人=偏离（attempt kind 仍为 reassign，附偏离记录）。
5. **空链/单站**：无链任务即单执行人任务，领队自由指派（兼容纯 D4 流程）。
6. **链编辑**：见 6.4 矩阵补充规则（未开始可整体编辑；开始后仅追加）。
7. **完成即续派（FR-36）**：站点完成使成员空闲；领队同轮决策必须「推进链 + 给空闲成员派下一任务」双动作（详见 [07](07-scheduling.md) 7.3.5）。

## 6.8 状态与界面的对应文案（中/英对照要点）

| 状态 | 中文 | English |
|---|---|---|
| draft | 草案 | Draft |
| ready | 待指派 | Ready |
| assigned | 已指派 | Assigned |
| in_progress | 执行中 | In progress |
| retrying | 自动重试中 | Retrying |
| paused | 已停驻 | Paused |
| awaiting_decision | 待领队决策 | Awaiting decision |
| needs_user | 等待用户 | Needs user |
| suspended | 已挂起 | Suspended |
| blocked | 被阻断 | Blocked |
| completed | 已完成 | Completed |
| failed | 已失败 | Failed |
| cancelled | 已取消 | Cancelled |

状态点颜色语义（亮/暗主题各一套，色盲安全：状态同时有图标/文字）：进行系蓝、成功绿、失败红、等待系黄、挂起灰、阻断橙。
