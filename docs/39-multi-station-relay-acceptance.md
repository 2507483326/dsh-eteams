# 39 · 小任务多人接力槽位与头像放大（docs/29 二轮+三轮验收）

> 2026-09-04。需求与设计见 docs/29（DA13/DA14 及 A 节二轮改写）；本文只记改动面、
> 审核发现与处置、四绿门结果。行为契约以 docs/29 为准。

## 背景（用户需求原话）

「任务里面的团队成员 头像弄大一点，然后每个小任务的卡槽目前只能放一个人员，
我想可以放多个人员」。协作语义经用户拍板：**按序接力**（拖入按顺序追加站点，
同一站点不并行多人——同站并行需要宿主数据模型改造，不采纳，见 docs/29 冲突②）。

## 决策

- **DA13**：小任务行尾成员框升级为**多人接力槽位**——可编辑窗口
  （`draft/ready && chainCursor===-1`）内框承整链站点 chips（按序=接力顺序）；
  拖到空白处=追加站点、拖到某 chip=定点替换该站（嵌套 drop target，dnd-core
  内层先 drop、容器 `didDrop` 让位、`isOver({shallow})` 区分悬停面，chip 与
  容器 canDrop 同条件）；chip ×=移除该站；全链同名去重（同名拖入=no-op，
  200ms 微反馈，闪现落点跟随命中面）。
- **DA14**：罗列条成员 chip、领队 chip、框内 chip 的头像 18px→**22px**
  （chip 高 26px→30px）。

## 改动面

| 文件 | 改动 |
| --- | --- |
| `src/client/features/tasks/taskAssignCore.ts` | `nextChainAfterDrop` 增 `stationIndex?`（缺省=末尾追加，显式=定点替换保 brief，越界→null）；全链同名去重；新增 `chainAfterRemove`（逐站移除）/`canRemoveStation`/`boxCoversChain`（可编辑框承整链）；废止 `canClearStation`/`clearedChain`/`dropTargetMember`/`boxRendersContent`（src 下零残留） |
| `src/client/features/tasks/taskAssign.tsx` | 成员框：空链=空槽（拖入追加）、非空=flex-wrap 整链 chips + 行尾「＋」提示 + 新增 `StationChip` 嵌套 drop target（替换该站、×移除、ring 高亮）；chip/罗列条/领队 chip 头像 22px、chip 高 30px；悬停/去重微反馈按命中面分离 |
| `src/client/pages/teamsView/tasksTab.tsx` | `suppressStations` 由「单站且框有内容」改为 `boxCoversChain(t)`（可编辑且非空即抑制 TaskStations）；`onClear` 改 `onRemoveStation={(index) => … chainAfterRemove(t, index)}` |
| `tests/taskAssign.test.ts` | 规则锁同步改写：空白追加/定点替换/越界 null/全链去重/逐站移除/boxCoversChain，共 19 用例 |

宿主无改动——drop 仍走 `updateTeamTask` 整链重发（DA10），非乐观更新，
成功后 `refreshActivitySoon()`。

## 审核发现与处置

- **F1（证据订正，重要）**：一轮设计曾认为「整链重发含悬空名会被宿主 400 拒」
  ——不成立。链校验只查成员名在 member 表模板行（`assignment.ts` 链校验段），
  `removeMember` 只把 taskMembers 行标 `removed`（`teamOps.ts`），member 表本身
  无 status。即**悬空名可随整链重发通过宿主校验**：未开跑链经框 chip 定点替换
  修复，已开跑链经「修改」弹窗修复（宿主实际放行）。风险后移到执行时刻
  （指派/领取路径）。docs/29 DA9、A.7、29.5 冲突③、Q2 已按此反转订正；
  「宿主是否应收紧为校验 taskMembers 非 removed」留为开放问题，不在本次范围。
- 嵌套 drop target 机制经 dnd-core 源码核实：内层先 drop，容器以
  `monitor.didDrop()` 让位；`isOver({shallow:true})` 区分悬停面；canDrop 在
  排序前过滤 → chip 与容器 canDrop 必须同条件（更严会被滤掉、落点误成容器追加）。
- `nextChainAfterDrop` 越界语义定为 **null（no-op，不误追加）**，实现与 docstring
  对齐（快照中途变化防御）。

## 四绿门（2026-09-04）

| 门 | 结果 |
| --- | --- |
| `pnpm typecheck` | 绿（host+client 双 tsconfig 无错误） |
| `pnpm lint` | 绿（0 error；2 条 warning 为 memberDialog/taskDrawer 既有 exhaustive-deps，非本次引入） |
| `pnpm test` | 绿（23 文件 / 292 用例全过；taskAssign 19 用例全过） |
| `pnpm build` | 绿（clean→tsc×2→tailwind→tsdown→wrapClient→smoke `SMOKE OK: id=dsh-eteams, exports=[apply, inject]`） |

**GUI 装机冒烟：未验证。** 客户端为注入宿主的 CJS 包，无独立 dev server；
拖拽/弹窗交互需装机后在 DSH 面板人工过一遍（docs/29 A 节规则表为人工核对单）。

## 备忘（不阻塞，留观察）

- **F8**：任务罗列条渲染条件未含 `chainCursor`（沿用一轮口径）；若后续发现
  开跑后罗列条干扰调度，再议。
- **F10**：docs/29 A 节部分宿主行为行号随版本漂移，属既有遗留；行号仅辅助
  定位，语义以段落文字为准。
- `docs/31-acceptance.md` 中一轮验收的旧函数名引用为历史记录，不改。

## 三轮追加（2026-09-05，DA15/DA16）

**用户需求原话**：「怎么限制只能放两个，把头像再加大，然后放入卡槽只显示头像试试」。

| 决策 | 内容 |
| --- | --- |
| DA15 | 接力链上限 **2 站**：框空白处满员禁追加（容器 canDrop 收紧、行尾「＋」转「已满」、悬停不高亮）；定点替换不受限（链长不变）；「修改」弹窗满 2 站禁用「添加站点」并标注上限；宿主不设链长上限，纯客户端约束 |
| DA16 | 卡槽 chip **只显示头像**：32px 圆形容器 + Avatar **26px**（各面头像 22→26、chip 高 30→32），成员名/站点序号/悬空标移入 title 悬浮提示；悬空名 chip 灰度弱化；× 改右上角 14px 角标；罗列条/领队/只读框 chip 名称照常、头像同步 26px |

改动面：`taskAssignCore.ts`（新增 `MAX_CHAIN_STATIONS=2` 与 `canAppendStation`；空白处追加
满员 → null）、`taskAssign.tsx`（容器 canDrop 收紧 + 满员态 UI + 头像-only chip）、
`tasksTab.tsx`（弹窗禁加站 + 标注上限）、`tests/taskAssign.test.ts`（满员 + canAppendStation
规则锁）。实现要点：容器 canDrop 比 chip 严一档属**安全方向**——dnd-core 按 canDrop
过滤目标集，满员时空白处无目标接受 drop（浏览器 not-allowed 光标即反馈），chip 替换
路径不受影响（docs/29 A.3.1 三轮注记）。

**三轮四绿门**：typecheck / lint / test（23 文件 292→295 用例，新增满员与 canAppendStation
锁）/ build 全绿（2026-09-05）。GUI 装机冒烟同样**未验证**（同上口径）。

## 四轮追加（2026-09-05，DA15 废止 / DA16 调整 / DA17）

**用户需求原话**：「接力链不设上限，把卡槽放到任务下面，名字和工号都显示出来」。

| 决策 | 内容 |
| --- | --- |
| DA15 废止 | 接力链**不设上限**：删除 `MAX_CHAIN_STATIONS`/`canAppendStation`，容器 canDrop 恢复对称（chip=容器=eligible），「修改」弹窗「添加站点」恢复可用 |
| DA16 调整 | 卡槽 chip 由头像-only 恢复「头像+名字」并加显**工号**（`employeeId`，`ET-0001` 格式，legacy null 不显）；头像 26px / chip 32px 保留 |
| DA17 | 卡槽从行尾移到**任务行下方独立一行**（点击不冒泡到任务行，不误触发展开抽屉）；罗列条提示文案同步「拖到小任务下方的成员卡槽」 |

改动面：`taskAssignCore.ts`（撤上限）、`taskAssign.tsx`（对称 canDrop + pill chip 显
名字/工号 + 只读框 chip 加工号 + 文案）、`tasksTab.tsx`（卡槽下置 + 弹窗恢复加站）、
`tests/taskAssign.test.ts`（撤满员/canAppendStation 锁，恢复多站追加锁，292 用例）。
drop/didDrop/shallow 嵌套机制不受卡槽位置影响；接力语义（追加/替换/移除/去重）不变。

