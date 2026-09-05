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
| E4 | `updateTask` 校验：任务须 `draft/ready`（否则「合同已冻结」）；chain 逐站校验**成员名在 `team.members`（member 表模板行）——不查 removed**（removeMember 只标 taskMembers 实例行 status，模板行保留，悬空名可过校验）；**不校验 stageBrief**；chain 全量替换 | [assignment.ts](../src/host/runtime/assignment.ts):242-247（状态闸）、257-263（链校验）、266（全量替换） |
| E5 | `createTask` 与 E4 不对称：建任务时 `stageBrief` 空串会被拒 | [assignment.ts](../src/host/runtime/assignment.ts):144-145 |
| E6 | 编辑矩阵口径：`draft / ready（chainCursor=-1，未被领取）可整体编辑执行链；执行开始后链不可改；ready 中间站仅允许追加` | [docs/06](06-task-lifecycle.md) §6.4:76-93 |
| E7 | 链推进：站点完成→任务回 ready、cursor+1；`stationStatusOf` 把 index≤cursor 记 done、cursor+1 记 current | [taskMachine.ts](../src/host/model/taskMachine.ts):151-165；[webui.ts](../src/host/runtime/webui.ts):103-115 |
| E8 | 领队（项目牧羊人）**不是** `team.members` 记录：快照单列 `captain`，成员表由 `addMember` 逐个追加（status 初始 `staged`）；`leaderRemoved` 标志控制是否计入人数 | [webui.ts](../src/host/runtime/webui.ts):190-236；[teamOps.ts](../src/host/runtime/teamOps.ts):194-311、243-253；[roster.ts](../src/host/runtime/roster.ts):214、238-267 |
| E9 | 领队「不接任务：负责拆解、指派与调度」是既有 UI 口径 | [eteamsView.tsx](../src/client/eteamsView.tsx):2232、2537 |
| E10 | `TeamSnapshot.members` 已滤除 removed 成员；`MemberView` 带 `status/role/avatar` | [webui.ts](../src/host/runtime/webui.ts):236；[monitor.ts](../src/client/monitor.ts):36-62 |
| E11 | `removeMember` 只把 **taskMembers 实例行**标 `removed`（member 表模板行保留），**不清理任何 chain 站点** → 链内悬空名（编辑期可过校验，E4） | [teamOps.ts](../src/host/runtime/teamOps.ts):693 |
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
| DA3 | drop 语义 | drop = 写入该小任务的 **chain（成员槽）**，复用 update 路由 **chain 全量替换**；成员框 = 接力槽位（2026-09-04 二轮 DA13：框承整链，空白处 drop=追加、chip drop=替换） |
| DA4 | drop 写入语义（2026-09-04 二轮修订：按序接力） | 拖到框**空白处 = 追加**新站点（末尾 `{member, stageBrief:''}`）；拖到框内**某站点 chip 上 = 替换**该站成员（stageBrief 原值保留）；框内 chip 的 `×` = 移除该站（可编辑窗口内任意站，整链重发；仅剩一站时移除即 chain 变 `[]`，回到「领队自由指派」，docs/06 §6.7:127 合法）。原「替换下一待执行站（单站=chain[0]）」口径废止——变更注记见 A.3.1 |
| DA5 | 框承范围（2026-09-04 二轮修订） | 可编辑窗口内框**承整链**：全部站点按序渲染成 chips（顺序=接力顺序），抑制 `TaskStations` 重复渲染；开跑后（`chainCursor ≥ 0`）或合同冻结 → 框转只读承单站（assignee 优先，否则下一待执行站），其余站点由 `TaskStations` ✔/●/◌ 渲染。整链的精细编辑（重排/stageBrief）仍走「修改」弹窗 |
| DA6 | 编辑窗口 | 可放置 = `subMutable（draft/ready）&& chainCursor === -1`；`chainCursor ≥ 0` 或已领取 → 框转只读展示（对齐 E6，比 host 更严，见 29.5 冲突②） |
| DA7 | 可拖成员集合 | `team.members` 全量（快照已滤 removed，E10）；**staged 成员可拖**（host 校验只排除 removed，E4），chip 加「未启动」弱化标记；**领队不在集合内**（E8，且与「领队不接任务」口径一致，E9） |
| DA8 | 去重（2026-09-04 二轮修订：全链去重） | 拖入成员与**链内任一站点**同名 → no-op（不发请求 + 200ms 边框闪现）——接力链同一成员占两站无意义，且防误操作；原「仅目标站去重、链内其他站允许」口径废止。已被指派（assignee）去重场景不存在——可编辑任务的 assignee 恒为 null |
| DA9 | 悬空名 | 链内已移除成员的名字照常渲染（弱化「已移出」）。**未开跑链（可编辑窗口）的悬空名可在框内任意站 chip 上拖拽替换修复**（DA13 框承整链）；**已开跑链的悬空名也可修复**——「修改」弹窗整链重发 host 实际放行（E4：链校验只查 member 表模板名、不查 removed；一轮设计「整链重发 400」断言有误，见 29.5 冲突③二轮订正），风险在执行侧：轮到该站时的指派/唤醒路径才会因成员已移出而失败 |
| DA10 | API | 复用 `updateTeamTask`（chain 全量替换，E2/E3），**不新增精简路由**；**非乐观更新**（等 host 返回 + `refreshActivitySoon`） |
| DA11 | 错误提示 | 行内 `FormErrorNote`（E17/E22 既有模式）：拖拽 POST 400 时在受影响小任务行下方就地显示 host 文案，下一次成功/关闭时清除 |
| DA12 | 无缝集成 | 只改 TasksTab 小任务行 + 组卡 + 新增成员罗列条；主任务卡结构、看板、汇报不动 |
| DA13 | 多人协作语义 | **按序接力**（2026-09-04 用户二次拍板，本轮需求「卡槽可以放多个人员」）：成员框升级为多人槽位，可放多个成员、按拖入/站序接力执行（前站完成后下一站接手）；**同站并行不采纳**——需改宿主数据模型（站点单成员→成员数组）、任务机与提示词，改动面大；并行需求以「拆多个小任务」承接（同组卡多小任务即并行） |
| DA14 | chip 规格 | 罗列条/领队/成员框 chip 统一 **30px 高 + Avatar 22px**（2026-09-04 用户拍板「头像弄大一点」，原 26/18）——A.5.1/A.5.3 规格随之更新 |
| DA15 | 接力链上限（**已废止**） | ~~最多 2 站~~（2026-09-05 三轮拍板后**同日四轮废止**——用户拍板「接力链不设上限」）：`MAX_CHAIN_STATIONS`/`canAppendStation` 删除、容器 canDrop 恢复对称、「修改」弹窗恢复加站；本行仅留决策痕迹 |
| DA16 | 头像-only 卡槽 chip（**四轮调整**） | ~~卡槽 chip 只显示头像~~（三轮 2026-09-05，**四轮调整**——用户要求「名字和工号都显示出来」）：卡槽 chip 恢复「头像+名字」并加显**工号**（employeeId，`ET-0001` 格式，legacy null 不显）；头像 26px / chip 高 32px 保留；罗列条/领队/只读框 chip 同步 26px 不变 |
| DA17 | 卡槽位置与内容（2026-09-05 四轮拍板） | 卡槽从行尾移到**任务行下方独立一行**（不再挤行尾按钮区）；卡槽 chip 内容 = **Avatar 26px + 名字 + 工号**（四轮）；接力链不设上限（DA15 废止）。接力语义（追加/替换/移除/去重）不变 |
| DA18 | 版面微调（2026-09-05 五轮拍板） | ①卡槽容器**横向单行**（去 280px 宽上限与换行，超宽横向滚动）；②工号不占版面——站点 chip/只读 chip 的工号折叠进**悬浮提示**（title）；③卡槽/框/chip 圆角收小为 **4px**（rounded-md/full → rounded-[4px]，含罗列条与领队 chip）；④罗列条 staged 成员的「未启动」小字改**工号数字徽章**（`employeeBadgeOf` 剥 `ET-` 前缀只显数字，legacy null 不渲染；staged 态由状态点表达）；⑤罗列条拖动提示**独占一行**（chips 下一行） |
| DA19 | 链编排收进卡槽（2026-09-05 六轮拍板） | ①卡槽内站点 chip **拖动调序**（chip→chip 数组搬移，stageBrief 随站走；自拖自放 no-op；容器不收站点类型——空白处无落点）；②行尾「＋」改**多选按钮**：点开 Popover 面板列全部团队成员（已在链中的禁用），勾选多人按勾选顺序末尾追加；空框点击/键盘同开面板；③**「修改」弹窗不再编排链**（成员槽编辑段撤除，update 不发 chain——主题/说明等字段编辑保留）。站点说明（stageBrief）随弹窗撤除暂无编辑入口（Q6） |
| DA20 | 小任务卡片拖拽调执行顺序（2026-09-05 七轮拍板） | ①组卡内小任务渲染为**全边框卡片**（同组卡观感，挂靠缩进 ml-4 保留），按**执行序**展示并带序号（`executionOrderOf` 兄弟依赖拓扑序，创建序平局）；②卡片兼作拖拽源/放置目标（新 item 类型 `eteams-subtask`）：拖 A 卡到 B 卡 = **调执行顺序**——语义落地为**兄弟依赖链改写**（`depPatchesForReorder`：数组搬移同 chip 口径、第 k 位依赖第 k-1 位、外部依赖保留、只发 deps 实际变化且 draft/ready 的补丁），逐发 `updateTeamTask({dependencies})`（host 依赖闸沿用，非乐观更新），语义详见 A.3.4；③同轮修复面板建小任务**挂靠丢失** bug——create 路由 `parentTaskId` 此前走 `str()` 只收字符串，客户端发的 JSON number 被静默丢弃 → 小任务落到顶层（组卡之外）且主任务计数不变；改 `readTaskIdParam`（number/数字串都收） |
| DA21 | 任务页拆**列表页 + 详情页**，编排全迁详情（2026-09-05 八轮拍板） | 用户原话「将任务做成任务详情页面和任务列表页面，点击到详情再编排整个任务」：①**列表页精简化**——组卡只剩头部信息（#id/主题/展示态/进度/汇总 chip/文件夹）+ 小任务精简行（执行序号/#id/主题/展示态/阻塞/指派，点击进详情），顶层任务行去掉站点行与依赖 chips；列表上**无任何编排 UI**（新增/改删/卡槽/拖拽/罗列条全撤）。②**详情页两级**——主任务详情 = 编排面（返回条 + 头部卡 + 新增小任务 + 小任务卡片全套（执行序号/卡槽/拖卡调序/修改删除）+ 成员罗列条单条）；任务/小任务详情 = 返回条 + 头部卡（小任务含修改/删除）+ 挂靠行 + `TaskDetailContent` 正文（合同四数组/状态说明/阻塞/产出/尝试时间线）+ 卡槽 + 站点行 + 依赖 chips + 罗列条。③**导航状态复用** ui model `drawerTaskId`（语义改为「详情页选中的任务 id」，null=列表页；选中任务被删自动回落列表）。④原 S13 shadcn Dialog 抽屉（`TaskDrawer`）**撤除**——详情正文改内联组件 `TaskDetailContent` 由详情页消费（标题/状态头由详情页渲染） |
| DA22 | 列表页组卡**只承状态概览**（2026-09-05 九轮拍板） | 用户原话「任务列表中的任务卡片不展示任务详情和整个任务列表，需要点击进去再看到整个任务列表」：主任务卡片撤掉八轮的小任务精简行——列表页组卡只剩头部（#id/主题/展示态）+ 进度计数（小任务 n/m 完成）+ 汇总 chip（ready）+ 文件夹，**整个任务列表只在主任务详情页看**（整卡点击进详情，导航口径不变）。计数/汇总与顺序无关，列表组卡不再调 `executionOrderOf`（详情页分支照旧拓扑排序） |
| DA23 | 小任务列表**把手拖拽**（2026-09-05 十轮拍板，含订正） | 用户原话「团队列表左上角新增一个拖拽图标，只有拖拽图标可以拖拽」（初读误为任务列表页主任务卡加把手，用户随即订正「错了不是任务列表，而是小任务列表，任务列表去掉拖拽」）：①**任务列表页无拖拽**——主任务卡保持九轮 DA22 状态概览（整卡点击进详情，展示序维持普通 filter 无拓扑排序），本轮误加的把手/调序撤除；②**主任务详情页小任务列表**：小任务卡片**左上角新增 grip 把手**（GripVertical，'eteams-subtask' item 不变）——**只有把手是拖拽源**（dragRef 只挂把手 span，canDrag = draft/ready，不可编辑态把手淡化），卡身不可拖；③卡身仍兼**放置目标**（同父兄弟卡可落，悬停 ring）——拖 A 把手落 B 卡 = 调小任务执行顺序，语义与七轮 DA20 完全一致（兄弟依赖链改写补丁，非乐观更新），仅拖拽源从整卡收窄为把手；④卡身点击 = 进小任务详情页不受影响（HTML5 拖拽不触发 click） |

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

