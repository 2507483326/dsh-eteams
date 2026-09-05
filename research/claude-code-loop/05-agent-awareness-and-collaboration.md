# 05 Agent 感知与协作：loop 中各 agent 如何感知彼此、如何协作

研究对象：`C:\Users\epat\Downloads\Claude-Code-main` 源码——AgentTool / runAgent /
SendMessageTool / teammateMailbox / attachments / LocalAgentTask / TeamCreateTool /
Task 工具族 / swarm（inProcessRunner、spawnMultiAgent、teammateInit）/ coordinator /
forkSubagent / agentSummary / resumeAgent / agentMemory。本文回答两个问题：**一个 agent
怎么知道别的 agent 存在、在干什么、知道什么**（感知），以及**它们之间通过什么机制分工、
交涉、回报**（协作）。每节末尾给 eTeam 对标（eTeam 现状以 2026-09-05 工作区为准）。

---

## 0. 总览：六面感知 × 四条协作通道

Claude Code 里参与 loop 的「agent」有五类：主循环（用户对话者）、**fork 子代理**（继承
全部上下文的影子分身）、**普通子代理**（零上下文的临时工）、**async/后台子代理**（同前者
但异步跑，产出经通知回投）、**队员 teammate**（长驻独立会话，tmux 或进程内）+ **协调者
模式**（主循环专职协调、干活全外包给 worker）。

它们的互相感知拆成六个面；协作走四条通道：

| 感知面 | 问的问题 | 载体 |
|---|---|---|
| ① 花名册 | 谁存在？ | 工具提示词/附件里的 agent 类型表；团队 config.json 文件；ListPeers |
| ② 身份与能力 | 我是谁？我能做什么/对方能做什么？ | team_context 附件（队员）、persona、工具 deny 列表、协调者上下文里的 worker 工具清单 |
| ③ 任务上下文 | 对方知道什么？ | fork 全量继承 vs 新子代理零上下文 + 人工简报；恢复时从盘上 transcript 重建 |
| ④ 消息/信箱 | 对方对我说了什么？ | 文件信箱（队员）+ 每轮 attachment 送达；运行中子代理的 pendingMessages 轮中排水 |
| ⑤ 结果与通知 | 对方做完了吗？结果呢？ | 同步=工具结果；异步=`<task-notification>` 信封（user 角色消息）；输出文件 Read |
| ⑥ 进度 | 对方现在干什么？ | AgentProgress 计数、30s fork 摘要、空闲通知（含 peer DM 摘要） |

| 协作通道 | 语义 | 机制 |
|---|---|---|
| A. 派生与简报 | 我→它：给它任务 | AgentTool（fork/async/sync/teammate 四路）+ 自包含 prompt |
| B. 消息 | 双向：任意时点通信 | SendMessage（按名路由、运行中排队、停止者自动复活） |
| C. 任务列表 | 共享黑板：认领/依赖 | TaskCreate/TaskUpdate + 文件锁原子认领 + blocks/blockedBy |
| D. 结构化协议 | 系统级交涉：关停/计划审批 | JSON 协议消息（shutdown_request / plan_approval_request） |

贯穿一切的三条铁律（反复出现在提示词与注释里）：
1. **纯文本输出对其他 agent 不可见**——要通信必须调 SendMessage；要回报必须走通知/工具结果。
2. **结果以 user 角色消息回流**——通知不是 agent 写的，是 harness 投递的；模型被反复叮嘱
   「never fabricate or predict agent results」。
3. **感知有成本**——每一条感知信息（花名册、环境、上下文）都要么进缓存前缀，要么按需
   注入，绝不常驻易变区。

---

## 1. 感知面①：花名册——「存在谁」

### 1.1 agent 类型表：先在提示词里，太大就挪附件

`AgentTool/prompt.ts` 的 getPrompt() 把**可选的 agent 类型清单**直接拼进工具提示词：
`- type: whenToUse (Tools: ...)` 一行一个。但这是**有意的权衡**：清单会随 MCP 连接、
插件加载、权限配置变化，而工具 schema 是全局缓存断点的锚——动态清单曾占整个机队
cache_creation token 的 10.2%。所以当清单超过阈值时改为 `agent_listing_delta` 附件
（进消息流、不进 schema），附件方案省下的就是这 10.2%。

