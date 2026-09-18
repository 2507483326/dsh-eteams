# 宿主重启后任务卡「执行中」——死会话对账（2026-09-18）

**状态：已实现（启动对账 + 30s 周期 sweep + 6 条回归用例）。**

## 症状

用户 2026-09-18 原话：

> 应用重启后还一直是 执行中，执行中的好像没有获取状态？

宿主（DSH Desktop）重启后，面板/看板里本该已经中断的任务仍一直显示「执行中」，
再也不会变；用户以为是「没有获取状态」。

## 先排除的误判：不是轮询问题

客户端**一直在拉状态**——`src/client/lib/monitor.ts:24` 的 1s 轮询链每次都请求
`/eteams-api/state`（服务端 `src/host/runtime/webui.ts` 的 `teamSnapshot`）。
问题不在「拉没拉」，而在**拉回来的状态源本身就是旧的**。

## 契约（实现本该做到的）

- 容器（大任务）状态由子任务实况派生，且**只在有在办小任务时才为 `start`**：
  写入侧 `src/host/runtime/assignment.ts:2245`（`syncGroupStatusInTx`）、读取侧
  `src/host/runtime/webui.ts:289`（`containerStatusOf`）。
- 「在办」判据两侧逐字一致：小任务 `status==='start'` **或** 存在
  `pending_accept`/`running` 尝试（`assignment.ts:2254`、`webui.ts:293`）。
- 中断要被记成状态：成员回合被中断 → 吊销尝试 → 小任务 `paused`
  （`src/host/runtime/assignment.ts:1481`，`pauseTaskOnInterrupt`）。

## 根因（三条叠加）

1. **在办状态是持久化残值，没有租约/心跳**：`attempts.status`（`pending_accept`
   / `running`）落库（`src/host/state/schema.sql:195-207`），表里只有
   `created_time` / `claimed_time` / `ended_time`。宿主进程没了，这些行照样在库里。
2. **读侧兜底判不出「人已经没了」**：`containerStatusOf`（`webui.ts:289-303`）
   只要看到任一子任务有在办尝试就判 `active` → 容器返回 `start`。它没有「对应
   会话还活着吗」的判据，所以「陈旧 start 回落 ready/paused」那一支永远不触发。
3. **唯一能吊销尝试的路径重启即失效**：中断观察者
   （`src/host/runtime/interruption.ts:72-101`）靠两张**进程内存 Map** 反查会话
   归属——成员表 `memberSessions`（`src/host/runtime/usage.ts:74`）、领队表
   `captainChildren`（`src/host/runtime/captainChildRegistry.ts:18`）。重启后两表
   皆空，`resolveInterruptionTarget` 直接 `return undefined`；崩溃也不会再补记
   `turn/end{interrupted}`。于是没人吊销，状态永远卡住。

（补充：`apply()` 原先没有任何启动对账；旧注释「冷恢复靠 session/created 对账 +
`ctx.sessions.list()` 装机补折」与实现不符，已随本次订正。）

## 修法：按宿主活 agent 集合对账（写侧）

新增 `src/host/runtime/reconcile.ts`，在 `src/host/index.ts` apply 的 2d 装机。

### 判据：活 agent 集合

`ctx.agents.list()`（`@deepseek-ai/dsh-agent` 的 `AgentRegistry`，cordis Service，**方法带接收者调用**）
返回全部活 agent，`Agent.id` 即共享的 agent/会话 id
（`node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:60-62`）。
重启后该集合必为空——这正是重启的可靠信号。

### 链路

```
每轮 sweep（启动一次 + 每 30s，timer unref）
  ├─ live = new Set(ctx.agents.list().map(a => String(a.id)))
  └─ for root in collectRoots(ctx, config):           # 跨工作区，按状态根去重
       for row in listInFlightAttempts(root):         # 只取 pending_accept/running（部分索引）
         ├─ 宽限期：now - (claimed_time ?? created_time) < 60s → skip
         ├─ sessionId = attempt.task_member_id → task_members.session_id（旧数据退按名）
         ├─ sessionId 非空且 ∈ live → skip             # 真有会话在跑
         └─ 否则 → pauseTaskOnDeadSession(env, teamId, taskId)
                     = 吊销 attempt → 小任务 paused → 容器派生同步
                       + task.suspended{via:'session.dead'} + statusNote
```

### 关键落点

| 关注点 | 位置 |
|---|---|
| 在办尝试查询（走 `idx_attempts_status`） | `src/host/state/store.ts`：`listInFlightAttempts` |
| 会话已死 → 挂起（复用中断路径同一批原语） | `src/host/runtime/assignment.ts`：`pauseTaskOnDeadSession` |
| 状态根枚举（与面板共用，避免双轨） | `src/host/runtime/workspaces.ts`：`collectRoots` |
| 对账本机（sweep / 装机 / 测试复位） | `src/host/runtime/reconcile.ts` |
| 装机 | `src/host/index.ts`：apply 2d |

**没动**：`containerStatusOf` 读侧兜底（写侧改对后它自然正确）、中断观察者、
`attempts` schema（不加列）。

## 已知边界

- **「活 agent」的语义是「进程内会话存在」，不是「正在跑回合」**：continuable
  子代理在 idle 期仍驻留注册表，因此在册 → 不判死；重启后必然不在册。
- **误杀窗口**：spawn / 冷恢复途中有短暂「不在册」，由 60s 宽限期兜住。若日后
  仍见误挂，可升级为「连续 N 轮命中」再动作。
- **冷恢复不冲突**：对账只吊销不动会话；用户点「开始」走既有 `resumeTask`
  重新派发，原生 spawn/wake 链路照常。
- **启动首轮可能 no-op**：apply 时刻 `workspaceRegistry` 可能尚未就绪，
  `collectRoots` 返回空；首个 30s tick 自然补上。
- **与中断观察者的分工**：进程内中断（手动停止/回合异常）仍由观察者按事件实时
  处置；对账负责重启后无事件的残留。
