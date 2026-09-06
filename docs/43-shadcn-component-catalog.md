# 43 shadcn/ui 组件清单与用件规则

> 用户指令：详细阅读 https://ui.shadcn.com/ 组件文档形成组件文档；对照组件文档扫描整个项目，该用组件的地方就用组件。
> 本文先给官方组件全集与本仓落库清单（自含，读本文即够），再给「什么场景必须用组件、什么场景保留手写」的用件规则，最后是 2026-09-05 的全仓扫描结论与整改记录。

## 43.1 官方组件全集（ui.shadcn.com，2026-09 快照）

shadcn/ui 不是 npm 组件库，而是「把组件源码拷进你的仓库」的分发模式：每个组件 = Radix 原语（或纯 div）+ cva 变体 + Tailwind 工具类，源码归你所有、随意改。官方组件索引共 50+ 件，按用途分组如下：

**表单与输入**

| 组件 | 用途 | 何时用 |
| --- | --- | --- |
| Button | 按钮四档变体（default/secondary/destructive/outline/ghost/link）× 四档尺寸 | 一切「点了做事」的 chrome 按钮 |
| Input | 单行文本输入 | 一切单行输入框 |
| Textarea | 多行文本输入 | 一切多行输入框 |
| Select | Radix Select 下拉选择 | 一切「选一个」的下拉 |
| Native Select | 原生 `<select>` 包皮 | 要原生滚动/移动端体验时 |
| Checkbox | Radix 复选框 | 布尔多选 |
| Radio Group | Radix 单选组 | 互斥单选 |
| Switch | Radix 开关 | 即时生效的开/关 |
| Slider | Radix 滑杆 | 数值区间选择 |
| Input OTP | 一次性密码输入 | 验证码 |
| Label | 表单标签 | 配合输入件的 label |
| Field / Form | 表单布局/校验包装（Form 走 react-hook-form） | 复杂表单栅格与校验 |

**展示与容器**

| 组件 | 用途 | 何时用 |
| --- | --- | --- |
| Card | 卡片容器（Header/Title/Description/Content/Footer） | 一切卡片面板 |
| Badge | 徽标（default/secondary/destructive/outline + 可扩展变体） | 状态、计数、标签 |
| Alert | 横幅提示（default/destructive，可扩展 warning 等） | 表单错误、警示横幅 |
| Progress | Radix 进度条 | 一切进度指示 |
| Skeleton | 骨架屏 | 加载占位 |
| Separator | Radix 分隔线 | 分区线 |
| Avatar | 头像（含 fallback） | 用户/成员头像 |
| Table | 语义化表格 | 结构化数据表 |
| Typography | 排版预设（标题/正文样式集合） | 文章页 |
| Accordion | Radix 手风琴 | 折叠问答/分区 |
| Collapsible | Radix 受控折叠 | 展开更多内容 |
| Tabs | Radix 页签 | 页签切换 |
| Aspect Ratio | 固定宽高比容器 | 图片/视频占位 |
| Carousel | 轮播 | 图集 |
| Scroll Area | Radix 自定义滚动区 | 需要统一样式滚动条 |
| Resizable | 分栏拖拽调宽 | 面板分栏 |
| Empty | 空态占位 | 列表空态 |
| Item | 图标+标题+描述的组合条目 | 设置项/列表项容器 |

**浮层与导航**

| 组件 | 用途 | 何时用 |
| --- | --- | --- |
| Dialog | Radix 模态弹窗 | 一切模态确认/编辑弹窗 |
| Alert Dialog | Radix 确认弹窗（专门的打断式确认语义） | 危险操作确认 |
| Sheet | 侧滑抽屉（Dialog 变体） | 侧边抽屉 |
| Drawer | Vaul 侧滑抽屉 | 移动端抽屉 |
| Popover | Radix 气泡 | 非模态浮层、面板型菜单 |
| Hover Card | 悬停卡片 | 悬浮预览 |
| Tooltip | 悬浮提示 | 图标钮的补充说明 |
| Dropdown Menu | Radix 下拉菜单 | 操作菜单 |
| Context Menu | Radix 右键菜单 | 右键操作 |
| Menubar | 菜单栏 | 顶部菜单 |
| Command | cmdk 命令面板 | ⌘K 搜索/命令 |
| Combobox | Popover+Command 组合（可搜索选择） | 可搜索下拉 |
| Navigation Menu | 顶部导航菜单 | 站点导航 |
| Breadcrumb | 面包屑 | 层级路径 |
| Pagination | 分页控件 | 列表分页 |
| Sidebar | 整套侧栏（shadcn 现成侧栏壳） | 应用侧栏 |

