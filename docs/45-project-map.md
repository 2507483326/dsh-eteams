# 45 客户端项目地图与组件清单

> 状态：**终态**（2026-09-06 M8 收口；同日按拍板二次调整——组件文件名全部驼峰、teamsView 内域目录上提到 pages/ 直下，本文路径即调整后终态）｜范围：`src/client` 全量
> 依赖方向（只能向下）：`teamsView/index.tsx` → 表面（pages 根）→ `pages/teamsView`（壳）→ `pages/<域目录>`（board/team/roster/tasks/reports/shared）→ `features` / `lib` / `hooks` / `store` → `components/ui`；任何层不得反向引用。改造方案与分区规范见 `44-page-structure-spec.md`，逐文件打勾见 `46-refactor-checklist.md`。

## 45.1 入口与表面

| 文件 | 角色 |
| --- | --- |
| `src/client/index.tsx` | 插件入口：注册 4 个宿主槽位（conversation.view→ETeamsView、conversation.input.right→TeamsButton、conversation.card→EteamsCard、conversation.chat.commandview→EteamBuildCard）+ hero 行 DOM 注入；`inject=['slots','conversationEvents','modelDirectories']` |
| `pages/teamsPanel.tsx` | 整页团队面板表面：enterTeamsPanel → teamsTabVisible ? 激活宿主 tab : 打开 body 覆盖层（fixed z-[500]，顶部「返回」）；渲染 ETeamsView（**M6 横幅分区**：类型→样式类→工具函数→主组件，覆盖层静态面类名收编 OVERLAY_PAGE_CLASS/OVERLAY_HEADER_CLASS——视图无状态切换三元可查表） |
| `pages/teamsButton.tsx` | 输入行弹层表面：团队/角色快捷 chips、新增团队/新增角色入口、复制拉人模板（**M6 横幅分区**六区；tab/视图查表化——页脚新增钮 TAB_ACTION_META、团队 tab 空态 TEAM_EMPTY_META、tab 触发器 POPUP_TAB_TRIGGER_CLASS、清除钮 ClearButton 子组件；EMPTY_CLASS 改局部命名 POPUP_EMPTY_CLASS 避让 shared 同名异值） |
| `pages/heroTeamsButton.ts` | hero 行 DOM 注入按钮（非 React 表面；**M6 lib 模板横幅分区**：样式类=HERO_BUTTON_CSS → 常量=选择器/标记/样式 id → 工具函数） |
| `pages/eteamsCard.tsx` | 对话卡片表面：团队快照（头像栈 slice(0,8)、人数计数；**M6 横幅分区**，Node 定义归常量区、installCard 归工具函数区；头像栈密度参数化留 M7-7 avatarStack 提取） |
| `pages/buildCard.tsx` | 构建会话卡片表面：状态 pill 查表 **M6 迁 lib/status.ts（BUILD_SESSION_META）** + 状态行 5 分支三元链拆 buildView 键 → BUILD_VIEW_META 文案表 + fetchBuildState 轮询（1500/800 setTimeout 链，扑空 75 次重试；**M6 横幅分区**，轮询链语义原样不并 usePoll） |

## 45.2 pages/（终态 29 文件：teamsView 壳 3 + 共享层 3 + 六域目录 23）

