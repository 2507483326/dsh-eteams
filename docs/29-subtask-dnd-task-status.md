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
| DA24 | 任务主列表**平铺小卡栅格**（2026-09-05 十一轮拍板） | 用户原话「任务主列表 不分 对话任务、待指派这种。把任务主列表做成团队那种小卡片」：①**撤分区**——「对话任务」区块与 STATUS_GROUPS 十态分区（组头/彩点/计数/精简行）全去，顶层任务不再按 kind/状态拆区块；②**平铺栅格**——团队列表同款容器（Card 面板 + 「任务 n 个」标题行 + `CARD_GRID_CLASS` 栅格，最小 210px 自适应列），一卡一**顶层任务**（主任务 + 顶层普通任务，快照序混排）；③**小卡三段式**（团队卡同款）：头行（#id 主题截断 + 展示态 pill，retryCount 并入）+ 身体行（主任务 = 小任务进度「x/y 完成 · n 进行中」（draft 只显个数；ready 叠加汇总 chip）；普通任务 = 指派人，无则不出）+ 文件夹行；阻塞 pill 并入身体行；④卡底色/边框/悬停由 `.eteams-task-card` 样式表接管（与团队卡 `.eteams-team-card` 别名并轨）；⑤整卡点击进详情（主任务 → 主任务详情、普通任务 → 任务详情），无拖拽（十轮 DA23 订正）；九轮 DA22 口径不变（不列小任务明细，整个任务列表在主任务详情页） |
| DA25 | 列表卡**去 #id、文件夹可点击、加大、分行、底栏删除**（2026-09-05 十二轮拍板） | 用户原话「去掉 #1 这种，文件夹左边... 然后做成可以点击的，卡片再大一点，分行，下面放删除按钮」；两个开放点用户续拍：文件夹点击 = **「打开任务文件夹」**（宿主拉系统文件管理器），删除按钮 = **「仅可删除的卡显示」**：①**头行去 `#id` 前缀**——只渲染主题 + 展示态 pill（详情页头部卡的 #id 不动）；②**文件夹行去「文件夹：」标签**——裸路径（`{folder}/`）渲染成可点击件（点线下划线 + hover 提色 + title），点击 = POST `/team/<id>/task/<taskId>/folder/open`（新宿主路由）：目录由 `locateTeam` 的 workspacePath + 任务 work_dir 现算（`taskDirAbs`），缺失 400、未知任务 404，打开器经 `WebSurfaceOptions.openFolder` 注入（默认按平台 spawn：win32 explorer / darwin open / 其余 xdg-open，detached + 异步错误吞掉）；api.ts 新增 `openTaskFolder`；失败按卡行内 `FormErrorNote`（folderBusy/folderError 瞬态，成功无回执 UI——文件管理器窗口即回执）；③**卡片加大**——任务列表专用 `TASK_GRID_CLASS`（最小 260px 自适应列，shared.tsx 新增；不并轨 `CARD_GRID_CLASS` 以免牵动团队/角色列表）；④**信息分行**——进度行/汇总 chip 行/阻塞行各自独立（不再 flex-wrap 混排一行）；⑤**底栏删除按钮**——border-t 分区行 + destructive 描边删除钮（团队卡底栏同款），**仅可删的卡渲染**（`deletableOf`：本身 draft/ready + 主任务全部小任务 draft/ready + 删除集不被未入集任务依赖——与 host `deleteTask` 守卫同口径，host 仍是最终裁决，弹窗就地显示拒绝原因）；删除确认弹窗共用面扩大（列表卡主任务/顶层任务 + 详情页小任务），标题改「删除任务」、主任务追加级联提示、文案去 `#id` 前缀 |
| DA26 | 列表卡**内容对齐、小任务 0、目录标签回补、路径截断收窄**（2026-09-05 十三轮拍板） | 用户原话「任务卡片内容对齐，没有小任务就显示0，而且目录两个字没有了，路径太长了截断大部分的」：①**内容行顶格对齐**——`BlockedPill` 不再内建 `ml-1`（ml-1 移到 className 由调用位补：详情页两处行内文字流场景传 `ml-1`，列表卡独立行顶格与其它行左缘齐）；底栏 `mt-auto` 沉底——同一栅格行内内容行数不同的卡，删除栏齐平在卡底；②**每卡必有进度行**——进度行从「主任务才渲染」改为**无条件渲染**（行结构跨卡统一）：主任务沿用 小任务 N 个（draft）/ N/M 完成 · n 进行中；无小任务的顶层普通任务显 **「小任务 0」**（用户拍板「没有小任务就显示0」；有指派人追加 「 · 指派 X」）；③**「目录」标签回补**——十二轮裸路径后用户发现「目录两个字没有了」，文件夹行恢复两字标签：**「目录 末段/」**（只显示 `folder.split('/').pop()` 末段），全路径进悬停 title（「在文件管理器中打开：<全路径>」）；④**路径截断收窄**——十二轮整条路径 truncate 截掉大部分，本轮只显末段后不再长截断 |
| DA27 | 列表卡**状态入底栏（圆角 2px）、进度三计数着色、工作目录标签钮、详情按钮**（2026-09-05 十四轮拍板） | 用户原话「1. 状态挪到卡片的左边下面，圆角改成 2px  2。目录样式调整一下，就显示工作目录就行，别显示具体路径了，别用灰色打底了不好看／2. 别小任务 个了，改成 共 x 个任务，已完成 x , 未完成 x 数字用颜色标识一下／3. 删除旁边加一个详情按钮」：①**展示态 pill 挪到卡底栏左侧**——「左边下面」按用户十二轮「下面放删除按钮」同词汇解作卡底栏：底栏改左右分栏（justify-between），左 = 状态 pill、右 = 按钮；**圆角改 2px** 指该状态 pill（`Pill` 增 `className` 透传、`DisplayStatusPill` 增 `pillClassName`，底栏位传 `rounded-[2px]` 压过 rounded-full；其余 pill 调用位不动）；头行只剩主题。②**进度行改三分计数**——「共 x 个任务，已完成 x，未完成 x」统一格式（原「小任务 N 个 / N/M 完成 · n 进行中 / 小任务 N」三分支废止，「进行中」计数不再单列），数字着色：已完成 `text-success` 绿、未完成 `text-warning` 琥珀、总数走行底灰；顶层普通任务指派人尾注保留。③**文件夹行改「工作目录」标签钮**——只留四字标签（十三轮的末段路径也撤），完整路径仅存 title 悬浮提示；样式去灰色弱化文案（muted + 点线下划线废止），改常规字色描边小按钮（border 走 `.eteams-ui` 的 --border 缺省、hover 淡底、self-start 不占满行）。④**底栏每卡常驻 + 详情按钮**——删除按钮右侧旁新增「详情」outline 钮（整卡点击进详情的显式等价入口，每卡都有）；删除仍仅可删的卡渲染（deletableOf 口径不变）；底栏从「仅可删的卡渲染」改为每卡渲染（mt-auto 沉底对齐因此覆盖全部卡） |
| DA28 | 底栏状态 pill **描边去 hover 淡底**、工作目录改**幽灵文字钮融入卡片**（2026-09-05 十五轮拍板） | 用户原话「1. 优化一下左下角状态的样式，去掉放上去变淡，加上边框／2. 工作目录还是不协调，修改一下更好融入卡片」：①**底栏状态 pill**——加 `--border` 描边（`BORDER_L1_CLASS` 经 tailwind-merge 压过 shadcn Badge 的 `border-transparent`）并**压平 hover 淡底**（Badge 悬停淡底 = secondary 80% 淡化，D19c color-mix 任意值实现）→ 同色 hover `hover:bg-[color:var(--eteams-pill-bg)]`，悬停后底色不变）；`Pill`/`DisplayStatusPill` 的 className/pillClassName 透传链沿用十四轮。②**文件夹行工作目录钮**——十四轮的描边小按钮（border/底色/内边距）「还是不协调」，撤掉按钮外壳改**幽灵文字钮**：常规字色（text-foreground）+ hover 下划线，与卡内其它文字行同权重、不再像外来件；文案「工作目录」四字与完整路径 title 悬停提示不变 |
| DA29 | 合同**四数组并一 MD**（DB 单字段 + 全链路 MD 渲染）+ 小任务卡**展开钮**（2026-09-05 十六轮拍板） | 用户原话「1. 任务的验收标准、范围内、交付物 改成MD渲染，然后数据库中任务 任务的验收标准、范围内、交付物 合并为一个字段。统一用MD管理／2. 每个小任务加上一个展开功能」：①**DB 合并**——task 表原四列（acceptance/in_scope/out_of_scope/deliverables，JSON 串数组）合并为**一列 `contract_md`**（Markdown 全文；DB_SCHEMA_VERSION 1→2，旧库在 getDb 连接时 `ALTER TABLE ADD COLUMN` + 按 `contractMdFromLegacyArrays` 合成回填，旧四列物理残留不再读写；新库 DDL 直接新形状）；内存 TaskRecord 四数组字段撤除、改 `contractMd?: string`。②**全链路透传 MD**——领队工具 `eteams_create_task`/`eteams_update_task` 的四个 strArr 参数收敛为一个 `contractMd` 字符串参数（MD 整篇写入/整篇替换）；派发邮件与成员工具的 `renderContract` 把 contractMd 原文透传（`任务合同：`标题 + 原文）；contract.md 文档（docs.ts `## 合同` 段）同源透传；任务看板 / webui 快照 TaskView / track 路由 contract 载荷改带 `contractMd`；旧 team.json 导入：`contractMd` 字段直取，无则由四数组合成。③**面板 MD 渲染**——任务/小任务详情页正文（TaskDetailContent）撤 `ContractList` 四组平文列表，改 `MarkdownText` 只读渲染（成员手册同款原语，宿主注入）；主任务详情页小任务卡新增**展开钮**（ChevronDown 图标钮，有 description 或 contractMd 的卡才渲染；点击就地展开**说明 + 合同 MD**（border-t 分区 + MarkdownText），再点收起，展开态 stopPropagation 不误进详情页；expandedSubIds 瞬态多开互不影响）。解读（非用户原话）：用户点名三字段，**范围外（outOfScope）一并合入**同一篇 MD（合同四段一体，单独留下会破「统一用MD管理」）；旧数组→MD 的段落结构（## 验收标准 编号列表 / ## 允许改动 / ## 禁止改动 / ## 交付物）由宿主合成器定稿 |
| DA30 | 小任务展开**改用 shadcn Collapsible**、展开内容**下移到成员卡槽下面**（2026-09-05 十七轮拍板） | 用户原话「小任务加上展开功能使用 https://ui.shadcn.com/ 组件来做，出现的文字会在卡槽下面」：①**交互组件 shadcn 化**——十六轮手写的展开钮 + 条件渲染展开区改用 **shadcn/ui Collapsible**（新 vendoring `components/ui/collapsible.tsx`：Radix `@radix-ui/react-collapsible` 的 Root/Trigger/Content 三件套直出，dialog/popover 同款 vendoring 惯例；devDependencies 增 `@radix-ui/react-collapsible@^1.1.20`，构建照常打包进 client envelope）：小任务卡身包一层 `Collapsible`（受控 `open`，仍由 expandedSubIds 瞬态多开驱动、`onOpenChange` 回写），卡头行展开钮改 `CollapsibleTrigger asChild` 包原 ChevronDown 钮（自绘 toggle 逻辑删除），展开内容改 `CollapsibleContent` 承载；expandable 判据（有说明或合同 MD）、ChevronDown 旋转 180°、stopPropagation 防误进详情页均保持。②**展开内容位置下移**——十六轮展开区在卡头行与成员卡槽之间，本轮 `CollapsibleContent` 挪到**成员卡槽（TaskAssignDropBox）+ 站点行之后**（卡内最底），用户拍板「出现的文字会在卡槽下面」；展开内容本体不变（说明行 + 合同 MD MarkdownDoc 渲染、border-t 分区） |
| DA31 | 小任务展开机制升级 **shadcn Accordion**（2026-09-05 十八轮拍板，随 docs/43 组件目录批次落地） | 用户原话（十七轮续单）：「小任务加上展开功能使用 https://ui.shadcn.com/ 组件来做，出现的文字会在卡槽下面」——十七轮以 Collapsible 落地后，组件目录批次（docs/43）统一用件规则把展开机制再升级为 **shadcn/ui Accordion**：新 vendoring `components/ui/accordion.tsx`（Radix `@radix-ui/react-accordion` 四件套，上游内嵌 ChevronDown 撤除——本仓触发位自带图标钮 asChild 包 Button，开合旋转由上游 `[&[aria-expanded=true]>svg]:rotate-180` 承载；Header 补 m-0 补 preflight 缺位；上游 animate-accordion-down/up 需 tailwind.config 的 keyframes 随件补上）；tasksTab：逐卡 `Collapsible` + 手写开合状态机撤除，改 `<Accordion type="multiple" value=expandedSubIds onValueChange>`（多开状态机交给组件），逐卡包装 div 改 `AccordionItem`（上游默认 border-b 以 border-b-0 压平），触发钮改 `AccordionTrigger asChild` 包 ghost 图标 Button（`h-6 w-6`，title 升级为 Hint 悬浮提示），展开内容改 `AccordionContent`（关态即卸载）；展开位（卡槽下面）、expandable 判据、stopPropagation 均保持；**本轮纯 client 交互件升级，无用户面观感变化** |
| DA32 | 小任务展开钮**挪按钮组最右侧**、**压平 hover 底色**（2026-09-05 十九轮拍板） | 用户原话「小任务 展开按钮放到最右侧，不要这个背景色」：①**位置**——展开钮从按钮组首位（⌄→修改→删除）挪到**最右侧**（修改→删除→⌄；不可编辑卡无修改/删除时展开钮本就独居右端，观感一致）；②**背景色**——触发钮是 ghost 变体图标 Button，悬停底色 `hover:bg-accent`（shadcn ghost 标配）即用户所指背景色，`className` 叠 `hover:bg-transparent` 经 tailwind-merge 压平（悬停只剩字色 muted→foreground 变化，无底色块）；图标随 aria-expanded 旋转、Hint 悬浮提示、stopPropagation 防误进详情页均保持 |
| DA33 | 主任务详情页**头部卡收三件**——成员罗列条上移入卡、进度行改任务卡片同款三计数、卡片下面加「任务列表」节标题（2026-09-05 二十轮拍板） | 用户原话「任务详情页面把团队成员放到上面去和任务标题放一起，下面的小任务也改成 和任务卡片一样 共 x 个任务 已完成 未完成。然后卡片下面加标题  任务列表」：①**成员罗列条上移入卡**——`detailHeader` 增 optional `extra` 槽（渲染在文件夹行之后、卡内末尾），主任务详情页把 TeamMemberStrip（自带 `border-t` 分区）从页面底部挪进头部卡，与任务标题同卡；仍是小任务卡槽的拖拽源（TaskDndProvider 未动）、渲染判据不变（存在 draft/ready 小任务才渲染）；任务/小任务详情页不传 extra，保持原观感（成员罗列条仍在页面底部）。②**进度行改三计数**——原「· 小任务 n/m 完成」行（含 draft 特例）撤除，改任务列表卡（DA27）同款三计数行「共 x 个任务，已完成 x，未完成 x」，放在头部卡内（进度行本就说小任务，收进卡与列表卡结构同构），数字着色 success/warning；汇总 chip（B.2 判据：ready 且有小任务）随行入卡。③**节标题**——头部卡与新增小任务按钮之间插「任务列表」标题（LIST_TITLE_CLASS 字号，列表页「任务」表头同款），小任务编排区从此有节名 |
| DA34 | 「任务列表」标题行**新增小任务钮靠右同排**、小任务卡**撤挂靠缩进 ml-4**（2026-09-05 二十一轮拍板） | 用户原话「任务列表右侧是新增任务，下面的任务列表左边不留空隙」：①**标题行改 flex 同排**——「任务列表」标题与「＋ 新增小任务」钮合并为一行（标题居左，LIST_TITLE_CLASS 自带 flex-1 占满把钮推到最右；钮的独立 mt-1.5 撤除，行整体 mt-1.5），列表页「任务 n 个」表头行同构（用户拍板「任务列表右侧是新增任务」）。②**缩进撤除**——小任务卡 SUBTASK_CARD_CLASS 撤七轮 DA20 的挂靠缩进 `ml-4`（用户拍板「下面的任务列表左边不留空隙」；卡片化后小任务卡已不在组卡内嵌套，缩进无嵌套语义；mt-1.5 卡间距保留）；改删错误行（FormErrorNote）随卡对齐同步撤 ml-4。任务/小任务详情页未动 |
| DA35 | 「＋」多选面板**标题简化「选择成员」**、**链中成员不再出现在列表**（2026-09-05 二十二轮拍板） | 用户原话「选择成员，追加为接力站点   去掉 追加为接力站点，而且已经选中的成员不出现在列表中」：①**标题去掉「追加为接力站点」**——StationPicker 面板头行文案「选择成员，追加为接力站点」简化为「选择成员」（用户拍板「去掉 追加为接力站点」）。②**链中成员不渲染**——「＋」点开的多选列表把已在接力链中的成员**整体滤除**（`members.filter((m) => !chainMembers.includes(m.name))`；用户拍板「已经选中的成员不出现在列表中」），原「禁用 + opacity-50 + 『已在链中』标 + cursor-not-allowed」废弃；全部成员都在链中时列表空、显「暂无可选成员」；`chainAfterAppendMany` 纯函数去重守卫不变（UI 过滤之外的兜底）。确认钮/勾选逻辑/勾选序追加语义不变 |
| DA36 | 确认钮改「添加成员」、**拖拽高亮可见性修复**、任务区头像描边、罗列条改**卡下方左竖线提示块**（2026-09-05 二十三轮拍板） | 用户原话「1. 添加站点改成添加成员 2.列表顶左边导致拖拽时高亮显示被遮挡了 3. 任务中的成员头像加上border 4.拖到本卡小任务下方的成员卡槽完成指派 修改为 拖拽成员到下方的成员卡槽完成指派，且不放到卡片里面，放到卡片下面，左边用小竖线标识为提示」：①**确认钮文案**——StationPicker 确认钮「添加站点 / 添加 N 站」→「添加成员 / 添加 N 个成员」。②**拖拽高亮修复**（两条腿：容器悬停底原与 chip 底同为中性 pill 色、chip 列表顶满时高亮看不出；chip 外缘环在滚动容器 overflow-x-auto 的滚动态会被裁）——BOX_MULTI_OVER 悬停底改品牌淡底（color-mix primary 12%）、CHIP_RING 加 `ring-inset`（环画进 chip 内缘，滚动容器裁不掉）。③**头像描边**——Avatar 增 optional `className` 透传，任务区 5 处（罗列条/领队/多选面板行/卡槽 chip/只读框）加 1px `--border` 细线；其它表面（成员库等）不传零变化。④**罗列条版式**——移出头部卡（二十轮 DA33 曾入卡），置**头部卡下方**独立提示块：根容器去 border-t 改 `border-l-2` 左小竖线 + pl-3 缩进，提示文案与罗列条 chip 悬浮提示统一改「拖拽成员到下方的成员卡槽完成指派」；渲染判据/拖拽源不变 |
| DA37 | 罗列条**回卡内原位**（只留 chips 行、提示拆出）、小任务卡加**「开始」按钮**、展示文案**合并「待开始」**（2026-09-05 二十四轮拍板） | 用户原话「1. 不对，团队成员还是在卡片内，只是拖拽成员到下方的成员卡槽完成指派不在 2. 卡片加上开始按钮 3. 没有什么草稿状态、待指派状态，只有待开始状态。如果有任务没有成员，则提示需要选择成员就行」：①**罗列条订正回卡**——二十三轮 DA36 把整个 TeamMemberStrip 移出头部卡是**过度移动**（用户拍板「团队成员还是在卡片内」）：TeamMemberStrip 恢复 border-t 分区形态放回头部卡 `extra` 槽，但**只留 chips 行**（「团队成员」标签 + 领队 chip + 成员 chips）；提示文案「拖拽成员到下方的成员卡槽完成指派」拆出为独立组件 `StripAssignHint`（border-l-2 左竖线 + pl-3，渲染在**头部卡下方**——用户拍板「只是拖拽成员到下方的成员卡槽完成指派不在（卡内）」），渲染判据与罗列条同（存在 draft/ready 小任务才渲染）。②**「开始」按钮**——ready 小任务卡按钮簇与任务详情页按钮行新增「开始」钮（`t.status === 'ready' && chain.length > 0` 才渲染）：点击 = POST `/team/<id>/task/<taskId>/start`（新宿主路由），宿主取 `task.chain[chainCursor + 1]` 复用 `assignTask` 派发核派发下一站（成员未起会话则 ensureSpawned 起会话）；ready 但**链空**的卡不渲染按钮、改显灰字提示「需要选择成员」（用户拍板「如果有任务没有成员，则提示需要选择成员就行」）；宿主空链 400 兜底同文案，链已到末站 400 「任务 #N 执行链已到末站，无下一站可派发」。③**展示文案合并**——draft/ready 展示文案合并为「待开始」（用户拍板「没有什么草稿状态、待指派状态，只有待开始状态」）：STATUS_LABELS.draft/ready、DISPLAY_STATUS_TABLE（draft muted→info 与 ready 同 tone）、groupDisplayOf 兜底 chip「待指派」→「待开始」；**底层 10 态状态机不动**（draft 仍是组拆解中、ready 仍是就绪待派，仅展示层合并），「需要选择成员」是**指派提示不是状态**（不设状态） |
| DA38 | 主任务**整体「开始」**（逐个派发小任务）、**无领队时主会话窗口就是领队**、提示块竖线**加粗加色**、小任务**卡身点击进详情撤除**、多选面板**点空白收起修复**（2026-09-05 二十五轮拍板） | 用户原话「1. 主任务需要加开始按钮，不然整个怎么启动，主任务启动就代表着小任务需要逐个开始执行了 2. 需要判断团队是否含有领队，如果没有领队，主会话窗口就是领队，如果有领队，则从领队开始正式开始执行任务 3. 拖拽成员到下方的成员卡槽完成指派 左侧的竖线改得显眼一点 4. 小任务不需要再点击进入任务详情了，然后点击小任务里面的选择成员弹出弹窗后点击小任务空白地方弹窗没有消失」：①**主任务整体开始**——主任务详情页「任务列表」标题行加主「开始」钮（`selected.status === 'ready' && subs.length > 0` 才渲染；主任务是容器，开始 = **逐个派发**全部 ready 小任务）：新宿主 `startGroupTask`（assignment.ts）逐卡独立走 `assignTask` 派发核（各自持锁校验起会话投递），无链卡跳过（reason「需要选择成员」）、链到末站跳过、依赖未满/占用/起会话失败等按卡跳过并把原因回传——路由 200 `{ok, started, skipped}`，面板行内就地提示（全跳过列原因清单、部分成功带「已开始 N 个小任务，M 个未开始」计数）；单任务路径响应兼容（started=1、skipped 恒空，行为不变）。②**无领队锚点**——`captainFor` 判据改为：有领队（行在且未移出）→ 领队主会话锚点（**从领队开始**，领队主会话不在册 = undefined 不退化）；无领队（行缺失/已移出）→ **主会话窗口就是领队**——领队行原 main_session_id 的会话仍在册就直接用（setLeaderRemoved 不改锚点，原主会话还开着时零迁移），再退化到客户端活跃会话心跳（POST `/presence` 落盘，60s 内有效）定位用户正在看的对话；锚点会话与领队行不一致时 `ensureSpawned` 先**重锚领队行**（内存快照改、随本次派发写事务落库——成员子代理的父会话校验 installMemberRuntime 按领队行判父，锚点必须一致才装成员工具）；两锚都不在册报错（提示文案改「领队/主会话窗口不在线」）。③**竖线显眼**——StripAssignHint 左竖线 `border-l-2` + 中性 token 线改 `border-l-4` + 品牌色实线（用户拍板「左侧的竖线改得显眼一点」）。④**卡身点击撤除**——小任务卡整卡点击 = 进小任务详情页的口径废止（用户拍板「小任务不需要再点击进入任务详情了」）：SUBTASK_CARD_CLASS 去 cursor-pointer、SubtaskCard 去 onOpen/onClick，卡身只承担把手拖拽放置目标；随之清理三处只为防卡身冒泡的 stopPropagation 包装层（按钮簇/卡槽行/展开内容）。⑤**弹窗收起修复**——用户拍板「点击小任务里面的选择成员弹出弹窗后点击小任务空白地方弹窗没有消失」：根因是 Radix Popover（1.1.23）外出点击关闭是 **click 期 deferred**（`deferPointerDownOutside: true`），且任何 click 的 stopPropagation 会让 document 冒泡相监听器收不到该 click、deferred 关闭被判定「已拦截」而**抑制**——卡内锚面（空链卡槽/「＋」钮）改 **onPointerDown 翻转开合**（点击在按下即翻转，click 只拦冒泡）、有链容器空白处点击**显式收起**弹窗再开「修改」、三处防冒泡包装层撤除后其余区域恢复原生冒泡（Radix 正常关闭） |
| DA39 | 锚面开合**改回 click 期** + 列表页主任务卡「开始」钮（2026-09-05 二十六轮拍板） | 用户原话「1. 现在小任务里面的选择成员弹出弹窗后马上就消失了 2. 主任务需要加开始按钮，没看到加在那里」：①**弹窗一开即收回归修复**——DA38 把锚面（空链卡槽/「＋」钮）开合改到 onPointerDown 是改过头：pointerdown 开合让刚挂载的 Radix 外出监听撞上同一交互的尾巴——焦点默认动作落在 portal 内容之外的锚面上，Radix focusin 外出关闭路径（NonModal 的防 focusin 关闭仅在有 pointerdown-outside 前置时生效，开锚面时该前置不存在）立即触发 onDismiss；改回 **click 期翻转**（onClick 内 stopPropagation + `pickerOpen ? 关 : 开`）——click 开合在整个交互结束后才挂外出监听，同交互不再自伤；点锚面收起由本处显式翻转承担（不依赖 deferred 关闭），空白处收起仍由 DA38 的包装层撤除 + 原生冒泡 + Radix deferred click 关闭承载（互不依赖，双保险都在）；②**列表页主任务卡「开始」钮**——DA38 只加在详情页标题行，用户在任务列表页没看到：列表卡底栏钮区首位加「开始」实底主钮（判据与详情页同：`kind==='group' && status==='ready' && subs.length>0`），点击 `submitStart` 走同一路由逐个派发 ready 小任务、跳过原因行内就地提示（startError 槽按卡定位渲染）；底栏容器既有 stopPropagation 保证不触发整卡进详情；详情页标题行的整体开始钮保留 |
| DA40 | 整体开始改**链式接力**（一棒交一棒）、领队锚点统一**主会话梯度**（不设「领队会话离线」报错态）、开始钮判据放宽**非终态组**（2026-09-05 二十七轮拍板） | 用户原话「还是没看到开始按钮， 1. 整体开始，所有小任务链式执行          2.不存在领队会话离线啊  3.不需要小任务详情啊，任务详情页面不就能看到所有小任务的状态信息了吗？」：①**链式接力**——DA38 的整体开始是「一次性派发全部 ready 小任务」（依赖未满的被拒跳过），与用户两轮口径「逐个开始执行（DA38）/链式执行（DA40）」不符；改按组内执行序（新宿主 `subExecutionOrder`：兄弟依赖拓扑序、同层建序稳定、组外依赖不算排序约束）**一次只发第一棒**，余下 ready 卡以「等待链式接力（前一小任务完成后自动开始）」记入 skipped（行内提示说明排队）；小任务终站收口（`completeTask` 尾）自动续派下一棒（组已收口免调用、失败仅记日志）；终态组（completed/cancelled）整体开始直接 400；建卡路由补收 `dependencies`（与 update 同口径——面板建卡此前不收依赖，依赖只能靠拖拽调序补写）。②**领队锚点统一**——用户拍板「不存在领队会话离线啊」：`captainFor` 撤掉「有领队就硬绑领队会话（不在册 = 报错不退化）」分支，统一梯度 = 领队行登记主会话在册先用 → 心跳（POST /presence，60s）定位 → 都不在册才报错；报错文案改「主会话窗口不在线」（不再有「领队会话离线」这个独立报错态）。③**开始钮判据放宽**——用户「还是没看到开始按钮」（连续三轮）：列表卡与详情页标题行判据由 `status === 'ready'` 放宽为**非终态组**（completed/cancelled 外）即渲染（ready 等值判据在组状态被旁路转移时会把钮藏掉，终态才收；正常执行期组恒 ready，纯兜底）。④**小任务详情**——用户拍板「不需要小任务详情啊，任务详情页面不就能看到所有小任务的状态信息了吗？」：确认 DA38 后小任务详情入口已全无（列表卡进详情仅顶层任务、小任务卡身无点击），主任务详情页即小任务状态总览；顶层普通任务的「详情」钮保留（本条无代码变更，仅口径确认） |
| DA41 | 列表组卡去「详情」钮（开始最右）+ 详情页头部卡收「开始」钮 + 展开箭头剥描边 + 对齐规整 + 小任务卡「修改」改**就地编辑**（说明/合同并读单 MD 字段）+ 普通任务头部卡「编辑」钮（2026-09-05 二十八轮拍板） | 用户原话「1. 主任务页面去掉详情按钮，把开始按钮放在右侧 2. 主任务详情页面上方卡片需要加开始按钮 3. 主任务详情页面下面的任务列表右侧的箭头背景色去掉 4. 主任务详情页面下面的任务列表上方的文字状态这些都没有对齐 5. 主任务详情页面下面的任务列表修改按钮的逻辑不是弹窗，而是就地编辑 包括任务标题和md详情，点击修改展开卡片，然后下方放MD编辑器来编辑」：①**组卡去详情钮**——组卡撤「详情」钮（整卡点击即进详情，详情钮对组卡冗余），钮序 **[删除][开始]**（开始最右）；顶层普通任务卡保持 [详情][删除] 逐位不变。②**头部卡收开始钮**——主任务详情页「开始」钮从「任务列表」标题行上移到**头部卡右端**（拍板「挪到 任务列表上方的卡片中间，上面不是任务的介绍吗？」），判据不变（非终态组且有子任务）；行内错误提示槽跟迁到头部卡下；「任务列表」行只剩「＋ 新增小任务」（弹窗不动）。③**箭头剥描边**——用户报「箭头背景色」，真凶 = Button 基类 `focus-visible:ring-1` 品牌色焦点环（点击箭头后残留）+ AccordionTrigger 渗漏类（py-4/flex-1/justify-between/hover:underline）；消费位 className 尾部覆盖剥净（flex-none py-0 justify-center hover:no-underline focus-visible:ring-0 focus-visible:ring-transparent），vendored accordion.tsx/button.tsx 零改动。④**对齐规整**——头部卡标题行改 flex（flex-wrap items-center justify-between + 信息组 gap-x-1.5，撤内联 ml-1）、文件夹行/进度行/汇总 chip 统一 mt-1.5、「任务列表」行 mt-2.5、小任务行 items-center（pill/文字与按钮簇垂直居中）。⑤**就地编辑**——拍板「说明和合同MD不是一个字段吗？不是的话改成一个字段。就是当前点击展开后展示出来的文本啊，上面的标题用input框修改不就好了么」：点「修改」该卡就地展开编辑器（标题 Input + mergedBodyOf 并读的单 MD Textarea——说明在前、空行分隔、contractMd 保真），保存整篇回写 `contractMd`、`description` 落严格空串（内容收敛进 contractMd，老数据首存并文不丢）；编辑态隐去开始/修改/删除/箭头钮簇与成员卡槽、锁拖拽、同刻仅一卡编辑（单槽 inlineEdit {taskId, scope}）；update 路由补透传 contractMd（raw 不 trim，正文首尾空白属内容）；拍板「只改小任务卡，普通任务上面的卡片也加上编辑按钮」——普通任务详情页头部卡加「编辑」钮（subMutable 判据同原修改钮）、按钮行撤「修改」、卡槽弹窗路径保留且编辑中哑化 onOpenEdit 防截胡；「新增小任务」保持弹窗 |
| DA42 | 小任务「修改」改**先展开、原布局不变**（编辑器入展开区）+ 行头状态 pill **前移并统一主任务底栏款样式**（2026-09-05 二十九轮拍板） | 用户原话「小任务的修改应该是如果没有展开先展开，在原有的布局上面修改，而不是突然改变布局。另外小任务的标题状态还是没有对齐，是不是行高问题，把状态放到最前面，然后统一使用主任务页面的状态样式」：①**就地编辑重布局**——DA41 的「编辑态隐钮簇/卡槽/箭头 + 行头下插编辑器」属突变布局，订正：点「修改」未展开**先展开**、已展开保持；行头钮簇/成员卡槽/箭头全程常显（原布局不动）；编辑器从行头下**迁入 AccordionContent 展开区**（编辑态 = 展开区只读正文换编辑器，二选一）；AccordionContent 节点级门 `(expandable \|\| editing)`（无内容卡仅在编辑中挂载——防「取消」后残留空分隔线且无箭头可收）；箭头判据 `expandable \|\| editing`（编辑中的卡也给箭头可收起），编辑中收起 = 仅隐藏、草稿保留，再点「修改」幂等重开（不重拉草稿），「取消」才退编辑；卡槽 onOpenEdit 编辑中哑化防老弹窗截胡；删除/开始成功即清编辑槽（防陈旧草稿复活——重试回退后再点「修改」沿用旧草稿整篇覆盖的隐患）；保存成功留展开态显示新只读内容。②**行头状态**——状态 pill 挪行头**最前**（BlockedPill 随簇连排其后），补 retryCount（重试计数小字）与 pillClassName 统一主任务底栏款（rounded-[2px] + --border 描边 + hover 淡底压平——新增 shared `STATUS_PILL_CLASS` 常量，底栏同引消除双处漂移）；行头左组从普通 div 内联排版改 `flex min-w-0 flex-wrap items-center + gap-x-1.5`（与 detailHeader 信息组同构——修内联基线/行高错位，ml-1/mr-0.5 全撤 gap 承担），顺序 = 状态 pill → 阻塞 pill → 序号 → #id → 主题 → 指派；箭头钮撤 DA30 时代 mt-0.5 基线手调 |
| DA43 | 就地编辑正文换**角色手册同款 MdEditor** + 标题**原位编辑**（2026-09-05 三十轮拍板） | 用户原话「怎么没有用角色里面得md编辑器？  标题修改也没在原来的地方」：①**正文编辑器**——DA41/42 就地编辑的 font-mono Textarea 换成角色人设同款 `MdEditor`（src/client/features/mdEditor/mdEditor.tsx，@mdxeditor/editor 所见即所得：标题/列表/表格/代码块/链接工具栏 + 粘贴转 MD + 亮暗主题桥），minHeight 220（对齐成员详情卡档）、占位「说明 / 合同（Markdown）」、头部说明「说明 + 合同 · 所见即所得」；MdEditor 组件加三个可选 props（placeholder/headerNote/readOnly，默认值维持人设文案——既有四个调用位零回归），保存飞行中 readOnly 锁编辑（MDXEditor 原生 readOnly 运行时可切）；弹层为 Radix popper fixed 定位，AccordionContent 的 overflow-hidden 不裁剪（fixed 元素包含块语义，勿顺手修裁剪）。②**标题原位编辑**——标题不再塞编辑器块：小任务行头主题 span 编辑态**原位换 Input**（h-7 min-w-0 flex-1、autofocus、行头布局不动——状态 pill/阻塞/序号/#id 照旧）；任务详情页头部卡经 detailHeader 新增 `subjectEditor` 槽在标题行**原位换 Input**（与 editor 槽同判据 headerEditing）；组详情页不传零变化；弹窗路径与 DA42 幂等/收起暂存/清槽语义不动 |

