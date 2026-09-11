# 面板手动创建任务：创建中状态 + 领队完善（v2 修订版）

用户需求：任务页面加「添加任务」按钮，手动创建任务只需**任务描述 + 选择团队**；提交后任务卡显示**创建中**状态（带 loading 效果）；团队有领队交给领队完善任务，没有领队交给主会话完善；这条流程与对话中「使用团队开始任务」同源，**复用逻辑**。

v2 修订：按审核报告修正派发锚一层的事实错误（captainFor 是主会话父锚解析器，不是领队子代理锚）、补 dispatchCaptainCore 的 parent 参数与团队现状快照、定案无领队路径与绑定横幅的冲突、补收口函数落点/详情页开始钮/测试基线/schema 注释双份同步，并定案「完善中开跑小任务」口径。

本文自含全部设计，不依赖其它文档。

---

## 1. 现状回顾（设计依据，已逐点核实）

### 1.1 对话中「使用团队开始任务」的既有流程

- 用户在 composer 绑定团队（POST `/session-team`）→ 会话系统提示词注入团队横幅，告知主会话把目标转交给持续领队子代理。
- 主会话调 `eteams_dispatch_captain(message)`，execute（captainDispatch.ts）核心链路：
  1. `resolveCaller` 判 captain → 读团队快照；
  2. `prompt = captainDispatchPrompt(JSON.stringify(teamView(env, team), null, 1), message)`（**首轮带团队现状快照**建立子代理上下文）；
  3. `persona = captainPersonaOf(env, config)`（roster 领队手册优先，缺省回退内置）；
  4. `previous = leaderRowOf(team)?.sessionId ?? ''`（**领队子代理锚在主持行 sessionId**）；领队模型路线 `leaderModel`；
  5. `previous !== ''` → `subagents.followup(exec.agent, previous, textTurn(prompt), { source, signal })` 续聊（**parent=exec.agent 是真实直接父**，lineage 授权要求）；失败则 `unregisterCaptainChild` 后重建；
  6. 重建：`subagents.startContinuable({ provider, label: buildCaptainLabel(teamId), request: { prompt, parent: exec.agent, persona, toolFilter: { deny: CAPTAIN_CHILD_DENIED_TOOLS }, agentOptions }, signal })` → `registerCaptainChild(childId, teamId)` + `persistCaptainChildId`（落盘主持行 session_id）。
- 领队子代理流程：问询（`ask_user_question`，可跳）→ `eteams_submit_task`（建主任务容器，kind=group）→ `eteams_create_task(parentTaskId=…)` 拆解小任务（chain 站点写班底**工号**）→ 汇报「计划已就绪（N 个小任务）」。
- 红线：领队**不自批开跑**，指派/开始需用户确认。

### 1.2 任务状态机

7 态（**用户迭代 2026-09-11 精简**，原 11 态收敛）：`creating/ready/start/paused/wait_user/completed/cancelled`，非法转移抛 `TransitionError`。
- `draft/ready/wait` → `ready`（统一「待开始」）：草稿与就绪同义，「等待派发」并入 start 语义——**派发不改状态**（任务留 ready），成员领取才 `ready→start`；重试失败/改派也回 ready。
- `wait_decision/failed` → `wait_user`（统一「待用户」）：待回答问题/待决策/重试超限。
- 依赖阻塞不再物化（原 `wait + blocked_from` 退役）：被上游卡住的任务保持 ready，**派发口**用 `dependenciesSatisfied` 校验；`blocked_from` 列弃用（保留不 DROP）。
- 大任务（容器，`parentId === null`）只用 `creating/ready/start/paused` + `completed`（**可回退标识**，追加小任务即回 ready；无 cancelled——取消 = 取消未完成小任务并回 ready）。

### 1.3 面板写端与锚点（关键事实）

