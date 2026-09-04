# 29 小任务成员指派拖拽（A）+ 任务状态流展示（B）

> 用户需求原话（A）：「改造任务中的小任务，直接在小任务后面加上成员框。在任务下方把所有成员罗列出来。用户可以拖拽到对应成员框中间去」——任务页每个小任务行尾加一个可放置的「成员框」；组卡下方罗列全部团队成员（可拖拽 chip）；把成员拖进某小任务的成员框 = 指派该成员。
> 用户需求原话（B）：「任务要加上状态 初始化 -> 已创建 -> 等待执行 -> 进行中 -> 已完成 错误 相关状态进行标记」。
> 本文是**设计文档**（不含实现）：A 节给出拖拽指派的完整设计（依赖/语义/API/视觉/边界），B 节给出展示态派生层设计（底层 13 态状态机不动）。所有论断落到 `文件:行号` 证据；与现有代码冲突处明确标注（见 29.5）。

## 29.0 证据基线（读码结论速查）

| # | 事实 | 证据 |
| --- | --- | --- |
| E1 | 小任务 = `kind:'task'` + `parentId`；成员槽 = `chain` 站点序列（`ChainStation{member,stageBrief}`）；group 主任务禁 chain/依赖/父 | [types.ts](../src/host/model/types.ts):34-40、146-180（TaskRecord：kind/parentId/chain 在 153/155/164）；[docs/26](26-conversation-task-workflow.md) §26.3 |
| E2 | 面板编辑弹窗已按「chain 全量替换」实现：`saveEdit` 把 `editSlots` 过滤空成员后整体重发 | [eteamsView.tsx](../src/client/eteamsView.tsx):4293-4324 |
| E3 | host 路由 `POST /team/:id/task/:taskId/update` 收链后逐字段收紧（`{member,stageBrief}`）再进 `updateTask` | [webui.ts](../src/host/runtime/webui.ts):1112-1147、1617-1626 |
| E4 | `updateTask` 校验：任务须 `draft/ready`（否则「合同已冻结」）；chain 逐站校验成员在团队且未 removed；**不校验 stageBrief**；chain 全量替换 | [assignment.ts](../src/host/runtime/assignment.ts):156-219（状态闸 175-180、链校验 193-199） |
| E5 | `createTask` 与 E4 不对称：建任务时 `stageBrief` 空串会被拒 | [assignment.ts](../src/host/runtime/assignment.ts):88-98 |
| E6 | 编辑矩阵口径：`draft / ready（chainCursor=-1，未被领取）可整体编辑执行链；执行开始后链不可改；ready 中间站仅允许追加` | [docs/06](06-task-lifecycle.md) §6.4:76-93 |
| E7 | 链推进：站点完成→任务回 ready、cursor+1；`stationStatusOf` 把 index≤cursor 记 done、cursor+1 记 current | [taskMachine.ts](../src/host/model/taskMachine.ts):151-165；[webui.ts](../src/host/runtime/webui.ts):103-115 |
| E8 | 领队（项目牧羊人）**不是** `team.members` 记录：快照单列 `captain`，成员表由 `addMember` 逐个追加（status 初始 `staged`）；`leaderRemoved` 标志控制是否计入人数 | [webui.ts](../src/host/runtime/webui.ts):190-236；[teamOps.ts](../src/host/runtime/teamOps.ts):194-311、243-253；[roster.ts](../src/host/runtime/roster.ts):214、238-267 |
| E9 | 领队「不接任务：负责拆解、指派与调度」是既有 UI 口径 | [eteamsView.tsx](../src/client/eteamsView.tsx):2232、2537 |
| E10 | `TeamSnapshot.members` 已滤除 removed 成员；`MemberView` 带 `status/role/avatar` | [webui.ts](../src/host/runtime/webui.ts):236；[monitor.ts](../src/client/monitor.ts):36-62 |
| E11 | `removeMember` 只把成员标 `removed`，**不清理任何 chain 站点** → 链内悬空名 | [teamOps.ts](../src/host/runtime/teamOps.ts):550-603（595） |
| E12 | 小任务行渲染：行头 `taskId+subject+STATUS_LABELS[status]+assignee`、行内 `TaskStations` 站点行，行尾「修改/删除」（仅 subMutable=draft/ready） | [eteamsView.tsx](../src/client/eteamsView.tsx):4387-4440 |
| E13 | `TaskStations` 渲染 ✔/●/◌ 三态站点 + `站点 n/m`；`stationStatus` 由 host 投影 | [eteamsView.tsx](../src/client/eteamsView.tsx):533-557；[webui.ts](../src/host/runtime/webui.ts):103-115 |
| E14 | 状态词表 `STATUS_LABELS`（13 态）与状态分组 `STATUS_GROUPS`（10 组）是任务页骨架；`STATUS_LABELS` **同时被成员状态 pill 复用**（词表不同源） | [eteamsView.tsx](../src/client/eteamsView.tsx):163-195、2522 |
| E15 | 任务状态机 13 态、迁移边、group 的 ready→completed 显式特例（`completeGroupIfDone`） | [types.ts](../src/host/model/types.ts):19-32；[taskMachine.ts](../src/host/model/taskMachine.ts):21-75；[assignment.ts](../src/host/runtime/assignment.ts):1035+；[docs/06](06-task-lifecycle.md) §6.1-6.2 |
| E16 | 样式 token（亮/暗）：business=sky-500/400、success=green-600/lime-400 档、warning=amber-600/400、destructive=red-600/400、pill=中性底+彩点（D22e）、pill-bg/ink token | [eteams.css](../src/client/eteams.css):69-98、128-145；[docs/24](24-panel-tw-official-v3.md) D22a/D22e |
| E17 | 类名纪律：禁 `tone-${x}` 拼接，全部完整字面量映射表（21.5.1）；`Pill=Badge+dot`、错误就地 `FormErrorNote`（shadcn Alert destructive） | [eteamsView.tsx](../src/client/eteamsView.tsx):209-223、413-447 |
| E18 | 面板客户端是 **同文档注入模块**（ModuleLoader CJS envelope），非 iframe/webview；tsdown 只 external `@deepseek-ai/*`、react、react-dom，其余全部打进单文件 | [wrapClient.mjs](../scripts/wrapClient.mjs):1-25；[tsdown.config.ts](tsdown.config.ts):3、120-153；package.json `dsh.client.inject` |
| E19 | React 18.2 peer（宿主注入）；devDeps 全部走 bundler 打包，`dependencies` 为空 | [package.json](package.json):84、142-196 |
| E20 | 头像渲染统一走 `Avatar{name,seed,salt,size}`（seeded vue-color-avatar，缺省名字首字母圆） | [avatar.tsx](../src/client/avatar.tsx):43-70 |
| E21 | 添加成员入口在「团队」页详情（Ele.me 点餐式弹窗），角色库在「角色」页 | [eteamsView.tsx](../src/client/eteamsView.tsx):1749、2801、3093 |
| E22 | 任务编辑/删除弹窗是组件内瞬态 useState，保存/删除成功后 `refreshActivitySoon()` 立即回拉快照；错误就地显示 | [eteamsView.tsx](../src/client/eteamsView.tsx):4293-4339、4599、4641 |
| E23 | 轮询 1s 全量快照替换（`activity/set` 整包），乐观补丁模式仅存在于模型路线（patchRoute/revertRoute） | [monitor.ts](../src/client/monitor.ts):24、218-250、333-345 |

