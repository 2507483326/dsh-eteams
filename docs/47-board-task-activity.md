# 47 看板 · 任务动态（任务卡片 + 小任务窗口）

> 用户需求原话：「团队看板页面新增任务动态，将当前的任务卡片显示出来，并把小任务显示出来，最多显示4个小任务。」
> 本文是**设计文档**（不含实现）：在看板页新增「任务动态」分区——当前团队的顶层任务平铺成小卡（任务列表页同栅格、同卡面观感的只读轻量版），主任务卡内嵌小任务窗口（按执行序最多 4 行，超出折叠「还有 n 个小任务」）。所有论断落到 `文件:行号` 证据。
> **审核修订（2026-09-06）**：审核 agent 核对 E1–E12 全部命中、可行性通过；本版收编审核发现——pill 族落点定案为纯移动 shared/components（DB10）、底栏/行头 pill 补 retryCount、小任务行指派补 null 守卫（P2）、汇总 chip 与阻塞行进卡（P3）、boardPage 模块头注释枚举同步（P3）。

## 47.1 目标与非目标

目标：

1. 看板页（`/board`，BoardTab）在 Token 消耗日历之后、「最近动态」之前新增「任务动态」Card 分区，展示**当前团队快照里的全部顶层任务**（主任务 + 顶层普通任务，快照序）。
2. 每张任务卡：主题 + 进度行（主任务）/指派行（顶层普通任务）+ 小任务窗口 + 底栏展示态 pill；**整卡点击**进 `/tasks/:taskId`（主任务 → 主任务详情、顶层普通任务 → 任务详情）。
3. 小任务窗口 = 该主任务的小任务按**执行序**（`executionOrderOf` 拓扑序，与详情页同款）**最多 4 行**：状态 pill + 序号 + 主题 + 指派灰注；超出渲染「还有 n 个小任务」灰字行。
4. 抽纯函数 `subtaskWindowOf` 供单测锁定「最多 4 个」口径（窗口大小/执行序由调用方排入/溢出计数/空集）。
5. pill 族（DisplayStatusPill/TaskStatusPill/BlockedPill/GroupSummaryChip）纯移动到 `pages/shared/components.tsx`（DB10，跨域复用归 components/ 的既定落点规则），tasks 域 4 个消费位改导入、零行为变更。

非目标：

1. 卡片上**不提供任何操作入口**（无开始/删除/详情钮、无拖拽、无文件夹行、无错误槽）——操作面仍在任务列表页/详情页；看板卡是只读概览。
2. 不改任务列表页——`taskListCard` 沿用九轮 DA22「列表卡不列小任务明细」口径不动；小任务窗口是看板分区专属呈现。
3. 不新增宿主路由/接口——数据全部来自既有 1s 轮询快照（`team.tasks`）。
4. **不过滤任务状态**（已完成/已取消的卡同样显示）——「当前的任务卡片」取字面义：当前快照里的任务卡片，与任务列表页同集合（证据 E3）；若后续要「仅进行中」只是加一道 filter（见 47.6 开放点）。
5. 小任务窗口**不提供展开**（看板是概览，完整列表在主任务详情页）。

## 47.2 证据基线（读码结论）