- `webui.ts` 单条 prefix 路由 `/eteams-api`；`envFor(ctx, config, workspace)` 无 sessionId，面板建任务的 `mainSessionId` 靠 body 透传（v6 参数位已在）。
- **`captainFor(env, team, task)`（assignment.ts）是「主会话父锚」解析器**——只当派发父锚，不查领队子代理：① 任务行 `mainSessionId` / `teamMainSessionOf(team)`（同为任务行快照）的活代理 → ② 面板 presence 心跳 → ③ `agents.resume` 冷恢复（主会话窗口被关也能复活）。返回 `Agent | undefined`。
- **领队子代理锚**在主持行 `sessionId`（`leaderRowOf(team)`），由派发核心内部决定 followup 续聊还是 startContinuable 新建——面板路径不能自己解析它，必须走同一个核心函数。
- 主会话唤醒（无领队路径用）：`agent.followup(createUserMessage({ content: [{type:'text',text}], source: { kind:'plugin', plugin:'dsh-eteams' } }))`（notifier.ts wakeCaptain 同款；agent 来自 `env.ctx.agents.get(sessionId)` 活代理）。
- 调用方身份 `resolveCaller`（identity.ts）优先级：session-team 绑定 → 领队子代理登记表 → **任务 `mainSessionId` 快照**（`findTeamByCaptain`：`SELECT team_id FROM task WHERE main_session_id = ?` LIMIT 1，无 ORDER BY）→ 领队行会话 → 成员副本行。面板 commission 把 body.sessionId 落进任务行后，被唤醒的主会话经第 3 优先级判为 captain，领队工具门禁（root 作用域注册）放行。

### 1.4 关键现状事实

- `hasLeader` 目前只是 `team` 表的开关（建队开关 + 面板展示消费），对话流程**不分支**：绑定横幅（sessionTeamBand）一律写「团队工作流由持续领队子代理主持——本会话只负责转交与展示」，对无领队团队失真。本设计首次让 `hasLeader` 决定「谁来完善任务」，并顺手把横幅按 `hasLeader` 分支收口。
- 绑定存内存 Map（runtime/sessionTeam.ts），重启自愈；绑定他队时 resolveCaller 绑定优先，`caller.team` 错配。
- 领队主持行（`task_members` 中 `name='项目牧羊人'` 且 `mainTaskId IS NULL`）是领队子代理会话锚。

---

## 2. 设计总览

```
任务页「＋ 添加任务」
   │ 填任务描述 + 选团队 → POST /team/<id>/task/commission { description, sessionId? }
   ▼
宿主建主任务容器（kind=group，status=creating，mainSessionId=sessionId）
   │ 事件 task_commissioned
   ▼
team.hasLeader?
   ├─ 是 → captainFor 取主会话父锚（快照/心跳/resume）
   │        → dispatchCaptainCore(env, config, parent, team, prompt, signal)
   │          （核心内部：主持行 sessionId 续聊 / startContinuable 新建——与对话流程同一函数）
   └─ 否 → captainFor 取主会话父锚
            → anchor.followup(createUserMessage(完善提示词))（wakeCaptain 同款）
   ▼
完善者：eteams_update_task 回写主题/说明 → eteams_create_task(parentTaskId=N) 拆解
        → eteams_submit_task(taskId=N) 收口：finalizeCommissionTask（更新容器 + creating→ready）
   ▼
任务卡从「创建中」变为「待开始」，用户照常批准/指派（红线不变：完善者不自批开跑）
```

---

## 3. 宿主端设计

### 3.1 新状态 `creating`（第 11 态）

- `types.ts`：`TaskStatus` 联合类型加 `'creating'`，头注释同步「11 态」。
- `taskMachine.ts`：`EDGES` 加 `creating: ['ready', 'cancelled']`；头注释「10 态收敛」→「11 态收敛」。
  - `creating → ready`：完善收口（`finalizeCommissionTask`，见 3.6）。
  - `creating → cancelled`：用户放弃（cancelTask 走 EDGES 合法；删除走 deleteTask 逃生门，见 3.4）。
  - 其余入边不存在：`creating` 只能由面板 commission 路径直接建出（不经转移）。