---

# 29.A 小任务成员指派拖拽（react-dnd）

## A.1 决策总览

| # | 决策点 | 结论 |
| --- | --- | --- |
| DA1 | 拖拽库 | `react-dnd@16.0.1` + `react-dnd-html5-backend@16.0.1`（见 A.2）；**不引 touch backend** |
| DA2 | DndProvider 层级 | **仅 TasksTab 局部包裹**（组件根），不放面板根 |
| DA3 | drop 语义 | drop = 写入该小任务的 **chain（成员槽）**，复用 update 路由 **chain 全量替换**；成员框 = 「下一待执行站点」的快捷指派位 |
| DA4 | 单站点任务 | 框内即 `chain[0]`：拖入=设置/替换 `chain[0].member`（保留原 stageBrief）；框内 × = 清空站点（chain 变 `[]`，回到「领队自由指派」，docs/06 §6.7:127 合法） |
| DA5 | 多站点（接力链） | 框内展示**下一待执行站点**（index=chainCursor+1；未领取时即站点 0），其余站点按 `TaskStations` ✔/●/◌ 只读渲染；多站点的追加/中间站编辑仍走「修改」弹窗，框不做全链编辑器 |
| DA6 | 编辑窗口 | 可放置 = `subMutable（draft/ready）&& chainCursor === -1`；`chainCursor ≥ 0` 或已领取 → 框转只读展示（对齐 E6，比 host 更严，见 29.5 冲突②） |
| DA7 | 可拖成员集合 | `team.members` 全量（快照已滤 removed，E10）；**staged 成员可拖**（host 校验只排除 removed，E4），chip 加「未启动」弱化标记；**领队不在集合内**（E8，且与「领队不接任务」口径一致，E9） |
| DA8 | 去重/替换 | 拖入成员与框内当前站点成员同名 → no-op（不发请求）；链内其他站点同名 → 允许（host 不禁，罕见链由弹窗处理）；已被指派（assignee）去重场景不存在——可编辑任务的 assignee 恒为 null |
| DA9 | 悬空名 | 链内已移除成员的名字照常渲染（弱化「已移出」）。**拖拽仅当悬空名恰在下一待执行站（即框内站点）时才能修复**：拖入新成员替换框内悬空名，替换后的整链不含悬空名、可过校验；悬空名在其余站点（`chainCursor===-1` 的多站链）时框只承站点 0、其余站点原样重发会把悬空名一起发回，被 host 逐站校验拒绝——面板修复路径须等开放问题 Q2 的 host 放行（既有雷见 29.5 冲突③、A.7 边界表） |
| DA10 | API | 复用 `updateTeamTask`（chain 全量替换，E2/E3），**不新增精简路由**；**非乐观更新**（等 host 返回 + `refreshActivitySoon`） |
| DA11 | 错误提示 | 行内 `FormErrorNote`（E17/E22 既有模式）：拖拽 POST 400 时在受影响小任务行下方就地显示 host 文案，下一次成功/关闭时清除 |
| DA12 | 无缝集成 | 只改 TasksTab 小任务行 + 组卡 + 新增成员罗列条；主任务卡结构、看板、汇报不动 |

## A.2 依赖选型与 DndProvider 层级

**版本与安装**：react-dnd v16 是最后一个发布线（2022-04 定版），`16.0.1` 为最新；peer 只要求 `react >= 16.14`（React 18 满足），自身依赖 `dnd-core@16.0.1`；`react-dnd-html5-backend@16.0.1` 无 React peer、与主包同版配套。v16 起包为 ESM-only——本项目经 tsdown(Rolldown) **打包进** client envelope（react-dnd 不在 `dsh.client.inject` 清单内，属 bundler 输入而非运行时 require，E18/E19），ESM-only 不构成障碍。

```bash
pnpm add -D react-dnd@16.0.1 react-dnd-html5-backend@16.0.1
```

（devDependencies 口径与 react/react-redux/radix 等一致：host 注入 react，其余打进 `lib/client.js`；体积预估 +35~45KB min，量级与 Radix 三件套相当，记入体积台账。）

**DndProvider 放置：TasksTab 局部包裹**，理由：

1. 消费面只有 TasksTab（小任务行成员框 + 成员罗列条都在其中）；面板五个表面根（ETeamsView/TeamsButton/card/buildCard/teamsPanel）各自独立 React 根，放面板根要动五个入口且其余四表面对 provider 零消费。
2. TasksTab 在 tab 切换/团队切换时整体卸载（`activeTab==='tasks' &&` 条件渲染，eteamsView.tsx:972-979），Provider 随之销毁重建——拖拽是瞬时交互，无跨 tab 存续需求；1s 轮询只做 `activity/set` 数据替换、不重挂组件（E23），Provider 在轮询下稳定。
3. Radix Dialog 的 portal（编辑弹窗）也在同一 React 树内（context 穿透 portal），若未来在弹窗内加 drop 目标无需改 Provider 位置。

