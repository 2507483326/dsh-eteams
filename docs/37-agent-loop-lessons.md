# 37 Claude Code Agent Loop 剖析与 eTeam 借鉴

分析对象：`C:\Users\epat\Downloads\Claude-Code-main\src\query.ts`（约 1730 行）——Claude Code 主循环
`query()` 的完整实现。本文先自含地剖析它的核心逻辑（循环骨架 / 消息拼接 / 工具调用 /
compact / 继续执行），再对照 eTeam 现状逐条提取可借鉴与可优化的点。

eTeam 的定位决定了借鉴方式：eTeam 是 DSH 插件，**原始模型循环（流式采样、消息数组管理、
prompt cache）由宿主持有**，eTeam 拥有的是循环之上的编排层——领队/成员持续子代理、
派发邮件与唤醒、任务状态机（[assignment.ts](../src/host/runtime/assignment.ts)、
[notifier.ts](../src/host/runtime/notifier.ts)、[members.ts](../src/host/runtime/members.ts)）。
因此本文的借鉴点分两类：

- **A 类：eTeam 编排协议层可直接落地**——不依赖宿主改动，改 `runtime/`、`tools/`、`prompts/` 即可；
- **B 类：宿主层机制**——eTeam 不自建，但值得作为对 DSH 的输入，或据此调整 eTeam 的兜底策略。

## 1. query.ts 核心逻辑剖析

### 1.1 循环骨架：async generator + State + 具名 transition

`query()` 是一个 async generator：yield 流事件与消息，return 一个终态对象
（`{ reason: 'completed' | 'prompt_too_long' | 'aborted_tools' | ... }`）。真正的循环在
`queryLoop()` 里是一个 `while (true)`，每轮迭代 = 「组装输入 → 调模型（流式）→ 执行工具
→ 把结果拼回消息数组 → 继续」，直到一轮没有产生 tool_use 才走出循环。

跨迭代状态收敛为一个 `State` 对象（messages、autoCompactTracking、恢复计数器、
pendingToolUseSummary、turnCount 等），每个 `continue` 点整体重写 `state = {...}`，并带一个
具名 `transition: { reason: '...' }`。全部 continue 点屈指可数，且每个 reason 都是可断言的：
`next_turn`（正常推进）、`reactive_compact_retry`（413 后压缩重试）、
`max_output_tokens_recovery`（限流续跑）、`stop_hook_blocking`（hook 阻断续跑）、
`token_budget_continuation`（预算续跑）等。注释明说这是为了「tests assert recovery paths
fired without inspecting message contents」——**循环可测性来自具名转移，而不是靠解析消息内容**。

终态 reason 同样枚举化，SDK 消费者据此决定展示与终止行为。

### 1.2 消息拼接：每轮 API 输入的组装流水线

每轮迭代开头，从持久消息数组投影出本轮真正发给 API 的 `messagesForQuery`，顺序是一条
**由廉价到昂贵的裁剪流水线**：

1. `getMessagesAfterCompactBoundary(messages)`——只取最近一次压缩边界之后的消息，边界之前
   的历史已被摘要替代；
2. `applyToolResultBudget`——对消息数组里的工具结果做总量预算，超限内容被替换为存根，
   替换记录持久化（会话恢复时能读回）；
3. snip（实验特性）——直接剪掉可丢弃片段；
4. microcompact——只压缩工具结果（按 tool_use_id 操作，不动正文语义）；
5. context collapse 投影——把已折叠的消息段替换为细粒度摘要（只读投影，不改底层数组）；
6. autocompact——以上都省不够时，才做整段对话摘要（全量压缩）。

流水线的关键次序注释：「collapse 在 autocompact **之前**跑——如果 collapse 已经把上下文压到
阈值以下，autocompact 就变成 no-op，我们保住细粒度上下文而不是一份粗摘要」。

其余拼接细节：

- 系统提示 = `appendSystemContext(systemPrompt, systemContext)`；用户上下文 =
  `prependUserContext(messagesForQuery, userContext)`，都是调用时的包装，不污染底层数组。
