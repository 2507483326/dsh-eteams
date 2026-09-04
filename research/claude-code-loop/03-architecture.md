# 03 架构：Tool 契约、注册表、deps/config、fork 缓存共享与请求层

研究对象：`C:\Users\epat\Downloads\Claude-Code-main` 源码的架构层——工具怎么定义与装配、
循环怎么参数化、子代理怎么共享缓存、请求层怎么打缓存断点。本文回答：支撑 §提示词与
§流程的**骨架**长什么样，哪些骨架思想 eTeam 该吸收。现状以 2026-09-04 工作区为准。

---

## 1. Tool 接口契约（`src/Tool.ts`，792 行）

工具不是「一个 execute 函数」，是一个有**缺省值纪律**的完整接口：

- **身份**：`name` / `description`（进 API schema）/ `prompt`（动态长文档）/ `userFacingName`
  / `aliases` / `searchHint`（被搜索时命中词）。
- **行为**：`call` / `validateInput` / `checkPermissions` / `preparePermissionMatcher` /
  `isConcurrencySafe`（能否并行）/ `isReadOnly` / `isDestructive` / `interruptBehavior`
  （'cancel' | 'block'）/ `shouldDefer` / `alwaysLoad` / `strict`。
- **上下文经济**：`maxResultSizeChars`（**每工具**的结果预算，超限转存盘、正文替换为引用；
  Read 工具设 Infinity）/ `backfillObservableInput`（事后回填展示字段，只加字段不改字节）/
  `extractSearchText` / `toAutoClassifierInput`。
- **展示**：`renderToolUse` / `renderToolResult`（模型可见与用户可见分离）。

### buildTool 的 fail-closed 缺省值

`TOOL_DEFAULTS`：`isConcurrencySafe: false`、`isReadOnly: false`、`isEnabled: true`、
`checkPermissions` 默认放行交给通用权限。**未声明的工具一律按「不安全、会写」处理**——
并行化与只读优化必须由工具作者显式声明，缺省侧向安全。

### ToolResult 与上下文修改权

`ToolResult<T> = { data, newMessages?, contextModifier?, mcpMeta? }`。关键规则：
**contextModifier 只对非 concurrency-safe 的工具生效**——能改全局上下文的工具必然独占，
并行工具不许动共享状态。类型系统上把「副作用能力」和「并发资格」绑在一起。

### ToolUseContext：随调用线程下传的执行环境

包括 options（tools/model/thinking）、abortController、readFileState（文件新鲜度）、
getAppState/setAppState、appendSystemMessage、agentId、`queryTracking {chainId, depth}`
（子代理深度追踪）、`contentReplacementState`（工具结果替换记录）、`renderedSystemPrompt`
（**轮首冻结**，fork 之间共享同一份系统提示以保缓存命中）、`loadedNestedMemoryPaths` 去重。

**eTeam 对标**：eTeam 用宿主 `defineTool`（parameters/output schema + render），工具面更窄
（`exec: {agent, signal}`），这没问题——宿主已承担权限/并发。可吸收三条：
**每工具结果预算**（eTeam 的 board/status 类工具返回无界 JSON，04 清单 R-7）、
**fail-closed 缺省**（eTeam 工具默认在 deny list 外即可见，方向是 fail-open，但 eTeam 场景
成员工具集是显式白名单式注册，等价安全）、**副作用与并发绑定**（eTeam 的 eteams_* 全是
事务型独占调用，天然满足）。

---

## 2. 工具注册表（`src/tools.ts`）

- **单一事实源** `getAllBaseTools()`：全部可能工具的静态列表；注释强调它必须与服务端
  全局缓存策略配置保持同步。
- **特性裁剪用 DCE**：`feature('AGENT_TRIGGERS')` 等门控的 require 是编译期死代码消除——
  外部构建里被裁工具的代码根本不存在，而不是运行时隐藏。
- **环依赖用懒 require 打破**：TeamCreateTool → … → tools.ts 的环，用
  `const getTeamCreateTool = () => require(...)` 解决，注释写明原因。