每条拖拽 item 的 type 用字符串常量 `'eteams-member'`，`useDrag`/`useDrop` 均限定在同一 TasksTab 的 Provider 内，跨表面/跨团队不可能串线。

## A.3 拖拽语义（与 chain / 编辑矩阵严格对齐）

### A.3.1 数据流核心：drop 只产生「chain 全量替换」

不发明任何新通道。拖放结果 = 以当前快照里的 `task.chain` 为底、按规则改一个站点后，整链经 `updateTeamTask(teamId, taskId, { chain })` 重发（E2 同款）。host 侧校验路径不变：`readChainParam` 逐字段收紧（E3）→ `updateTask` 状态闸 + 逐站成员在团校验（E4）。**不存在绕过 host 的通道**：拖拽在数据层与「修改」弹窗的保存完全同构，只是入口从表单换成拖放。

纯函数（新文件内，可单测）：

```
nextChainAfterDrop(task: TaskView, member: string): TaskSlotInput[] | null
  // null = no-op（同名去重/不可编辑），否则返回替换后的整链
```

规则（全部落 E4/E6/E7）：

| 前置条件（任务） | drop 行为 |
| --- | --- |
| `chain.length === 0` | 生成 `[{member, stageBrief:''}]`（单站） |
| `chain.length === 1 && chainCursor === -1` | 替换 `chain[0].member`，`stageBrief` 原值保留（空则空） |
| `chain.length ≥ 2 && chainCursor === -1` | 替换**站点 0**（下一待执行站）成员，其余站点原样重发（注意：若其余站点含悬空名，整链会被 host 逐站校验拒绝——见 A.7 悬空名边界与 29.5 冲突③） |
| `chainCursor ≥ 0`（已开跑：站点已完成/当前站） | 不注册 drop target（只读） |
| 非 `draft/ready`（assigned/in_progress/…/终态） | 不注册 drop target（只读，DA12：合同冻结，E4 状态闸会拒绝，客户端直接不给入口） |

- **移除**：框内 chip 的 `×` 仅在 `chain.length ≤ 1 && chainCursor === -1` 时出现 → `chain = []`（回到无链任务，领队自由指派，E6/docs/06 §6.7:127）。多站点移除走「修改」弹窗（可整链重排，含删站）。
- **追加**：多站点任务不在框上追加；「修改」弹窗已有「添加站点」（eteamsView.tsx:4588-4597）。理由：框是「下一站快捷指派位」，追加是全链编辑语义，混在拖拽里会产生「拖一次多一站」的意外增长。
- **stageBrief**：拖拽写入空串合法（E4 asymmetry，create 才拒绝，见 29.5 冲突①）；拖拽不改写文案，改文案走「修改」弹窗。建议后续把 E5 的 create 校验放宽到与 update 一致（开放问题 Q3）。
- **去重**：`nextChainAfterDrop` 若发现目标站点成员与拖入成员同名 → 返回 null，框给出一次 200ms 的「已是该成员」微反馈（边框闪现，不发请求）。顶层任务的 assignee 去重不存在（可编辑窗口内 assignee 恒 null，E4 指派只发生在 ready 之后）。

### A.3.2 可拖拽成员集合（含过滤规则）

| 成员状态 | 可拖？ | 展示 |
| --- | --- | --- |
| `ready / working / paused`（正式成员） | ✔ | 正常 chip + 状态点（memberTone 语义，eteamsView.tsx:239-245） |
| `staged`（未启动） | ✔ | chip 弱化 + 「未启动」标记——host 链校验放行（只排除 removed，E4），与「未就绪先 eteams_add_member」口径一致（docs/26 §26.2 步骤 3） |
| `removed` | 不出现在集合 | 快照已滤（E10） |
| 领队（项目牧羊人） | ✘ | 不在 `team.members`（E8），罗列条单独渲染领队 chip（带「领队」徽标、**不可拖**，`draggable:false`），与「领队不接任务」既有口径一致（E9）；`leaderRemoved===true` 时不渲染领队 chip（monitor.ts:143-144） |
| 「从成员库添加」入口 | 不放 | 加人入口保留在「团队」页详情（E21）；任务页成员罗列条只做指派，避免第二套加人通道（开放问题 Q4） |

成员 chip 拖拽中（`isDragging`）源 chip 半透明；全部小任务框在 `canDrop` 预判（编辑窗口 + 目标站点）失败时**不进入 hover 高亮**。

### A.3.3 与 README 决策 D14 的关系（细化口径，不构成 D14 偏离）

D14（[README 决策记录](README.md)：执行槽与拖拽指派，`docs/README.md:53`）的字面是「用户可拖拽成员入槽分配（staged 填链、ready 指派；偏离需确认说明；in_progress 禁用）」。本文把「拖拽」的写入语义细化为**链槽位编辑**，验收按本节口径理解 D14：

- **拖拽 = 链槽位编辑**：staged/ready 状态拖入一律只写 `chain` 槽位（DA3/A.3.1），**不直接指派**（不写 `assignee`）、**不发指派通知**（不触发 claim/邮箱 assignment）；
- **ready 的指派路径不变**：指派仍由领队经 `eteams_assign_task` / advance 承担（E4 的既有语义：指派发生在 ready 之后、由领队工具执行；DA8 亦因此「可编辑窗口内 assignee 恒 null」）；
- **D14 的「偏离需确认说明」不触发**：该条款承接 D11 的「领队显式偏离预规划执行链须留痕确认」语义；纯填链语义下用户拖入改的是链槽位本身（链尚未开跑），不存在「偏离执行链」的情形；
- **in_progress 禁用**：与 DA6/DA12 一致（`chainCursor ≥ 0` 或非 draft/ready 框转只读）。