| DA44 | tasksTab **组件抽离五文件** + 组页小任务行头去 #id + 原位 Input 统一加宽 + 间距规整 + 拖拽高亮 ring-inset + 组页头部卡「编辑」钮 + 状态组件统一抽离（2026-09-05 三十一轮拍板） | 用户原话「1. 去掉左侧的#多少 2.这个input框太丑了，有用组件吗？而且宽度要增加 2. 这个间距好像都不规范啊，请仔细检查 3. 这个页面长度太长了，请抽离可复用的组件出去 4. 拖拽小任务还是左边的边框会看不见，看看是否有overflow导致的 5. 页面上面的任务卡片没有加编辑按钮，状态也不是主任务页面的状态样式，这个状态统一抽离出组件使用」：①**行头去 #id**——组详情页小任务行头撤 `#{t.taskId}`（序号保留；任务详情页头部卡的 #id 保留——DA25 口径）；②**原位 Input 统一加宽**——新 shared `INLINE_SUBJECT_INPUT_CLASS`（h-8 对齐 32px 档、min-w-[160px] 防窄行塌缩、px-2.5），小任务行头/任务详情页头部 subjectEditor/组页 subjectEditor 三处同引；③**间距规整**——挂靠行 mt-1→mt-2、组侧 assignError 撤 ml-4、列表底栏 pt-2.5→pt-2、依赖 chips mt-[3px]→mt-1、taskDrawer 站点行 mt-[3px]→mt-1（卡槽/inlineEditor/任务列表行等「记录不改」处不动）；④**组件抽离**——tasksTab 1429 行**纯移动**拆五文件（taskPills/taskHeaderCard/taskSubtaskItem/taskListCard/taskDialogs），收敛 805 行、无循环依赖、零行为变化；⑤**拖拽高亮**——SubtaskCard isOver 外缘环改 `ring-inset`（根因 = 面板滚动列 CONTENT_CLASS `overflow-x-hidden` 裁掉贴左缘卡的外缘环，环画进卡内缘免疫裁剪，DA36 chip 同款先例；isDragging opacity-50 不动）；⑥**组页头部卡「编辑」钮 + 状态统一**——组详情页头部卡加「编辑」钮（判据 = mutable：draft/ready——host updateTask 状态闸仅这两态放行全部字段）、开始钮仍最右，subjectEditor/editor 槽与任务详情页同构；状态 pill 三处统一走新 `TaskStatusPill`（taskPills.tsx：DisplayStatusPill 私有 + STATUS_PILL_CLASS 封装，BlockedPill/GroupSummaryChip 同迁） |

