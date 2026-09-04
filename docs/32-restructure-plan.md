# 32 项目结构整改方案：client 平面归属规则与 eteamsView 拆分

> 用户指令：「整体项目结构没有规划，重新规划项目结构，组件和页面 css 这些东西，现在 ts tsx 各种混乱，不知道组件、页面的归属，现出一个整改方案，再执行」。
> 本文是整改的设计合同：现状归属矩阵、目录归属判定标准、目标结构树、eteamsView.tsx 逐符号拆分映射、全量迁移映射（含 tests/scripts/构建接线同步）、host 侧决策、分阶段执行计划、风险与文档回写全部在此定稿；执行按 32.8 的阶段推进。
> **铁律：只做「移动 / 改名 / 建目录」，零行为变更。** 代码注释原样随代码走；不做顺手重构、不改样式、不改逻辑；每步四绿门验证（32.5.3 / 32.8）。

- 范围：`src/client/**` 全量归位 + `eteamsView.tsx` 拆分 + `tests/`、`scripts/` 引用同步 + 构建接线微调 + 文档回写。
- 非目标：不改 `src/host/`（结论与后续路线见 32.7）；不引入 tsconfig paths 别名（32.11）；不做组件重写、不迁样式、不动依赖版本；不做渲染级单测（沿用 docs/21 21.5.4 口径）。
- 绿基线（2026-09-04 实测，本方案的所有批次都以此为参照）：`pnpm typecheck` / `pnpm lint` / `pnpm test`（272 passed）/ `pnpm build` 全绿；`lib/client.js` = **5223 KB**（单文件 CJS envelope，含 mdxeditor 全家；每批次复测记录，异常膨胀 = 隐性 finding）。

## 32.1 现状与问题

| # | 问题 | 证据 |
|---|---|---|
| 1 | `src/client/` 根目录平铺 33 个文件，入口 / 五类表面 / 共享组件 / 基建 / d.ts 垫片 / css 混在一层，无法从路径判断归属 | 见 32.2 矩阵：根目录只有 `store/`、`components/ui/` 两个已分类目录 |
| 2 | 面板巨石 `eteamsView.tsx` **5060 行、110 个顶层符号**：侧栏导航 + 看板/团队/角色/任务/汇报五个 tab + TaskDrawer/MemberDialog 等 13 个子组件 + 约 60 个类名常量 + 领域常量（保护成员表）全部同居一文件 | 32.5.1 逐符号清单 |
| 3 | `docs/04` §4.3 的客户端模块划分与现实完全脱节（`panel/ActivityPanel.tsx`、`state/monitor.ts` 等树从未存在过） | docs/04 §4.3 |
| 4 | `components.json` 的 `hooks` alias 指向不存在的 `src/client/hooks`；shims 与 css 混放根目录，进一步加剧「不知道放哪」 | components.json aliases |

拆分 `eteamsView.tsx` 是本次核心痛点（问题 2），其余文件是「归位」——纯移动即可，映射表见 32.6。

## 32.2 现状归属矩阵

判定词表：**入口**（client 包 apply）、**页面**（挂到宿主槽位/注入点的一个表面根）、**特性**（领域功能块：组件+纯逻辑+领域常量，有独立文档线）、**基建**（无表面归属的横切层）、**状态**（dva）、**基件**（shadcn vendored）、**垫片**（环境声明）、**样式**（css 资产）。目标目录按此词表命名（32.3/32.4）。