- **deny 在暴露前**：`filterToolsByDenyRules` 用与运行时权限检查**同一个匹配器**，把被
  整体 deny 的工具（含 MCP 服务器前缀规则）在模型看到 schema **之前**剔除。注释的理由：
  「strips all tools from that server before the model sees them — not just at call time」——
  模型已经看到工具再拒绝，浪费的是格式化调用的 token 与一轮重试。
- **模式过滤**：SIMPLE 模式只留 Bash/Read/Edit；REPL 模式把原语工具藏进 REPL；最后统一
  过 `isEnabled()`。
- **装配保缓存**：`assembleToolPool` 把内置工具排序成连续前缀、MCP 工具排序后接、`uniqBy`
  保序去重（内置优先）——服务端在最后一个前缀匹配的内置工具后打全局缓存断点，扁平排序
  会让插入其间的 MCP 工具打爆下游缓存。

**eTeam 对标**：eTeam 的 deny-at-spawn（`MEMBER_DENIED_TOOLS` / `CAPTAIN_CHILD_DENIED_TOOLS`
在 `startContinuable` 的 toolFilter 里传入，`members.ts` / `captainAgent.ts`）与 Claude Code
的 deny-before-exposure **同构且方向正确**——成员根本看不到领队工具，反之亦然。保持。
可记录的一条差异：eTeam 工具描述是静态长句（含纪律），Claude Code 把使用纪律放系统提示、
工具 description 只讲怎么用——分工更清晰，长会话下 description 常驻 API schema，纪律放
persona 更省 token（低优先级优化，04 附录）。

---

## 3. 循环参数化：deps / config / 转移助手

- **`QueryDeps`**（`src/query/deps.ts`）：callModel / microcompact / autocompact / uuid
  四个依赖以 `typeof fn` 类型注入——**签名与实现自动同步**，测试注入假件，主路径用真件。
  循环核心对 I/O 的全部假设被压缩到四个函数。
- **`QueryConfig`**（`src/query/config.ts`）：query 入口处把全部开关拍成**不可变快照**，
  轮次中途配置变化不影响进行中的循环（feature() 门控的编译期开关除外——为了 tree-shaking
  不进快照）。
- **`transitionQueryState`**（`src/query/transitions.ts`，3 行）：恒等函数，占位为将来把
  while 循环重写成 reducer——**先立命名转移，再谈重构**。

**eTeam 对标**：eTeam 的 runtime 函数（`assignment.ts` 等）直接闭包引用 `env.ctx`、
`wakeMember`、`emit`。QueryDeps 模式说明：**循环协议的可测性来自把 I/O 收窄成少数可注入
依赖**。eTeam 若要给编排协议做无 SQLite 的单元测试，把「唤醒」「事件」「时钟」抽成
RuntimeDeps 即可（04 附录记为远期）。

---

## 4. fork 与子代理：cacheSafeParams 缓存共享

`src/utils/forkedAgent.ts`（689 行）的 fork 机制：

- `cacheSafeParams = { systemPrompt, userContext, systemContext, toolUseContext,
  forkContextMessages }`——fork **继承父会话的全部缓存前缀**（同系统提示、同上下文包装、
  同消息数组），自己的 prompt 追加在尾部。这样 fork 的第一次 API 调用命中父会话已建立的
  缓存，fork 的成本只是新增尾部。
- `createSubagentContext` 隔离可变字段：新 agentId、`queryTracking.depth + 1`（链追踪）、
  独立 abortController——**共享只读前缀，隔离可变状态**。
- `skipCacheWrite`（fire-and-forget fork）：缓存断点移到倒数第二条消息——最后一个共享
  前缀点，fork 不把自己的尾巴写进 KV 缓存。
- fork **不做**消息预清理：修复必须走与主线相同的下游路径，产出逐字节相同的前缀，缓存
  才能命中（「identical post-repair prefix keeps the cache hit」）。
- 用量从 `message_delta` 流事件逐轮 `accumulateUsage` 累计。