规则（全部落 E4/E6/E7；2026-09-04 二轮按 DA13 按序接力修订）：

| 前置条件（任务） | drop 行为 |
| --- | --- |
| `chain.length === 0`（可编辑） | 生成 `[{member, stageBrief:''}]`（单站，追加语义同款）；点击空框 / 键盘 Enter/Space = 打开「＋」成员多选面板（六轮 DA19） |
| `chainCursor === -1` 且 draft/ready（任意链长） | 拖到**框空白处** = 末尾**追加** `{member, stageBrief:''}`（不设上限——DA15 曾限 2 站，四轮废止）；拖到**框内某站点 chip** = 替换该站成员、stageBrief 原值保留（同站同名即 DA8 no-op，不发请求）；**站点 chip 拖到另一站点 chip** = 调序（六轮 DA19：被拖站搬移到目标位、stageBrief 随站走，自拖自放 no-op）；**「＋」点击** = 成员多选面板（六轮 DA19：勾选若干人按勾选顺序末尾追加，已在链中的成员禁用） |
| `chainCursor ≥ 0`（已开跑：站点已完成/当前站） | 不注册 drop target（只读） |
| 非 `draft/ready`（assigned/in_progress/…/终态） | 不注册 drop target（只读，DA12：合同冻结，E4 状态闸会拒绝，客户端直接不给入口） |

