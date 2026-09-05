# 28 看板 · 每日 Token 消耗日历

> **存储迁移（2026-09-05）**：记账存储已从本文描述的 JSONL 台账（usage.jsonl + 归档 + 水位对账）整体迁移到 SQLite 两表（`usage_detail` 明细 + `usage_daily_total` 总和），DB 即唯一存储——无文件、无对账、无历史回补（存量台账已于 2026-09-05 人工导入一次）。采集方案（firehose 监听、归属五级、日界快照）、路由与渲染规格仍然有效，仅「怎么记」中的文件写入/轮转/对账细节已被取代；存储现状以 40 号文档为准。

面板「看板」tab 新增「Token 消耗」卡片：GitHub 风格贡献日历（`react-activity-calendar`），**2026-09-05 用户迭代起为全应用口径**——展示整体应用每天消耗的 TOKEN 数量（`GET /usage/calendar`，不按团队/归属过滤；团队维度路由保留供后续钻取）。本文回答四个问题：**数据从哪来**（宿主层无 token 统计，必须找到可落地的 seam）、**怎么记**（usage.jsonl 记录模型）、**怎么读**（/eteams-api 聚合路由）、**怎么画**（日历渲染规格）。

## 28.1 目标与非目标

**目标**

1. 看板新增「Token 消耗」卡片：全年 365/366 天热力日历，亮暗主题跟随宿主，hover 显示当日分项（输入/输出/缓存读/缓存写/推理）。
2. 采集零侵入：不改变任何会话/子代理行为，插件在宿主层旁路观察 usage；计量失败绝不影响会话。
3. 归属到团队：领队主会话、领队子代理、成员子代理、面板绑定会话的消耗都计入该团队；无法归属的归 workspace 桶（不进团队日历）。
4. 跨年可切换；启用后开始记录，不回填历史。

**非目标**

- 不做成本/计费换算（无单价概念）；不做成员级明细钻取页（日历 tooltip 只到「日」粒度，成员分项留待后续文档）。
- 不做秒级实时：日历数据低频拉取（挂载/切年/切团队时 + 可选 60s 低频轮询），**不进** `monitor.ts` 的 1s activity 轮询。
- 不覆盖 out-of-process 子代理（ACP/远端）——见 28.6.5 盲区声明。

## 28.2 数据源调查结论（证据）

### 28.2.1 证据清单

