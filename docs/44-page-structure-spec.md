# 44 客户端结构性改造：页面规范与整体方案

> 状态：进行中（2026-09-06 启动）｜范围：`src/client` 全量结构性改造｜方式：工作流逐模块推进（M1→M8）
> 本篇自含「分区规范 + 整体方案 + 模块序列 + 执行纪律」；现状文件地图与组件清单见 `45-project-map.md`，逐文件打勾清单见 `46-refactor-checklist.md`。

## 44.1 背景与目标（用户六项诉求）

1. **页面拆分**：引入 React Router（react-guide.github.io/react-router-cn），不再把所有状态混在一个页面（membersTab 1195 行、tasksTab 805 行列表/详情混居）。
2. **组件拆分复用**：子代理已全仓普查重复代码（三元渲染链 246 处/23 文件；`e instanceof Error ? …` 错误规范化 28 处；busy/error 壳 15+ 处），按清单提取可复用件。
3. **常量与状态机**：新建 `lib/status.ts`，各状态域收敛为 `META[status]` 查表，渲染位禁三元链。
4. **目录重排**：`pages/teamsView` 20 文件平铺散乱——全部改造完成后专门清理，每文件放到该放的位置。
5. **页面结构规范**：以 `/** ===== 模块X ===== */` 分区横幅让页面结构清晰可见，相关功能聚在一起（样式类一块、事件处理一块、变量一块）——先出本篇 44.3 规范，再逐页改造。
6. **工作流推进**：整体方案（本篇）→ 细化到模块（44.4）→ 细化到文件（46 清单）；过程中形成项目地图 + 项目组件文档（45），改造清单逐文件打勾（46）。

**总纪律：本次是结构性改造，观感/交互/文案零变更**（docs/43 用件规则继续生效）。

## 44.2 总体方案

### 44.2.1 路由：react-router-dom v6 MemoryRouter（每表面一棵）

插件是 DSH 宿主插件，不拥有浏览器 URL，且同屏可能有两个面板表面（整页覆盖层 teamsPanel + 槽位面板）——HashRouter/BrowserRouter 均不可行（hash 全局共享互相打架）。采用 `react-router-dom@^6.30` **MemoryRouter**：真实 Router API（Routes/Route/useNavigate/useParams），历史存内存，随表面挂载生、卸载灭，表面间零冲突。依赖以 devDependencies 引入（打进 envelope，dva 同款待遇）。

路由树（面板壳 `teamsView/index.tsx` 内）：

| 路径 | 页面 | 来源状态 |
| --- | --- | --- |
| `/board` | 看板 | ui.activeNav='board' |
| `/team` | 团队列表（卡片栅格 + 建团/删团弹窗留页内） | teamTab 列表段 |
| `/team/:teamId` | 团队详情（成员卡列表/拉人/移出） | teamTab detailId 态 |
| `/team/:teamId/member/:name` | 成员详情（手册编辑/同步） | teamMembers 成员详情段 |
| `/roster` | 角色列表（搜索/分页/删除） | membersTab view='list' |
| `/roster/add` | 新增工作台（choose/ai/manual 三态留页内） | membersTab view='add' |
| `/roster/:name` | 角色详情（编辑） | membersTab view='detail' |
| `/tasks` | 任务列表（TaskListCard 栅格） | ui.drawerTaskId=null 分支 |
| `/tasks/:taskId` | 任务详情 | ui.drawerTaskId 分支 |
| `/reports` | 汇报（dialogMember 是选择不是导航，走 ui model） | ui.activeNav='reports' |

- **ui model 保留为持久层与观察面**：MemoryRouter 挂载时用 `ui.activeNav` + `ui.drawerTaskId` + 已消费的桥 pending 信号推导 `initialEntries`；每次 location 变化 sync 回 `ui/setNav` / `ui/setDrawerTask`。ui model 结构不变。
- **跨表面跳转不变**：bridge pending 标记 + window 事件原样保留；面板内收到信号 → `navigate()`。
- 拆页无障碍事实：tasksTab 两分支本就分别包 TaskDndProvider；membersTab 的 build 会话轮询与自动跳转留在 roster 域（保持「仅角色页活跃时轮询」）；`ui/setNav` 等 dispatch 集中在壳内，迁移边界干净。
- **新拆出的页面文件直接落在最终域目录**（`pages/roster/`、`tasks/`、`team/`、`reports/`，2026-09-06 拍板：域目录放 pages/ 直下，不用 teamsView 内三层）——它们是新文件，没有「移动」步骤；M8 的纯移动只针对既有文件（44.2.4）。

