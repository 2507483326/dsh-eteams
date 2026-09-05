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