# 48 看板 · 任务动态 验收报告

> 验收对象：docs/47-board-task-activity.md（看板「任务动态」分区 + pill 族 DB10 纯移动），实现于工作区未提交改动。
> 验收日期：2026-09-06。验收手段：全仓门禁 + DB10 机械比对 + docs/47.4 规格逐项读码核对。
> **结论：通过。** 四项门禁全绿、DB10 逐字一致（83 行 diff 为空）、47.4 规格逐项命中（仅两处无害增强，见 48.4 附注）；无与本功能相关的实质问题。装机冒烟未验证（见 48.6）。

## 48.1 门禁结果

| # | 门禁 | 命令 | 结果 | 关键输出 |
| --- | --- | --- | --- | --- |
| 1 | 类型检查 | `pnpm typecheck` | ✓ 通过 | `tsc -p tsconfig.host.json --noEmit && tsc -p tsconfig.client.json --noEmit`，exited with code 0 |
| 2 | 单测 | `pnpm test` | ✓ 通过 | `Test Files 28 passed (28)`、`Tests 369 passed (369)`，exit 0 |
| 3 | Lint | `npx eslint <8 个改动文件>` | ✓ 通过 | exit 0，零告警零错误（唯一输出为 npm 无关配置警告 `Unknown project config "verify-deps-before-run"`） |
| 4 | 构建 | `pnpm build` | ✓ 通过 | `✔ Build complete in 1540ms`、`wrap-client: wrapped lib/client.stage.js -> lib/client.js (atomic) as id "dsh-eteams"`、`SMOKE OK: id=dsh-eteams, exports=[apply, inject]`，exit 0 |

eslint 清单：taskActivity.tsx、boardPage.tsx、shared/components.tsx、taskListCard.tsx、taskSubtaskItem.tsx、taskHeaderCard.tsx、taskDetailPage.tsx、tests/boardTaskActivity.test.ts。并行会话改动（taskBody.ts、listPagination 等，见 48.7）未致任何门禁失败，无需「非本功能范围」归属标注。

## 48.2 DB10 纯移动逐字比对

- 比对对象 A：`git show HEAD:src/client/pages/tasks/taskPills.tsx` 第 17-99 行（组件本体，83 行）。
- 比对对象 B：`src/client/pages/shared/components.tsx` 「任务展示态 pill 族」段头注释（87 行）之后的 `/** 展示态徽标` 起到文件尾（89-171 行，83 行）。
- 方法：两段各自落临时文件后 `diff`。
- **结果：IDENTICAL（两段各 83 行，diff 零输出）**——DisplayStatusPill/TaskStatusPill/BlockedPill/GroupSummaryChip 四组件的 props 签名、类字面量、注释逐字一致。仅段头注释行差异（允许范围内：A 的文件头注释自 taskPills 撤除，B 换为 components.tsx 内的段头注释）。

迁移落点核对：

| 项 | 证据 | 结果 |
| --- | --- | --- |
| components.tsx 导入面补 `displayStatusOf`/`GroupSummary` 类型/`STATUS_PILL_CLASS`/`MUTED_CLASS` | components.tsx:15-22 | ✓ |
| 四消费位改导入 `../shared/components` | taskListCard.tsx:15、taskSubtaskItem.tsx:31、taskHeaderCard.tsx:18、taskDetailPage.tsx:54 | ✓ |
| 无任何 `from './taskPills'` 残留 | 全 tasks 域 grep 零命中 | ✓ |
| `taskPills.tsx` 文件撤除 | git status `D src/client/pages/tasks/taskPills.tsx`；目录列举无此文件 | ✓ |
| taskDetailPage 头注释 taskPills 提法改 shared/components | taskDetailPage.tsx:13-14（「展示态徽标居 shared/components（docs/47 DB10 自 taskPills 纯移动…）」）、17 行（依赖枚举 `shared、taskDrawer…`） | ✓ |

## 48.3 docs/47.4 规格逐项核对

### 47.4.1 导出面与导入来源（taskActivity.tsx）

| 项 | 证据 | 结果 |
| --- | --- | --- |
| `MAX_SUBTASK_ROWS = 4` 具名导出 | taskActivity.tsx:32 | ✓ |
| `subtaskWindowOf(subs: readonly TaskView[]): { shown: TaskView[]; hidden: number }` 具名导出 | taskActivity.tsx:45-47 | ✓ |
| `TaskActivityCard({ team }: { team: TeamSnapshot }): ReactNode` 具名导出 | taskActivity.tsx:143 | ✓ |
| `TaskStatusPill`/`BlockedPill`/`GroupSummaryChip` ← `../shared/components` | taskActivity.tsx:19 | ✓ |
| `executionOrderOf` ← `../../features/tasks/taskAssignCore` | taskActivity.tsx:15 | ✓ |
| `useNavigate` ← react-router-dom | taskActivity.tsx:14 | ✓ |
| 类名常量 ← `../shared/styles` | taskActivity.tsx:20-26 | ✓ |
| `subtaskWindowOf` 只做窗口截取不重排：`slice(0, 4)` + `max(0, len-4)` | taskActivity.tsx:48-51 | ✓ |
| 空集 → `{ shown: [], hidden: 0 }` | taskActivity.tsx:48-51 + 测试「空集」用例 | ✓ |
| 排序留组件内（`executionOrderOf(allTasks.filter(parentId === task.taskId))`，与详情页同构） | taskActivity.tsx:74-77 | ✓ |