类型表里每项都带 **whenToUse（何时选它）+ Tools（它能用什么）**——即「感知对方」的
最小充分集是「何时该找它」+「它会不会用工具」。builtInAgents.ts 里内置 general-purpose、
statusline-setup、Explore/Plan（gated）、claude-code-guide、verification；fork 与
coordinator 的 worker 类型不在清单里（fork 明确标注 "Not selectable via subagent_type"）。

### 1.2 团队花名册：文件即真相，指针即感知

团队队员互相感知的方式**不是**注入名单，而是**指路**：

- `team_context` 附件（仅队员、仅首轮注入，见 §2.1）只给两个路径：config.json 与任务
  列表目录，附一句 "Read the team config to discover your teammates' names"；
- `TeamCreateTool/prompt.ts` 给领队同样的指引：config.json 的 members 数组里有每个
  队员的 name（**通信与任务归属一律用 name，UUID 仅供参考**）；
- 跨会话目标（UDS socket / Remote Control bridge）用 ListPeers 工具发现，prompt 里
  承诺「列出的 peer 活着且会处理消息，没有 busy 状态——消息排队、在接收方下一轮排空」。

**文件即花名册**的好处：roster 变化零 token 成本（不进提示词），且 spawn/退出的写路径
天然一致（teamFile.members.push → writeTeamFileAsync，`spawnMultiAgent.ts:995`）。

**eTeam 对标**：eTeam 的花名册走的是「领队每轮快照带成员表（工号/角色/状态）+ 成员 persona
带班底手册」（`teamOps.ts` teamView / roster personaMd）。方向与 CC 相反——CC 把 roster
从常驻提示词挪到了按需文件；eTeam 把 roster 常驻在每轮快照里（正是 04 清单 R-4 要瘦身的
对象）。可借鉴：**成员状态增量**（新入职/退出/状态变化才提）+ **真相指向**（eTeam 已有
teams/<team>/ 落盘文档，快照里给路径即可）。通信按名不按 UUID 这一点 eTeam 已对齐
（成员按 name 唤醒，`notifier.ts` findInstanceRow）。

---

## 2. 感知面②：身份与能力——「我是谁、谁能干什么」

### 2.1 队员的身份注入：首轮 team_context 附件

`utils/attachments.ts:3797` getTeamContextAttachment：只在**没有任何 assistant 消息时**
注入一次，内容是 `<system-reminder>` 包裹的身份卡：

> You are a teammate in team "{team}". **Your Identity:** Name: {agentName}.
> **Team Resources:** Team config: {path}, Task list: {path}.
> **Team Leader:** The team lead's name is "team-lead". Send updates and completion
> notifications to them.

配合 `TEAMMATE_SYSTEM_PROMPT_ADDENDUM`（追加到队员系统提示尾部，`main.tsx:1392`）：

> You are running as an agent in a team. To communicate with anyone on your team:
> Use SendMessage with `to: "<name>"` … broadcasts sparingly.
> **Just writing a response in text is not visible to others on your team — you MUST
> use the SendMessage tool.** The user interacts primarily with the team lead.

身份感知的三件套：**我叫什么**（addressing 的键）、**资源在哪**（花名册与任务列表的
指针）、**对谁负责**（lead 名字）。全部首轮一次性注入，之后不再重复。

### 2.2 能力感知：deny 列表划定的协作拓扑

`constants/tools.ts` 的 `ALL_AGENT_DISALLOWED_TOOLS` 是一张**拓扑声明**：子代理拿不到
TaskOutput、EnterPlanMode/ExitPlanMode、**AskUserQuestion**、TaskStop、Agent（ant 用户
除外）、Workflow。含义：

- 子代理**不能直接问用户**——有疑问只能写进报告让父循环转达；
- 子代理**不能再派子代理**（默认）——递归扇出被堵在类型层；
- 子代理**不能管理别的 agent**（TaskStop/TaskOutput）——只有父循环是管理者。