| # | 结论 | 证据（文件:行） |
|---|---|---|
| E1 | `TokenUsage` 定义：`inputTokens`/`outputTokens` 互斥计数，缓存单独报（`cacheReadTokens`/`cacheWriteTokens` 可选），`reasoningTokens` 可选 | `node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts:123-129` |
| E2 | 会话日志事件 `assistant/message` 携带该步 `usage?: TokenUsage`；「没有单独的 usage 事件，账目随消息走」；adapter 未上报时缺省 | `node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts:269-285`（注释 271-277） |
| E3 | 每个事件含 `seq`（单调递增）与 `time`（Unix 毫秒）——日粒度聚合与去重键的基础 | `node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts:425-433` |
| E4 | 每步派发前追加 `request/header`（`EpochHeader.config: LlmCallConfig` → `provider`/`model`），`request/context` 仅在路线变化时记——provider/model 需按会话折叠维护 | `node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts:191-200, 323-335`；`@deepseek-ai/dsh-llm/lib/types/call-config.d.ts:16-23`；`Session.requestContext()` `dsh-session/lib/types/index.d.ts:229-234` |
| E5 | 子代理一次性结果 `SubagentResult` **不含** usage（output/structured/diagnostic/stopReason 而已）——不能靠结果回传拿 token | `node_modules/@deepseek-ai/dsh-subagent/lib/types/types.d.ts:204-230` |
| E6 | `subagent/start`/`subagent/end` 事件负载（`SubagentRunInfo`/`SubagentRunEndInfo`）也不含 usage，也不含 label | `node_modules/@deepseek-ai/dsh-subagent/lib/types/index.d.ts:81-95`；`types.d.ts:30-66` |
| E7 | `session/event` 是 cordis 事件：会话每次 append 提交后广播 `(session, event)`；监听器失败被逐个捕获记录，不影响 append | `node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts:55-66`；实现 `dsh-session/lib/index.js:1462-1476`（`entry.carrier` 经 `collectSessionCallbacks` → `ctx.events.dispatch("emit")`） |
| E8 | scope 过滤语义：scope 载体「**admits untagged listeners globally**」且「admits tagged listeners for a matching key or any of its ancestors」——**根/插件级（未打标）监听者收到本进程所有会话的事件**（主会话 + 子代理会话） | `node_modules/@deepseek-ai/dsh-scope/lib/types/index.d.ts:86-97`；cordis 分发过滤 `@deepseek-ai/cordis/lib/index.js:258-264`（`hook.global` 直通、`filter.call(thisArg, hook.ctx)` 按**监听者 ctx 的 scope 标签**过滤） |
| E9 | 构造种子不重发：续聊/重启恢复的会话，其历史日志以 seed 进入、**不触发 `session/event`**（`firstLiveSeq` 之后的新 append 才发）——重启天然不双计，但宕机窗口内的事件会漏计（见 E10 兜底） | `node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts:124-145` |
| E10 | `session/created`（session 进入 store 并公告时触发）+ `ctx.sessions.list()`/`get()`——可做「装机后对活会话折算补漏」的对账面 | `node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts:36-44, 390-398` |
| E11 | `registerContinuableSetup((childCtx) => ...)`：把部署能力装进 continuable 子代理「未发布的创建 context」；`childCtx` 是子代理的 scoped context，**API 形态上可 `childCtx.on('session/event')`——仅为 API 形态，非事件路由证据**：tagged 监听能否只收子树取决于 sessions store 挂载拓扑，**未核实**（见 28.2.3-5）；eteams 已在用（成员工具安装） | `node_modules/@deepseek-ai/dsh-subagent/lib/types/activation-setup-registry.d.ts:15-22`；`src/host/runtime/members.ts:227-249`（`childCtx.agent`、`session.header.parentSession`、`foldSubagentDescriptor` 均可读） |
| E12 | `startContinuable` 返回 `ContinuableStart { childId, messageId }`——成员/领队子代理的持久会话 id 在 spawn 处已知 | `node_modules/@deepseek-ai/dsh-subagent/lib/types/continuation.d.ts:100-105`；`src/host/runtime/members.ts:90-110`（成员）、`src/host/tools/captainDispatch.ts:183-196`（领队） |
| E13 | 现成归属基础设施：成员子代理 label `eteams-member:<teamId>:<memberName>`；领队子代理 label `eteams-captain:<teamId>` + 注册表 `captainChildren`；领队主会话 `team.captainSessionId`；面板会话团队绑定 `getSessionTeamId` | `src/host/runtime/members.ts:21-37`；`src/host/runtime/captainAgent.ts:23-54`；`src/host/model/types.ts:222`（写入 `src/host/runtime/teamOps.ts:94`）；`src/host/runtime/sessionTeam.ts:62-64` |
| E14 | `dsh-session-stats` 的 `sessionStats` 投影只有 `decodeTokens`（「decode-timed steps 的 provider output tokens」）——**输出 token 的子集**，无输入/缓存维度，不够用 | `node_modules/@deepseek-ai/dsh-session-stats/lib/types/types.d.ts:18-35` |
| E15 | `dsh-token-meter` 是「请求/表面压力」估计（`measure(session)` 返回当前上下文压力与表面节点），**不是累计消耗台账** | `node_modules/@deepseek-ai/dsh-token-meter/lib/types/index.d.ts:38-45`；`types.d.ts:23-43` |
| E16 | 投影注册表 seam：`ctx.sessionProjections.register(单元)` + `onChanged`，框架对每个已提交事件驱动 `apply`，并持久化 `(sessionId, key, ver, seq, val)` 检查点（需 merge `SessionProjectionMap` + zod schema） | `node_modules/@deepseek-ai/dsh-session-projection/lib/types/index.d.ts:37-68, 106-144, 185-222`；挂载证据：`dsh-plan-mode/package.json`、`dsh-goal/package.json` 依赖 session-projection |
| E17 | 追加写先例：`events.jsonl`/`inbox/*.jsonl` 用 `appendFile` 追加、容错读（撕裂尾行截断）；原子替换用 `atomicWriteText`（docs/09.2） | `src/host/state/events.ts:13-33, 45-57`；`src/host/state/store.ts:25-33`；`docs/09-persistence.md:9.1-9.3` |
| E18 | **第一方同型先例**：dsh-session-persistence（DSH 自带持久化插件）在插件安装路径上做 `ctx.on("session/created")` + `ctx.on("session/event")` + 遍历 `ctx.sessions.list()`——持久化职责要求它收全进程所有会话的事件，方案 A（根监听 + 水位对账）由「类型注释推断」升级为「有第一方同型先例」 | `node_modules/@deepseek-ai/dsh-session-persistence/lib/index.js:1152-1162` |

### 28.2.2 候选 seam 对比

| 候选 | 覆盖面 | 侵入/依赖 | 重启一致性 | 主要风险 |
|---|---|---|---|---|
| **A. 根作用域 `ctx.on('session/event')` firehose** | 本进程**所有**会话（主会话+成员/领队子代理+一次性构建子代理），一个监听全覆盖 | 最小：插件 `apply()` 里一行注册，不加 inject 依赖 | 需自管 watermark 对账（E9 漏计、E10 兜底） | 依赖 E8 的未打标监听全收语义（有实现级证据 E7/E8） |
| B. 每子代理 `childCtx.on('session/event')`（经 E11 的 setup hook） | 「仅该子代理子树」**未核实**——E11 是 API 形态非路由证据，实际覆盖面取决于 sessions store 挂载拓扑，启用前需装机验证（28.2.3-5）；主会话与领队主会话需另挂 | 中：要在 setup hook/每子代理挂监听、逐个管理 dispose | 同 A | 监听器生命周期与 Activation 纪元耦合，遗漏分支多；覆盖面未证实 |
| C. `ctx.sessionProjections.register` 投影单元 + `onChanged` | 所有会话（注册表自己订阅 `session/event`） | 大：`inject: ['sessionProjections']` 硬依赖、merge `SessionProjectionMap`、zod schema、`stateVersion` | 最好：框架持久化检查点（E16） | 旧运行时无该服务即加载失败（需 optional inject 特性探测）；为「记个账」引入整套投影单元不成比例 |
| D. attempt 结束时读子会话日志增量（`session.events` 折算） | 仅 eteams 自己 spawn 的子代理，且要 attempt↔会话对账 | 中：与 assignment/attempt 生命周期强耦合，非 attempt 会话（领队闲聊、面板对话）漏掉 | 差：跨 attempt 重复/漏读需额外状态 | attempt 结束时机不可靠（失败/中断/续聊），且拿不到主会话 |
| E. `dsh-session-stats` `decodeTokens` | 全会话（投影） | 中 | 好 | 只有输出 token 子集（E14），无输入/缓存，无按团队归属的载体 |
| F. `dsh-token-meter.measure()` | 单会话压力快照 | 小 | 无台账语义 | 语义是「当前请求压力」不是「累计消耗」（E15） |

