# 子对话问答统一 + 原生弹窗直弹主对话（2026-09-10）

## 背景与问题

统一之前，插件的「子对话问答」有三条不同逻辑的路：

1. **成员/领队问答**（`eteams_ask_user`）：presence 判定用户在不在看提问会话——在 → 就地弹；不在 → 把问题**转交主会话**弹出（唤醒主对话 LLM 重弹原生 `ask_user_question`），用户答后主对话调 `eteams_ask_answer` 回收，宿主再 `wakeAskingChild` 唤醒提问方。提问方结束回合挂起等唤醒。链路长、烧主对话 token、唤醒时序脆弱（用户不答就永远悬着）。
2. **构建师访谈**（`eteams_build_report(interview)`）：同一套路由判定但另一套机制——`popSelf` 指引、`publishBuilderAsk` 转交构建父、`eteams_interview_answer` / `eteams_ask_answer` 双回收入口、`popFailed` 补转、`markInterviewRouted` 路由痕迹字段。
3. **主对话提示词里养着一段「转交协议」**（`sessionTeam.ts` band）：教模型收到【eteams 用户问答转交】后代弹/代提交——把本该纯机械的路由塞进了 LLM 的回合里。

三条路三个心智模型，提示词要教、测试要铺、出错面（唤醒丢失、双入口竞态、面板与弹窗互相覆盖）各自独立。

## 决策（用户拍板，两轮）

1. **统一深度 = 完全统一**：构建师访谈也走 `eteams_ask_user`；`eteams_ask_answer`、`eteams_interview_answer`、publishBuilderAsk 转交、popFailed 补转、steering 提示词（`ask.ts` / `interview.ts`）、主对话转交协议**全部退役**。
2. **弹窗目标 = 用户当前所在会话，否则提问方所属的主对话**（用户迭代「直接调用 DeepSeek 的弹窗，而且应该只弹它自己的主对话」；2026-09-12 修订「弹窗问题还是一样的，需要判断用户当前在那个会话，如果在当前会话就弹当前会话，不在就弹主会话」）：不造任何自定义提醒 UI，直接用 DeepSeek 原生问答弹窗。落点判定先查客户端上报的活跃会话心跳 presence——命中提问会话自身（用户正看着那个子对话）就**就地弹**；否则弹任务锚 `mainSessionId` / 构建父会话记录的主对话——用户通常在主对话里，弹窗直接接管它的输入区。第一版「输入区提醒条 + sessions.open 跳转」的自定义 dock 因观感不佳整删。

## 统一后的唯一问答路径

```
子代理（领队/成员/构建师）调 eteams_ask_user
  ① 审计行落 ask_questions（status=pending，askingSessionId=提问会话自身）
  ② ctx.userQuestions.ask({agent}) 弹原生问答弹窗——agent 按优先级取：
     a. 提问会话自身（presence 命中）：readBuildPresence 记的活跃会话恰是
        提问子代理的会话（用户正看着那个子对话）→ 就地弹，用户当场作答
     b. 主对话（默认）：成员按自己大任务的任务锚 mainSessionId、领队子代理
        按注册表记录的主任务锚、构建师按构建受理时落盘的父会话 id；
        agents.get(sessionId) 命中 = 主对话在线，弹窗直接接管它的输入区，
        用户在自己的窗口里作答（无须任何跳转/提醒）
     c. 提问会话自身（兜底）：主对话不在线（agents.get 查不到活根）或
        弹窗被拒（CALLER_NOT_LIVE 等）时退回再试一次——子代理也是
        continuable 运行时根，未决问题经 SessionSummary.pendingInteraction
        投影成侧边栏琥珀点，用户打开该会话即见 composer 接管作答
  ③ 构建师调用时：宿主自动 answerBuildInterview 把答案写回
    .eteams/rolebuilder.json（幂等覆写、最新答案胜出）——构建子代理
    无须再 build_report(answers)，同回合继续起草
  ④ 两连弹都被拒/服务缺失 → 行转 cancelled（或干脆不落单）→ 返回
    degraded + degradeHint（把问题写进汇报文本直接问——文本问答兜底不变）
```

关键语义收窄：`relaySessionId` 从「转交目标会话」收窄为审计留档——恒等于 `askingSessionId` 自身；弹窗实际落点（提问会话 or 主对话 or 自身）随运行态决定，不另落列。主会话亲自问（绑定/建队身份）不带 `mainSessionId`——它自己就是主对话，弹窗目标即自身。

## 宿主端落点