| DA45 | 头像边框**全局统一**（Avatar 容器默认 1px --border 描边）（2026-09-05 三十二轮拍板） | 用户原话「头像加上边框」：任务区 5 处头像二十三轮 DA36 已显式加描边，用户仍见无边框头像 → 指其它表面（团队卡/成员库/添加成员弹窗/teamsButton/汇报卡等）；描边做进 Avatar 容器默认类（AVATAR_CONTAINER_CLASS 追加 border border-solid border-[color:var(--border)]——本仓惯例补 border-solid），双渲染分支（seeded SVG 主干 + 首字母 fallback）同吃，全仓头像面（AvatarRing/AvatarStack 包装内部同走 Avatar，无手绘旁路）统一生效；className 仍可覆盖默认；任务区 5 处冗余显式传参撤除（twMerge 合并语义下改前改后 set 相等，视觉零变化）。观察：AvatarRing 四处双线环面（构建台/角色添加/角色详情/成员详情）随之多一道内层 1px 细线——全表面统一的预期后果，嫌重可传 className 覆盖 |

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
| `chainCursor === -1` 且 draft/ready（任意链长） | 拖到**框空白处** = 末尾**追加** `{member, stageBrief:''}`（不设上限——DA15 曾限 2 站，四轮废止）；拖到**框内某站点 chip** = 替换该站成员、stageBrief 原值保留（同站同名即 DA8 no-op，不发请求）；**站点 chip 拖到另一站点 chip** = 调序（六轮 DA19：被拖站搬移到目标位、stageBrief 随站走，自拖自放 no-op）；**「＋」点击** = 成员多选面板（六轮 DA19：勾选若干人按勾选顺序末尾追加；二十二轮 DA35 起链中成员不进列表） |
| `chainCursor ≥ 0`（已开跑：站点已完成/当前站） | 不注册 drop target（只读） |
| 非 `draft/ready`（assigned/in_progress/…/终态） | 不注册 drop target（只读，DA12：合同冻结，E4 状态闸会拒绝，客户端直接不给入口） |