- **缓存纪律**：绝不原地修改历史消息——回填工具入参的展示字段时先克隆，且只在「新增了
  字段」时才克隆（覆盖式回填连克隆都不做），注释写明改动原文会导致字节不匹配、打破
  prompt cache。
- 工具执行完、发起下一轮调用**之前**，才注入附件类消息（文件变更通知、排队的用户消息、
  记忆预取、技能发现），并把它们推进 `toolResults`，让它们随下一轮请求一起上行。注释强调
  必须在工具全部结束之后做，因为「API 不允许 tool_result 与普通 user 消息交错」。

### 1.3 工具调用：流式执行与配对卫生

- **流式工具执行**：`StreamingToolExecutor` 在 tool_use 块还在流式生成时就入队，工具一边
  流一边跑；已完成的结果在流式过程中就被 yield 出去。模型继续生成的同时工具在执行——
  这是把「串行的 模型→工具→模型」变成部分重叠的关键。
- **循环退出信号**：不看 `stop_reason`（注释：「stop_reason === 'tool_use' is unreliable —
  it's not always set correctly」），而是看本轮流式里是否真的出现了 tool_use 块
  （`needsFollowUp`）。
- **配对卫生**（本文件里最值得学的工程纪律）：任何异常路径——模型 fallback、流式中断、
  请求抛错——都必须保证每个 tool_use 都有配对的 tool_result：
  - `yieldMissingToolResultBlocks()`：把已产生 tool_use 的每条助手消息补上合成
    tool_result（错误文案 + `is_error`），fallback/报错/中断三条路径都调它；
  - 中断时若走流式执行器，消费 `getRemainingResults()` 让执行器为排队/进行中的工具生成
    合成结果——否则 tool_use 会悬空；
  - 流式中途换模型：已生成的半截助手消息 yield tombstone（thinking 签名已失效，留在历史里
    会触发「thinking blocks cannot be modified」类 API 错误），执行器 `discard()` 后重建，
    防止旧 tool_use_id 的孤儿结果混进重试。
- 每轮工具批完成后，可以刷新工具集（新连上的 MCP 热加载进下一轮）。

### 1.4 Compact：四层递进 + 主动/反应两路

- **主动路**：每轮迭代开头按 §1.2 的流水线自检，省够了就不压缩；压缩成功后重建
  `postCompactMessages`（摘要 + 附件 + hook 结果）作为新的消息基线，并重置压缩追踪状态
  （turnId/turnCounter）。
- **反应路**：真正的 API 413（prompt too long）到来时走 reactive compact——先试最便宜的
  collapse 排水，不行再整段压缩，各一次性，由 `hasAttemptedReactiveCompact` 守卫防螺旋。
- **熔断**：压缩连续失败计数 `consecutiveFailures` 向下传递，熔断器阻止下一轮无限重试。
- **错误扣留**：prompt-too-long / max-output-tokens 这类「可恢复错误」先扣住不 yield，
  等恢复路径确定失败才放出来。原因注释很直白：SDK 消费者看到任何 `error` 字段就会终止
  会话，恢复循环还在跑但已经没人听了。
- **预算跨压缩结转**：task_budget 的 `remaining` 在每次压缩时把「被压缩掉的最后一个完整
  上下文窗口」从预算里扣掉——压缩后服务端只能看到摘要，不结转就会少算已花的钱。
- 旁注：autocompact 关闭时有一个硬阻塞上限，**预留空间让用户还能手动 /compact**；且
  「刚压缩完就跳过阻塞检查」——因为旧消息里的 usage 字段反映的是压缩前的上下文，拿它
  估算会误判。

### 1.5 继续执行：恢复梯与守卫

一轮没有 tool_use 也不终止时，按顺序走恢复梯：

1. **max_output_tokens**：先试一次性升级（默认 8k 上限命中 → 直接以 64k 重发同一请求，
   不发任何提示语）；仍不行则最多 3 次「续跑注入」——追加一条 meta 消息，文案值得全文抄录：
   > `Output token limit hit. Resume directly — no apology, no recap of what you were doing.`
   > `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`
   （直接续——不道歉、不复述；从被切断处接着写；把剩余工作拆小。）