### 28.2.3 选定：A 为主 seam，C 的「检查点」思想自己实现，B 作降级开关

**选定 A**：`src/host/index.ts` 的 `apply()` 中注册一个根作用域 `session/event` 监听（新模块 `src/host/runtime/usage.ts`）。论证：

1. **覆盖完整**：E7+E8 证明未打标的插件级监听者收到本进程所有会话的每个已提交事件——成员子代理、领队子代理、一次性构建子代理、领队主会话、面板绑定会话全在一个 firehose 里，不需要逐个挂钩。eteams 插件 ctx 由 cordis loader 挂在宿主组合根下、无 scope 标签（`src/host/index.ts:84-117` 直接 `ctx.tools.register`/`ctx.systemPrompt.section`，未 `createScope`），天然是「untagged listener」。
2. **侵入最小**：不加 inject 依赖（`inject` 数组保持 `src/host/index.ts:51` 不动）；不新增子代理生命周期耦合；`usage` 缺失的 step 直接跳过（E2），对会话零影响（监听器异常被 dsh-session 逐个 contain 并 warn，E7）。
3. **重启一致性**：E9 说明 seed 不重发 → 不双计；漏计（宿主宕机窗口内已提交但未计量的事件）用**自管 watermark** 补：维护 `usage-checkpoint.json`（`sessionId → lastFoldedSeq`），在 `session/created`（E10）与插件装机时对 `ctx.sessions.list()` 的活会话把 `session.events` 中 `seq > checkpoint` 的 `assistant/message` 补折一次。**读侧按 `(sessionId, seq)` 去重**（usage.jsonl 行携带两键）→ 追加重试/重复折叠都无害，弱于 C 的框架检查点但足够，且不用为账本引入投影单元。
4. **为何不选 C**：`registerContinuableSetup`/投影注册表能做的（全量事件驱动 + 持久检查点）A 用「watermark 文件 + 读侧去重」即可等价实现，而 C 要付出 hard-inject、zod、SessionProjectionMap merge 三项成本，且在无 `sessionProjections` 服务的部署（headless/webless）直接装载失败——违背「最可靠、侵入最小」。
5. **B 的定位**：若装机证伪 A（E8 语义不符），降级方案是在 E11 的 `registerContinuableSetup` 里对 `childCtx.on('session/event')` 挂子树监听（子代理部分）+ 主会话按 `session/created` 逐会话挂——API 均已核实存在，只是实现面更碎，故作为兜底而非主案。**B 的「仅该子代理子树」覆盖语义未核实**：E11 只说明 `childCtx` 是「child's unpublished scoped context」（API 形态，不构成事件路由证据），tagged 监听者实际能否只收子树取决于 sessions store 的挂载拓扑（`session/event` 的 scope 载体按监听者 ctx 的 scope 标签过滤，`dsh-session/lib/index.js:1695`；node_modules 内无 SessionStore 实例化点，无法证实）——`dsh-session` 类型注释「agent-scoped listeners receive only sessions entered through that agent's context」（`dsh-session/lib/types/index.d.ts:59-60`）反而暗示按 agent scope 打标。**启用 B 前需装机验证 childCtx 监听的实际覆盖面**；兜底的兜底：cordis 监听可带 `{ global: true }` 绕过 scope 过滤直收全量事件（`@deepseek-ai/cordis/lib/index.js:258-264` 的 `hook.global` 直通分支，E8），代价是放弃 scope 隔离、由监听器自行按会话身份过滤。

**结论一句话**：usage 只随 `assistant/message` 事件走（E2），本进程所有会话的事件都能被插件根监听者看到（E7/E8），因此「一个根监听 + 每会话折叠 provider/model 路线 + 水位对账」就是最小可靠 seam。

## 28.3 记录模型

### 28.3.1 事件粒度台账：`<workspace>/.eteams/usage.jsonl`

追加写 JSONL（对齐 docs/09.1 的 `events.jsonl` 先例：`appendFile` 追加 + 撕裂尾行容错读，`src/host/state/events.ts:13-33`）。**位置放工作区级**（`<workspace>/.eteams/usage.jsonl`，即 `stateRootOf` 的 stateDir 内，`src/host/runtime/base.ts:89-91`、`cordis.patch.yml` `stateDir: .eteams`），因为归属工作区由会话 `header.cwd` 决定，团队只是过滤维度。

```jsonc
// 一行 = 一次携带 usage 的 assistant/message
{
  "at": 1786270800000,          // event.time（Unix ms，dsh-session types.d.ts:429）
  "day": "2026-09-04",          // 记录时按宿主本地时区折算的日界（见 28.6.4）
  "sessionId": "session-123",   // 事件所属会话
  "seq": 42,                    // event.seq —— 读侧去重键之一
  "teamId": "team-abcdef",      // 记录时快照；无法归属时为 null（workspace 桶）
  "memberName": "小舟",          // 记录时快照（成员删除/改名不影响历史行）；非成员为 null
  "roleKind": "member",         // captain | captain-child | member | conversation | workspace
  "provider": "deepseek",
  "model": "deepseek-chat",
  "inputTokens": 10240,         // 不含缓存的输入（E1：billed input = input + cacheRead + cacheWrite）
  "outputTokens": 860,
  "cacheReadTokens": 52310,
  "cacheWriteTokens": 0,
  "reasoningTokens": 512        // 可能为 null；与 output 的重叠关系见 28.3.3
}
```

**写入纪律**