`ASYNC_AGENT_ALLOWED_TOOLS` 则是 async agent 的白名单（Read/Grep/Glob/Bash 族/Edit/
Write/Skill/EnterWorktree…）。领队感知 worker 能力的方式是**协调者上下文里直接给清单**：
`getCoordinatorUserContext`（`coordinatorMode.ts:120`）把 worker 可用工具排序列出，
MCP 服务器另起一行——领队不猜 worker 会什么。

### 2.3 领队手册：TeamCreate prompt 的行为规约

`TeamCreateTool/prompt.ts` 是领队的协作手册，要点全部围绕感知纪律：

- **通信可达性**：「Your team cannot hear you if you do not use the SendMessage tool」
  「Do not use terminal tools to view your team's activity」——感知队友状态的正确通道是
  消息与任务列表，不是偷看终端；
- **禁止伪协议**：「Do NOT send structured JSON status messages like {"type":"idle"}」
  ——状态归 TaskUpdate，人话归 SendMessage，两轨不混；
- **空闲语义教学**：「A teammate going idle immediately after sending you a message does
  NOT mean they are done or unavailable. Idle simply means they are waiting for input」
  「Be patient with idle teammates! Don't comment on their idleness until it actually
  impacts your work」——把「空闲通知会刷屏」这件事提前教给领队，防止领队把每个空闲
  通知当事件回应（回应本身就是新一轮 token）；
- **peer DM 摘要**：队友 A 给队友 B 发私信后，A 的空闲通知里带一句 DM 摘要——领队对
  平级协作**有可见性、无内容**（informational，明确说「不需要回应」）。

**eTeam 对标**：身份注入 eTeam 已有等价物——成员 persona 的身份段与「领队即用户对话者、
成员通过邮件上报」的规则（MEMBER_RULES）。三处可对齐：
1. eTeam 成员**没有 AskUserQuestion 通道**（与 CC 子代理一致），但成员规则里没有显式
   「有疑问写进 progress note 让领队转达」的指引——可补一句；
2. eTeam 没有伪协议问题（上报走工具不走自由文本，结构更强），保持；
3. 「空闲≠完成」的教学对应 eTeam 的 D15 口径文档化——成员规则里值得写明「领队未续派
   不代表失联，等待即空闲」，防止成员空转补发重复汇报。

---

## 3. 感知面③：任务上下文——「对方知道什么」

### 3.1 两种极端：fork 全继承 vs 新代理零上下文

- **fork**（`forkSubagent.ts`）：子代理的对话 = 父会话完整历史 + 父最后一条 assistant
  消息（全部 tool_use 保留）+ 一条 user 消息（所有 tool_use 配占位结果
  "Fork started — processing in background" + 本孩子专属指令文本）。占位结果对所有 fork
  孩子**逐字节相同**——只有最后的指令块每个孩子不同，缓存前缀因此最大化共享。父的
  tool_use 还没执行完，孩子们看到的「结果」是占位符，各自的指令告诉它该关注什么。
- **新子代理/队员**：**零上下文**。spawnMultiAgent 注释明说 in-process teammate 拿到的
  toolUseContext.messages 被显式清空：「Passing the parent's full conversation here would
  pin it for the teammate's lifetime, surviving /clear and auto-compact」——队员永远自己
  从 prompt 与消息流构建历史，绝不背父会话的包袱。

于是感知责任全在**简报质量**上。AgentTool prompt 里的简报纪律（§"Writing the prompt"）：
「Brief the agent like a smart colleague who just walked into the room」——要做什么、
为什么、已试过什么排除了什么、判断空间在哪，外加响应长度契约（"report in under 200
words"）。协调者手册把它推到极致（`coordinatorMode.ts` §5）：

> **Workers can't see your conversation.** Every prompt must be self-contained.
> **Always synthesize — your most important job.** Never write "based on your findings"
> or "based on the research." These phrases delegate understanding to the worker instead
> of doing it yourself. A well-synthesized spec proves you understood by including
> specific file paths, line numbers, and exactly what to change.