- 已核实的既有穷举点对 creating 天然安全、**不改**：`suspendTask`（只收 wait/start/ready）、`reassignTask`（状态集不含 creating）、`prepareAssignment`（只派 ready——但需加父容器守卫，见 3.8）、POISON 集（不含 creating）、`restoreBlocked`（恢复目标只会是 'ready'，creating 不进 blockedFrom）、`boardOverview` 白名单（creating 不上看板也不崩）、webui `ACTIVE_STATUSES` 消费位（排除 creating 语义正确）。`progress.total` 口径顺手排除 creating（见 4.5）。

### 3.2 `createTask` 支持 status 覆盖

`assignment.ts` `createTask` 参数加 `status?: TaskStatus`（默认 `'ready'` 不变，注释说明仅面板 commission 路径传 `'creating'`）。落库 `status: params.status ?? 'ready'`。其余逻辑（副本整班复制、workDir 分配、文档物化）不动——建大任务即全员在册的纪律对 creating 容器同样成立。

### 3.3 新路由 `POST /team/<id>/task/commission`

`webui.ts` 新增写端，body：`{ description: string, sessionId?: string }`。

1. `locateTeam` 取团队；description trim 非空校验（400）。
2. `createTask(env, who, { kind:'group', subject: 描述首行截断 24 字, description, status:'creating', mainSessionId: body.sessionId })`。subject 是占位（完善者会回写，收口走既有 `renameTaskFolder`），取描述首行让「创建中」卡片可读。
3. 事件 `task_commissioned`（actor=plugin，payload：`taskId`、`hasLeader`、`dispatched`、失败时 `reason`）。
4. 唤醒完善者（两路共用同一父锚来源 `captainFor(env, team, task)`——它就是主会话父锚解析器，① 任务行 mainSessionId（刚落了 body.sessionId）活代理命中概率高，窗口被关走 ③ 冷恢复）：
   - **hasLeader**：`parent = captainFor(...)`；拿到后调 `dispatchCaptainCore(env, config, parent, team, prompt, signal)`（3.5）——核心内部解析主持行 sessionId 决定续聊/新建。**不能**绕过核心直接把主会话代理当领队子代理投递（P2 修正：两者是父子两层，不是同一锚）。
   - **无领队**：`anchor = captainFor(...)`；拿到后 `anchor.followup(createUserMessage({ content: [{type:'text',text: prompt}], source: { kind:'plugin', plugin:'dsh-eteams' } }))`（wakeCaptain 同款）。主会话被唤醒后经任务行 mainSessionId 快照判为 captain，root 作用域领队工具可用。
5. 绑定守卫（P5 定案）：`body.sessionId` 存在且 `getSessionTeamId(body.sessionId)` 绑定了**其他**团队 → 跳过唤醒，`dispatched: false` + detail「该会话已绑定其他团队，完善指令无法投递（任务保留为创建中，可删除后在对应团队对话中重试）」——把 resolveCaller 绑定优先导致的 `caller.team` 错配提前变成可诊断的明确失败，而不是让完善者调工具时报「任务不存在」。
6. 响应：`{ ok: true, taskId, dispatched: boolean, detail?: string }`。
   - 父锚解析失败 / 代理不存在 / 子代理服务缺失 → `dispatched: false` + detail。**建任务仍成功**——任务已入册，宁可留给完善者/用户处理，不可静默丢失。
   - `task_commissioned` 事件如实记 `dispatched`/`reason`。
7. 并发（审核建议 2）：commission 派发段按团队串行——模块级 `Map<teamId, Promise>` in-flight 链（同 teamLockKey 锁语义对齐），两次快速提交不并发 `startContinuable` 重建同 label 子代理。

### 3.4 既有守卫的放宽与收紧