| 文件 | 行数 | 角色 |
| --- | --- | --- |
| `teamsView/index.tsx` | 358 | 面板壳：Provider+错误边界、作用域根与宽/窄档位实测（RAIL_WIDE_MIN_WIDTH 测量留驻壳，railWide 经 props 传入）、五 tab 页头与路由出口、桥信号消费、Toaster+ROLE_LIST_CSS 注入；侧栏拆 `teamsView/rail.tsx`（M8） |
| `teamsView/routes.tsx` | 267 | 路由表（M1 新增）：ETeamsRouter（每表面一棵 MemoryRouter，initialEntries 由 ui.activeNav + 任务页签 drawerTaskId 推导）+ 全部路由与 location→store 单向 sync（ui/setNav、/tasks 域 ui/setDrawerTask） |
| `teamsView/rail.tsx` | 174 | 侧栏（**M8 自 index 拆出**）：宽栏（官网 docs 侧栏签名——搜索框/分组标题/细线列表/链接三态）与窄栏两套渲染；PanelRail 自消费 useLocation/useNavigate，railQuery 筛选为组件内瞬态 |
| `pages/shared/styles.ts` | 175 | 跨页共享层 · 类名常量与注入样式（**M8 自 shared.tsx 拆分**）：领域常量（LEADER_NAME 族/memberRank）、tone 徽标族（TONE_CLASS/PILL_*/pillClass/dotClass）、页面级类名常量（BORDER_L1_CLASS/PANEL_CARD_CLASS…）、ROLE_LIST_CSS 注入样式表 |
| `pages/shared/components.tsx` | 77 | 跨页共享层 · 小组件（**M8 自 shared.tsx 拆分**）：Pill/FormErrorNote/PageHeader |
| `pages/shared/markdownDoc.tsx` | 30 | Markdown 只读渲染包装（**M8 自 markdownDoc.tsx 移入**；typeset 双类容器，×4 消费位） |
| `pages/board/boardPage.tsx` | 134 | 看板页（**M8 自 boardTab.tsx 移入**）：待决策横幅 + 日历挂载 + 任务动态分区挂载（docs/47）+ 最近动态事件流（EMPTY_FOOTNOTE_META/FETCH_AT_EMPTY 查表收编） |
| `pages/board/usageCalendar.tsx` | 311 | Token 消耗日历卡（**M8 自 usageCalendar.tsx 移入**；react-activity-calendar + 档位标尺，已表驱动） |
| `pages/board/taskActivity.tsx` | 174 | 看板「任务动态」分区卡（**docs/47 新增**）：顶层任务平铺只读小卡 + 主任务小任务窗口（executionOrderOf 执行序最多 4 行，超出折叠；subtaskWindowOf 具名导出，tests/boardTaskActivity.test.ts 锁定窗口口径） |
| `pages/reports/reportsPage.tsx` | 83 | 汇报页（**M8 自 reportsTab.tsx 移入**）：成员选择 + 汇报时间线（D15 只读；MEMBER_SELECT_PLACEHOLDER 收编） |
| `pages/team/teamPage.tsx` | 294 | 团队列表页（M4 新增，/team）：卡片栅格 + 建团/删团弹窗留页内 + 空态（页头建团入口与详情页同款常驻） |
| `pages/team/teamDetailPage.tsx` | 460 | 团队详情页（M4 新增，/team/:teamId）：返回条 + 成员卡列表 + 模型路线乐观补丁链 + 添加成员弹窗 + 页头建团常驻，not-found 一帧 null 后 navigate('/team') |
| `pages/team/memberCards.tsx` | 227 | 领队卡/成员卡（M4 新增）：LeaderCard/MemberCard + ROLE_CHIP_CLASS 导出（成员详情页头共用）+ ACTIVITY_DOT 查表消费 |
| `pages/team/memberDetailPage.tsx` | 409 | 成员详情页（M4 新增，/team/:teamId/member/:name）：手册编辑/同步回角色库/toast；kind（领队/成员）并入路由；页头建团同款常驻 |
| `pages/team/memberDialog.tsx` | 84 | 成员汇报时间线（**M8 自 memberDialog.tsx 移入**；只读 fetch + KIND_LABELS 查表） |
| `pages/team/addMembersDialog.tsx` | 309 | 添加成员弹窗（**M8 自 addMembersDialog.tsx 移入**）：购物车 + StepButtons + 名额配额（消费方 team/teamDetailPage） |
| `pages/team/modelRoutePicker.tsx` | 396 | 模型/推理等级二级 Popover（**M8 自 modelRoutePicker.tsx 移入**；领队/成员卡共用，消费方 team/memberCards） |
| `pages/roster/rosterPage.tsx` | 268 | 角色列表页（M2 新增，/roster）：搜索/分页（每页 8）/删除 + 新增入口（构建中显「待加入角色」）+ openAddTick 消费 |
| `pages/roster/rosterAddPage.tsx` | 369 | 新增工作台页（M2 新增，/roster/add）：choose/ai/manual 三态留页内（初值经 location.state）+ 一键预填引导 |
| `pages/roster/rosterDetailPage.tsx` | 260 | 角色详情编辑页（M2 新增，/roster/:name 即角色名）：编辑/只读切换 + 手册编辑 + 汇报时间线入口 |
| `pages/roster/buildWorkbench.tsx` | 493 | 构建工作台（M2 新增，由 add 页消费）：useBuildSession（轮询仅角色域活跃时跑 + 待确认自动跳新增页）+ 访谈/草稿确认/放弃续跑卡 |
| `pages/roster/buildDraft.tsx` | 170 | 构建草稿数据层（**M8 自 buildDraft.tsx 移入**）：BUILD_STEPS/DraftEdit/fromBuildDraft/handbookSeed/CommandChip/DraftPreview |
| `pages/tasks/tasksPage.tsx` | 232 | 任务列表页（M3 新增，/tasks）：TaskListCard 栅格 + TaskDndProvider 随页 + TaskDialogs（删除弹窗真值，编辑弹窗 props 置 inert）+ 列表本地态（folderBusy/folderError/startError/deleteTarget） |
| `pages/tasks/taskDetailPage.tsx` | 719 | 任务详情页（M3 新增，/tasks/:taskId 即选中任务 id）：详情条/返回条/就地编辑器/弹层抽屉 + TaskDndProvider 随页，not-found 一帧 null 后 navigate('/tasks') |
| `pages/tasks/taskDialogs.tsx` | 124 | 任务编辑/新增 + 删除确认双弹窗（**M8 自 taskDialogs.tsx 移入**；TaskEditTarget 类型） |
| `pages/tasks/taskDrawer.tsx` | 155 | 任务详情正文（**M8 自 taskDrawer.tsx 移入**）：合同 MD、尝试时间线 + TaskStations 站点行 |
| `pages/tasks/taskHeaderCard.tsx` | 65 | 详情页头部卡（**M8 自 taskHeaderCard.tsx 移入**；actions/editor/subjectEditor 槽） |
| `pages/tasks/taskListCard.tsx` | 193 | 列表小卡 + deletableOf（**M8 自 taskListCard.tsx 移入**；具名导出，tests/taskListCard.test.ts 锁定镜像宿主 deleteTask 守卫口径） |
| `pages/tasks/taskSubtaskItem.tsx` | 311 | 组页小任务 AccordionItem（**M8 自 taskSubtaskItem.tsx 移入**；拖拽把手/钮簇/卡槽/展开区；开始钮/需选成员判据经 isStartable 消费） |
| `pages/tasks/taskPills.tsx` | ~~99~~ 已撤 | 展示态徽标族（**docs/47 DB10 移入 pages/shared/components.tsx**——看板「任务动态」分区成为第二个消费域，跨域复用归 shared/；tasks 域四消费位改导入） |