| # | 事实 | 证据 |
| --- | --- | --- |
| E1 | 看板页结构：待决策 Alert → UsageCalendarCard（置顶日历）→ 最近动态 Card；空态用 muted 行「暂无事件」（分区常驻渲染）；模块头注释枚举了分区构成（改后需同步） | [boardPage.tsx](../src/client/pages/board/boardPage.tsx):1-13、91-133（空态行 127、标题行 113） |
| E2 | `TeamSnapshot.tasks` 是全量任务行（含 `kind/parentId/status/assignee/dependencies`），1s 轮询整包替换 | [monitor.ts](../src/client/lib/monitor.ts):142-159（tasks 字段 150）、77-112（TaskView） |
| E3 | 顶层任务口径 = `parentId === null`（主任务 + 顶层普通任务混排，快照序），任务列表页同款过滤 | [tasksPage.tsx](../src/client/pages/tasks/tasksPage.tsx):190 |
| E4 | 组卡小任务取法 = `allTasks.filter(s => s.parentId === task.taskId)`；进度三分计数「共 x 个任务，已完成 x，未完成 x」数字着色 success/warning | [taskListCard.tsx](../src/client/pages/tasks/taskListCard.tsx):79-97 |
| E5 | 小任务按**执行序**展示是详情页既有口径（兄弟依赖拓扑序，创建序平局）；`executionOrderOf` 纯函数，环/悬空防御兜底输入序 | [taskDetailPage.tsx](../src/client/pages/tasks/taskDetailPage.tsx):411-412；[taskAssignCore.ts](../src/client/features/tasks/taskAssignCore.ts):178-204 |
| E6 | 展示态派生 `displayStatusOf(status, retryCount)`，retryCount>0 并出「重试 n」detail；状态 pill 统一封装 `TaskStatusPill`（`STATUS_PILL_CLASS` = rounded-[2px] + --border 描边 + hover 淡底压平） | [taskDisplayStatus.ts](../src/client/features/tasks/taskDisplayStatus.ts):131-138；[taskPills.tsx](../src/client/pages/tasks/taskPills.tsx):51-68；[styles.ts](../src/client/pages/shared/styles.ts):61-63 |
| E7 | 任务卡栅格 `TASK_GRID_CLASS`（min 260px 自适应列）；卡面板 `PANEL_CARD_CLASS`；标题行 `LIST_TITLE_CLASS` + `LIST_COUNT_CLASS`（容器 `mb-2.5 flex items-center gap-2`，tasksPage:200-202 同款）；次级文字 `MUTED_CLASS` | [styles.ts](../src/client/pages/shared/styles.ts):118-121、91-96、103-107、70-72 |
| E8 | 任务卡面/边框/悬停由注入样式表 `.eteams-task-card` 接管（与团队卡 `.eteams-team-card` 并轨） | [styles.ts](../src/client/pages/shared/styles.ts):143-144 |
| E9 | 整卡点击进详情的导航口径：`/tasks/:taskId` 路由段即选中任务 id，routes.tsx 的 location sync 回写 `drawerTaskId` | [routes.tsx](../src/client/pages/teamsView/routes.tsx):131-141、232-239 |
| E10 | 小任务行头既有样式模式：状态 pill（retryCount 随传）→ 序号灰字 → 主题 → 指派灰注，**指派有 null 守卫**；列表卡有独立阻塞行（`task.blocked && <BlockedPill/>`） | [taskSubtaskItem.tsx](../src/client/pages/tasks/taskSubtaskItem.tsx):185-197；[taskListCard.tsx](../src/client/pages/tasks/taskListCard.tsx):110 |
| E11 | BoardTab 仅 routes.tsx 消费（两处，均在 MemoryRouter 树内），`useNavigate` 可直接用；面板无 React 渲染测试基建（测试只锁纯函数，`deletableOf` 先例） | [routes.tsx](../src/client/pages/teamsView/routes.tsx):147-154、257-265；[taskListCard.test.ts](../tests/taskListCard.test.ts):14 |
| E12 | 组卡汇总 chip 判据 = ready 且有小任务（`groupDisplayOf(subs) !== null`，全 done 返回 null）；详情页 chip 与逐行小任务明细**同屏并存**——chip 不是「不列明细」专属件，是状态聚合件（隐藏异常的唯一载体） | [taskListCard.tsx](../src/client/pages/tasks/taskListCard.tsx):81-84、109；[taskDetailPage.tsx](../src/client/pages/tasks/taskDetailPage.tsx):448；[taskDisplayStatus.ts](../src/client/features/tasks/taskDisplayStatus.ts):181-204 |
| E13 | 跨域复用落点规则：跨 tab/跨域复用的小组件归 `pages/shared/`（Pill/FormErrorNote/PageHeader 先例）；pill 族现居 `pages/tasks/taskPills.tsx`，消费位 4 个 tasks 域文件 | [components.tsx](../src/client/pages/shared/components.tsx):1-14；[taskPills.tsx](../src/client/pages/tasks/taskPills.tsx)（消费位：taskListCard:17、taskSubtaskItem:32、taskHeaderCard:16、taskDetailPage:60） |
| E14 | `styles.ts` 已有同名异值 `TASK_CARD_CLASS`（小任务卡面 rounded-[8px] 档）——看板卡类常量**不得复用该名** | [styles.ts](../src/client/pages/shared/styles.ts):87-89 |