- 热路径 O(1)：监听器对 `event.type !== 'assistant/message'` 立即返回；`request/header`/`request/context` 事件只更新每会话的路线缓存（provider/model，E4）；usage 行的构造同步完成，`appendFile` 经**模块级 Promise 链串行队列**异步发出、不 await（usage.jsonl 是工作区级文件，不走 docs/09.3 的 per-team 锁，串行队列即保证行序）。
- 写失败降级：吞错 + 1 分钟节流 warn（计量绝不能破坏会话；`session/event` 监听器失败本就被 dsh-session contain，E7）。
- 追加写不走 `atomicWriteText`（不是整体重写）；读侧用 `parseJsonl` 同款容错（撕裂尾行丢弃，`src/host/state/events.ts:13-33`）。

### 28.3.2 归属策略：记录时打快照，不引用活状态

`session/event` 只给 `(session, event)`，归属靠**解析一次、缓存**的会话身份表（`session.id → { teamId, memberName, roleKind }`），解析顺序：

| 优先级 | 判定 | roleKind | 证据 |
|---|---|---|---|
| 1 | 会话 id 出现在成员子代理注册表（`registerContinuableSetup` hook 内按 label `eteams-member:<teamId>:<memberName>` 解析后登记） | `member` | `members.ts:21-37, 227-249` |
| 2 | 会话 id 在 `captainChildren` 注册表（领队子代理） | `captain-child` | `captainAgent.ts:43-54`（`captainDispatch.ts:196` 写入） |
| 3 | 会话 id === 某 `team.captainSessionId`（读该工作区 team.json 比对；解析失败短 TTL 缓存避免每事件读盘） | `captain` | `model/types.ts:222`（`teamOps.ts:94` 写入） |
| 4 | `getSessionTeamId(sessionId)` 命中面板团队绑定 | `conversation` | `sessionTeam.ts:62-64` |
| 5 | 其余（未绑定对话、`eteams-rolebuilder` 一次性构建子代理、用户普通会话） | `workspace`（`teamId: null`） | `builderPhases.ts:159` |

要点：

- **快照不引用**：归属在**记录时**解析并写死进行内（成员后被移除/改名、会话解绑都不改历史行）——满足「成员跨团队同名/被移除」的可追溯要求；跨团队同名成员由 `teamId + memberName` 双键区分。
- 领队双形态（主会话 + 领队子代理）都归属团队：日历按团队合计展示，不因双计重复（是两个真实会话各自的真实消耗）；`roleKind` 保留区分能力，供后续明细钻取。
- `workspace` 桶照记不丢，进**全应用日历**（`GET /usage/calendar`，2026-09-05 用户迭代——看板「Token 消耗」卡展示整体应用每日消耗）；不进团队日历（`GET /team/:id/usage/calendar` 仍按 28.3.2 原语义只聚合归属行）。
- 冷恢复的子代理会话：`registerContinuableSetup` 在每次 Activation（含 cold resume）都会重跑（这是成员工装现存的正确性前提，`members.ts:227` 注释与 `captainAgent.ts:16-17`「重启后重登记」），身份表随之重建。
- 工作区解析回退：写入侧按会话 `header.cwd` 解析工作区（先例 `members.ts:237`——该行实为 `child.session?.header?.cwd ?? process.cwd()`，cwd 可缺省且有回退）；usage 写入侧保留同一回退，**回退生效时按 1 分钟节流 warn**，避免 `header.cwd` 缺失的会话被静默错桶（详见 28.6.3）。

### 28.3.3 计数口径

- `totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`（E1：三者互斥，billed input = 三者之和；日历热力以「计费口径 token」为准）。
- `reasoningTokens` 单独记录、**不计入** `totalTokens`：DeepSeek/Anthropic 的 reasoning 计数是否已含在 `outputTokens` 内需实测确认（E1 未声明互斥），tooltip 按独立分项展示并注明「可能与输出重叠」。
- `usage` 缺失的 step 不记行（E2：adapter 未上报时事件缺 usage 字段）——日历低估而非虚高，可接受。

### 28.3.4 重启对账（watermark）

- `<workspace>/.eteams/usage-checkpoint.json`：`{ [sessionId]: lastFoldedSeq }`，`atomicWriteText` 整写（小文件）；条目按会话最后活跃时间剪枝（保留 30 天），防无限增长。
- 补折时机：`session/created`（E10）+ 装机时 `ctx.sessions.list()`（E10）遍历活会话；折算时**先查 checkpoint**，`seq > lastFoldedSeq` 的 `assistant/message` 才记行并推进水位。
- 读侧去重键 `(sessionId, seq)`：宕机窗口内「先追加 usage 行、checkpoint 未及更新」造成的重折会在聚合时被去重，双写无害。

### 28.3.5 与 docs/27 的衔接：usage.jsonl 是 token 记账唯一真相

- **[27 SQLite 表结构](27-sqlite-schema.md) 已删除原表 8 `token_usage`**（2026-09-04 定案，随本文落稿同步修订）：SQLite 本轮不承载 token 记账，token 日历的采集、存储与查询只走本设计的 usage.jsonl——**usage.jsonl 是 token 记账的唯一真相**，不存在第二份。27 侧已同步删除 `idx_token_*` 索引、查询场景 Q7–Q9 与「表 8 预留」表述（27.7/27.8 阶段 1 亦改口），其 27.9-1 已改写为本定案的引用记录。
- **若后续 SQLite 阶段 1 需要 token 投影表**，行模型必须按本文档的记录模型对齐，不得自行另造：
  - `role_kind` 扩为五值 `captain / captain-child / member / conversation / workspace`（28.3.2，不是 `member/captain` 两值）；
  - `team_id` 可空（workspace 桶 `teamId: null`，28.3.2 优先级 5）；
  - 增加 `provider` / `model` **记录时快照列**（28.3.2「快照不引用」原则——不得 join members 表的活路线）；
  - 粒度为**事件行**（一次携带 usage 的 assistant/message 一行，`(sessionId, seq)` 去重），**不得回退为 `(team, member, day)` 日聚合表**——28.4「读取时聚合，不落盘日汇总」的全部理由对投影表同样适用。