2. **fallback 模型切换**：捕获 `FallbackTriggeredError` → 换模型重试整轮。注意三个细节：
   给每条 tool_use 补合成 tool_result；**剥掉 thinking 签名**（签名与模型绑定，把受保护
   thinking 块重放给另一个模型会 400）；向用户发一条 warning 系统消息（用户可见的降级
   通知，但循环继续）。
3. **stop hook 阻断**：hook 返回 blockingErrors 时把错误拼进消息继续循环，`stopHookActive`
   防递归；两处防死亡螺旋的守卫值得记住：
   - 最后一条消息是 API 错误时**跳过 stop hooks**（错误 → hook 阻断 → 重试 → 错误 →
     hook 每圈注入更多 token → 死循环）；
   - stop-hook 阻断重入循环时**保留** `hasAttemptedReactiveCompact`——它被注释记载过一桩
     真实事故：重置为 false 会造成 compact → 仍超长 → 报错 → hook 阻断 → compact → …
     烧掉几千次 API 调用。
4. **token 预算续跑**：预算允许时注入一条 nudge 消息继续（isMeta）。
5. `maxTurns` 限值在**中断路径也要检查**（工具执行中途被打断同样计数），不只在正常路径。

### 1.6 旁支机制（对 eTeam 有参考价值的模式）

- **预取（start early, consume if settled）**：记忆/技能检索在轮次开头就异步发起，工具跑完
  后若已 settle 就消费，没 settle 就零等待跳过、下一轮再试——「预取有多少轮机会，取决于
  轮数」。绝不为附件阻塞主循环。
- **小模型异步摘要**：每批工具跑完后用 Haiku 异步生成一条「工具使用摘要」，下一轮迭代开头
  再 yield（模型流式的 5–30s 里摘要早已算完）——用便宜的小模型做展示层，不占主模型、
  不阻塞下一轮。
- **队列排水与优先级**：工具执行完取一次排队命令快照，转成附件随下一轮上行；优先级按
  「本轮是否执行了 Sleep 工具」决定（执行了就排 `later`，否则 `next`）；斜杠命令**不**在轮中
  排水（必须走命令生命周期）；队列按 agent 分账——主线只收 `agentId === undefined` 的，
  子代理只收发给自己的任务通知，绝不见用户 prompt 流。
- **周期任务摘要**：长会话周期性用小模型刷新「它正在做什么」的一句话（面板/`claude ps` 用），
  只在主线程做，子代理跳过。
- fetch 包装器每 query 只建一次：每次都建会各自闭包持有请求体，长会话能积出 ~500MB。

## 2. 概念映射：query.ts ↔ eTeam

eTeam 没有也不需要自建 §1 的原始循环——成员/领队是持续子代理，模型循环与压缩由宿主
负责；eTeam 的「循环」是**编排协议**：唤醒（followup）→ 成员干活并经工具上报 → 领队决策
→ 再唤醒。两边概念的对应关系：