## 47.3 设计决策

| # | 决策 | 理由 |
| --- | --- | --- |
| DB1 | 分区位置：`UsageCalendarCard` 之后、「最近动态」Card 之前 | 日历置顶是用户迭代定稿位（E1 头注「Token 消耗日历置顶」）不动；任务动态是比事件流更重的概览面，放事件流前 |
| DB2 | 卡片集合 = 全部顶层任务（`parentId === null`，快照序），不过滤状态 | 需求原话「将当前的任务卡片显示出来」= 当前快照里的任务卡片；与任务列表页同集合同序（E3），口径可预期 |
| DB3 | 小任务窗口 = 按执行序（`executionOrderOf`）取前 4 行，超出「还有 n 个小任务」 | 需求「最多显示4个小任务」；执行序是详情页小任务展示的既有口径（E5）——看板卡既然逐行列小任务，排序与详情页对齐；**不用快照序**（建序靠后的小任务会压住执行链头部）、**不做活跃优先重排**（发明语义） |
| DB4 | 看板卡是**新轻量组件**（`board/taskActivity.tsx`），不复用 `TaskListCard` | 列表卡承载删除/开始/文件夹/错误槽四组交互 props，看板只读卡带上这些是噪音；卡面观感靠 `.eteams-task-card` 样式表共享（E8），卡身类字面量本文件自持但**命名避开 `TASK_CARD_CLASS`**（E14 同名异值陷阱，取 `BOARD_TASK_CARD_CLASS`） |
| DB5 | 小任务窗口行 = 状态 pill（`TaskStatusPill`，**retryCount 随传**）+ 序号灰字 + 主题（truncate，title 兜底全文）+ 指派灰注（**assignee 非空才渲染**，E10 同款守卫）；行**不可点**（点击落整卡进详情） | 与详情页小任务行头同构（E10）；小任务不设详情页是既有口径（DA38/DA40：任务详情页即小任务状态总览），看板行进组详情即达同一信息 |
| DB6 | 渲染 `GroupSummaryChip`，判据与列表卡/详情页同款（`status === 'ready' && subs.length > 0` → `groupDisplayOf(subs)`，null 不渲染），置于进度行之后、窗口之前 | chip 是状态聚合件而非「不列明细」专属件（E12 详情页同屏先例）；窗口只显 4 行时 chip 兜住隐藏小任务里的异常汇总——审核 P3 采纳 |
| DB7 | 空集仍渲染分区（muted「暂无任务」行） | 「最近动态」空态先例（E1：分区常驻、muted 行）；看板分区固定序不随数据伸缩跳变 |
| DB8 | 纯函数 `subtaskWindowOf(subs): { shown, hidden }` 随组件文件导出（`MAX_SUBTASK_ROWS = 4` 常量），测试直接锁 | 对齐 `taskListCard.deletableOf` 的「判据抽纯函数 + 单测镜像」惯例（E11） |
| DB9 | 顶层普通任务卡：进度行**不渲染**「共 0 个任务」，改指派行（「指派 X」灰注，无指派不出） | 列表页「共 0」三分计数是为栅格对齐服务的统一行（十三/十四轮口径）；看板卡有独立小任务窗口区分组/普通两种身份，对普通任务重复「共 0」无信息量 |
| DB10 | pill 族**整体纯移动** `pages/tasks/taskPills.tsx` → `pages/shared/components.tsx`（DisplayStatusPill 私有件随迁，注释逐字随迁；`taskPills.tsx` 撤除；taskListCard/taskSubtaskItem/taskHeaderCard/taskDetailPage 四个消费位改导入），零行为变更 | 跨域复用落点规则：跨域小组件归 shared/components（E13）；board 是第二个消费域，方案 A（跨域直引 tasks 叶子）将开全仓先例、破规则；方案 B 从严且是纯移动。shared/components 已有对 features/tasks/taskDisplayStatus 的既有边（tone 类型），补 displayStatusOf/GroupSummary 不成环 |
| DB11 | 顶层普通任务卡的阻塞行照列表卡口径渲染（`task.blocked && <BlockedPill/>` 独立行）；主任务卡同样渲染（列表卡不分身份，E10） | 阻塞是任务动态的核心状态（卡不动 = 卡在等），比操作按钮更该上板；审核 P3 采纳「按列表卡口径补一行」选项 |