- 两文档分工：SQLite 管「角色/团队/任务」结构化状态（docs/27），usage.jsonl 管 token 台账（本文），互不替代、互不知情写入。

## 28.4 API 设计

**结论：读取时聚合，不落盘日汇总。** 理由：日汇总文件会引入第二真相（跨天边界、成员删除补偿、时钟回拨都要在两份文件间对账），违背 docs/09「磁盘是唯一真相、追加文件永不改写」的简化版；usage.jsonl 单工作区规模可控（28.6.1 轮转上限内 ≤2MB），全量扫一次 + 按 `teamId/year` 过滤 + 内存按日累加在 10⁴–10⁵ 行量级是亚十毫秒操作。日历数据**不进 1s 轮询**（见 28.1），请求频率天然低；webui 侧再加「mtime+size 未变则复用上次解析结果」的进程内缓存兜底高频请求。token 记账的唯一真相即此 usage.jsonl——docs/27 已删除 `token_usage` 表，SQLite 不承载 token 记账（衔接声明见 28.3.5）。

```
GET /eteams-api/team/<teamId>/usage/calendar?year=2026
→ 200 {
  teamId, year, serverTime,
  days: [                       // 该年每天都有一格（无数据日 totalTokens:0），1/1 起至 12/31
    { "date": "2026-09-04", "totalTokens": 64220, "inputTokens": 11240,
      "outputTokens": 860, "cacheReadTokens": 52310, "cacheWriteTokens": 0,
      "reasoningTokens": 512, "calls": 37 }
  ],
  totals: { "totalTokens": 1843200, "inputTokens": ..., "outputTokens": ...,
            "cacheReadTokens": ..., "cacheWriteTokens": ..., "reasoningTokens": ...,
            "calls": 5210, "firstDay": "2026-08-30", "lastDay": "2026-09-04" }
}
```

- 路由落点：`src/host/runtime/webui.ts` 现有 `GET /team/<id>/...` 段（`webui.ts:1489-1561`，`locateTeam` 跨工作区解析团队 → 用 `located.root` 对应工作区的 usage.jsonl 聚合；`sendJson`/`sendError` 复用 `webui.ts:376-391`）。`year` 缺省取本地当前年；`year > 当前年` 返回空 `days`（不 404，便于前端无脑切年）。
- 安全边界沿用 docs/12.5：回环面只读 GET，无鉴权变化。
- 去重：聚合时对 `(sessionId, seq)` 建内存 Set 跳过重复行；撕裂尾行由 `parseJsonl` 容错。
- 该路由**不进**客户端 1s 轮询（28.1），故不做增量协议；如后续要实时感，另开 `afterSeq` 增量参数（docs/12.2 `/events` 先例）。

**全应用口径路由（2026-09-05 用户迭代）**：看板「Token 消耗」卡改为展示**整体应用每天消耗的 token**——不按团队/归属过滤，workspace 桶（普通对话、一次性构建子代理）一并计入：

```
GET /eteams-api/usage/calendar?year=2026
→ 200 { year, teamId: null, serverTime, days: [...], totals: {...} }   // 结构同团队路由，无 teamId
```

- 聚合走 `readAppUsageCalendar(roots, year)`（usage.ts 同一核心，`includeRow` 恒真）：`roots` 取 `collectRoots(ctx, config)` 跨工作区合并台账（全局单库 stateDir 下即一个根；多根合并读时去重键带根序号前缀，防跨根 `(sessionId, seq)` 撞键）。
- `year` 缺省当年、非法值 400、未来年返回零填充格，均同团队路由；不进 1s 轮询（60s 低频轮询同团队路由）。
- 团队路由 `GET /team/:id/usage/calendar` 保留 28.3.2 原语义（归属行按 teamId 过滤），供后续按团队钻取复用。

## 28.5 前端设计

### 28.5.1 依赖：react-activity-calendar 3.2.1（v3，与 React 18 兼容）

- 现版本 **3.2.1**（npm registry 实查，2026-09-04）：`peerDependencies: { "react": "^18.0.0 || ^19.0.0" }`——本仓 `react ^18.2.0`（`package.json:84,184`）满足，**无升级动作**。
- 自带依赖：`@floating-ui/react ^0.27.19`、`date-fns ^4.2.1`（tarball `package.json` dependencies）——随 client envelope 打包，不进 host。
- 安装命令（对齐 lucide-react/@mdxeditor 的 devDependency + 打包模式，`package.json:162-194`）：

  ```
  pnpm add -D react-activity-calendar
  # 落盘 devDependencies: "react-activity-calendar": "^3.2.1"
  ```

  如需在宿主运行时引用（本设计不需要——日历纯 client 面），才考虑加 `peerDependenciesMeta` optional 条目。