> **变更注记（2026-09-04 二轮）**：原口径「drop 一律替换下一待执行站（单站替换 `chain[0]`、多站替换站点 0）」由 DA13 按序接力取代——框升级为多人槽位后：空白处 drop=追加、chip 上 drop=定点替换、chip `×`=逐站移除；同名去重从「目标站」扩为全链（DA8）。多站点任务的追加不再要求走「修改」弹窗，框上即可追加；嵌套 drop target（chip ⊂ 框）用 `monitor.didDrop()` 防双触发、容器以 `isOver({shallow:true})` 区分空白处与 chip 悬停；**chip 与容器的 `canDrop` 必须同条件**（同一 eligible 判定）——dnd-core 按 canDrop 过滤目标集后内层先 drop，chip 若更严会被滤掉、落点误成容器「追加」，语义分流只由 `didDrop` 承担。

> **变更注记（2026-09-05 四轮，DA15 废止/DA16 调整/DA17）**：接力链**不设上限**——三轮的容器 `canDrop` 非对称收紧随 DA15 废止撤销，chip 与容器恢复同条件（`eligible`）；卡槽从行尾移到任务行下方独立一行（drop/didDrop/shallow 机制不受位置影响）；卡槽 chip 内容 = Avatar 26px + 名字 + 工号（employeeId），`×` 恢复 chip 内按钮。头像 26px / chip 32px / 去重 / 逐站移除 / 嵌套 drop target 机制均沿二轮口径不变。

> **变更注记（2026-09-05 六轮，DA19 链编排收进卡槽）**：站点 chip 兼作**拖拽源**——拖到另一 chip = 调序（`chainAfterReorder` 数组搬移）；「＋」由装饰提示改**多选按钮**（Popover 面板 `chainAfterAppendMany`）；「修改」弹窗的成员槽编辑段**撤除**（update 不发 `chain`——链编排唯一入口是卡槽）。双 item 类型：`eteams-member`（罗列条成员，drop=追加/替换）与 `eteams-station`（站点 chip，drop 到 chip=调序）；站点 chip 的 accept 为**双类型数组**（dnd-core `matchesType` 对数组走 `.some` 匹配），容器仍只收 `eteams-member`——调序只能 chip→chip，空白处对站点类型无落点（not-allowed 即语义）。

> 纯函数签名：`nextChainAfterDrop(task, member, stationIndex?)`——`stationIndex` **缺省（空白处 drop）= 末尾追加** `{member, stageBrief:''}`（不设上限）；显式传站点下标（chip drop）= 定点替换该站成员、stageBrief 保留。返回 null = no-op（不可编辑 / 全链同名去重 / 越界下标）。六轮新增：`chainAfterReorder(task, fromIndex, toIndex)`（from===to / 越界 / 只读 → null）、`chainAfterAppendMany(task, members)`（按勾选顺序追加，过滤链内已存在名字，一个都不新增 → null）。七轮新增：`executionOrderOf(tasks)`（兄弟依赖拓扑展示序）与 `depPatchesForReorder(tasks, from, to)`（拖卡 → 依赖改写补丁，A.3.4）。

- **移除**：框内每个站点 chip 带 `×`（可编辑窗口内任意站，`canRemoveStation`）→ 移除该站后整链重发；仅剩一站时移除即 chain = `[]`（回到无链任务，领队自由指派，E6/docs/06 §6.7:127）。~~整链重排/批量调整仍走「修改」弹窗~~——六轮 DA19 起整链重排改卡槽内 chip 拖动调序，弹窗不再编排链。
- **追加**：框空白处拖入即追加（多站链同样直接追加）——原「不在框上追加、拖一次多一站的意外增长」顾虑由双 target 语义分明化解（chip=替换、空白=追加），且追加空 brief 合法（E4 asymmetry，见 29.5 冲突①）；六轮 DA19 起另有「＋」多选面板批量追加（已在链中成员禁用勾选）。
- **stageBrief**：拖拽写入空串合法（E4 asymmetry，create 才拒绝，见 29.5 冲突①）；拖拽不改写文案。~~改文案走「修改」弹窗~~——六轮 DA19 弹窗编排撤除后**站点说明暂无编辑入口**（替换保留原值、调序随站走、追加为空串）；如需恢复再评估（开放问题 Q6）。建议后续把 E5 的 create 校验放宽到与 update 一致（开放问题 Q3）。
- **去重**：`nextChainAfterDrop` 若发现拖入成员与链内**任一站点**同名 → 返回 null，给出一次 200ms 微反馈（不发请求）——**flash 落点跟随 drop 命中面**：落在 chip 上闪该 chip（复用悬停 ring 高亮），落在空白处闪容器边框。顶层任务的 assignee 去重不存在（可编辑窗口内 assignee 恒 null，E4 指派只发生在 ready 之后）。

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

### A.3.4 小任务卡片拖拽调执行顺序（七轮 DA20：兄弟依赖链语义）

「小任务做成卡片、卡片也能拖拽调整执行顺序」落地为**依赖改写**，不新增排序通道：host 对执行先后的强制机制本就是 `dependencies`（物化阻塞 wait + blockedFrom，docs/36），面板「执行顺序」= 组卡内小任务（同 `parentId` 兄弟，含 null 顶层）构成的**线性依赖链**（第 k 位依赖第 k-1 位）。规则：