若用户验收时要求「ready 拖入即指派」，属 D14 决策变更——按 README 纪律先改决策记录表，再改本文（DA3/A.3.1 的 drop 语义随之扩展）。

## A.4 API 落点与数据流时序

**复用 update 路由**（DA10）。不新增精简路由的理由：chain 全量替换是既有契约（弹窗 E2 = 路由 E3 = host 校验 E4 三层已闭环）；精简路由（如 `PATCH chain`）会复制一层校验语义，且「chain 全量替换」本身就是最小正确载荷（单站任务整链就一个元素）。路由已按 `actor:{kind:'user',name:'用户'}` 记事件（E3），拖拽指派与弹窗修改在审计流里同源。

**非乐观更新**（与模型路线的 patchRoute 乐观模式不同，E23）：链是带校验语义的字段（成员在团/合同冻结/悬空名校验），乐观回滚需要给 chain 造一套 pending 覆盖层，收益（省 ≤1s）不抵复杂度；轮询节奏 1s（E23）+ 成功即 `refreshActivitySoon()` 已足够跟手。

```
用户拖成员 chip（useDrag, 'eteams-member'）
   │ hover 框内 → canDrop 预判（编辑窗口/目标站点）
   ▼
drop → nextChainAfterDrop(task, member)            [纯函数，no-op 即短路]
   │
   ▼
setAssignBusy(taskId) → updateTeamTask(teamId, taskId, { chain })   [api.ts:343-360]
   │
   ▼
host: POST /eteams-api/team/:id/task/:taskId/update                [webui.ts:1112-1147]
      readChainParam 收紧 → assignment.updateTask                  [webui.ts:1617-1626]
        ├─ 状态闸：draft/ready 才可改（合同冻结即 400）            [assignment.ts:175-180]
        ├─ 逐站校验成员在团队且非 removed                          [assignment.ts:193-198]
        ├─ task.chain = 新链 → writeTeam + renderTeamDocs
      200 {ok,taskId}                        400 {message}
   │                                              │
   ▼                                              ▼
refreshActivitySoon() → /state（≤1s 轮询命中）   行内 FormErrorNote 就地显示 host 文案
框渲染新 chain chip；setAssignBusy(null)          （不乐观回滚——旧 chain 本就未动）
```

## A.5 视觉规格与界面草图

### A.5.1 成员框（TaskAssignDropBox）

| 态 | 规格 |
| --- | --- |
| 空框 | 虚线边框槽：`h-[26px] min-w-[96px] rounded-md border border-dashed px-2 text-xs text-muted-foreground`，文案「＋ 拖入成员」（BORDER_L1 类边框 token，E16） |
| 已放置 | 中性 pill chip：`Avatar` 18px + 名字 12px（`PILL_BASE_CLASS` 家族口径，E16/E20）+（`chain.length≤1` 时）`×` 移除钮 |
| 拖拽悬停 | `canDrop && isOver`：虚线转实线 + `border-primary bg-[color:var(--eteams-pill-bg)]` + 文案「松手指派」，chip 轻微上浮阴影 |
| 拖拽可放置（非悬停） | 虚线边框转 `border-primary/60`（提示可落点） |
| 不可放置/只读 | 不注册 drop target；chip 静态渲染；已移除成员名字弱化 + 「已移出」标记 |
| 提交中 | `assignBusy` 时框禁用 + 透明度 50% |

单站点任务在框出现时**抑制** `TaskStations` 的重复渲染（`chain.length≤1` 时站点行与框内容重合，E13）；多站点任务保留 `TaskStations`（顺序语义）+ 框只承下一站。空框点击 = 打开「修改」弹窗（键盘/触屏降级路径，A.7）。

### A.5.2 界面草图（对话任务区块）

```
┌ 对话任务 · 1 ───────────────────────────────────────────────────────────┐
│                                                                          │
│ ┌ t7-101 登录页改版 ────────────────── [ 修改 ] [ 删除 ] ┐              │
│ │ t2 登录页实现  ● 进行中 · 链: 张三   ┌╌╌╌╌╌╌╌╌╌╌╌╌┐  │              │
│ │                                      ╎ (◉张三) × ╎←成员框        │  │
│ │                                      └╌╌╌╌╌╌╌╌╌╌╌╌┘  │              │
│ │   （单站点：TaskStations 行被框替代，不再重复 ◌张三）    │              │
│ │ ───────────────────────────────────────────────────────  │             │
│ │ 团队成员（拖到本卡小任务行尾的成员框完成指派）           │              │
│ │ ┌────────┐ ┌────────┐ ┌──────────┐ ┌╌╌╌╌╌╌╌╌┐          │              │
│ │ │(◉张三) │ │(◉李四) │ │(◔王五)   │ │(◆项目牧羊人│←领队 chip：   │          │
│ │ │ 研究员 │ │ 工程师 │ │ 未启动   │ │  领队   ╌╌│  带徽标、不可拖│          │
│ │ └────────┘ └────────┘ └──────────┘ └╌╌╌╌╌╌╌╌┘          │              │
│ └─────────────────────────────────────────────────────────┘              │
│                                                                          │
│ ┌ t3 接口联调 ───────────────────────── [ 修改 ] [ 删除 ] ┐             │
│ │ t8 联调排障  ◌ 已创建                                  │              │
│ │   ◌ ✔张三 → ●李四 → ┌╌╌╌╌╌╌╌╌╌╌╌╌┐   ← 多站点：      │              │
│ │   （站点 2/3）        ╎ ＋ 拖入成员 ╎     站点行保留，    │              │
│ │                       └╌╌╌╌╌╌╌╌╌╌╌╌┘   框=下一待执行站   │              │
│ │   ✔=站点1已完成  ●=站点2执行中  框承接站点2的成员（只读）│              │
│ │ ───────────────────────────────────────────────────────  │             │
│ │ 团队成员（每张组卡下方各一条，chip 副本相同；图略）      │              │
│ └─────────────────────────────────────────────────────────┘              │
└──────────────────────────────────────────────────────────────────────────┘

拖拽悬停时的成员框（放大态）：
┌────────────────────────┐
│ (◉李四) → 松手放入      │   实线 + brand 淡底 + 「松手」文案
└────────────────────────┘
```

