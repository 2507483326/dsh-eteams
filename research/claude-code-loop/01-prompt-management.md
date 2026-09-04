# 01 提示词管理：Claude Code 如何组装、缓存、注入与回收提示词

研究对象：`C:\Users\epat\Downloads\Claude-Code-main` 源码。本文回答：一个生产级 agent 的
提示词体系是怎么组织的——系统提示由哪些部分构成、怎么在长会话里保住 prompt cache、
环境上下文在哪里注入、压缩提示词怎么写、提示词与压缩机制怎么配对。每节末尾给 eTeam 的
对标（eTeam 现状以 2026-09-04 工作区为准）。

---

## 1. 系统提示 = 分节数组 + 静态/动态边界

`src/constants/prompts.ts` 的 `getSystemPrompt()` 返回 **字符串数组**，不是一整段：

```
[ 静态节……                     ← 可跨会话缓存
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY   ← 边界标记（一行哨兵字符串）
  动态节…… ]                   ← 会话相关，不进全局缓存
```

静态节固定顺序：intro（身份与安全）→ System → Doing tasks → Executing actions with care →
Using your tools → Tone and style → Output efficiency。动态节按序：
session_guidance → memory → env_info → language → output_style → mcp_instructions →
scratchpad → frc → summarize_tool_results。

两个关键设计：

- **边界是为缓存服务的**。`src/utils/api.ts` 的 `splitSysPromptPrefix` 按边界切开：边界前的
  块打 `cacheScope: 'global'`（跨组织可共享缓存），边界后 `null`（不缓存）。prompts.ts 里
  有显式警告：移动边界必须同步两处缓存逻辑。
- **会话相关的条件项必须放边界后**。prompts.ts 注释原话：边界前的每个运行时条件都会让
  全局前缀哈希的变体数翻倍（2^N 缓存变体 bug，PR #24490/#24171 踩过）。所以「是否启用
  fork 子代理」「是否有 skills」这类按会话变化的段落全部排在边界之后。

### 分节注册表（68 行的小机器）

`src/constants/systemPromptSections.ts`：

- `systemPromptSection(name, compute)` — **每会话记忆化**：算一次，缓存在 bootstrap state，
  `/clear` 与 `/compact` 时清空重算；
- `DANGEROUS_uncachedSystemPromptSection(name, compute, _reason)` — **每轮重算**，第三个
  参数强制写明「为什么值得破坏缓存」（如 mcp_instructions：'MCP servers connect/disconnect
  between turns'）；
- `resolveSystemPromptSections` 并行解析，返回 null 的节直接丢弃。

名字是必须的：注册表按 name 记忆化，缓存键可观测。

### 一条经验：易变内容不要放进系统提示，改成持久化旁路

MCP 服务器指令默认在系统提示里每轮重算——晚连接的 MCP 服务器会把缓存打爆。开启
`mcp_instructions_delta` 后改为**持久化增量附件**：指令只在变化时以附件形式进入消息流一次。
同理，`token_budget` 一节曾因读当前预算而每轮变化，每次预算翻转打爆 ~20K token；修法是把
措辞改成「When the user specifies a token target …」——无预算时是 no-op，于是可以无条件
缓存。**原则：让提示词对状态无感（状态化措辞改为恒真措辞），或者把状态化内容挪出提示词。**

**eTeam 对标**：eTeam 的 persona（`src/host/prompts/persona.ts`、`captain.ts`、`member.ts`、
roster 的 personaMd 手册）在子代理 spawn 时组装一次、整个会话稳定——这已经对齐「静态在前」。
领队手册的解析链（roster personaMd 优先、缺省回退内置）与 Claude Code 的
`buildEffectiveSystemPrompt` 优先级链（override > coordinator > agent > custom > default，
`src/utils/systemPrompt.ts`）同构。可借鉴的是**写法纪律**：persona 若将来引入会话中可变段
（如「当前进行中的任务」），应放人格尾部并接受每轮变化，或改走派发消息而不是人格。

---

## 2. 环境与用户上下文：记忆化 + 包装注入，不污染持久数组

`src/context.ts`：

- `getUserContext()` / `getSystemContext()` **按会话记忆化**：CLAUDE.md、currentDate、
  gitStatus（截 2000 字符的快照）。gitStatus 是**快照**——不追求新鲜，追求字节稳定。
- 注入方式分两路（`src/utils/api.ts`）：
  - `prependUserContext`：把上下文包进 `<system-reminder>` 注入为**第一条合成 user 消息**，
    `isMeta: true`，并带免责声明 "IMPORTANT: this context may or may not be relevant…"——
    系统注入的内容永远标注来源与相关性提示，防止模型把它当用户指令；
  - `appendSystemContext`：`key: value` 行追加到系统提示尾部。
- 两者都是**调用时包装**：发给 API 的投影上做，不写回持久消息数组。持久数组只追加真实
  轮次，缓存前缀因此稳定。

环境信息节（`computeSimpleEnvInfo`）的构成也值得抄：工作目录、是否 git、worktree 提醒
（"Run all commands from this directory. Do NOT cd to the original repository root"）、平台、
shell（win32 特判："use Unix shell syntax, not Windows"）、OS 版本（os.version() 比
os.type() 更可读）、模型描述、知识截止。