| 项 | 口径 |
| --- | --- |
| 展示序 | `executionOrderOf(tasks)`：兄弟集内依赖做分层拓扑排序（Kahn，逐轮按输入序=创建序平局）；兄弟集外的外部依赖不参与兄弟排序；环/悬空引用（防御，host 侧 wouldCycle 本应杜绝）剩余按输入序追加，不丢任务 |
| 拖拽 | 卡片即拖拽源（`eteams-subtask`，draft/ready 才可拖，拖拽中半透明）+ 放置目标（**同父兄弟卡**才可落，悬停 ring 高亮）；拖 A 到 B = A 搬到 B 的执行位（数组搬移，同六轮 chip 口径：前移插目标前、后移插目标后）；点击整卡仍是开合详情抽屉（拖拽不触发 click）（**十轮 DA23 收窄**：拖拽源改为左上 grip 把手、卡身只作放置目标、卡身点击 = 进小任务详情页——见下方增补段） |
| 补丁 | `depPatchesForReorder(tasks, from, to)`：按新执行序重写兄弟依赖为**线性链**（第 k 位依赖第 k-1 位），各卡**外部依赖保留**；只发 deps 实际变化且 draft/ready 的卡——已领取/冻结的兄弟不改写（host 会拒），其链位滑动为已知口径；from===to / 找不到卡 / 非同父 / 端点不可编辑 / 全部无变化 → null 不发请求 |
| 提交 | 补丁按序逐发 `updateTeamTask(teamId, taskId, { dependencies })`（**非乐观更新**，成功 `refreshActivitySoon`；部分失败也回拉快照对齐），落点卡行内 `FormErrorNote`（`reorderError` 同 `assignError` 模式）；host `updateTask` 依赖闸（自依赖/不存在/wouldCycle/draft-ready）沿用，update 路由本轮补 `dependencies` 透传（`readDependenciesParam` 整包收紧——非数组/含非数元素视为缺省不改字段，畸形载荷不半改写） |
| 通道 | 复用 update 路由（DA10 同款）；api.ts `updateTeamTask` 增 `dependencies?: number[]`（整体替换） |

**十轮 DA23 增补（小任务卡把手拖拽）**：拖拽源从整卡**收窄为左上 grip 把手**（GripVertical）——dragRef 只挂把手 span（`canDrag` = draft/ready，不可编辑态把手淡化 opacity-40），卡身 div 只挂 dropRef（canDrop 口径不变：双方 draft/ready 且同父兄弟），children 内容包 `min-w-0 flex-1` 容器与把手并排。`depPatchesForReorder`/`executionOrderOf` 零核心改动（兄弟集仍由调用方传入数组按 parentId 现算，详情页照旧传全量 `team.tasks`）；HTML5 拖拽不触发 click——卡身点击进小任务详情不受影响。任务列表页无拖拽（十轮订正：初版误给列表页主任务卡加把手调序，已撤除并恢复九轮口径）。

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

### A.5.1 成员卡槽（TaskAssignDropBox；2026-09-04 二轮按 DA13/DA14、2026-09-05 三/四/五/六轮按 DA15（废止）/DA16/DA17/DA18/DA19 修订）

**位置（四轮 DA17）**：卡槽从行尾移到**任务行下方独立一行**（不占行尾按钮区；点击不冒泡到任务行）。

| 态 | 规格 |
| --- | --- |
| 空框 | 虚线边框槽：`h-[32px] min-w-[96px] rounded-[4px] border border-dashed px-2 text-xs text-muted-foreground`（圆角 4px，五轮 DA18），文案「＋ 拖入成员」（BORDER_L1 类边框 token，E16）；**点击 / 键盘 Enter/Space = 打开「＋」成员多选面板**（六轮 DA19——弹窗不再编排链） |
| 已放置（任意站数，不设上限） | 容器虚线圆角框**横向单行**（`rounded-[4px] border-dashed px-1.5 py-1 max-w-full flex-nowrap overflow-x-auto`——五轮 DA18：去 280px 宽上限与 flex-wrap 换行，超宽横向滚动）内按序排布站点 chips——顺序=接力顺序；每个 chip：中性 pill `h-[32px] rounded-[4px]`、`Avatar` **26px** + 名字 12px（**工号折叠进 title 悬浮提示**，五轮 DA18——「站点 N：名字（工号，已移出）」；legacy 无工号不带括注）+ 悬空名「已移出」标记 + `×` 移除钮；chip **可拖动调序**（六轮 DA19：拖到另一 chip=搬移到该位、拖拽中半透明）；行尾「＋」**多选按钮**（六轮 DA19：Popover 面板勾选成员追加，替换原装饰性提示 span） |
| 拖拽悬停（容器空白处） | `canDrop && isOver({shallow:true})`：虚线转实线 + `border-primary bg-[color:var(--eteams-pill-bg)]`，文案/提示指向「追加」（仅成员类型——容器不收站点类型，六轮 DA19） |
| 拖拽悬停（chip 上） | 该 chip `ring-1 ring-primary` brand 环（box-shadow 不引发回流）+ 上浮阴影（=替换该站；站点 chip 拖到其上=调序，六轮 DA19）；容器不追加高亮（shallow 区分） |
| 拖拽可放置（非悬停） | 虚线边框转 `border-[color:color-mix(in_srgb,var(--primary)_60%,transparent)]`（提示可落点；token 纪律禁 /alpha，与 BOX_CAN_DROP_CLASS 一轮口径一致） |
| 不可放置/只读 | 不注册 drop target；chip 静态渲染（中性 pill `h-[32px] rounded-[4px]` + Avatar 26px + 名字 + 悬空标；工号入 title，五轮 DA18）；已移除成员名字弱化 + 「已移出」标记 |
| 提交中 | `assignBusy` 时整框禁用 + 透明度 50%（含「＋」面板确认钮） |

可编辑窗口内框承整链（DA5），一律**抑制** `TaskStations` 的重复渲染（`boxCoversChain` 纯函数；站点行与框 chips 内容重合，E13）；开跑后（`chainCursor ≥ 0`）恢复 `TaskStations` + 框只读承单站。多站容器空白处 / chip 点击 = 打开「修改」弹窗（主题/说明等，键盘 Enter/Space 同路径；六轮 DA19 起弹窗不再编排链），空框点击 = 「＋」多选面板（A.7）。

### A.5.2 界面草图（2026-09-05 八轮 DA21 页面化 + 九轮 DA22 列表概览化 + 十轮 DA23 小任务卡把手：列表页 ↔ 详情页；四轮卡槽下置 + 七轮卡片化口径并入详情页草图）