反例清单给得很具体：`"Fix the bug we discussed"`（对方看不见你的对话）、
`"Something went wrong with the tests, can you look?"`（无错误信息无路径无方向）。

### 3.2 继续对话 = 恢复感知：从盘上 transcript 重建

SendMessage 给已停止的 agent 续聊时（`resumeAgent.ts`）：

- 从 `getAgentTranscript(agentId)` 读盘上 transcript，**三道清洗**：filterUnresolvedToolUses
  （补不齐配对的 tool_use 滤掉）、filterOrphanedThinkingOnlyMessages、
  filterWhitespaceOnlyAssistantMessages——恢复的上下文必须是合法可重放的；
- `reconstructForSubagentResume` 重建 contentReplacementState（工具结果替换记录也随盘
  恢复——被替换过的结果恢复后仍然是被替换后的样子）；
- worktree 路径从 metadata 读回，stat 不存在则回退父 cwd 不崩；复活时 bump mtime 防
  stale 清理误删（`#22355`）；
- fork 恢复特殊处理：重算父系统提示保缓存前缀一致，`forkContextMessages: undefined`
  （transcript 已含父上下文切片，再供给会重复 tool_use ID）；
- agentId 不变、name registry 不重写——**对父循环而言，这个 agent 还是同一个地址**。

### 3.3 运行中追加上下文：pendingMessages 轮中排水

给**运行中**的 async agent 发消息：SendMessage → `queuePendingMessage`（追加进 task 的
pendingMessages 数组）→ 该 agent 下一轮工具间隙由 `getAgentPendingMessageAttachments`
（`attachments.ts:1087`）排水，转成 `queued_command` 附件（origin: coordinator，isMeta）
注入。注释一句话概括设计：**「queued mid-turn via SendMessage, drained at tool-round
boundaries」**——不打断当前轮，但保证下一轮必然可见。

**eTeam 对标**：eTeam 的对应物是「成员子会话 + 派发邮件合同 + followup 增量」。
1. **合同即简报**：eTeam 派发邮件（handoff.ts assignment）本身就是自包含合同+stageBrief，
   与「self-contained prompt」同构，保持；改进点在 R-6——重试/恢复路径缺「上次做到哪」
   的逐字交接，正是「Workers can't see your conversation」教训的镜像：**不只首派发要
   自包含，每一次交接（重试、恢复、改派）都要重新自包含**；
2. **运行中排队**：D15「执行中排队不打断」与 pendingMessages 语义一致，但 eTeam 缺
   「排水保证」——CC 的排队消息随**下一轮工具间隙必然上行**，eTeam 的排队消息要等
   一次不确定的唤醒（04 清单 R-8 搭车即补此洞）；
3. **resume 重建**：eTeam 的冷恢复（lineage 不符重建领队子会话）对应「从盘上 transcript
   重建」，eTeam 的持久层（任务/邮件/事件）已具备，R-4 的水位持久化是同一思想。

---

## 4. 感知面④：消息与信箱——异步协作的底座

### 4.1 队员信箱：文件 + 锁 + 读标记

每队员一个收件箱文件 `~/.claude/teams/{team}/inboxes/{agent_name}.json`，
TeammateMessage = {from, text, timestamp, read, color?, summary?}，锁文件 10 次重试
（5–100ms 退避）。写入方（SendMessage、空闲通知 hook）与读取方（attachments 每轮）以
文件为唯一事实源。

**送达语义**（这是对 eTeam 最有参考价值的一段，`attachments.ts:3532` 起）：

- 每轮组装附件时读未读 → 包成 `teammate_mailbox` 附件（normalizeAttachmentForAPI 把
  多条消息 formatTeammateMessages 成**一条** isMeta user 消息）；
- **结构化协议消息（permission/shutdown）故意不进附件**——留给 useInboxPoller 的 UI
  路由弹卡。注释把竞态写明：「attachment generation races the poller — whoever reads
  first marks read」；附件侧先构建**再**标已读（build-before-mark，无丢失窗口）；