**其它**

| 组件 | 用途 |
| --- | --- |
| Toast / Sonner | 操作结果轻提示 |
| Toggle / Toggle Group | 按压态切换钮 |
| Button Group | 按钮组合 |
| Kbd | 键盘按键标记 |
| Calendar / Date Picker | 日历/日期选择 |
| Chart | 图表（recharts 包装） |
| Data Table | TanStack Table 数据表 |
| Bubble / Message / Message Scroller / Attachment / Questionnaire / Marker / Direction / Input Group | AI 对话场景专用件（v4 注册表新增） |

## 43.2 本仓落库清单（src/client/components/ui/）

本仓在**单文件 CJS envelope、无独立 CSS 通道、preflight 关闭、rootDir 无 paths 别名**的构建约束下，采用 shadcn 官方认可的 Manual Installation：组件从 registry（`https://ui.shadcn.com/r/styles/new-york/{name}.json`，new-york 风格）手动拷贝进 `src/client/components/ui/`，kebab-case 文件名有目录级 eslint override。`components.json` 仅作 CLI 接入预留的映射记录，本仓不跑 shadcn CLI。

| 文件 | 上游基线 | 本仓适配 | 现有消费方 |
| --- | --- | --- | --- |
| button.tsx | new-york button | cn 相对导入；hover `/alpha` 改 `color-mix()` 任意值（宿主变量是完整色值，`/alpha` 静默失效）；ghost 变体带 `border-none` | teamsButton、eteamsCard、buildCard、teamsPanel、tasksTab、teamTab、teamMembers、membersTab、addMembersDialog、taskAssign 等 10 处 |
| badge.tsx | new-york badge | 同上；追加 `success/warning/business` 变体（状态语义 tone）；`border` 配 `border-solid` | shared（Pill）、eteamsCard、buildCard |
| card.tsx | new-york card | 无特殊（上游无 /alpha） | teamsView 各 tab、teamsPanel、buildCard 等 9 处 |
| dialog.tsx | new-york dialog | portal 改自管容器（`components/ui/portal.ts` 挂 `eteams-ui-portal eteams-ui`，不逃出 `.eteams-ui` 作用域） | teamsView 各 tab 的编辑/删除/添加成员弹窗 |
| alert.tsx | new-york alert | 追加 `warning` 变体（amber 横幅）；`border` 配 `border-solid` | shared（FormErrorNote）、membersTab、teamsPanel |
| input.tsx | new-york input | `border` 配 `border-solid` | membersTab、teamsPanel、taskAssign 等 |
| textarea.tsx | new-york textarea | `border` 配 `border-solid` | tasksTab |
| select.tsx | new-york select（Radix） | cn 相对导入；类型规整 | reportsTab（成员筛选）、teamTab 等 |
| tabs.tsx | new-york tabs（Radix） | 同上 | teamsButton 弹层页签 |
| popover.tsx | new-york popover（Radix） | 同上 | modelRoutePicker、taskAssign |
| progress.tsx | new-york progress（Radix） | 同上 | eteamsCard |
| collapsible.tsx | new-york collapsible（Radix） | 同上 | 暂无消费方（预留；小任务展开已升级 Accordion） |
| accordion.tsx | new-york accordion（Radix） | cn 相对导入；去上游内嵌 ChevronDown（触发位 asChild 自带图标钮）；Header 补 `m-0`（preflight 关闭下压住 Radix Header h3 的 UA 边距）；动画 keyframes 随件补进 tailwind.config.ts | tasksTab 小任务展开（十八轮 DA31） |
| tooltip.tsx | new-york tooltip（Radix） | cn 相对导入；Tooltip **内嵌 TooltipProvider**（本仓多表面各自成树、无全局根可挂 Provider——Radix Root 缺 Provider 直接抛错，内嵌让调用位自足；代价是跨提示 skip-delay 协调不保留）；Content 强制挂自管 portal 容器（getPortalContainer，dialog.tsx 同款） | 暂无消费方（预留；二十轮撤回——悬浮提示回归原生 title=，十九轮的 hint.tsx 组合件删除） |
| toast.tsx | new-york toast（Radix） | cn 相对导入；X 走深层 `.mjs` 导入；`border` 补 `border-solid`；`text-foreground/50` 改 color-mix（token 色禁 /alpha）；Viewport 就地渲染无 portal——**Toaster 必须挂 `.eteams-ui` 子树内** | 经 ui/toaster.tsx 消费（挂载位 = teamsView/index.tsx 面板根） |
| toaster.tsx | new-york toaster | 文案本地化（关闭 sr-only）；渲染 useToast 全局单例 store | teamsView/index.tsx |
| pagination.tsx | new-york pagination | cn 相对导入；类型自足（size 内联联合）；ChevronLeft/Right/MoreHorizontal 深层导入（lucide-icon.d.ts 增补声明）；PaginationLink 以 **Slot 承 asChild**（上游 `<a>` 链接语义 → 无路由面板，消费位 asChild 包 `<Button>`，非 asChild 仍渲染 `<a>`）；Previous/Next **内嵌箭头 + 中文文字**（官方 base/pagination 文档页观感，2026-09-06 用户拍板还原——十九轮「去箭头文字钮」适配撤销），经 `Slottable` 落位进消费位 Button（`@radix-ui/react-slot` 具名导出）；激活档 outline / 非激活 ghost（buttonVariants）；aria 本地化；PaginationContent 补 `m-0 list-none p-0`（preflight 关闭下压住 ul 的 disc 标记与 40px 缩进） | membersTab 角色列表分页 → 组装收口 listPagination（ListPagination，2026-09-06） |
| hooks/useToast.ts | new-york use-toast hook | camelCase 文件名（hooks/ 目录 eslint 强制）；toast() 全局单例 store——任意表面可发、挂了 Toaster 的树渲染 | membersTab（复制反馈）、teamMembers（保存/同步反馈） |
| separator.tsx | new-york separator（Radix） | 同上 | 暂无消费方（预留） |
| skeleton.tsx | new-york skeleton | 同上 | 暂无消费方（预留） |
| portal.ts | 本仓自研 | Radix Dialog 容器重定向 | dialog.tsx |