### 44.2.2 常量与状态机：lib/status.ts

新建 `src/client/lib/status.ts`，状态域收敛为 `META[status] → { label, tone, title }` 查表，渲染位一律查表、禁三元链，未知值落 muted 兜底（`?? FALLBACK`）：

- **导航** `NAV_ITEMS`（id/label/path，M1 的 rail + 路由表共用）；
- 任务十态：已有 `DISPLAY_STATUS_TABLE`（features/tasks/taskDisplayStatus.ts，本仓查表范本）——保留并作为样板；
- 站点/构建步骤三态 done/current/pending（→ StepGlyph 组件消费）；
- BuildSession 四态 active/awaiting_confirmation/confirmed/cancelled（buildCard CARD_STATUS 迁入）+ 渲染端 5 分支大三元链拆状态→文案表；
- 子代理活动 running/inactive（teamMembers 点色 + title 双三元）；
- 成员五态 label（teamMembers）、尝试六态 label（taskDrawer）、消息 kind（memberDialog kindLabel）；
- 保留不动：taskDisplayStatus `memberTone` if 链（兜底老快照语义，注释明确）、usageCalendar 档位表（已表驱动）。

配套谓词进 features/tasks/taskDisplayStatus.ts：`isStartable` / `isTerminal`（收拢 taskListCard / taskSubtaskItem / tasksTab 三处开始钮判据）。

### 44.2.3 组件拆分与复用

落点规则：**跨域复用** → `src/client/components/`（camelCase，ui/ 之外新增领域组件层）；**域内复用** → 各域目录；**逻辑/谓词** → `lib/`；**轮询 hook** → `hooks/`（camelCase，随既有 useHostDark/useToast）。11 项提取清单（提取物、落点、消费位）见 46 清单 M7 段，最终形态记录在 45.5 组件清单。

### 44.2.4 目录重排（M8，最后做）

既有文件纯移动（docs/32 32.5.1 先例：只改相对导入与文档，不动行为）。M8 按 teamsView 内三层落地后，同日按拍板二次调整：**组件文件名全部驼峰**（撤销 kebab-case），**域目录上提到 pages/ 直下**（teamsView 只留壳，两级结构）。终态：

```
pages/teamsView/
  index.tsx                  壳：Provider/边界/路由出口/桥信号/Toaster/ROLE_LIST_CSS
  routes.tsx                 路由表（M1 新增）
  rail.tsx                   宽/窄侧栏（自 index 拆出）
pages/shared/
  styles.ts                  类名常量层（shared.tsx 拆分，17 引用方改导入）
  components.tsx             Pill/FormErrorNote/PageHeader 小组件层
  markdownDoc.tsx            Markdown 只读渲染包装
pages/board/    boardPage.tsx  usageCalendar.tsx
pages/reports/  reportsPage.tsx
pages/team/     teamPage.tsx  teamDetailPage.tsx  memberCards.tsx
                memberDetailPage.tsx  memberDialog.tsx
                addMembersDialog.tsx  modelRoutePicker.tsx
pages/roster/   rosterPage.tsx  rosterAddPage.tsx  rosterDetailPage.tsx
                buildWorkbench.tsx  buildDraft.tsx
pages/tasks/    tasksPage.tsx  taskDetailPage.tsx  taskDialogs.tsx
                taskDrawer.tsx  taskHeaderCard.tsx  taskListCard.tsx
                taskSubtaskItem.tsx  taskPills.tsx
```

pages 根 5 个表面（teamsButton/teamsPanel/heroTeamsButton/eteamsCard/buildCard）是独立注册面，留在 pages/ 根。

## 44.3 页面结构规范（分区横幅）

### 44.3.1 横幅格式

分区横幅统一定宽：左右各 34 个 `=`，标题两侧各一空格，`/**` 开头 `*/` 结尾。七个标准区（按序出现，用不上的区整段省略）：

```
/** ================================== 类型 ================================== */
/** ================================== 样式类 ================================== */
/** ================================== 常量与映射表 ================================== */
/** ================================== 工具函数 ================================== */
/** ================================== 事件处理 ================================== */
/** ================================== 子组件 ================================== */
/** ================================== 主组件 ================================== */
```

### 44.3.2 各区定义