### A.5.3 成员罗列条（每张组卡下方各一条；用户 2026-09-04 已确认）

**布局决策（用户 2026-09-04 拍板）：成员罗列条渲染在每张任务单（group）卡内的下方——小任务行之后，每卡一条。** 回归用户原话「在任务下方把所有成员罗列出来」的字面位置。设计稿曾论证「区块级单条」（同队成员对全部组卡相同、去重、置顶视线），经用户确认**不采纳**；本文按用户决策执行：逐卡重复渲染一份相同副本（可拖拽 chip），拖拽源与放置目标在同一卡内就近可见。

- 条内 chip：`Avatar` 20px + 名字（12px medium）+ 状态点（memberTone）；staged 成员名字后缀「未启动」小字；领队 chip 单列置首、带「领队」徽标、不可拖（口径不变）。
- chip 规格复用 `ROLE_CHIP_CLASS` 的品牌淡底变体做「可拖」签名（`bg-business-tint`，E16），hover 提示 `title="拖到小任务成员框完成指派"`，cursor `grab/grabbing`。
- 「从成员库添加」入口：**不在罗列条内提供**（DA12/E21）；条尾只放一行 12px 说明文字。若用户验收时要求快捷加人，再评估（Q4）。
- 实现提示：罗列条容器（`TeamMemberStrip`）按摆放位置参数化，逐卡渲染即在每张组卡内插一份；数据仍只取同一份成员快照（同队成员对全部组卡相同），无重复请求。

## A.6 集成点与宿主环境结论（拖拽技术面）

**结论：面板运行在宿主同文档（非 iframe/webview），HTML5 backend 无跨文档 dataTransfer 问题。** 证据链：

1. 客户端构建产物是 CJS envelope，经 `window.__ModuleLoader__.load(...)` 注入宿主 web 应用（wrapClient.mjs:1-25）；`dsh.client.platform:'web'`（package.json:52-54）——插件代码与宿主 UI 同 React 同文档运行。
2. `docs/03` 曾在头像编辑器场景评估过「iframe 嵌独立应用」并明确放弃（docs/03-tech-stack.md:59）——面板从未走 iframe。
3. 拖拽源（成员罗列条）与放置目标（小任务成员框）都渲染在同一个 TasksTab React 树、同一 document；`dataTransfer` 只在 dragstart/drop 的同文档生命周期内使用，不涉及跨 window/跨文档传递。

已排查的次级风险（均不阻塞）：

| 检查项 | 结论 |
| --- | --- |
| Radix Dialog portal 内的 drop target | 同文档 + React context 穿透 portal，react-dnd 正常工作（本设计本轮不在弹窗内放 drop target，仅备注） |
| 滚动容器（CONTENT_CLASS overflow-y-auto，eteamsView.tsx:460） | HTML5 backend 支持 auto-scroll；拖拽预览（drag image）取 chip 元素，容器内正常 |
| 宿主全局 dragstart/dragover 干预 | DSH Desktop（Electron）无已知全局拖拽劫持；风险记入验收（GUI 实装后目检） |
| HTML5 backend 的 Electron 兼容 | Chromium 原生 HTML5 DnD，直接支持 |
| 多 Provider 实例（ETeamsView 与 TeamsButton 弹层各一份 TasksTab？） | TasksTab 只存在于 ETeamsView；单实例单 Provider，无跨树拖拽需求 |

**触屏取舍（并入 A.7）**：HTML5 backend 不支持触屏拖拽；本产品宿主为 DSH Desktop（桌面端，鼠标环境），不引入 `react-dnd-touch-backend`（它无 HTML5 预览、双 backend 还需 multi-backend 胶水）。降级路径：空框/框 chip 点击打开既有「修改」弹窗（Select 选成员），功能等价、路径可达。

## A.7 边界与降级

| 边界 | 行为 |
| --- | --- |
| 任务领取后（assigned/in_progress/retrying/paused/awaiting_decision/needs_user/suspended/blocked） | 成员框转只读（chip 静态渲染，不注册 drop target，无 ×）——「领取后合同冻结」（E4/E6；host 状态闸兜底 400） |
| `chainCursor ≥ 0`（链已开跑，含 ready 中间站） | 只读（DA6，对齐 docs/06 §6.4:93「开始后链不可改」） |
| 终态（completed/failed/cancelled） | 只读 + chip 灰化 |
| 删除成员后框内悬空名（恰在下一待执行站） | 名字照常渲染 + 弱化「已移出」标记；拖入新成员即替换（DA9）——替换后的整链不含悬空名、可过校验 |
| 悬空名在其余站点（`chainCursor === -1` 的多站链） | 框只承下一待执行站：拖拽（只改站点 0）与「修改」弹窗整链重发均会把悬空名一起发回，被 host 逐站校验拒绝（`assignment.ts:193-198`，既有雷）——面板修复路径须等 Q2 的 host 放行 |
| staged 成员被拖入 | 允许（host 放行），chip 带「未启动」标记；该成员后续 spawn 后正常接任务（docs/26 §26.2 步骤 3） |
| 团队 phase==='staged'（批准前） | 照常可拖（小任务 draft 可改，批准时统一 draft→ready，docs/26 §26.2 步骤 5） |
| 触屏 | HTML5 backend 不支持——不引入 touch backend（A.6 结论）；空框/框 chip **点击 = 打开「修改」弹窗**（Select 选成员，全功能等价降级路径，E2） |
| 键盘 | 同上：框可聚焦（`tabIndex`），Enter/Space 打开「修改」弹窗 |
| 拖拽进行中快照轮询到达 | drop 时以最新快照的 task 重算 `nextChainAfterDrop`，不缓存旧 chain（风险②） |
| 同名成员去重 | 目标站点成员 === 拖入成员 → no-op（DA8）；可编辑窗口内 assignee 恒 null，不存在「已是执行人」场景 |

## A.8 无缝集成点（改动面收敛）

