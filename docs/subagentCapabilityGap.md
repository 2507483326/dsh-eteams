# 子代理能力缺口：检测、分级与结构性升级（2026-09-16）

## 边界（必读，本方案的地基）

方案建立在承认三件做不到的事之上——不承认它们，后面每一条都会设计错：

1. **我们无法给子代理授权。** in-process 子代理的审批策略在委派时被钉死为 `never`，而
   `never` 在服务内部、waterfall 分发之前就短路成 `rejected`——**任何消息、任何表格、任何
   应答者都注入不进一个 `allowed-once`**。沙箱范围同理：只在委派瞬间快照，事后父会话切档
   不追溯（durable pin）。所以「升级 → 拿到许可 → 子代理自己跑」这条回路**不存在**。
2. **被拒是个好信号，不该被绕开。** 一次拒绝是确定的（不是挂起）、带审计的、带指引文本的、
   且不杀回合的。它比任何事前猜测都准——尤其因为子代理**根本不知道**父会话的审批策略。
   所以判定应当**反应式**（先试、读拒绝），而不是先验式（猜我会不会被拒）。
3. **分类器不改变权限。** 它只决定「被拒之后怎么办」。判错的代价是**一次多余的往返**或
   **一份标注了限制的产出**——可恢复，不是安全事故；反过来，**绝不能让它成为安全边界**。

**由此得出本方案的形状：不为每一次操作求许可，而是尽早、准确地识别「本站需要的能力超出我的
范围」，把它作为一次*结构性*决定上报，让有权限的一侧去解决。**

## 背景与问题

现状（`docs/unifiedSubConversationAsks.md` 之后）是：子代理遇到阻塞，走
`eteams_send_message to="captain"` 报障碍，或 `eteams_fail_task` 让自动重试耗尽后落 `wait`，
领队再分诊成 `reassign` / `escalate_task → wait_user`。这条链有两个缺口：

- **成员分不清「我方法不对」和「我需要我没有的能力」。** 前者应当自己换法子接着干
  （Claude Code 的 `DENIAL_WORKAROUND_GUIDANCE` 明确许可「用 `head` 代替 `cat`」这类绕行）；
  后者必须上报。现在两者都走同一条「报障碍」，于是要么把可自解的问题升级上去烧人类时间，
  要么把能力缺口当成普通失败硬撑重试。
- **上报的是「我卡住了」，不是「我需要什么」。** 领队拿到的是一个阻塞，做不出结构性判断
  （改派？放宽后重派？这一段自己跑？），只能再往上抛给用户。
- **同类缺口被反复升级。** N 个成员卡在同一类操作上，就弹 N 次窗。

参照系：Claude Code 在**结构**层解决（swarm worker → leader 的授权通道 + `permissionMode:
'bubble'` + sync/async 区分），分类器只负责**减少打扰**（`awaitAutomatedChecksBeforeDialog`：
"the user should only be interrupted when automated checks can't resolve the permission"）。
**分类器做过滤，结构做路由。两者正交。** 本方案照这个分工：分类器**只**用来分辨
「换法子」与「缺能力」，路由交给既有的消息/升级通道。

## 决策

1. **触发点＝反应式**：子代理先做，撞到拒绝才判定。不做事前预测（它没有谓词）。
2. **分类器的职责收窄为二选一**：这个拒绝是 `self-resolvable`（换法子能过）还是
   `capability-gap`（换法子也过不去）。**不判断「该谁执行」**——那是结构的职责。
3. **确定性优先**：越界与否用路径/模式判断（子代理运行时上下文里有 `sandbox:policy`：模式 +
   workspace root），不烧模型；只有残余才进分类器。
4. **能力缺口是三档，不是两档**：`self-resolve` / `report-gap` / `refuse`。`high` 档**不升级**
   ——永远不要请人类授权外泄类操作，直接失败并报告。
5. **能力缺口不改任务状态**：任务仍在执行中，只是这一轮在等一个结构性决定。走 `ask_questions`
   的 pending 行做可视（面板「待问答」徽标现成）。**只有**缺口超时未决或被判「无法解决」时，
   才落 `eteams_fail_task` → 走既有的重试超限 → `wait` → 领队分诊链。
6. **升级的载荷是「缺口报告」，不是「请批准这条命令」**：需要什么能力、为了哪个验收标准、
   已试过什么替代、建议怎么解决（`widen-and-redelegate` / `main-executes` / `split-stage`）。