| 区 | 放什么 |
| --- | --- |
| 类型 | 本文件的 interface/type（含 Props）；import 块在最前、不设横幅 |
| 样式类 | Tailwind 类名常量（`_CLASS` 后缀）与注入样式表字符串 |
| 常量与映射表 | 领域常量与 `META[status]` 查表（`_META`/`_LABELS`/`_TABLE` 后缀），含 NAV_ITEMS 类配置 |
| 工具函数 | 模块级纯函数（私有或导出） |
| 事件处理 | 模块级事件处理工厂/自定义 hook；留在主组件内的 handler 集中放在状态声明之后、JSX 之前，以行注释 `/* —— 事件处理 —— */` 分隔（不占模块横幅） |
| 子组件 | 被主组件消费的文件内组件（多组件文件时） |
| 主组件 | 文件主实体，置于末尾；命名导出 |

### 44.3.3 三种文件模板

- **页面**（路由页）：类型 → 样式类 → 常量与映射表 → 工具函数 → 事件处理 → 子组件 → 主组件
- **组件**：类型 → 样式类 → 常量与映射表 → 子组件 → 主组件
- **lib/数据层**：类型 → 常量与映射表 → 工具函数（无组件区）

命名约定：样式类常量 `UPPER_SNAKE_CLASS`；映射表 `UPPER_SNAKE_META/LABELS/TABLE`；查表消费 `XXX_META[status].label` + `?? FALLBACK`；组件文件 camelCase（components/、域目录），hook 文件 camelCase（hooks/）。文件头保留既有 `@module` JSDoc 头注释惯例，写清本文件角色与去向。

## 44.4 模块序列 M1-M8

每模块完成后跑四道门禁（`pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build`，全绿才算完成）并在 46 清单打勾。基线：317 测试用例全绿、lint 0 错误 2 既有警告。

| 模块 | 范围 | 改造内容 | 完成判据 |
| --- | --- | --- | --- |
| M1 路由骨架 | 依赖、壳、rail | react-router-dom devDep；routes.tsx（MemoryRouter + 5 基础路径 + ui model sync）；rail 迁 useNavigate；lib/status.ts 初版（NAV_ITEMS）；railBtnClass/railLinkClass 三元改查表 | 五 tab 点击/桥跳转/刷新恢复均路由驱动 |
| M2 角色域 | membersTab → roster/ | 三页拆分 + build-workbench；随机头像钮/详情编辑态查表化；buildDraft 轮询留域 | membersTab 删除，四新文件接岗 |
| M3 任务域 | tasksTab → tasks/ | 两页拆分（TaskDndProvider 随页）；isStartable/isTerminal 查表；deletableOf 单测锁定 | tasksTab 删除，/tasks/:taskId 通 |
| M4 团队域 | teamTab/teamMembers 等 | 三页拆分；member-cards/member-detail 拆分；三弹层件横幅分区 | teamTab/teamMembers 删除 |
| M5 看板+汇报 | boardTab/reportsTab/usageCalendar | 页内三元链查表化；横幅分区 | — |
| M6 弹层与卡片 | teamsButton/teamsPanel/heroTeamsButton/eteamsCard/buildCard | 各表面内部 tab/视图查表化 + 横幅分区；buildCard CARD_STATUS 迁 lib/status.ts | — |
| M7 复用收口 | 全仓 | 46 清单 M7 段 11 项提取 | 普查清单清零 |
| M8 目录重排+终检 | 既有 20 文件纯移动 + 横幅终查 | 按 44.2.4 终表移动、import 更新、45 地图收口 | 四门禁 + 全文件横幅合规 |

## 44.5 执行纪律（写入每个实施 agent）

1. 长中文 TS 文件**小步 Edit，禁一次性 Write 整文件**（历史两次大 Write 产出损坏代码）；新建文件除外。
2. 每完成一个文件跑 `pnpm typecheck`；模块完成跑四道门禁，全绿才打勾。
3. **零行为变更**：观感/交互/文案不变；类名等价替换时保持逐字面量（21.5.1 禁拼接纪律）。
4. 相对导入、无 paths 别名；不提交 git（用户统一提交）。
5. 完成即更新 46 清单打勾；45 地图相应条目同步。

## 44.6 三件套分工

- **44（本篇）**：分区规范 + 整体方案 + 模块序列 + 纪律——改造期间唯一方案真源。
- **45**：项目地图（每文件一行角色 + 去向）+ 项目组件清单（既有 + M7 新增）——收口于 M8。
- **46**：改造清单，逐文件 checkbox；每模块验收后在文末「验收记录」追加门禁结果。

## 验收记录

（逐模块追加）