**四轮四绿门（2026-09-05 复跑）**：typecheck / lint / test（23 文件 292 用例全过，
taskAssign 19 例）/ build（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿；
lint 仅 2 条既有 exhaustive-deps warning（memberDialog/taskDrawer，非本次引入）。
静态核对：`canAppendStation`/`MAX_CHAIN_STATIONS`/`SLOT_CHIP*` 在 src+tests 零残留。
GUI 装机冒烟持续**未验证**（同上口径）。

## 五轮追加（2026-09-05，DA18 版面微调）

**用户需求原话**：「1. 卡槽还是横向排列 2.工号放上去才展示，3.圆角只需要一点点
4.团队成员列表未启动改成工号，别ET- 就显示数字就行，然后用徽章展示。
5. 拖动tip放到下一行展示」。

| 决策 | 内容 |
| --- | --- |
| DA18 | ①卡槽容器**横向单行**：去 280px 宽上限与 flex-wrap 换行，`max-w-full flex-nowrap overflow-x-auto` 超宽横向滚动；②**工号不占版面**：站点 chip 与只读框 chip 的工号撤出版面、折叠进 title 悬浮提示（「站点 N：名字（工号，已移出）」，legacy 无工号不带括注）；③**圆角收小为 4px**：卡槽框/空框/追加提示/框内 chip `rounded-md`→`rounded-[4px]`，罗列条与领队 chip `rounded-full`→`rounded-[4px]`；④罗列条 staged 成员「未启动」小字改**工号数字徽章**（新增 `employeeBadgeOf` 剥 `ET-` 前缀只显数字，`STRIP_BADGE_CLASS` 小型徽章面；legacy null 不渲染；staged 态由状态点表达）；⑤罗列条**拖动提示独占一行**（chips 下一行，容器改两行结构） |

改动面：`taskAssignCore.ts`（新增 `employeeBadgeOf`）、`taskAssign.tsx`（横向单行 +
圆角 4px + 工号入 title + 工号徽章 + 提示独立行）、`tests/taskAssign.test.ts`（增
`employeeBadgeOf` 规则锁 3 例）。接力语义（追加/替换/移除/去重）与嵌套 drop target
机制零改动——本轮纯版面调整。验收 agent 静态核对曾报 chip 内「× 移除」按钮残留
`rounded-full`（不在决策明示面内），已顺手统一收 4px 后复跑四门。

**五轮四绿门（2026-09-05 复跑）**：typecheck / lint / test（23 文件 **295 用例**全过，
taskAssign 22 例）/ build（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿；
lint 仅 2 条既有 exhaustive-deps warning（memberDialog/taskDrawer，非本次引入）。
静态核对：`rounded-full`/`rounded-md`/`max-w-[280px]`/「未启动」渲染文本在
taskAssign.tsx 零残留；`CHIP_TAG_CLASS` 仅剩 CaptainChip「领队」徽标一处使用；
`employeeBadgeOf` core 导出 + 3 例测试锁齐备。
GUI 装机冒烟持续**未验证**（客户端为注入宿主的 CJS 包，无独立 dev server；
拖拽/悬浮提示/徽章观感需装机后在 DSH 面板人工过一遍）。

## 六轮追加（2026-09-05，DA19 链编排收进卡槽）

**用户需求原话**：「卡槽里面也可以拖动调整顺序，后面的加号点开也只显示出所有
团队成员然后多选添加就行，不再弹窗中做编排」。

| 决策 | 内容 |
| --- | --- |
| DA19 | ①卡槽内站点 chip **拖动调序**：chip 兼作拖拽源（新 item 类型 `eteams-station`），拖到另一 chip = 被拖站搬移到目标位（数组搬移，stageBrief 随站走）；自拖自放 no-op；容器只收成员类型——空白处对站点类型无落点（not-allowed 即语义）。②行尾「＋」改**多选按钮**：点开 Popover 面板列出全部团队成员（已在链中的禁用、标「已在链中」），勾选若干人按勾选顺序末尾追加（brief 空串）；空框点击/键盘 Enter/Space 同开面板。③**「修改」弹窗不再编排链**：成员槽编辑段撤除（Select 行/stageBrief 输入/添加站点钮），update 不发 `chain`（host 不改链）、create 不带 chain；弹窗保留主题/说明编辑，容器空白处与 chip 点击仍打开弹窗 |

改动面：`taskAssignCore.ts`（新增 `chainAfterReorder`/`chainAfterAppendMany`）、
`taskAssign.tsx`（站点 chip 双 ref 合一 + 拖拽半透明 + drop 按载荷分流调序/替换；
`StationPicker` 面板；空框与「＋」改道多选）、`tasksTab.tsx`（弹窗链编排段撤除，
`SlotDraft`/`editSlots`/Select/Minus/FORM_LABEL_CLASS/SELECT_NONE 依赖清理）、
`tests/taskAssign.test.ts`（reorder 5 例 + appendMany 3 例）。

实现要点：chip 的 accept 为**双类型数组** `[eteams-member, eteams-station]`（dnd-core
16 `matchesType` 对数组走 `.some` 匹配，`HandlerRegistryImpl.addTarget` `validateType(type, true)`
官方放行数组）；drop 内按 `'index' in item` 分流（station=调序、member=替换）；
容器 canDrop/accept 不含站点类型，drag 站点 chip 时容器不亮、光标 not-allowed。

**遗留（Q6，不阻塞）**：站点说明（stageBrief）随弹窗编排撤除暂无编辑入口——替换
保留原值、调序随站走、追加为空串；触屏/键盘调序通道同样暂缺（加站/移除可点）。
用户未再要求前不加 UI。

**六轮四绿门（2026-09-05）**：typecheck / lint / test（23 文件 **303 用例**全过，
taskAssign 30 例）/ build（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿；
lint 仅 2 条既有 exhaustive-deps warning（memberDialog/taskDrawer，非本次引入）。
GUI 装机冒烟持续**未验证**（同上口径——chip 拖动调序、多选面板需装机人工过）。

## 七轮追加（2026-09-05，DA20 卡片化 + 拖卡调执行顺序 + 挂靠修复）

**用户需求原话**：「1. 里面小任务做成卡片，我需要卡片也能拖拽调整执行顺序
2. 新增小任务出现到了主任务之外了 3. 主任务上面的小任务数量没有变化」。

| 决策 | 内容 |
| --- | --- |
| DA20 | ①组卡内小任务**卡片化**：行式 border-b 行改全边框卡（同组卡观感，挂靠缩进 ml-4 保留），按**执行序**展示并带序号（`executionOrderOf` 兄弟依赖拓扑序——Kahn 分层、创建序平局；外部依赖不参与兄弟排序、环防御不丢任务）。②**拖卡调执行顺序**：卡片兼作拖拽源/放置目标（新 item 类型 `eteams-subtask`，canDrop 要求双端 draft/ready 且同父兄弟），拖 A 卡到 B 卡 = A 搬到 B 的执行位（数组搬移同六轮 chip 口径）；语义落地为**兄弟依赖链改写**（`depPatchesForReorder`：第 k 位依赖第 k-1 位、外部依赖保留、只发 deps 实际变化且 draft/ready 的补丁），逐发 `updateTeamTask({dependencies})`（host wouldCycle/draft-ready 依赖闸沿用，非乐观更新）。③**挂靠丢失修复**（用户 ②③ 同根因）：面板 create 路由 `parentTaskId` 此前走 `str()` 只收字符串，客户端（api.ts）发的 JSON number 被静默丢弃 → 小任务落到**顶层**（主任务卡之外）且主任务计数恒不变；改 `readTaskIdParam`（number/数字串都收，畸形 → undefined） |

改动面：`taskAssignCore.ts`（新增 `executionOrderOf`/`depPatchesForReorder`）、
`taskAssign.tsx`（新增 `SUBTASK_DRAG_TYPE`/`SubtaskDragItem`）、`tasksTab.tsx`
（`SubtaskCard` 组件——拖拽源+放置目标+序号+半透明/ring 反馈、subs 拓扑排序、
`submitReorder` 逐发补丁 + `reorderError` 行内展示）、`webui.ts`（create 路由
`readTaskIdParam` 修复 + update 路由 `dependencies` 透传 `readDependenciesParam`
整包收紧）、`api.ts`（`updateTeamTask` 增 `dependencies?: number[]`）、
`tests/taskAssign.test.ts`（executionOrderOf 4 例 + depPatchesForReorder 5 例）、
`tests/webui.test.ts`（数字 parentTaskId 挂靠 + 依赖通道回归 1 例）。