7. **同类缺口合并**：由领队把同一任务/同一团队下的同类缺口合成**一次**问询或一次结构决定。
8. **一次结构决定沉淀为「常设路线」**（routing memo），让后续同类操作不再重复升级。
   **注意：这是路由备忘，不是授权**——它记住的是「这类活儿以后谁来干」，不是「子代理被允许
   干什么」。
9. **独立成表，不关联问答单**：`capability_gaps` + `routing_memos` 各自独立，**没有** `askId`
   之类的跨表关联。人类介入只发生在两处——主会话执行时的**原生审批流**，或领队用**既有的**
   `eteams_ask_user` 问路线；两者都不需要缺口表参与。理由见「存储与落点」。

## 判定环

```
子代理执行 → 被拒（DSH 审批拒绝 / 沙箱拒绝 / 工具自身报错）
   │
   ├─ Layer 0 确定性预筛（零模型调用；**宿主侧只做后三条**）
   │    · 越界？   上报方对照自己 runtime-context 里的 sandbox:policy（模式 + root）判「这是
   │              能力越界还是普通报错」——宿主拿不到这份上下文，故由上报方判定；
   │              普通报错 → 走既有 fail/retry 链，与本方案无关（不跑后续）
   │    · 高风险？ risk=high 或上报方自判 refuse → 拒（不落表、不升级）
   │    · 已定路线？同 (team, task, 操作类) 命中常设路线 → 直接按路线走，不再升级
   │    · 已报过？ 同任务同操作已有 open 缺口 → 去重，复用那一行
   │    ↓ 残余
   ├─ Layer 1 分级（**由上报子代理自己判定**，宿主不收模型面——见下方说明）
   │    self-resolvable → 自己换法子接着干，eteams_append_progress 记一笔，不打扰任何人
   │    report-gap      → 生成缺口报告，进 Layer 2
   │    refuse          → 不升级，eteams_fail_task 并把风险写清楚
   │
   └─ Layer 2 升级路由（复用既有骨架）
        · 领队可见（eteams_send_message to="captain" 唤醒 + capability_gaps 落行）
        · 领队合并同类 → 结构化决定：
             widen-and-redelegate → 请主会话放宽父会话范围后重新委派（丢状态，仅当本站可重跑）
             main-executes        → 宿主**自动**把操作（来源 + 精确 argv/cwd）作为消息交给
                                    主会话（子 → 父相邻投递），由它主动执行；人类由主会话的
                                    原生审批流问到
             split-stage          → 把这一站拆出来交给有权限的一侧（推荐：循环型工作）
        · 路线本身只有用户能定 → 领队用**既有的** eteams_ask_user 问（不建任何跨表关联）
        · 决定回传 → 记常设路线（若有普遍性）→ 子代理按路线继续
```

**关键设计点：Layer 2 的三种解决方式里，只有 `main-executes` 与 `widen-and-redelegate` 能真正
让活儿干成。** `main-executes` 适合一次性操作；`widen-and-redelegate` 适合本站可整体重跑；
**循环型工作（build-test-fix）必须走 `split-stage`**——把整个循环挪到有权限的一侧，因为逐次代执行的
往返成本会吃掉收益（见「分阶段」P2）。

## 载荷：能力缺口报告

```jsonc
{
  "gapId": "uuid",
  "teamId": 3,
  "taskId": 71,
  "attemptId": 210,               // 有 attempt 时带（token 与之一致）
  "askingSessionId": "...",       // 提问子代理会话（面板定位 + 来源）
  "askingName": "前端开发",
  "stationIndex": 1,              // 执行链站点（领队据此判断是「这一站的固定需求」还是偶发）
  "kind": "capability-gap",       // self-resolvable 不进本表
  "risk": "medium",               // 分级结果；high 一律 refuse、不落表
  "operation": {                  // 精确到什么被拒（给人读的说明 + 可执行的精确命令，分两栏）
    "summary": "运行 npm run build 生成 dist/",
    "argv": ["npm", "run", "build"],
    "cwd": "C:/eTeam",
    "writes": ["dist/**"],        // 预期副作用（给人读，仅供参考）
    "reason": "denied by approval/sandbox"  // 拒绝来源标记
  },
  "why": "验收标准第 2 条要求产出可运行构建产物",   // 挂钩验收标准，而非「我觉得需要」
  "alternativesTried": [          // Layer 1 判 self-resolvable 失败后的残余
    "改用 tsc --noEmit 做类型检查（通过，但不产出构建产物）",
    "子集构建只覆盖 src/ 下的模块（仍被拒）"
  ],
  "suggestedRoute": "main-executes",  // 模型建议，领队/人类可推翻
  "status": "open",               // open | routed | resolved | refused | expired
  "route": "main-executes",       // 最终采用的结构决定
  "routeNote": "...",             // 决定理由 / 用户原话
  "decidedBy": "captain",         // captain | user
  "decidedAt": 1758000000000,
  "createdAt": 1758000000000,
  "updatedAt": 1758000000000
}
```