| query.ts 概念 | eTeam 对应物 | 对齐情况 |
| --- | --- | --- |
| 每轮 `messagesForQuery` 拼接 | 成员子会话上下文（宿主持有）+ eTeam 每轮唤醒文本（assignment mail、notice） | eTeam 拼的是「增量消息」，完整消息数组不可见 |
| tool_use / tool_result 配对 | `eteams_*` 工具 + attempt token 握手（[assignment.ts:1258](../src/host/runtime/assignment.ts:1258) `requireLiveAttempt`） | 语义等价：无 token/已吊销的上报一律拒绝 |
| attachments（下一轮搭车注入） | 邮箱 + 唤醒（[notifier.ts](../src/host/runtime/notifier.ts)：邮件落库、提交后 best-effort followup） | 同构：都是「下一轮可见的旁路消息」 |
| compact（主动/反应） | 宿主对子会话上下文的压缩，eTeam 无感知 | eTeam 未做兜底（见 §3.11） |
| recovery ladder（限流续跑/fallback/续跑指令） | retry 同成员立即重试 → 超限 `wait_decision` → 改派/挂起/通知用户（[assignment.ts:1127](../src/host/runtime/assignment.ts:1127) `failTask`） | 阶梯已有；缺「续跑指令风格」与 token 断点恢复（§3.1/§3.4） |
| 具名 transition / 终态 reason | events 表事件（task.blocked、attempt.revoked、decision.requested…） | eTeam 已有且更强：持久化 + 审计 |
| queued commands 排水 | 成员对话框排队消息（空闲即唤醒、执行中排队） | 可借鉴「搭车注入 + 优先级」（§3.6） |
| tool-use summary（小模型摘要） | 进度 notes（成员手写，≤200 字） | 可借鉴自动摘要（§3.7） |
| `StreamingToolExecutor` / cached microcompact / context collapse | 无对应，也不应有——这是宿主循环内器官 | B 类，不建议插件自建 |

## 3. 可借鉴点（A 类：eTeam 直接落地）

按优先级排列；每条给出 query.ts 的依据、eTeam 现状（文件级行号）与建议动作。

### 3.1 【P1】运行中 attempt 的 token 无断点恢复路径

- **依据**：query.ts 的恢复梯有一个隐含原则——循环推进所需的任何状态（token、attempt、
  合同要点）都必须能从持久层重建，恢复路径不能依赖「模型还记得」。压缩后关键状态会随
  `postCompactMessages` 的附件重新注入，就是这个原则的落地。
- **现状**：成员上报（progress/complete/fail）要求 `attempt_id + token`，而 token 只在
  `eteams_claim_task` 的返回里出现一次（[memberTools.ts:80](../src/host/tools/memberTools.ts:80)），
  且 claim 只对 `pending_accept` 的尝试有效——运行中尝试不能重取。`eteams_task_board`
  的视图（[memberTools.ts:251](../src/host/tools/memberTools.ts:251)）不回传 token。一旦成员
  子会话上下文被宿主压缩、截断或冷恢复丢失，token 就永久丢失，该 attempt 无人能上报，
  只能等领队吊销改派——一条本可自愈的路变成了人工流程。
- **建议**：二选一（可都做）：
  1. `eteams_task_board` 对 assignee 返回其当前 `running` attempt 的 `attemptId + token`
     （token 本就是该成员的凭证，回传不越权）；
  2. `eteams_claim_task` 幂等重入：对本人 `running` 且 `token` 匹配失败/缺失时允许
     「重新领取」同一 attempt 并重发 token（发事件 `attempt.reclaimed` 留痕）。

### 3.2 【P1】唤醒失败没有补投与熔断

- **依据**：query.ts 对每类失败都有「兜底 + 计数 + 熔断」三件套：合成结果保证配对、
  `consecutiveFailures` 阻断下一轮重试、`hasAttemptedReactiveCompact` 防螺旋。
- **现状**：`wakeMember` 失败只 `logger.warn` 后返回 false（[notifier.ts:148](../src/host/runtime/notifier.ts:148)），
  `runWakes` 吞掉一切（[assignment.ts:89](../src/host/runtime/assignment.ts:89)）。注释称
  「邮箱里已落库，下轮轮询仍可见」——但成员子会话只有被 followup 时才产生新轮次，
  空闲成员不会自己「轮询」；若唤醒失败且领队不再对该成员派发，邮件就静默滞留。
  连续失败（领队不在线、会话被回收）也没有计数，`eteams_dispatch_captain` 每轮都可能
  重复尝试。
- **建议**：
  1. 唤醒失败时在邮件上记投递状态（`delivery_failed_at` / 计数），事件 `mail.undelivered`；
  2. 任一后续成功唤醒/派发时批量补投未达邮件（邮件本来就是「下次唤醒随派发消息送达」
     的语义，补投只是把它显式化）；
  3. 对同一目标的连续唤醒失败做 `consecutiveFailures` 式熔断（如 3 次后降级为只落库 +
     事件，等面板/领队显式重试），避免失败风暴刷日志。

