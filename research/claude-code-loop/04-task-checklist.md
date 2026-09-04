# 04 任务与实施清单：eTeam 编排层整体优化

**这是本研究的最终交付**。基于对 Claude Code 源码（`C:\Users\epat\Downloads\Claude-Code-main`，
以 `src/query.ts` 为中心）三个主题的研究——提示词管理、流程管理、架构——对照 eTeam 编排
协议层（`src/host/`）的现状（核实于 2026-09-04 工作区），形成的可执行清单。

eTeam 的定位：DSH 插件，原始模型循环由宿主持有；eTeam 拥有的是循环之上的编排层（领队/
成员持续子代理、派发邮件与唤醒、任务状态机）。因此清单里每一条都是**编排协议层可落地**
的改动；依赖宿主内部能力的项单独列在附录 B，作为对 DSH 的输入，不是 eTeam 任务。

每条自带「现状 / 依据 / 动作 / 验收」，可单独开工。**每项开工按项目流程走
设计→审核→开发→验收子 agent 流程，设计与验收文档落 `docs/`。**

## 分期与等级

- **第一期（必要）**：不做会丢工作、静默滞留、烧钱或自锁的项。等级：
  - **P0** 协议正确性/自愈——状态不可恢复、消息不可送达、循环可自锁；
  - **P1** 上下文经济与恢复质量——直接决定每轮账单与领队决策质量。
- **第二期（优化）**：体验与成本改善（P2）。
- **附录 A（远期 P3）**：低频或深水区项，先记录不动工。
- **附录 B（宿主输入）**：不是 eTeam 任务。

工作量标记：S = 单文件小改（半天级）、M = 跨文件+测试（1–2 天级）、L = 结构性（2 天以上）。

---

# 第一期（必要）

## R-1 【P0 · M】attempt token 断点恢复

**现状**：成员上报（progress/complete/fail）要求 `attemptId + token`，token 只在
`eteams_claim_task` 返回里出现一次（`src/host/tools/memberTools.ts` claim 工具），而
claimTask 只接受 `pending_accept` 的尝试（`src/host/runtime/assignment.ts:948/988`）——
运行中（running）尝试不能重取。`eteams_task_board` 的视图（`memberTools.ts` boardTool）
不回传 token。成员子会话一旦被宿主压缩/截断/冷恢复丢掉 token，该 attempt 永久无人能上报，
只能等领队吊销改派——一条本可自愈的路变成人工流程。

**依据**（源码研究）：Claude Code 恢复梯的隐含原则是「循环推进所需的任何状态必须能从
持久层重建，恢复路径不能依赖模型还记得」——压缩后关键状态随附件重新注入。token 是成员
自己的凭证，回传不越权。

**动作**（二选一或都做，推荐都做）：
1. `eteams_task_board`（`memberTools.ts` boardTool）：对 assignee 本人，当前 `running`
   attempt 附 `attemptId + token`；
2. `eteams_claim_task` 幂等重入（`assignment.ts` claimTask）：对本人 `running` 且 token
   匹配失败/缺失时允许重新领取同一 attempt 并重发 token，发事件 `attempt.reclaimed` 留痕。

**验收**：
- 单元测试：模拟「token 丢失」后经 board 或重入 claim 取回 token，progress/complete 上报成功；
- 事件表出现 `attempt.reclaimed`；非本人/非 running 场景仍拒绝（不放宽安全边界）。

## R-2 【P0 · M】唤醒补投、投递状态与熔断

**现状**：`wakeMember` 失败只 `logger.warn` 后返回 false（`src/host/runtime/notifier.ts:141-158`
两处：领队不在线、followup 抛错）；`runWakes` 吞掉一切（`assignment.ts:89`）。成员子会话
只有被 followup 才产生新轮次——唤醒失败且领队不再对该成员派发时，邮件静默滞留；连续失败
无计数，`eteams_dispatch_captain` 每轮重复尝试刷日志。唤醒结果不进事件表，面板无法回答
「成员为什么没反应」。

**依据**（源码研究）：Claude Code 对每类失败都有「兜底 + 计数 + 熔断」三件套（合成结果保
配对、`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` 熔断器、`hasAttemptedReactiveCompact`
一次性守卫），且注释里留有事故推演。补投只是把「邮件本来就在下次唤醒随派发消息送达」的
既有语义显式化。