## 47.4 组件规格（board/taskActivity.tsx）

### 47.4.1 导出面与导入来源

```ts
export const MAX_SUBTASK_ROWS = 4;
export function subtaskWindowOf(subs: readonly TaskView[]): { shown: TaskView[]; hidden: number };
export function TaskActivityCard({ team }: { team: TeamSnapshot }): ReactNode;
```

组件内导入：`TaskStatusPill`/`BlockedPill`/`GroupSummaryChip` ← `../shared/components`（DB10 迁移后的家）；`executionOrderOf` ← `../../features/tasks/taskAssignCore`；`useNavigate` ← react-router-dom；类名常量 ← `../shared/styles`。`subtaskWindowOf`：入参已按执行序排好（排序留在组件内，与 E5 调用位同构——`executionOrderOf(team.tasks.filter(...))`），函数只做**窗口截取**：`shown = subs.slice(0, MAX_SUBTASK_ROWS)`、`hidden = max(0, subs.length - MAX_SUBTASK_ROWS)`；空集 → `{ shown: [], hidden: 0 }`。

### 47.4.2 渲染结构（一卡一顶层任务）

```
Card（PANEL_CARD_CLASS + pb-3，与任务列表页容器同款）
├─ 标题行（mb-2.5 flex items-center gap-2，tasksPage:200-202 同款）：
│    h3「任务动态」（LIST_TITLE_CLASS）+「N 个」（LIST_COUNT_CLASS）
├─ TASK_GRID_CLASS 栅格（无顶层任务 → MUTED_CLASS「暂无任务」行，DB7）
│    └─ 每顶层任务一卡：div.eteams-task-card（BOARD_TASK_CARD_CLASS =
│         'flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl p-3.5'，整卡 onClick=onOpen）
│         ├─ 头行：主题（truncate，text-sm font-semibold）
│         ├─ 进度行（主任务，LIST_COUNT_CLASS）：
│         │    共 x 个任务，已完成 <text-success>x</text-success>，未完成 <text-warning>y</text-warning>
│         ├─ 指派行（顶层普通任务且 assignee 非空，MUTED_CLASS）：指派 X
│         ├─ 汇总 chip 行（DB6 判据命中时）：GroupSummaryChip
│         ├─ 阻塞行（task.blocked 时，DB11）：BlockedPill blockedFrom
│         ├─ 小任务窗口（主任务且 subs.length > 0）：
│         │    └─ 行（text-xs，flex items-center gap-1.5，min-w-0）：
│         │         TaskStatusPill status retryCount（shrink-0）+「{i+1}.」（MUTED_CLASS）+
│         │         主题（truncate，title=全文）+「· {assignee}」（MUTED_CLASS，shrink-0，非空守卫）
│         │    └─ 溢出行（hidden > 0）：「还有 {hidden} 个小任务」（MUTED_CLASS）
│         └─ 底栏（mt-auto，border-t border-solid pt-2）：
│              TaskStatusPill status retryCount={task.retryCount}（左，审核 P2）
└─ （无按钮/无文件夹行/无错误槽——只读，DB4）
```