## 45.3 features / lib / hooks / store

| 文件 | 角色 |
| --- | --- |
| `features/tasks/taskDisplayStatus.ts` | 任务展示态查表范本：DISPLAY_STATUS_TABLE（十态）、displayStatusOf、isStartable/isTerminal（**M3 已落地**，三处开始钮判据收拢为谓词消费）、memberTone、DOT_BASE/DOT_TONE_CLASS——M7 收编 GLYPH_TONE_CLASS |
| `features/tasks/taskAssign.tsx` / `taskAssignCore.ts` | 任务指派拖拽层与核心逻辑（TaskDndProvider 消费） |
| `features/avatar/*`（avatar.tsx/avatarOption.ts/avatarSvg.ts/avatarWidgets.ts） | 头像组件族（seed SVG、随机选项） |
| `features/backdrop/*`（backdropEngine.ts/eteamsBackdrop.tsx） | 面板背景板（absolute 打底，零交互） |
| `features/mdEditor/mdEditor.tsx` | Markdown 编辑器封装（docs/42 CodeMirror 单实例纪律） |
| `lib/monitor.ts` | /state 主循环轮询（POLL_MS=1000）+ TeamSnapshot/MemberView/TaskView 类型（19 文件消费，全仓最热模块） |
| `lib/bridge.ts` | 跨表面跳转：pending 标记 + window 事件（GOTO_ADD/GOTO_ROSTER/SELECT_TEAM） |
| `lib/api.ts` | 后端 API 封装 |
| `lib/addPeople.ts` | 一键预填 composer + writeClipboardSafe |
| `lib/modelCatalog.ts` | 模型目录（catalogRow/catalogRowByModel） |
| `lib/cn.ts` / `lib/tailwind.ts` | 类名合并与 Tailwind 基础设施 |
| `lib/diagnostics.tsx` | ClientErrorBoundary + 诊断 |
| `lib/versionLabel.ts` | 版本标注 |
| `lib/status.ts` | **M1 新建**：NAV_ITEMS 起步，逐步收纳各状态域查表（44.2.2 清单；M2 增 ROSTER_DETAIL_SUBTITLE_META/RANDOM_AVATAR_BTN_META，M4 增 ACTIVITY_DOT 子代理活动点两态，**M6 增 BUILD_SESSION_META 构建会话四态——label + toneClass，buildCard 状态 pill 消费**；M7 RANDOM_AVATAR_BTN_META 迁 components/avatarRing.tsx） |
| `lib/errors.ts` | **M7 新建**：errorMessageOf + runWithBusy（28 处错误规范化收口） |
| `lib/text.ts` | **M7 新建**：matchesQuery（大小写不敏感子串判据） |
| `hooks/useHostDark.ts` / `hooks/useToast.ts` | 宿主暗色侦测 / toast hook；M7 增 `hooks/usePoll.ts` |
| `store/app.ts` + `store/models/{index,activity,ui,roster,build}.ts` | dva-core 单例与 4 model（activity 快照轮询 / ui 导航选择 / roster 成员库 / build 构建会话）；ui 为路由持久层 |
| `types/*.d.ts`（4 个） | dvaCore/mdEditorCss/usageCalendarCss/eteamsCss 模块声明 |

