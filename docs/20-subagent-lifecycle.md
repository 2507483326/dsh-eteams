# 20 子代理生命周期与回收（基于官方 Subagent 参考的重新规划）

> 依据：官方参考 https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/subagent
> 与社区镜像 https://deepseekdocs.com/docs/features/subagent（Docusaurus 概览站，非官方域名；
> 两者内容交叉验证，冲突处以官方为准——`drainContinuable*` 两个操作仅官方参考收录）。
> 本文档是**规划稿**：先定契约，再动代码。

## 20.1 问题陈述

用户痛点：构建/团队完结后，子代理仍「挂」在界面上。此前我们误以为 harness 没有任何回收口，
实际官方参考给出了明确的公开语义——包括两个此前类型快照里没有的回收操作。重新规划如下。

## 20.2 官方语义（已逐段核对）

### 20.2.1 两种形态

| 形态 | API | 生命周期 | 持久记录 |
|---|---|---|---|
| 一次性 one-shot | `subagents.start(name, request)` → `SubagentRun` | 单轮：发布 → 轮次 → result 结算 → dispose | 本地 run 持久化子会话（descriptor 标 `one-shot`），**会出现在 listChildren 枚举里**；但**面向模型的 `list_agents` 适配器只保留 continuable 条目**——模型永远看不到 one-shot |
| 可续 continuable | `startContinuable(spec)` + `followup` / `interrupt` / `reportFrom` | 持久 Session ⇄ 至多一个驻留 Activation（running / waiting / settled）；冷恢复重建 Activation | 持久子会话 + 版本化 descriptor（快照 provider/model/persona/toolFilter） |

要点：

1. **Activation 结算（settled）后管理器 dispose `AgentHandle` 并移除 Activation**；持久子会话**不受进程内拆卸影响**——记录与「是否在跑」是两回事。
2. `interrupt` 只停当前轮次（`keepInbox: true`），已接受未领取的 inbox 工作保留，下一次唤醒发送会恢复被暂停的 FIFO 队列；对不存在/一次性/已结算目标是**接受的 no-op**。
3. continuable 子代理结算时，管理器**无条件**向其持久化直接父投递一条 `subagent-settled` 通知（`notice` 形态）——这是对话里那些「后台子代理已结束」系统行的来源，不是泄漏。
4. followup 权威 = 持久 header 里的**确切直接父**；父在重组期间被注销/替换则无法投递。
5. 一次性 run 的契约：「消费方 await 该结果并**始终 dispose** 该 run」——dispose 释放资源并到达静止，幂等。

### 20.2.2 回收操作（官方公开 API；本仓库 node_modules 类型快照落后，未收录）

```ts
// 释放某确切在线父下选中的驻留 continuable 直接子级；其余子级不受影响。
// 不存在的目标与无管理器组合为接受的 no-op；返回 = 所有选中 Activation 释放其 AgentHandle。
drainContinuableChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void>

// 关闭确切在线父之下的准入，同步停其可见后代 Activation，等待物化完成后子级优先释放森林。
drainContinuableDescendants(parents: readonly Agent[]): Promise<void>

// 枚举（不加载不恢复 Agent）：直接子级 / 全树；条目含 mode('one-shot'|'continuable') 与
// activity('running'|'inactive')——activity 只表示记录是否在 ctx.sessions 存活。
listChildren(parentSessionId, signal?): Promise<SubagentListEntry[]>
listDescendants(rootSessionId, signal?): Promise<SubagentDescendantListEntry[]>
```

**关键结论**：

- 「回收」有且只有两层：① `drain*` 释放**驻留 Activation**（live 注册表立刻干净、不可再唤醒）；
  ② **记录级清理 = 父会话销毁**（持久化子会话随父对话回收）。不存在 per-record delete API。
- `drain*` 是**运行时版本相关**的新公开面：本仓库安装的 `@deepseek-ai/dsh-subagent` 类型里没有。
  任何调用必须**特性检测**（`typeof subagents.drainContinuableChildren === 'function'`），缺失时降级为 `interrupt`。

### 20.2.3 镜像站补充（概览级，与官方一致）