- `runtime/askUser.ts` 重写：`runAskUser` 只剩 self/degraded 两种结局；删除 `decideAskRoute` / `publishBuilderAsk` / `deliverAskRelay` / `wakeAskingChild` / `askRelayNextStep`。弹窗目标解析（2026-09-12 起）：`readBuildPresence(root)` 命中 `caller.askingSessionId` → 首选提问会话自身（`options.agent`）；否则 `liveAgentOf(ctx, caller.mainSessionId)`（assignment/notifier 同款 `agents.get` 取活实例）——命中且非调用者自身则作首选，否则提问会话自身；try/catch 两段式回退提问会话自身（同目标不再重试）。presence 来自既有 `POST /presence` 心跳（客户端 5s 上报、60s 过期），单库模式下与 runtime 同一状态根。服务缺失的检查放在 insertAskSync **之前**（不留孤儿 pending 行）；两连弹都异常先 `cancelAskSync` 再降级。
- `tools/askUserTools.ts`：`eteams_ask_user` 调用者解析 = 先 `resolveCaller`（成员/领队），抛错时查构建会话 `builderChildId` → 构建视图（`teamId: 0`、`askingKind: 'conversation'`、`mainSessionId` = `readBuildParentSession`）；两者皆非原样抛错。成员的主对话 = `team.tasks.find(id === member.mainTaskId)?.mainSessionId`；领队子代理 = `captainChildTaskOf` 注册表 → 任务锚。`eteams_ask_answer` 工具删除。
- `tools/captainTools.ts`：`eteams_build_report(interview)` 发布即返回（问题只写构建会话，无 popSelf/无转交/无路由痕迹）；**`answers` 旁路面保留**（主对话亲自构建的降级路径 + 面板补交仍走它，`answerBuildInterview` 幂等覆写与宿主自动落盘不冲突）。`eteams_interview_answer` 工具删除。
- `runtime/builderPhases.ts`：BUILDER_TOOLS 的 `ask_user_question` → `eteams_ask_user`（直接弹原生工具会绕过审计行）。
- `state/asks.ts`：`readAllPendingAsksSync` 保留为诊断/运维读端（曾服务一版已退役的客户端读端路由）。
- `runtime/webui.ts`：无新增路由（自定义提醒条方案整删后无客户端轮询端点）。
- 提示词：`prompts/steering/ask.ts`、`prompts/steering/interview.ts` 整删；`sessionTeam.ts` band 声明「子代理问答以原生弹窗直接弹在本对话——本会话无须代答、转交或补充」；builder persona / captainChild / dispatch / captain 文案全部改口径（「弹窗直接弹在主对话，不在线自动退回你的对话」）。

## 客户端落点

- **零新增**：第一版的 `pages/askDock.tsx`、`api.fetchPendingAsks`、`sessionState.openSession` 整删——原生弹窗已经弹在用户所在的窗口，不需要任何自定义引导 UI。
- 文案：看板页待问答 alert、构建卡片 activeInterview、构建工作台访谈块——「转交主会话/到子对话作答」全部改为「弹窗已弹在用户当前所在会话（未在该子对话时弹在提问成员的主任务会话），到那里作答即可」（2026-09-12 随落点判定同步改口）。

## 为什么这样设计

- **弹窗为什么先看 presence、再落到主对话**：`ctx.userQuestions.ask({agent})` 按 `agent.id` 把 composer 接管路由到那个会话——弹在用户没看的会话里等于用户看不到（只剩侧边栏琥珀点）。所以落点以「用户当前所在会话」为准：presence 心跳（客户端 5s 上报、60s 过期）命中提问子对话就地弹；否则回落到确定性的主对话目标（任务锚/构建父会话记录）。presence 缺失/过期一律按「不在子对话」处理，宁可弹主对话（用户通常在那）也不误判。
- **为什么还要自身兜底**：主对话可能已关闭（活根不在注册表 → 原生服务会拒 CALLER_NOT_LIVE）；此时退回提问子代理自己的对话，侧边栏琥珀点仍给出未决标记——可见性有底，且不唤醒任何 LLM。
- **构建师答案为什么宿主自动写回**：构建子代理收不到「用户答完了」的消息就得停驻等唤醒（`eteams_build_wait` 的老坑）；宿主在 `eteams_ask_user` 的成功帧里顺手 `answerBuildInterview`，答案落盘与弹窗回包同帧完成，子代理同回合继续——停驻纪律不再需要任何例外。
- **审计行为什么就地弹也落**：面板「待问答」徽标以审计行为唯一数据源，不需要第二套内存态。

## 问询 vs report 职责分离（2026-09-12）

用户口令：需要用户答复的问题**必须弹问答弹窗**（`eteams_ask_user`），且**要在任务执行之前问**；
用户自行调整成员卡槽是正常情况、无需询问。

- `report`（子代理单向汇报通道）只做**通知**：升级「待用户」的告知、失败结论、拆解计划就绪、
  主任务收口总结——**不承载需要用户答复的问题**。唯一例外：`eteams_ask_user` 返回
  `mode=degraded` / 调用报错时，才按 `degradeHint` 把问题写进汇报文本（既有兜底不变）。
  口径落在 `prompts/spawn/captainChild.ts` 的汇报纪律/问询纪律/失败分诊三条，
  以及 `prompts/steering/dispatch.ts` 的开跑与完善文案。