统一约定（每个 vendored 文件头注都有记载）：

- `cn` 一律相对导入 `../../lib/cn`（仓库无 paths 别名）；
- 类型按 `verbatimModuleSyntax`/`strict` 规整（`import type * as React`、空接口改 type）；
- token 色禁用 `/alpha` 透明度修饰——宿主 `--dsw-alias-*` 变量是完整色值，`/alpha` 实测不产 CSS；半透明一律 `color-mix(in srgb, var(--x) N%, transparent)` 任意值，且类名保持完整字面量（Tailwind content 扫描可检出）；
- preflight 已关：上游 `border` 类只产 border-width，必须显式补 `border-solid` 才有边框；
- 去掉 `"use client"` 指令（非 RSC 环境）。

## 43.3 用件规则（该用组件的地方就用组件）

**必须用 vendored 组件的场景**（本合同核心规则）：

1. **chrome 按钮** → `<Button variant size>`。default=主操作、secondary=次操作、destructive=危险操作（配合 `text-destructive` 或 destructive 变体）、outline=描边次钮、ghost=幽灵钮、link=链接钮；尺寸 default/sm/lg/icon。禁止手写按钮样式常量（`STEP_BTN_CLASS`、`.eteams-role-del` 这类）。
2. **文本输入** → `<Input>` / `<Textarea>`；原生 `<input>/<textarea>` 禁止（宿主内联样式体系外的裸控件吃不到主题）。
3. **下拉选择** → `<Select>`（Radix）；`<select>` 原生件禁止。
4. **弹窗** → `<Dialog>` 系；确认类弹窗语义上等同 Dialog 现用法（标题+描述+取消/确认），不必另引 Alert Dialog。
5. **页签** → `<Tabs>`；进度 → `<Progress>`；横幅 → `<Alert>`；徽标 → `<Badge>`；卡片容器 → `<Card>`；受控折叠 → `<Collapsible>`；浮层 → `<Popover>`。
6. **悬浮提示** → 原生 `title=` 属性（**二十轮用户拍板**：撤回十九轮的 Hint/Tooltip 迁移，恢复原生浏览器提示——`hint.tsx` 随之删除，`tooltip.tsx` 转预留件；十九轮的「原生 title= 禁止」规则废止）。条件提示直接 `title={cond ? 'a' : undefined}`；禁用态控件收不到 pointer 事件、原生提示同样不弹（与十九轮前行为一致，不改）。
7. **操作结果轻提示** → `toast()`（useToast 全局 store + ui/toaster.tsx）；就地瞬时文案（「✓ 已复制 2 秒」这类状态翻转/下方小字）禁止——结果反馈统一浮层 toast（成功 default / 失败 destructive）。表单校验错误仍走就地 `<Alert>`（FormErrorNote，用户视线在表单内）。
8. **分页** → `<ListPagination page totalPages onChange>`（components/listPagination.tsx，2026-09-06 统一收口）：上一页/下一页（内嵌箭头 + 文字）+ 页码窗口（首尾页恒在 + 当前页 ±1，跨档省略号，激活 outline 档）。0 基 page/totalPages；totalPages ≤ 1 组件自不渲染，调用位免守卫。禁止页面各自拼 PaginationContent/Item。