**动作**：
1. `mail_messages` 加投递状态列（`docs/27` 相应迁移）：`delivery_failed_at` / `failed_count`；
2. `wakeMember`/`runWakes`（`notifier.ts` / `assignment.ts`）：失败时标记邮件并
   `emit(tx, …, 'wake.failed', { target, mailSeq, 原因 })`，成功 `wake.sent`；
3. 补投：任一后续成功唤醒/派发该成员时，批量带上未达邮件（唤醒文本尾部附「未送达邮件
   N 条」）；
4. 熔断：同一目标连续 3 次唤醒失败后降级为「只落库 + 事件」，等面板/领队显式重试——守卫
   旁写注释说明（防失败风暴刷日志刷 token）。

**验收**：
- 单元测试：唤醒失败 → 邮件标记 + 事件；下次成功唤醒补投；连续 3 次失败触发熔断不再重复 followup；
- 面板成员行/邮箱行能看到投递状态（消费 `wake.sent`/`wake.failed` 事件）。

## R-3 【P0 · S】编排环守卫：婉拒环与决策期重复通知

**现状**：
1. `declineTask`（`assignment.ts:977`）把任务退回 ready、**不计 retryCount**——「领队改派
   回同一成员 → 婉拒 → 再改派回同一人」可无限循环；
2. 任务 `wait_decision` 未决期间，领队快照每轮重放同一封失败邮件（全量快照随派发重发，
   `captainDispatch.ts:167`），且新的失败报告可再次唤醒领队重放全文。

**依据**（源码研究）：Claude Code 用注释记录了两桩真实死亡螺旋（stop hooks × compact 烧
数千次 API 调用；API 错误上 hook 每圈注入更多 token），守卫全部是一次性计数型。eTeam 任务
级环已有多重守卫（重试上限→wait_decision、POISON 依赖集、`wouldCycle` 判环），编排层
这两处是漏网。

**动作**（`assignment.ts`）：
1. 婉拒去重：同一任务同一成员的婉拒记入去重集合（如 `task_members` 行或 DecisionRecord
   旁），改派回同一成员前领队工具结果里提示「该成员曾婉拒此任务（原因）」，或直接拒绝
   改派回婉拒者（领队显式覆盖需带理由）；
2. 决策期去重：`pendingDecisions` 存在未决记录时，同 taskId 的新失败通知只落库不唤醒
   （或首次唤醒后记 `notifiedAt`，同决策未决期间不再重复唤醒全文）；
3. 两处守卫均写事故推演注释。

**验收**：单元测试覆盖「婉拒→改派回同一人」第二次被拦；「wait_decision 未决 + 再次失败」
第二次只落库不 wake。

## R-4 【P1 · M】派发快照全量→增量（子会话缓存纪律）

**现状**：`eteams_dispatch_captain` 每次转交都把全量 `teamView` JSON 拼进 prompt
（`src/host/tools/captainDispatch.ts:167-173`）。快照虽已精简过一次（成员只带工号/角色/
状态、任务只带摘要、邮箱尾 5 条正文截 300 字，`teamOps.ts` teamView），但仍是**每轮全量
重发**：任务数、成员数线性增长，且每轮 JSON 都在变。领队子代理是持续会话——这些尾部大
JSON 正是每轮必付的非缓存输入。

**依据**（源码研究）：Claude Code 的缓存纪律是「追加到历史尾部的内容保持小且稳定」；大块
易变内容每轮重发既撑大未缓存尾部又因内容变化打爆缓存（01 文档 §8）。宿主对持续子会话的
缓存按追加前缀命中——增量、稳定尾部是编排层唯一能控制的经济杠杆。

**动作**（`captainDispatch.ts` + `teamOps.ts`）：
1. 首派发保留全量快照（建立上下文）；
2. 续聊轮改为增量：`【变化】自上轮以来：新任务 N、状态变更 M 条、未读邮件 K 封（摘要）`
   + 指向工作区文档（teams/<team>/ 的 README 与任务文件夹本就是落盘真相）；