实现要点：执行顺序的强制机制就是宿主既有 `dependencies` 物化阻塞（wait +
blockedFrom，docs/36），本轮**不新增排序通道**——「卡片拖拽」只是依赖改写的
交互皮；已领取/冻结的兄弟不改写（host 会拒），其链位滑动为已知口径（docs/29
A.3.4/A.7）；update 路由畸形依赖载荷整包视为缺省（不改字段，不半改写）。

**七轮四绿门（2026-09-05）**：typecheck / lint / test（23 文件 **313 用例**全过，
taskAssign 39 例、webui 35 例）/ build（`SMOKE OK: id=dsh-eteams,
exports=[apply, inject]`）全绿；lint 仅 2 条既有 exhaustive-deps warning
（memberDialog/taskDrawer，非本次引入）。
GUI 装机冒烟持续**未验证**（同上口径——卡片拖拽调序、序号展示、挂靠修复需
装机后在 DSH 面板人工过一遍）。

## 八轮追加（2026-09-05，DA21 任务页拆列表页 + 详情页）

**用户需求原话**：「将任务做成任务详情页面和任务列表页面，点击到详情再编排整个任务」。

| 决策 | 内容 |
| --- | --- |
| DA21 | ①**列表页精简化**：组卡只剩头部信息（#id/主题/展示态/进度/汇总 chip/文件夹）+ 小任务精简行（执行序号/#id/主题/展示态/阻塞/指派，保留 `executionOrderOf` 展示口径）；顶层任务行去掉站点行与依赖 chips；列表上**无任何编排 UI**（新增/改删/卡槽/拖拽/罗列条全撤）。②**详情页两级**：主任务详情 = 整个任务的编排面（返回条 + 头部卡 + 进度 + 新增小任务 + 小任务卡片全套（执行序号/卡槽/拖卡调序/修改删除）+ 成员罗列条单条）；任务/小任务详情 = 返回条 + 头部卡（小任务含修改/删除）+ 挂靠行 + `TaskDetailContent` 正文（合同四数组/状态说明/阻塞/产出/尝试时间线）+ 卡槽 + 站点行 + 依赖 chips + 罗列条。③**导航状态复用** ui model `drawerTaskId`（语义改为「详情页选中的任务 id」，null=列表页；选中任务被删自动回落列表）。④**原 S13 shadcn Dialog 抽屉撤除**：详情正文改内联组件 `TaskDetailContent`（track 拉取/正文渲染原样保留），标题/状态头由详情页渲染；A.5.3「每张组卡下方各一条」的罗列条 placement 随页面化废止（改详情页单条） |

改动面：`taskDrawer.tsx`（Dialog 撤除 → `TaskDetailContent` 内联组件）、`tasksTab.tsx`
（两级页面 + `dialogs` 共用弹窗 + `selectedTaskId/setSelectedTaskId` 改名 + 列表精简）、
`index.tsx`（prop 接线与注释同步）、`ui.ts`（`setDrawerTask` 注释同步）、
`taskDisplayStatus.ts`（`STATUS_LABELS` 改键序规范来源注释）。零新增纯函数、
零 store 结构变更——本轮纯客户端页面重组。

**八轮四绿门（2026-09-05）**：typecheck / lint / test（23 文件 **314 用例**全过；同工作区并行 usage 流随后加例至 315，非本轮范畴）/
build（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿；lint 仅 2 条既有
exhaustive-deps warning（memberDialog/taskDrawer，非本次引入）。
GUI 装机冒烟持续**未验证**（同上口径——两级导航/详情页编排/精简列表需装机后在
DSH 面板人工过一遍）。

## 九轮追加（2026-09-05，DA22 列表页组卡概览化）

**用户需求原话**：「团队列表不展示任务详情了，做成一个小卡片，显示任务状态就行」
（经确认实指任务列表页：「任务列表中的任务卡片不展示任务详情和整个任务列表，
需要点击进去再看到整个任务列表」）。

| 决策 | 内容 |
| --- | --- |
| DA22 | 列表页主任务卡片撤掉八轮的小任务精简行——组卡只承**状态概览**：头部（#id/主题/展示态）+ 进度计数（小任务 n/m 完成）+ 汇总 chip（ready）+ 文件夹；**整个任务列表只在主任务详情页看**（整卡点击进详情，DA21 导航口径不变）。列表组卡不再调 `executionOrderOf`（计数/汇总与顺序无关，改普通 filter）；详情页分支拓扑排序照旧 |

改动面：仅 `tasksTab.tsx`（列表 groups.map 段 + 文件头/TasksTab 注释）。零 store/host/
纯函数变更，无新增测试（无逻辑变化）。

**九轮四绿门（2026-09-05）**：typecheck / lint（0 error，2 条既有 exhaustive-deps
warning）/ test（23 文件 **315 用例**全过）/ build（`SMOKE OK: id=dsh-eteams,
exports=[apply, inject]`）全绿。GUI 装机冒烟持续**未验证**（同上口径）。

## 十轮追加（2026-09-05，DA23 小任务卡把手拖拽；含列表页误加订正）

**用户需求原话**：「团队列表左上角新增一个拖拽图标，只有拖拽图标可以拖拽」
（初读误为任务列表页主任务卡加把手，实现后用户订正「错了不是任务列表，而是
小任务列表，任务列表去掉拖拽」）。

| 决策 | 内容 |
| --- | --- |
| DA23 | ①**任务列表页无拖拽**：主任务卡保持九轮 DA22 状态概览（整卡点击进详情，展示序普通 filter 无拓扑排序），本轮初版误加的把手/调序已撤除。②**主任务详情页小任务列表**：小任务卡片**左上角新增 grip 把手**（GripVertical，'eteams-subtask' item 不变）——**只有把手是拖拽源**（dragRef 只挂把手 span，canDrag = draft/ready，不可编辑态把手淡化 opacity-40），卡身不可拖。③卡身仍兼**放置目标**（同父兄弟卡可落，悬停 ring 高亮）：拖 A 把手落 B 卡 = 调小任务执行顺序，语义与七轮 DA20 完全一致（兄弟依赖链改写补丁 `depPatchesForReorder`，非乐观更新逐发 `updateTeamTask({dependencies})`）——本轮仅把拖拽源从整卡收窄为把手。④卡身点击 = 进小任务详情页不受影响（HTML5 拖拽不触发 click） |

改动面：`tasksTab.tsx`（`SubtaskCard` 把手化——dragRef 移把手、卡身只挂
dropRef、children 包 `min-w-0 flex-1`；列表页恢复九轮状态概览无拖拽）、
`taskAssign.tsx`（拖拽类型注释更新；初版误加的 `GROUP_DRAG_TYPE`/
`GroupDragItem` 撤除）、`lucide-icon.d.ts`（GripVertical 深层导入声明）、
`tests/taskAssign.test.ts`（无新增——初版数组限定对照锁随列表拖拽撤除删除）。
零 store/host/核心纯函数变更。

**十轮四绿门（2026-09-05）**：typecheck / lint / test（23 文件 **311 用例**全过；
八/九轮时点为 315，并行 usage 流随后调整了 usage 用例数，非本轮范畴）/ build
（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿；lint 仅 2 条既有
exhaustive-deps warning（memberDialog/taskDrawer，非本次引入）。
GUI 装机冒烟持续**未验证**（同上口径——把手拖拽调序、把手不可编辑态淡化、
拖拽与卡身点击互不干扰需装机后在 DSH 面板人工过一遍）。

## 十一轮追加（2026-09-05，DA24 任务主列表平铺小卡栅格）

**用户需求原话**：「任务主列表 不分 对话任务、待指派这种。把任务主列表做成
团队那种小卡片」。

| 决策 | 内容 |
| --- | --- |
| DA24 | ①**撤分区**：「对话任务」区块与 STATUS_GROUPS 十态分区（组头/彩点/计数/精简行）全去——顶层任务不再按 kind/状态拆区块。②**平铺栅格**：团队列表同款容器（Card 面板 + 「任务 n 个」标题行 + CARD_GRID_CLASS 栅格，最小 210px 自适应列），一卡一**顶层任务**（主任务 + 顶层普通任务，快照序混排）。③**小卡三段式**（团队卡同款）：头行（#id 主题截断 + 展示态 pill，retryCount 并入）+ 身体行（主任务 = 小任务进度「x/y 完成 · n 进行中」（draft 只显个数；ready 且有明细叠加汇总 chip）；普通任务 = 指派人，无则不出；阻塞 pill 并入此行）+ 文件夹行。④卡底色/边框/悬停由 `.eteams-task-card` 样式表接管（ROLE_LIST_CSS 增别名选择器与 `.eteams-team-card` 并轨）。⑤整卡点击进详情（主任务 → 主任务详情、普通任务 → 任务详情），无拖拽（十轮 DA23 订正口径不变）；九轮 DA22 口径不变（不列小任务明细） |

