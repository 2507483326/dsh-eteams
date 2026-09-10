# 子对话问答统一 + 原生弹窗直弹主对话（2026-09-10）

## 背景与问题

统一之前，插件的「子对话问答」有三条不同逻辑的路：

1. **成员/领队问答**（`eteams_ask_user`）：presence 判定用户在不在看提问会话——在 → 就地弹；不在 → 把问题**转交主会话**弹出（唤醒主对话 LLM 重弹原生 `ask_user_question`），用户答后主对话调 `eteams_ask_answer` 回收，宿主再 `wakeAskingChild` 唤醒提问方。提问方结束回合挂起等唤醒。链路长、烧主对话 token、唤醒时序脆弱（用户不答就永远悬着）。
2. **构建师访谈**（`eteams_build_report(interview)`）：同一套路由判定但另一套机制——`popSelf` 指引、`publishBuilderAsk` 转交构建父、`eteams_interview_answer` / `eteams_ask_answer` 双回收入口、`popFailed` 补转、`markInterviewRouted` 路由痕迹字段。
3. **主对话提示词里养着一段「转交协议」**（`sessionTeam.ts` band）：教模型收到【eteams 用户问答转交】后代弹/代提交——把本该纯机械的路由塞进了 LLM 的回合里。

三条路三个心智模型，提示词要教、测试要铺、出错面（唤醒丢失、双入口竞态、面板与弹窗互相覆盖）各自独立。

## 决策（用户拍板，两轮）

1. **统一深度 = 完全统一**：构建师访谈也走 `eteams_ask_user`；`eteams_ask_answer`、`eteams_interview_answer`、publishBuilderAsk 转交、popFailed 补转、steering 提示词（`ask.ts` / `interview.ts`）、主对话转交协议**全部退役**。
2. **弹窗目标 = 提问方所属的主对话**（用户迭代「直接调用 DeepSeek 的弹窗，而且应该只弹它自己的主对话」）：不造任何自定义提醒 UI，直接用 DeepSeek 原生问答弹窗；目标会话 = 任务锚 `mainSessionId` / 构建父会话记录的主对话——用户正在对话的窗口，弹窗直接接管它的输入区。第一版「输入区提醒条 + sessions.open 跳转」的自定义 dock 因观感不佳整删。

## 统一后的唯一问答路径

```
子代理（领队/成员/构建师）调 eteams_ask_user
  ① 审计行落 ask_questions（status=pending，askingSessionId=提问会话自身）
  ② ctx.userQuestions.ask({agent}) 弹原生问答弹窗——agent 按优先级取：
     a. 主对话（默认）：成员按自己大任务的任务锚 mainSessionId、领队子代理
        按注册表记录的主任务锚、构建师按构建受理时落盘的父会话 id；
        agents.get(sessionId) 命中 = 主对话在线，弹窗直接接管它的输入区，
        用户在自己的窗口里作答（无须任何跳转/提醒）
     b. 提问会话自身（兜底）：主对话不在线（agents.get 查不到活根）或
        弹窗被拒（CALLER_NOT_LIVE 等）时退回再试一次——子代理也是
        continuable 运行时根，未决问题经 SessionSummary.pendingInteraction
        投影成侧边栏琥珀点，用户打开该会话即见 composer 接管作答
  ③ 构建师调用时：宿主自动 answerBuildInterview 把答案写回
    .eteams/rolebuilder.json（幂等覆写、最新答案胜出）——构建子代理
    无须再 build_report(answers)，同回合继续起草
  ④ 两连弹都被拒/服务缺失 → 行转 cancelled（或干脆不落单）→ 返回
    degraded + degradeHint（把问题写进汇报文本直接问——文本问答兜底不变）
```

关键语义收窄：`relaySessionId` 从「转交目标会话」收窄为审计留档——恒等于 `askingSessionId` 自身；弹窗实际落点（主对话 or 自身）随运行态决定，不另落列。主会话亲自问（绑定/建队身份）不带 `mainSessionId`——它自己就是主对话，弹窗目标即自身。

## 宿主端落点