**eTeam 对标**：eTeam 的持续子代理（`startContinuable`/`followup`，`captainDispatch.ts`）
没有也不需要 fork 式前缀共享——成员/领队是**长会话**，缓存靠「追加稳定尾部」实现。这使
**追加内容的经济性**比 Claude Code 更关键：每轮 followup 的 prompt（全量 teamView JSON）
正是唯一非缓存区，长度直接进账单——04 清单 R-4 的架构依据。`queryTracking.depth` 对应
eTeam 的「领队子代理不再派领队子代理」（deny list 已保证无递归），保持。

---

## 5. 请求层：缓存断点与参数治理（`src/services/api/claude.ts`）

- **`addCacheBreakpoints`**（3063 行起）：每请求**恰好一个**消息级 `cache_control` 标记，
  落在最后一条消息；fork 的 skipCacheWrite 移到倒数第二条。注释解释了为什么不能打两个
  （服务端 KV 页逐轮逐出策略：两个标记会让无用的倒数第二位置多活一轮）。
- **cached microcompact 的 pinned edits**：删除型缓存编辑块插入最后一条 user 消息后，
  **钉住**（pin）未来请求在原位重发同一块——服务端缓存编辑要求位置稳定；重复引用去重。
- **cache_reference**：给缓存前缀内的 tool_result 打引用（clone-on-write，绝不原地改——
  消息对象可能被别的请求复用）。
- **`buildSystemPromptBlocks`**：系统提示块按 splitSysPromptPrefix 的 scope 打缓存控制，
  注释警告「再加块会 400」。
- **max_tokens 治理**：`getMaxOutputTokensForModel` 槽位预留上限（默认降到 8K，BQ p99
  输出 4,911；命中上限的请求在 query.ts 拿一次 64K 干净升级）；`adjustParamsForNonStreaming`
  保证 `max_tokens > thinking.budget_tokens` 约束；非流式 64K 上限。
- **小模型通道**：`queryHaiku` / `queryWithModel` 是独立的最小管线（无工具、无流式、默认
  不缓存）——便宜模型的调用不进主循环的复杂度。

**eTeam 对标**：1–3 属宿主。eTeam 侧可吸收两条：**参数治理注释里带数据**（8K 默认值的
依据是 BQ p99——数值决策留痕，eTeam 的 ≤200 字/300 字截断同样可补依据注释）、
**小模型调用走独立通道**（04 清单 R-9 的小模型摘要应独立于成员子会话，直接一次非流式
调用 + usage 记账，不建 continuable 会话）。

---

## 6. 架构原则蒸馏（eTeam 视角）

1. **fail-closed 缺省**：并发性、只读性、权限都要显式声明；未声明按危险处理。
2. **deny 在暴露前**：过滤发生在模型看到 schema 之前，而不是调用被拒之后。
3. **副作用能力与并发资格绑定**：能改共享状态的工具必然独占。
4. **每工具结果预算**：上下文是稀缺资源，预算责任下放到最了解结果形状的工具。
5. **I/O 收窄成可注入依赖**：循环协议的测试性来自 deps 注入，不来自 mock 数据库。
6. **共享前缀、隔离可变状态**：fork 继承缓存前缀；子代理拿新 id、新追踪链、新中止器。
7. **数值决策留依据注释**：8K/64K、≤25 词、2000 字符——阈值旁写实测来源，防止后人
   当魔法数改掉。
8. **展示与数据分离**：renderTool* 与 ToolResult.data 分离——eTeam 的 output schema +
   render 函数（`defineTool` 的 output.render）已是同型，保持。

---

## 7. 不照搬清单（宿主内部器官，插件自建只会做出脆弱复制品）

- 流式工具执行器与 sibling 中止（宿主循环内器官）；
- cached microcompact / cache_edits pinning / context collapse（依赖服务端缓存编辑能力）；
- thinking 签名剥离与 fallback 模型切换（模型层细节）；
- KV 页逐轮回收类基础设施（Mycro/micro' 服务端行为）；
- fetch 包装器复用等调试基建（宿主进程级）。

eTeam 的正确姿势：把这几条整理成**对宿主（DSH）的建议输入**，自己只做编排协议层的
对齐（见 04 清单附录 B）。