改动面：`tasksTab.tsx`（列表 return 块重写——分区/组头/精简行撤除，Card 面板 +
栅格小卡；TASK_ROW_CLASS/GROUP_CARD_CLASS/dotClass/STATUS_GROUPS 消费点删除）、
`shared.tsx`（ROLE_LIST_CSS 增 `.eteams-task-card` 别名选择器 + 注释同步）、
`taskDisplayStatus.ts`（STATUS_GROUPS 注释改「无运行时渲染方的键序规范」）、
`tests/taskDisplayStatus.test.ts`（describe 题注同步）。零 store/host/纯函数变更。

**十一轮四绿门（2026-09-05）**：typecheck / lint / test（23 文件 **311 用例**全过）/
build（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿；lint 仅 2 条既有
exhaustive-deps warning（memberDialog/taskDrawer，非本次引入）。
GUI 装机冒烟持续**未验证**（同上口径——平铺栅格/小卡三段式/整卡点击进详情需
装机后在 DSH 面板人工过一遍）。

## 十二轮追加（2026-09-05，DA25 去号/文件夹可点击/加大/分行/底栏删除）

**用户需求原话**：「去掉 #1 这种，文件夹左边... 然后做成可以点击的，卡片再大
一点，分行，下面放删除按钮」；两个开放点用户续拍：文件夹点击 = 「打开任务
文件夹」（宿主拉系统文件管理器），删除按钮 = 「仅可删除的卡显示」。

| 决策 | 内容 |
| --- | --- |
| DA25 | ①**头行去 `#id` 前缀**：列表小卡只渲染主题 + 展示态 pill（详情页头部卡 #id 不动）。②**文件夹行**：去「文件夹：」标签，裸路径（`{folder}/`）渲染成可点击件（下划线 + hover 提色 + title），点击 = 新宿主路由 POST `/team/<id>/task/<taskId>/folder/open`——目录由 workspacePath + 任务 work_dir 现算（`taskDirAbs`），缺失 400、未知任务 404；打开器经 `WebSurfaceOptions.openFolder` 注入（默认按平台 spawn：win32 explorer / darwin open / 其余 xdg-open，detached + 异步错误吞掉）；失败按卡行内 FormErrorNote，成功无回执 UI（文件管理器窗口即回执）。③**卡片加大**：任务列表专用 `TASK_GRID_CLASS`（最小 260px 自适应列，不并轨 CARD_GRID_CLASS 以免牵动团队/角色列表）。④**信息分行**：进度/汇总 chip/阻塞各自独立行（不再 flex-wrap 混排）。⑤**底栏删除按钮**：border-t 分区 + destructive 描边删除钮（团队卡底栏同款），仅可删的卡渲染（`deletableOf` = 本身 draft/ready + 主任务全部小任务 draft/ready + 删除集不被未入集任务依赖——与 host `deleteTask` 守卫同口径，host 仍最终裁决、弹窗就地显示拒绝原因）；删除确认弹窗共用面扩大（列表卡主任务/顶层任务 + 详情页小任务），标题改「删除任务」、主任务追加级联提示、文案去 `#id` 前缀 |

改动面：`tasksTab.tsx`（列表小卡重排 + `deletableOf` + `folderBusy/folderError`
瞬态 + `openFolder` 提交 + 删除弹窗改共用面）、`shared.tsx`（新增
`TASK_GRID_CLASS`）、`api.ts`（新增 `openTaskFolder`）、`webui.ts`（新增
folder/open 路由 + `WebSurfaceOptions` 注入点 + `defaultOpenFolder`）、
`tests/webui.test.ts`（folder/open 路由回归 1 例：假打开器收目录、未知任务
404、目录缺失 400 且不拉打开器；团队/任务名取 ASCII——本机 Windows 对 CJK
路径 rmSync 静默不删，环境怪癖与路由逻辑无关，CJK 路径由其余用例覆盖）。

**十二轮四绿门（2026-09-05）**：typecheck / lint / test（23 文件 **312 用例**
全过）/ build（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿；lint
仅 2 条既有 exhaustive-deps warning（memberDialog/taskDrawer，非本次引入）。
GUI 装机冒烟持续**未验证**（同上口径——文件夹点击拉起资源管理器、底栏删除
显隐判据、加大栅格与分行版面需装机后在 DSH 面板人工过一遍；其中「拉起系统
文件管理器」是真实进程行为，离线测试只验证了注入路径与目录解析）。

## 十三轮追加（2026-09-05，DA26 对齐/小任务 0/目录标签/路径截断收窄）

**用户需求原话**：「任务卡片内容对齐，没有小任务就显示0，而且目录两个字没有
了，路径太长了截断大部分的」。

| 决策 | 内容 |
| --- | --- |
| DA26 | ①**内容行顶格对齐**：`BlockedPill` 不再内建 `ml-1`（ml-1 外置到 className——详情页两处行内文字流场景由调用位补 `ml-1`，列表卡独立行顶格与其它行左缘齐）；底栏 `mt-auto` 沉底——同一栅格行内内容行数不同的卡，删除栏齐平在卡底。②**每卡必有进度行**：进度行从「主任务才渲染」改为无条件渲染，行结构跨卡统一——主任务沿用 小任务 N 个（draft）/ N/M 完成 · n 进行中；无小任务的顶层普通任务显**「小任务 0」**（用户拍板「没有小任务就显示0」；有指派人追加 「 · 指派 X」）。③**「目录」标签回补**：十二轮裸路径后用户发现「目录两个字没有了」，文件夹行恢复两字标签——「目录 末段/」（`folder.split('/').pop()`），全路径进悬停 title「在文件管理器中打开：<全路径>」。④**路径截断收窄**：十二轮整条路径 truncate 截掉大部分，只显末段后不再长截断 |

改动面：`tasksTab.tsx` 单文件（`BlockedPill` className prop + 两处详情调用位、
进度行统一渲染、文件夹行目录末段、底栏 mt-auto；头注/卡片常量/区块注释同步）。
零 store/host/api/纯函数变更（312 用例）。

**十三轮四绿门（2026-09-05）**：typecheck / lint / test（23 文件 **312 用例**
全过）/ build（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿；lint
仅 2 条既有 exhaustive-deps warning（memberDialog/taskDrawer，非本次引入）。
GUI 装机冒烟持续**未验证**（同上口径——阻塞行顶格、每卡进度行含「小任务 0」、
目录末段路径、底栏沉底齐平需装机后在 DSH 面板人工过一遍）。

## 十四轮追加（2026-09-05，DA27 状态入底栏/进度三计数/工作目录钮/详情钮）

**用户需求原话**：「1. 状态挪到卡片的左边下面，圆角改成 2px  2。目录样式调整
一下，就显示工作目录就行，别显示具体路径了，别用灰色打底了不好看」；「2. 别
小任务 个了，改成 共 x 个任务，已完成 x , 未完成 x 数字用颜色标识一下」；
「3. 删除旁边加一个详情按钮」（原文两处序号重复，按语义拆四点）。

| 决策 | 内容 |
| --- | --- |
| DA27 | ①**状态 pill 挪到卡底栏左侧 + 圆角 2px**：「左边下面」按用户十二轮「下面放删除按钮」同词汇解作卡底栏——底栏改左右分栏（justify-between），左 = 展示态 pill、右 = 按钮组；头行只剩主题。「圆角改成 2px」指该状态 pill：`Pill` 增 `className` 透传、`DisplayStatusPill` 增 `pillClassName`，底栏位传 `rounded-[2px]`，其余 pill 调用位不动。②**进度行三分计数**：「共 x 个任务，已完成 x，未完成 x」统一格式（原「小任务 N 个 / N/M 完成 · n 进行中 / 小任务 N」三分支废止，「进行中」不再单列），数字着色——已完成 `text-success` 绿、未完成 `text-warning` 琥珀、总数行底灰；指派人尾注保留。③**文件夹行「工作目录」标签钮**：只留四字标签（末段路径也撤），完整路径仅存 title 悬停提示；样式去灰色弱化文案改描边小按钮（hover 淡底）。④**底栏每卡常驻 + 详情钮**：删除旁新增「详情」outline 钮（每卡都有，整卡点击的显式等价入口）；删除仍仅可删的卡渲染（deletableOf 口径不变）；底栏从仅可删的卡渲染改每卡渲染（mt-auto 对齐因此覆盖全部卡） |

改动面：`shared.tsx`（Pill 增 className 透传 + 注释）、`tasksTab.tsx`（头行
只剩主题、DisplayStatusPill 增 pillClassName、底栏重构、进度行三分计数 JSX、
文件夹行工作目录钮、注释同步）。零 store/host/api/纯函数变更（312 用例）。