**eTeam 对标**：eTeam 派发给领队的快照（`teamView`）相当于这里的 userContext，但走的是
**每轮重发**而非记忆化+稳定快照——这是 04 清单 R-4 的直接依据。注入格式上，eTeam 用
`【团队现状】JSON + 【用户/主对话最新消息】` 的合成消息，与 prependUserContext 同型；
缺的是「may or may not be relevant」式的来源标注与字节稳定性。

---

## 3. 工具面提示词：跟随启用的工具集动态成节

系统提示的 Using your tools 一节按 `enabledTools` 集合拼装：有 Read/Edit/Write/Glob/Grep
才写「用专用工具别用 Bash」；REPL 模式下原语工具被藏起，该节整体换成任务工具一句话；
ant 构建内嵌了搜索工具就不写 Glob/Grep 行。**提示词不描述不存在的工具**——工具集变了，
提示词跟着变，且变化只发生在边界后的动态区。

工具本体各自持有 `description`（进 API schema）与 `prompt`（长文档，按需进系统提示或附件），
工具提示词与系统提示的分工在注册表处统一。

**eTeam 对标**：eTeam 的 `eteams_*` 工具 description 都是静态中文长句（含使用纪律），成员
规则（MEMBER_RULES）在 persona 里。等价于「工具提示词 + 系统提示」两层，结构无问题；
可借鉴的是「跟随工具集成节」的思想——若将来成员/领队工具集按配置伸缩（如关掉
eteams_team_status），规则段落应同步裁剪，避免提示词描述不存在的工具。

---

## 4. 子代理提示词：最小人格 + 环境附注

`src/constants/prompts.ts` 的 `DEFAULT_AGENT_PROMPT`：身份一句 + "Complete the task
fully—don't gold-plate, but don't leave it half-done" + **汇报契约**（"respond with a concise
report covering what was done and any key findings — the caller will relay this to the user,
so it only needs the essentials"）。

`enhanceSystemPromptWithEnvDetails` 给子代理追加 Notes：绝对路径（"cwd resets between
bash calls"）、最终回复带文件路径、不用 emoji、工具调用前不加冒号。以及一条注释性强的
设计：子代理也会收到 skill_discovery 附件，因此**必须**同时拿到与主会话相同的 DiscoverSkills
框架文本——「附件走到哪里，解释附件的提示词就要跟到哪里」。

**eTeam 对标**：`captainChildPersona`（`src/host/prompts/captain.ts`）= 静态纪律 + 领队手册，
成员 persona 经 roster 手册回退——都是「最小人格 + 可编辑手册」。汇报契约在 eTeam 的对应物
是 `eteams_complete_task` 的 output 说明与 report 通道文案（`captainDispatch.ts` 的
dispatchAck 明确「原样展示，不要复述全文」——已对齐）。可补的一条是「附件与解释配对」：
eTeam 给成员发邮箱摘要（inboxPreview）时，persona 里要有对应的使用说明，否则模型看到
摘要不知道全文在哪。

---

## 5. 压缩提示词：9 节模板 + 双保险禁工具 + 即弃草稿

`src/services/compact/prompt.ts`，全部 374 行值得读。要点：

- **禁工具双保险**：`NO_TOOLS_PREAMBLE` 放最前（"Tool calls will be REJECTED and will waste
  your only turn — you will fail the task"），`NO_TOOLS_TRAILER` 放最后。注释给了实测数据：
  Sonnet 4.6 上没有前置强语气时 2.79% 的轮次模型仍试图调工具（Preamble 放最前是修出来的，
  放后面没用）。
- **9 节模板**：1 Primary Request and Intent（逐条用户请求）/ 2 Key Technical Concepts /
  3 Files and Code Sections（含关键代码片段）/ 4 Errors and fixes（**特别记用户纠偏**）/
  5 Problem Solving / 6 All user messages（全部非工具结果的用户消息）/ 7 Pending Tasks /
  8 Current Work（最近在做什么，含文件与片段）/ 9 Optional Next Step（**要求引用原话逐字**，
  防止任务理解漂移）。
- **`<analysis>` 即弃草稿**：模板要求先在 `<analysis>` 标签里打草稿再写 `<summary>`；
  `formatCompactSummary` 在摘要进入上下文前**剥掉 analysis**。草稿提升摘要质量，但不付
  长期 token 代价。
- **方向变体**：全量压缩（BASE）、保留尾部只压前缀（'up_to'，摘要将排在保留消息**之前**，
  因此第 8/9 节换成 "Work Completed" 与 "Context for Continuing Work"——模板随摘要的
  **位置**变化，不是同一份文本到处复用）。
- **续聊包装**（`getCompactUserSummaryMessage`）："This session is being continued from a
  previous conversation…" + 可选 `transcriptPath`（"If you need specific details … read the
  full transcript at: …"——全文永远可回读，只放指针）+ 可选 "Recent messages are preserved
  verbatim." + 无问题续聊指令（"Resume directly — do not acknowledge the summary, do not
  recap … Pick up the last task as if the break never happened."）。