- **v3 相对 v2 的 API 变化**（以 tarball `build/index.d.ts` 为准）：
  - `colorScale` prop 更名 **`theme: ThemeInput`**（`{ light: Color[]; dark?: Color[] }`，逐 level 显式给色或给两端自动插值）；
  - tooltip 从 v2「`ref` + 外挂 ReactTooltip」改为**内置 floating-ui tooltip**：`tooltips={{ activity: { text(activity), placement, offset, withArrow } }}`，需引入样式 `import 'react-activity-calendar/tooltips.css'`（包 `exports` 提供）；
  - 保留：`data: Activity[]`（`{ date: 'yyyy-MM-dd', count, level }`）、`colorScheme?: 'light' | 'dark'`、`minLevel`/`maxLevel`（默认 0–4 五档）、`blockSize`/`blockMargin`/`blockRadius`、`showWeekdayLabels`、`labels`、`loading?: boolean`（内置加载态）、`renderBlock`、`weekStart`。
  - **prop 名以安装后的 `build/index.d.ts` 为准**：实现首日按 `node_modules/react-activity-calendar/build/index.d.ts` 校准 `theme` / `tooltips` / `showWeekdayLabels` / `showColorLegend` / `labels` 等 prop 名——本节断言基于 registry 元数据与包描述实查，prop 级未附类型声明行号，属待校准项。

### 28.5.2 「Token 消耗」卡片规格（BoardTab）

位置与容器：`BoardTab`（现 `src/client/pages/teamsView/boardTab.tsx`，原 `src/client/eteamsView.tsx:1000-1146`，结构整改已拆分）**看板顶部**（2026-09-04 用户迭代：位置由「最近动态」卡之后移到看板顶部；样式试过一版去卡壳扁平渲染后定稿——仍按 `Card className={PANEL_CARD_CLASS}` 卡壳渲染，日历与 meta 行在卡内居中显示；组件名 `UsageCalendarCard` 保留），标题行复用 `SECTION_TITLE_CLASS` 并缀 muted「全应用」口径标注（2026-09-05 用户迭代）；meta 行用 `MUTED_CLASS`（类名常量现均在 `src/client/pages/teamsView/shared.tsx`）。数据经 `fetchAppUsageCalendar(year)`（api.ts，`requestJson` 同款，2026-09-05 起替换 `fetchUsageCalendar`）获取，挂载/切年低频触发（60s 可选轮询，`monitor.ts:343` 的 `refreshActivitySoon` 不动）。

| 项 | 规格 |
|---|---|
| 年份切换 | 标题行右侧 `ChevronLeft`/`ChevronRight`（lucide 深层导入，文件头 S 纪律）；未来年禁用；切换即重拉 |
| 亮暗 | `useHostDark()`（先例 `src/client/features/mdEditor/mdEditor.tsx:157-169`，纯移动行号不变：`document.body.hasAttribute('data-ds-dark-theme')` + MutationObserver）→ `colorScheme={dark ? 'dark' : 'light'}`；**不要**省略让它读系统 scheme——宿主 GUI 主题与系统可能不一致（eteams.css 注记「宿主暗色时 body 带该属性」） |
| `theme` 色板（官网 sky 令牌，与 docs/24 D22a 一致；fill 为 SVG attribute，**不用 `var(--token)`**——属性值不解析 CSS 变量） | light `['#f1f5f9','#bae6fd','#7dd3fc','#38bdf8','#0ea5e9']`（slate-100 空档 → sky-200/300/400/500）；dark `['#1e293b','#0c4a6e','#0369a1','#0284c7','#38bdf8']` |
| 几何 | `blockSize=11, blockMargin=3, blockRadius=2, fontSize=12`（面板 14px 基线下的小字档）；`weekStart={1}`（周一开头）；格子无装饰（2026-09-04 用户迭代：`renderBlock` + cloneElement 以 `stroke:'none'` 覆掉包 v3 给每格硬编码的 hairline 描边——light `rgba(0,0,0,0.08)` / dark `rgba(255,255,255,0.04)`，纯色方块扁平风） |
| 标签 | `labels={{ months:['一月',…], weekdays:['日','一','二','三','四','五','六'], totalCount:'{{year}} 年共 {{count}} tokens', legend:{ less:'少', more:'多' } }}`；`showWeekdayLabels={['sun','wed']}`；图例默认显示（`showColorLegend` 不传） |
| level 分级 | 固定「AI 代码工程师强度」标尺（2026-09-05 用户迭代，不再按当年四分位相对划分）：0 tokens 恒 0 档；≤10 万=轻度、≤100 万=常规、≤300 万=高强度、>300 万=满负荷（1–4 档；>500 万同样顶格满负荷色），tooltip 行首标注档位名。某年全 0 时全部 level 0（空档色） |
| tooltip | `tooltips={{ activity: { text: (a) => 分项文案, placement: 'top' } }}`；`text` 闭包内查 `date → day` 映射渲染多行：`9月4日 · 64,220 tokens` + `输入 11,240 / 输出 860 / 缓存读 52,310 / 缓存写 0`（`reasoningTokens>0` 时附「推理 512（可能与输出重叠）」；`calls` 一并展示） |
| tooltip 样式 | `import tooltipsCss from 'react-activity-calendar/tooltips.css'` 字符串模块注入（mdEditor 先例 `features/mdEditor/mdEditor.tsx:85` + `mdEditorCss.d.ts` shim，新增 `usageCalendarCss.d.ts` 垫片）；该样式自带反色 dark（`.react-activity-calendar__tooltip[data-color-scheme='dark']` 是浅底深字），在 `.eteams-ui` 作用域追加覆写为深底浅字以贴面板。**实现时先确认 tooltip DOM 挂点**：floating-ui tooltip 若渲染在 body 根 portal 而非 `.eteams-ui` 子树内，`.eteams-ui` 作用域选择器不命中——必要时把覆写选择器提到 body 级并以 `data-source` 标记限定（eteams.css 暗色块同为 body 后代选择器可覆盖，实测为准） |
| 加载/空态 | 拉取中 `loading`（内置骨架闪烁）；`days` 全 0 或 `totals.totalTokens === 0` → 日历照渲（全 0 档）+ 底部 `MUTED_CLASS` 兜底文案（2026-09-04 用户迭代定稿「今年还没有记录到消耗——成员执行任务后这里会逐日亮起」）；拉取失败 → 卡内 `FormErrorNote`（现 `pages/teamsView/shared.tsx`，原 `eteamsView.tsx:432-447`）+ 日历渲染上次成功数据 |
| meta 行 | 底部 `MUTED_CLASS` 居中一行（用户迭代 2026-09-05 前置当天数字）：`今日 X tokens · 全年合计 Y tokens · Z 次调用`——今日值直接取全年零填充响应里今天那格（客户端本地拼装日键，与宿主 `dayKeyOf` 同构），无需新接口；拉取失败行显示「上次刷新失败」 |
| 无团队 | BoardTab 既有空态分支（现 `pages/teamsView/boardTab.tsx`，原 `eteamsView.tsx:1029-1043`）不涉及本卡；**取数 useEffect 必须置于该早退分支之前**（`rules-of-hooks`：hook 不得放在条件 return 之后）——空态分支只是不渲染本卡，hook 照常挂载 |