**保留手写的场景**（均为 list-item / 画布语义，不是 chrome 控件；shadcn 无对应件或组件语义不匹配）：

1. **列表行/卡片行**（teamsButton 的 `ROW_CLASS` 团队/角色行、membersTab 的 `eteams-role-row` 与「AI 创建/手动创建」选择卡、tasksTab/teamTab 的任务小卡与团队小卡、teamMembers 成员行）：整行可点击进入详情，是**列表项**不是按钮；官网左边线三态、悬停抬升等签名由注入样式表 `.eteams-role-row/.eteams-task-card` 承载。
2. **菜单行**（modelRoutePicker 的 `PICKER_CELL/OPTION_CLASS`、taskAssign 的成员多选行）：`role="menuitemradio"` 的菜单项，shadcn 对应件是 Dropdown Menu/Command，但本处是双钻入面板 + 键盘巡航的自定义交互（对话 ModelSelect 同构），改用 DropdownMenu 是行为重写不是样式迁移，保留。
3. **侧栏导航链接**（teamsView 宽栏/窄栏 rail 按钮）：官网 docs 侧栏签名（左细线三态），非表单控件。
4. **画布/投放目标**（taskAssign 的 `＋` 追加投放点）：拖拽 drop target，点击只是等价入口。
5. **微型贴片钮**（chip 内 ×、16×16 清除钮）：嵌在 chip/触发器内部的微交互，组件的 h-9/h-8 尺寸体系塞不进，保留原生。
6. **文字型导航钮**（任务详情页「返回列表」条、任务卡「工作目录」幽灵文字钮）：用户拍板的文字融入式设计（link 语义），Button 的边距/高度体系反而破坏观感。
7. **纯 DOM 注入**（heroTeamsButton.ts）：无 React 树，不在范围。

## 43.4 全仓扫描结论（2026-09-05）

扫描方法：grep 裸 `<button>/<input>/<select>/<textarea>` 排除 `components/ui/`，逐处读上下文判语义（chrome 控件 vs 列表项/菜单行）；核对 15 个 vendored 组件的消费方分布。结论：

**大部分表面已组件化**——所有弹窗（Dialog）、页签（Tabs）、下拉（Select）、进度条（Progress）、横幅（Alert）、徽标（Badge/Pill）、卡片（Card）、折叠（Collapsible）与绝大多数按钮已走 `components/ui/`。teamsButton、eteamsCard、buildCard、teamsPanel、boardTab、reportsTab、usageCalendar、taskDrawer、buildDraft 等文件无漏网。

**漏网之鱼（本次整改）**：

| 位置 | 现状 | 整改 |
| --- | --- | --- |
| teamsView/addMembersDialog.tsx 购物车步进器 ×2 | 手写 `STEP_BTN_CLASS` 图标钮（−/＋） | `<Button variant="outline" size="icon" className="h-6 w-6 …">`，删类常量 |
| teamsView/membersTab.tsx 角色卡删除钮 ×1 | 手写按钮挂 `.eteams-role-del` 注入 CSS | `<Button variant="outline" size="sm" className="…text-destructive…">`，删 shared.tsx 的 `.eteams-role-del` CSS 规则 |
| teamsView/index.tsx 宽栏快捷搜索 ×1 | 裸 `<input>` + 手写 ring 类 | `<Input>` + ring 覆盖层（`border-0 ring-1 … pl-8`，保留官网 quick-search 签名） |
| teamsView/tasksTab.tsx 小任务展开钮 ×1 | 裸 `<button>` 包 ChevronDown | `<Button variant="ghost" size="icon" className="h-6 w-6 …">`（展开机制见十八轮增补） |

