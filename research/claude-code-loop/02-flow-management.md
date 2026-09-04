# 02 流程管理：循环骨架、裁剪流水线、压缩梯与恢复梯

研究对象：`C:\Users\epat\Downloads\Claude-Code-main` 源码，以 `src/query.ts`（约 1730 行）
为中心，含其直接依赖（transitions/deps/config/tokenBudget/stopHooks/messageQueueManager、
services/tools、services/compact）。本文回答：agent 循环的每一轮是怎么推进的、失败是怎么
恢复的、什么时候压缩、压缩失败怎么办。每节末尾给 eTeam 的对标（现状以 2026-09-04
工作区为准）。

---

## 1. 循环骨架：async generator + State + 具名转移

`query()` 是 async generator：yield 流事件与消息，return 终态对象。真循环在 `queryLoop()`
的 `while (true)` 里，每轮迭代 = 组装输入 → 调模型（流式）→ 执行工具 → 结果拼回消息数组 →
继续，直到一轮没有产生 tool_use 才退出循环。

跨迭代状态收敛为一个可变的 `State` 对象（messages、autoCompactTracking、恢复计数器、
turnCount、pendingToolUseSummary 等）。**每个 `continue` 点都整体重写 state 并带具名
reason**，全部转移屈指可数且可断言：

- `next_turn`（正常推进）
- `reactive_compact_retry`（413 后压缩重试）
- `collapse_drain_retry`（collapse 排水后重试）
- `max_output_tokens_escalate` / `max_output_tokens_recovery`（限流升级/续跑）
- `stop_hook_blocking`（hook 阻断续跑）
- `token_budget_continuation`（预算续跑）

终态 reason 同样枚举：`completed`、`prompt_too_long`、`aborted_tools`、`blocking_limit`、
`model_error`、`image_error`、`hook_stopped`、`stop_hook_prevented`、`max_turns`。

设计意图写在注释里：**循环可测性来自具名转移——测试可以断言「恢复路径触发过」，而不用
解析消息内容**。配套的模式：`QueryDeps`（callModel/microcompact/autocompact/uuid 四个
依赖，`typeof fn` 类型让签名自动同步，测试注入假件）与 `QueryConfig`（query 入口处的
不可变快照）。

`maxTurns` 限值在**中断路径也要检查**（工具执行中途被打断同样计数），不只正常路径。

**eTeam 对标**：eTeam 的对应物是状态机 + 事件表（`src/host/model/taskMachine.ts` 十态、
`src/host/state/events.ts`）——已经是「具名转移 + 可断言」，且持久化更强。可借鉴的是
`QueryDeps` 式的**依赖注入**：eTeam 的 runtime 函数直接调 `wakeMember`/`emit` 等闭包，
测试靠 SQLite fixture；把「唤醒」「事件」抽成可注入 deps 能让编排协议的测试摆脱数据库
（低优先级，记入 04 附录）。`maxTurns 中断路径也计数` 的对应教训：eTeam 的重试计数
retryCount 在失败路径累加，但**婉拒不计**——构成 04 清单 R-3 的环。

---

## 2. 每轮输入：由廉价到昂贵的裁剪流水线

每轮迭代开头从持久消息数组投影出 `messagesForQuery`，顺序是一条**成本递增**的流水线：

1. `getMessagesAfterCompactBoundary` — 只取最近压缩边界之后的消息；
2. `applyToolResultBudget` — 工具结果总量预算，超限替换为存根，替换记录持久化
   （会话恢复可读回）；
3. snip（实验）— 直接剪掉可丢弃片段；
4. microcompact — 只压缩工具结果（按 tool_use_id 操作，不动正文语义）；
5. context collapse 投影 — 已折叠段替换为细粒度摘要（只读投影，不改底层数组）；
6. autocompact — 以上省不够才整段摘要。

次序的注释理由：「collapse 在 autocompact **之前**跑——collapse 压到阈值以下时 autocompact
变 no-op，保住细粒度上下文而不是一份粗摘要」。

拼接细节：

- 系统提示/用户上下文都是调用时包装（见 01 文档 §2），不污染底层数组；
- **缓存纪律**：绝不改历史消息；回填只克隆+只加字段；
- 附件类消息（文件变更通知、排队用户消息、记忆预取、技能发现）在**工具全部结束之后、
  下一轮请求之前**注入并推进 `toolResults`——注释明说：API 不允许 tool_result 与普通
  user 消息交错，所以必须等工具批结束再拼；
- 边界消息的 usage 字段延迟到真实 API 用量回来才填。

**eTeam 对标**：eTeam 没有消息数组，对应物是「成员子会话上下文（宿主持有）+ eTeam 每轮
注入的增量消息（派发邮件、唤醒文本、邮箱摘要）」。流水线的映射：**每次唤醒注入的应该是
增量**，全量快照只是低频对账——04 清单 R-4。`applyToolResultBudget` 的思想对应 eTeam
工具层自查：`eteams_task_board` 把成员所有任务的全文 contract 都返回（`memberTools.ts`
boardTool），多任务时无界——04 清单 R-7。

---

## 3. 工具编排：流式执行 + 配对卫生