日历数据源映射：`days` 直接来自 API（服务端已按日聚合），客户端只做 level 分位与 tooltip 查表，不做任何折算——保证「图即真相」。

## 28.6 边界与性能

### 28.6.1 usage.jsonl 增长控制

- 双阈值轮转：`usage.jsonl` 超过 **2MB** 或包含 **>730 天前**的行时，在写队列空闲点把老行搬入 `usage-archive.jsonl`（`atomicWriteText` 整写新文件 + 原子 rename 交接，docs/09.2 同款降级策略）；日历只查「当前年 + 上一年」，聚合读这两个文件。
- checkpoint 文件按会话最后活跃剪枝（保留 30 天）。
- 量级预算：单会话一个活跃日数百次 model call，行 ~250B；8 成员团队全天高频运转 ≈ 每日数万行 ≈ 数 MB/月——**触阈值即轮转**，因此聚合读取的成本上限恒定（见 28.4 的 mtime/size 解析缓存）。

### 28.6.2 跨年切换

- API 按 `year` 参数过滤；客户端切年即重拉。跨年首条记录写入时不做任何「年末结转」动作（无汇总文件，无状态），轮转由 28.6.1 的 730 天阈值自然完成。
- 上一年数据已轮转出主文件时，聚合读 `usage-archive.jsonl` 兜住（读两个文件合并）。

### 28.6.3 多工作区

- usage.jsonl **per workspace**（`<workspace>/.eteams/usage.jsonl`）：写入时按 `session.header.cwd` 解析工作区（先例 `members.ts:237`——该行为 `child.session?.header?.cwd ?? process.cwd()`，cwd 可缺省且有回退；usage 写入侧保留同一回退，回退生效时 1 分钟节流 warn，防错桶静默）；读路径经 `locateTeam` 拿到 `located.root`（`webui.ts:1492-1497`），只聚合该工作区文件。
- 跨工作区移动团队（docs 现有 locateTeamAcrossWorkspaces 能力）不影响历史行：行内 teamId 快照不变，聚合按 teamId 过滤。

### 28.6.4 时区

- `day` 在**记录时**按宿主本地日界折算（`new Date(event.time)` 的本地日期），日历年/切换年份也按宿主本地年——与用户直觉一致。
- 跨日界的会话（午夜前后一次长 step）按事件时刻归属单日，不拆分；DST 造成 ±1h 归属偏移可接受。
- 若宿主时区后来变更，历史行不变（day 已固化），仅新行按新时区——文档化为已知行为，不做迁移。

### 28.6.5 已知盲区与精度声明

- **out-of-process 子代理**（ACP/远端 provider）的会话日志不在本进程 firehose 内，其 usage 计不到。`memberProvider` 默认 `spawn`（`cordis.patch.yml`），当前成员/领队均为进程内会话，故主路径无影响；将来接入远端 provider 时需在该 provider 侧补计（开放问题 28.8-4）。
- 宕机窗口：`appendFile` 无 fsync（docs/09.6 同源权衡），崩溃丢尾部行 → 低估；watermark 对账只覆盖「会话恢复后 seed 重放」的漏计，覆盖不了「usage 行已写盘但会话日志本身损坏」的极端面（接受）。
- adapter 未上报 usage 的 step 不计（E2）→ 低估不虚高。

### 28.6.6 热路径预算

- `session/event` 对每个事件（含 `assistant/chunk` token 级流）都广播：监听器第一行做类型早退，非 `assistant/message`/`request/header`/`request/context` 直接 return；路线缓存与会话身份表均为 O(1) Map 读写。
- usage 行构造同步、append 异步串行队列、不 await——单事件开销 ≈ 一次 Map 读写 + 队列入队。

## 28.7 实现切面清单（开发照此执行）