- `runtime/askUser.ts` 重写：`runAskUser` 只剩 self/degraded 两种结局；删除 `decideAskRoute` / `publishBuilderAsk` / `deliverAskRelay` / `wakeAskingChild` / `askRelayNextStep` / presence 路由判定。弹窗目标解析 = `liveAgentOf(ctx, caller.mainSessionId)`（assignment/notifier 同款 `agents.get` 取活实例）→ 命中且非调用者自身则作首选，try/catch 两段式回退提问会话自身（同目标不再重试）。服务缺失的检查放在 insertAskSync **之前**（不留孤儿 pending 行）；两连弹都异常先 `cancelAskSync` 再降级。
- `tools/askUserTools.ts`：`eteams_ask_user` 调用者解析 = 先 `resolveCaller`（成员/领队），抛错时查构建会话 `builderChildId` → 构建视图（`teamId: 0`、`askingKind: 'conversation'`、`mainSessionId` = `readBuildParentSession`）；两者皆非原样抛错。成员的主对话 = `team.tasks.find(id === member.mainTaskId)?.mainSessionId`；领队子代理 = `captainChildTaskOf` 注册表 → 任务锚。`eteams_ask_answer` 工具删除。
- `tools/captainTools.ts`：`eteams_build_report(interview)` 发布即返回（问题只写构建会话，无 popSelf/无转交/无路由痕迹）；**`answers` 旁路面保留**（主对话亲自构建的降级路径 + 面板补交仍走它，`answerBuildInterview` 幂等覆写与宿主自动落盘不冲突）。`eteams_interview_answer` 工具删除。
- `runtime/builderPhases.ts`：BUILDER_TOOLS 的 `ask_user_question` → `eteams_ask_user`（直接弹原生工具会绕过审计行）。
- `state/asks.ts`：`readAllPendingAsksSync` 保留为诊断/运维读端（曾服务一版已退役的客户端读端路由）。
- `runtime/webui.ts`：无新增路由（自定义提醒条方案整删后无客户端轮询端点）。
- 提示词：`prompts/steering/ask.ts`、`prompts/steering/interview.ts` 整删；`sessionTeam.ts` band 声明「子代理问答以原生弹窗直接弹在本对话——本会话无须代答、转交或补充」；builder persona / captainChild / dispatch / captain 文案全部改口径（「弹窗直接弹在主对话，不在线自动退回你的对话」）。

## 客户端落点

- **零新增**：第一版的 `pages/askDock.tsx`、`api.fetchPendingAsks`、`sessionState.openSession` 整删——原生弹窗已经弹在用户所在的窗口，不需要任何自定义引导 UI。
- 文案：看板页待问答 alert、构建卡片 activeInterview、构建工作台访谈块——「转交主会话/到子对话作答」全部改为「弹窗已弹在对应主对话，到那里作答即可」。

## 为什么这样设计

- **弹窗为什么直弹主对话**：主对话代理是活运行时根（`agents.get` 注册表命中），`ctx.userQuestions.ask({agent})` 按 `agent.id` 把 composer 接管路由到那个会话——与其让用户被引导去子对话作答，不如把弹窗送到用户眼前的窗口；「自己的主对话」这个目标语义是确定性的（任务锚/构建父会话记录），不依赖任何 presence 猜测。
- **为什么还要自身兜底**：主对话可能已关闭（活根不在注册表 → 原生服务会拒 CALLER_NOT_LIVE）；此时退回提问子代理自己的对话，侧边栏琥珀点仍给出未决标记——可见性有底，且不唤醒任何 LLM。
- **构建师答案为什么宿主自动写回**：构建子代理收不到「用户答完了」的消息就得停驻等唤醒（`eteams_build_wait` 的老坑）；宿主在 `eteams_ask_user` 的成功帧里顺手 `answerBuildInterview`，答案落盘与弹窗回包同帧完成，子代理同回合继续——停驻纪律不再需要任何例外。
- **审计行为什么就地弹也落**：面板「待问答」徽标以审计行为唯一数据源，不需要第二套内存态。

## 明确不做

- `eteams_build_wait` 保留现状（已标注遗留/诊断用）。
- `build_report(answers)` 旁路面保留（主对话亲自构建降级路径在用）。
- 决策升级（wait_decision）流程不在本次范围。
- 不做任何自定义问答提醒 UI（第一版输入区 dock 已按用户反馈整删）。

## 验证

- `pnpm typecheck && pnpm lint && pnpm test` 全绿。
- 测试面：`tests/askUser.test.ts`（成员/领队 self 全流程、**主对话在线弹窗带主对话 agent**、**主对话拒收两连弹退回自身**、构建师分支含**构建父会话在线弹窗切父会话**、服务缺失不落单、两连弹被拒行转 cancelled、身份门禁）、`tests/buildInterviewRelay.test.ts`（发布无路由痕迹/旁路面保留/退役工具不再注册）。
- 手动场景清单：领队/成员问答弹窗直接出现在**主对话**输入区（composer 接管），作答后提问方同回合继续；主对话关着时退回提问子对话弹窗，侧边栏琥珀点引导；`/eteam` 构建访谈弹窗落发起构建的主对话，作答后 rolebuilder.json 自动落盘；弹窗被拒 → degraded 文本问答；看板/构建卡文案不再出现「转交主会话」。