**核对后保留手写**（按 43.3 规则，非漏网）：modelRoutePicker 菜单行与触发器 ×10、taskAssign 投放点/多选行/chip × ×3、teamsButton 列表行/清除钮 ×3、membersTab 选择卡 ×2、index 侧栏导航钮 ×2、tasksTab 返回条/工作目录钮 ×2。

**十八轮 DA31 增补（2026-09-05，用户拍板「小任务列表展开用 Accordion」）**：主任务详情页的小任务列表展开由逐卡 shadcn Collapsible + 手写多开状态升级为 **shadcn Accordion**（`type="multiple"` + `value=expandedSubIds`，多开状态机交给组件；触发钮/展开位/拖拽结构不变）。Accordion 按官方 Manual 流程新增 vendor：registry JSON 的 `dependencies` 声明 `@radix-ui/react-accordion`，随件安装——与库内 dialog/select/tabs 等件的依赖结构完全一致（shadcn 组件源码 = Radix 原语 + cva + Tailwind，见 43.1 前言）。适配注记见 43.2 表；collapsible.tsx 随之空出转为预留件；shared.tsx 注入样式表里已死的 details/summary 规则一并清除。

**十九轮增补（2026-09-05，用户拍板「能用组件的就用组件——Pagination/Tooltip/Toast 全迁 + 全仓重扫」）**：43.6 初版的三个「核对后不迁」全部翻案接线。**Pagination**：membersTab 分页迁 `<Pagination>` 骨架（Previous/Next asChild 包 Button，`<a>` 链接语义经 Slot 改道——button.tsx Comp 同款模式）；**Tooltip**：vendor tooltip.tsx（内嵌 Provider + 自管 portal），新增 hint.tsx 条件组合件，全仓 20+ 处原生 `title=` 迁 Hint（含 react-dnd 拖拽 chip/把手、行头、步进钮、菜单项、头像栈——Slot 与拖拽 ref 合并实测兼容）；**Toast**：vendor toast.tsx + toaster.tsx + hooks/useToast.ts，Toaster 挂团队面板根，membersTab 复制反馈（按钮标签翻转撤除）与 teamMembers 保存/同步反馈（就地小字撤除）迁 `toast()`。重扫另清三处冗余 title（modelRoutePicker 失败行与 StationPicker 已在链中行——提示与可见文案完全重复，直接删；avatar.tsx 内嵌 title 撤除——防与使用位提示嵌套双弹）。

**二十轮增补（2026-09-05，用户拍板「原来的 title 换成 Hint 组件，换回来，重新用 title」）**：十九轮的 Tooltip/Hint 迁移整体撤回——全部悬浮提示位（含十九轮删除的三处冗余 title）恢复原生 `title=` 属性，`hint.tsx` 删除、`tooltip.tsx` 转预留件（tooltip 依赖与 vendor 文件保留，出现样式化提示需求再启用）。toast 迁移与 Pagination 迁移不受影响，维持十九轮状态。

## 43.5 如何新增 vendor 一个组件

1. 从 `https://ui.shadcn.com/r/styles/new-york/{name}.json` 抓 registry 快照（或官方文档页复制源码）。
2. 落 `src/client/components/ui/{name}.tsx`，按 43.2 统一约定改：cn 相对导入、类型规整、`/alpha` 改 `color-mix()`、`border` 补 `border-solid`、去 `"use client"`；上游无的扩展变体在变体表内注释标记。
3. 需要新 Radix 依赖时装 devDependency（react-dnd 同款打进 envelope），lucide 图标走深层 `.mjs` 导入（主入口会拖全量图标进包）。
4. 若组件含样式文件，走 tsdown 虚拟 CSS 模块字符串内联（usageCalendar 先例）。
5. `components.json` 的 aliases 已按真实路径登记，无需改动。

## 43.6 一对一检索表（官方组件 ↔ 本仓使用面，2026-09-05 全盘核对）

官方组件全集（43.1）逐件对照本仓代码的结论。判据：43.3 用件规则——chrome 控件必用组件；列表行/菜单行/导航链接/画布投放点/微型贴片钮保留手写。