## 45.4 components/

| 文件 | 角色 |
| --- | --- |
| `components/ui/*`（18 件） | vendored shadcn（docs/43 管辖）：alert/badge/button/card/dialog/input/popover/progress/select/separator/skeleton/tabs/textarea/accordion/collapsible/pagination/toast/toaster + portal.ts + lucide-icon.d.ts + tooltip.tsx（**预留件**，二十轮拍板悬浮提示回归原生 title=） |
| **M7 新增**（components/ 领域组件层，camelCase） | `formDialog.tsx`（FormDialog 壳 + FormFooterActions）、`confirmDeleteDialog.tsx`、`avatarRing.tsx`（AvatarRing+RandomAvatarButton+rollAvatarPair）、`backBar.tsx`、`deleteButton.tsx`、`stepGlyph.tsx`、`avatarStack.tsx` —— 逐一消费位见 46 清单 M7 段 |
| `listPagination.tsx` | ListPagination 列表分页条（2026-09-06 新建）：ui/pagination 骨架唯一组装位——上一页/下一页（内嵌箭头+文字）+ 页码窗口（首尾恒在 + 当前 ±1，跨档省略号，激活 outline），0 基 page/totalPages，totalPages ≤ 1 不渲染；各列表页统一走它（rosterPage 角色列表为首位消费方） |

## 45.5 项目组件清单（可复用件与消费位）

**既有**（改造中保持/收口）：

| 组件/模块 | 定义处 | 主要消费位 |
| --- | --- | --- |
| Pill / FormErrorNote / PageHeader | teamsView/shared/components.tsx（M8 起） | 全面板 17 文件 |
| 类名常量族（MUTED_CLASS/PANEL_CARD_CLASS/BORDER_L1_CLASS…） | teamsView/shared/styles.ts（M8 起） | 全面板 17 文件 |
| MarkdownDoc | teamsView/shared/markdownDoc.tsx（M8 起） | ×4 只读渲染位 |
| ModelRoutePicker | teamsView/team/modelRoutePicker.tsx（M8 起） | 领队卡/成员卡 |
| DisplayStatusPill 族 | shared/components.tsx（docs/47 DB10 起，自 tasks/taskPills 纯移动） | 任务域各件 + 看板任务动态分区 |
| Avatar 族 | features/avatar/* | 成员卡/头像栈/弹层 |
| useActivityMonitor / relativeTime / refreshActivitySoon | lib/monitor.ts | 壳/弹层/任务域/团队域 19 文件 |
| TaskDndProvider | features/tasks/taskAssign.tsx | 任务列表/详情两页 |
| Toaster + toast() | components/ui/toaster + hooks/useToast | 壳统一渲染，各处发 |
| Portal | components/ui/portal.ts | Dialog 系（.eteams-ui 作用域内挂载） |

**M7 新增**（11 项，全部已建）：FormDialog/FormFooterActions、ConfirmDeleteDialog、AvatarRing+RandomAvatarButton、BackBar、DeleteButton、StepGlyph、AvatarStack、usePoll、errorMessageOf/runWithBusy、matchesQuery、isStartable/isTerminal——提取物/落点/消费位明细见 `46-refactor-checklist.md` M7 段。