| 函数 | 改动 | 原因 |
|---|---|---|
| `updateTask` | 可编辑状态集加 `'creating'` | 完善者回写主题/说明、合同 |
| `createTask`（小任务挂靠校验） | 父任务状态集 `['draft','ready']` → 加 `'creating'` | 领队往创建中的容器拆小任务 |
| `deleteTask` | 可删状态集加 `'creating'` | 派发失败的逃生门；面板 deletableOf 同步（仅容器分支放宽，小任务分支不动——creating 小任务不存在） |
| `startGroupTask` | 组任务 status 为 `creating` 时拒绝（「创建中，等完善收口」） | 未完善的容器不可开跑 |
| `completeGroupIfDoneInTx` | 仅父任务 `status==='ready'` 才自动收口 | 防「小任务全完成时父还在 creating」触发非法转移崩溃 |

### 3.5 派发核心抽函数 + 完善提示词（P1/P3 修订）

- `captainDispatch.ts`：把 execute 第 149–208 行（子代理服务可用性检查 → prompt 组装 → persona → previous/leaderModel → followup 续聊失败重建 → startContinuable → register → persist）抽成导出函数：

  ```ts
  export async function dispatchCaptainCore(
    env: RuntimeEnv,
    config: ETeamsResolvedConfig,
    parent: Agent,            // 真实直接父（lineage 授权）；对话路径 = exec.agent，面板路径 = captainFor 返回的主会话代理
    team: TeamState,
    message: string,          // 派发消息（prompt 组装在其内：快照 + message）
    signal?: AbortSignal,
  ): Promise<{ ok: true; relayed: string }>
  ```

  工具 execute 保留 caller 判定 + 团队读取，改调核心函数——**工具自身行为零变更**，现有 tests/captainDispatch.test.ts 假服务用例直接验证。
- `prompts/steering/dispatch.ts`：新增 `captainCommissionPrompt(teamViewJson, taskId, subject, description)`——**按 `captainDispatchPrompt` 同款组装（团队现状快照 + 完善指令）**，否则新建子代理不知道班底构成、`eteams_create_task` 的 chain 工号无从下手。完善指令内容：
  - 告知任务 #N 已以「创建中」占位（主题=描述首行截断、说明=全文），**不要**再 `eteams_submit_task` 新建主任务；
  - 流程与对话一致：如有必要先问询（可跳过；问询弹窗会直接弹给用户）→ `eteams_update_task` 回写主题/说明 → `eteams_create_task(parentTaskId=N)` 拆解小任务（依赖/执行链/成员槽，站点写工号）→ `eteams_submit_task(taskId=N, subject, description)` 收口（更新容器信息并把创建中转就绪）→ 汇报「任务 #N 已完善（N 个小任务）」；
  - 红线照旧：**不自批开跑**（完善收口后等用户批准/指派；本设计另在宿主闸上兜底，见 3.9）。

### 3.6 `eteams_submit_task` 扩展收口模式 + 收口函数落点（P9 修订）

- `assignment.ts` 新增导出函数 `finalizeCommissionTask(env, who, taskId, { subject, description?, contractMd? })`：单 `withTeam` 事务内——updateTask 核心校验（复用其字段校验）+ `applyTransition(creating→ready)` + `renameTaskFolder`（主题变了同步 sub/ 文件夹前缀）+ `plan.questionnaire` 事件照发 + 返回任务记录。**收口必须落在这个纯 runtime 函数**——工具层（captainTools）按分层纪律不能手写事务/转移，而 `updateTask` 自己开事务无法与其拼装。
- `captainTools.ts` `eteams_submit_task` 参数加可选 `taskId: number`：
  - 不带（现状）：照旧新建主任务容器。
  - 带且目标存在、`parentId===null`、`status==='creating'`：调 `finalizeCommissionTask`；输出照现状补 `folder`（readTeam + taskDirRel）。
  - 带但目标不是 creating 容器 → actionable 错误（「任务 #N 已就绪，无需重复提交；拆解请用 eteams_create_task」）。
  - 收口后容器 ready：组任务开始钮/派发语义与普通组任务一致（红线仍由提示词 + 3.8 闸兜底）。

### 3.7 事件展示