3. 增量块需要「上轮已推送给领队的水位」——用持久层记领队子会话的 lastDispatchedSeq
   （events 或 team 状态）；
4. 全量对账低频化：每 N 轮一次或领队显式 `eteams_team_status`；
5. 增量块文本**字节稳定**（同状态不产生新字节；无变化时输出「无变化」）。

**验收**：
- 单元测试：连续两次派发，第二次 prompt 不含全量 JSON，长度不随任务数增长；
- 冷恢复路径（lineage 不符重建）自动回退全量快照；
- 增量水位持久化，重启后不重推已推内容。

## R-5 【P1 · S】completeTask 产出预算截断

**现状**：`eteams_complete_task` 的 `output` 只做 trim 与非空校验（`assignment.ts:1061-1066`），
长度不设限，全文进入完成邮件送达领队并随快照再次进入领队子会话上下文。成员规则里虽有
「产出同步写 notes.md」纪律，工具层不兜底。

**依据**（源码研究）：Claude Code 的 `applyToolResultBudget`——超限的工具结果在主上下文
替换为「摘要 + 引用」，全文存可恢复处；`maxResultSizeChars` 是**每工具**的预算（03 文档
§1）。领队邮箱是稀缺资源，全文属于文件系统。

**动作**（`assignment.ts` completeTask + `memberTools.ts` 工具描述）：
1. output 上限（建议 2000 字）：超出截断，邮件/事件 payload 里为截断文本 +
   `changedPaths` + 任务文件夹指针；
2. 校验 notes.md 已写入（或工具返回值提示「请将完整产出写入任务 notes.md」）；
3. 事件 payload 保留 `truncated: true` 标记。

**验收**：单元测试：超长 output → 邮件为截断 + 指针，attempt.result 全文仍落库（数据层
不丢）；notes.md 缺失时返回提示。

## R-6 【P1 · S】重试/恢复交接升级为续跑指令

**现状**：重试 handoff 只有计数与错误回显——`重试 x/y。上次失败：<error>`
（`assignment.ts:1176`）；`resumeTask`（`assignment.ts:822`）恢复 paused 任务时新尝试的
派发邮件只有合同与 stageBrief（872-878 行 sendAssignmentInTx 调用），不带上次进度；改派
路径有 `lastOutputOf`（assignment.ts:768）但恢复路径没有。

**依据**（源码研究）：Claude Code 的 max_output_tokens 续跑文案是精心调过的恢复提示：
"Resume directly — no apology, no recap … Pick up mid-thought … Break remaining work into
smaller pieces."；压缩摘要模板第 9 节要求**逐字引用最后的工作状态**防任务理解漂移
（01 文档 §5）。成员失败后的重试、挂起后的恢复本质上都是对同一上下文的续跑。

**动作**（`assignment.ts` + `prompts/handoff.ts`）：
1. 重试 handoff 追加续跑指令 + 最后一条 progress note（原文逐字）：
   `直接从上次断点继续——不要道歉、不要复述已做的事；从失败步骤接着做；把剩余工作拆小。`
2. `resumeTask` 的 sendAssignmentInTx 带 `lastOutputOf(task)` 或最后一条 progress note，
   与改派路径对齐；
3. 文案进 `handoff.ts` 统一维护（与 declineMail/reportMail 同处）。

**验收**：单元测试：重试邮件含续跑指令与最后 progress；resumeTask 派发邮件含上次产出。

---

# 第二期（优化）

## R-7 【P2 · S】成员看板视图瘦身

**现状**：`eteams_task_board` 对 `mine` 里每个任务都带全文 `renderContract(t)`
（`memberTools.ts` boardTool），多任务长会话下无界。
**依据**：每工具结果预算（03 文档 §1）——上下文稀缺，预算下放到最了解结果形状的层。
**动作**：当前任务（wait/start/paused）带全文合同，其余任务只带 subject/status/station
进度；需要全文用任务号查派发邮件或任务文件夹。
**验收**：任务数多时 board 输出长度有界；当前任务合同完整。

## R-8 【P2 · M】执行中对话消息搭车送达