- 模型面对的控制面 = `tool-subagent`（一次性）与 `tool-subagent-control`（`send_message`/`interrupt_agent`/`list_agents`，即 continuable 控制面）。
- provider 家族：`spawn`/`fork`（同进程，默认装载）、`acp`/`claude-code`/`codex`/`dsh-sdk`（子进程/桥接）。
  `fork` = 同进程 + 父已完成轮次前缀 seed；`spawn` 从空对话开始。
- 能力旗标 `outputSchema/depthLimit/toolFilter/persona` 仅描述 one-shot 路径；continuable 由
  `prepareContinuable` 方法存在性把关。
- 验证手段：`dsh web --dump-config | grep subagent`；会话日志 `~/.dsh/sessions/*/*/session.jsonl.zstd` 中 `subagent/` 事件。

## 20.3 现状对照

| 领域 | 现状 | 与官方语义的关系 |
|---|---|---|
| 角色构建师 | 已改**一次性阶段制**（A 受理/访谈 → B 起草 → C 恢复，`builderPhases.ts`） | ✅ 对齐 one-shot 形态：每个阶段单轮终结；模型面 list_agents 不再显示；UI 里是终态 one-shot 记录 |
| 团队成员 | `startContinuable` 持久成员（邮箱模型/完成即续派/上下文连续依赖） | continuable 是**产品正确选择**；完结/移除后记录仍在，此前无回收手段 |
| 团队收尾 | `archiveTeam`/`deleteTeam` 只处理 `.eteams/<teamId>/` 并 `interruptMember` | ❌ 未调 `drain*`：成员驻留 Activation 保留、live 列表仍显示 |
| 一次性 run 收尾 | `spawnBuildPhase` fire-and-forget，**未持有 run、未 dispose** | ❌ 违反「始终 dispose」契约：资源释放时机交给了运行时 |
| 记录级清理 | 文档写明「随父会话回收」 | ✅ 与官方一致（会话即工作区） |

## 20.4 改进计划（按优先级）

### P1 一次性 run 兑现 dispose 契约（builderPhases.ts）

派发后不丢句柄：

```ts
const run = await subagents.start(provider, {...});
void run.result
  .catch(() => undefined)          // 基础设施故障已由运行时结算，吞掉即可
  .then(() => run.dispose())       // 自然完结 → 立即释放资源、到达静止
  .catch(() => undefined);
```

阶段语义不变（干完自然结束）；变化仅是**资源确定性释放**。

### P2 团队收尾接 drain（teamOps.ts + members.ts）

成员 `childId` 已持久化在 team.json（`member.id`），直接可用：

- `removeMember`（运行中分支）：现有 `interruptMember` 之后，特性检测调用
  `drainContinuableChildren(captainAgent, [member.id])`，等待驻留 Activation 释放。
- `archiveTeam` / `deleteTeam`：对全部成员 id 批量 `drainContinuableChildren(captainAgent, ids)`
  （captain Agent 需在线：`ctx.agents.get(team.captainSessionId)`，缺线则跳过并照旧 interrupt）。
- 降级链：`drainContinuableChildren` 缺席（旧运行时）→ 维持现状 `interruptMember`（interrupt 对
  已结算目标是 no-op，安全）。
- 语义边界：drain 释放**驻留 Activation**（live 列表立刻干净、不可再被 followup 唤醒）；
  持久记录仍在——记录级清理唯一途径见 P5。

### P3 类型面补齐（base.ts）

`RuntimeContext.subagents` 增补**可选**声明（运行时版本门控，全部 `?.` 调用）：
`listChildren?` / `listDescendants?` / `drainContinuableChildren?` / `drainContinuableDescendants?`。

### P4 面板「子代理活动状态」（webui.ts + eteamsView.tsx）

- 团队概览 / 快照新增只读字段：对该团队 captainSessionId 调
  `listChildren`（特性检测），输出 `{name, activity: 'running'|'inactive'}[]`。
- 面板成员行渲染活动点：running=呼吸点，inactive=灰点（完结即灰，用户肉眼可确认「没有在跑」）。
- 一次性阶段代理（角色构建师）不进该列表——listChildren 只列**直接子级**，构建阶段代理的父是主会话而非团队；保持现状即可。