`webui.ts` `summarizeEvent` 加 `task_commissioned` case：`dispatched` 为真 →「面板创建任务 #N，已交{领队/主会话}完善」；为假 →「面板创建任务 #N（创建中），完善者未送达：{reason}」。

### 3.8 「完善中开跑小任务」定案（审核建议 1，采纳宿主闸方案）

容器 creating 时其小任务已 ready，`eteams_assign_task` 与面板 `/start` 单任务路径都只查小任务自身状态，用户可在完善中开跑——违背「完善收口前计划未定」红线。定案：**`prepareAssignment` 加守卫——目标小任务的父容器 `status==='creating'` 时拒绝派发**（「主任务 #N 创建中，等完善收口后再开始」）。这同时保证收口时不会出现「小任务全 completed 但容器停在 creating」的死局（完善期间小任务跑不起来，收口必然发生在任何小任务执行之前）。不改 `eteams_assign_task` 工具层，闸落在两条派发路径共用的 `prepareAssignment`。

### 3.9 绑定横幅按 hasLeader 分支（P5 定案）

`prompts/system/sessionTeam.ts` + `runtime/sessionTeam.ts`（薄壳传参）：

- `SessionTeamBandInput` 的 live 分支加 `hasLeader: boolean`（薄壳从活团队快照读）。
- `hasLeader === true`：现有文案不动（转交持续领队子代理）。
- `hasLeader === false`：分工段改为「本团队未设领队：团队工作流（提交任务单、问询、拆解、指派、汇报）由**本会话直接主持**——直接调用 eteams_submit_task / eteams_create_task / eteams_update_task 等领队工具完善与推进任务，问询用 ask_user_question，不自批开跑」。这同时修正了现状横幅对无领队团队的失真（对话流程里无领队团队本就该主会话自己拆，CLAUDE.md 流程口径如此），面板唤醒路径与对话绑定路径共用同一套语义，无每回合冲突。
- 头注释两个分支的说明同步更新。

---

## 4. 客户端设计

### 4.1 api

`lib/api.ts` 新增 `createTaskCommission(teamId, { description, sessionId? })` → `POST /team/<id>/task/commission`，返回 `{ taskId, dispatched, detail? }`。

### 4.2 任务页

- `tasksPage.tsx`：
  - props 增 `pool: TeamSnapshot[]`、`sessionId?: string`、`onSelectTeam: (id: string) => void`（routes.tsx 透传，数据壳已有）；`onSelectTeam` 实现是 `dispatch ui/setSelectedTeam`，只切团队不导航——停留在 /tasks，快照切换即「落在该团队任务页」。
  - Card 头部行右侧加「＋ 添加任务」按钮（lucide `plus.mjs` 深层导入，与团队页「＋ 新增团队」同款）。
  - 新弹窗 `addTaskDialog.tsx`（FormDialog 壳）：任务描述 Textarea（必填）+ 团队 Select（默认当前团队，选项 = pool 全部团队）；瞬态状态（open/description/teamId/busy/error）由 tasksPage 持有，经 props 传入（与 TaskDialogs 同风格）。
  - 提交成功：关弹窗 + `refreshActivitySoon()`；若所选团队 ≠ 当前团队 → `onSelectTeam(所选团队)`。`dispatched:false` 时 toast 提示 detail（任务仍创建成功，保留为创建中可删）。
  - 空态文案补一句「或点右上角『添加任务』手动创建」。
- `taskListCard.tsx`：`deletableOf` 仅容器分支放宽（`t.status` 集加 `'creating'`）；小任务分支（`sub.status`）判据不动。**tests/taskListCard.test.ts 的镜像锁同步更新**。

### 4.3 创建中展示与 loading

`features/tasks/taskDisplayStatus.ts`：