> **变更注记（2026-09-04 二轮）**：原口径「drop 一律替换下一待执行站（单站替换 `chain[0]`、多站替换站点 0）」由 DA13 按序接力取代——框升级为多人槽位后：空白处 drop=追加、chip 上 drop=定点替换、chip `×`=逐站移除；同名去重从「目标站」扩为全链（DA8）。多站点任务的追加不再要求走「修改」弹窗，框上即可追加；嵌套 drop target（chip ⊂ 框）用 `monitor.didDrop()` 防双触发、容器以 `isOver({shallow:true})` 区分空白处与 chip 悬停；**chip 与容器的 `canDrop` 必须同条件**（同一 eligible 判定）——dnd-core 按 canDrop 过滤目标集后内层先 drop，chip 若更严会被滤掉、落点误成容器「追加」，语义分流只由 `didDrop` 承担。

> **变更注记（2026-09-05 四轮，DA15 废止/DA16 调整/DA17）**：接力链**不设上限**——三轮的容器 `canDrop` 非对称收紧随 DA15 废止撤销，chip 与容器恢复同条件（`eligible`）；卡槽从行尾移到任务行下方独立一行（drop/didDrop/shallow 机制不受位置影响）；卡槽 chip 内容 = Avatar 26px + 名字 + 工号（employeeId），`×` 恢复 chip 内按钮。头像 26px / chip 32px / 去重 / 逐站移除 / 嵌套 drop target 机制均沿二轮口径不变。

> **变更注记（2026-09-05 六轮，DA19 链编排收进卡槽）**：站点 chip 兼作**拖拽源**——拖到另一 chip = 调序（`chainAfterReorder` 数组搬移）；「＋」由装饰提示改**多选按钮**（Popover 面板 `chainAfterAppendMany`）；「修改」弹窗的成员槽编辑段**撤除**（update 不发 `chain`——链编排唯一入口是卡槽）。双 item 类型：`eteams-member`（罗列条成员，drop=追加/替换）与 `eteams-station`（站点 chip，drop 到 chip=调序）；站点 chip 的 accept 为**双类型数组**（dnd-core `matchesType` 对数组走 `.some` 匹配），容器仍只收 `eteams-member`——调序只能 chip→chip，空白处对站点类型无落点（not-allowed 即语义）。

> 纯函数签名：`nextChainAfterDrop(task, member, stationIndex?)`——`stationIndex` **缺省（空白处 drop）= 末尾追加** `{member, stageBrief:''}`（不设上限）；显式传站点下标（chip drop）= 定点替换该站成员、stageBrief 保留。返回 null = no-op（不可编辑 / 全链同名去重 / 越界下标）。六轮新增：`chainAfterReorder(task, fromIndex, toIndex)`（from===to / 越界 / 只读 → null）、`chainAfterAppendMany(task, members)`（按勾选顺序追加，过滤链内已存在名字，一个都不新增 → null）。七轮新增：`executionOrderOf(tasks)`（兄弟依赖拓扑展示序）与 `depPatchesForReorder(tasks, from, to)`（拖卡 → 依赖改写补丁，A.3.4）。

- **移除**：框内每个站点 chip 带 `×`（可编辑窗口内任意站，`canRemoveStation`）→ 移除该站后整链重发；仅剩一站时移除即 chain = `[]`（回到无链任务，领队自由指派，E6/docs/06 §6.7:127）。~~整链重排/批量调整仍走「修改」弹窗~~——六轮 DA19 起整链重排改卡槽内 chip 拖动调序，弹窗不再编排链。
- **追加**：框空白处拖入即追加（多站链同样直接追加）——原「不在框上追加、拖一次多一站的意外增长」顾虑由双 target 语义分明化解（chip=替换、空白=追加），且追加空 brief 合法（E4 asymmetry，见 29.5 冲突①）；六轮 DA19 起另有「＋」多选面板批量追加（二十二轮 DA35 起链中成员整体不进列表，不再禁用标注）。
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

### A.5.1 成员卡槽（TaskAssignDropBox；2026-09-04 二轮按 DA13/DA14、2026-09-05 三/四/五/六轮按 DA15（废止）/DA16/DA17/DA18/DA19 修订、二十二轮按 DA35 修订）

**位置（四轮 DA17）**：卡槽从行尾移到**任务行下方独立一行**（不占行尾按钮区；点击不冒泡到任务行）。

| 态 | 规格 |
| --- | --- |
| 空框 | 虚线边框槽：`h-[32px] min-w-[96px] rounded-[4px] border border-dashed px-2 text-xs text-muted-foreground`（圆角 4px，五轮 DA18），文案「＋ 拖入成员」（BORDER_L1 类边框 token，E16）；**点击 / 键盘 Enter/Space = 打开「＋」成员多选面板**（六轮 DA19——弹窗不再编排链） |
| 已放置（任意站数，不设上限） | 容器虚线圆角框**横向单行**（`rounded-[4px] border-dashed px-1.5 py-1 max-w-full flex-nowrap overflow-x-auto`——五轮 DA18：去 280px 宽上限与 flex-wrap 换行，超宽横向滚动）内按序排布站点 chips——顺序=接力顺序；每个 chip：中性 pill `h-[32px] rounded-[4px]`、`Avatar` **26px** + 名字 12px（**工号折叠进 title 悬浮提示**，五轮 DA18——「站点 N：名字（工号，已移出）」；legacy 无工号不带括注）+ 悬空名「已移出」标记 + `×` 移除钮；chip **可拖动调序**（六轮 DA19：拖到另一 chip=搬移到该位、拖拽中半透明）；行尾「＋」**多选按钮**（六轮 DA19：Popover 面板勾选成员追加，替换原装饰性提示 span） |
| 拖拽悬停（容器空白处） | `canDrop && isOver({shallow:true})`：虚线转实线 + `border-primary` + 品牌淡底 `bg-[color:color-mix(in_srgb,var(--primary)_12%,transparent)]`（二十三轮 DA36：原中性 pill 底与 chip 底同色、chip 列表顶满时高亮看不出，用户拍板「拖拽时高亮显示被遮挡了」），文案/提示指向「追加」（仅成员类型——容器不收站点类型，六轮 DA19） |
| 拖拽悬停（chip 上） | 该 chip `ring-1 ring-inset ring-primary` brand 环（box-shadow 不引发回流；二十三轮 DA36 加 ring-inset——环画进 chip 内缘，滚动容器 overflow-x-auto 滚动态裁不掉外缘环，同上用户拍板）+ 上浮阴影（=替换该站；站点 chip 拖到其上=调序，六轮 DA19）；容器不追加高亮（shallow 区分） |
| 拖拽可放置（非悬停） | 虚线边框转 `border-[color:color-mix(in_srgb,var(--primary)_60%,transparent)]`（提示可落点；token 纪律禁 /alpha，与 BOX_CAN_DROP_CLASS 一轮口径一致） |
| 不可放置/只读 | 不注册 drop target；chip 静态渲染（中性 pill `h-[32px] rounded-[4px]` + Avatar 26px + 名字 + 悬空标；工号入 title，五轮 DA18）；已移除成员名字弱化 + 「已移出」标记 |
| 提交中 | `assignBusy` 时整框禁用 + 透明度 50%（含「＋」面板确认钮） |
| 「＋」多选面板 | `PopoverContent w-64 p-2`：标题行「选择成员」（二十二轮 DA35：原「选择成员，追加为接力站点」去掉后半句）；下方滚动列表（max-h-56）逐行头像（1px --border 描边，二十三轮 DA36）+ 名字 + 角色 + 勾选 ✓——**已在链中的成员不再出现在列表**（DA35 滤除，不渲染；六轮原「禁用 +『已在链中』标」废弃），全部在链中时显「暂无可选成员」；底部「添加成员 / 添加 N 个成员」确认钮（二十三轮 DA36 改文案，原「添加站点 / 添加 N 站」；busy 或零勾选禁用）；勾选若干人按勾选顺序末尾追加站点 |

可编辑窗口内框承整链（DA5），一律**抑制** `TaskStations` 的重复渲染（`boxCoversChain` 纯函数；站点行与框 chips 内容重合，E13）；开跑后（`chainCursor ≥ 0`）恢复 `TaskStations` + 框只读承单站。多站容器空白处 / chip 点击 = 打开「修改」弹窗（主题/说明等，键盘 Enter/Space 同路径；六轮 DA19 起弹窗不再编排链），空框点击 = 「＋」多选面板（A.7）。

### A.5.2 界面草图（2026-09-05 八轮 DA21 页面化 + 九轮 DA22 列表概览化 + 十轮 DA23 小任务卡把手 + 十一轮 DA24 平铺小卡 + 十二轮 DA25 卡片加大/分行/文件夹可点击/底栏删除 + 十三轮 DA26 对齐/小任务 0/目录标签 + 十四轮 DA27 状态入底栏/进度三计数/工作目录钮/详情钮 + 十五轮 DA28 状态 pill 描边/工作目录幽灵钮 + 十六轮 DA29 小任务卡展开钮 + 十七轮 DA30 展开改 shadcn Collapsible/展开内容下移卡槽下面 + 十八轮 DA31 展开升级 shadcn Accordion + 十九轮 DA32 展开钮最右侧/hover 底色压平 + 二十轮 DA33 头部卡收三件/「任务列表」节标题 + 二十一轮 DA34 标题行新增钮靠右/小任务卡撤缩进 + 二十三轮 DA36 罗列条卡下方左竖线提示块/任务区头像描边 + 二十四轮 DA37 罗列条回卡只留 chips 行/提示拆出/小任务卡「开始」钮/待开始文案合并 + 二十五轮 DA38 主任务整体「开始」钮/提示竖线加粗加色/小任务卡身点击撤除 + 二十六轮 DA39 锚面开合改回 click 期/列表页主任务卡「开始」钮 + 二十七轮 DA40 链式接力/开始钮判据放宽：列表页 ↔ 详情页；四轮卡槽下置 + 七轮卡片化口径并入详情页草图 + 二十八轮 DA41 组卡去详情钮（开始最右）/头部卡开始钮/箭头剥描边/对齐规整/小任务卡就地编辑 + 二十九轮 DA42 就地编辑先展开原布局不变/行头状态前移统一样式 + 三十轮 DA43 正文换角色同款 MdEditor/标题原位编辑 + 三十一轮 DA44 组件抽离五文件/行头去 #id/原位 Input 统一加宽/间距规整/拖拽环 inset/组页头部卡编辑钮/状态组件统一 + 三十二轮 DA45 头像边框全局统一）

**列表页（十一轮 DA24 平铺小卡栅格 + 十二轮 DA25 修订 + 十三轮 DA26 修订 + 十四轮 DA27 修订 + 十五轮 DA28 修订：底栏左状态 pill（圆角 2px + --border 描边 + hover 不变色）、进度行共/已完成/未完成三计数着色、工作目录幽灵文字钮（hover 下划线）、底栏加详情钮；与团队列表同款容器、不分「对话任务」/状态分区、无拖拽；二十六轮 DA39 修订：主任务卡底栏加「开始」钮——用户拍板「主任务需要加开始按钮，没看到加在那里」（DA38 只加在详情页标题行，列表页看不到），与详情页标题行同判据；二十七轮 DA40 判据放宽为非终态组（completed/cancelled 外）即渲染）**：