设计要点：

- **`operation` 分「给人读的说明」与「可执行的精确命令」两栏，但两栏都由上报方填写。** 宿主
  的职责是把它们**分开存、分开用**：`summary`/`writes` 只给人读（面板、问询选项描述），
  **绝不参与构造命令**；`argv`/`cwd` 结构化、可原样交给执行侧，也是路线键归一的输入。
  这条针对混淆代理：执行侧看到的是**这条精确命令本身**，据此判断能不能做；若只有一段散文，
  判断就退化成「相信子代理的描述」。
  **口径要说准**：宿主只校验 `argv`/`cwd` 的**形状**（非空、无换行），**不校验真伪**——
  保证的是「精确、可原样执行、可审计」，不是「可信」。
- **`why` 必须挂验收标准。** 没有验收标准挂钩的缺口不成立（否则「我觉得需要」会变成特权的
  滑坡）。
- **`stationIndex` 是给领队做结构判断用的**：同一站点反复出同类缺口 = 这一站本身就需要该能力，
  应当在计划里解决（改派/拆站），而不是一次次救火。

## 存储与落点：独立成表，不关联问答单

**结论（2026-09-16 修订，推翻前一版的「分层合表」）：`capability_gaps` 独立成表，且与
`ask_questions` 没有任何关联列。**

前一版说「能合用，但只该合人面前那一段」——那是**在回答一个基本不存在的问题**。追一下
「人面前那一段」到底是什么，会发现它通常不是「一个问题」：

### 缺口的「人」是被主会话的原生审批流问到的，不是被缺口问到的

`main-executes` 的本质是「**把操作交给有权限的一侧**」，而不是「问用户一个问题」：

1. 成员被拒 → 报缺口 → 领队定路线 `main-executes`；
2. 领队把「来源 + 精确 `argv`/`cwd`」作为**消息**交给主会话；
3. 主会话执行时若需要授权，**DeepSeek 的原生审批流会自己去问用户**——那份
   `approval/request` 挂在**真实的工具调用**上（带真实参数、在用户正看着的那个会话里）。

这比再造一个合成弹窗**更好**：原生弹窗挂在真调用上，合成弹窗只能挂在问题文本上。所以缺口
**不需要**自己的弹窗，**也不需要**用户答完再把答案回传给它——主会话那边就是终点。

### 领队真正需要问人的是「路线」，而那不需要任何新集成

如果路线的选择本身只有用户能定（改计划、丢状态、砍验收标准），领队就让用户拍板——**用它
本来就有的 `eteams_ask_user`**，和它处理任何其它未决项一模一样。答案回到领队手里，领队自己
握着「这是哪个缺口」的上下文，随后调路线工具即可。**跨表关联在这里没有任何用**：`askId` 是
多余的，所以把已经落地的它拆掉了。

### 那为什么不能干脆合表？（这一段的结论没变）

**A. 全合（`ask_questions` 加 `kind` + nullable `payload` 列）**

- **每个现成读者都要补 `kind` 过滤**：`readPendingAsksSync`、`readRecentAsksSync`、
  `readAllPendingAsksSync`，以及 webui 路由与看板「决策面板」历史。**漏一个就静默错渲染**
  ——缺口会混进「待问答」徽标和「已决策」历史，且形状客户端渲染不了。
- 状态机要放宽成一个 enum 装两套：`pending → answered | expired | cancelled` 与
  `open → routed → resolved` 混在一起，每个 kind 都带一串不可达态。