- **去重**：同一封邮件可能同时出现在文件信箱与 AppState.inbox（poller 从文件搬进内存
  的中转），两源合并按 `from|timestamp|text前100` 键去重（`attachments.ts:3631`）；
- **空闲通知塌缩**：同一 agent 的多条 available 通知塌成最新一条，防刷屏；
- **账目隔离**：AppState.inbox 只装「发给领队的」——进程内队员与领队共享 AppState，
  侧写注释明说「Skip it to prevent leakage (including self-echo from broadcasts).
  Teammates receive messages exclusively through their file-based mailbox」。

### 4.2 进程内队员的主循环：等待、轮询、优先关停

`inProcessRunner.ts:680` waitForNextPromptOrShutdown：队员每轮结束后进入 500ms 信箱轮询
循环，处理顺序**关停请求优先于普通消息**（防「消息洪水饿死关停」）。普通消息逐条成为
新 prompt；无消息就一直活着（idle）。空闲通知（available/interrupted/failed）发给领队
并做重复抑制。领队侧 useInboxPoller 把文件信箱新邮件搬进 AppState.inbox（pending 状态），
随领队下一轮附件上行。

### 4.3 通信礼仪（prompt 层的感知纪律）

SendMessage prompt 的核心句：「Your plain text output is NOT visible to other agents —
to communicate, you MUST call this tool. Messages from teammates are delivered
automatically; you don't check an inbox. Refer to teammates by name, never by UUID.
When relaying, don't quote the original — it's already rendered to the user.」

广播 `to: "*"` 被标注 "expensive (linear in team size), use only when everyone genuinely
needs it"——广播成本写进工具提示词，让模型自己权衡。

**eTeam 对标**：eTeam 的 mail_messages 表 + 每轮 claim 时邮箱尾 5 条预览 + 唤醒携带，
与「文件信箱 + 下一轮 attachment」同构（eTeam 的 DB 落库比 CC 的 JSON 文件更持久）。
逐条对标：
1. **读标分离**：CC 附件侧 build-before-mark + 协议消息留 poller；eTeam 的 readMailbox
   读取即返回、无独立已读位（mail 表无 read 列）——「成员看过没有」目前不可判定，R-2
   的投递状态列可顺带补；
2. **两源去重**：eTeam 的对应风险是「邮件落库 + 唤醒文本内嵌同一内容」的重复注入
   （claim 预览与派发邮件都带同文）——目前靠各自截断缓冲，长期值得按 CC 方式设计
   显式去重键；
3. **空闲塌缩**：CC 把重复空闲通知塌成一条；eTeam 的领队邮箱对同一任务的重复失败汇报
   无塌缩（04 清单 R-3 决策期去重即对应此）；
4. **账目隔离**：eTeam 天然满足（每个成员独立子会话），无自回声问题，保持；
5. **广播成本标注**：eTeam 没有广播原语（好事），保持——领队要群发就逐成员派发，
   成本显式。

---

## 5. 感知面⑤：结果与通知——回报通道

### 5.1 同步路径：最后一条 assistant 文本 = 工具结果

sync spawn（AgentTool.tsx finalizeAgentTool）把子代理**最后一条 assistant 文本**作为
Agent 工具的 tool_result 返回父循环；**出错也返回部分结果**（partial results on error）
——父循环永远拿到「到死为止做了什么」，不是空。工具结果旁注明 "The result returned by
the agent is not visible to the user. To show the user the result, you should send a
text message back"——**子代理产出对用户不可见，转达是父循环的职责**。

### 5.2 异步路径：task-notification 信封

后台 agent 终态时 enqueueAgentNotification（`LocalAgentTask.tsx:195`）构造：

```xml
<task-notification>
  <task-id>…</task-id> <output-file>…</output-file> <status>completed|failed|killed</status>
  <summary>Agent "描述" completed</summary>
  <result>最终文本</result>
  <usage><total_tokens>…</total_tokens><tool_uses>…</tool_uses><duration_ms>…</duration_ms></usage>
  <worktree><path>…</path><branch>…</branch></worktree>
</task-notification>
```