### 3.3 【P1】派发快照改「全量 → 增量」，保护子会话缓存

- **依据**：query.ts 的缓存纪律——追加到历史尾部的内容要保持「小且稳定」，大块易变内容
  每轮重发既撑大未缓存尾部，又因内容变化让缓存失效；大对象放文件里按需读（工具结果
  预算的思想：正文替换为引用，全文另存）。
- **现状**：`eteams_dispatch_captain` 每次转交都把全量 `teamView` JSON 拼进 prompt
  （[captainDispatch.ts:167](../src/host/tools/captainDispatch.ts:167)）。快照虽已精简过
  （成员只带工号/角色/状态、任务只带摘要、邮箱尾 5 条正文截 300 字，
  [teamOps.ts:749](../src/host/runtime/teamOps.ts:749)），但仍是**每轮全量重发**：任务数、
  成员数线性增长，且每轮 JSON 都在变——领队子代理是持续会话，这些尾部大 JSON 正是
  打破增量缓存、推高每轮输入的部分。
- **建议**：首派发全量快照（建立上下文，现状保留）；续聊轮改为**增量**——
  `【变化】自上轮以来：新任务 N、状态变更 M 条、未读邮件 K 封` + 指向工作区文档
  （teams/<team>/ 的 README 与任务文件夹本来就是落盘真相，成员/领队可用工具读取）。
  全量对账改为低频（每 N 轮一次或显式 `eteams_team_status`）。

### 3.4 【P2】重试/恢复的交接文案升级为「续跑指令」

- **依据**：query.ts 的 max_output_tokens 续跑文案（§1.5）是精心调过的恢复提示：
  不道歉、不复述、从断点接着做、剩余工作拆小。这同样适用于「成员失败后的重试」与
  「挂起后的恢复」——它们本质上都是对同一个上下文的续跑。
- **现状**：重试交接只有计数与错误回显——`handoff: 重试 x/y。上次失败：<error>`
  （[assignment.ts:1165](../src/host/runtime/assignment.ts:1165)）；`resumeTask` 恢复 paused
  任务时的新尝试不携带上次进度（[assignment.ts:859](../src/host/runtime/assignment.ts:859)，
  派发邮件里只有合同与 stageBrief）。
- **建议**：
  1. 重试 handoff 追加续跑指令：`直接从上次断点继续——不要道歉、不要复述已做的事；从
     失败步骤接着做；把剩余工作拆小。`并附上该 attempt 的最后一条 progress note；
  2. `resumeTask` 的交接里带上 `lastOutputOf`/最后进度（改派路径已经这么做了，
     [assignment.ts:768](../src/host/runtime/assignment.ts:768) `lastOutputOf`，恢复路径对齐即可）。

### 3.5 【P2】产出说明进邮箱前做预算截断

- **依据**：query.ts 的 `applyToolResultBudget`：超限的工具结果在主对话里替换为摘要 + 引用，
  全文保存在可恢复处。主上下文（领队邮箱）是稀缺资源，全文属于文件系统。
- **现状**：`eteams_complete_task` 的 `output` 长度不设限，全文进入完成邮件送达领队
  （[assignment.ts:1059](../src/host/runtime/assignment.ts:1059)），并随快照尾部再次进入
  领队子代理上下文。成员规则里虽有「产出同步写入任务 notes.md」的纪律，工具层不兜底。
- **建议**：工具层对 output 设上限（如 2000 字）：邮箱/面板展示走截断文本 +
  changedPaths + 任务文件夹路径；同时校验 notes.md 已写入（或工具返回值里提示写盘）。
  与 `appendProgress` 的 200 字上限同一思想，只是长内容落文件而非丢弃。

### 3.6 【P2】执行中收到的对话消息「搭车」送达