```
┌ Card 面板（PANEL_CARD_CLASS，同团队列表）────────────────────────────────┐
│ 任务 · 3 个                                                              │
│ ┌ 登录页改版 ─────────────────┐ ┌ 部署脚本 ────────────┐                 │
│ │ 共 3 个任务，已完成 2，      │ │ 共 0 个任务，已完成 0，│  ←十四轮：     │
│ │   未完成 1（数字绿/琥珀着色） │ │   未完成 0 · 指派 王五 │   进度三计数  │
│ │ [汇总 chip（ready 时）]      │ │ 阻塞中 · 前置 #7      │   着色；头行  │
│ │ 工作目录 ←幽灵文字钮（hover    │ │ 工作目录（完整路径     │   只有主题；  │
│ │   下划线），路径在悬停提示    │ │  在悬停提示）          │   状态 pill  │
│ │ ─────────────────────────    │ └───────────────────────┘ 挪入底栏左  │
│ │ ◔ 待开始  [删除][开始]      │ ←底栏每卡常驻：左状态 pill（2px 圆角  │
│ └──────────────────────────────┘   + 描边，hover 不变色）右详情钮（每卡）│
│                                     + 删除钮（仅可删的卡）；「开始」     │
│                                     = 二十六轮 DA39 主任务卡实底主钮     │
└──────────────────────────────────────────────────────────────────────────┘
（min 260px 自适应列——十二轮加大一档；头行无 #id 前缀；进度/chip/阻塞逐行
分行、顶格左缘对齐——十三轮；底栏 mt-auto 沉底同栅格行齐平；整卡点击进详情，
工作目录钮/开始/详情/删除钮不冒泡（底栏容器统一 stopPropagation）；开始钮
判据 = 非终态组（completed/cancelled 外）且有小任务，点击**链式接力发棒**
（一次只派第一棒、余卡排队「等待链式接力」等交棒，跳过/排队原因行内就
地提示——二十七轮 DA40）。二十八轮 DA41：组卡撤「详情」钮（整卡点击即进详情；顶层普通任务卡保持 [详情][删除]），组卡钮序 [删除][开始]（开始最右）；不列小任务明细）
```

**主任务详情页（= 整个任务的编排面；返回条 + 头部卡（二十轮 DA33 收三件 + 二十四轮 DA37 罗列条回卡只留 chips 行）+ 指派提示块（二十四轮 DA37 拆出卡下、二十五轮 DA38 竖线加粗加色）+ 编排全套 + 整体「开始」（二十五轮 DA38；二十八轮 DA41 上移头部卡右端、「任务列表」行只剩新增小任务、小任务卡「修改」改就地编辑——说明/合同并读单 MD 字段））**：

```
│ ← 返回列表                                                              │
│ ┌ #t7-101 登录页改版 ◔ 待开始 · · 王五 ┐                                 │
│ │ 文件夹：登录改版/                    │←头部卡                           │
│ │ 共 3 个任务，已完成 2，未完成 1      │←二十轮①：三计数行入卡           │
│ │   （数字绿/琥珀着色，DA27 同款）     │  （原「· 小任务 2/3 完成」行     │
│ │ [汇总 chip（ready 时）]             │   撤除；汇总 chip 随行入卡）     │
│ │ ── 团队成员（border-t 分区）────────│←二十四轮：罗列条回卡内原位        │
│ │ ┌────────┐ ┌────────┐ ┌╌╌╌╌╌╌╌╌┐   │   （二十轮③形态恢复；二十三轮    │
│ │ │(◉张三) │ │(◉李四) │ │(◆项目牧羊│   │   移出整条废止；只留 chips 行，  │
│ │ │ 研究员 │ │ 工程师 │ │ 领队  ╌╌│   │   提示行拆出卡外；头像 1px 描边  │
│ │ └────────┘ └────────┘ └╌╌╌╌╌╌╌╌┘   │   二十三轮保留）                │
│ └──────────────────────────────────────┘                                 │
│ ▌拖拽成员到下方的成员卡槽完成指派       ←二十四轮：提示拆出独立左竖线块    │
│                                        （二十五轮：border-l-4 + 品牌色实线 │
│                                         改显眼，原 2px 中性线；pl-3 不变） │
│ 任务列表                        [开始] [＋ 新增小任务]                     │
│ ↑二十轮③节标题；二十一轮①钮靠右同排（标题 flex-1 占满）；二十五轮 DA38：  │
│   标题行加主任务整体「开始」钮（主钮，ready 且有小任务才渲染——点击逐个   │
│   派发 ready 小任务，跳过卡原因行内就地提示；新增钮同排靠右）             │
│                                                                          │
│ ┌ ⠿ 1. #t2 登录页设计 ◌ 待开始 ─ [开始] [修改] [删除] [⌄] ┐←小任务卡片    │
│ │ ↑ 十轮 DA23：把手 = 唯一拖拽源          ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐  （七轮     │
│ │   ⌄ = 展开钮（十九轮 = shadcn Accordion │ (◉张三)×  (◍李四)× [＋多选] ╎ DA20：   │
│ │   触发钮，组内最右侧，无 hover 底色；   └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘  拖 A 到   │
│ │ [开始] = 二十四轮：ready 且有链渲染，   │                             B=调执行顺序）│
│ │   点击派发执行链下一站；ready 链空改   │                             │
│ │   显灰字「需要选择成员」；draft/已入   │                             │
│ │   执行不渲染                           │                             │
│ │ ── 成员卡槽（TaskAssignDropBox）──                               │
│ │ ── 站点行（TaskStations，不与槽位重合时）──                      │
│ │ 展开内容渲染在卡槽下面（十七轮拍板「出现的文字会在卡槽下面」）：  │
│ │   说明：… ＋ 合同 MD（MarkdownDoc 渲染）                         │
│ └──────────────────────────────────────────────────────────────────┘
│ （二十五轮 DA38：卡身点击 → 小任务详情页口径**废止**——卡身只承担把手    │
│  拖拽放置目标，去 cursor-pointer；防冒泡包装层（按钮簇/卡槽行/展开区）    │
│  随之清理，多选面板外出点击关闭恢复原生；把手不可编辑态淡化）            │
```

**任务/小任务详情页**（返回条 + 头部卡（小任务含开始/修改/删除按钮行）+ 挂靠行 + 正文）：

```
│ ← 返回列表                                                              │
│ ┌ #t3 接口联调 ● 进行中 · · 李四 ┐                                       │
│ 挂靠：#t7-101 登录页改版                                                 │
│ ┌ 任务合同（contractMd 一篇 Markdown，MarkdownText 渲染；无则不渲染）┐   │
│ │ 状态说明 / 幂等说明 / 产出 / 尝试时间线（track 拉取）        │←正文     │
│ │ ✔张三 → ●李四      站点 1/2                                 │          │
│ └────────────────────────────────────────────────────────────┘          │
│ [开始]（ready 且有链；ready 链空改显「需要选择成员」）[修改] [删除]       │
│   ←二十四轮：ready 小任务按钮行新增开始钮，与修改/删除同排               │
│ [依赖 t2]（draft/ready 时另有卡槽 + 罗列条 + 指派提示块）                 │
```

（原四轮版单页草图——组卡内嵌卡槽/罗列条/新增按钮——随页面化废止：卡槽/罗列条/
新增/改删全部只出现在详情页。）

### A.5.3 成员罗列条（八轮 DA21 调整：详情页单条；二十轮 DA33：主任务详情页罗列条上移入头部卡；原逐卡 placement 用户 2026-09-04 已确认、2026-09-05 八轮页面化后废止）

**八轮 DA21（2026-09-05）调整**：任务页拆列表页 + 详情页后，罗列条**随编排走**——只在详情页渲染**单条**（主任务详情：存在可放置小任务时；任务/小任务详情：小任务且可编辑时），列表页不再出现。下述「每张组卡下方各一条」的逐卡 placement 为页面化前的历史决策，废止。

**二十轮 DA33（2026-09-05）修订**：主任务详情页的罗列条从页面底部（小任务卡片之后）**上移进头部卡**——与任务标题同卡（用户拍板「把团队成员放到上面去和任务标题放一起」）；渲染判据不变（存在 draft/ready 小任务才渲染），仍为小任务卡槽的拖拽源。任务/小任务详情页的罗列条维持页面底部原位（本轮未动）。

**二十三轮 DA36（2026-09-05）修订**：罗列条**移出头部卡**，置**头部卡下方**独立提示块（用户拍板「不放到卡片里面，放到卡片下面，左边用小竖线标识为提示」）——根容器去 `border-t` 分区线，改 `border-l-2` 左小竖线 + `pl-3` 缩进（BORDER token）；提示文案改「拖拽成员到下方的成员卡槽完成指派」，罗列条 chip 悬浮提示同步；渲染判据与拖拽源不变。

**二十四轮 DA37（2026-09-05）修订（订正二十三轮的过度移动）**：用户拍板「团队成员还是在卡片内，只是拖拽成员到下方的成员卡槽完成指派不在」——二十三轮把**整条**罗列条移出卡是过度移动，本轮拆分：`TeamMemberStrip` 恢复 `border-t` 分区形态放回头部卡 `extra` 槽（二十轮 DA33 形态），但**只留 chips 行**（「团队成员」标签 + 领队 chip + 成员 chips）；提示文案「拖拽成员到下方的成员卡槽完成指派」拆出为独立组件 `StripAssignHint`（`border-l-2` 左小竖线 + `pl-3`，二十三轮版式落在提示上而非罗列条），渲染在**头部卡下方**、与罗列条同判据（存在 draft/ready 小任务才渲染）；罗列条 chip 悬浮提示文案不变。任务/小任务详情页同轮接入同一套件——该页罗列条维持页面底部原位（`detailHeader` 不传 extra），提示块紧随其后；**罗列条入头部卡**仅发生在主任务详情页。

**二十五轮 DA38（2026-09-05）修订（竖线显眼）**：用户拍板「拖拽成员到下方的成员卡槽完成指派 左侧的竖线改得显眼一点」——`StripAssignHint` 左竖线由 `border-l-2` + 中性 token 线改 **`border-l-4` + 品牌色实线**（`border-primary`，与卡槽悬停/拖入高亮的品牌系一致）；文案、`pl-3` 缩进、渲染判据（与罗列条同源）均不变。

**二十六轮 DA39（2026-09-05）修订（锚面开合改回 click 期）**：用户拍板「现在小任务里面的选择成员弹出弹窗后马上就消失了」——DA38 的 onPointerDown 抢翻转回归：pointerdown 开合让同一交互的焦点默认动作（焦点落到 portal 内容之外的锚面上）被刚挂载的 Radix focusin 外出关闭监听捕获、立即 onDismiss。开合改回 click 期（锚面 onClick：stopPropagation + 显式翻转），同交互结束后才挂外出监听，开得稳；空链卡槽「＋ 拖入成员」与行尾「＋」两处锚面同改，键盘 Enter/Space 降级路径不变。点击卡身空白处收起弹窗不受影响——那半由 DA38 的防冒泡包装层撤除 + 原生冒泡 + Radix deferred click 关闭承载，与锚面开合是两条独立路径。

**二十七轮 DA40（2026-09-05）修订（开始钮判据放宽）**：用户「还是没看到开始按钮」（连续三轮）——ready 等值判据在组状态被旁路转移（如终站收口/取消后的旁路状态）时会把钮藏掉；列表卡与详情页标题行统一放宽为**非终态组即渲染**（completed/cancelled 才收；正常执行期组状态恒 ready，行为不变，纯兜底）。同轮整体开始改**链式接力**（一次只发第一棒、完成帧自动交棒，见 A.1 DA40 与 29.3 二十七轮行）；小任务详情入口维持 DA38 口径全无（用户拍板「不需要小任务详情啊」——主任务详情页即小任务状态总览，顶层普通任务的「详情」钮保留）。

**二十八轮 DA41（2026-09-05）修订（组卡去详情钮/头部卡开始钮/箭头剥描边/对齐/就地编辑）**：用户五项（见 A.1 DA41）——列表页组卡撤「详情」钮（整卡点击即进详情，顶层普通任务卡 [详情][删除] 逐位不变）、组卡钮序 [删除][开始]（开始最右）；主任务详情页「开始」钮上移头部卡右端（头部卡即任务介绍卡），「任务列表」行只剩「＋ 新增小任务」，行内错误提示槽跟迁到头部卡下（语义不变：同 taskId 匹配）；展开箭头剥品牌色焦点环与 Trigger 渗漏类（真凶 focus-visible:ring-1——hover 淡底十九轮 DA32 已压平，用户仍见「背景色」实为点击后的 1px 品牌色描边）；头部卡标题行 flex 化（pill 与文字垂直居中、行距统一 mt-1.5/2.5）+ 小任务行 items-center；小任务卡「修改」从弹窗改**就地编辑**——点修改该卡行头下方展开标题 Input + 单 MD 编辑器（内容 = 展开只读视图显示的说明与合同并读文本），保存整篇回写 contractMd、description 落严格空串（内容收敛进 contractMd、老数据首存并文不丢），编辑态隐钮簇/卡槽/箭头并锁拖拽、同刻仅一卡编辑；普通任务详情页头部卡加「编辑」钮（按钮行撤「修改」），「新增小任务」与卡槽弹窗路径维持不动（就地编辑中 onOpenEdit 哑化防截胡草稿）。