- **最要命的一条：缺口根本不一定要经过「决定」。** 领队可以直接按常设路线转交、也可以判定
  这是 `refuse` 档直接失败——这两种都不产生任何问答单。硬合的话，你得在问答表里塞一行
  **既没有 question 也没有 answer** 的记录——那不是这张表的形状。
- 且违反仓库自己的先例：`decisions`（领队分诊）与 `ask_questions`（用户问答）**都是
  「需要有人决定」却没合表**，因为写路径与生命周期不同（见下）。

**B. 分层合（前一版的写法，已否）**：把缺口的结构数据放新表、把人面前那一段挂到
`ask_questions` 并用 `askId` 互指。既然「人面前那一段」通常不存在（见上），这一层就只剩下
一个多余的列和一条多余的写路径。

**C. 独立成表（采用）**：`capability_gaps` + `routing_memos` 各自独立；人类介入只发生在
两个地方——**主会话的原生审批流**（执行时），或**领队用既有的 `eteams_ask_user` 问路线**。
两者都不需要缺口表参与。

### 为什么新表不随 TeamState 整存整取

仓库里现有三种形态，各有其位，**新表照 `ask_questions` / `events` 那一型**：

| 表 | 写路径 | 状态机 | 读端 |
| --- | --- | --- | --- |
| `decisions` | **TeamState 整存整取**（open 行删重建，resolved 行留档） | `open → resolved` | 看板 Q9 待决策横幅 |
| `ask_questions` | **独立行 CRUD**（`*Sync` 直写，不随团队写） | `pending → answered/expired/cancelled` | 面板「待问答」徽标 + 决策面板历史 |
| **`capability_gaps`（新）** | **独立行 CRUD** | `open → routed → resolved/refused/expired` | 看板「能力缺口」筛选 + 领队 |

缺口是**执行期随时产生**的（不像 `decisions` 由领队分诊那一刻产生），所以不能随团队写连坐；
但它内部要按 `*InTx` / `*Sync` 双形态提供——**当路线决定要与任务改动同事务落盘时**
（例如「改派 + 记路线」必须原子），走 `*InTx` 并入调用方的 `withTeamTx`；独立产生时走 `*Sync`
直写。两条路径与 `events.ts` 同型，`store.ts` 顶部那条纪律照抄：
**事务内不得嵌套 `withTeamTx`**。

- **上升通道复用 `mail_messages`**：成员落 `capability_gaps` 行后，照既有纪律
  `eteams_send_message to="captain"`（正文带 `gapId` 与一句话摘要）唤醒领队。**不改消息表结构。**
- **交付给主会话也走消息**（P2）：领队把「来源 + 精确 `argv`/`cwd`」发到主会话，由主会话
  **主动**执行——不是把命令塞进某个队列等它自动跑。人类在这条路上由主会话的原生审批流问到。
- **领队要问用户时用既有的 `eteams_ask_user`**：路线本身是用户级决策时才发生，且**不需要
  缺口表参与**、不需要 `askId`。问题文本仍按既有口径自我承担（自包含 + 说人话 + 选项写清后果）。
- **常设路线表 `routing_memos`**：`(team_id, task_id NULLABLE, operation_class, route, note,
  decided_by, created_at, expires_at)`。`operation_class` 由**宿主**归一（基命令 + 相对 cwd 的
  规范化前缀），**不接受模型自由写的模式串**。
- **面板**：看板页复用「待问答」同款的 pending 可视（缺口也是未决项），加一个「能力缺口」筛选；
  缺口行可点进任务。

## 分级口径（Layer 1）——由上报方自判，不是宿主调模型

**实现修正（2026-09-16，落地时发现）**：原稿写「宿主调一次模型做分级」，但
`RuntimeContext` 里**没有 llm 面**——宿主调不了模型。而且分级要判的恰是「换做法能不能过」，
**只有刚撞到拒绝的那个子代理知道**（它试过哪些替代）。所以分级由上报方自己做，口径写在
`eteams_report_gap` 的 description 里；宿主负责它才做得了的三件事：确定性预筛、校验落表、
结构性活动的原子落地。

上报方拿到的输入只有：被拒的那次调用（工具名 + 参数 + 拒绝来源标记）、它自己的
`sandbox:policy` 行（模式 + workspace root）、该任务的验收标准、以及 `alternativesTried`。
**不喂历史、不喂父会话策略**（它本来就没有）。