### 流式执行器（`StreamingToolExecutor`）

- tool_use 块**边流式生成边入队**，工具在模型继续生成的同时开始跑；
- `isConcurrencySafe` 并行的安全工具并行跑，非安全工具独占；并发默认 10
  （`runTools` 回退路径用 `partitionToolCalls`：连续安全工具批量并行）；
- 每工具一个子 AbortController；Bash 失败经 `siblingAbortController` 级联中止兄弟工具；
- `interruptBehavior()`：'cancel'（中断时放弃）或 'block'（必须等它结束）；
- 异常路径生成合成结果（sibling_error / user_interrupted / streaming_fallback），
  `discard()` 丢弃执行器状态，**按序 yield**（pendingProgress 立即出）。

### 循环退出信号

`needsFollowUp` 以本轮**是否真的出现 tool_use 块**为准，注释明说
`stop_reason === 'tool_use' is unreliable`。

### 配对卫生（全文最值得学的纪律）

任何异常路径都必须保证每个 tool_use 有配对 tool_result：

- `yieldMissingToolResultBlocks()`：fallback / 报错 / 中断三条路径都补合成
  tool_result（错误文案 + is_error）；
- 中断时消费 `getRemainingResults()`，让执行器为排队/进行中工具生成合成结果；
- 流式中途换模型：半截助手消息 yield **tombstone**（thinking 签名与模型绑定，重放会 400），
  执行器 `discard()` 后重建，防旧 tool_use_id 的孤儿结果混入重试；
- 下游还有一道 `ensureToolResultPairing`（claude.ts）兜底修复；
- fork 分支**不做**预过滤——注释：预过滤会把整条 assistant 连同配对结果一起丢掉（API 400），
  下游修复必须产出与主线程完全相同的修复后前缀，缓存才命中。

**eTeam 对标**：eTeam 的配对是 attempt token 握手（`requireLiveAttempt`，
`assignment.ts:1258` 附近）——无 token/已吊销的上报一律拒绝，语义等价。缺口在**断点恢复**：
token 只在 claim 返回出现一次且 claim 只对 pending_accept 有效，运行中尝试丢 token 后无人
能上报——04 清单 R-1。「异常路径补齐」的对应教训：成员子会话若中途死掉，eTeam 应有
「吊销 + 事件 + 改派」的合成结果路径（已有 attempt.revoked），保持。

---

## 4. 压缩梯：阈值、主动/反应两路、熔断、错误扣留

阈值体系（`src/services/compact/autoCompact.ts` 与 context.ts 常量）：

- 有效窗口 = contextWindow − 20K（预留摘要输出）；
- autocompact 阈值 = 有效窗口 − 13K buffer；
- 警告 buffer 20K、错误 buffer 20K；手动 /compact 的阻塞 buffer 只有 3K——**给用户手动
  压缩留余量**；
- 「刚压缩完就跳过阻塞检查」——旧消息 usage 反映压缩前上下文，拿来估算会误判。

流程：

- **主动路**：每轮开头跑 §2 流水线，省够了不压；压缩成功后重建 `postCompactMessages`
  （摘要 + 附件 + hook 结果）作为新基线，重置追踪状态；
- **反应路**：真 413 到来才走 reactive compact——先试最便宜的 collapse 排水，不行再整段
  压缩，各**一次性**（`hasAttemptedReactiveCompact` 守卫防螺旋）；
- **熔断**：`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`，连续失败阻断下一轮重试（注释：
  BQ 数据显示过每天 25 万次浪费的 API 调用）；
- **错误扣留**：prompt-too-long / max-output-tokens 等「可恢复错误」先扣住不 yield，等恢复
  路径确定失败才放出来——SDK 消费者看到 error 就终止会话，恢复循环还在跑但没人听了；
- **预算结转**：task_budget 的 remaining 在每次压缩时扣掉「被压缩掉的最后一个完整上下文
  窗口」——压缩后服务端只见摘要，不结转会少算已花的钱。

**eTeam 对标**：压缩本体属宿主。eTeam 侧的自愈缺口：`wakeMember` 失败只 warn 后返回 false
（`notifier.ts:148`），连续失败无计数无熔断——04 清单 R-2。「错误扣留」的编排层含义：
**可恢复状态（wait、paused、待重试）不应立刻升级为用户可见的阻塞**，先走自动恢复梯——
eTeam 的重试阶梯（同成员立即重试 → 超限 wait_decision）已经对齐，保持。

---

## 5. 恢复梯：每类失败一条最便宜的恢复路径

一轮没有 tool_use 也不终止时，按顺序尝试（`query.ts` 恢复梯）：

1. **max_output_tokens**：先一次性升级——默认 8K 上限命中后直接以 64K 重发同一请求
   （不发任何提示语）。数值依据（claude.ts:3399 注释）：BQ p99 输出仅 4,911 token，32K/64K
   默认值超订 8–16 倍槽位容量，降到 8K 后命中率极低、命中的拿到一次干净升级。仍不行则
   最多 3 次续跑注入，文案逐字固定：
   > "Output token limit hit. Resume directly — no apology, no recap of what you were doing.
   > Pick up mid-thought if that is where the cut happened. Break remaining work into smaller
   > pieces."