**二十九轮 DA42（2026-09-05）修订（就地编辑先展开 + 行头状态前移统一样式）**：用户指正两点（见 A.1 DA42）——DA41 就地编辑的「钮簇/卡槽/箭头整簇隐去 + 行头下插编辑器」属突变布局，订正为「未展开先展开、原布局全程不动」：编辑器入 AccordionContent 展开区与只读正文二选一（节点级门 `expandable \|\| editing` 防无内容卡取消后残留空分隔线），编辑中收起草稿保留、幂等重开不重拉，「取消」才退编辑，删除/开始成功清编辑槽防陈旧草稿复活，保存后留展开态；行头状态 pill 前移（状态 → 阻塞 → 序号 → #id → 主题 → 指派），样式统一主任务底栏款（`STATUS_PILL_CLASS`：2px 圆角 + 描边 + hover 淡底压平，底栏同引），左组 flex 化与 detailHeader 信息组同构（内联基线/行高错位机理消除）。

**三十轮 DA43（2026-09-05）修订（正文换角色同款 MdEditor + 标题原位编辑）**：用户指正两点（见 A.1 DA43）——就地编辑正文从 font-mono Textarea 换成角色人设同款 `MdEditor`（所见即所得，minHeight 220、任务占位/头部文案，保存飞行中 readOnly 锁编辑；MdEditor 组件加 placeholder/headerNote/readOnly 三个可选 props，默认值维持人设文案、既有调用位零回归）；标题不再塞编辑器块——小任务行头与任务详情页头部卡的主题 span 编辑态**原位换 Input**（detailHeader 新增 subjectEditor 槽与 editor 槽同判据），组详情页不传零变化，弹窗路径与 DA42 幂等/暂存/清槽语义不动。

**三十一轮 DA44（2026-09-05）修订（组件抽离五文件 + 行头去 #id + Input 统一加宽 + 间距规整 + 拖拽环 inset + 组页头部卡编辑钮 + 状态组件统一）**：用户六项（见 A.1 DA44）——抽离为**纯移动重构**（taskPills 状态件/taskHeaderCard 头部卡/taskSubtaskItem 小任务行整块/taskListCard 列表卡/taskDialogs 弹窗三件，tasksTab 1429→805 行，无循环依赖、零行为变化，验收对照 HEAD 原文逐段核对）；小任务行头撤 #id（序号与头部卡 #id 保留）；三处原位 Input 统一 `INLINE_SUBJECT_INPUT_CLASS`（h-8/min-w-[160px]，宽度确有增加）；五处间距规整（挂靠行 mt-2/组侧 assignError 撤 ml-4/底栏 pt-2/依赖 chips mt-1/抽屉站点行 mt-1）；拖拽高亮 ring-inset 免 overflow 裁剪（根因面板滚动列 overflow-x-hidden 裁外缘环）；组详情页头部卡补「编辑」钮（mutable 判据——host updateTask 仅 draft/ready 可改字段，开始钮仍最右）与 subjectEditor/editor 槽；状态 pill 三处统一 `TaskStatusPill`（taskPills.tsx 新文件，DisplayStatusPill 私有 + STATUS_PILL_CLASS 封装）。

**三十二轮 DA45（2026-09-05）修订（头像边框全局统一）**：用户「头像加上边框」——任务区 5 处 DA36 已有描边，用户所见无边框头像在其它表面；描边进 Avatar 容器默认类（border border-solid border-[color:var(--border)]），双渲染分支同吃，全表面统一生效（AvatarRing/AvatarStack 包装同走 Avatar 无旁路），className 仍可覆盖；任务区 5 处 AVATAR_BORDER_CLASS 显式传参与常量撤除（twMerge 下视觉零变化）；AvatarRing 四处双线环面随之多内层细线（预期后果，嫌重可覆盖）。

**逐卡决策（历史，用户 2026-09-04 拍板）：成员罗列条渲染在每张任务单（group）卡内的下方——小任务行之后，每卡一条。** 回归用户原话「在任务下方把所有成员罗列出来」的字面位置。设计稿曾论证「区块级单条」（同队成员对全部组卡相同、去重、置顶视线），经用户确认**不采纳**；本文按用户决策执行：逐卡重复渲染一份相同副本（可拖拽 chip），拖拽源与放置目标在同一卡内就近可见。

- 条内 chip：`Avatar` 26px + 名字（12px medium）+ 状态点（memberTone）；**工号数字徽章**（五轮 DA18，2026-09-05 拍板「未启动改成工号，别 ET- 就显示数字」：`employeeBadgeOf` 剥 `ET-` 前缀只显数字，`STRIP_BADGE_CLASS` 小型徽章面；legacy null 不渲染——原 staged「未启动」小字废止，staged 态由状态点表达）；**头像 1px --border 描边**（二十三轮 DA36：用户拍板「任务中的成员头像加上border」，Avatar 增 className 透传）；领队 chip 单列置首、带「领队」徽标、不可拖（口径不变）；chip 高统一 32px（DA14 30px → DA16 三轮；圆角 4px，五轮 DA18）。
- chip 规格复用 `ROLE_CHIP_CLASS` 的品牌淡底变体做「可拖」签名（`bg-business-tint`，E16），hover 提示 `title="拖拽成员到下方的成员卡槽完成指派"`（二十三轮 DA36 文案），cursor `grab/grabbing`。
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
| 全部 created/init | 汇总 chip 「待开始」（中性；二十四轮 DA37 文案合并，原「待指派」废止） |

优先级：error > doing > waiting > created（错误传染语义与 docs/05.9 依赖 POISON 集一致，taskMachine.ts:97-102）。group 的 `draft`（批准前）不做汇总——拆解中，只显示「小任务 n 个」计数。