**已接线（20 件，components/ui/ + hooks/）**

| 组件 | 消费位 |
| --- | --- |
| Accordion | tasksTab 小任务列表展开（多开受控，DA31） |
| Alert | boardTab 待决策横幅（warning 变体）、shared FormErrorNote（destructive）、membersTab 表单错误 |
| Badge | shared Pill（状态徽标 + 彩点）、eteamsCard/buildCard 阶段徽标 |
| Button | 全部 chrome 按钮位（弹窗底钮/卡底栏/步进器/分页/移出/删除…10+ 文件） |
| Card | 各 tab 面板卡（PANEL_CARD_CLASS 覆盖层）×9 文件 |
| Collapsible | 暂无（预留；原小任务展开位已升级 Accordion） |
| Dialog | 任务编辑/删除确认、添加成员、创建团队、汇报记录等全部弹窗 |
| Input | 弹窗表单、rail 快捷搜索、构建工作台 |
| Pagination | membersTab 角色列表分页（组装收口 ListPagination，2026-09-06 照官方 base/pagination 样式还原） |
| Popover | modelRoutePicker（模型二级菜单）、taskAssign（成员多选） |
| Progress | eteamsCard 进度条 |
| Select | reportsTab 成员筛选、teamTab 等 |
| Tabs | teamsButton 弹层页签（下划线三态覆盖层） |
| Textarea | tasksTab 小任务编辑弹窗 |
| Toast / Toaster | membersTab 复制反馈、teamMembers 保存/同步反馈（十九轮；Toaster 挂 teamsView 面板根） |
| Tooltip | 暂无消费方（预留；二十轮撤回——悬浮提示回归原生 title=） |
| Separator / Skeleton | 暂无（预留件，见下） |
| portal.ts（自研） | Dialog/Tooltip Content 容器重定向（不逃出 `.eteams-ui` 作用域） |

**核对后不迁（组件存在，但现实现等价或迁移属行为重写）**

| 官方组件 | 本仓现状 | 结论 |
| --- | --- | --- |
| Alert Dialog | 删除确认 = Dialog（标题+描述+取消/确认） | 语义等价，不另引件 |
| Avatar | features/avatar（vue-color-avatar SVG 移植） | 领域件，非中性头像，不换 |
| Command / Combobox | modelRoutePicker 双钻面板 | 对话 ModelSelect 同构 + 键盘巡航（自定义交互），cmdk 重写属行为迁移 |
| Dropdown Menu / Context Menu / Menubar | 无操作菜单场景；菜单行语义见保留手写清单 | 无对应位 |
| Switch / Checkbox / Radio Group / Slider | 无布尔开关/多选/滑杆场景（成员多选走卡槽，领队恢复走步进器） | 无对应位 |
| Sheet / Drawer | 详情已页面化（任务详情页），汇报记录用 Dialog | 无对应位 |
| Scroll Area | 原生 overflow-y-auto（宿主滚动条统一） | Radix 滚动条样式包体不划算，不迁 |
| Skeleton | 加载位是文字行（「角色库加载中…」「正在刷新模型列表…」） | 骨架屏降信息量；件保留预留，出现卡片栅格加载场景再接 |
| Separator | 分区线均为容器 border-t/b（行内分区） | 无独立分隔线位；件保留预留 |
| Empty | EMPTY_CLASS（虚线框空态） | 官方件在 v4 registry（本仓 new-york v3 基线），现类等价 |
| Typography | 官网排版经 docs/41 typeset 端口（eteams.css） | 已有等价体系 |
| Field / Form / Label | 表单为单字段行（FORM_LABEL_CLASS） | Radix Label 无增益 |
| Hover Card / Navigation Menu / Breadcrumb / Data Table / Chart / Calendar / Date Picker / Carousel / Aspect Ratio / Resizable / Input OTP / Kbd / Toggle / Toggle Group / Button Group / Sidebar | 无对应场景 | 出现需求再 vendor |

结论：**chrome 控件与官方组件一一对应的位全部已接线**（Pagination/Toast 十九轮补齐；Tooltip 迁移二十轮撤回——悬浮提示按用户拍板回归原生 `title=`）；其余保留位全部有记录在案的语义/观感理由，出现新场景按 43.5 流程补件即可。