附注：组件另导入 `groupDisplayOf`（taskActivity.tsx:16，DB6 chip 判据所需）与 `Card`（:27）、`cn`（:17）——47.4.1 导入清单未穷举但均在规格语义内（DB6/E12 要求 `groupDisplayOf`），不算偏差。

### 47.4.2 渲染结构（一卡一顶层任务）

| 项 | 证据 | 结果 |
| --- | --- | --- |
| Card `PANEL_CARD_CLASS + pb-3`，与任务列表页容器同款 | taskActivity.tsx:149（tasksPage.tsx:199 `cn(PANEL_CARD_CLASS, 'pb-3')` 同款） | ✓ |
| 标题行 `mb-2.5 flex items-center gap-2` + h3「任务动态」`LIST_TITLE_CLASS` +「N 个」`LIST_COUNT_CLASS` | taskActivity.tsx:150-152（tasksPage.tsx:200-202 同款） | ✓ |
| `TASK_GRID_CLASS` 栅格 | taskActivity.tsx:157 | ✓ |
| 无顶层任务 → `MUTED_CLASS`「暂无任务」行（DB7 空集常驻） | taskActivity.tsx:154-155 | ✓ |
| 卡身 `div.eteams-task-card` + `BOARD_TASK_CARD_CLASS`（规格字面量 `'flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl p-3.5'` 逐字） | taskActivity.tsx:38、88 | ✓ |
| 命名避开 `TASK_CARD_CLASS`（E14 同名异值，styles.ts:89 为小任务卡面 rounded-[8px] 档） | taskActivity.tsx:34-38 注释与取名 `BOARD_TASK_CARD_CLASS`；全文件无对 styles `TASK_CARD_CLASS` 的引用 | ✓ |
| 头行主题 `truncate text-sm font-semibold` | taskActivity.tsx:90 | ✓（附注 ①） |
| 进度行（主任务）：`共 x 个任务，已完成 <text-success>x</text-success>，未完成 <text-warning>y</text-warning>`，与列表卡逐字同款 | taskActivity.tsx:96-99（taskListCard.tsx:92-93 同字面量；done 计数口径 78 行同 taskListCard:79） | ✓ |
| 指派行（顶层普通任务且 assignee 非空，`MUTED_CLASS`）：「指派 X」 | taskActivity.tsx:101 | ✓（DB9：`kind==='group'` 三元分支，「共 0」不渲染） |
| 汇总 chip（DB6）：判据 `kind==='group' && status==='ready' && subs.length>0` → `groupDisplayOf`，null 不渲染，置于进度行后、窗口前 | taskActivity.tsx:83-86、103（taskListCard.tsx:81-83 同判据） | ✓ |
| 阻塞行（DB11）：`task.blocked && <BlockedPill blockedFrom={task.blockedFrom} />` 独立行，主任务/普通任务同渲染 | taskActivity.tsx:104（taskListCard.tsx:109 同口径） | ✓ |
| 小任务窗口 `subs.length > 0` 才渲染，容器 `flex flex-col gap-1 text-xs` | taskActivity.tsx:108-109 | ✓ |
| 窗口行 `flex min-w-0 items-center gap-1.5`；pill `TaskStatusPill status retryCount 随传`（shrink-0）；序号「{i+1}.」MUTED；主题 truncate + title 全文；指派灰注「· {assignee}」MUTED shrink-0 非空守卫 | taskActivity.tsx:111-119 | ✓（附注 ②） |
| 溢出行 `hidden > 0`：「还有 {hidden} 个小任务」MUTED | taskActivity.tsx:122 | ✓ |
| 底栏 `mt-auto` + `border-t border-solid pt-2` + `TaskStatusPill status retryCount={task.retryCount}`（左，审核 P2） | taskActivity.tsx:127-128 | ✓ |
| 无操作面：无开始/删除/详情钮、无文件夹行、无错误槽、行不可点 | 全文件仅整卡 onClick；grep 无 Button/folder/stopPropagation | ✓（DB4 只读） |

附注（两处无害增强，不改变规格语义，判 ✓）：
① 头行主题实现加了 `title={task.subject}` 兜底（taskActivity.tsx:90）——47.4.2 头行规格未列 title（title 口径在 DB5 的小任务窗口行）；与窗口行同款兜底，视觉行为无差。
② 窗口序号实现为 `cn(MUTED_CLASS, 'shrink-0')`（taskActivity.tsx:113）——规格序号只标 `MUTED_CLASS`；shrink-0 防序号被压缩，与同行指派灰注同款处理。

### 47.4.3 导航