（上表为设计期快照，行内旧词表文案——「等待执行/已创建」等——以 `taskDisplayStatus.ts` 的 DISPLAY_STATUS_TABLE 当前实现为准；二十四轮 DA37 起 draft/ready 展示文案合并为「待开始」（STATUS_LABELS.draft/ready、DISPLAY_STATUS_TABLE 两态、groupDisplayOf 兜底 chip 三处同步），底层 10 态状态机不动，「需要选择成员」是指派提示不是状态。）

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
| 十一轮（2026-09-05，DA24 任务主列表平铺小卡栅格） | `tasksTab.tsx`：列表页 return 块整体重写——「对话任务」区块与 STATUS_GROUPS 十态分区（组头/dotClass/TASK_ROW_CLASS 精简行）**撤除**，改团队列表同款 `Card` 面板（PANEL_CARD_CLASS + 「任务 n 个」标题行 LIST_TITLE/LIST_COUNT + CARD_GRID_CLASS 栅格）平铺顶层任务小卡（`TASK_CARD_CLASS` + `.eteams-task-card`：头行 #id 主题截断 + 展示态 pill、身体行 小任务进度（x/y 完成 · n 进行中）/指派 + 阻塞 pill + 汇总 chip、文件夹行；整卡点击进详情）；`shared.tsx`：ROLE_LIST_CSS 增 `.eteams-task-card` 别名选择器（与 `.eteams-team-card` 同规则并轨）+ 注释同步；`taskDisplayStatus.ts`：STATUS_GROUPS 注释改「十一轮后无运行时渲染方的键序规范」（列表不再按态分区）；`tests/taskDisplayStatus.test.ts`：STATUS_GROUPS describe 题注同步（311 用例）。零 store/host/核心纯函数变更 |
| 十二轮（2026-09-05，DA25 去号/文件夹可点击/加大/分行/底栏删除） | `tasksTab.tsx`：列表小卡重排——头行去 `#{taskId}` 前缀（只渲染主题 + pill）、信息**分行**（进度/chip/阻塞各自独立行，不再 flex-wrap 混排）、文件夹行去「文件夹：」标签改**可点击件**（裸路径下划线 + hover 提色 + title；stopPropagation；`folderBusy` 禁用中、`folderError` 行内 FormErrorNote）、栅格换 `TASK_GRID_CLASS`（260px）、底栏 border-t 分区 + 删除钮（`deletableOf` 判据 = draft/ready + 主任务小任务全 draft/ready + 删除集无下游依赖，仅可删的卡渲染；stopPropagation；删除确认弹窗共用面扩大——标题「删除任务」、主任务级联提示、文案去 #id）；`shared.tsx`：新增 `TASK_GRID_CLASS`（任务列表专用 260px 栅格，不并轨 CARD_GRID_CLASS）；`api.ts`：新增 `openTaskFolder(teamId, taskId)`；`webui.ts`：新增 POST `/team/<id>/task/<taskId>/folder/open` 路由（`taskDirAbs` 现算目录、缺失 400、未知任务 404；`installWebSurface` 增 `WebSurfaceOptions.openFolder` 注入点，默认 `defaultOpenFolder` 按平台 spawn explorer/open/xdg-open，detached + 异步错误吞掉）；`tests/webui.test.ts`：增 folder/open 路由回归 1 例（假打开器收目录 + 404/400 分支，312 用例） |
| 十三轮（2026-09-05，DA26 对齐/小任务 0/目录标签/路径截断收窄） | `tasksTab.tsx`：①`BlockedPill` 增 `className` prop、**ml-1 不再内建**（详情页两处行内文字流调用位补 `className="ml-1"`，列表卡独立行顶格与其它行左缘齐）；②进度行**无条件渲染**（`const progress` 三分支：主任务 draft = 小任务 N 个、主任务非 draft = N/M 完成 · n 进行中、顶层普通任务 = 小任务 N（指派人并入同行）——无小任务显「小任务 0」，用户拍板「没有小任务就显示0」）；③文件夹行恢复**「目录」两字标签** + 只显示末段路径（`folder.split('/').pop()/`，全路径进 title「在文件管理器中打开：<全路径>」）；④底栏 `mt-auto` 沉底（同栅格行内容行数不同的卡删除栏齐平）；头注/卡片常量/区块注释同步。零 store/host/api/纯函数变更（312 用例） |
| 十四轮（2026-09-05，DA27 状态入底栏/进度三计数/工作目录钮/详情钮） | `shared.tsx`：`Pill` 增 `className` 透传（tailwind-merge 压过基础圆角/底色，其余调用位不传观感不变）；`tasksTab.tsx`：①头行只剩主题（展示态 pill 挪出），`DisplayStatusPill` 增 `pillClassName` 直通内层 Pill；②底栏重构为每卡常驻左右分栏（justify-between）——左 = 状态 pill（`rounded-[2px]` 用户拍板「圆角改成 2px」，「左边下面」按十二轮「下面放删除按钮」同词汇解作卡底栏），右 = 「详情」outline 钮（新增，`setSelectedTaskId` 显式入口）+ 「删除」钮（仍仅 `deletableOf` 通过的卡渲染）；③进度行改三分计数 JSX：共 N 个任务，已完成 N（`text-success`）/未完成 N（`text-warning`），数字着色、总数走行底灰，「进行中」计数不再单列（`active` 变量删除），指派人尾注保留；④文件夹行改「工作目录」四字描边小按钮（self-start、border 走 `.eteams-ui` --border 缺省、hover 淡底；末段路径文案撤除，完整路径仅存 title）；头注/卡片常量/区块注释同步。零 store/host/api/纯函数变更（312 用例） |
| 十五轮（2026-09-05，DA28 状态 pill 描边/工作目录幽灵钮） | `tasksTab.tsx`：①底栏状态 pill `pillClassName` 叠加 `BORDER_L1_CLASS` 描边（tailwind-merge 压过 Badge `border-transparent`）+ `hover:bg-[color:var(--eteams-pill-bg)]` 同色 hover（压平 Badge `hover:bg-secondary/80` 淡底，悬停底色不变）——用户「去掉放上去变淡，加上边框」；②文件夹行工作目录钮撤外壳（border/bg-background/px/py/transition 全去）改幽灵文字钮（text-foreground + underline-offset-2 hover:underline）——用户「还是不协调，修改一下更好融入卡片」；头注/卡片常量/区块注释同步。零 store/host/api/纯函数变更（314 用例——工作区另有并行新增的 rolebuilder-resume 回归 2 例，非本轮改动面） |
| 十六轮（2026-09-05，DA29 合同并一 MD + 小任务展开） | **本轮动数据模型（DB + host + client 全链）**。`src/host/model/contract.ts`（新）：`contractMdFromLegacyArrays`（旧四数组 → 一篇 MD 合成器，段落 = ## 验收标准 编号 / ## 允许改动 / ## 禁止改动 / ## 交付物）；`model/types.ts`：TaskRecord 四数组字段撤除 → `contractMd?: string`；`state/schema.sql` + `state/db.ts`（SCHEMA_SQL 同步）：task 表四列 → `contract_md TEXT` 单列、DB_SCHEMA_VERSION 1→2，getDb 增 `migrateTaskContractMd`（table_info 探测 → ALTER ADD COLUMN + 旧列数据合成回填，幂等；新库 DDL 已是新形状直接跳过）；`state/store.ts`：task SELECT/INSERT 换 contract_md（jsonArrayOrUndefined/jsonArrayOrNull 助手删除）；`state/import.ts`：LegacyTask 增 `contractMd?`，INSERT 换 contract_md 列（contractMd 直取 ?? 四数组合成）；`runtime/assignment.ts`：create/update 参数四数组 → `contractMd?: string`；`tools/captainTools.ts`：eteams_create_task/eteams_update_task 四个 strArr 参数 → `contractMd` 单字符串参数（描述注明分节写法）、task_board 输出 `acceptance: []` → `contractMd: t.contractMd ?? null`；`prompts/handoff/mails.ts`：renderContract 改透传 contractMd 原文（`任务合同：` + 空行 + 原文；description/幂等说明/前置依赖行保留）——contract.md 文档与成员工具（claim/my_tasks 的 contract 字段）同源受益；`runtime/webui.ts`：taskView 与 track contract 载荷四数组 → `contractMd: t.contractMd ?? null`；client 侧 `lib/monitor.ts`：TaskView 四数组 → `contractMd: string | null`；`pages/teamsView/taskDrawer.tsx`：`ContractList` 四组平文列表撤除 → `ContractMd`（MarkdownText 只读渲染，`任务合同：`标签行）；`pages/teamsView/tasksTab.tsx`：主任务详情页小任务卡加**展开钮**（ChevronDown，`expandable = description/contractMd 有其一`，expandedSubIds 瞬态多开）+ 展开区（border-t 分区：说明行 + MarkdownText 合同 MD；stopPropagation 不误进详情页）；`tests/lifecycle.test.ts`：create_task 参数换 contractMd + 增 `sub.contractMd` 回读锁；`tests/store.test.ts`：增 v1→v2 迁移回归 1 例（v1 形状旧库建表插四列旧数据 → getDb 触发迁移，锁 contract_md 四节齐全 + 重开幂等不变）（317 用例——本轮新增迁移回归 1 例，其余为并行流增例） |
| 十七轮（2026-09-05，DA30 展开 shadcn 化/展开内容下移卡槽下） | `components/ui/collapsible.tsx`（新）：shadcn/ui Collapsible vendoring（Radix `@radix-ui/react-collapsible` Root/Trigger/Content 直出，dialog/popover 同款惯例）；`package.json`：devDependencies 增 `@radix-ui/react-collapsible@^1.1.20`（构建打包进 client envelope）；`tasksTab.tsx`：小任务卡身包 `Collapsible`（受控 open 仍由 expandedSubIds 瞬态多开驱动、onOpenChange 回写，手写 toggleSub 删除），卡头行展开钮改 `CollapsibleTrigger asChild` 包原 ChevronDown 钮，展开内容改 `CollapsibleContent` 且从「卡头行与卡槽之间」挪到**成员卡槽 + 站点行之后**（用户拍板「出现的文字会在卡槽下面」；内容本体不变 = 说明行 + MarkdownDoc 合同 MD + border-t 分区）；expandable 判据（有说明或合同 MD 才渲染触发钮）、旋转 180°、stopPropagation 防误进详情页保持。零 host/store/纯函数变更（317 用例） |
| 十八轮（2026-09-05，DA31 展开升级 shadcn Accordion——并行流落地、本文回补） | `components/ui/accordion.tsx`（新）：shadcn/ui Accordion vendoring（Radix `@radix-ui/react-accordion` 四件套；上游内嵌 ChevronDown 撤除、Header 补 m-0 补 preflight 缺位、animate-accordion-down/up keyframes 随 tailwind.config 随件补上——详见 docs/43）；`package.json`：devDependencies 增 `@radix-ui/react-accordion`；`tailwind.config.ts`：accordion keyframes/animation；`tasksTab.tsx`：逐卡 Collapsible + 手写开合状态机撤除 → `<Accordion type="multiple" value=expandedSubIds.map(String) onValueChange>`（多开状态机交给组件），包装 div 改 `AccordionItem`（border-b-0 压平），触发钮改 `AccordionTrigger asChild` 包 ghost 图标 Button（title 升级为 Hint 悬浮提示），展开内容改 `AccordionContent`（关态即卸载）。展开位（卡槽下面）/expandable 判据/stopPropagation 保持。**并行流（docs/43 组件目录批次）落地、四绿门与验收记录随该批次** |
| 十九轮（2026-09-05，DA32 展开钮最右侧 + hover 底色压平） | `tasksTab.tsx`：①展开钮（Hint + AccordionTrigger asChild + ghost 图标 Button）从按钮组首位挪到**最右侧**（修改→删除→⌄；用户拍板「放到最右侧」；不可编辑卡无修改/删除时展开钮本就独居右端）；②触发钮 className 叠 `hover:bg-transparent`（tailwind-merge 压平 ghost 变体 `hover:bg-accent`，用户拍板「不要这个背景色」；悬停只剩字色 muted→foreground）。图标旋转/Hint/stopPropagation/展开位（卡槽下面）保持。零 host/store/纯函数变更（317 用例） |
| 二十轮（2026-09-05，DA33 主任务详情页头部卡收三件 + 「任务列表」节标题） | `tasksTab.tsx`：①`detailHeader` 增 optional `extra?: ReactNode` 槽（渲染在文件夹行后、卡内末尾；任务/小任务详情页不传保持原观感）；②主任务详情页——原 `progressText` 变量（「· 小任务 n/m 完成」行 + draft 特例）删除，改头部卡内三计数行（共 N 个任务，已完成 N `text-success` / 未完成 N `text-warning`，DA27 任务列表卡同款），汇总 chip（B.2 判据）随行入卡，`detailStrip` 上移入卡（渲染判据不变，页面底部原 `{detailStrip(...)}` 调用位删除）；③头部卡与新增小任务按钮之间插「任务列表」节标题（LIST_TITLE_CLASS + mt-1.5，用户拍板「卡片下面加标题 任务列表」）。小任务卡（展开/卡槽/把手）与任务/小任务详情页均未动。零 host/store/纯函数变更（317 用例） |
| 二十一轮（2026-09-05，DA34 标题行新增钮靠右 + 小任务卡撤缩进） | `tasksTab.tsx`：①「任务列表」标题与「＋ 新增小任务」钮合并为一行 flex（items-center gap-3；标题 LIST_TITLE_CLASS 自带 flex-1 占满把钮推到最右；钮的独立 mt-1.5 撤除，行整体 mt-1.5）——用户拍板「任务列表右侧是新增任务」；②`SUBTASK_CARD_CLASS` 撤七轮 DA20 挂靠缩进 `ml-4`（mt-1.5 卡间距保留）——用户拍板「下面的任务列表左边不留空隙」，小任务卡与头部卡/标题左缘齐平；③组内改删错误行（FormErrorNote）随卡对齐同步撤 ml-4。任务/小任务详情页未动。零 host/store/纯函数变更（317 用例） |
| 二十二轮（2026-09-05，DA35 多选面板标题简化 + 链中成员不进列表） | `taskAssign.tsx`（StationPicker）：①面板头行「选择成员，追加为接力站点」→「选择成员」（用户拍板去掉「追加为接力站点」）；②列表 `members.filter((m) => !chainMembers.includes(m.name))` 滤除链中成员（不渲染；用户拍板「已经选中的成员不出现在列表中」，原禁用 + opacity-50 + 「已在链中」标 + cursor-not-allowed 分支删除），行内角色小字恒显 `m.role`；全部在链中时显「暂无可选成员」空态；③文件头注释同步。确认钮（添加 N 站）/勾选序追加语义/`chainAfterAppendMany` 去重守卫不变。零 host/store/纯函数变更（317 用例） |
| 二十三轮（2026-09-05，DA36 确认钮文案 + 拖拽高亮修复 + 头像描边 + 罗列条卡下方左竖线） | `taskAssign.tsx`：①StationPicker 确认钮「添加站点 / 添加 N 站」→「添加成员 / 添加 N 个成员」（用户拍板「添加站点改成添加成员」）；②`BOX_MULTI_OVER_CLASS` 悬停底改 `color-mix` 品牌淡底（原与 chip 底同色看不出）+ `CHIP_RING_CLASS` 加 `ring-inset`（环画进 chip 内缘，滚动容器滚动态裁不掉外缘环）——用户拍板「拖拽时高亮显示被遮挡了」；③`AVATAR_BORDER_CLASS`（1px --border）应用于任务区 5 处头像（罗列条/领队/多选面板行/卡槽 chip/只读框），`avatar.tsx` 增 optional `className` 透传——用户拍板「任务中的成员头像加上border」；④`TeamMemberStrip` 根容器去 border-t 改 `border-l-2` + pl-3 左竖线提示块、提示文案与 chip title 改「拖拽成员到下方的成员卡槽完成指派」，`tasksTab.tsx` 罗列条移出 detailHeader extra 槽置头部卡下方（渲染判据不变）——用户拍板「不放到卡片里面，放到卡片下面，左边用小竖线标识为提示」。零 host/store/纯函数变更（317 用例） |
| 二十四轮（2026-09-05，DA37 罗列条回卡只留 chips 行 + 小任务卡「开始」钮 + 展示文案合并「待开始」） | `taskAssign.tsx`：①`TeamMemberStrip` 恢复 border-t 分区形态回头部卡（订正二十三轮整条移出为过度移动——用户拍板「团队成员还是在卡片内」），**只留 chips 行**（「团队成员」标签 + 领队 chip + 成员 chips，提示行拆出）；②新增 `StripAssignHint` 组件（border-l-2 左竖线 + pl-3，文案「拖拽成员到下方的成员卡槽完成指派」——用户拍板「只是拖拽成员到下方的成员卡槽完成指派不在（卡内）」，二十三轮版式落在提示上）；`tasksTab.tsx`：③罗列条回 `detailHeader` extra 槽 + 提示块渲染在头部卡下方（同判据 `stripShow`；**主任务详情页**罗列条入卡，**小任务详情页**罗列条维持页底原位、提示块紧随其后，两处都渲染）；④小任务卡按钮簇与小任务详情页按钮行新增**「开始」钮**（`t.status === 'ready' && chain.length > 0` 才渲染；点击 = 新 `submitStart` → POST `/task/:taskId/start`；`startBusy`/`startError` 瞬态 + 行内 FormErrorNote）——用户拍板「卡片加上开始按钮」；ready 但**链空**的卡不渲染按钮、改显灰字「需要选择成员」（用户拍板「如果有任务没有成员，则提示需要选择成员就行」）；`api.ts`：⑤新增 `startTeamTask(teamId, taskId)`；`webui.ts`：⑥新增 POST `/team/<id>/task/<taskId>/start` 路由（locateTeam/404/400 校验同族；取 `task.chain[chainCursor + 1]` 复用 `assignTask` 派发核派发下一站；空链 400「需要选择成员」、链到末站 400「任务 #N 执行链已到末站，无下一站可派发」；依赖未满足/成员忙碌/领队不在线等拒绝照宿主原文 400 透出）；`taskDisplayStatus.ts`：⑦展示文案合并——用户拍板「没有什么草稿状态、待指派状态，只有待开始状态」：STATUS_LABELS.draft/ready = 「待开始」、DISPLAY_STATUS_TABLE draft（muted→info）/ready 同显「待开始」（桶键 init/created 保留不动组卡汇总优先级）、groupDisplayOf 兜底 chip「待指派」→「待开始」；**底层 10 态状态机不动**（仅展示层合并）；`tests/taskDisplayStatus.test.ts` 同步 + ①-⑥ 规则锁；`tests/webui.test.ts` 增 start 路由回归 1 例（空链 400 文案、派发成功 ready→wait + attempts + 成员子会话起会话、重复开始 400、未知任务 404；322 用例——基线 321 含用户提交 5b3f539 的并行批次 4 例） |
| 二十五轮（2026-09-05，DA38 主任务整体开始 + 无领队主会话锚点 + 竖线显眼 + 卡身点击撤除 + 弹窗收起修复） | `taskAssign.tsx`：①`StripAssignHint` 左竖线 `border-l-2`+token 线改 **`border-l-4`+品牌色实线**（用户拍板「左侧的竖线改得显眼一点」）；②多选面板收起修复（用户拍板「点击小任务里面的选择成员弹出弹窗后点击小任务空白地方弹窗没有消失」——根因：Radix Popover 1.1.23 外出点击关闭是 click 期 deferred（`deferPointerDownOutside: true`），click 的 stopPropagation 拦断 document 冒泡相监听后 deferred 关闭被判「已拦截」而抑制）：空链卡槽锚面与「＋」钮改 **onPointerDown 翻转开合**（按下即翻转，click 只拦冒泡）、有链容器空白处点击**显式收起**弹窗再开「修改」；`tasksTab.tsx`：③小任务卡身点击进详情**撤除**（用户拍板「小任务不需要再点击进入任务详情了」——SUBTASK_CARD_CLASS 去 cursor-pointer、SubtaskCard 去 onOpen/onClick，卡身只承担把手拖拽放置目标；按钮簇/卡槽行/展开区三处防冒泡包装层随之清理，点击恢复原生冒泡）；④主任务详情页标题行加**整体「开始」钮**（用户拍板「主任务需要加开始按钮，不然整个怎么启动，主任务启动就代表着小任务需要逐个开始执行了」——`selected.status === 'ready' && subs.length > 0` 才渲染；`submitStart` 升级吃 `{started, skipped}` 响应，跳过卡原因行内 FormErrorNote：全跳过列原因清单、部分成功带「已开始 N 个小任务，M 个未开始」）；`api.ts`：⑤`startTeamTask` 返回 `{started, skipped}`（`GroupStartSkipped` 类型；单任务路径两字段无跳过行为不变）；`assignment.ts`：⑥新增 `startGroupTask`（主任务判据 `parentId === null && 有子`；逐卡独立走 `assignTask` 派发核——各自持锁校验起会话投递，无链跳过 reason「需要选择成员」、链到末站跳过、依赖未满/占用/起会话失败按卡跳过回传原因，不拖累其余）；⑦`captainFor` 无领队锚点——用户拍板「需要判断团队是否含有领队，如果没有领队，主会话窗口就是领队，如果有领队，则从领队开始正式开始执行任务」：有领队（行在且未移出）→ 领队主会话锚点（不在册 = undefined 不退化）；无领队（行缺失/已移出）→ 原主会话在册先用（setLeaderRemoved 不改锚点、零迁移）→ 退化客户端活跃会话心跳 `readBuildPresence`（POST /presence 落盘，60s 有效）；⑧`ensureSpawned` 锚点重锚——锚点会话 ≠ 领队行 main_session_id 时改锚领队行（内存快照改、随派发写事务落库——成员子代理父会话校验 installMemberRuntime 按领队行判父）；不在线报错文案改「领队/主会话窗口不在线」；`webui.ts`：⑨start 路由主任务分支（`parentId === null && 有子` 判据——容器走 `startGroupTask`，200 `{ok, started, skipped}`；非主任务单任务链派发路径不变）；`tests/webui.test.ts`：⑩增 2 例（主任务整体开始混合小任务——有链派发 wait+attempts、无链跳过「需要选择成员」、容器保持 ready、全空链 started=0；无领队心跳锚点——leader/remove 后 delete 原主会话注册键 + POST /presence 指向另一在册会话，派发成功且领队行 main_session_id 改锚 `cap-second`、成员子会话起会话；harness 暴露 captains Map；324 用例——基线 322 + 2） |
| 二十六轮（2026-09-05，DA39 锚面开合改回 click 期 + 列表页主任务卡「开始」钮） | `taskAssign.tsx`：①弹窗一开即收回归修复（用户拍板「现在小任务里面的选择成员弹出弹窗后马上就消失了」——DA38 的 onPointerDown 抢翻转让同交互尾部的焦点变化落进刚挂载的 Radix focusin 外出关闭监听、立即 onDismiss；读 installed 1.1.19 dismissable-layer + 1.1.23 popover 源码实锤：NonModal 的防 focusin 关闭仅在有 pointerdown-outside 前置时生效）：空链卡槽锚面与「＋」钮开合改回 **click 期翻转**（onClick 内 stopPropagation + `pickerOpen ? 关 : 开`，同交互结束后才挂外出监听，点锚面收起由显式翻转承担、不依赖 deferred 关闭），onPointerDown 处理器撤除，键盘 Enter/Space 路径不变；`tasksTab.tsx`：②任务列表页主任务卡底栏钮区首位加「开始」实底主钮（用户拍板「主任务需要加开始按钮，没看到加在那里」——判据 `kind==='group' && status==='ready' && subs.length>0` 与详情页标题行同口径，点击走同一路由逐个派发 ready 小任务），startError 槽按卡行内就地提示（folderError 行之后）；详情页标题行整体开始钮保留；无新增用例（交互行为修复，GUI 装机冒烟口径）；四绿门复跑全绿（324 用例——与二十五轮持平） |
| 二十七轮（2026-09-05，DA40 链式接力 + 领队锚点统一 + 开始钮判据放宽 + 建卡补收 dependencies） | `assignment.ts`：①整体开始改**链式接力**（用户「整体开始，所有小任务链式执行」+ DA38「逐个开始执行」）——新增 `subExecutionOrder`（组内执行序：兄弟依赖拓扑序、同层建序稳定、组外依赖不算排序约束、依赖环兜底按快照序补齐），`startGroupTask` 按序**一次只发第一棒**（余下 ready 卡以「等待链式接力（前一小任务完成后自动开始）」记入 skipped；无链卡仍「需要选择成员」、派发被拒按卡透因后继续找下一棒），终态组（completed/cancelled）400「已…，无法整体开始」；②`completeTask` 尾**链式续派**——小任务终站收口且父组非终态时以完成成员名义调用 `startGroupTask` 交棒（组已收口免调用；失败仅 logger.warn 不吞完成应答；完成帧 out 增 actor 字段）；③`captainFor` 统一梯度（用户拍板「不存在领队会话离线啊」）——撤「有领队就硬绑领队会话」分支：领队行登记主会话在册先用 → 心跳 `readBuildPresence` 定位 → 都不在册才 undefined；`ensureSpawned` 报错文案改「主会话窗口不在线」；`webui.ts`：④建卡路由补收 `dependencies`（与 update 同`readDependenciesParam` 口径——面板建卡此前不收依赖）；`tasksTab.tsx`：⑤开始钮判据放宽——列表卡与详情页标题行由 `status === 'ready'` 放宽为非终态组即渲染（用户「还是没看到开始按钮」；正常执行期组恒 ready，纯兜底）；`tests/webui.test.ts`：⑥增 3 例（链式接力——整体开始只发第一棒、第二棒「等待链式接力」排队且保持 ready、第一棒完成后第二棒自动进 wait 且 Bob 起会话；终态组——末棒收口组 completed、再点开始 400「已完成，无法整体开始」；领队在册但会话下线——不 remove 领队、delete 主会话注册键 + 心跳指另一在册会话，派发成功且领队行改锚 `cap-second`）；四绿门复跑全绿（327 用例——基线 324 + 3） |
| 二十八轮（2026-09-05，DA41 组卡去详情钮 + 头部卡开始钮 + 箭头剥描边 + 对齐 + 就地编辑） | `api.ts`：updateTeamTask 增 `contractMd?: string`；`webui.ts`：update 路由补透传 contractMd（raw string 直传，绕开 str() 的 trim——正文首尾空白属内容；宿主 updateTask 原生支持）；`tasksTab.tsx`：①列表卡底栏——组卡撤「详情」钮、渲染序 [删除][开始]（开始最右），顶层普通任务卡 [详情][删除] 不变；②detailHeader options 化（extra/actions/editor 三槽）——组页头部卡 actions 挂「开始」（判据不变），startError 槽上移头部卡下，「任务列表」行撤开始钮；③小任务卡——箭头钮防御类剥品牌色焦点环与 Trigger 渗漏（flex-none py-0 justify-center hover:no-underline focus-visible:ring-0 focus-visible:ring-transparent）、行头 items-center、「修改」onClick 换 openInlineEdit、编辑态隐钮簇/卡槽/箭头（inlineEdit 单槽 {taskId, scope:'sub'|'header'} + subject/body/busy/error 四态，与弹窗态完全分离）、SubtaskCard 增 editing prop 锁拖拽、编辑器（Input + font-mono rows-10 Textarea + 取消/保存 + 行内报错）插行头下方、expandable/说明行加 trim 判据（快照空串落库不显空「说明：」行/空箭头）；④普通任务详情页——头部卡「编辑」钮（header scope 同套编辑器）+ 按钮行撤「修改」+ 卡槽 onOpenEdit 编辑中哑化；⑤mergedBodyOf 并读（说明 trim 空省略 + 空行分隔 + contractMd 保真），保存载荷 {subject, contractMd, description: ''}（宿主空串原样落库已核实）；`tests/webui.test.ts`：增 1 例（update 路由 contractMd——description 清空落库严格空串、contractMd 写入、仅 subject 不动合同、raw 保真、claim 后冻结 400）；四绿门复跑全绿（328 用例——基线 327 + 1）；验收后顺手修两处：普通卡钮序回退 [详情][删除]（实现笔误翻转 [删除][详情]）、contractMd 也加 trim 判据（清空正文后 expandable 残留） |
| 二十九轮（2026-09-05，DA42 就地编辑先展开 + 行头状态前移统一样式） | `shared.tsx`：新增导出 `STATUS_PILL_CLASS`（rounded-[2px] + BORDER_L1_CLASS + hover 淡底压平——底栏与行头共用）；`tasksTab.tsx`：①openInlineEdit——撤「打开编辑收起该卡」，改未展开先展开；同卡同 scope 幂等重开（只确保展开、草稿保留不重拉）；②小任务卡——行头钮簇/成员卡槽撤编辑态门恢复常显、卡槽 onOpenEdit 编辑中哑化（inlineEdit 双键匹配）、编辑器从行头下迁入 AccordionContent（节点级门 `(expandable \|\| editing)`，编辑态 inlineEditor/非编辑态只读正文二选一）、箭头判据 `expandable \|\| editing` + 撤 mt-0.5、confirmDelete/submitStart 成功清编辑槽（防陈旧草稿复活）；③行头左组——flex min-w-0 flex-wrap items-center（与 detailHeader 信息组同构）+ 状态 pill 最前（补 retryCount + STATUS_PILL_CLASS）→ BlockedPill → 序号 → #id → 主题 → 指派，ml-1/mr-0.5 全撤；④列表卡底栏 pillClassName 改引 STATUS_PILL_CLASS（串值等价视觉零变化）；四绿门复跑全绿（328 用例持平）；验收后顺手补一处：submitStart 清槽撤 scope 限定（头部卡编辑 + 开始成功同清，防冻结草稿残留） |
| 三十轮（2026-09-05，DA43 就地编辑正文换角色同款 MdEditor + 标题原位编辑） | `mdEditor.tsx`：MdEditor 加可选 props placeholder（默认人设占位文案）/headerNote（默认人设头部文案，空串隐藏）/readOnly（透传 MDXEditor 原生 readOnly，运行时可切）——既有 membersTab×3、teamMembers×1 调用位零回归；`tasksTab.tsx`：①inlineEditor 撤标题 Input + font-mono Textarea，换 `<MdEditor value/onChange minHeight={220} placeholder="说明 / 合同（Markdown）" headerNote="说明 + 合同 · 所见即所得" readOnly={inlineBusy} />`（FormErrorNote/取消保存行原样）；②小任务行头主题 span 编辑态原位换 Input（h-7 min-w-0 flex-1、autofocus）；③detailHeader opts 加 subjectEditor 槽、判据行整行替换（组详情页不传零变化）、任务详情页头部调用传同判据 Input；四绿门复跑全绿（328 用例持平）；弹层 fixed 定位不被 AccordionContent overflow-hidden 裁剪（Radix popper 包含块语义，头注已记） |