（注意：标题行用 `LIST_TITLE_CLASS`+`LIST_COUNT_CLASS` 与同页「最近动态」卡的 `SECTION_TITLE_CLASS` 视觉等价——前者带「N 个」计数行需要，取舍随任务列表页容器款，不并 SECTION_TITLE_CLASS。）

### 47.4.3 导航

整卡 `onClick` → `useNavigate()`（组件内自取，E11）→ `navigate(\`/tasks/${t.taskId}\`)`。路由 `/tasks/:taskId` 既有 location sync 回写 `drawerTaskId`（E9），零新增接线。

### 47.4.4 接线（boardPage.tsx）

`<UsageCalendarCard />` 与「最近动态」Card 之间插 `<TaskActivityCard team={team} />` 一行；`now`/`fetchedAt`/`error` 不进本分区（无相对时间消费）。模块头注释的两处分区枚举（boardPage.tsx:2、7-8「Token 消耗日历 + 最近动态」「面板只剩待决策横幅 + 日历 + 最近动态」）同步补「任务动态」，并标注 docs/47 出处。

### 47.4.5 pill 族迁移（DB10，随本功能一并落地）

`pages/tasks/taskPills.tsx` 整文件内容（DisplayStatusPill 私有 + TaskStatusPill + BlockedPill + GroupSummaryChip + 原注释）纯移动到 `pages/shared/components.tsx` 尾部；导入面补 `displayStatusOf`、`GroupSummary` 类型（features/tasks/taskDisplayStatus，与 components.tsx:11 同一条既有边）、`STATUS_PILL_CLASS`、`MUTED_CLASS`（./styles）。四个消费位改导入：taskListCard.tsx:17、taskSubtaskItem.tsx:32、taskHeaderCard.tsx:16、taskDetailPage.tsx:60（`./taskPills` → `../shared/components`）；`taskPills.tsx` 文件撤除；taskDetailPage 头注释的两处 taskPills 提法（13、17 行）改 shared/components。

## 47.5 边界

1. **team undefined**：BoardTab 早退分支不变（E1）——任务动态只在有团队时挂载，组件内 hooks（useNavigate）无条件调用无早退问题（与 usageCalendar 同款约束）。
2. **主任务 draft（拆解中）**：无小任务或小任务待开始——窗口照常渲染（draft 小任务的「待开始」pill 与计数行表达拆解进度），不加「拆解中」特判；chip 判据 ready 才出，draft 组不出（与列表卡同口径）。
3. **小任务 > 4**：只截取执行序前 4，溢出行给计数；隐藏异常由汇总 chip 兜住（DB6），不提供展开（非目标 5）。
4. **轮询重挂载**：1s 轮询只换数据不重挂组件（E2），卡片 DOM 稳定，无焦点/滚动丢失面。
5. **单测**：`tests/boardTaskActivity.test.ts` 锁 `subtaskWindowOf`（窗口=4、溢出计数、空集、执行序透传不重排）；组件渲染不进单测（面板无 React 渲染测试基建，E11）。
6. **文档**：docs/44 页面结构表 `pages/board/` 行补 `taskActivity.tsx`；`taskPills.tsx` 行（如有）随 DB10 更新。
7. **迁移回归**：DB10 是纯移动——四消费位行为逐位不变（pill 类字面量、props 签名、注释随迁），验收以 typecheck + 既有测试全绿为据。

## 47.6 开放点（不阻塞实现）

1. **仅进行中**：若用户后续要求「任务动态只显示进行中的任务」，在 DB2 的集合上加一道非终态 filter 即可（`isTerminal` 反）——本设计先按字面全集实现。
2. **窗口排序**：DB3 取执行序；若用户想要「活跃优先」（执行中/待接取排前），是窗口内一次稳定重排的局部改动。