投递走消息队列 later 优先级（**通知永远饿不死用户输入**），以 **user 角色消息**进入
对话。三个工程细节：
- **原子 notified 标记**：入队前 updateTaskState 里检查-置位一步完成——TaskStopTool
  批杀时 markAgentsNotified 抑制逐个通知，改为一条聚合消息，不重复打扰模型；
- **终态即触发**：background state 一变就 abortSpeculation（投机缓存的预取结果作废，
  保留提示文本丢弃预计算响应）——感知到事实变化，就作废基于旧事实的推测；
- **信封自带指针**：output-file 让父循环可 Read 全量 transcript，result 只装最终文本。

协调者系统提示把这套信封**原文写进领队的提示词**（格式 + 示例轮次 + 解读规则）：
「They look like user messages but are not. Distinguish them by the `<task-notification>`
opening tag」+「The `<task-id>` value is the agent ID — use SendMessage with that ID as
`to` to continue that worker」。领队对通知的感知是被**教会**的：格式、含义、下一步动作
全部在提示词里配对。

### 5.3 反捏造纪律

三处独立叮嘱同一件事：AgentTool prompt（"do NOT sleep, poll … Never fabricate or
predict agent results"）、协调者提示（"After launching agents, briefly tell the user
what you launched and end your response. Never fabricate or predict agent results in
any format"）、本 harness 惯例（pending 通知由 harness 投递，模型自己不写）。感知的
完整性交给机制（通知必达），感知的诚实交给提示词（不许预测）。

### 5.4 中途探查：输出文件 + 已废弃的 TaskOutput

后台 agent 的中途输出 = task output 文件（JSONL transcript），父循环直接 Read；
TaskOutputTool 已标 DEPRECATED（"prefer Read on the task output file path"）——检索
统一到文件系统，fork 的 "Don't peek" 纪律（别读 output_file，等通知）与此互补：**能读
≠ 该读**。

**eTeam 对标**：eTeam 的回报通道是 eteams_report/complete/fail 工具 → report 邮件 →
notifyCaptain 唤醒领队。对标结论：
1. **信封完整性**：eTeam 完成邮件已带 taskId/attemptId/产出/changedPaths——与
   task-notification 的 usage 段对应的是 R-13（用量进视图）；CC 把 usage 直接写进通知
   信封值得抄——**回报自带成本数据，领队不用另查**；
2. **原子去重**：eTeam 的 report 无 notified 式防重（同 attempt 双上报靠 token 幂等兜）
   ——token 幂等已覆盖，保持；R-3 的决策期去重补的是领队侧重复唤醒；
3. **反捏造**：eTeam 的 dispatchAck 已教领队「原样展示，不要复述全文」，同向；可加
   「未收到上报前不得向用户断言任务进展」一句进领队手册；
4. **文件指针**：CC 的 output-file 模式 = eTeam 的 notes.md/任务文件夹，已对齐，保持。

---

## 6. 感知面⑥：进度——不打扰的观察

三层从轻到重：

1. **计数快照**：AgentProgress {toolCount, tokenCount…}，LocalAgentTask 记
   lastReportedToolCount/lastReportedTokenCount 算增量——面板数字，不进模型上下文。
2. **30s fork 摘要**（`services/AgentSummary/agentSummary.ts`）：每 30 秒 fork 一份
   worker 的对话，让同一个模型生成「3–5 词现在进行时」摘要（"Reading runAgent.ts"）
   供协调者面板。三条缓存级细节：
   - 工具**保留在请求里但用 canUseTool 全部拒绝**——注释明说传 tools:[] 会打爆缓存；
   - **不设 maxOutputTokens**——clamp 会改 thinking 配置，缓存键失配；
   - forkContextMessages 每 tick 从 transcript 重建，不闭包钉死（会泄漏整段历史）。
   摘要 prompt 自带好坏示例 + `Previous: "…" — say something NEW`（防重复摘要）。