- **依据**：query.ts 的排队命令模式（§1.6）：轮中取一次快照、转成附件随下一轮请求上行、
  按优先级（Sleep 跑过→later，否则 next）决定排水范围，且按 agent 分账。
- **现状**：D15 口径「空闲即唤醒、执行中排队不打断」——成员执行中收到的成员对话框消息
  静默排队，等成员下一轮被唤醒（可能是领队续派）才可见；若迟迟无唤醒，用户消息滞留
  无提示。
- **建议**：给执行中成员的入站消息记「待搭车」标记；领队下次对该成员的任何唤醒
  （续派/重试/通知）的邮件尾部自动附上「未读对话 K 条 + 摘要」；用户级消息优先级高于
  通知。这样排队的消息必然随下一次轮次上行，而不是依赖一次不确定的独立唤醒。
  若成员完全空闲（无人会再唤醒它）则维持现状直接唤醒——那本来就是「空闲即唤醒」。

### 3.7 【P2】站点完成的小模型自动摘要

- **依据**：query.ts 的 tool-use summary 模式（§1.6）：用便宜的小模型异步生成展示摘要，
  下一轮才消费，完全不阻塞主流程；BG_SESSIONS 的周期任务摘要也是同款思路。
- **现状**：领队决策「完成即续派」依赖成员手写 output；进度 notes 也是人工 ≤200 字。
  长产出时领队要自己读全文才能决定推进。
- **建议**：站点/任务完成事件落库后，异步用小模型对「output + notes.md 摘要」生成
  ≤100 字一句话站摘要，作为 `task.stage_completed`/`task.completed` 事件 payload 的展示
  字段（面板与完成邮件头部展示，全文仍以邮件/文件为准）。生成失败不影响任何状态
  ——它是纯展示层。eTeam 已有 usage 计量，摘要调用可顺带归属记账。

### 3.8 【P2】派发/唤醒的结果事件化（终态 reason 枚举）

- **依据**：query.ts 把每个终态与每次 continue 的原因枚举化（§1.1），可观测、可断言。
- **现状**：dispatch 工具结果只有一句受理确认；`wakeMember`/`wakeCaptain` 失败只进
  logger，不进 events 表——面板无法回答「成员为什么没反应」。
- **建议**：唤醒结果写入事件（`wake.sent` / `wake.failed`，payload 带 target、原因、
  邮件 seq），面板成员行/邮箱行可显示投递状态。与 §3.2 的补投共用同一套标记。

### 3.9 【P3】死循环守卫清单化

- **依据**：query.ts 用注释记录了两桩真实事故（hook 阻断 × compact 螺旋烧掉数千次 API
  调用；stop hooks 在 API 错误上的死亡螺旋），守卫代码都带守卫理由。
- **现状**：eTeam 的任务级环已有多重守卫（重试上限→wait_decision、POISON 依赖集、
  改派占用判定、判环 `wouldCycle`），但编排层还有几个可自锁的环没有显式守卫：
  - 改派回同一成员的「领取→婉拒→改派回同一人」环（婉拒不计入 retryCount）；
  - wait_decision 未决时领队反复被同一封失败邮件唤醒（每次 wake 都重放全文）；
  - §3.2 的失败唤醒重放风暴。
- **建议**：为上述三处各加一道计数/去重守卫（同一 decision 未决期间失败邮件只唤醒
  一次；婉拒同一任务同一成员记去重；补投带最大次数），并在代码注释里写明守卫理由——
  query.ts 的经验是：**守卫要注释出事故推演**，否则后人重构时会当冗余删掉。

### 3.10 【P3】邮箱与事件的 microcompact（分层回收）

- **依据**：query.ts 的分层次序（§1.2/§1.4）：最便宜的先做（snip：直接删），其次按类回收
  （microcompact：只处理工具结果一类），最后才是整段摘要；每层都可能让下一层变成
  no-op；回收边界持久化（boundary message），重启后恢复仍知道摘要从哪里开始。