- `STATUS_LABELS` 加 `creating: '创建中'`（键序放在 draft 前——创建中是比待开始更早的态；STATUS_GROUPS 按其键序展开，tests/taskDisplayStatus.test.ts 的键序锁同步）。
- `DISPLAY_STATUS_TABLE` 加 `creating: { key:'init', label:'创建中', tone:'info' }`（归 init 桶：尚未进入执行语义）。
- 新增 `isGroupStartable(status: string): boolean` = `!isTerminal(status) && status !== 'creating'`——组任务「开始」钮判据收拢（现状 `!isTerminal` 对 creating 容器会渲染开始钮，点击被宿主 400 拒）。**isTerminal 实现本身不改**（终态判据不变），其逐格测试锁不动。
- `taskListCard.tsx` 组开始钮判据改 `isGroupStartable(task.status)`（替换 `!isTerminal(task.status)`）。
- `taskDetailPage.tsx` 组头开始钮判据同改（现状 `!isTerminal(selected.status) && subs.length > 0`——P6：creating 容器拆出小任务后开始钮实际可达，不改会点了报 400）。

`taskListCard.tsx` loading 效果：`task.status === 'creating'` 时，状态 pill 旁渲染 lucide `loader-circle.mjs` + `animate-spin`（Tailwind 自带动画类）的 14px 旋转图标。卡片不渲染「开始」钮（判据已收）；文件夹/删除钮照常（删除 = 逃生门）。

### 4.4 详情页

`taskDetailPage` / `taskHeaderCard` 走同一展示态派生层，creating 自动显「创建中」pill；详情页就地编辑入口判据（`['draft','ready']`）加 `'creating'` 与宿主 `updateTask` 对齐；小任务开始钮判据 `isStartable` 不含 creating、无需改——小任务在完善期可被编辑/查看但派发被宿主闸（3.8）拦，行内错误就地显示。

### 4.5 看板进度口径（审核建议 4）

`webui.ts` `progress.total` 的 real 任务计数排除 `creating`（创建中且未拆解的容器不计入进度分母，语义更准；顺手改，一处白名单）。

---

## 5. 测试与验收（P7 修订，文件名以实际为准）

- `tests/model.test.ts`：applyTransition 用例补 creating——`creating→ready`、`creating→cancelled` 合法；`creating→start/wait` 抛 TransitionError。
- `tests/taskDisplayStatus.test.ts`：STATUS_LABELS 键序锁加 creating（STATUS_GROUPS 同步）；`displayStatusOf('creating')` = 创建中/init/info；`isGroupStartable` 用例（ready ✓ / creating ✗ / completed ✗）。
- `tests/taskListCard.test.ts`：deletableOf 镜像锁同步（容器判据加 creating）；组开始钮渲染判据改 `isGroupStartable` 后的用例口径。
- `tests/lifecycle.test.ts`：任务运行时用例——createTask status 覆盖；startGroupTask 拒绝 creating；completeGroupIfDoneInTx 不收口 creating 父；prepareAssignment 拒绝 creating 容器下的小任务派发；finalizeCommissionTask（更新 + 转移 + 事件 + 非法目标报错）。
- `tests/webui.test.ts`：panel harness 补 commission 路由用例（建任务成功 + dispatched 两态 + 绑定他队拒投 + 400 校验）。
- `tests/captainDispatch.test.ts`：dispatchCaptainCore 抽取后现有 7 用例零变更通过（工具行为不变的证据）；如可行补面板路径 parent 来源用例。
- 手工验收链：面板建任务（有领队队 / 无领队队各一）→ 卡片「创建中」+ 旋转图标 → 领队/主会话完善（含问询）→ 卡片转「待开始」且主题被回写 → 派发失败分支（无锚/绑定他队）→ 提示 + 可删除。

---

## 6. 影响面清单