**十四轮四绿门（2026-09-05）**：typecheck / lint / test（23 文件 **312 用例**
全过）/ build（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿；lint
仅 2 条既有 exhaustive-deps warning（memberDialog/taskDrawer，非本次引入）。
GUI 装机冒烟持续**未验证**（同上口径——状态 pill 入底栏与 2px 圆角、进度
数字着色、工作目录描边钮、详情钮需装机后在 DSH 面板人工过一遍）。

## 十五轮追加（2026-09-05，DA28 状态 pill 描边/工作目录幽灵钮）

**用户需求原话**：「1. 优化一下左下角状态的样式，去掉放上去变淡，加上边框」；
「2. 工作目录还是不协调，修改一下更好融入卡片」。

| 决策 | 内容 |
| --- | --- |
| DA28 | ①**底栏状态 pill 描边 + 去 hover 淡底**：加 `--border` 描边（`BORDER_L1_CLASS` 经 tailwind-merge 压过 shadcn Badge 的 `border-transparent`），并以同色 hover（`hover:bg-[color:var(--eteams-pill-bg)]`）压平 Badge 自带的悬停淡底（secondary 80% 淡化，D19c color-mix 实现）——悬停后底色不变；透传链沿用十四轮（`Pill.className` → `DisplayStatusPill.pillClassName`）。②**工作目录钮融入卡片**：十四轮的描边小按钮「还是不协调」，撤掉按钮外壳（border/底色/内边距全去），改**幽灵文字钮**——常规字色 + hover 下划线，与卡内其它文字行同权重；文案四字与完整路径 title 不变 |

改动面：`tasksTab.tsx` 单文件（底栏 pillClassName 叠描边 + 同色 hover、文件夹
行按钮 className 换幽灵文字样式、六处注释同步——文件头/DisplayStatusPill/
卡片常量/列表区块/文件夹行/底栏）。零 store/host/api/纯函数变更。

**十五轮四绿门（2026-09-05）**：typecheck / lint / test（23 文件 **314 用例**
全过——工作区另有并行新增的 rolebuilder-resume 回归 2 例，非本轮改动面）/
build（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿；lint 仅 2 条
既有 exhaustive-deps warning（memberDialog/taskDrawer，非本次引入）。
GUI 装机冒烟持续**未验证**（同上口径——状态 pill 描边与 hover 不变色、工作
目录幽灵文字钮需装机后在 DSH 面板人工过一遍）。

## 十六轮追加（2026-09-05，DA29 合同并一 MD + 小任务展开）

**用户需求原话**：「1. 任务的验收标准、范围内、交付物 改成MD渲染，然后数据库中
任务 任务的验收标准、范围内、交付物 合并为一个字段。统一用MD管理／2. 每个小任务
加上一个展开功能」。

| 决策 | 内容 |
| --- | --- |
| DA29 | ①**DB 合并**：task 表四列（acceptance/in_scope/out_of_scope/deliverables，JSON 串数组）合并为**一列 `contract_md`**（Markdown 全文）——DB_SCHEMA_VERSION 1→2；旧库迁移在 getDb 连接时做（`migrateTaskContractMd`：PRAGMA table_info 探测 → `ALTER TABLE task ADD COLUMN contract_md TEXT` + 旧四列数据经 `contractMdFromLegacyArrays` 合成回填，幂等可重入；旧四列物理残留、此后不再读写；全新库 DDL 直接新形状，迁移零操作）。②**全链路统一 MD**：内存 TaskRecord 四数组撤除改 `contractMd?: string`；领队工具 eteams_create_task/eteams_update_task 四个 strArr 参数收敛为 `contractMd` 单字符串（整篇写入/整篇替换）；renderContract（派发邮件/成员工具 claim/my_tasks 的 contract 字段）与 docs.ts contract.md `## 合同` 段透传原文；webui 快照 TaskView 与 track 路由 contract 载荷改带 contractMd；旧 team.json 导入 contractMd 直取、无则由四数组合成。③**面板 MD 渲染**：任务/小任务详情正文（TaskDetailContent）撤 ContractList 四组平文列表，改 **MarkdownText** 只读渲染（`@deepseek-ai/dsh-client-ui-primitives`，成员手册同款原语）。④**小任务展开钮**：主任务详情页小任务卡头部行尾加 ChevronDown 图标钮（有 description 或 contractMd 的卡才渲染；展开/收起互切、旋转过渡），展开区 border-t 分区就地显示**说明 + 合同 MD**（MarkdownText），展开态点击不冒泡进详情页；expandedSubIds 瞬态（多开互不影响），零 store 结构变更 |

解读（非用户原话，验收对照口径）：用户点名「验收标准、范围内、交付物」三字段，
**范围外（out_of_scope）一并合入**同一篇 MD——合同四段一体，单独留下会破
「统一用MD管理」；旧数组 → MD 的段落结构（`## 验收标准` 编号列表 / `## 允许
改动` / `## 禁止改动` / `## 交付物` 清单）由宿主合成器（model/contract.ts）定稿。

改动面：`src/host/model/contract.ts`（新，合成器）、`model/types.ts`（TaskRecord）、
`state/schema.sql` + `state/db.ts`（SCHEMA_SQL 逐字同步 + v2 迁移）、
`state/store.ts`（task 读写两端 + 删 jsonArray 助手）、`state/import.ts`（旧
team.json 导入）、`runtime/assignment.ts`（create/update 参数）、
`tools/captainTools.ts`（create/update 工具参数 + task_board 输出）、
`prompts/handoff/mails.ts`（renderContract 透传 MD）、`runtime/webui.ts`
（taskView + track contract 载荷）、`client/lib/monitor.ts`（TaskView）、
`client/pages/teamsView/taskDrawer.tsx`（ContractMd/MarkdownText）、
`client/pages/teamsView/tasksTab.tsx`（展开钮 + 展开区 + ChevronDown 深层导入）、
`tests/lifecycle.test.ts`（create 参数换 contractMd + contractMd 回读锁 1 处）。
**本轮动 DB schema（v1→v2）与领队工具入参形状**——旧装机会在首次连接时自动迁移。

**十六轮四绿门（2026-09-05）**：typecheck / lint（0 error，2 条既有
exhaustive-deps warning）/ test（23 文件 **317 用例**全过——十四…十五轮时点
314，并行流随 08bf08c「细节修复」增 webui 用例，本轮另增 v1→v2 迁移回归
1 例至 317）/ build
（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿。
GUI 装机冒烟持续**未验证**（同上口径——MD 渲染观感、小任务展开交互、旧库
迁移回填需装机后在 DSH 面板人工过一遍；其中旧库迁移由 getDb 幂等迁移承载，
tests/store.test.ts 迁移回归锁回填内容与重开幂等，tests/lifecycle.test.ts
锁新库路径 contractMd 回读）。

## 十七轮追加（2026-09-05，DA30 小任务展开 shadcn 化 + 展开内容下移卡槽下）

用户原话（十六轮追加的同日续单）：

> 小任务加上展开功能使用 https://ui.shadcn.com/ 组件来做，出现的文字会在卡槽下面

拍板（DA30）：十六轮的小任务展开交互改用 **shadcn/ui Collapsible** 组件实现；
展开出现的文字渲染在**成员卡槽下面**。

| 项 | 拍板 |
| --- | --- |
| 展开交互组件 | shadcn/ui Collapsible——新 vendoring `src/client/components/ui/collapsible.tsx`（Radix `@radix-ui/react-collapsible` 的 Root/Trigger/Content 直出，dialog/popover 同款手动 vendoring 惯例）；`package.json` devDependencies 增 `@radix-ui/react-collapsible@^1.1.20`（tsdown 照常打包进 client envelope，external 清单不含 radix） |
| 卡身结构 | 小任务卡身包一层 `Collapsible`（受控 `open` 仍由 expandedSubIds 瞬态多开驱动，`onOpenChange` 回写；十六轮手写 toggleSub 删除）；卡头行展开钮改 `CollapsibleTrigger asChild` 包原 ChevronDown 钮；expandable 判据（有说明或合同 MD 才渲染触发钮）、箭头 rotate-180、点击 stopPropagation 防误进详情页保持 |
| 展开内容位置 | 十六轮展开区在「卡头行 ↔ 成员卡槽」之间；本轮 `CollapsibleContent` 挪到**成员卡槽（TaskAssignDropBox）+ 站点行（TaskStations）之后**、卡内最底——用户拍板「出现的文字会在卡槽下面」。内容本体不变：说明行 + 合同 MD（MarkdownDoc 只读渲染）+ border-t 分区 |