| 位置 | 改动 |
| --- | --- |
| `TasksTab` 小任务行（eteamsView.tsx:4387-4440） | 行尾挂 `TaskAssignDropBox`；单站点抑制 `TaskStations` |
| `TasksTab` 对话任务区块（eteamsView.tsx:4346-4445） | 每张组卡内小任务行之后插「团队成员」罗列条（含领队 chip，逐卡一份，A.5.3 用户决策） |
| `TasksTab` 根 | 包 `DndProvider`；新增 `assignBusy/assignError` 瞬态（对齐 editBusy/editError 模式，E22） |
| 其余（主任务卡、顶层状态分组行、看板、BoardTab、编辑弹窗） | **不动** |

---

# 29.B 任务状态流展示

## B.1 结论：底层 13 态状态机不动 + 新增展示态派生层

**底层 13 态状态机不动**。`TaskStatus`（types.ts:19-32）+ `canTransition/applyTransition`（taskMachine.ts:21-75）+ `refreshDependencyStatus` 传染 + group 特例（taskMachine.ts:60-65）是调度、重试预算、依赖阻断的运行依据（docs/06 §6.1-6.2、6.5-6.7），任何「压扁」都会破坏 `assigned→ready→assigned`（改派）、`blocked` 恢复、retryCount 清零等语义。

新增**展示态派生层**：纯函数（读取时计算，不落盘、不写状态机），把 13 态映射为用户口径六档 + cancelled 分支：

```
type DisplayStatusKey = 'init' | 'created' | 'waiting' | 'doing' | 'done' | 'error';
// cancelled 归入 'error' 桶（一切非正常终止/需处置的终态），但文案独立为「已取消」
```

选择「cancelled 归 error 桶 + 文案覆盖」而非第 7 档的理由：用户口径只给六档；取消与失败同为异常终态，聚合规则（B.2 组卡汇总）需要「异常优先」语义时二者同桶最简单；但「已取消」是用户主动行为，颜色用中性灰而非红，避免把用户操作标成故障。桶只服务聚合优先级，文案/颜色/图标逐态独立。

## B.2 13 态 → 展示态映射表

| 13 态 | 展示态 | 文案 | 点色 | 图标 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `draft` | init | 初始化 | muted 灰 | ◌ | 计划期草案（staged 团队） |
| `ready` | created | 已创建 | business 蓝 | ◌ | 计划已批准、任务就绪待指派 |
| `assigned` | waiting | 等待执行 | warning 黄 | ⏳ | 已指派待接取 |
| `blocked` | waiting | 等待执行 | warning 黄 | ⏳ | 上游阻断，恢复后回原态（taskMachine.ts:82-94） |
| `paused` | waiting | 等待执行 | warning 黄 | ⏳ | attempt 停驻待恢复 |
| `suspended` | waiting | 等待执行 | warning 黄 | ⏳ | 领队挂起 |
| `in_progress` | doing | 进行中 | business 蓝 | ● | 执行中 |
| `retrying` | doing | 进行中 | business 蓝 | ● | detail「重试 n」 |
| `awaiting_decision` | error | 错误 | warning 黄 | ✕ | detail「待领队决策」（重试超限，异常待处置；异常汇总 chip 用 err 红） |
| `needs_user` | error | 错误 | warning 黄 | ✕ | detail「等待用户」 |
| `completed` | done | 已完成 | success 绿 | ✔ | 成功终态 |
| `failed` | error | 错误 | destructive 红 | ✕ | detail「失败」 |
| `cancelled` | error | 已取消 | muted 灰 | ✕ | 用户/领队主动取消（桶在 error、色中性，避免误标为红） |

色值取 token（E16）：business `#0ea5e9`/暗 `#38bdf8`、success `#16a34a`/暗 `#4ade80`、warning `#d97706`/暗 `#fbbf24`、destructive `#dc2626`/暗 `#f87171`、muted-foreground `#64748b`/暗 `#94a3b8`——即 `DOT_TONE_CLASS` 五桶（E16/E17），色盲安全由「图标+文字」双通道保证（docs/06 §6.8:149 同口径）。图标沿用既有字形语言：✔/●/◌（D22f 保留的产品语义字形，docs/24 D22f）+ ⏳/✕ 两个新增字符（lucide 图标可选替代，见开放问题 Q6）。

**detail 字段**：展示态吞并了部分操作细节（awaiting/needs_user/retrying/suspended/paused/blocked 的差异），这些差异用 detail 小字保留在展示态 pill 后（如「进行中 · 重试 2」「等待执行 · 已挂起」），detail 文案直接取 `STATUS_LABELS[13态]`（E14 复用，不新造词表）。

### group 主任务的汇总规则

group 自身只有 draft/ready/completed（+cancelled）四态可达（taskMachine.ts:22、60-65；docs/26 §26.2 步骤 7）。展示规则：

1. 基础：`displayStatusOf(group.status)` 直接映射。
2. `group.status === 'ready'` 且存在小任务时，叠加小任务汇总（纯函数 `groupDisplayOf(subs: TaskView[])`）：

| 小任务展示态分布 | 组卡汇总显示 |
| --- | --- |
| 全部 done | 「小任务 n/n 完成」（现有进度行保留）+ 组卡主展示态仍为「已创建」（host 将在下一事件自动收口 ready→completed，assignment.ts:1035+） |
| 含任一 error 桶小任务 | **错误优先**：组卡加 `✕ n 项异常` 汇总 chip（点色 err；detail 列出首个异常小任务的 detail） |
| 否则含 doing | 汇总 chip 「n 执行中」 |
| 否则含 waiting | 汇总 chip 「n 等待执行」 |
| 全部 created/init | 汇总 chip 「待指派」（中性） |

优先级：error > doing > waiting > created（错误传染语义与 docs/05.9 依赖 POISON 集一致，taskMachine.ts:97-102）。group 的 `draft`（批准前）不做汇总——拆解中，只显示「小任务 n 个」计数。

## B.3 渲染位置与 STATUS_LABELS 共存策略