| 层 | 文件 | 动作 |
|---|---|---|
| model | `src/host/model/types.ts` | TaskStatus + creating；头注释 11 态 |
| model | `src/host/model/taskMachine.ts` | EDGES + creating；头注释 11 态 |
| state | `src/host/state/db.ts` | SCHEMA_SQL 内 `status` 列注释与 `blocked_from` 注释补 creating（**与 schema.sql 逐字一致**；TEXT 枚举注释变更，`DB_SCHEMA_VERSION` 不动） |
| state | `src/host/state/schema.sql` | 同步上述注释（审核副本对照） |
| runtime | `src/host/runtime/assignment.ts` | createTask status 覆盖；守卫放宽/收紧；新增 `finalizeCommissionTask`；prepareAssignment 父容器闸 |
| tools | `src/host/tools/captainTools.ts` | submit_task taskId 收口分支（输出补 folder） |
| tools | `src/host/tools/captainDispatch.ts` | 核心抽 `dispatchCaptainCore(env, config, parent, team, message, signal?)` |
| prompts | `src/host/prompts/steering/dispatch.ts` | `captainCommissionPrompt(teamViewJson, taskId, subject, description)` |
| prompts | `src/host/prompts/system/sessionTeam.ts` + `src/host/runtime/sessionTeam.ts` | band 按 hasLeader 分支 |
| runtime | `src/host/runtime/webui.ts` | commission 路由（含绑定守卫 + in-flight 串行）+ summarizeEvent + progress.total 排除 creating |
| client | `src/client/lib/api.ts` | createTaskCommission |
| client | `src/client/features/tasks/taskDisplayStatus.ts` | creating 词表/表；isGroupStartable |
| client | `src/client/pages/tasks/tasksPage.tsx` | 按钮 + 弹窗 + props |
| client | `src/client/pages/tasks/addTaskDialog.tsx` | 新文件 |
| client | `src/client/pages/tasks/taskListCard.tsx` | deletableOf（仅容器）+ loading + isGroupStartable |
| client | `src/client/pages/tasks/taskDetailPage.tsx` | 组头开始钮 isGroupStartable；编辑判据 + creating |
| client | `src/client/pages/teamsView/routes.tsx` | TasksPage 透传 pool/sessionId/onSelectTeam |
| test | `tests/model.test.ts`、`tests/taskDisplayStatus.test.ts`、`tests/taskListCard.test.ts`、`tests/lifecycle.test.ts`、`tests/webui.test.ts`、`tests/captainDispatch.test.ts` | 上述用例 |

不落库结构变更（无新表/新列，`creating` 是合法枚举值走 TEXT 列；注释双份逐字同步即可），**DB_SCHEMA_VERSION 不动**。

## 7. 明确不做

- **完善超时机制**：领队问询停驻时创建中卡会长时间转圈，删除是既有逃生门；只在完善提示词与路由 detail 说明「完善过程可能出现问询弹窗」，不引入超时状态机。
- **updateTask 容器参数校验缺口**（容器不拒 dependencies/chain，与 createTask 不对称）：既有缺口，非本设计引入，另行处理。
- **无领队路径「一主会话一队」假设**：`findTeamByCaptain` LIMIT 1 无 ORDER BY，同一主会话服务多队时可能解析错队——保持假设并在工具报错 hint 可诊断，不做绑定改写。
- **对话流程对无领队团队仍会起子代理的旧行为**：由 3.9 横幅分支自然收口（横幅不再引导无领队团队转交），不改 dispatch 工具本身。

---

## 8. 实现落点与偏差（开发完成后回填）

按上述设计实现完毕（宿主端 + 客户端 + 测试全绿），与设计的偏差如下：