3. **空闲通知**：队员 Stop hook（teammateInit）→ setMemberActive(false) + 信箱投递
   {idleReason: 'available', summary: getLastPeerDmSummary(messages)}——**摘要取最后
   一条 peer DM**，让领队对平级协作有最小可见性。

**eTeam 对标**：eTeam 的进度感知全靠成员手写 progress note（≤200 字），无自动层。CC 的
30s fork 摘要模式是 04 清单 R-9（小模型自动摘要）的直接模板——且其三条缓存纪律（小
调用保留工具集、不动输出上限、消息每 tick 重建）正是 R-9 实现时要抄的细节。peer DM
摘要对应 eTeam 成员间私信（若有）的领队可见性——eTeam 目前私信必经领队转达，无平级
直连，感知面更简单，保持。

---

## 7. 协作协议A：共享任务列表——无消息协调

团队与任务列表 1:1（Team = TaskList，`~/.claude/tasks/{team}/`）。task = {subject,
description, activeForm, status(pending/in_progress/completed), **owner(agent ID)**,
**blocks[], blockedBy[]**(任务 ID), metadata}。

协作语义（`utils/tasks.ts` + TeamCreate prompt）：

- **认领即原子事务**：claimTask 文件锁下「检查 owner 未被占 + busy 检查（自己名下还有
  未结任务就不给领新）+ 写 owner」一步完成，失败返回 'already_claimed' 或 'blocked'
  （附 blockedByTasks 清单——**拒绝的理由带着数据**，模型可直接回应）；
- **依赖图驱动认领**：blocked 的任务领不了；完成时 deleteTask 级联清引用；
- **认领纪律写进提示词**：「Prefer tasks in ID order (lowest ID first) when multiple
  tasks are available, as earlier tasks often set up context for later ones」——低 ID
  优先 = 上下文铺设顺序；
- **完成后强制再看板**：「Check TaskList periodically, **especially after completing
  each task**, to find available work or see newly unblocked tasks」——空闲队员的自取
  食物路径；
- **全被堵时的升级路径**：「If all available tasks are blocked, notify the team lead or
  help resolve blocking tasks」；
- **TaskCreated hook 可否决**创建（与 SubagentStart/Stop hook 同一族）。

**eTeam 对标**：eTeam 的任务认领是 attempt token 握手（board → claim → pending_accept →
start），语义上 = owner 认领 + busy 检查，**且 eTeam 更强**：token 是认领凭证、有重试
阶梯与吊销。可借鉴两条：
1. **拒绝理由带数据**：eTeam claim 失败目前只报状态；CC 的 'blocked' 附 blockedByTasks
   ——成员拿到拒绝后能自己判断要不要等，省一轮往返；
2. **busy 检查**：CC 不让同一 agent 领第二份活；eTeam 已由「一人一活跃 attempt」保证，
   保持。

---

## 8. 协作协议B：结构化协议与停止/复活

- **shutdown_request / shutdown_response**：只有领队可发起（prompt 明说 "Don't
  originate shutdown_request unless asked"），响应必须发回 team-lead，拒绝必须带 reason，
  批准后自 abort（进程内）或 gracefulShutdown（tmux）——关停是一等协议而非 kill；
- **plan_approval_request / response**：只有领队有审批权，批准携带 permissionMode
  继承——计划模式下队员干活前领队把关；
- **停止 ≠ 销毁**：TaskStopTool 停掉的 worker 可以 SendMessage 复活（stopped agents
  auto-resume from disk transcript）——协调者手册的「用户改需求」流程就是 stop →
  修正指令 → 复活，**上下文不丢**；
- **结构化消息不可广播、不可跨会话**——协议消息只走点对点，广播里混协议会被路由拒绝。

**eTeam 对标**：eTeam 的对应物是 wait_decision（成员请示 → 领队决策 → 决议邮件回投），
即 plan_approval 的同构物；关停对应吊销 attempt/移除成员。可借鉴「**拒绝必须带
reason**」——eTeam 的 declineTask 已带 reason 传回派发方，保持；决议邮件里显式带
permissionMode 式的授权变化（如「本次重试允许改 schema」）是可选增强。