| 文件 | 动作 | 改什么（一句话） |
|---|---|---|
| `src/host/runtime/usage.ts` | 新增 | usage 记录模块：`UsageRecord` 类型、会话身份解析（28.3.2 优先级表）、`installUsageMeter(ctx, config)`（根 `session/event` 监听 + 路线折叠 + 水位对账 + 串行追加队列）、`readUsageCalendar(stateRoot, teamId, year)` 聚合器、轮转逻辑 |
| `src/host/index.ts` | 修改 | `apply()` 中调用 `installUsageMeter(ctx, config)`（import 一行 + 一处调用，`inject` 不动） |
| `src/host/runtime/members.ts` | 修改 | `installMemberRuntime` 的 setup hook（227-249 行）内把解析出的成员身份登记进 usage 的会话身份表（`usage.registerMemberSession(childId, {teamId, memberName})`） |
| `src/host/runtime/captainAgent.ts` | 不改 | `captainChildren` 注册表现成可查（usage.ts 事件时读 `captainChildTeamOf`） |
| `src/host/runtime/sessionTeam.ts` | 不改 | `getSessionTeamId` 现成可查（62-64 行） |
| `src/host/runtime/webui.ts` | 修改 | `/team/<id>/...` GET 段（1489-1561 行）新增 `usage/calendar` 子路由 + `days`/`totals` 聚合响应（28.4）+ 解析缓存 |
| `src/client/lib/api.ts` | 修改 | 新增 `UsageDay`/`UsageCalendar` 类型与 `fetchUsageCalendar(teamId, year)`（`requestJson` 同款） |
| `src/client/pages/teamsView/usageCalendar.tsx`（原 `src/client/eteamsView.tsx`，已拆分；`BoardTab` 挂载点在 `boardTab.tsx`） | 修改 | BoardTab 新增「Token 消耗」卡（年切换、`ActivityCalendar` 接线、level 分位、tooltip 分项、loading/空态，28.5.2 规格）；引入 `useHostDark`（从 mdEditor 提取或复制并注明先例） |
| `src/client/hooks/useHostDark.ts` | 新增（可选） | 把 `features/mdEditor/mdEditor.tsx:157-169` 的 hook 提为共享模块，mdEditor 与日历卡共用（不提取则复制 8 行） |
| `src/client/types/usageCalendarCss.d.ts` | 新增 | `declare module 'react-activity-calendar/tooltips.css'` 垫片（对齐 `types/mdEditorCss.d.ts`） |
| `package.json` | 修改 | devDependencies 加 `react-activity-calendar: ^3.2.1`（`pnpm add -D`），构建后记录 `lib/client.js` 体积增量（docs/21 纪律：预计 +120KB min / +35KB gzip 级，实测为准） |
| `tests/usage.test.ts` | 新增 | vitest：归属优先级表、usage.jsonl 聚合/去重（`(sessionId,seq)`）、撕裂尾行容错、轮转阈值（对齐 docs/16 验收口径） |
| `tests/webui.test.ts` | 修改 | `GET /team/<id>/usage/calendar` 路由契约用例（现有路由测试文件内追加） |
| `docs/27-sqlite-schema.md` | 已定稿（联动） | token 记账不进 SQLite：27 已删除 `token_usage` 表、`idx_token_*` 索引与查询 Q7–Q9，SQLite 与 usage.jsonl 的分工声明见 28.3.5（27.9-1 为定案引用记录） |
| `docs/README.md` | 已增补 | 阅读顺序表补 27/28/29/30 四行（2026-09-04 随三篇落位一并完成） |
| `docs/12-http-api.md` | 修改 | 12.2 读路由表追加 `GET /team/<teamId>/usage/calendar?year=<y>` 行 |

验收面（照 docs/16 惯例）：装机后团队跑一轮任务 → 看板出现非空日历格；当日 tooltip 五分项正确；切年返回空 days 不报错；亮/暗主题下色板正确；`pnpm typecheck && pnpm lint && pnpm test && pnpm build` 四绿。

## 28.8 开放问题

1. **reasoningTokens 与 outputTokens 的重叠语义**：E1 只声明 input 三项互斥，reasoning 是否含在 output 需对 DeepSeek adapter 实测；结论影响 tooltip 口径与是否计入 totalTokens（28.3.3 已按「不计入」保守处理）。
2. **usage 上报缺口**：哪些 provider/adapter 会在 `assistant/message` 缺 `usage`（E2 允许缺省）？需装机实测一轮（与 28.8-3 的归属矩阵合并执行：主会话 + 成员/领队子代理 + 面板绑定会话 + 构建子代理）确认计量覆盖率，必要时在 tooltip/文档标注「部分调用未上报」。
3. **E8 未打标监听语义与归属矩阵的装机验证**：设计依据 `dsh-scope` 类型注释与 cordis/carry 实现推得「插件级监听者收全量会话事件」（另有 E18 的 dsh-session-persistence 第一方同型先例），需装机冒烟确认。**归属冒烟矩阵**（与 28.8-2 的覆盖率实测合并为一组用例）：成员子代理 / 领队子代理 / 领队主会话 / 面板绑定会话 / `eteams-rolebuilder` 构建子代理各跑一次，逐条核对 usage.jsonl 行的 `roleKind` / `teamId`（28.3.2 优先级表 1–5 行各至少一例）。**若证伪 A**：先验证 B 方案 childCtx 监听的实际覆盖面（28.2.3-5 未核实项）再动工，必要时以 cordis 监听 `{ global: true }` 绕过 scope 过滤兜底；装机项另核 `ctx.sessions.list()` 含成员/领队子代理会话（28.3.4 对账面的前提，E10/E18）。
4. **远端/ACP 子代理**：out-of-process 会话不计（28.6.5）；若后续 memberProvider 支持远端，需与 dsh-session-projection 一样在远端侧补计量面。
5. **`sessionProjections` 备选**：若未来要「跨进程/框架级检查点」，把 28.3.4 的自管 watermark 换成注册 `eteamsUsage` 投影单元（E16）——需先验证部署装配里 `ctx.sessionProjections` 可注入并评估 optional inject 的降级路径。
6. **workspace 桶视图**：未归属消耗（普通对话、构建代理）已在记录，是否补一张工作区级日历/统计页另立文档。
7. **文档编号**：docs/27（SQLite schema）、docs/29（子任务拖拽）与本文同期落位（并行设计面），README 阅读顺序表需三篇一起增补。