**现状**：D15 口径「空闲即唤醒、执行中排队不打断」——成员执行中收到的对话框消息静默
排队，等成员下一次被唤醒（可能是很久后的领队续派）才可见；若无唤醒则滞留无提示。
**依据**：Claude Code 消息队列的「轮中排水 + 搭车注入 + 优先级」——用户输入默认 next、
任务通知默认 later（通知永远饿不死用户），排队消息随下一次轮次**必然**上行而不是依赖
一次不确定的独立唤醒（02 文档 §6）。
**动作**（`notifier.ts`/`teamOps.ts`/`assignment.ts`）：
1. 执行中成员的入站消息记「待搭车」标记（mail 表加列或 kind）；
2. 领队/系统对该成员的任何唤醒（续派/重试/通知）邮件尾部自动附「未读对话 K 条 + 摘要」；
3. 搭车排序：用户级消息 > 成员私信 > 系统通知；
4. 完全空闲成员维持「空闲即唤醒」不变。
**验收**：单元测试：执行中送达的消息在下次唤醒文本尾部可见；排序符合优先级；空闲路径不变。

## R-9 【P2 · M】站点/任务完成的小模型自动摘要

**现状**：领队「完成即续派」依赖成员手写 output；进度 notes 人工 ≤200 字；长产出时领队
要读全文才能决策。
**依据**：Claude Code 的小模型异步摘要模式——Haiku 生成展示摘要，下一轮才消费，不阻塞
主流程（02 文档 §7）；小模型调用走独立最小管线（03 文档 §5）。
**动作**：站点/任务完成事件落库后，异步用小模型对「output + notes.md 摘要」生成 ≤100 字
一句话摘要，作为 `task.stage_completed`/`task.completed` 事件 payload 的展示字段（面板与
完成邮件头部）；独立非流式小调用 + usage 记账归属该任务；生成失败不影响任何状态。
**验收**：完成事件 payload 带 summary 字段；摘要调用计入 usage；故障注入下主流程不受影响。

## R-10 【P2 · L】邮箱与事件分层回收

**现状**：`mail_messages` 与 `events` 只增不减；claim 时邮箱只取尾 5 条预览、快照尾 5 条，
全量数据永不回收，长周期团队扫描成本线性上升。
**依据**：Claude Code 的分层次序——最便宜先做（snip 直接删）、按类回收（microcompact 只
处理工具结果一类，`COMPACTABLE_TOOLS` 白名单）、最后整段摘要；回收边界持久化，恢复按
水位续读（02 文档 §2/§4）。
**动作**（分两步，先第一步）：
1. 已读且已被任务文档吸收的邮件（assignment/report，任务已 completed 且 notes.md 存在）
   归档为按任务聚合的一行摘要（按类回收，不动别的）；
2. events 表任务收口时聚合为一条 `task.timeline_summarized`，明细移归档表，聚合水位
   持久化，恢复路径按水位续读。
**验收**：归档后查询结果含聚合行；水位持久化、重启后不重复归档；未满足条件的邮件不动。

## R-11 【P2 · S】persona 增加回收自保条款（与 R-10 配对）

**现状**：成员/领队规则（MEMBER_RULES、领队手册）没有「旧邮件可能被归档」的说明。
**依据**：FRC 的配对设计——机制上线前系统提示先告知模型「旧工具结果会被清理，重要信息
当场写进自己的正文」（01 文档 §6）。只上机制会静默丢上下文，只上提示词是空话。
**动作**：persona 静态纪律加一条：「邮箱中较早的邮件可能被归档为摘要；收到邮件时重要
信息（合同要点、决策、路径）当场记入任务 notes.md」。与 R-10 同一迭代上线。
**验收**：persona 文案含条款；R-10 验收通过时成员侧无「摘要替代后找不到事实」的回归。

## R-12 【P2 · S】唤醒/派发投递状态面板化

**现状**：R-2 落地后事件表有 `wake.sent`/`wake.failed`/`mail.undelivered`，但面板未消费。
**动作**（`src/client/` teamsView）：成员行与邮箱行显示投递状态（未达条数、最后失败原因、
熔断状态）；手动「重试唤醒」按钮（显式解除熔断）。
**验收**：面板可见未达邮件并可手动重试；事件驱动（轮询可接受但以事件为准）。