**列表页（精简概览，无小任务明细、无拖拽——十轮订正）**：

```
┌ 对话任务 · 1 ───────────────────────────────────────────────────────────┐
│                                                                          │
│ ┌ #t7-101 登录页改版 ◔ 待指派 ─────────────────────────────────┐        │
│ │ · 小任务 2/3 完成                                             │        │
│ │ 文件夹：登录改版/                                             │        │
│ │ （九轮 DA22：不列小任务明细——整卡可点，整个任务列表在详情页； │        │
│ │  十轮订正：任务列表页无拖拽）                                  │        │
│ └───────────────────────────────────────────────────────────────┘        │
│                                                                          │
│                                                                          │
│ ─ 待接取 · 1 ──────────────────────────────────────────────              │
│ │ #t9 数据迁移 ◔ 待接取 · · 王五   ←顶层任务精简行（站点行/     │        │
│ └────────────────────────────────────────────  依赖 chips 迁详情页）│    │
└──────────────────────────────────────────────────────────────────────────┘
```

**主任务详情页（= 整个任务的编排面；返回条 + 头部卡 + 编排全套）**：

```
│ ← 返回列表                                                              │
│ ┌ #t7-101 登录页改版 ◔ 待指派 · · 王五 ┐                                 │
│ │ 文件夹：登录改版/                    │←头部卡                           │
│ └──────────────────────────────────────┘                                 │
│ · 小任务 2/3 完成                                                        │
│ [＋ 新增小任务]                                                          │
│                                                                          │
│ ┌ ⠿ 1. #t2 登录页设计 ◌ 已创建 ─ [修改] [删除] ┐←小任务卡片               │
│ │ ↑ 十轮 DA23：把手 = 唯一拖拽源          ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐  （七轮     │
│ │ ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐  │ (◉张三)×  (◍李四)× [＋多选] ╎ DA20：   │
│ │ ╎                                 ╎  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘  拖 A 到   │
│ │ └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘   B=调执行顺序）             │        │
│ └──────────────────────────────────────────┘                             │
│ （卡身点击 → 小任务详情页；把手不可编辑态淡化；卡槽/按钮点击不冒泡）       │
│ ─────────────────────────────────────────────────────                   │
│ 团队成员                                                                 │
│ ┌────────┐ ┌────────┐ ┌──────────┐ ┌╌╌╌╌╌╌╌╌┐                           │
│ │(◉张三) │ │(◉李四) │ │(◔王五)   │ │(◆项目牧羊人│←领队 chip：       │
│ │ 研究员 │ │ 工程师 │ │ [0001]   │ │  领队   ╌╌│  带徽标、不可拖    │
│ └────────┘ └────────┘ └──────────┘ └╌╌╌╌╌╌╌╌┘                           │
│ 拖到本卡小任务下方的成员卡槽完成指派（提示独占一行，五轮）                │
```

**任务/小任务详情页**（返回条 + 头部卡（小任务含修改/删除）+ 挂靠行 + 正文）：

```
│ ← 返回列表                                                              │
│ ┌ #t3 接口联调 ● 进行中 · · 李四 ┐                                       │
│ 挂靠：#t7-101 登录页改版                                                 │
│ ┌ 验收标准 / 范围内 / 范围外 / 交付物（合同四数组，空组不渲染）┐          │
│ │ 状态说明 / 幂等说明 / 产出 / 尝试时间线（track 拉取）        │←正文     │
│ │ ✔张三 → ●李四      站点 1/2                                 │          │
│ └────────────────────────────────────────────────────────────┘          │
│ [依赖 t2]（draft/ready 时另有卡槽 + 罗列条）                             │
```

（原四轮版单页草图——组卡内嵌卡槽/罗列条/新增按钮——随页面化废止：卡槽/罗列条/
新增/改删全部只出现在详情页。）

### A.5.3 成员罗列条（八轮 DA21 调整：详情页单条；原逐卡 placement 用户 2026-09-04 已确认、2026-09-05 八轮页面化后废止）

**八轮 DA21（2026-09-05）调整**：任务页拆列表页 + 详情页后，罗列条**随编排走**——只在详情页渲染**单条**（主任务详情：存在可放置小任务时；任务/小任务详情：小任务且可编辑时），列表页不再出现。下述「每张组卡下方各一条」的逐卡 placement 为页面化前的历史决策，废止。

**逐卡决策（历史，用户 2026-09-04 拍板）：成员罗列条渲染在每张任务单（group）卡内的下方——小任务行之后，每卡一条。** 回归用户原话「在任务下方把所有成员罗列出来」的字面位置。设计稿曾论证「区块级单条」（同队成员对全部组卡相同、去重、置顶视线），经用户确认**不采纳**；本文按用户决策执行：逐卡重复渲染一份相同副本（可拖拽 chip），拖拽源与放置目标在同一卡内就近可见。

- 条内 chip：`Avatar` 26px + 名字（12px medium）+ 状态点（memberTone）；**工号数字徽章**（五轮 DA18，2026-09-05 拍板「未启动改成工号，别 ET- 就显示数字」：`employeeBadgeOf` 剥 `ET-` 前缀只显数字，`STRIP_BADGE_CLASS` 小型徽章面；legacy null 不渲染——原 staged「未启动」小字废止，staged 态由状态点表达）；领队 chip 单列置首、带「领队」徽标、不可拖（口径不变）；chip 高统一 32px（DA14 30px → DA16 三轮；圆角 4px，五轮 DA18）。
- chip 规格复用 `ROLE_CHIP_CLASS` 的品牌淡底变体做「可拖」签名（`bg-business-tint`，E16），hover 提示 `title="拖到小任务下方的成员卡槽完成指派"`，cursor `grab/grabbing`。
- 「从成员库添加」入口：**不在罗列条内提供**（DA12/E21）；拖动提示独占 chips 下一行（12px 说明文字，五轮 DA18——不再与 chips 挤同一行）。若用户验收时要求快捷加人，再评估（Q4）。
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
| 删除成员后框内悬空名（未开跑链，可编辑窗口） | 名字照常渲染 + 弱化「已移出」标记；拖入新成员**到该站 chip 上**即替换（DA9 随 DA13 放宽：任意站）——替换后的整链不含悬空名、可过校验 |
| 悬空名在已开跑链 | 框只读承单站（拖拽不可达）；「修改」弹窗整链重发 host **放行**（E4 链校验只查 member 表模板名、不查 removed）——悬空名可经弹窗修复；真实风险在执行侧：轮到该站时指派/唤醒路径才可能失败 |
| staged 成员被拖入 | 允许（host 放行），chip 带「未启动」标记；该成员后续 spawn 后正常接任务（docs/26 §26.2 步骤 3） |
| 团队 phase==='staged'（批准前） | 照常可拖（小任务 draft 可改，批准时统一 draft→ready，docs/26 §26.2 步骤 5） |
| 触屏 | HTML5 backend 不支持——不引入 touch backend（A.6 结论）；加站：空框 / 「＋」**点击 = 成员多选面板**（六轮 DA19，可点可勾选）；移除：chip `×` 可点；**调序无触屏通道**（chip 拖动仅鼠标——已知限制，触屏设备暂由领队在建链时按序添加规避；小任务卡片调执行顺序同限，七轮 DA20） |
| 键盘 | 空框可聚焦（`tabIndex`），Enter/Space = 打开「＋」多选面板（六轮 DA19）；多站容器 Enter/Space = 打开「修改」弹窗（主题/说明）；「＋」按钮与面板勾选行均可 Tab 聚焦；调序无键盘通道（同上已知限制；卡片调执行顺序同限，七轮 DA20——执行顺序仍可经既有依赖编辑面调整） |
| 拖拽进行中快照轮询到达 | drop 时以最新快照的 task 重算 `nextChainAfterDrop`，不缓存旧 chain（风险②） |
| 同名成员去重 | 拖入成员与链内任一站点同名 → no-op（DA8 二轮：全链去重）；可编辑窗口内 assignee 恒 null，不存在「已是执行人」场景 |