| 渲染位 | 处置 |
| --- | --- |
| 小任务行（eteamsView.tsx:4398-4402） | `STATUS_LABELS[t.status]` 文本 → 展示态 pill（Badge secondary + 6px dot + detail 小字）。行尾 assignee 显示不变 |
| 顶层普通任务行（eteamsView.tsx:4468-4474） | 同上替换（retryCount 标记并入 detail） |
| 组卡头（eteamsView.tsx:4366-4370） | group 自身展示态 + 小任务汇总 chip（B.2 规则） |
| 任务详情 TaskDrawer（eteamsView.tsx:618） | **保留 13 态精确文案**（详情页是操作语境，`blockedFrom`/attempt 状态等精度必要；attempt 行 630 同理） |
| 成员状态 pill（eteamsView.tsx:2522） | **不动**——`STATUS_LABELS` 被成员状态复用（staged/working… 词表不同源，E14），展示态映射只用于任务渲染位 |
| 看板目标卡（eteamsView.tsx:1059-1099） | 本轮不动：进度条 + completed/total/active 计数 + 阶段徽标已表达全局态；任务展示态是任务页语义 |
| `STATUS_GROUPS`（eteamsView.tsx:163-179） | 顶层状态分组**收敛为展示态分组**（6+1 组：初始化/已创建/等待执行/进行中/已完成/错误/已取消可选独立组）——分组头与行内展示态口径一致，消除「行在『待接取』组却显示『等待执行』」的错位。tone 沿用现有组语义映射（等待系黄、执行系蓝、成功绿、失败红、挂起灰、阻断橙→等待系黄） |

**共存策略结论**：`STATUS_LABELS` 不删除——它降级为「13 态精确词表」，服务 TaskDrawer、attempt 行、成员 pill 与展示态的 detail 文案；任务行/组卡/分组头消费新的展示态映射。`STATUS_GROUPS` 的「组」概念保留（分节导航不变），但分组边界从 13 态并成展示态。

## B.4 状态流转可视化（上一态 → 当前态）——本轮不做

理由：

1. 快照是 1s 全量替换（E23），客户端需要为每行缓存「上一个快照的状态」并处理轮询乱序/丢包，复杂度与收益不成比例。
2. 流转线索已有着落：看板「最近动态」事件流逐条渲染 `task.assigned/claimed/progress/completed/failed/retried/blocked` 等迁移（webui.ts:280-309 summarizeEvent），TaskDrawer 的 attempt 时间线呈现站内流转（docs/06 §6.3 渲染映射）。
3. 展示态本身带 detail（重试 n/待决策/被阻断…），已覆盖「从哪个状态来的」最高频疑问。

后续可选（记录不实施）：TaskDrawer 内基于 attempts/事件流渲染「状态轨迹」时间线（数据已在 track 路由，eteamsView.tsx:590-604 已拉取），无需改状态机。

---

# 29.3 实现切面清单

| 文件 | 改什么 |
| --- | --- |
| `package.json` | devDeps 增 `react-dnd@16.0.1`、`react-dnd-html5-backend@16.0.1`（pnpm add -D，A.2） |
| `src/client/taskAssign.tsx`（新） | `DndProvider(HTML5Backend)` 包裹器、`MemberDragChip`（useDrag 'eteams-member'）、`TaskAssignDropBox`（useDrop + canDrop 预判）、`nextChainAfterDrop` 纯函数；类名全部完整字面量映射表（E17 纪律） |
| `src/client/taskDisplayStatus.ts`（新） | `displayStatusOf(status): {key,label,tone,icon,detail}`、`groupDisplayOf(subs)` 纯函数（B.1/B.2） |
| `src/client/eteamsView.tsx` | TasksTab：根包 DndProvider；小任务行尾挂 `TaskAssignDropBox`（+单站点抑制 TaskStations）；每张组卡内小任务行之后插「团队成员」罗列条（逐卡一份，A.5.3 用户决策）；`assignBusy/assignError` 瞬态 + 行内 FormErrorNote；任务行/组卡换展示态 pill + detail；`STATUS_GROUPS` 收敛为展示态分组 |
| `src/client/api.ts` | 不改（`updateTeamTask` 已支持 chain 全量替换，api.ts:343-360） |
| `src/client/monitor.ts` | 不改（`TaskView.chain/chainCursor/chainLength`、`MemberView.status/avatar` 齐备，monitor.ts:77-102、36-62） |
| `src/host/**` | 不改（host 校验/路由/状态机零变更；29.5 冲突的 host 侧缺口只记录为开放问题） |
| `tests/taskAssign.test.ts`（新，建议） | `nextChainAfterDrop` 规则锁：空链建站、同站替换、同名 no-op、多站只改站点 0、只读窗口 |
| `tests/taskDisplayStatus.test.ts`（新，建议） | 13 态→展示态映射全表 + group 汇总优先级（error>doing>waiting） |
| `docs/README.md` | 阅读顺序表补 27/28/29/30 四行（2026-09-04 已随三篇落位一并增补）；D14 行加「细化口径见 docs/29」注记（A.3.3） |

预计新增 client 组件：`TaskAssignDropBox`（成员框）、`MemberDragChip`（成员罗列条 chip）、`TeamMemberStrip`（罗列条容器）、`DisplayStatusPill`（展示态徽标）。

---

# 29.4 数据流时序（A：拖拽 → API → host 校验 → 刷新快照）

```
浏览器（同文档 React 树）                     host（loopback /eteams-api）
────────────────────────                     ────────────────────────────
1. 轮询 /state（1s，monitor.ts:24）
   activity/set 整包替换 → TasksTab 渲染
   成员罗列条（源）+ 各小任务成员框（目标）
2. dragstart（HTML5 backend）：chip → 'eteams-member' item
   hover：canDrop = subMutable(draft/ready)
          && chainCursor === -1
3. drop → nextChainAfterDrop(task, member)
   （同名 no-op → 短路结束）
4. POST /team/:id/task/:taskId/update        → readChainParam 收紧（webui.ts:1617）
   body { chain: [{member, stageBrief}, …] } → updateTask：
                                               · draft/ready 状态闸（175-180）
                                               · 逐站成员在团校验（193-198）
                                               · task.chain 全量替换
                                               · writeTeam + renderTeamDocs
5. 200 {ok,taskId}  ←────────────────────→  （400 {message} → 行内 FormErrorNote）
   refreshActivitySoon() → 立即 /state
6. activity/set 新快照：成员框渲染新 chain；
   setAssignBusy(null)
   （下一次常规轮询 ≤1s 亦收敛，双保险）
```