改动面：`src/client/components/ui/collapsible.tsx`（新）、`package.json` +
`pnpm-lock.yaml`（新依赖）、`src/client/pages/teamsView/tasksTab.tsx`（Collapsible
包裹 + 触发钮/内容件替换 + 展开内容下移）。零 host/store/纯函数变更——本轮
纯 client 交互件替换与布局调整。

**十七轮四绿门（2026-09-05）**：typecheck / lint（0 error，2 条既有
exhaustive-deps warning：memberDialog.tsx:38 / taskDrawer.tsx:117）/ test
（23 文件 **317 用例**全过，用例数与十六轮持平——纯交互件替换无新测试面）/
build（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿。
GUI 装机冒烟持续**未验证**（Radix Collapsible 的展开/收起交互、展开内容
「卡槽下面」的观感需装机后在 DSH 面板人工过一遍）。

## 十九轮追加（2026-09-05，DA32 小任务展开钮最右侧 + hover 底色压平）

用户原话：

> 小任务 展开按钮放到最右侧，不要这个背景色

背景：十七轮（DA30）以 shadcn Collapsible 落地展开后，并行流的组件目录批次
（docs/43）又把展开机制升级为 shadcn Accordion（十八轮 DA31——逐卡 Collapsible
撤除，`<Accordion type="multiple">` 受控多开 + AccordionItem/AccordionTrigger/
AccordionContent，触发钮包 ghost 图标 Button + Hint 悬浮提示；该轮随 docs/43
批次落地，本文与 docs/29 已回补决策行）。本轮在此基础上继续两处修订。

| 项 | 拍板 |
| --- | --- |
| 展开钮位置 | 从按钮组首位挪到**最右侧**（修改→删除→⌄；用户拍板「放到最右侧」；不可编辑卡无修改/删除时展开钮本就独居右端，观感一致） |
| 背景色 | ghost 变体图标 Button 的悬停底色 `hover:bg-accent` 即用户所指背景色——`className` 叠 `hover:bg-transparent` 经 tailwind-merge 压平，悬停只剩字色 muted→foreground 变化、无底色块（用户拍板「不要这个背景色」） |

改动面：`src/client/pages/teamsView/tasksTab.tsx`（触发钮 JSX 挪位 + className）。
零 host/store/纯函数变更；十八轮 DA31 为并行流批次（四绿门随该批次记录）。

**十九轮四绿门（2026-09-05）**：typecheck / lint（0 error，2 条既有
exhaustive-deps warning：memberDialog.tsx:38 / taskDrawer.tsx:117）/ test
（23 文件 **317 用例**全过，用例数持平）/ build
（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿。
GUI 装机冒烟持续**未验证**（展开钮最右位观感、悬停无底色需装机后在 DSH
面板人工过一遍）。

## 二十轮追加（2026-09-05，DA33 主任务详情页头部卡收三件 + 「任务列表」节标题）

用户原话：

> 任务详情页面把团队成员放到上面去和任务标题放一起，下面的小任务也改成 和任务卡片一样 共 x 个任务 已完成 未完成。然后卡片下面加标题  任务列表

背景：本轮只动**主任务（group）详情页**（即有团队成员条与小任务列表的页面）。
三处拍板逐条落地：

| 项 | 拍板 |
| --- | --- |
| 团队成员位置 | 罗列条（TeamMemberStrip，自带 border-t 分区）从页面底部上移进**头部卡**，与任务标题同卡——`detailHeader` 增 optional `extra` 槽（渲染在文件夹行后）；仍是小任务卡槽的拖拽源，渲染判据不变（存在 draft/ready 小任务才渲染）；任务/小任务详情页不传 extra，保持原观感 |
| 小任务进度显示 | 原头部卡外「· 小任务 n/m 完成」行（含 draft 特例）撤除，改任务列表卡（DA27）同款三计数行「共 x 个任务，已完成 x，未完成 x」，收进头部卡内（进度行本就说小任务，与列表卡结构同构），数字着色 success/warning；汇总 chip（B.2 判据：ready 且有小任务）随行入卡 |
| 节标题 | 头部卡与「＋ 新增小任务」按钮之间插「任务列表」节标题（LIST_TITLE_CLASS 字号，列表页「任务」表头同款），小任务编排区从此有节名 |

改动面：`src/client/pages/teamsView/tasksTab.tsx`（detailHeader 增 extra 槽、
主任务详情页 return 块重排、页面底部 detailStrip 调用位删除、节标题插入）。
小任务卡（展开/卡槽/把手）与任务/小任务详情页均未动。零 host/store/纯函数变更。

**二十轮四绿门（2026-09-05）**：typecheck / lint（0 error，2 条既有
exhaustive-deps warning：memberDialog.tsx:38 / taskDrawer.tsx:117）/ test
（23 文件 **317 用例**全过，用例数持平）/ build
（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿。
GUI 装机冒烟持续**未验证**（罗列条入卡后的头部卡观感、三计数行、节标题
位置需装机后在 DSH 面板人工过一遍）。

## 二十一轮追加（2026-09-05，DA34 「任务列表」标题行新增钮靠右 + 小任务卡撤缩进）

用户原话：

> 任务列表右侧是新增任务，下面的任务列表左边不留空隙

背景：二十轮 DA33 在主任务详情页加了「任务列表」节标题后，本轮两处版式
修订：

| 项 | 拍板 |
| --- | --- |
| 新增任务位置 | 「任务列表」标题与「＋ 新增小任务」钮合并为一行——标题居左（LIST_TITLE_CLASS 自带 flex-1 占满）、钮靠右同排（列表页「任务 n 个」表头行同构；钮的独立 mt-1.5 撤除，行整体 mt-1.5） |
| 列表左空隙 | 小任务卡 SUBTASK_CARD_CLASS 撤七轮 DA20 的挂靠缩进 `ml-4`（mt-1.5 卡间距保留）——卡片化后小任务卡已不在组卡内嵌套，缩进无嵌套语义；卡与头部卡/标题左缘齐平；组内改删错误行（FormErrorNote）随卡对齐同步撤 ml-4 |

改动面：`src/client/pages/teamsView/tasksTab.tsx`（标题行 flex 重排 +
SUBTASK_CARD_CLASS 撤 ml-4 + 改删错误行撤 ml-4）。任务/小任务详情页未动。
零 host/store/纯函数变更。

**二十一轮四绿门（2026-09-05）**：typecheck / lint（0 error，2 条既有
exhaustive-deps warning：memberDialog.tsx:38 / taskDrawer.tsx:117）/ test
（23 文件 **317 用例**全过，用例数持平）/ build
（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿。
GUI 装机冒烟持续**未验证**（标题行同排观感、卡左缘齐平需装机后在 DSH
面板人工过一遍）。

## 二十二轮追加（2026-09-05，DA35 多选面板标题简化 + 链中成员不进列表）

用户原话：

> 选择成员，追加为接力站点   去掉 追加为接力站点，而且已经选中的成员不出现在列表中

背景：小任务卡槽行尾「＋」点开的成员多选面板（StationPicker，六轮 DA19
引入），本轮两处修订：

| 项 | 拍板 |
| --- | --- |
| 标题 | 面板头行「选择成员，追加为接力站点」简化为「选择成员」（用户拍板去掉「追加为接力站点」） |
| 链中成员 | 已在接力链中的成员**不再出现在列表**（`members.filter` 滤除，不渲染）——原「禁用 + opacity-50 + 『已在链中』标」废弃；全部在链中时显「暂无可选成员」；`chainAfterAppendMany` 纯函数去重守卫不变（兜底） |

改动面：`src/client/features/tasks/taskAssign.tsx`（StationPicker 头行文案 +
列表过滤 + 死分支删除 + 文件头注释）。确认钮/勾选序追加语义不变。
零 host/store/纯函数变更。

**二十二轮四绿门（2026-09-05）**：typecheck / lint（0 error，2 条既有
exhaustive-deps warning：memberDialog.tsx:38 / taskDrawer.tsx:117）/ test
（23 文件 **317 用例**全过，用例数持平）/ build
（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿。
GUI 装机冒烟持续**未验证**（面板新标题、链中成员隐藏需装机后在 DSH
面板人工过一遍）。

## 二十三轮追加（2026-09-05，DA36 确认钮文案 + 拖拽高亮修复 + 头像描边 + 罗列条卡下方左竖线）

用户原话：

> 1. 添加站点改成添加成员 2.列表顶左边导致拖拽时高亮显示被遮挡了 3. 任务中的成员头像加上border 4.拖到本卡小任务下方的成员卡槽完成指派 修改为 拖拽成员到下方的成员卡槽完成指派，且不放到卡片里面，放到卡片下面，左边用小竖线标识为提示