- **现状**：`mail_messages` 与 `events` 只增不减；成员 claim 时邮箱只取尾 5 条做预览，
  领队快照只带尾 5 条，但全量数据永不回收。长周期团队里两者随任务数与轮次线性增长
  （快照/查询的扫描成本随之上升）。
- **建议**（不必一步到位）：
  1. 已读且已被任务文档吸收的邮件（assignment/report，任务已 completed 且 notes.md 存在）
     归档为按任务聚合的一行摘要（同 query.ts 的 microcompact：按类回收，不动别的）；
  2. events 表在任务收口时把该任务的明细事件聚合为一条 `task.timeline_summarized`，
     明细移入归档表；聚合水位持久化（= boundary），恢复路径按水位续读。

### 3.11 【P3】对宿主子会话压缩的兜底假设写进契约

- **依据**：query.ts 证明了压缩是常态操作且压缩后**必须重新注入关键状态**（附件 + 摘要）。
  eTeam 的对应问题是：成员/领队子会话被宿主压缩后，合同要点、attempt_id、token 是否
  仍可用。
- **现状**：eTeam 的持久层设计天然友好——合同每次派发随邮件全文重发、任务文档落
  工作区、看板可重查，都是「压缩后可重建」的（这正是 query.ts 的做法）。缺口只在
  token（§3.1）。
- **建议**：把「token 可从看板取回（§3.1 落地后）+ 合同随每次派发重发 + 任务真相在
  notes.md」写成对宿主压缩的显式兜底契约（注释或 README 术语段），并在装机验证清单
  里加一项：对成员子会话触发压缩后，验证 claim/上报仍可完成。若宿主保证不可得，
  退路是派发邮件尾注始终携带 `attempt_id + token`（首派 claim 后由 eTeam 追加确认邮件）。

## 4. B 类：宿主层机制（不建议 eTeam 自建，可作对 DSH 的输入）

- **流式工具执行**（§1.3）：工具在模型流式生成期间开始执行。这是宿主循环内器官，
  插件无法插手；作为对 DSH 的建议价值很高——成员执行任务时的串行等待是 eTeam 观感
  慢的主要来源。
- **分层 compact 与 reactive compact**（§1.4）：同理属宿主；建议 DSH 对 continuable 子会话
  提供「压缩后关键上下文重新注入」的保证或钩子（eTeam 的 §3.11 兜底即为此准备）。
- **错误扣留**（§1.4）：宿主应在恢复路径确定失败后才把可恢复错误上抛给插件/SDK——
  否则插件侧任何「看到错误就终断」的消费者都会误杀仍在恢复中的会话。
- **工具结果总量预算**（§1.2）：宿主若提供 per-message 工具结果预算，eTeam 的
  `eteams_task_board`/`eteams_team_status` 大结果自动受益；否则按 §3.5 在工具层自查。
- **不照搬清单**：thinking 签名剥离与 fallback 模型切换（模型层）、cached microcompact 与
  context collapse（宿主缓存编辑能力）、dumpPromptsFetch 内存治理（调试基建）——这些
  依赖宿主内部能力，插件层模仿只会做出脆弱的复制品。

## 5. 小结

query.ts 值得 eTeam 带走的是四条原则，而不是它的代码：

1. **配对卫生**：任何异常路径都要把悬空的请求/响应对补全（eTeam 对应：attempt/token
   握手 + §3.1 的 token 断点恢复）；
2. **由廉价到昂贵的裁剪流水线**：先 delta、先分类回收，最后才全量压缩；大对象落文件、
   上下文里只放引用（eTeam 对应：§3.3 增量快照、§3.5 产出截断、§3.10 邮箱回收）；
3. **恢复梯 + 守卫注释**：每类失败给一条最便宜的恢复路径，一次性守卫防螺旋，守卫旁写
   事故推演（eTeam 对应：§3.2 补投熔断、§3.9 死循环守卫清单）；
4. **旁路不阻塞主路**：摘要、预取、排队消息全部异步/搭车，宁可下一轮补上也不让主循环
   等待（eTeam 对应：§3.6 对话消息搭车、§3.7 小模型摘要）。