| 三十一轮（2026-09-05，DA44 tasksTab 组件抽离 + 六项规整） | 抽离（纯移动，零行为变化）：`taskPills.tsx`（98 行——DisplayStatusPill 私有 + 新 `TaskStatusPill` 封装 STATUS_PILL_CLASS + BlockedPill/GroupSummaryChip 迁入）、`taskHeaderCard.tsx`（65 行——detailHeader → TaskHeaderCard，options 三元改 props 判据等价）、`taskSubtaskItem.tsx`（305 行——SUBTASK_CARD_CLASS + SubtaskCard + SubtaskItem 小任务行整块；isOver `ring-inset` 修复拖拽左缘高亮被面板列 overflow-x-hidden 裁剪）、`taskListCard.tsx`（204 行——TASK_CARD_CLASS + deletableOf + TaskListCard）、`taskDialogs.tsx`（166 行——TaskEditTarget + 编辑/新增/删除确认三弹窗）；`tasksTab.tsx` 1429→805 行（头注裁剪、import 收口、四处调用位换组件调用）；`shared.tsx`：新增 `INLINE_SUBJECT_INPUT_CLASS`（h-8 min-w-[160px] flex-1 rounded-md px-2.5 text-sm）——小任务行头/两处头部 subjectEditor 三处统一；小任务行头撤 `#{t.taskId}`（序号/头部卡 #id 保留）；组页 headerEditing 派生 + actions [编辑][开始]（编辑判据 = mutable draft/ready，开始最右）+ subjectEditor/editor 槽；间距：挂靠行 mt-2、组侧 assignError 撤 ml-4、列表底栏 pt-2、依赖 chips mt-1、taskDrawer 站点行 mt-1；三处状态 pill 调用换 TaskStatusPill。无宿主/api/tests 变更，四绿门全绿（328 用例持平） |

| 三十二轮（2026-09-05，DA45 头像边框全局统一） | `features/avatar/avatar.tsx`：AVATAR_CONTAINER_CLASS 追加 `border border-solid border-[color:var(--border)]`（补 border-solid 惯例）——描边进容器默认，双渲染分支（SeedAvatar 主干/首字母 fallback）同吃，全表面统一（团队卡/成员库/添加成员弹窗/teamsButton/buildCard/构建台/角色页/任务区；AvatarRing/AvatarStack 包装内部同走 Avatar 无旁路）；头注/常量/组件注释补 DA45 记录；`features/tasks/taskAssign.tsx`：AVATAR_BORDER_CLASS 常量与 5 处调用位显式传参撤除（罗列条 chip/领队 chip/只读框/多选面板行/卡槽 chip——twMerge 下视觉零变化）。无宿主/api/tests 变更；四绿门全绿（24 文件 337 用例——基线随用户并行提交上移，非本轮改动面） |

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