```
你在判断一次被拒绝的工具调用属于哪一类。只输出一个 JSON，不要解释。

判定标准（按优先级）：

refuse —— 该操作涉及把当前信任边界内的数据送出去（外发、上传、写凭据、
          绕过安全机制）。这一类永远不升级，直接失败并报告风险。
          → {"verdict":"refuse","reason":"..."}

self-resolvable —— 拒绝的原因是**做法**，换一个等价或更保守的做法就能达成同一个目标，
          且不需要任何额外权限或放宽范围。
          例：用 head 代替 cat；用 --noEmit 做类型检查代替完整构建；写进工作区内
          允许的目录代替写系统目录。
          注意：**"重试同样的事"不是 self-resolvable。**
          → {"verdict":"self-resolvable","next":"<具体换法>","reason":"..."}

report-gap —— 换做法也过不去：需要超出当前范围的能力（越出 workspace root 的写入、
          需要网络、需要执行宿主禁止的命令类别），或拒绝来源是策略而非做法。
          → {"verdict":"report-gap","risk":"medium","suggestedRoute":
             "main-executes"|"widen-and-redelegate"|"split-stage",
             "why":"<挂到哪条验收标准>","reason":"..."}

suggestedRoute 的选择：
  main-executes        —— 一次性操作，做完就好
  widen-and-redelegate —— 本站整体需要该能力，且可以整体重跑（子代理重建可接受）
  split-stage          —— 该能力会被反复用到（构建/测试/部署这类循环），
                          应当把这一站整体交给有权限的一侧

不确定时必须报 report-gap，不要报 self-resolvable。
```

（与 Auto review 的口径差异要说清：Auto review 的分级**产出结论**（allow/deny），我们的分级
**产出通道**（自解/上报/拒绝）。这是两件事，别把提示词写成前者。）

## 常设路线（routing memo）——安全约束

这是本方案里唯一有特权风险的表，约束必须写死：

- **只记路由，不记权限。** memo 回答「这类活儿以后谁来干」，**绝不**被解读成「子代理被允许干」。
  执行侧看到 memo 时的动作是「按既定路线转交」，不是「放行」。
- **`operation_class` 由宿主归一**，不接受模型自由写的前缀/通配。至少包含：基命令 + 规范化 cwd。
- **作用域收紧**：`(team_id, task_id)`，**跨工作区不继承**——在 A 工程批的路线不能用到 B 工程。
- **有寿命**：`expires_at` 默认到主任务收口；不做永久环境特权。
- **来源可查**：`decided_by`（captain / user）+ 关联 `gapId`，面板可回溯「谁在什么时候定的」。
- **危险操作不进 memo**：`refuse` 档永不落 memo；删除类、凭据类、外发类一律每次重问。

## 分阶段

- **P1（先做这个，收益最大）**：Layer 0 确定性预筛 + Layer 1 分级口径 + 缺口报告落表 +
  成员/领队提示词改口。产出：成员不再把「方法不对」升级上去、不再把「缺能力」硬撑成失败；
  领队拿到的从「我卡住了」变成「我需要什么 + 建议怎么办」。**不碰执行侧。**
  - 落地进度（2026-09-16）：**P1 完成（存储层 + 运行时编排 + 工具面 + 提示词口径）** ——
    `state/gaps.ts`（双形态写助手 + 操作类归一 + 路线命中）、`runtime/gaps.ts`（Layer 0 预筛 +
    落表 + 结构性决定的原子落地）、`tools/gapTools.ts`（`eteams_report_gap` 上报：根作用域、
    全体子代理可用、不进任何 deny 列表；`eteams_route_gap` 处置：领队面，加进
    `MEMBER_DENIED_TOOLS`——成员不能给自己定路线，执行体另有 `resolveCaller` 门禁）、
    schema v16（`capability_gaps` + `routing_memos`）。**提示词口径已落地**：成员侧
    （`prompts/spawn/member.ts` 的两条常驻纪律 + 工具速查 + 简报「实时汇报」第 3 条）、领队侧
    （`prompts/spawn/captainChild.ts` 新增「能力缺口处置」纪律）、分诊邮件
    （`prompts/handoff/mails.ts` 的失败·待领队三条路径含缺口）。
    剩余：**面板「能力缺口」读端**（看板筛选 + 详情，复用「待问答」待决可视的做法）——
    这是「人可见」的最后一环；P2 的交付动作已完成（见下）。