| 项 | 证据 | 结果 |
| --- | --- | --- |
| `useNavigate()` 组件内自取 | taskActivity.tsx:144 | ✓ |
| 整卡 `onClick` → `navigate(\`/tasks/${t.taskId}\`)` | taskActivity.tsx:88、163 | ✓ |
| 路由 `/tasks/:taskId` 既有 location sync 回写 `drawerTaskId`，零新增接线 | routes.tsx:233（路由段）、131-135（`/^\/tasks\/(\d+)$/` sync） | ✓ |

### 47.4.4 接线（boardPage.tsx）

| 项 | 证据 | 结果 |
| --- | --- | --- |
| `<TaskActivityCard team={team} />` 插在 `<UsageCalendarCard />` 与「最近动态」Card 之间 | boardPage.tsx:115（日历）→ 120（任务动态）→ 121（最近动态 Card） | ✓ |
| `now`/`fetchedAt`/`error` 不进本分区 | taskActivity.tsx:143 props 仅 `team` | ✓ |
| 模块头注释两处分区枚举同步补「任务动态」并标注 docs/47 出处 | boardPage.tsx:2（「Token 消耗日历（置顶扁平区）+ 任务动态 + 最近动态」）、8（「面板只剩待决策横幅 + 日历 + 任务动态 + 最近动态」）、9-11（docs/47 出处与分区说明）；挂载位注记 116-119 | ✓ |

### 47.4.5 pill 族迁移

见 48.2（逐字比对 + 落点五项全 ✓）。

### 47.5 边界与 DB 决策抽样复核

| 项 | 证据 | 结果 |
| --- | --- | --- |
| DB2 顶层集合 = `parentId === null` 快照序不过滤状态，与任务列表页同款 | taskActivity.tsx:147（tasksPage.tsx:190 同款过滤） | ✓ |
| team undefined 早退分支不变，分区只挂有团队分支 | boardPage.tsx:76-94 早退、115-120 分区挂载 | ✓ |
| 单测锁 `subtaskWindowOf`：上限=4/恰好 4/不足 4/溢出计数/空集/乱序透传不重排，共 6 用例 | tests/boardTaskActivity.test.ts:42-80 | ✓ |
| 组件渲染不进单测（E11 面板无 React 渲染测试基建） | tests/boardTaskActivity.test.ts 仅纯函数锁 | ✓ |
| docs/44 结构表：shared/components.tsx 行补 pill 族、pages/board/ 行补 taskActivity.tsx | docs/44:72-73、75 | ✓ |
| docs/45 结构表：taskActivity.tsx 新增行（174 行）、taskPills.tsx 标 ~~99~~ 已撤、boardPage 行补分区挂载、DisplayStatusPill 族落点更新 | docs/45:27、29、50、93 | ✓ |

## 48.4 未验证项（如实标注，不伪造）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| DSH 宿主装机冒烟 | **未验证** | 客户端面板需打进真实 DSH 宿主运行；本验收环境无真实宿主。`pnpm build` 的 `SMOKE OK`（id=dsh-eteams，exports=[apply, inject]）是打包产物烟测，不等于面板内 UI 运行验证。 |
| 面板内交互验证 | **未验证** | 依赖宿主运行的人工面：整卡点击进 `/tasks/:taskId` 的路由回落、1s 轮询快照驱动下的卡片/小任务窗口实时渲染、`.eteams-task-card` 样式表在宿主样式注入下的实际观感。静态核对已覆盖接线（routes.tsx:131-135、233 既有），运行时行为未实机确认。 |

## 48.5 遗留/并行问题

本功能实现与 docs/47 无实质不符，无遗留问题。两处无害增强（48.3 附注 ①②）为规格未列的实现细节，语义等价，不构成偏差。

并行会话（三十四轮，taskBody/listPagination 等）在途改动清单——本验收未触碰、其问题不归属本功能：

- 新增：`src/client/components/listPagination.tsx`、`src/client/pages/tasks/taskBody.ts`、`tests/buildDraftPrefill.test.ts`、`tests/buildInterviewRelay.test.ts`、`.tmp-pagination-preview/`
- 修改：`src/client/components/ui/pagination.tsx`、`src/client/pages/roster/rosterPage.tsx`、`src/client/pages/roster/buildDraft.tsx`、`src/client/features/mdEditor/mdEditor.tsx`、`src/host/prompts/personas/builder.ts`、`src/host/prompts/spawn/builderPhases.ts`、`src/host/prompts/steering/interview.ts`、`src/host/runtime/members.ts`、`src/host/runtime/roleBuilder.ts`、`src/host/runtime/usage.ts`、`src/host/tools/captainTools.ts`、`tests/buildWait.test.ts`、`tests/roleBuilder.test.ts`、`tests/usage.test.ts`、docs/19、docs/29、docs/39、docs/README.md、`.claude/launch.json`
- 注意：taskListCard.tsx / taskHeaderCard.tsx / taskDetailPage.tsx 三个文件同时含本功能改动（pill 导入）与并行改动（如 `readBodyOf`/`mergedBodyOf` ← taskBody）——本次门禁对二者整体跑且全绿；其中并行部分不属本功能验收范围。
- 本验收期间全仓门禁（typecheck/test/eslint/build）全绿，不存在并行改动导致的失败，无需标注归属失败项。