1. **派发核心落点**：`dispatchCaptainCore` 没留在 `tools/captainDispatch.ts`，而是下沉到 `src/host/runtime/captainAgent.ts`——面板路由（runtime/webui.ts）按分层纪律不得 import tools/ 层，核心必须住 runtime；`tools/captainDispatch.ts` 的 execute 只剩 caller 判定 + 团队读取 + prompt 组装，改调核心函数，工具行为零变更（tests/captainDispatch.test.ts 全数通过为证）。
2. **prompt 组装移出核心**：核心第 5 参改为调用方组装好的完整 prompt 文本（对话路径 = `captainDispatchPrompt`，面板路径 = `captainCommissionPrompt`），核心内部不再拼快照——两路 prompt 结构本就不同，拼装留在各自的语义层。
3. **绑定守卫时序**：绑定他队检查在 `withCommissionLock` 内、任务创建之后执行（任务先入册再判投递），detail 文案为「该会话已绑定其他团队，完善指令无法投递（任务保留为创建中，可删除后重试）」。
4. **任务页空态结构**：「＋ 添加任务」按钮在任务卡头部行——为让空态也能点，Card 与头部行恒渲染、空态文案移入卡内（与团队页 PageHeader 恒渲染同风格），空态文案按设计补句。
5. **completeGroupIfDoneInTx 防线**：`parent.status !== 'ready'` 早退守卫经公共 API 不可达（派发闸挡在前面、creating 无入边），lifecycle 用例覆盖的是可达的组合行为（`startGroupTask` / `prepareAssignment` 拒绝），不做直接单测。
6. **面板路径 parent 来源用例**：落在 tests/webui.test.ts 的无领队唤醒用例（installFull 桩补 followup，断言 `anchor.followup` 收到带任务 #id 与描述原话的完善指令），代替 5 里「captainDispatch.test.ts 补面板路径用例」的原设想；另有 commission 路由五用例（成功派发 / 无锚不回滚 / 绑定他队拒投 / 无领队唤醒 / 入参校验）。

待手工验收（需在 DSH 桌面端实际操作）：5 里「手工验收链」——面板建任务（有领队队 / 无领队队）→「创建中」+ 旋转图标 → 完善（含问询弹窗）→ 转「待开始」且主题回写 → 派发失败分支提示 + 可删除。

---

## 9. 客户端改走「新建对话」（用户迭代 2026-09-11，本文档客户端侧口径作废）

用户拍板：面板「添加任务」不再产小任务、也不再走本文的 commission 建「创建中」容器，而是**新开一个对话**，把描述和所选团队带过去。原因（用户原话）：添加任务是「从零建立一个任务单」，且希望在新的对话窗口里跟团队交互。

改动（只动客户端调用点，宿主 §3 的 commission 链路**原样保留**，暂未退役）：

- `addTaskDialog.tsx`：目标团队下拉改为带**首字徽章**的团队行（复用 `TEAM_CHIP_CLASS`，观感对齐对话里 `teamsButton` 弹层的团队选择）；描述文案改为「新开一个对话…」。
- `tasksPage.tsx`：`openAddDialog` 的目标团队默认值改为**当前会话绑定的团队**（`fetchSessionTeam` 宿主真相源，异步回填且不打断用户手选；取不到或该队不在池里落队首）。`submitAddTask` 改调 `lib/taskConversation` 的 `openTaskConversation`；整页团队页表面（覆盖层形态）成功后广播 `requestCloseTeamsPage()` 收页。
- 新增 `lib/taskConversation.ts`：编排「建会话（沿用来源会话 cwd）→ 绑团队（`POST /session-team`）→ 投递描述（`SessionFace.prompt`，queue）→ `sessions.open` 切过去」。顺序有语义：绑团队必须早于投递，否则首轮系统提示词组装时团队 band 尚未生效。
- `lib/sessionState.ts`：探测面扩展 `createSession` / `promptSession` / `sessionCwdOf`。`sessions.create` **不在** `ISessions` 契约面上（在 `SessionsPort` 跨域面上，DSH 自己的 New Session 流程走它），故按本仓结构探测纪律读取：能力缺失/失败一律 `null`/`false`，调用方降级不抛。
- `lib/api.ts`：`createTaskCommission` 已无消费位，删除（宿主 `/task/commission` 路由与其测试保留）。

任务单仍由「两步走」建立：新对话无锚定主任务，团队绑定 band 走 `prompts/system/sessionTeam.ts` 的「先 `eteams_submit_task` 建任务单 → 再 `eteams_dispatch_captain` 转交领队」分支（未设领队的团队由该会话直接主持）——与用户在对话里直接提任务完全同源，宿主零改动。

失败分层：建会话失败 / 绑团队失败 → 弹窗内就地报错（不静默成功）；描述未投递或未能切换 → 新对话照常打开并 toast 说明（消息可重发）。