- **P2（让活儿真正干成）：已完成（2026-09-16）。** 领队定下 `main-executes` 后，宿主**自动**
  把「来源 + 精确 `argv`/`cwd`」作为**消息**发给主会话——`runtime/gaps.ts` 的
  `handoffToMain()` 走 `subagents.sendMessage` 的**子 → 父相邻投递**（主会话是领队子代理的
  父），目标会话取「小任务 → 其大任务行」的 `mainSessionId` 快照（与 `eteams_ask_user` 同口径）。
  三件必须写进正文的事：**来源**（任务 / 上报人 / gapId）、**精确 `argv` + `cwd`**（执行侧按它
  构造命令、不按散文）、**不要转回成员**（成员在同样的限制里，转回去只会再被拦一次）。
  - **四条失败路径一律只降级、不抛**：无锚会话 / 调用方就是主会话（不自投）/ 宿主缺
    `sendMessage` / 投递抛错。**路线已经落库了，交付失败不该让处置回滚**——指引改成
    「需要你手动交付」并把原因带上，由领队补一条 `eteams_send_message`。
  - 其余两条路线（`widen-and-redelegate` / `split-stage`）**不触发交付**（不额外发消息）。
  - `main-executes` 的含义仍然不是「代执行 relay」：**不回传输出**——主会话那条路自己闭环
    （执行时由它自己的原生审批流问人、由它自己判断结果），回传只会制造第二份真相。
- **P3（减少打扰）**：照 Claude Code 的 `awaitAutomatedChecksBeforeDialog` 思路，在
  **报 gap 之前**先跑自动判定（历史同类是否已有路线、缺口是否为 `refuse` 档），只有判定不出
  才落到人。以及领队侧的同类缺口合并。
- **P4（可选）**：把 `routing_memos` 喂给 `stageBrief`，让「这一站需要什么能力」在**计划期**
  就写清——这是最省事的一条，可能比运行期判定更有效。

## 明确不做

- **不做「为一次操作求一个许可」的逐次批准。** 逐次批准在循环型工作上成本失控，且它假装解决了
  一个我们解决不了的问题（子代理仍然没有权限）。
- **不做权限下发/自动放行。** 我们改变不了 DSH 的策略；任何「我们记了 memo 所以放行」的设计
  都是错的。
- **不用分类器做事前预测或路由决策。** 只做「换法子 vs 缺能力」的二选一。
- **不改 `ask_questions` 的形状**，不把缺口塞进现有问答单。
- **不碰 DSH 的审批/沙箱语义**（那是别的包 owner 的事，且明确 deferred）。
- **不唤醒任何 LLM 做纯机械的路由**（`unifiedSubConversationAsks.md` 已确立的纪律）。

## 验证