| 现路径 | 行数 | 职责（一句话） | 归属判定 | 主要被引方 |
|---|---|---|---|---|
| src/client/index.tsx | 127 | 入口：`apply()` + 五表面槽位注册 + `inject` 服务清单 | 入口（保持不动） | 包 exports（lib/client.js 入口） |
| src/client/eteamsView.tsx | 5060 | 团队面板：壳/侧栏 + 五 tab + 13 个子组件 + 共享类名/领域常量 | 页面（拆分，32.5） | index、teamsPanel |
| src/client/teamsButton.tsx | 753 | 输入栏「团队」按钮 + 团队/角色弹层（含 localStorage 选中态） | 页面 | index |
| src/client/teamsPanel.tsx | 226 | 智能入口：tab 可见走 `actions.setView`，否则整页挂团队页 | 页面 | index、teamsButton |
| src/client/heroTeamsButton.ts | 128 | hero 行 DOM 注入按钮（MutationObserver） | 页面 | index、teamsPanel |
| src/client/card.tsx | 296 | 会话卡片 ETeamsCard（conversationEvents 折叠） | 页面 | index |
| src/client/buildCard.tsx | 265 | /eteam 命令卡片 EteamBuildCard（commandview keyed 槽） | 页面 | index |
| src/client/bridge.ts | 203 | 跨表面桥：window 事件常量、pending 信号、tab 激活/可见性 | 基建 | index、card、eteamsView、teamsPanel（+tests/bridge、tests/m0） |
| src/client/diagnostics.tsx | 140 | 客户端诊断环形缓冲 + host 上报 + ClientErrorBoundary | 基建 | 8 个消费方（全部表面 + store/app + mdEditor） |
| src/client/api.ts | 561 | `/eteams-api` 面板写 API 封装（roster/team/task/build/usage） | 基建 | store/models、taskAssignCore、teamsButton、buildCard、eteamsView（+tests/rosterEffects） |
| src/client/monitor.ts | 355 | `/eteams-api/state` 轮询 + activity 快照投影（`refreshActivitySoon` 等） | 基建 | store/app、store/models/activity、card、eteamsView、teamsButton、taskAssign（+tests/activityModel、tests/dvaApp） |
| src/client/cn.ts | 21 | clsx + tailwind-merge 类名合并 | 基建 | components/ui 全部 15 个 + 各表面（+tests/cnUtil） |
| src/client/modelCatalog.ts | 218 | 会话模型目录只读（host modelDirectories 服务） | 基建 | index、eteamsView |
| src/client/addPeople.ts | 112 | /eteam 命令模板 + 一键预填 helper（React-free） | 基建 | eteamsView、teamsButton（+tests/roleBuilder） |
| src/client/phaseLabels.ts | 20 | 团队阶段词表 | 基建 | card、eteamsView、teamsButton |
| src/client/versionLabel.ts | 4 | 插件版本标签常量 | 基建 | diagnostics |
| src/client/tailwind.ts | 38 | Tailwind 产物运行时幂等注入（构建接线端点） | 基建 | index |
| src/client/useHostDark.ts | 22 | 宿主暗色 body 属性订阅 hook | 基建 | eteamsView、mdEditor |
| src/client/avatar.tsx | 105 | Avatar 组件（seeded SVG / 首字母回退） | 特性（头像系统，docs/14） | card、buildCard、eteamsView、taskAssign、teamsButton |
| src/client/avatarOption.ts | 233 | 头像 option 模型 + 种子生成器 | 特性 | avatar、avatarSvg（+tests/avatarPipeline、scripts/avatarPreviewEntry） |
| src/client/avatarSvg.ts | 121 | 头像 SVG 合成器 | 特性 | avatar（+scripts/avatarPreviewEntry） |
| src/client/avatarWidgets.ts | 117 | vendored 部件 SVG 表（脚本生成物） | 特性 | avatarSvg（+scripts/genAvatarWidgets.mjs 生成） |
| src/client/backdropEngine.ts | 1369 | 背景板纯计算引擎（零 DOM，docs/25） | 特性 | eteamsBackdrop（+tests/backdropEngine） |
| src/client/eteamsBackdrop.tsx | 386 | 背景板 canvas 薄壳接线 | 特性 | eteamsView |
| src/client/mdEditor.tsx | 354 | mdxeditor 人设编辑器（样式运行时注入） | 特性 | eteamsView |
| src/client/taskAssign.tsx | 282 | 小任务拖拽指派组件（docs/29 A） | 特性 | eteamsView |
| src/client/taskAssignCore.ts | 93 | 拖拽纯逻辑层（React-free） | 特性 | taskAssign、eteamsView（+tests/taskAssign） |
| src/client/taskDisplayStatus.ts | 177 | 13 态→展示态派生 + 词表/tone/彩点类（docs/29 B） | 特性 | taskAssign、eteamsView（+tests/taskDisplayStatus） |
| src/client/eteams.css | 221 | Tailwind 输入 + shadcn token 桥（构建接线端点） | 样式 | buildTailwind.mjs `-i`、components.json |
| src/client/dvaCore.d.ts | 71 | dva-core 最小类型声明（无顶层 import 的脚本） | 垫片 | — |
| src/client/eteamsCss.d.ts | 5 | `*.gen.css` 通配声明 | 垫片 | — |
| src/client/mdEditorCss.d.ts | 5 | `@mdxeditor/editor/style.css` 声明 | 垫片 | — |
| src/client/usageCalendarCss.d.ts | 5 | `react-activity-calendar/tooltips.css` 声明 | 垫片 | — |
| src/client/store/{app.ts,models/*} | 58+672 | dva 单例 app + 4 model 聚合注册 | 状态（已分类，不动） | 各表面、tests×3 |
| src/client/components/ui/*（15 个） | 1107 | shadcn vendored 基件（kebab-case override） | 基件（保持不动） | 全部表面 |
| src/host/**（model/runtime/state/tools/prompts） | — | 已按域分类（runtime/webui.ts 1736 最重） | host（32.7 决策） | host 自洽 + tests×12 |

> 测试导入面：23 个测试文件全部 `from '../src/...'` 相对导入；其中 12 个覆盖 client 文件、11 个仅覆盖 host 文件。迁移需同步的测试清单见 32.6.2。

## 32.3 归属判定标准（目录规则与命名）

每个目录一条唯一规则，新文件按 32.3.1 的判定顺序走一遍即有唯一答案，杜绝「不知道放哪」复发。

### 32.3.1 判定决策树（按序问，命中即停）

0. 是不是根入口 `src/client/index.tsx`？→ **保持根目录不动**（tsdown 入口，全仓唯一，不参与判定）。
1. 是不是 `d.ts` 环境声明（`declare module`）？→ **`types/`**。
2. 是不是 `.css` 样式资产？→ **`styles/`**。
3. 是不是 shadcn vendored 基件（从 registry 拷入）？→ **`components/ui/`**（唯一 kebab-case 例外）。
4. 是不是 dva model / app 引导？→ **`store/`**（models 在 `store/models/index.ts` 聚合注册）。
5. 是不是宿主槽位 / 注入触发器（挂 `.eteams-ui` 的表面根，或把表面挂上去的命令式入口）？→ **`pages/`**（表面私有子组件放该页面自己的文件里）。
6. 是不是领域特性块（有独立文档线/测试/纯逻辑层的自洽功能块，如头像、背景板、任务指派、md 编辑器）？→ **`features/<域>/`**。
7. 是不是跨表面的 React hook？→ **`hooks/`**。
8. 其余：无表面归属的横切基建（协议/轮询/诊断/工具函数/样式注入）→ **`lib/`**。
9. 兜底：实在拿不准 → 放 `lib/` 并在模块头写一行「职责与为何在此」；下一次同类文件出现时升级成正式目录。

### 32.3.2 各目录规则表

| 目录 | 唯一归属规则 | 明确不属于它 | 命名 |
|---|---|---|---|
| `src/client/index.tsx` | 唯一入口：`apply()` + 槽位注册 + `inject` 清单 | 任何业务组件 | —（tsdown 入口，保持不动） |
| `pages/` | 一个文件/目录 = 一个宿主挂载面（conversation.* 槽位、DOM 注入、整页挂载）；页面私有子组件/类名常量就近放页面文件 | 被两个以上表面复用的组件（那是 features/）；纯逻辑（那是 lib/） | camelCase；tab 文件 `*Tab.tsx` |
| `pages/teams-view/shared.tsx` | 仅限团队面板页内：被 ≥2 个 tab 文件引用的类名常量、tone 徽标、跨 tab 小组件、领域常量 | 被其他表面复用的东西（上浮 features/）；只被一个 tab 用的东西（留在该 tab 文件） | — |
| `features/` | 领域特性块：组件 + 纯逻辑 + 领域常量同目录，有独立文档线（docs/14 头像、docs/25 背景板、docs/29 任务、docs/19 编辑器） | 只有「跨文件复用」但没有领域语义的工具（那是 lib/） | 目录单数小写；文件 camelCase |
| `components/ui/` | shadcn registry 手动 vendored 基件（kebab-case，docs/21 D19d） | 自建组件（不进 components/，进页面或 features） | kebab-case（既有 eslint override 维持） |
| `lib/` | 无表面归属的横切基建：协议、轮询、诊断、通用工具、样式注入；允许含非展示型基建（诊断边界、样式注入器），文件仍可 .tsx | 渲染业务 UI 的组件；领域规则（那是 features/） | camelCase |
| `hooks/` | 跨表面复用的 React hook（一个 hook 一个文件） | 只服务一个表面的 hook（留表面文件） | camelCase，`useXxx.ts` |
| `store/` | dva：`app.ts` 引导 + `models/index.ts` 全量注册（docs/21 D19e，start() 前注册完毕） | 组件内瞬态（useState） | camelCase |
| `styles/` | `.css` 样式资产与 token 桥；**eteams.css 保持单文件**——它是唯一 Tailwind 输入，承载全表面共享的 token 桥（亮暗双块）/作用域基线/@tailwind 三指令，非任何单页面样式；页面/feature 私有运行时样式随其宿主文件注入（既有形态：mdEditor ensureMdxStyles、usageCalendar ensureUsageCalendarStyles） | 运行时注入器（tailwind.ts 是基建，进 lib/） | camelCase |
| `types/` | 环境声明垫片（`*.d.ts`，声明体为包名或通配模式，与放置位置无关） | 普通类型导出（类型随其宿主模块走） | camelCase |

### 32.3.3 命名与放置细则

- **文件名一律 camelCase**（既有 `unicorn/filename-case` 纪律不变）：目录名同样 camelCase（eslint filename-case 约束目录名，shadcn `components/ui/` 除外），但根目录与 `components/` 之外的所有新文件保持 camelCase，**不新引入 kebab 文件**，现有 eslint 配置零改动。仅一处改名：`card.tsx → pages/eteamsCard.tsx`（裸「card」与 `components/ui/card.tsx` 撞名且看不出是表面）。
- shadcn `components/ui/` 原样保留（kebab-case + 既有 override，docs/21 D19d）。
- 组件文件名 = 主导出符号；一个文件一个主导出组件/函数（子组件私有，不导出除非跨文件消费）。
- 类名常量不新建目录：页面私有类名留页面文件，跨 tab 进 `shared.tsx`（禁拼接种类名、完整字面量映射纪律不变，docs/21 21.5.1）。
- 新增 dva model：`store/models/<name>.ts` + 在 `store/models/index.ts` 聚合注册（D19e：start() 前全量注册）。
- 新增宿主表面：先 `pages/` 建文件、再回 `index.tsx` 的 `apply()` 加一段 guard 注册。
- 禁止在根目录新增除 `index.tsx` 以外的任何文件（入口层唯一）。

## 32.4 目标结构树

```
src/client/
├── index.tsx                          # 入口：apply() + 五表面槽位注册 + inject 清单（不动）
├── lib/                               # 横切基建：无表面归属、不渲染业务 UI
│   ├── bridge.ts                      # 跨表面桥：window 事件、pending 信号、tab 激活/可见性
│   ├── diagnostics.tsx                # 诊断环形缓冲 + host 上报 + ClientErrorBoundary
│   ├── api.ts                         # /eteams-api 写 API 封装
│   ├── monitor.ts                     # state 轮询 + activity 投影（refreshActivitySoon 等）
│   ├── cn.ts                          # clsx + tailwind-merge
│   ├── modelCatalog.ts                # 会话模型目录只读（host 服务）
│   ├── addPeople.ts                   # /eteam 模板 + 一键预填 helper
│   ├── phaseLabels.ts                 # 团队阶段词表
│   ├── versionLabel.ts                # 版本标签常量
│   └── tailwind.ts                    # Tailwind 产物运行时幂等注入（构建接线端点）
├── hooks/
│   └── useHostDark.ts                 # 宿主暗色属性订阅（components.json hooks alias 落到实处）
├── components/
│   └── ui/                            # shadcn vendored 15 件（原样保留，kebab-case）
├── store/                             # dva（原样保留）
│   ├── app.ts                         # 单例引导（RootState）
│   └── models/{index,activity,build,roster,ui}.ts
├── features/                          # 领域特性块（组件 + 纯逻辑 + 领域常量）
│   ├── avatar/                        # 头像系统（docs/14）
│   │   ├── avatar.tsx                 # Avatar 组件（seeded SVG / 首字母回退）
│   │   ├── avatarOption.ts            # option 模型 + 种子生成器
│   │   ├── avatarSvg.ts               # SVG 合成器（部件拼装 + id 命名空间）
│   │   └── avatarWidgets.ts           # vendored 部件表（脚本生成物，禁手改）
│   ├── backdrop/                      # 背景板系统（docs/25）
│   │   ├── backdropEngine.ts          # 纯计算引擎（零 DOM、可单测）
│   │   └── eteamsBackdrop.tsx         # canvas/DPR/rAF/降运动薄壳
│   ├── mdEditor/
│   │   └── mdEditor.tsx               # mdxeditor 人设编辑器（样式运行时注入 + 语言预载）
│   └── tasks/                         # 任务领域（docs/29 A/B）
│       ├── taskAssign.tsx             # 拖拽指派组件（DndProvider/DropBox/成员条）
│       ├── taskAssignCore.ts          # 拖拽纯逻辑层（React-free）
│       └── taskDisplayStatus.ts       # 13 态→展示态派生 + 词表/tone/彩点类 + STATUS_GROUPS（迁入）
├── pages/                             # 表面：一个文件/目录 = 一个宿主挂载面
│   ├── teamsView/                     # 团队面板（conversation.view 槽，原 eteamsView.tsx）
│   │   ├── index.tsx                  # ETeamsView + ETeamsViewBody（壳/侧栏/tab 路由/信号消费）
│   │   ├── shared.tsx                 # 页内跨 tab 共享层（32.5.2：类名常量/tone 徽标/小组件/领域常量）
│   │   ├── boardTab.tsx               # 看板 tab（目标/进度/最近动态）
│   │   ├── usageCalendar.tsx          # Token 消耗日历卡（看板私有，docs/28）
│   │   ├── teamTab.tsx                # 团队 tab（团队列表栅格 + 团队详情）
│   │   ├── teamMembers.tsx            # 领队卡/成员卡/成员详情（成员模型路线消费方）
│   │   ├── modelRoutePicker.tsx       # 模型路线选择器（领队/成员共用）
│   │   ├── addMembersDialog.tsx       # 添加成员弹窗（点餐式，含 StepButtons）
│   │   ├── buildDraft.tsx             # 构建草稿簇（DraftPreview/CommandChip/handbookSeed/BUILD_STEPS，docs/19）
│   │   ├── membersTab.tsx             # 角色 tab（成员库 + 构建工作台）
│   │   ├── tasksTab.tsx               # 任务 tab（分组清单 + 编辑弹窗 + 展示态徽标）
│   │   ├── taskDrawer.tsx             # 任务详情抽屉 + 站点行（TaskDrawer/TaskStations）
│   │   ├── memberDialog.tsx           # 成员对话框（角色页/汇报页共用，D15）
│   │   └── reportsTab.tsx             # 汇报 tab（成员选择 + 汇报时间线）
│   ├── teamsButton.tsx                # 输入栏「团队」按钮 + 团队/角色弹层
│   ├── teamsPanel.tsx                 # 智能入口 / 整页团队页（enterTeamsPanel）
│   ├── heroTeamsButton.ts             # hero 行 DOM 注入按钮（无 React 树）
│   ├── eteamsCard.tsx                 # 会话卡片 ETeamsCard（原 card.tsx，撞名改现名）
│   └── buildCard.tsx                  # /eteam 命令卡片 EteamBuildCard（commandview keyed 槽）
├── styles/
│   └── eteams.css                     # Tailwind 输入 + shadcn token 桥（buildTailwind `-i`）
└── types/                             # 环境声明垫片（声明体均为包名/通配，与位置无关）
    ├── dvaCore.d.ts
    ├── eteamsCss.d.ts
    ├── mdEditorCss.d.ts
    └── usageCalendarCss.d.ts
```

要点：根目录只剩 `index.tsx`；`teamsView/` 平铺 14 个文件（不建 `tabs/` 子目录——14 个文件一层放得下，多一层只增加路径长度）；`features/` 四个域各有独立文档线（docs/14/25/29/19），判定标准可复核。

## 32.5 eteamsView.tsx 拆分映射

### 32.5.1 顶层符号 → 目标文件（110 个全覆盖，docs/33 全量核验）

符号按「唯一真实消费方（注释级引用不计）落该文件；≥2 个目标文件引用的落 `shared.tsx`」分配。下表即执行底稿：**每个符号整段移动（含其上方注释），不改一行代码**。

| 目标文件（pages/teams-view/） | 符号（顶层声明，原样搬迁） |
|---|---|
| **index.tsx** | `ETeamsView`（唯一导出，index.tsx/teamsPanel 消费）、`ETeamsViewBody`、`SHELL_CLASS`、`CONTENT_CLASS`、`RAIL_CLASS`、`RAIL_WIDE_CLASS`、`RAIL_TITLE_CLASS`、`RAIL_LIST_CLASS`、`RAIL_LINK_BASE_CLASS`、`RAIL_LINK_IDLE_CLASS`、`RAIL_LINK_ACTIVE_CLASS`、`railBtnClass`、`railLinkClass`、`RAIL_WIDE_MIN_WIDTH` |
| **shared.tsx** | 领域常量：`LEADER_NAME`、`ROLE_BUILDER_NAME`、`PROTECTED_MEMBERS`、`memberRank`；tone 徽标族：`TONE_CLASS`、`PHASE_TONES`、`PILL_BASE_CLASS`、`PILL_NEUTRAL_CLASS`、`PILL_TONE_CLASS`、`pillClass`、`dotClass`、`Pill`、`GLYPH_TONE_CLASS`；跨 tab 小组件：`FormErrorNote`、`PageHeader`；页面注入样式：`ROLE_LIST_CSS`；类名常量：`BORDER_L1_CLASS`、`TEXT2_CLASS`、`MUTED_CLASS`、`LINE_CLASS`、`SECTION_TITLE_CLASS`、`EMPTY_CLASS`、`PANEL_CARD_CLASS`、`FORM_ROW_CLASS`、`FORM_LABEL_CLASS`、`LIST_TITLE_CLASS`、`LIST_COUNT_CLASS`、`CARD_GRID_CLASS`、`CHIP_CLASS`、`SELECT_NONE` |
| **boardTab.tsx** | `BoardTab`、`EVENT_ROW_CLASS` |
| **usageCalendar.tsx** | `UsageCalendarCard`、`USAGE_CALENDAR_THEME`、`USAGE_CALENDAR_LABELS`、`ensureUsageCalendarStyles`、`usageStylesInjected`（模块级 `let`，注入幂等标志，随 ensureUsageCalendarStyles 整段搬）、`usageNum`、`usageDateLabel`、`usagePercentile`、`usageLevelsOf`、`usageTooltipText`（react-activity-calendar 的 `ActivityCalendar`/`Labels`/`ThemeInput` 导入与 `tooltips.css` 导入随迁） |
| **teamTab.tsx** | `TeamTab`、`TEAM_CARD_CLASS`、`TEAM_GOAL_PLACEHOLDER`、`PHASE_PILL_CLASS`、`MEMBER_LIST_CLASS` |
| **teamMembers.tsx** | `LeaderCard`、`MemberCard`、`MemberDetailView`、`MODEL_OPTIONS`、`LEADER_MODEL_OPTIONS`、`MEMBER_CARD_CLASS`、`ROLE_CHIP_CLASS` |
| **modelRoutePicker.tsx** | `ModelRoutePicker`、`PICKER_CELL_CLASS`、`PICKER_OPTION_CLASS` |
| **addMembersDialog.tsx** | `AddMembersDialog`、`StepButtons`、`STEP_BTN_CLASS`、`CartItem` |
| **buildDraft.tsx** | `DraftPreview`、`CommandChip`、`fromBuildDraft`、`EMPTY_EDIT`、`DraftEdit`、`PREFILL_STEPS`、`BUILD_STEPS`、`handbookSeed`、`HandbookSource`、`DETAIL_ROW_CLASS`、`DETAIL_LABEL_CLASS`、`CMD_CHIP_CLASS` |
| **membersTab.tsx** | `MembersTab`、`ROLE_CARD_CLASS`、`ADD_MODE_CARD_CLASS`、`ADD_MODE_ICON_CLASS`、`PAGE_PILL_CLASS`、`BUILD_STEP_CLASS`、`STEP_ROW_CLASS`、`STEP_NUM_CLASS` |
| **tasksTab.tsx** | `TasksTab`、`SlotDraft`、`TaskEditTarget`、`TASK_ROW_CLASS`、`DisplayStatusPill`、`GroupSummaryChip` |
| **taskDrawer.tsx** | `TaskDrawer`、`TaskStations`、`DRAWER_DIALOG_CLASS`、`ATTEMPT_CLASS` |
| **memberDialog.tsx** | `MemberDialog`、`DRAWER_CLASS`、`DIALOG_ITEM_CLASS` |
| **reportsTab.tsx** | `ReportsTab` |
| **features/tasks/taskDisplayStatus.ts**（上浮迁入） | `STATUS_GROUPS`（13 态→六档分组表；唯一真实消费方是 tasksTab，与 `STATUS_LABELS`/`displayStatusOf` 同家——docs/29 B 的展示态层收口） |

目标文件间的依赖方向（无环）：

```
index → 全部 tab 文件 → shared
boardTab → usageCalendar → shared
teamTab → teamMembers → modelRoutePicker；teamTab → addMembersDialog
membersTab / teamMembers → buildDraft（BUILD_STEPS/handbookSeed）
membersTab / reportsTab → memberDialog
tasksTab → taskDrawer；tasksTab → features/tasks（TaskDndProvider 等 + STATUS_GROUPS）
全部 → lib/*、features/{backdrop,md-editor,avatar,tasks}、store、components/ui、monitor、bridge
```

### 32.5.2 共享符号下沉说明（shared.tsx 规则）

- **进入条件**：符号被拆分后 ≥2 个目标文件引用。执行时以 32.5.1 的表为准（该表已按读码核实过真实 JSX/调用点，注释级引用不作为依据）。
- **tone 徽标族整族进 shared.tsx**：`TONE_CLASS` 当前唯一真实消费方是 boardTab（动态分组 tone 查表），但它是面板 tone 视觉词表的根，与 `PHASE_TONES`（boardTab/teamTab 双消费）、`pillClass/dotClass/Pill/PILL_*`（teamTab/tasksTab/membersTab 多消费）同源，整族同居一处才符合「tone 语义一处定义」；`DOT_BASE_CLASS/DOT_TONE_CLASS` 维持在 features/tasks/taskDisplayStatus.ts（docs/29 B 既有结论），shared.tsx 经 import 消费。
- **领域常量族例外（明示）**：`ROLE_BUILDER_NAME`（唯一真实消费方 addMembersDialog）、`PROTECTED_MEMBERS`（membersTab）、`memberRank`（membersTab）、`ROLE_LIST_CSS`（注入点在 index、选择器服务多 tab）四个符号按规则应落唯一消费方文件，但**领队/保护成员是同一领域常量族——`PROTECTED_MEMBERS` 字面引用 `LEADER_NAME/ROLE_BUILDER_NAME`，拆家反而破坏族内聚**，故整族同居 shared.tsx。这是 tone 族之外的第二处明示例外，执行时不改落位。
- **`STATUS_GROUPS` 上浮进 features/tasks/taskDisplayStatus.ts**：它本质是任务展示态的分组定义（13 态→六档），与已迁的 `STATUS_LABELS/memberTone/displayStatusOf/groupDisplayOf` 同家；当前唯一真实消费方是 tasksTab。这是拆分中唯一一次「符号换家到面板外」，属纯移动（无值/类型变化），在提交说明中单列。
- **`refreshActivitySoon` 不动**：它已住在 lib/monitor.ts（既有事实），shared.tsx 不收。
- **shared.tsx 上限纪律**：若执行中 shared.tsx 超过 400 行，按「类名常量 classes.ts + 组件 widgets.tsx」二分（32.11 开放问题，默认不拆）。
- shared.tsx 内部按四段注释分区：`领域常量` / `tone 徽标族` / `跨 tab 小组件` / `页面级类名常量与注入样式`，注释原样跟符号走。

### 32.5.3 拆分批次与验证（纯移动、可回滚）

每批合同（沿用 docs/21 D19f 四绿门纪律）：**范围 → 移动符号 + 改 import → 四绿门 → 记录 lib/client.js 体积 → 批次边界（见下方提交节奏）**。eteamsView.tsx 在批 1–6 期间持续缩小，每批结束仍是合法可编译模块。

> **提交节奏（用户口径 2026-09-04）**：执行 agent 不落 commit——每批四绿后在批次边界停下，由用户按其习惯（纯中文短句，如「结构整改：共享层下沉」）提交，或整阶段统一提交；回滚锚点 = 阶段基线 commit。若用户委托 agent 提交，提交信息沿用用户的中文短句风格，不用 conventional 前缀。

| 批 | 内容 | 拆分后 eteamsView 余量（约） | 验证 |
|---|---|---|---|
| 0 | 基线：四绿 + 记录 lib/client.js 基线体积（5223 KB） | 5060 行 | 四绿门 |
| 1 | 建 `pages/teams-view/`；迁 `shared.tsx`（32.5.1 shared 行全部符号）；eteamsView 改 import | ~4730 | 四绿门 |
| 2 | 迁 `features/tasks/` 三文件归位 + `STATUS_GROUPS` 上浮进 taskDisplayStatus.ts；import 同步范围 = eteamsView 改 import + shared.tsx 对 taskDisplayStatus 的 import 改写（`../../taskDisplayStatus`→`../../features/tasks/taskDisplayStatus`）+ 被迁文件自身出向 import 改写（taskAssign.tsx 的 `./api`→`../../lib/api`、`./avatar`→`../features/avatar/avatar`、`./monitor`→`../../lib/monitor`、`./cn`→`../../lib/cn`；taskAssignCore.ts 的 `./api`→`../../lib/api`） | ~4690 | 四绿（tests/taskAssign、taskDisplayStatus 保持绿） |
| 3 | 迁 `usageCalendar.tsx` → `boardTab.tsx` | ~4270 | 四绿 |
| 4 | 迁 `taskDrawer.tsx` → `tasksTab.tsx` | ~3600 | 四绿 |
| 5 | 迁 `modelRoutePicker.tsx` → `buildDraft.tsx` → `teamMembers.tsx` → `addMembersDialog.tsx` → `teamTab.tsx`（顺序：先被依赖后消费方——teamMembers 依赖 buildDraft 的 HandbookSource/handbookSeed，buildDraft 必须先迁；批内子步不单独跑门，以批末状态为准） | ~1720 | 四绿 |
| 6 | 迁 `memberDialog.tsx` → `membersTab.tsx` → `reportsTab.tsx`（membersTab 依赖 memberDialog，memberDialog 先迁） | ~480 | 四绿 |
| 7 | 收口：`ETeamsView/ETeamsViewBody` + 侧栏/壳常量迁 `pages/teams-view/index.tsx`；删除 `eteamsView.tsx`；`index.tsx`、`teamsPanel.tsx` 改 import（唯一两个外部消费方；import specifier 一律显式写 `./pages/teams-view/index`，不依赖目录索引） | 0（文件删除） | 四绿 + `node scripts/verifyM0.mjs` |

每批的固定验证命令（逐条跑，不合并）：

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
node -e "console.log((require('fs').statSync('lib/client.js').size/1024).toFixed(0)+' KB')"
node scripts/verifyM0.mjs   # 批 2/7 及阶段收口时加跑
```

> 批次顺序依据：先无依赖的共享层（批 1）→ 外置特性（批 2，路径同步顺带做，见 32.6）→ 叶子组件先于消费方（批 3–6）→ 最后收口入口（批 7）。任何一批四绿不过：带错误重试一次，再不过即停，不强行推进（D19f 同款合同）。

## 32.6 全量迁移映射表

### 32.6.1 文件级映射（旧 → 新）

| 旧路径 | 新路径 | 变更类型 | import 需要同步的消费方 |
|---|---|---|---|
| src/client/index.tsx | src/client/index.tsx | 不动（仅改内部 import 路径） | — |
| src/client/eteamsView.tsx | src/client/pages/teams-view/*（14 文件） | 拆分（32.5） | index、teamsPanel |
| src/client/bridge.ts | src/client/lib/bridge.ts | 移动 | index、card、eteamsView 拆分件、teamsPanel、teamsButton |
| src/client/diagnostics.tsx | src/client/lib/diagnostics.tsx | 移动 | 8 个消费方（全部表面 + store/app + mdEditor） |
| src/client/api.ts | src/client/lib/api.ts | 移动 | store/models/{build,roster}、taskAssignCore、teamsButton、buildCard（buildCard.tsx:24 直连 `./api`）、eteamsView 拆分件 |
| src/client/monitor.ts | src/client/lib/monitor.ts | 移动 | store/app、store/models/activity、card、eteamsView 拆分件、teamsButton、taskAssign |
| src/client/cn.ts | src/client/lib/cn.ts | 移动 | components/ui 15 件 + shared + 各表面 |
| src/client/modelCatalog.ts | src/client/lib/modelCatalog.ts | 移动 | index、eteamsView 拆分件 |
| src/client/addPeople.ts | src/client/lib/addPeople.ts | 移动 | eteamsView 拆分件、teamsButton |
| src/client/phaseLabels.ts | src/client/lib/phaseLabels.ts | 移动 | card、eteamsView 拆分件、teamsButton |
| src/client/versionLabel.ts | src/client/lib/versionLabel.ts | 移动 | diagnostics |
| src/client/tailwind.ts | src/client/lib/tailwind.ts | 移动 | index（eteamsCss.d.ts 的 `*.gen.css` 通配声明与位置无关，无需改） |
| src/client/useHostDark.ts | src/client/hooks/useHostDark.ts | 移动 | eteamsView 拆分件、mdEditor |
| src/client/eteams.css | src/client/styles/eteams.css | 移动 | buildTailwind.mjs `-i`、components.json（32.6.4） |
| src/client/dvaCore.d.ts / eteamsCss.d.ts / mdEditorCss.d.ts / usageCalendarCss.d.ts | src/client/types/（同名） | 移动 | 无（环境声明，包名/通配声明与位置无关） |
| src/client/avatar.tsx / avatarOption.ts / avatarSvg.ts / avatarWidgets.ts | src/client/features/avatar/（同名四文件） | 移动 | card、buildCard、eteamsView 拆分件、taskAssign、teamsButton、avatarSvg 内部相对导入、tests/avatarPipeline、scripts/avatarPreviewEntry、scripts/genAvatarWidgets.mjs |
| src/client/backdropEngine.ts / eteamsBackdrop.tsx | src/client/features/backdrop/（同名） | 移动 | eteamsView 拆分件、tests/backdropEngine |
| src/client/mdEditor.tsx | src/client/features/md-editor/mdEditor.tsx | 移动 | eteamsView 拆分件 |
| src/client/taskAssign.tsx / taskAssignCore.ts / taskDisplayStatus.ts | src/client/features/tasks/（同名） | 移动 | eteamsView 拆分件、tests/taskAssign、tests/taskDisplayStatus |
| src/client/card.tsx | src/client/pages/eteamsCard.tsx | 移动+改名（撞名消歧） | index |
| src/client/buildCard.tsx | src/client/pages/buildCard.tsx | 移动 | index |
| src/client/teamsButton.tsx | src/client/pages/teamsButton.tsx | 移动 | index |
| src/client/teamsPanel.tsx | src/client/pages/teamsPanel.tsx | 移动 | index、teamsButton |
| src/client/heroTeamsButton.ts | src/client/pages/heroTeamsButton.ts | 移动 | index、teamsPanel、tests/heroTeamsButton |
| src/client/store/** | 不动 | — | — |
| src/client/components/ui/** | 不动 | — | — |
| src/host/** | 不动 | — | — |

### 32.6.2 tests/ 导入同步清单（12 个文件）

全部为「`../src/client/<旧>` → `../src/client/<新>`」的前缀替换，断言零改动：

| 测试文件 | 被迁模块 | 新导入 |
|---|---|---|
| tests/bridge.test.ts | bridge | `../src/client/lib/bridge` |
| tests/m0.test.ts | bridge（另含 host，不动） | 同上 |
| tests/cnUtil.test.ts | cn | `../src/client/lib/cn` |
| tests/activityModel.test.ts | monitor、store/app、store/models/activity | 仅 monitor 改 `../src/client/lib/monitor` |
| tests/dvaApp.test.ts | monitor、store/app | 同上 |
| tests/rosterEffects.test.ts | api、store/models/roster | 仅 api 改 `../src/client/lib/api` |
| tests/roleBuilder.test.ts | addPeople（另含 host，不动） | `../src/client/lib/addPeople` |
| tests/heroTeamsButton.test.ts | heroTeamsButton | `../src/client/pages/heroTeamsButton` |
| tests/avatarPipeline.test.ts | avatarOption、avatarWidgets、avatarSvg | `../src/client/features/avatar/*` |
| tests/backdropEngine.test.ts | backdropEngine | `../src/client/features/backdrop/backdropEngine` |
| tests/taskAssign.test.ts | taskAssignCore | `../src/client/features/tasks/taskAssignCore` |
| tests/taskDisplayStatus.test.ts | taskDisplayStatus | `../src/client/features/tasks/taskDisplayStatus` |

不动的测试（11 个仅 host 面）：captainAgent、captainDispatch、lifecycle、model、rosterProtected、sessionPersona、sessionTeam、store、usage、webui、workspaces；以及上表各文件中指向 `store/`、host 的导入（store/ 与 src/host/ 均未动）。

### 32.6.3 scripts/ 同步清单

| 脚本 | 现引用 | 改为 |
|---|---|---|
| scripts/genAvatarWidgets.mjs | `OUT_FILE = src/client/avatarWidgets.ts` | `src/client/features/avatar/avatarWidgets.ts`（生成物路径） |
| scripts/avatarPreviewEntry.ts | `../src/client/avatarOption`、`../src/client/avatarSvg` | `../src/client/features/avatar/avatarOption`、`../src/client/features/avatar/avatarSvg` |
| scripts/buildTailwind.mjs | `-i src/client/eteams.css` | `-i src/client/styles/eteams.css`（L129 一处） |
| scripts/wrapClient.mjs、smokeEnvelope.mjs、clean.mjs、bisect-client.mjs、verifyM0.mjs | 只触 `lib/*` | 不动 |
| scripts/gen-role-docs.cjs、list-routes.cjs、scanSlots.cjs、list-primitives.cjs、asar-extract.cjs | 不触 client | 不动 |

### 32.6.4 构建接线同步清单

| 接线文件 | 现状 | 是否要改 | 改法 |
|---|---|---|---|
| tsconfig.client.json | rootDir `src/client`、include 全量、无 paths | **不需要改** | 拆分/移动全部发生在 rootDir 之内；`lib/types/client/` 镜像树自动跟随 |
| tsconfig.host.json / tsconfig.base.json | 仅 host | **不需要改** | — |
| tsdown.config.ts | 入口 `src/client/index.tsx` + 三个虚拟模块插件（readFileSync 均指 node_modules / lib 产物） | **不需要改** | 入口不动、虚拟模块 id 与源码路径无关；`inlineDynamicImports` 对多模块源码无感（rolldown 静态图内联） |
| tailwind.config.ts | content `src/client/**/*.{ts,tsx}` | **不需要改** | 移动全部发生在 src/client 内，扫描面不变；`.eteams-ui` 字面量仍出现在被扫描的 TSX（表面根不变） |
| scripts/buildTailwind.mjs | `-i src/client/eteams.css` | **改 1 行** | `-i src/client/styles/eteams.css` |
| components.json | css 指 `src/client/eteams.css`；aliases.utils 指 `src/client/cn`；aliases.lib 指 `src/client`；aliases.hooks 指向 `src/client/hooks`（现值即为正确目标，hooks/ 建立后首次成真，值不改） | **改 3 个字段值 + `$comment` 改写** | css → `src/client/styles/eteams.css`；utils → `src/client/lib/cn`；lib → `src/client/lib`；hooks 值不动；components/ui 两 alias 不动 |
| package.json | exports 指 `lib/*`；`dsh.client.inject` 是包名数组 | **不需要改** | `lib/types/client/index.d.ts` 存在性由 verifyM0 把关，index.tsx 留在根保证成立 |
| cordis.patch.yml | 挂载与配置，无源码路径 | **不需要改** | — |
| eslint.config.mjs | `src/client/components/**` kebab override + 全局 camelCase | **不需要改** | 新文件全部 camelCase（32.3.3） |
| vitest.config.ts | include `tests/**/*.test.ts` | **不需要改** | 测试文件不动、只改其内部 import |
| .gitignore / .prettierignore | — | **不需要改** | docs/ 已在 prettier ignore；lib/ 产物路径不变 |

> 结论：构建接线只有 **buildTailwind.mjs 1 行 + components.json 3 个字段值（css/utils/lib）+ `$comment` 改写** 需要动，其余接线对「rootDir 内的相对移动」天然透明——这是把全部新目录放进 `src/client/` 之内的直接收益。

## 32.7 host 侧决策

**结论：本轮 `src/host/` 基本保持现状，不拆 `runtime/webui.ts`（1736 行）。**

理由：

1. **风险隔离**：client 拆分是本次唯一主战场（5060 行巨石 + 33 文件归位），host 侧任何拆动都会把「四绿门」的失败面翻倍，排查时无法区分是 client 拆分还是 host 拆分引入的回归。
2. **host 已有分类**：`model/ runtime/ state/ tools/ prompts/` 五域齐全，归属判定本身成立；唯一超重文件是 webui.ts。
3. **webui.ts 的重不在「散」而在「一」**：真正的巨石是 `installWebSurface()` 单函数约 1000 行（路由注册），周边符号（视图投影 `teamSnapshot/memberView/taskView/summarizeEvent`、日志 `appendClientLog/appendHostLog`、参数 helper）已各自内聚。拆它需要按路由域切函数体，属于**行为级重构**（函数体切分），违背本轮「零行为变更」铁律。

**后续路线（记录，不在本轮执行）**：webui.ts 三步走——(a) 视图投影层独立 `runtime/webui/views.ts`（teamSnapshot/memberView/taskView/summarizeEvent/stationStatusOf，纯函数可直接单测）；(b) 日志面 `runtime/webui/logs.ts`（appendClientLog/appendHostLog/logHostBoot + 行数上限常量）；(c) `installWebSurface` 按 docs/12 路由域分片（roster/team/task/build/usage/client-log），每片一个 registrar 函数。届时以独立方案文档定稿（对齐 docs/12 路由表）。

## 32.8 分阶段执行计划

四阶段；每阶段结束跑全套验收门，阶段内批次沿用 32.5.3 的合同。**阶段可独立发布**（任一阶段完成后主干都是完整可构建状态）。

| 阶段 | 范围 | 产出 | 验收门 | 风险与回滚 |
|---|---|---|---|---|
| **阶段 1 共享层下沉** | 32.5 批 0–2：基线记录；`pages/teams-view/shared.tsx`；`features/{avatar,backdrop,md-editor,tasks}/` 四域归位 + `STATUS_GROUPS` 上浮；`lib/`（bridge/api/monitor/cn/modelCatalog/addPeople/phaseLabels/versionLabel/tailwind/diagnostics）、`hooks/`、`types/`、`styles/` 归位；`pages/{teamsButton,teamsPanel,heroTeamsButton,eteamsCard,buildCard}.*` 归位（eteamsView 未拆，先改 import 路径） | 33 个根文件只剩 index.tsx + eteamsView.tsx；eteamsView 缩到 ~4690 行 | 四绿门 + 32.6.2/32.6.3 同步清单逐项核对 + verifyM0 | 纯移动；**阶段 1 拆 3 个提交粒度**：① 纯文件移动 + 消费方/测试/脚本 import 同步 → ② 批 1 shared.tsx → ③ 批 2 features/tasks 归位 + STATUS_GROUPS 上浮，每个粒度后跑四绿（32.5.3 的提交节奏同款：agent 不落 commit，边界处停下）；最高风险是测试/脚本路径断链——验收含 `pnpm test`（vitest 直接抓）与 `node scripts/avatarPreview.mjs` 冒烟（可选） |
| **阶段 2 eteamsView 拆分** | 32.5 批 3–7：按拆分映射表分 5 批迁出全部 tab 与子组件，最后删 eteamsView.tsx | eteamsView.tsx 归零；teams-view/ 14 文件 | 每批四绿门；批 7 后跑 verifyM0 + 全量 `pnpm verify`；体积台账（每批记录，预期净变化 ≈ 0，tree-shaking 后可能小幅下降） | 每批独立 commit，单批 revert；循环依赖由 32.9 R1 的依赖方向守门 |
| **阶段 3 接线收口** | components.json 3 个字段值 + `$comment` 改写、buildTailwind 1 行（若阶段 1 未做）；全仓 grep 复查残留旧路径引用 | 接线与真实路径一致 | `pnpm build` + `node scripts/smokeEnvelope.mjs` + grep 零命中（32.8.1） | 配置改动极小；回滚 revert |
| **阶段 4 host 轻量 + 文档回写** | host 不动代码（32.7）；docs 回写（32.10 清单）：docs/04 §4.3 重写、docs/README 表、docs/21 增补、components.json 注释 | 文档与结构一致 | `pnpm format:check`（docs 已 ignore，人工核对）+ README 阅读顺序行生效 | 纯文档；无需回滚预案 |

### 32.8.1 收口核查清单（阶段 3 的机器可查项）

```bash
# 1. 旧路径残留（源码 + 测试 + 脚本，应为零；typecheck/build 是硬门，grep 是辅助线）
grep -rn "from '\./eteamsView'\|from '\./api'\|from '\./monitor'\|from '\./cn'\|from '\./bridge'\|from '\./diagnostics'\|from '\./addPeople'\|from '\./modelCatalog'\|from '\./phaseLabels'\|from '\./versionLabel'\|from '\./tailwind'\|from '\./useHostDark'\|from '\./avatar\|from '\./backdropEngine'\|from '\./eteamsBackdrop'\|from '\./mdEditor'\|from '\./taskAssign\|from '\./taskDisplayStatus'\|from '\./card'\|from '\./teamsButton'\|from '\./teamsPanel'\|from '\./heroTeamsButton'\|from '\./eteamsBackdrop'\|from '\./avatarOption'\|from '\./avatarSvg'\|from '\./avatarWidgets'\|from '\./eteams.css'" src/client/ tests/ scripts/
# 2. 根目录只剩入口（ls -p 目录带 / 后缀，grep -v / 只数文件）
ls -p src/client/ | grep -v / | wc -l   # 期望 1（index.tsx）
# 3. 全套门
pnpm typecheck && pnpm lint && pnpm test && pnpm build && node scripts/verifyM0.mjs
```

## 32.9 风险清单

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | **循环依赖**：拆分时 shared/tabs/sub-component 间互相 import 成环（最易出现） | 运行时 TDZ undefined / tsdown 静态图打环 | 依赖方向单向（32.5.1 尾图）：tab→shared→lib；真实跨文件类型边只有 membersTab→`DraftEdit`、teamMembers→`HandbookSource` 两处，一律 `import type`（verbatimModuleSyntax + eslint consistent-type-imports 双重强制，编译期擦除无运行时环）；每批 typecheck + 构建双兜底 |
| R2 | **dva model 注册路径**：models 经 `store/models/index.ts` import 聚合注册（非路径驱动），但注册时序不可变 | app 启动缺 model → 面板全灭 | store/ 的文件不搬迁、model 注册结构与聚合顺序零改动（D19e）；store 内对被迁模块（diagnostics/monitor/api）的相对 import 随迁移**同步改路径**（32.6.1 已列，store/app.ts:12-13、models/build:32、models/roster:26、models/activity:10）；verifyM0 + tests/dvaApp 把守 |
| R3 | **模块级副作用顺序**：`store/models/index.ts` 顶部副作用引入 `@babel/runtime/regenerator`（先于 start()）；monitor 单例、tailwind 注入幂等键都依赖模块求值时序 | 拆分改变 import 图可能扰动求值顺序 | 只移动符号不改 import 结构；store/app 对 models 的导入链零改动；四绿门中的 build（envelope 冒烟）会抓求值期崩溃 |
| R4 | **动态 import**：client 侧仅 `react-activity-calendar/tooltips.css`、`@mdxeditor/editor/style.css` 两个虚拟模块 import 与 `inlineDynamicImports` 约束 | 虚拟模块 id 漂移会断样式注入 | 两个虚拟 id 的消费文件（mdEditor.tsx→features/md-editor、eteamsView 拆分件→usageCalendar）仅路径变化，id 字符串本身（包名）不变；tsdown 插件零改动 |
| R5 | **测试导入断裂**：12 个测试文件直连旧路径 | vitest 全红（立即暴露，无静默面） | 32.6.2 清单随阶段 1 同步；`pnpm test` 是硬门 |
| R6 | **scripts 工具链断链**：genAvatarWidgets 生成路径、avatarPreview 入口、buildTailwind `-i` | 生成物错位 / 构建假绿 | 32.6.3 清单同步；buildTailwind 有产物存在性自检（不会假绿）；genAvatarWidgets 跑一次验证 OUT_FILE 写入 |
| R7 | **bundle 体积变化**：拆分改变模块图，tree-shaking 边界变化 | envelope 异常膨胀/缩水 | 每批记录体积（基线 5223 KB）；±1% 内视为正常，超出即查（对齐 docs/21 附录 C 台账口径） |
| R8 | **Tailwind content 扫描**：类名字面量必须出现在被扫描的 ts/tsx | 拆分后类名常量进 shared.tsx 仍被扫描，理论安全 | content glob 是 `src/client/**/*`（目录无关）；批 1 后冒烟 `lib/tailwind.gen.css` 含 `.eteams-ui` 与代表性类（smokeEnvelope 已断言） |
| R9 | **`.eteams-ui` 作用域字面量**：表面根字面量随文件搬迁 | 字面量丢失 → purge 清空产物 | 表面根元素随组件整体搬迁（EteamsView 根在 index.tsx、TeamsButton/TeamsPanel/card/buildCard 各自根在其文件），smokeEnvelope 断言兜底 |
| R10 | **d.ts 垫片位置**：eteamsCss.d.ts 的 `*.gen.css` 是通配声明、与位置无关，但若误改成相对声明即断 | typecheck 红 | 移动时保持声明体原样（已核：四个垫片全部为包名/通配声明） |
| R11 | **改名遗漏**：card.tsx → eteamsCard.tsx 的 import（index）与 docs 引用 | typecheck 红 / 文档陈旧 | 32.8.1 grep + 32.10 文档清单 |
| R12 | **`lib/` 目录名与构建产物 `lib/` 同名**：`src/client/lib/` 与根 `lib/`（产物）撞名 | 心智混淆（非构建问题：tsc/tsdown 路径互不相干） | 文档明确二者关系；备选名 `core/`（32.11 开放问题） |

## 32.10 文档回写清单

| 文档 | 回写内容 | 时机 |
|---|---|---|
| **docs/32（本文）** | 新增；执行完成后在文末追加「实施结果回写」段（批次实际结果、体积终态） | 阶段 4 |
| **docs/04-architecture.md §4.3** | 「模块划分（客户端）」整节按 32.4 目标树重写（现树与现实脱节，从未存在过） | 阶段 4 |
| **docs/README.md** | 阅读顺序表增 `32` 行（回答的问题：项目结构归属规则与 eteamsView 拆分映射）；决策记录不动（本次无用户级决策变更） | 阶段 4 |
| **docs/21-client-ui-stack.md** | 增补一节「32.x 结构整改指针」：D19d 的 `components/ui` 路径不变、`cn/hooks/css` 新路径、content/`-i` 路径新值；历史 S0–S15 施工记录中的旧路径不回改（历史证据） | 阶段 4 |
| **components.json** | `$comment` 改写（vendoring 目录、aliases 真实路径、hooks alias 首次成真） | 阶段 3 |
| docs/14（头像）、docs/25（背景板）、docs/29（任务指派/展示态）、docs/19（编辑器/预填）、docs/28（日历） | 仅在各文档「现状/模块」描述段更新新路径；证据基线（带行号的 E 编号表）为历史记录不回改（行号本就随演进漂移） | 阶段 4 |
| docs/13（界面设计） | 若引用具体文件路径则同步；界面规格本身不变 | 阶段 4 |
| **tsdown.config.ts** | usageTooltipsCssInline 的 docstring 提到「src/client/eteamsView.tsx 的 Token 消耗卡片」——批 3 后随批更新为 usageCalendar.tsx 新路径（注释级，非接线） | 批 3 |
| **后续清理候选记录** | `pillClass` 基线即零调用（死代码）：本轮随 tone 族迁 shared.tsx **原样保留不删**；删除属后续独立清理项，在此记录候选 | 阶段 4 |
| eslint.config.mjs 头注释 | 「components/ kebab 例外」说明保持（无需改规则，仅确认注释语义仍准确） | 无需动 |

回写纪律（对齐 docs/README「文档即契约」）：文档段落**当场自含说清楚**，不写「见另一文档」引用链；历史施工记录（S 步骤、E 证据表、行号锚点）一律不回改。

## 32.11 开放问题

| # | 问题 | 当前倾向 |
|---|---|---|
| Q1 | `pages/eteamsCard.tsx` 改名 vs 保留 `card.tsx` | 改名（裸 card 撞 `components/ui/card.tsx`，本次就是治「看不出归属」）；若执行中判定改名收益不足可退回原名，映射表仅一行差异 |
| Q2 | `features/` 是否过度分层（tasks/avatar/backdrop/md-editor 四域都是面板单消费） | 保留：四域各有独立文档线与测试，且 eteamsView 拆分后 teams-view/ 已 14 文件；若未来某域只剩面板单消费且无文档线，可下放页面目录 |
| Q3 | `STATUS_GROUPS` 落 features/tasks/taskDisplayStatus.ts 还是 tasksTab.tsx | 落 taskDisplayStatus（展示态层收口，与 STATUS_LABELS 同家）；执行时如发现它引用了面板侧符号则退回 tasksTab.tsx 并在批次说明记录 |
| Q4 | `src/client/lib/` 与构建产物 `lib/` 同名是否改名 `core/` | 保持 `lib/`（与「基建」心智一致、路径前缀 src/client 不会真混）；若团队反馈混淆再议 |
| Q5 | 是否引入 tsconfig paths 别名（`@client/*`）减少相对路径深度 | 本轮否：tsdown/rolldown 需加 resolve alias 配置，叠加构建风险；相对路径 + 浅层级（最多 `../../`）可接受，后续如痛点再现单独立项 |
| Q6 | shared.tsx 的拆分阈值 | 超 400 行再二分 classes.ts / widgets.tsx；默认单文件 |
| Q7 | docs 历史施工记录中的 `eteamsView.tsx:行号` 锚点漂移 | 不回改历史证据；受影响的「现状描述」段在回写时更新（32.10） |
| Q8 | 执行分支 | 沿用 D19f 惯例：自 master 切 `refactor/client-structure`，阶段=提交序列，单步可 revert |

## 32.12 实施结果回写（2026-09-04，验收报告为 docs/34）

全部批次已执行完毕，验收通过（独立验收与逐项证据见 docs/34）。本段按 32.10 的要求记录实际结果：

### 批次实际结果一览（每批四绿；体积锚点 = 批 0 基线与终态，见下）

| 批 | 内容 | 结果 |
|---|---|---|
| 0 | 基线四绿 + 体积记录 | 绿；5223 KB（5,348,587 B） |
| 1 | `pages/teamsView/shared.tsx`（32.5.1 shared 行 30 符号，四段分区注释） | 绿 |
| 2 | `features/tasks/` 三文件归位 + `STATUS_GROUPS` 上浮 taskDisplayStatus.ts；import 同步范围按 32-M8 补全 | 绿 |
| 3 | `usageCalendar.tsx` → `boardTab.tsx`（含 `usageStylesInjected`，32-B1 补列项）；tsdown docstring 注释随批更新 | 绿 |
| 4 | `taskDrawer.tsx` → `tasksTab.tsx` | 绿 |
| 5 | 修订序 `modelRoutePicker → buildDraft → teamMembers → addMembersDialog → teamTab` | 绿 |
| 6 | 修订序 `memberDialog → membersTab → reportsTab` | 绿 |
| 7 | 收口 `index.tsx`/壳常量迁 `pages/teamsView/index.tsx`、删 `eteamsView.tsx`、index/teamsPanel 改显式 `./pages/teamsView/index` 导入 | 绿 + verifyM0 |

每批边界处的逐批体积记录于执行时的批次验证输出（工作流上下文，未持久化进仓库，与 docs/21 附录 C 的 S0 基线同口径）；可持久核对的锚点是**批 0 基线 5223 KB 与终态 5230 KB**（见下）。终态四门：`pnpm typecheck` / `pnpm lint` / `pnpm test`（272/272）/ `pnpm build`（SMOKE OK）全绿；`node scripts/verifyM0.mjs` all checks passed；`node scripts/smokeEnvelope.mjs` SMOKE OK（验收独立复跑）。**体积终态 5230 KB（5,355,635 B），基线 +7 KB（+0.13%），在 R7 ±1% 阈值内**（台账同步进 docs/21 附录 C）。

### 与方案文本的三处实施差异（验收报告 docs/34 §五有实证）

1. **两处目录 camelCase 改名**：`pages/teams-view/` → `pages/teamsView/`、`features/md-editor/` → `features/mdEditor/`。32.3.3 原文「目录名可用连字符」的示例与既有 `unicorn/filename-case` 纪律相悖（该规则连带约束目录名），属方案事实性错误——**本段回写时已将 32.3.3 更正为「目录名同样 camelCase（eslint filename-case 约束目录名，shadcn `components/ui/` 除外）」**；32.4 目标树同步改名。全仓 kebab 仅存 `components/ui/`（既有 override）。
2. **verifyM0 断言修复**（批 0 后）：inject 服务断言由 2 服务改为 3 服务（slots + conversationEvents + modelDirectories）——断言底稿与 `src/client/index.tsx` 既有事实对齐，非行为变更；修复后 all checks passed。
3. **`cb52bc4`「结构归位」为批 6 中间态快照**：验收实测该快照 `tsc -p tsconfig.client.json` 报 3 处 TS2305（membersTab 的 useDispatch/useSelector、MemberDialog——批 6 未收尾）；批 6+7 尾段与阶段 4 文档回写落在工作区未提交改动中，终态四绿。历史快照本身不绿属中途提交产物，不影响终态；回滚锚点建议用阶段前基线 commit（`c1e0a95`）。

### 阶段 4 文档回写完成清单

docs/04 §4.3 重写、docs/21 §21.6.1 + 附录 C 体积行、components.json `$comment`、docs/13/14/19/25/28/29 现状段路径更新（历史锚点保留）、docs/README 32/33 行（31/34 行由验收补齐）、tsdown.config.ts docstring（批 3）、tailwind.config.ts / types/eteamsCss.d.ts / lib 注释级路径更新——全部完成。`pillClass` 随族迁 shared.tsx **原样保留不删**（其唯一调用位是 Pill 组件体，基线 423 行、现 shared.tsx:93 同构；32.10「基线即零调用」措辞欠准，口径以 docs/34 §五-⑥ 为准），删除属后续独立清理项。