## R-13 【P2 · M】任务/成员级用量汇总进视图

**现状**：`usage.jsonl` 火线记录已有（`src/host/runtime/usage.ts`），但任务/成员粒度的
汇总不进 board/快照，领队与面板都无法回答「这个任务花了多少」。
**依据**：Claude Code 的 task_budget remaining 跨压缩结转——用量可见性是决策输入；
`accumulateUsage` 把用量做成一等数据（03 文档 §5）。
**动作**：usage 聚合（按 taskId/member/attempt 周期聚合到 SQLite 汇总表），`eteams_task_board`
与领队快照带「本任务用量」行；面板任务行显示用量。
**验收**：汇总表与 jsonl 对账一致；board/快照/面板三处可见。

---

# 附录 A（远期 P3）

- **R-14 宿主压缩兜底契约**：把「token 可从看板取回（R-1 落地后）+ 合同随每次派发重发 +
  任务真相在 notes.md」写成对宿主子会话压缩的显式兜底契约（README 术语段），并在装机
  验证清单加一项：触发成员子会话压缩后 claim/上报仍可完成。若宿主保证不可得，退路是
  派发邮件尾注始终携带 attempt_id + token。
- **R-15 编排协议 deps 化**：参照 QueryDeps（callModel/microcompact/autocompact/uuid 四
  依赖注入）把 eTeam 的「唤醒/事件/时钟」抽成可注入 RuntimeDeps，编排协议测试摆脱
  SQLite fixture。重构量 L，收益在测试速度与覆盖。
- **R-16 工具 description 瘦身**：eTeam 工具 description 里混有使用纪律（常驻 API schema）；
  纪律挪 persona、description 只讲参数与用途，长会话省 token。需逐一过 8+ 个工具。

# 附录 B（对宿主 DSH 的输入，非 eTeam 任务）

按价值排序，源自 02/03 文档「不照搬清单」与 B 类分析：

1. **流式工具执行**：工具在模型流式生成期间开始执行（StreamingToolExecutor）——成员执行
   任务时的串行等待是 eTeam 观感慢的主要来源，此项对观感改善最大。
2. **错误扣留**：prompt-too-long/max-output-tokens 等可恢复错误在恢复路径确定失败后才
   上抛给插件——否则 eTeam 任何「见错误即终断」的消费者会误杀仍在恢复中的子会话。
3. **分层 compact + reactive compact**：子会话压缩后关键上下文重新注入的保证或钩子
   （R-14 的兜底即为此准备）。
4. **per-tool 结果预算**：宿主提供每工具 maxResultSizeChars 式预算，eTeam 的 board/status
   大结果自动受益。
5. **会话级 latch**：影响请求字节的配置（模型、beta、缓存 TTL 资格）在会话内锁存，中途
   翻转每次打爆 ~20K token 缓存。
6. **工具池排序**：内置工具连续前缀 + MCP 后接，保全局缓存断点命中。

---

# 实施顺序建议（第一期内部）

依赖与风险排序：先修自愈底座，再做经济项。

1. **R-2 唤醒补投**（底座：投递状态是 R-12/R-8 的地基）
2. **R-3 环守卫**（独立小改，先堵自锁）
3. **R-1 token 断点恢复**（依赖 R-2 的事件基建）
4. **R-6 续跑交接**（纯文案+参数，最快见效）
5. **R-5 产出截断**（配合 R-6 一起验证领队侧体感）
6. **R-4 增量快照**（最大单项收益，需水位持久化，最后做）

第二期按 R-11（随 R-10）→ R-7 → R-8 → R-9 → R-13 → R-12 顺序；R-10 可与 R-14 合并规划。

# 总原则（第一期全部项的共同纪律）

1. **配对卫生**：任何异常路径都要补全悬空的请求/响应对（token 握手 + R-1 断点恢复）。
2. **由廉价到昂贵**：先 delta、先按类回收，最后才全量；大对象落文件，上下文只放引用。
3. **恢复梯 + 守卫注释**：每类失败一条最便宜的恢复路径，一次性守卫防螺旋，守卫旁写事故
   推演。
4. **旁路不阻塞主路**：摘要、搭车、补投全部异步/随下次轮次，绝不为旁路等待主流程。