关键点：全程**无乐观覆盖层**——失败时 UI 天然停在新快照（= 旧 chain），无回滚路径；成功路径由 `refreshActivitySoon` + 1s 轮询双通道收敛（E22/E23）。

---

# 29.5 与现有代码的冲突与风险清单

| # | 冲突/风险 | 证据 | 处置 |
| --- | --- | --- | --- |
| 冲突① | `createTask` 校验 stageBrief 非空、`updateTask` 不校验——拖拽写入空 brief 在 update 合法、走 create（新增小任务）会 400 | assignment.ts:96-98 vs 193-199 | 拖拽只落 update 通道（不受影响）；在「修改」弹窗与拖拽 hint 文案注明「新增时站点说明不能为空」 |
| 冲突② | host 对 `ready && chainCursor≥0` 的任务仍允许 chain 全量替换，宽于 docs/06.4「中间站仅允许追加」 | assignment.ts:175-199 vs docs/06 §6.4:93 | 客户端守卫 `chainCursor===-1` 才开 drop（DA6）；host 缺口记开放问题 Q1（不改 host 本轮） |
| 冲突③ | `removeMember` 不清 chain：链内悬空名会使任何「整链重发」的编辑（含既有修改弹窗）被 E4 逐站校验拒绝 | teamOps.ts:550-603（595）+ assignment.ts:193-198 | 拖拽替换悬空名**仅当悬空名恰在下一待执行站（框内站点）**时成立——替换后的整链不含悬空名、可过校验（DA9）；悬空名在其余站点时，拖拽（只改站点 0）与修改弹窗整链重发均 400，面板修复路径须等 Q2 的 host 放行；既有弹窗的整链重发 400 属既有雷 |
| 冲突④ | `STATUS_LABELS` 被成员状态 pill 复用，若整体替换会破坏成员态文案 | eteamsView.tsx:181-195、2522 | 共存策略（B.3）：STATUS_LABELS 降级为 13 态精确词表，展示态映射只用于任务位 |
| 冲突⑤ | `STATUS_GROUPS` 收敛会改变顶层任务行的分组呈现（10 组 → 展示态组），属可见的行为变化 | eteamsView.tsx:163-179、4446-4499 | 在 B.3 明示；若验收反对，回退方案=保留 10 组分组、仅行内换展示态 pill（记录为 Q7） |
| 风险① | HTML5 拖拽在宿主 GUI 实装内的实际手感（宿主全局事件、BrowserView 缩放）未经实机验证 | E18 推导 | 四绿门外加 GUI 实装目检项：拖拽悬停高亮、drag image、Esc 取消 |
| 风险② | 1s 轮询整包替换在拖拽进行中触发重渲染 | monitor.ts:24、229-240 | react-dnd 的 monitor 状态由内部 manager 持有，不受快照替换影响；但 hover 高亮读取的 `task.chain` 可能中途更新——drop 时以 drop 事件携带的最新 task 重新计算 nextChainAfterDrop，不缓存 JSX 闭包里的旧 chain |
| 风险③ | 大团队 × 多组卡时成员罗列条（逐卡）与框的视觉密度 | 成员数上限 = `env.config.maxMembers`（默认 8，`cordis.patch.yml:24`；`teamOps.ts:248` 校验，含领队占额） | chip 26px 高、罗列条 flex-wrap，密度可控；不做虚拟化 |
| 风险④ | react-dnd v16 ESM-only 进 CJS envelope 的打包面 | tsdown.config.ts:120-153 | Rolldown 以 bundler 输入消化 ESM 依赖（radix/lexical 先例同面）；四绿门 + 冒烟验证 envelope 求值 |
| 风险⑤ | 触屏/键盘无拖拽通道 | A.7 | 空框与框 chip 点击 = 打开「修改」弹窗（Select 全功能等价路径） |

---

# 29.6 开放问题

| # | 问题 | 建议 |
| --- | --- | --- |
| Q1 | host 是否要补齐「ready 中间站仅追加」的链编辑校验（对齐 docs/06.4）？ | 后续独立小改：`updateTask` 在 `chainCursor≥0` 时拒绝替换 index≤cursor+1 的站点；本期客户端守卫先行 |
| Q2 | 悬空名链的宿主语义：`updateTask` 是否应放行「含已移除成员的既有站点」？ | 倾向放行（历史站点只读），避免既有弹窗整链重发 400；需产品确认 |
| Q3 | `createTask` 的 stageBrief 非空校验是否放宽到与 update 一致？ | 放宽（空 brief = 交接物待定），低风险 |
| Q4 | 任务页成员罗列条是否补「＋ 添加成员」快捷入口？ | 本轮不加（避免第二套加人通道）；用户验收后定 |
| Q5 | 组卡较多时成员罗列条是否 sticky（滚动跟随）？ | A.5.3 已按用户决策改为每卡一条（源条随卡就近可见），sticky 不再需要；若未来改回区块级单条再评估 |
| Q6 | 展示态图标用字符（⏳/✕）还是 lucide 深层导入？ | 先字符（与 ✔/●/◌ 同语言、零体积）；docs/24 D22f 的 lucide 纪律允许后续替换 |
| Q7 | `STATUS_GROUPS` 收敛为展示态分组是否保留「待决策/已挂起」等细分分节？ | 默认收敛；若用户要操作导向的细分，退回 10 组 + 行内展示态 |
| Q8 | 展示态是否回写 docs/06.8 词表（展示层口径入基线）？ | B 节验收后在本文件或 docs/06 补一节「展示态派生」引用，不改状态机文档正文 |