## A.8 无缝集成点（改动面收敛）

| 位置 | 改动 |
| --- | --- |
| `TasksTab` 小任务行（原 eteamsView.tsx，现 tasksTab.tsx） | 任务行下方独立一行挂 `TaskAssignDropBox`（四轮 DA17，原行尾）；可编辑窗口抑制 `TaskStations`（二轮 `boxCoversChain`，DA13） |
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
| 任务详情（原 TaskDrawer Dialog；八轮 DA21 页面化后 = 任务详情页 + `TaskDetailContent`） | **保留 13 态精确文案**（详情页是操作语境，`blockedFrom`/attempt 状态等精度必要；attempt 行同理）。八轮页面化注记：详情页头部实际走展示态 pill（DisplayStatusPill），`STATUS_LABELS` 降为键序规范来源 |
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
| `src/client/features/tasks/taskAssign.tsx` | `DndProvider(HTML5Backend)` 包裹器、`MemberDragChip`（useDrag 'eteams-member'）、`TaskAssignDropBox`（useDrop + canDrop 预判）、`nextChainAfterDrop` 纯函数；类名全部完整字面量映射表（E17 纪律） |
| `src/client/features/tasks/taskDisplayStatus.ts` | `displayStatusOf(status): {key,label,tone,icon,detail}`、`groupDisplayOf(subs)` 纯函数（B.1/B.2） |
| `src/client/pages/teamsView/tasksTab.tsx`（原 `src/client/eteamsView.tsx`，已拆分） | TasksTab：根包 DndProvider；小任务行下方独立一行挂 `TaskAssignDropBox`（四轮 DA17，原行尾；+可编辑窗口抑制 TaskStations，二轮后为 `boxCoversChain`）；每张组卡内小任务行之后插「团队成员」罗列条（逐卡一份，A.5.3 用户决策）；`assignBusy/assignError` 瞬态 + 行内 FormErrorNote；任务行/组卡换展示态 pill + detail；`STATUS_GROUPS` 分组定义落 `features/tasks/taskDisplayStatus.ts` |
| `src/client/lib/api.ts` | 不改（`updateTeamTask` 已支持 chain 全量替换，api.ts:343-360） |
| `src/client/lib/monitor.ts` | 不改（`TaskView.chain/chainCursor/chainLength`、`MemberView.status/avatar` 齐备，monitor.ts:77-102、36-62） |
| `src/host/**` | 不改（host 校验/路由/状态机零变更；29.5 冲突的 host 侧缺口只记录为开放问题） |
| `tests/taskAssign.test.ts`（新，建议） | `nextChainAfterDrop` 规则锁（一轮）：空链建站、同站替换、同名 no-op、多站只改站点 0、只读窗口——二轮起按 DA13 改写（见下行二轮行） |
| `tests/taskDisplayStatus.test.ts`（新，建议） | 13 态→展示态映射全表 + group 汇总优先级（error>doing>waiting） |
| `docs/README.md` | 阅读顺序表补 27/28/29/30 四行（2026-09-04 已随三篇落位一并增补）；D14 行加「细化口径见 docs/29」注记（A.3.3） |
| 二轮（2026-09-04，DA13/DA14 多人接力 + 头像放大） | `taskAssignCore`：`nextChainAfterDrop` 增 `stationIndex`（chip 定点替换）+ 全链去重；新增 `chainAfterRemove`/`canRemoveStation`/`boxCoversChain`（`canClearStation`/`clearedChain`/`dropTargetMember`/`boxRendersContent` 废止）；`taskAssign.tsx`：框承整链 chips + 嵌套 drop target（chip=替换、空白=追加）+ 行尾「＋」提示；chip 30px/Avatar 22px；`tasksTab`：`suppressStations` 换 `boxCoversChain`；`tests/taskAssign.test.ts` 规则锁同步改写 |
| 三轮（2026-09-05，DA15 接力链上限 + DA16 头像-only 卡槽） | `taskAssignCore`：新增 `MAX_CHAIN_STATIONS=2` 与 `canAppendStation`；`nextChainAfterDrop` 空白处追加满员 → null（替换不受限）；`taskAssign.tsx`：容器 `canDrop` 收紧 + 满员态（行尾「已满」、不高亮、title 注明）；卡槽 chip 头像-only（SLOT_CHIP_CLASS 32px 圆形容器 + Avatar 26px、名称/悬空标入 title、悬空灰度弱化、× 右上角角标）；chip 30→32px、各面 Avatar 22→26px；`tasksTab`：「修改」弹窗禁加站（满 2 站禁用按钮 + 标注上限）；`tests/taskAssign.test.ts` 增满员/`canAppendStation` 规则锁（295 用例） |
| 四轮（2026-09-05，DA15 废止 + DA17 卡槽下置与名字工号） | `taskAssignCore`：删除 `MAX_CHAIN_STATIONS`/`canAppendStation`（上限废止，`nextChainAfterDrop` 恢复无上限追加）；`taskAssign.tsx`：容器 canDrop 恢复对称（`eligible`）、卡槽 chip 恢复 pill 并显「Avatar 26px + 名字 + 工号（employeeId，legacy 不显）」+ 悬空标 + chip 内 ×、只读框 chip 同步加工号、罗列条提示文案改「拖到小任务下方的成员卡槽」；`tasksTab`：`TaskAssignDropBox` 从行尾按钮区移到任务行下方独立一行（点击不冒泡）、弹窗「添加站点」恢复可用；`tests/taskAssign.test.ts` 撤满员/canAppendStation 锁、恢复多站追加锁（292 用例） |
| 五轮（2026-09-05，DA18 版面微调） | `taskAssignCore`：新增 `employeeBadgeOf`（工号徽章文案——剥 `ET-` 前缀只显数字，null/空串 → null）；`taskAssign.tsx`：卡槽容器横向单行（`max-w-full flex-nowrap overflow-x-auto`，去 280px 上限与换行）、全部 chip/框圆角收小 `rounded-[4px]`（含罗列条与领队 chip，`rounded-full`/`rounded-md` → 4px）、站点 chip 与只读 chip 的工号撤出版面折叠进 title（「站点 N：名字（工号，已移出）」）、罗列条 staged「未启动」小字改工号数字徽章（`STRIP_BADGE_CLASS`，staged 态由状态点表达）、罗列条拖动提示独占 chips 下一行（容器改两行结构）；`tests/taskAssign.test.ts` 增 `employeeBadgeOf` 规则锁（295 用例） |
| 六轮（2026-09-05，DA19 链编排收进卡槽） | `taskAssignCore`：新增 `chainAfterReorder`（chip 拖动调序——数组搬移、brief 随站走，from===to/越界/只读 → null）与 `chainAfterAppendMany`（「＋」多选追加——按勾选顺序追加、过滤链内已存在名字、零新增 → null）；`taskAssign.tsx`：站点 chip 兼作拖拽源（`STATION_DRAG_TYPE`/'eteams-station'，chip accept 双类型数组、drop 按 `'index' in item` 分流调序/替换，拖拽中半透明、双 ref 合一）、行尾「＋」改多选按钮（Popover 面板 `StationPicker`：列全部成员、链内成员禁用标「已在链中」、勾选顺序追加）、空框点击/键盘改开面板、多站容器/chip 点击仍开「修改」弹窗；`tasksTab.tsx`：弹窗成员槽编辑段撤除（`SlotDraft`/`editSlots`/Select+Minus 依赖删除，update 不发 chain、create 不带 chain）；`tests/taskAssign.test.ts` 增 reorder/appendMany 锁 8 例（303 用例） |
| 七轮（2026-09-05，DA20 卡片拖拽调执行顺序 + 挂靠修复） | `taskAssignCore`：新增 `executionOrderOf`（兄弟依赖拓扑展示序——Kahn 分层、创建序平局、外部依赖不参与、环防御不丢任务）与 `depPatchesForReorder`（拖卡 → 依赖改写补丁：数组搬移同 chip 口径、线性链重写第 k 位依赖第 k-1 位、外部依赖保留、只发 deps 实际变化且 draft/ready 的卡）；`taskAssign.tsx`：新增 `SUBTASK_DRAG_TYPE`/'eteams-subtask' 与 `SubtaskDragItem`（taskId/parentId/editable）；`tasksTab.tsx`：小任务行改全边框卡片 `SubtaskCard`（拖拽源 + 放置目标（同父兄弟可落）、执行序号、拖拽半透明/悬停 ring、点击开合抽屉）、subs 按 `executionOrderOf` 排序、`submitReorder` 逐发 dependencies 补丁（`reorderError` 行内 FormErrorNote）；`webui.ts`：create 路由 `parentTaskId` 改 `readTaskIdParam`（number/数字串都收——修复 JSON number 被 `str()` 静默丢弃 → 小任务落顶层 + 主任务计数不变的 bug）、update 路由补 `dependencies` 透传（`readDependenciesParam` 整包收紧）；`api.ts`：`updateTeamTask` 增 `dependencies?: number[]`；`tests/taskAssign.test.ts` 增 executionOrderOf 4 例 + depPatchesForReorder 5 例、`tests/webui.test.ts` 增数字 parentTaskId/依赖通道回归 1 例（313 用例） |
| 八轮（2026-09-05，DA21 页面化：列表页 + 详情页，编排全迁详情） | `taskDrawer.tsx`：原 S13 shadcn Dialog 抽屉 `TaskDrawer` **撤除**——详情正文改内联组件 `TaskDetailContent`（track 拉取/合同四数组/时间线原样保留；标题/状态头由详情页渲染，`TaskStations` 导出不变）；`tasksTab.tsx`：TasksTab 拆**列表页 ↔ 详情页**两级——列表页精简化（组卡头部 + 小任务精简行 + 顶层任务行，全部只读可点进详情，无新增/改删/卡槽/站点行/依赖 chips/罗列条）；主任务详情 early-return 分支 = 返回条 + 头部卡 + `· 进度` + 汇总 chip + 新增小任务 + `SubtaskCard` 编排全套（执行序号/卡槽/拖卡调序/修改删除，`suppressStations` 沿用 `boxCoversChain`）+ `detailStrip` 单条；任务/小任务详情分支 = 返回条 + 头部卡 + 挂靠行 + 修改/删除（parent≠null 且可编辑）+ `TaskDetailContent` + 站点行 + 依赖 chips + 卡槽 + `detailStrip`；两个 Dialog（编辑/删除确认）抽成 `dialogs` const 两页共用（编辑弹窗文案改「详情页小任务卡下方的卡槽」）；签名 `expandedTask/setExpandedTask` → `selectedTaskId/setSelectedTaskId`（复用 ui model `drawerTaskId`，语义 = 详情页选中任务 id，null=列表页，选中被删自动回落）；`index.tsx`：prop 接线同步改名 + 注释改详情页语义；`ui.ts`：`setDrawerTask` 注释同步（互斥段「抽屉在任务 tab」→「任务详情页在任务 tab」）；`taskDisplayStatus.ts`：`STATUS_LABELS` 词表注释改「键序规范来源」（页面化后无直接渲染方）。列表页小任务精简行保留执行序号（`executionOrderOf` 展示口径不变） |
| 九轮（2026-09-05，DA22 列表页组卡概览化） | `tasksTab.tsx`：列表页组卡撤掉小任务精简行（八轮 DA21 的只读行）——组卡只剩头部（#id/主题/展示态）+ 进度计数 + 汇总 chip + 文件夹，整卡点击进主任务详情看整个任务列表；列表组卡不再调 `executionOrderOf`（计数/汇总与顺序无关，改普通 filter），详情页分支拓扑排序照旧；文件头与 TasksTab 注释同步。零 store/host/纯函数变更 |
| 十轮（2026-09-05，DA23 小任务卡把手拖拽；含列表页误加订正） | `tasksTab.tsx`：`SubtaskCard` **把手化**——dragRef 从卡身 div 移到左上 GripVertical 把手 span（canDrag = draft/ready，不可编辑态 opacity-40 淡化），卡身只挂 dropRef（canDrop 同父兄弟口径不变），children 包 `min-w-0 flex-1` 与把手并排；任务列表页保持九轮 DA22 状态概览**无拖拽**（初版误给列表主任务卡加把手调序，经用户订正「任务列表去掉拖拽」撤除，展示序恢复普通 filter）；`taskAssign.tsx`：拖拽类型注释更新（'eteams-subtask' 即把手 item；误加的 `GROUP_DRAG_TYPE`/`GroupDragItem` 撤除）；`lucide-icon.d.ts`：增 GripVertical 深层导入声明；`tests/taskAssign.test.ts`：无新增（初版数组限定对照锁随列表拖拽撤除删除，311 用例）。零 store/host/核心纯函数变更 |

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
| 冲突③（二轮订正） | 一轮设计断言「含已移除成员的整链重发会被 host 逐站校验拒 400」**与代码不符**：链校验只查 member 表模板名、不查 removed（removeMember 只标 taskMembers 实例行） | assignment.ts:257-263 + teamOps.ts:693 + store.ts:256-263 | 悬空名链的整链重发 host 放行——未开跑链经框内逐站拖拽替换（DA9/DA13）、已开跑链经修改弹窗均可修复；真实风险在执行侧（轮到该站时成员已移出，指派/唤醒路径才失败）；开放问题 Q2 反转为「host 是否应收紧为校验 taskMembers 非 removed」 |
| 冲突④ | `STATUS_LABELS` 被成员状态 pill 复用，若整体替换会破坏成员态文案 | eteamsView.tsx:181-195、2522 | 共存策略（B.3）：STATUS_LABELS 降级为 13 态精确词表，展示态映射只用于任务位 |
| 冲突⑤ | `STATUS_GROUPS` 收敛会改变顶层任务行的分组呈现（10 组 → 展示态组），属可见的行为变化 | eteamsView.tsx:163-179、4446-4499 | 在 B.3 明示；若验收反对，回退方案=保留 10 组分组、仅行内换展示态 pill（记录为 Q7） |
| 风险① | HTML5 拖拽在宿主 GUI 实装内的实际手感（宿主全局事件、BrowserView 缩放）未经实机验证 | E18 推导 | 四绿门外加 GUI 实装目检项：拖拽悬停高亮、drag image、Esc 取消 |
| 风险② | 1s 轮询整包替换在拖拽进行中触发重渲染 | monitor.ts:24、229-240 | react-dnd 的 monitor 状态由内部 manager 持有，不受快照替换影响；但 hover 高亮读取的 `task.chain` 可能中途更新——drop 时以 drop 事件携带的最新 task 重新计算 nextChainAfterDrop，不缓存 JSX 闭包里的旧 chain |
| 风险③ | 大团队 × 多组卡时成员罗列条（逐卡）与框的视觉密度 | 成员数上限 = `env.config.maxMembers`（默认 8，`cordis.patch.yml:24`；`teamOps.ts:248` 校验，含领队占额） | chip 32px 高（DA16）、卡槽 chip 显名字（工号入 title，五轮 DA18）但不设上限（四轮，DA15 废止）——容器横向单行、超宽横向滚动（五轮 DA18，原 `max-w-[280px]` flex-wrap 换行兜底废止）、罗列条 flex-wrap，密度可控；不做虚拟化 |
| 风险④ | react-dnd v16 ESM-only 进 CJS envelope 的打包面 | tsdown.config.ts:120-153 | Rolldown 以 bundler 输入消化 ESM 依赖（radix/lexical 先例同面）；四绿门 + 冒烟验证 envelope 求值 |
| 风险⑤ | 触屏/键盘无拖拽通道 | A.7 | 加站/移除全可点（「＋」多选面板 + chip ×，六轮 DA19）；**调序仅鼠标拖拽**（卡槽 chip 调序与小任务卡片调执行顺序，七轮 DA20 同限）——触屏/键盘暂无通道，记录为已知限制（Q6 同批观察） |

