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
| collapsible.tsx | new-york collapsible（Radix） | 同上 | tasksTab 小任务展开 |
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
| teamsView/tasksTab.tsx 小任务展开钮 ×1 | 裸 `<button>` 包 ChevronDown | `<Button variant="ghost" size="icon" className="h-6 w-6 …">`（CollapsibleTrigger asChild 内） |

**核对后保留手写**（按 43.3 规则，非漏网）：modelRoutePicker 菜单行与触发器 ×10、taskAssign 投放点/多选行/chip × ×3、teamsButton 列表行/清除钮 ×3、membersTab 选择卡 ×2、index 侧栏导航钮 ×2、tasksTab 返回条/工作目录钮 ×2。

## 43.5 如何新增 vendor 一个组件

1. 从 `https://ui.shadcn.com/r/styles/new-york/{name}.json` 抓 registry 快照（或官方文档页复制源码）。
2. 落 `src/client/components/ui/{name}.tsx`，按 43.2 统一约定改：cn 相对导入、类型规整、`/alpha` 改 `color-mix()`、`border` 补 `border-solid`、去 `"use client"`；上游无的扩展变体在变体表内注释标记。
3. 需要新 Radix 依赖时装 devDependency（react-dnd 同款打进 envelope），lucide 图标走深层 `.mjs` 导入（主入口会拖全量图标进包）。
4. 若组件含样式文件，走 tsdown 虚拟 CSS 模块字符串内联（usageCalendar 先例）。
5. `components.json` 的 aliases 已按真实路径登记，无需改动。