- `pnpm typecheck && pnpm lint && pnpm test` 全绿。
- 测试面（✅ = 已落地，文件名为实际名）：
  - ✅ `tests/capabilityGapStorage.test.ts`（23 用例）：`operationClassOf` 归一（任意代码基命令取
    完整 argv、非任意取首个非选项参数、剥路径/扩展名、工作区根折叠）与形状守卫（拒通配）；
    落表闸（`high` / 空 `why` / 空 `argv` 一律拒收）；读端过滤与坏 JSON 容错；
    生命周期与**先决者胜**（返回值标明谁赢）；路线作用域/过期/唯一性/安全闸；
    `*InTx` 随事务回滚（「改派 + 记路线」原子性）。
  - ✅ `tests/capabilityGapRuntime.test.ts`（13 用例）：Layer 0 四条判据（`self-resolvable` 不落表、
    `high` 与自判 `refuse` 拒收、同操作同任务去重、不同任务各留一条）；`applyGapRoute` 写路线 +
    沉淀路线并返回备忘号；沉淀后同类操作命中 `known-route`；**输家不改路线也不沉淀**。
  - ✅ `tests/gapTools.test.ts`（21 用例）：**上报面**——入参校验（`report-gap` 必带 `why`、
    `self-resolvable` 必带 `next`、argv 形状拒空/拒换行、`suggestedRoute` 枚举收口）；身份解析
    （成员/领队按团队，路人原样抛错）；团队/任务由身份派生、**站点下标由执行链按工号派生**
    （不让上报方自报）；high 与 self-resolvable 不落表；同墙二报 deduped；沉淀后 known-route
    并回「不要自己重试」。**处置面**——领队定路线 → `routed` 且缺省 `decidedBy=captain`、未开
    memoize 时明说「下次还会来问」；memoize 后返回备忘号且同类操作直接命中 `known-route`；
    **成员被身份门禁拦下**（缺口保持 open）；**跨团队守卫**（第二个团队的领队处置不了，
    单库多团队共用状态根）；已处置回 `already-decided` 且不覆盖既有路线；`route` 未知 /
    `gapId` 缺失 / 缺口不存在一律拒收。
  - ✅ 提示词口径断言：`tests/memberBriefing.test.ts`（成员常驻规则含三分判定与
    `eteams_report_gap`、工具速查列出它、简报「实时汇报」第 3 条写明「先报缺口再报领队然后停下」、
    失败·待领队邮件给出三条分诊路径含 `eteams_route_gap`）+ `tests/captainDispatch.test.ts`
    （领队「能力缺口处置」纪律含三条路线名、「不要自己去跑那条命令」、`memoize=true`）。
  - ✅ P2 交付动作：`tests/capabilityGapRuntime.test.ts`（`handoffTextOf` 正文写全来源/
    精确 `argv`+`cwd`/为什么/已试替代/「不要转回成员」；`mainSessionIdOfGap` 小任务锚到大任务 +
    两级回退 + 缺任务返回 undefined；`handoffToMain` 成功投递且目标与正文正确，**四条失败路径
    全部只降级不抛**）+ `tests/gapTools.test.ts`（领队子代理定 `main-executes` → 自动投递
    `handoff:true` 且正文带 gapId 与 `argv`；投递抛错 → `handoff:false`、指引改为手动、**路线仍
    落 `routed`**；其余两条路线不发消息；调用方即主会话时不自投）。
  - ⏳ 缺口与问答的隔离断言（面板读端落地后补）：`readPendingAsksSync` / `readRecentAsksSync` /
    `readAllPendingAsksSync` 的返回**不含**缺口数据（既有读者不受影响）。缺口表**没有**关联
    问答单的列——已由 ✅「缺口不落关联字段」用例覆盖。
- 手动场景清单：
  1. 成员撞到沙箱越界 → 自己对照 `sandbox:policy` 判「是能力越界」→ 报缺口 → Layer 0 预筛放行
     落表 → 领队收到带 `gapId` 的消息；面板「能力缺口」出现 pending。
  2. 领队 `eteams_route_gap` 定 `main-executes` → 缺口转 `routed`，且**主会话自动收到一条带
     来源与精确 `argv`/`cwd` 的代执行请求**（主会话执行时若被要求授权，用户会被原生审批流问到
     那一次真实的工具调用）；同类反复出现时带 `memoize=true` 沉淀常设路线，此后同类操作
     **不再升级、不再重复上报**（直接命中 `known-route`）。
  3. 同一个成员第二次撞同一堵墙（同任务同命令）→ Layer 0 判 `deduped`，复用原行、不重复弹窗。
  4. 成员用了会被拒的写法但换法子能过 → 分级判 `self-resolvable` → 成员换法继续，**用户全程无感**。
  5. 循环型需求（构建/测试）→ 分级建议 `split-stage` → 领队把该站改派给有权限的一侧，
     而不是让成员逐次求批准。
  6. 外发类操作被拒 → `refuse`，不弹窗、不升级，失败并把风险写清楚。
  7. 成员试图自己给自己定路线 → 被拒见 + 执行体门禁两道拦下，缺口保持 `open`。

## 与其他文档的关系

- 前置：`docs/unifiedSubConversationAsks.md`（问答统一；本方案复用其落点判定与审计行纪律，
  不另造第二套路由）。
- 相邻：`docs/taskChainWeakOrder.md`（执行链 —— `split-stage` 建议落在链站点上）、
  `docs/taskOrchestrationRefinement.md`（领队分诊 —— 缺口是 `wait` 分诊的一个新输入）。
- 上游约束：DSH 的 `subagent-approval-pinned-never` 与 `subagent-policy-inheritance` 两份
  Agent Note 决定了本方案的边界（见文首「边界」）。