---

# 29.6 开放问题

| # | 问题 | 建议 |
| --- | --- | --- |
| Q1 | host 是否要补齐「ready 中间站仅追加」的链编辑校验（对齐 docs/06.4）？ | 后续独立小改：`updateTask` 在 `chainCursor≥0` 时拒绝替换 index≤cursor+1 的站点；本期客户端守卫先行 |
| Q2 | 悬空名链的宿主语义（二轮订正：host **实际已放行**——链校验只查 member 表模板名、不查 removed，见 E4/冲突③） | 问题反转为：host 是否应收紧为校验 taskMembers 非 removed（防把已移出成员留在链上、直到执行轮到才失败）？倾向补校验但属 host 独立小改，本轮不动 |
| Q3 | `createTask` 的 stageBrief 非空校验是否放宽到与 update 一致？ | 放宽（空 brief = 交接物待定），低风险 |
| Q4 | 任务页成员罗列条是否补「＋ 添加成员」快捷入口？ | 本轮不加（避免第二套加人通道）；用户验收后定 |
| Q5 | 组卡较多时成员罗列条是否 sticky（滚动跟随）？ | A.5.3 已按用户决策改为每卡一条（源条随卡就近可见），sticky 不再需要；若未来改回区块级单条再评估 |
| Q6 | 站点说明（stageBrief）暂无编辑入口（六轮 DA19 弹窗编排撤除后：替换保留原值、调序随站走、追加为空串） | 用户未再要求编辑 brief 前不加 UI；若需要，候选「＋」面板详情行或 chip 双击行内编辑 |
| Q6 | 展示态图标用字符（⏳/✕）还是 lucide 深层导入？ | 先字符（与 ✔/●/◌ 同语言、零体积）；docs/24 D22f 的 lucide 纪律允许后续替换 |
| Q7 | `STATUS_GROUPS` 收敛为展示态分组是否保留「待决策/已挂起」等细分分节？ | 默认收敛；若用户要操作导向的细分，退回 10 组 + 行内展示态 |
| Q8 | 展示态是否回写 docs/06.8 词表（展示层口径入基线）？ | B 节验收后在本文件或 docs/06 补一节「展示态派生」引用，不改状态机文档正文 |