2. **fallback 模型切换**：捕获 FallbackTriggeredError → 换模型重试整轮。三个细节：给每条
   tool_use 补合成 tool_result；剥掉 thinking 签名（签名与模型绑定）；向用户发 warning
   （可见的降级通知，循环继续）。
3. **stop hooks**：hook 阻断时错误拼进消息续跑，`stopHookActive` 防递归。两处防死亡螺旋
   的守卫（都在注释里记了事故）：
   - 最后一条消息是 API 错误时**跳过** stop hooks——错误 → hook 阻断 → 重试 → 错误 →
     hook 每圈注入更多 token → 死循环；
   - hook 阻断重入循环时**保留** `hasAttemptedReactiveCompact`——注释记载真实事故：
     重置为 false 会造成 compact → 仍超长 → 报错 → hook 阻断 → compact → … 烧掉几千次
     API 调用。
4. **token 预算续跑**：预算允许时注入 nudge（isMeta）；`BudgetTracker` 带边际收益递减检测。

**恢复设计的四条元原则**（从全部恢复路径蒸馏）：

- 循环推进所需的状态必须能从持久层重建（压缩后关键状态随附件重注入）；
- 恢复按成本递增排序，最便宜的先试；
- 每类一次性恢复路径配一次性守卫，**守卫旁写事故推演**（否则后人当冗余删掉）；
- 可恢复错误扣留到恢复失败才上抛。

**eTeam 对标**：eTeam 的重试阶梯（failTask：同成员立即重试 → 超限 wait_decision → 领队
改派/挂起/通知用户，`assignment.ts:1153` 附近）已是「成本递增」结构；缺三样——续跑指令
文案（只回显 `重试 x/y。上次失败：…`）、resumeTask 恢复路径不带上次进度、若干无守卫的
自锁环——04 清单 R-3/R-6。

---

## 6. 消息队列：优先级、轮中排水、按代理分账

`src/utils/messageQueueManager.ts`（模块级 `commandQueue`）：

- 优先级三级：`now: 0` > `next: 1` > `later: 2`；**用户输入默认 next，任务通知默认 later**——
  通知永远饿不死用户；
- 轮中排水：工具跑完取一次快照，转附件随下一轮上行；排水范围看本轮是否执行了 Sleep——
  执行了（说明在等待周期任务）只排 `later`，否则排 `next`；
- **斜杠命令不参与轮中排水**（必须走完整命令生命周期）；
- **按代理分账**：主线只收 `agentId === undefined` 的命令，子代理只收发给自己的任务通知，
  绝不见用户 prompt 流；
- UI 侧 `useSyncExternalStore` 冻结快照模式；队列操作日志落 session storage。

**eTeam 对标**：eTeam 的对应物是邮箱 + 唤醒（`notifier.ts`：邮件落库、提交后 best-effort
followup）。D15 口径「空闲即唤醒、执行中排队不打断」——执行中收到的成员对话框消息静默
排队，等下一次唤醒才可见，若无唤醒则滞留且无提示。队列模式的两个思想可迁：**搭车注入**
（执行中消息标记待搭车，随下次唤醒邮件尾部送达）与**优先级分级**（用户消息 > 成员私信 >
通知）——04 清单 R-8。

---

## 7. 旁路不阻塞主路：预取与小模型

- **预取（start early, consume if settled）**：记忆/技能检索在轮首异步发起，工具跑完若已
  settle 就消费，没 settle 零等待跳过、下一轮再试。注释：「预取有多少轮机会，取决于轮数」。
  绝不为附件阻塞主循环。
- **小模型异步摘要**：每批工具跑完用 Haiku 异步生成「工具使用摘要」，下一轮开头才 yield
  （主模型流式的 5–30s 里摘要早已算完）——展示层用便宜模型，不占主上下文。
- **周期任务摘要**：长会话周期性用小模型刷新「正在做什么」一句话（面板用），只在主线做。
- 内存教训：fetch 包装器每 query 只建一次——每次都建会各自闭包持有请求体，长会话积出
  ~500MB。

**eTeam 对标**：站点完成的小模型摘要（面板与完成邮件头部展示，失败不影响状态，记账归属
usage）——04 清单 R-9。「下一轮才消费」对应 eTeam 的邮箱语义（邮件本来就在下一轮送达），
同构，保持。

---

## 8. 小结：流程层能带走的六条

1. **具名转移与枚举终态**：可测性来自转移命名，不来自解析消息（eTeam 事件表已对齐）。
2. **裁剪按成本递增**：先 delta、先分类回收，最后才全量压缩；每层都可能让下一层 no-op。
3. **配对卫生**：任何异常路径都补全悬空的请求/响应对；修复必须字节确定（缓存）。
4. **恢复梯 + 一次性守卫 + 事故注释**：最便宜的先试，守卫写明理由，可恢复错误扣留上抛。
5. **队列有优先级、有分账、有轮中排水**：通知不饿死用户，消息随下一次轮次必然上行。
6. **旁路全部异步/搭车**：预取、摘要、排队消息宁可下一轮补上，不让主路等待。