| 项 | 拍板 |
| --- | --- |
| 确认钮文案 | StationPicker 确认钮「添加站点 / 添加 N 站」→「添加成员 / 添加 N 个成员」 |
| 拖拽高亮 | 两处修复：①容器悬停底原为中性 pill 色——与卡槽 chip 底**同色**，chip 列表顶满时高亮看不出，改 color-mix 品牌淡底（primary 12%）；②chip 悬停 brand 环画在**外缘**，滚动容器（overflow-x-auto）滚动态会裁掉外缘环（chip 列表顶到左边时尤甚），加 `ring-inset` 画进 chip 内缘——滚动容器裁不掉 |
| 头像描边 | Avatar 增 optional `className` 透传；任务区 5 处（罗列条成员/领队/多选面板行/卡槽站点 chip/只读框单站）加 1px `--border` 细线；其它表面（成员库等）不传零变化 |
| 罗列条版式 | 移出头部卡（二十轮 DA33 曾入卡），置**头部卡下方**独立提示块——根容器去 border-t 改 `border-l-2` 左小竖线 + pl-3 缩进；提示文案与罗列条 chip 悬浮提示统一改「拖拽成员到下方的成员卡槽完成指派」；渲染判据（存在 draft/ready 小任务）与拖拽源不变 |

改动面：`src/client/features/tasks/taskAssign.tsx`（确认钮/高亮类/头像描边/
罗列条）、`src/client/features/avatar/avatar.tsx`（className 透传）、
`src/client/pages/teamsView/tasksTab.tsx`（罗列条移出卡置卡下方）。
零 host/store/纯函数变更。

**二十三轮四绿门（2026-09-05）**：typecheck / lint（0 error，2 条既有
exhaustive-deps warning：memberDialog.tsx:38 / taskDrawer.tsx:117）/ test
（23 文件 **317 用例**全过，用例数持平）/ build
（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿。
GUI 装机冒烟持续**未验证**（高亮可见性、头像描边、罗列条左竖线观感需装机
后在 DSH 面板人工过一遍）。

## 二十四轮追加（2026-09-05，DA37 罗列条回卡只留 chips 行 + 小任务卡「开始」钮 + 展示文案合并「待开始」）

用户原话：

> 1. 不对，团队成员还是在卡片内，只是拖拽成员到下方的成员卡槽完成指派不在 2. 卡片加上开始按钮 3. 没有什么草稿状态、待指派状态，只有待开始状态。如果有任务没有成员，则提示需要选择成员就行

背景：二十四轮对二十三轮 DA36 做订正（整条罗列条移出卡是过度移动），并新增
面板「开始」派发通道与展示文案合并：

| 项 | 拍板 |
| --- | --- |
| 罗列条回卡 | `TeamMemberStrip` 恢复 border-t 分区形态放回头部卡 `extra` 槽（二十轮 DA33 形态），**只留 chips 行**（「团队成员」标签 + 领队 chip + 成员 chips）；提示文案拆出为独立组件 `StripAssignHint`（border-l-2 左小竖线 + pl-3，渲染在**头部卡下方**、与罗列条同判据）——「团队成员还是在卡片内，只是拖拽成员到下方的成员卡槽完成指派不在」 |
| 「开始」按钮 | ready 小任务卡按钮簇与小任务详情页按钮行新增「开始」钮（`ready && chain.length > 0` 才渲染）：点击 = 新宿主路由 POST `/team/<id>/task/<taskId>/start`，宿主取 `task.chain[chainCursor + 1]` 复用 `assignTask` 派发核派发下一站（成员未起会话自动起会话）；ready 但链空的卡不渲染按钮、改显灰字「需要选择成员」；宿主空链 400 兜底同文案、链到末站 400 「任务 #N 执行链已到末站，无下一站可派发」；依赖未满足/成员忙碌/领队不在线照宿主原文 400 透出 |
| 展示文案合并 | draft/ready 展示文案合并为「待开始」：STATUS_LABELS.draft/ready、DISPLAY_STATUS_TABLE（draft muted→info 与 ready 同 tone）、groupDisplayOf 兜底 chip「待指派」→「待开始」；**底层 10 态状态机不动**（draft 仍是组拆解中、ready 仍是就绪待派，仅展示层合并）；「需要选择成员」是指派提示不是状态（不设状态，空槽即提示面） |

改动面：`src/client/features/tasks/taskAssign.tsx`（Strip 回卡只留 chips 行 +
StripAssignHint 拆出）、`src/client/pages/teamsView/tasksTab.tsx`（罗列条/提示
块渲染、submitStart + startBusy/startError、开始/需要选择成员按钮簇、详情页
按钮行）、`src/client/features/tasks/taskDisplayStatus.ts`（三处文案合并）、
`src/client/lib/api.ts`（startTeamTask）、`src/host/runtime/webui.ts`（start
路由）、`tests/taskDisplayStatus.test.ts` + `tests/webui.test.ts`（文案锁 +
start 路由回归 1 例）。任务列表页卡片**未加**开始钮（开始从详情发起，列表卡
保持只读概览——九轮 DA22 口径）。

**二十四轮四绿门（2026-09-05）**：typecheck / lint（0 error，2 条既有
exhaustive-deps warning：memberDialog.tsx:38 / taskDrawer.tsx:117）/ test
（23 文件 **322 用例**全过——基线 321 含用户提交 5b3f539 并行批次新增
4 例，本轮 +1）/ build
（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿。
GUI 装机冒烟持续**未验证**（罗列条回卡、卡下提示块、开始按钮、待开始 pill
需装机后在 DSH 面板人工过一遍）。

## 二十五轮追加（2026-09-05，DA38：主任务整体开始 + 无领队主会话锚点 + 竖线显眼 + 卡身点击撤除 + 弹窗收起修复）

用户原话：

> 1. 主任务需要加开始按钮，不然整个怎么启动，主任务启动就代表着小任务需要逐个开始执行了
> 2. 需要判断团队是否含有领队，如果没有领队，主会话窗口就是领队，如果有领队，则从领队开始正式开始执行任务
> 3. 拖拽成员到下方的成员卡槽完成指派 左侧的竖线改得显眼一点
> 4. 小任务不需要再点击进入任务详情了，然后点击小任务里面的选择成员弹出弹窗后点击小任务空白地方弹窗没有消失

背景：二十四轮 DA37 给了单个小任务「开始」按钮，但主任务（容器）没有整体
启动入口；领队移出后的派发锚点无兜底；指派提示块左竖线太淡；小任务卡身
点击进详情的口径该收；多选面板点空白不消失是交互 bug。本轮四项一并处理：

| 项 | 拍板 |
| --- | --- |
| 主任务整体开始 | 主任务详情页「任务列表」标题行加主「开始」钮（ready 且有小任务才渲染）；新宿主 `startGroupTask` 逐卡独立走 `assignTask` 派发核——无链（「需要选择成员」）/链到末站/依赖未满/占用/起会话失败的卡**跳过并回传原因**（200 `{ok, started, skipped}`），不拖累其余；面板行内就地提示（全跳过列原因清单、部分成功带「已开始 N 个小任务，M 个未开始」计数）；单任务路径响应兼容（started=1、skipped 恒空，行为不变） |
| 无领队锚点 | `captainFor`：有领队（行在且未移出）→ 领队主会话锚点（**从领队开始**，主会话不在册 = undefined 不退化）；无领队（行缺失/已移出）→ **主会话窗口就是领队**——领队行原 main_session_id 的会话仍在册先用（setLeaderRemoved 不改锚点、零迁移），再退化客户端活跃会话心跳（POST /presence，60s 内有效）；锚点会话与领队行不一致时 `ensureSpawned` 先**重锚领队行**（内存快照改、随本次派发写事务落库——成员子代理父会话校验 installMemberRuntime 按领队行判父）；两锚都不在册报错（文案改「领队/主会话窗口不在线」） |
| 竖线显眼 | `StripAssignHint` 左竖线 `border-l-2` + 中性 token 线改 **`border-l-4` + 品牌色实线**（border-primary，与卡槽高亮同系）；文案/pl-3/渲染判据不变 |
| 卡身点击撤除 | 小任务卡整卡点击 = 进详情的口径**废止**（用户拍板「小任务不需要再点击进入任务详情了」）：去 cursor-pointer、去 onOpen/onClick，卡身只承担把手拖拽放置目标；按钮簇/卡槽行/展开区三处防冒泡包装层随之清理——**小任务详情页自此无组卡入口**（页面保留，仍服务顶层普通任务；属用户拍板的直接后果，非遗漏） |
| 弹窗收起修复 | 根因（读 Radix 1.1.23 源码实锤）：Popover 外出点击关闭是 **click 期 deferred**（`deferPointerDownOutside: true`），click 的 `stopPropagation` 拦断 document 冒泡相监听后，deferred 关闭被判「已拦截」而**抑制**——卡内所有防冒泡点击都会触发。修复：空链卡槽锚面与「＋」钮改 **onPointerDown 翻转开合**（按下即翻转、click 只拦冒泡，开合不再依赖 Radix deferred 关闭）；有链容器空白处点击**显式收起**弹窗再开「修改」；包装层撤除后其余区域恢复原生冒泡（Radix 正常关闭） |