- 时机：问询属**计划阶段**，必须在收口（`eteams_submit_task(taskId)` 把主任务
  `creating→ready`）**之前**完成；收口时随 `questionnaire` 记录问过的问题。宿主在
  `runtime/assignment.ts` 的 `finalizeCommissionTask` 加**收口问询自检闸**：既无 `questionnaire`
  又未显式传 `skipQuestionnaire=true`（用户已给全/要求直接开始的合法跳过）→ 拒绝收口，
  主任务停在「创建中」不可开跑。工具参数见 `tools/captainTools.ts` 的 `eteams_submit_task`。
- 卡槽免问：用户调整任务成员卡槽（chain 站点）/执行链/团队成员是正常计划操作，领队不询问、
  不确认、不追问「是否有意」，只现读现状后适配（`prompts/spawn/captainChild.ts` 新增纪律）。

## 提问口径：自包含 + 说人话 + 选项写清后果（2026-09-14）

用户口令：问答弹窗出现在主会话时需要具体细节，将问题通过小学生和外行都能听懂的方式
给到主会话显示出来，不然用户不知道怎么选。

弹窗是原生组件、载荷只有 `questions`——弹到主对话时，用户手里只有这段问题文本，提问
子代理脑子里的任务上下文一点都传不过来（实况：问题只有「车门开关的触发方式选哪种？」
这类短语 +「全部按推荐（A/A/A/A/A）」这类无信息量选项）。所以口径由提问方在文案里
**自我承担**，不做宿主侧上下文前缀：问题必须**自包含**（点名哪个任务/哪一步、为什么
问）、**说人话**（无代号/缩写/变量名/文件路径/行话，术语就地一句解释）、**选项写清
「选它会怎样」**（禁止「方案 A / 方案 B」「看情况」这类选项）、**具体可判**（该给
数字/范围/样例就给），推荐项放首位并在 label 尾标「（推荐）」。

口径落点（分主次，避免双轨）：

- **全文（5 条）只写一处**：`tools/askUserTools.ts` 的 `eteams_ask_user` 工具
  description——所有子代理（成员/领队/构建师）弹窗前必读；同文件的 `question` /
  `options` 参数描述同步具体化。
- **短句（一句话）**在其余用户可见提问通道复用：`tools/captainTools.ts` 的
  `eteams_build_report(interview)` 问题描述（访谈问题会原样经 `eteams_ask_user` 弹出并
  渲染在面板，两处同源）、`prompts/personas/builder.ts` 的意图访谈规则、
  `prompts/steering/askFallback.ts` 的降级文本提问、`prompts/spawn/captainChild.ts` 的
  问询（FR-37）纪律、`prompts/spawn/member.ts` 的求助纪律、`prompts/system/sessionTeam.ts`
  两个指示原生 `ask_user_question` 的无领队分支（文件内常量 `ASK_USER_QUESTION_SPEC`）。
- 主会话亲自问询走原生 `ask_user_question`，其工具 description 不归本仓库——band 是唯一
  可控入口。若实况仍漂移，下一步再考虑在 `runtime/askUser.ts` 里给问题自动前缀任务上下文
  的兜底（本次显式不做：前缀只补出处、补不了解释）。

## 明确不做

- `eteams_build_wait` 保留现状（已标注遗留/诊断用）。
- `build_report(answers)` 旁路面保留（主对话亲自构建降级路径在用）。
- 决策升级（wait_decision）流程不在本次范围。
- 不做任何自定义问答提醒 UI（第一版输入区 dock 已按用户反馈整删）。

## 验证

- `pnpm typecheck && pnpm lint && pnpm test` 全绿。
- 测试面：`tests/askUser.test.ts`（成员/领队 self 全流程、**presence 命中提问会话 → 就地弹（主对话在线也优先）**、**presence 命中主会话/缺失 → 弹主对话**、**主对话在线弹窗带主对话 agent**、**主对话拒收两连弹退回自身**、构建师分支含**构建父会话在线弹窗切父会话**、服务缺失不落单、两连弹被拒行转 cancelled、身份门禁）、`tests/buildInterviewRelay.test.ts`（发布无路由痕迹/旁路面保留/退役工具不再注册）。
- 手动场景清单：领队/成员问答弹窗弹在**用户当前所在会话**输入区（用户在子对话里就地弹，否则主对话；composer 接管），作答后提问方同回合继续；主对话关着时退回提问子对话弹窗，侧边栏琥珀点引导；`/eteam` 构建访谈同理（用户在构建子对话就弹那里，否则发起构建的主对话），作答后 rolebuilder.json 自动落盘；弹窗被拒 → degraded 文本问答；看板/构建卡文案不再出现「转交主会话」。