---

## 9. 协作协议C：继续 vs 新建——上下文重叠决策表

协调者手册 §5 的决策表（对 eTeam 的续派/重建决策直接可用）：

| 情形 | 机制 | 理由 |
|---|---|---|
| 研究探索的正是要改的文件 | **继续**（SendMessage） | 文件已在上下文，补个明确计划即可 |
| 研究面广、实现面窄 | **新建** | 别拖着一堆探索噪音进实现 |
| 纠错或延伸刚做的事 | **继续** | 错误上下文和刚试过的路都在 |
| 验证别人刚写的代码 | **新建** | 验证者要「fresh eyes」，不带实现者的假设 |
| 首次实现方向全错 | **新建** | 错误方向会锚定重试，清白上下文更好 |
| 完全无关的新任务 | **新建** | 无可复用 |

配套原则：「High overlap → continue. Low overlap → spawn fresh. There is no universal
default.」以及反捏造、别用一个 worker 去盯另一个 worker（"Workers will notify you
when they are done"）。

**eTeam 对标**：eTeam 的 followup-first-then-rebuild（`captainDispatch.ts` 续聊优先、
lineage 不符才重建）就是「continue vs spawn fresh」的实现——但决策目前是**技术条件**
（会话是否活着）而非**语义条件**（上下文是否重叠）。CC 决策表给了语义维度：成员刚
失败的同类重试应 followup（错误上下文在），方向全错的重试应 rebuild（防锚定）。这可以
写进领队手册作为续派指导。

---

## 10. 感知经济：每一条感知都有账单

把全文出现的感知成本纪律集中一列：

1. **花名册出提示词**（10.2% cache_creation 的教训——agent_listing_delta 附件）；
2. **只读子代理不带 CLAUDE.md**（~5–15 Gtok/周）、Explore/Plan 不带 gitStatus（stale
   40KB 死重）——**感知裁剪按 agent 角色定制**；
3. **正常子代理关 thinking**（成本），fork 保留（缓存前缀一致性）；
4. **队员 roster 不进提示词**，给 config.json 路径自己读；
5. **fork 占位结果逐字节一致**、摘要 fork 保留工具 schema 拒绝调用——**观察者不能
   打爆被观察者的缓存**；
6. **队列优先级**：通知 later、用户 next——感知事件永不挤占主对话；
7. **空闲通知塌缩 + 原子 notified 标记**——同一事实不重复进入模型上下文。

**eTeam 对标**：eTeam 的感知经济现状与差距都已在 04 清单（R-4 增量快照、R-7 board 瘦身、
R-3 决策期去重、R-8 搭车）；本节新增一条可直接落地的：**领队手册教「空闲≠失联、通知
不用逐条回应」**（§2.3 的教学句式），与 R-3/R-8 配对——机制塌缩 + 提示词教学，两件套。

---

## 11. 蒸馏：给 eTeam 的协作层设计原则

1. **可达性先于一切**：每个 agent 第一课是「纯文本不可见」——eTeam 的成员规则已有
   「产出走 eteams_* 工具」，同向；补齐「有疑问写进上报，别等领队来问」。
2. **自包含是每次交接的义务，不是首派的特权**：重试、恢复、改派都要重新自包含
   （R-6）；「based on your findings」式转达是反模式（Never delegate understanding）。
3. **拒绝要带数据**：claim blocked 带 blockedBy、busy 带名下任务——被拒者能自决策。
4. **回报是信封，不是转述**：终态通知带 id/状态/摘要/用量/文件指针，原子去重；
   领队手册教会领队解读信封并禁止预测。
5. **观察不打扰**：进度感知走旁路（计数/fork 摘要），缓存纪律是观察者的义务。
6. **继续 vs 新建看上下文重叠**：技术存活条件之外补语义条件（错向重试要 rebuild）。
7. **感知有账单**：名单、环境、上下文各自有注入策略；重复事实要塌缩；协议消息与
   普通消息分轨。
8. **文件即真相，指针即感知**：roster、任务、产出都在盘上，上下文里只放路径与增量。