改动面：`src/client/features/tasks/taskAssign.tsx`（竖线 + 锚面 pointerdown
翻转 + 容器显式收起）、`src/client/pages/teamsView/tasksTab.tsx`（卡身点击
撤除 + 包装层清理 + 主任务开始钮 + submitStart 吃 `{started, skipped}`）、
`src/client/lib/api.ts`（startTeamTask 返回 payload + GroupStartSkipped）、
`src/host/runtime/assignment.ts`（startGroupTask + captainFor 无领队锚点 +
ensureSpawned 重锚与报错文案）、`src/host/runtime/webui.ts`（start 路由主任务
分支）、`tests/webui.test.ts`（+2：整体开始混合小任务、无领队心跳锚点；
harness 暴露 captains Map）。任务列表页卡片未动（概览只读，九轮 DA22）。

**二十五轮四绿门（2026-09-05）**：typecheck / lint（0 error，2 条既有
exhaustive-deps warning：memberDialog.tsx:38 / taskDrawer.tsx:117）/ test
（23 文件 **324 用例**全过——基线 322 + 本轮 2）/ build
（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿。
GUI 装机冒烟持续**未验证**（主任务开始钮、竖线显眼、卡身点击撤除、弹窗
收起、无领队派发需装机后在 DSH 面板人工过一遍）。

## 二十六轮追加（2026-09-05，DA39：锚面开合改回 click 期 + 列表页主任务卡「开始」钮）

用户原话：

> 1. 现在小任务里面的选择成员弹出弹窗后马上就消失了
> 2. 主任务需要加开始按钮，没看到加在那里

背景：二十五轮 DA38 的两处口径装机后不达预期——①多选弹窗一开就收（回归）；
②整体「开始」钮只加在详情页标题行，用户在任务列表页没看到。本轮两项订正：

| 项 | 拍板 |
| --- | --- |
| 弹窗一开即收回归修复 | DA38 把锚面（空链卡槽/「＋」钮）开合改到 onPointerDown 是**改过头**：pointerdown 开合让刚挂载的 Radix 外出监听撞上同一交互的尾巴——焦点默认动作落在 portal 内容之外的锚面上，Radix **focusin 外出关闭路径**（读 installed 1.1.19 dismissable-layer + 1.1.23 popover 源码实锤：NonModal 的防 focusin 关闭仅在有 pointerdown-outside 前置时生效，开锚面时该前置不存在）立即触发 onDismiss。订正：锚面开合**改回 click 期翻转**（onClick 内 stopPropagation + `pickerOpen ? 关 : 开`）——click 开合在整个交互结束后才挂外出监听，同交互不再自伤；点锚面收起由本处显式翻转承担（不依赖 deferred 关闭）；**空白处收起不受影响**——那半由 DA38 的防冒泡包装层撤除 + 原生冒泡 + Radix deferred click 关闭承载，与锚面开合是两条独立路径 |
| 列表页主任务卡「开始」钮 | DA38 只加在主任务详情页「任务列表」标题行，任务列表页没有。订正：列表卡**底栏钮区首位**加「开始」实底主钮——判据与详情页标题行同（`kind === 'group' && status === 'ready' && subs.length > 0`），点击走同一路由逐个派发 ready 小任务（host startGroupTask，跳过卡回传原因）；startError 槽按卡行内就地提示（folderError 行之后）；底栏容器既有 stopPropagation 保证不触发整卡进详情；详情页标题行的整体开始钮保留 |

改动面：`src/client/features/tasks/taskAssign.tsx`（两处锚面 onPointerDown 撤除、
开合改回 onClick 翻转 + 文件头/A.5 口径注记）、`src/client/pages/teamsView/
tasksTab.tsx`（列表卡底栏「开始」钮 + startError 行内槽 + 文件头注记）。
无新增用例（交互行为修复——Radix 外出关闭与焦点时序无法在 node 端 harness
断言，装机冒烟口径）；四绿门复跑全绿（324 用例，与二十五轮持平）。

**二十六轮四绿门（2026-09-05）**：typecheck / lint（0 error，2 条既有
exhaustive-deps warning：memberDialog.tsx:38 / taskDrawer.tsx:117）/ test
（23 文件 **324 用例**全过，与二十五轮持平）/ build（`SMOKE OK: id=dsh-eteams,
exports=[apply, inject]`）全绿。
GUI 装机冒烟持续**未验证**（弹窗开合点锚面/点空白、列表卡开始钮需装机后在
DSH 面板人工过一遍）。

## 二十七轮追加（2026-09-05，DA40：整体开始链式接力 + 领队锚点统一 + 开始钮判据放宽）

用户原话：

> 还是没看到开始按钮， 1. 整体开始，所有小任务链式执行          2.不存在领队会话离线啊  3.不需要小任务详情啊，任务详情页面不就能看到所有小任务的状态信息了吗？

背景：连续三轮「没看到/还是没看到开始按钮」——列表卡判据是 `status === 'ready'`
等值；本轮判据放宽兜底（正常执行期组恒 ready，最大嫌疑仍是客户端构建包未
更新，装机后请重启 DSH 让插件重注入）。三项拍板：

| 项 | 拍板 |
| --- | --- |
| 整体开始 = 链式接力 | DA38 的整体开始是「一次性派发全部 ready 小任务」（依赖未满的被拒跳过），与用户口径「逐个开始执行（DA38）/链式执行（DA40）」不符。订正：按组内执行序（新宿主 `subExecutionOrder`：兄弟依赖拓扑序、同层建序稳定、组外依赖不算排序约束）**一次只发第一棒**，余下 ready 卡以「等待链式接力（前一小任务完成后自动开始）」记入 skipped（行内提示说明排队）；小任务**终站收口即自动交棒**（`completeTask` 尾以完成成员名义续派下一棒；组已收口免调用、失败仅记日志不吞完成应答）；终态组（completed/cancelled）整体开始直接 400；**建卡路由补收 `dependencies`**（面板建卡此前不收依赖——依赖只能靠拖拽调序补写，create 路由与 update 对齐） |
| 不存在领队会话离线 | 用户拍板「不存在领队会话离线啊」——撤掉 DA38「有领队就硬绑领队会话（不在册 = 报错不退化）」分支：`captainFor` 统一条梯度 = 领队行登记主会话在册先用 → 心跳（POST /presence，60s）定位 → 都不在册才报错；报错文案改「主会话窗口不在线」，不再有「领队会话离线」这个独立报错态。重锚领队行逻辑不变（锚点会话 ≠ 领队行登记时改锚、随派发写事务落库） |
| 不需要小任务详情 | 用户拍板「任务详情页面不就能看到所有小任务的状态信息了吗？」——确认 DA38 后小任务详情入口已全无（列表卡进详情仅顶层任务、小任务卡身无点击），主任务详情页即小任务状态总览；顶层普通任务的「详情」钮保留。本条无代码变更，仅口径确认 |
| 开始钮判据放宽 | 用户「还是没看到开始按钮」：列表卡与详情页标题行判据由 `status === 'ready'` 放宽为**非终态组**（completed/cancelled 外）即渲染——ready 等值判据在组状态被旁路转移时会把钮藏掉，终态才收（纯兜底） |

改动面：`src/host/runtime/assignment.ts`（subExecutionOrder + startGroupTask
链式接力/终态守卫 + completeTask 尾续派 + captainFor 统一梯度 + ensureSpawned
报错文案）、`src/host/runtime/webui.ts`（建卡路由补收 dependencies）、
`src/client/pages/teamsView/tasksTab.tsx`（两处开始钮判据放宽 + 文件头注记）、
`tests/webui.test.ts`（+3：链式接力、终态组 400、领队在册会话下线心跳兜底）。

**二十七轮四绿门（2026-09-05）**：typecheck / lint（0 error，2 条既有
exhaustive-deps warning：memberDialog.tsx:38 / taskDrawer.tsx:117）/ test
（23 文件 **327 用例**全过——基线 324 + 本轮 3）/ build
（`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`）全绿。
GUI 装机冒烟持续**未验证**（链式接力交棒、开始钮显示需装机后在 DSH 面板
人工过一遍；请重启 DSH 载入最新构建包后再验「开始」钮）。