**eTeam 对标**：eTeam 的交接文案（`src/host/prompts/handoff.ts` 的 assignment mail、
`assignment.ts:1176` 的重试 handoff）是「合同 + 状态 + 上次失败」结构。9 节模板的三个思想
可直接迁移：**用户纠偏单独一节**（eTeam 对应：把用户在对话框里的纠正写进交接）、**原话
逐字防漂移**（重试交接只回显 error 摘要，缺「上次做到哪」的逐字 progress）、**指针代替
全文**（transcriptPath 模式 = eTeam 的 notes.md/任务文件夹指针）。这构成 04 清单 R-5/R-6。

---

## 6. 提示词与压缩机制的配对（FRC）

压缩不是只有机制，还有**配套的系统提示**。开启 cached microcompact 的函数结果清理（FRC）
时，系统提示加两节：

- `getFunctionResultClearingSection`："Old tool results will be automatically cleared from
  context to free up space. The N most recent results are always kept."——**提前告知机制**；
- `SUMMARIZE_TOOL_RESULTS_SECTION`："When working with tool results, write down any
  important information you might need later in your response, as the original tool result may
  be cleared later."——**教模型自保**。

压缩行为是运行时决定的，模型却被提前教会了应对：重要信息当场写进自己的正文，旧工具
结果被清掉也不丢事实。**机制与提示词必须一起上线**，只上机制会静默丢上下文，只上提示词
是空话。

**eTeam 对标**：eTeam 若做邮箱/事件归档回收（04 清单 R-10），必须同时给成员/领队 persona
加一条「旧邮件可能被归档，重要信息当场记 notes.md」（04 清单 R-11）。eTeam 已有的
「产出写 notes.md」纪律方向一致，但缺「为什么」的说明（机制告知）。

---

## 7. 长度锚点：用数字，不用形容词

ant 构建的系统提示里有实测驱动的两行："Length limits: keep text between tool calls to ≤25
words. Keep final responses to ≤100 words unless the task requires more detail."——注释写明
**数字锚点比定性描述（be concise）实测减少 ~1.2% 输出 token**。eTeam 的 progress ≤200 字
上限、邮箱摘要截 300 字已是数字锚点；persona 里的「简洁汇报」类措辞若也有对应数字，同向。

---

## 8. 缓存纪律清单（提示词侧的横切规则）

长会话的 prompt cache 是主要成本杠杆。Claude Code 在提示词相关路径上的全部纪律：

1. **历史消息绝不原地改**。回填展示字段先克隆，且只在「新增字段」时克隆——改一个字节
   缓存即失效（`src/query.ts` 注释）。
2. **工具 schema 会话内稳定**。缓存键 `name:inputJSONSchema`，同一会话内工具定义变化
   不重建 schema；每请求只做薄覆盖（`src/utils/api.ts`）。
3. **工具池排序保缓存**：内置工具排序成连续前缀，MCP 工具排序后接，`uniqBy` 保序去重
   （内置优先）。理由（`src/tools.ts` 注释）：服务端在最后一个前缀匹配的内置工具后打全局
   缓存断点，扁平排序会让插进内置工具之间的 MCP 工具打爆全部下游缓存。
4. **影响请求字节的配置在会话内锁存（latch）**。1h 缓存 TTL 的资格判定与 allowlist 首次
   算出后写进 bootstrap state（`src/services/api/claude.ts:393` 注释：中途翻转每次打爆
   ~20K token）；beta header 锁存同理，`/clear` 才重置。
5. **每请求只打一个消息级缓存断点**（`addCacheBreakpoints`，claude.ts:3063）；fork 不写
   缓存时断点移到倒数第二条消息。
6. **系统提示分节记忆化**，易变节必须带理由（§1）。
7. **上下文以包装注入**（投影时拼装），持久数组保持 append-only。

**eTeam 对标**：eTeam 自己不发 API 请求，1–5 属宿主；但 4 的思想在编排层有对应物——
**影响子会话 prompt 字节的编排侧内容（派发快照、交接文本）必须在会话内增量、稳定**，
这是 04 清单 R-4 的原则依据。第 3 条对 eTeam 的意义：成员/领子代理的工具集（deny list
过滤后）在 spawn 时固定（`MEMBER_DENIED_TOOLS`/`CAPTAIN_CHILD_DENIED_TOOLS`，
`src/host/runtime/members.ts`、`captainAgent.ts`），方向正确，保持。

---

## 9. 小结：eTeam 能带走的五条

1. **提示词分节 + 命名 + 记忆化**；会话相关内容放缓存边界之后；无理由不打爆缓存。
2. **状态化内容挪出提示词**：或改成恒真措辞，或改走持久化旁路（附件/派发消息）。
3. **上下文注入用包装与标注**：合成消息带 `isMeta` 语义与相关性免责声明，不污染真相源。
4. **压缩提示词是模板工程**：禁工具双保险、9 节结构、逐字引用防漂移、即弃草稿、
   指针代替全文、续聊指令「直接续」。
5. **机制与提示词配对上线**：任何「旧内容会被回收」的机制都要提前告知模型并教它自保。