### P5 记录级清理的用户指引（文档 + 面板文案）

- 官方语义：持久化子会话随父对话回收，**无 per-record delete**。
- 指引写进面板历史团队区与 README：一个项目/一批团队用一个对话；项目结束 → `eteams_archive_team`
  归档状态 → 在 DSH 归档/删除该对话，整棵子代理记录随之回收。

### P6 明确不做的事

- 不做「子代理记录删除」的任何旁路（直改 harness 存储目录）——官方无此 API，风险（破坏会话存储）远大于收益。
- 不把成员改成一次性：邮箱投递、完成即续派、任务上下文连续都以持久对话为前提；官方文档亦把
  「常驻助手、跨轮持有状态」列为 continuable 的适用场景，成员正是该场景。
- 不追 `fork` seed：构建阶段代理需要的是结构化会话快照（rolebuilder.json），不是对话前缀。

## 20.5 风险与权衡

| 风险 | 处置 |
|---|---|
| node_modules 类型落后于线上运行时 | 全部新 API 特性检测 + 降级链；不在类型层断言存在 |
| drain 等待释放可能耗时（等子级静止） | 仅团队收尾路径调用（低频操作），UI 无感知；超时风险由管理器自身契约承担（返回即已释放） |
| one-shot 记录仍占 listChildren 枚举（模型不可见、UI 可见） | 官方语义即如此；UI 端以 P4 的 activity 灰点呈现「已完结」 |
| 镜像站与官方文档漂移 | 引用一律以官方 github.io 为准；镜像只作概览交叉验证 |

## 20.6 验证

1. `dsh web --dump-config | grep -iE "subagent"`：确认运行时 provider 与服务在位。
2. 会话日志 `subagent/` 事件：构建阶段跑完后应见 `subagent/start`+`subagent/end` 成对事件（one-shot 不产生 continuable 水位）。
3. 面板：构建完结后成员/构建行活动点转灰；团队删除后成员不再出现在 live 列表。
4. `list_agents`（模型面）：角色构建阶段代理完结后不再出现（one-shot 被适配器过滤）。
5. 既有门禁：tsc×2 / lint / vitest / build / verifyM0 全绿。

## 20.7 实施顺序

P1+P3 → P2 → P4 → P5（文档与文案收尾）。每步独立可交付、独立可回滚。

## 20.8 实施记录

- **P1 ✅** `builderPhases.ts`：派发后持有 `SubagentRun`，`result → dispose()` 链兑现官方「始终 dispose」契约；阶段语义不变。
- **P3 ✅** `base.ts`：`RuntimeContext.subagents` 增补可选声明 `drainContinuableChildren?` / `drainContinuableDescendants?` / `listChildren?` / `listDescendants?`（+ 最小结构 `SubagentChildEntry`），全部运行时版本门控。
- **P2 ✅** `members.ts` 新增 `drainMembers(env, captain, ids)`（特性检测 + 静默降级）；`teamOps.ts` 三处接入：`removeMember`（interrupt 后 drain 单个）、`archiveTeam` / `deleteTeam`（drain 全部成员 childId，childId 已持久化于 team.json `member.id`）。
- **P4 ✅** 宿主新只读路由 `GET /eteams-api/team/<id>/agentactivity`（`listChildren` 特性检测 → `{childId: activity}`，旧运行时空表）；面板 `TeamTab` 3s 轮询，`MemberCard` 名旁渲染活动点（running=绿色呼吸点 / inactive=灰点；无数据不渲染）。一次性构建阶段代理不进该列表（其父是主会话而非团队 captain），保持终态记录形态。
- **P5 ✅** docs/09 §9.8 更新为两层回收语义；本节为实施记录。
- 全部门禁：tsc×2 / lint / vitest(64) / build / verifyM0。

## 20.9 后续候选（未排期）

- `drainContinuableDescendants` 的面板级「停止整棵森林」入口（现仅 API 面）。
- 构建历史 one-shot 记录在 UI 的折叠视图（现按终态记录原样展示）。
