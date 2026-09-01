# 23 面板二期：DSW 蓝复用 + shadcn 组件化 + 官网全模块对标

> 用户指令（二期）：①「DSW 蓝 可以复用」——accent 不必硬切官网 sky-500，可复用宿主的 DSW 蓝；②「需要使用 https://ui.shadcn.com/ 的组件」——UI 控件以 shadcn/ui 组件为基座；③延续 docs/22 总纲：整体风格对标 tailwindcss.cn 官网（侧栏/颜色/字体），且「仔细检查每个模块，都要对标」，分步骤分模块开发与验收。
> 本文是二期合同：调研结论、决策（D21 系列，接续 D20）、模块拆解（每步范围 → 四绿门 → commit → 体积台账）、验收标准。docs/22 的 S22-0..5 已交付（官网色板兜底/宽侧栏/背景引擎与画布/预览页），本文在其上做「真实宿主环境内的对标落地」。

## 23.1 调研结论（真实宿主实测，app.asar CSS 提取，2026-09）

> 方法：从 `C:\Users\epat\AppData\Local\Programs\DSH Desktop\resources\app.asar`
> 提取 `--dsw-alias-*` / `--dsw-static-*` 定义（light | dark 双值）。

### 23.1.1 宿主真实色板（docs/22 期未知的关键事实）

| 别名 | 亮 | 暗 | 与官网对照 |
| --- | --- | --- | --- |
| `--dsw-alias-brand-primary` | `#0f1115`（neutral-bluish-1000，近黑！） | `#f9fafb`（近白） | **不是蓝**——一期 `--primary` 桥到它，宿主内激活态呈近黑，官网签名（蓝 accent）完全丢失 |
| `--dsw-alias-button-info-fill` | deepseek-500 `#4176e6` | deepseek-400 `#679efe` | **DSW 蓝**：宿主主按钮实心蓝，亮暗自动切换——「DSW 蓝」的本体 |
| `--dsw-alias-button-info-hover` | deepseek-400 | deepseek-500 | 同族 hover 档 |
| `--dsw-alias-state-business-primary` | deepseek-500 | deepseek-400 | 与 info-fill 同值的业务蓝（一期 `--business` 已桥接） |
| `--dsw-alias-state-business-tertiary` | deepseek-100 `#e4edfd` | deepseek-800 `#34415b` | 品牌淡底对（chips/选中底的正确语义源） |
| `--dsw-alias-interactive-bg-active` | `#2631481a`（中性暗淡底） | `#ffffff24` | 一期品牌 chips 桥到它 → 宿主内呈中性灰淡底，非品牌蓝淡底 |
| `--dsw-alias-interactive-bg-hover` | `#2631480f` | `#ffffff14` | 中性 hover 淡底（官网 hover accent 同为中性，可沿用） |
| `--dsw-alias-bg-layer-1/2` | `#fff` / `#fff` | `#232324` / 850 | 亮=白与官网一致；暗偏中性灰（官网 slate-900 偏蓝） |
| `--dsw-alias-label-primary/secondary/tertiary` | `#0f1115`/`#61666b`/`#81858c` | `#f9fafb`/`#cfd3d6`/`#adb2b8` | neutral-bluish 灰阶：与官网 slate 阶同明度带、色相略暖 |
| `--dsw-alias-border-l1/l2` | `#0000000a`/`#0000001a` | `#ffffff0f`/`#ffffff1f` | 与官网 slate-100/200 细线同档弱度 |
| `--dsw-static-deepseek-400/450/500` | `#679efe`/`#5686fe`/`#4176e6` | 同 | DSW 蓝全档 |

结论：**「DSW 蓝」= deepseek 族（宿主主按钮/info/business 同源），一期把 `--primary` 桥到 `brand-primary`（近黑）是宿主内不对版的根因**。二期把 accent 全族改桥 button-info-fill。

### 23.1.2 shadcn/ui 组件库存与缺口

- 已 vendor（new-york，docs/21 D19d 手动落库）：`badge` `button` `card` `dialog` `input` `portal` `separator` `skeleton` `textarea`。
- 手写 chrome 面盘点（本合同要迁的）：`eteamsView` 的 `BTN_CLASS` 原生按钮 ×4 位、`SELECT_CLASS` 原生 select ×2 位、`PILL/DOT` 手写徽标、`PROGRESS_TRACK/FILL` 手写进度条、`FORM_ERROR/BANNER` 手写横幅；`teamsButton` 弹层 tab 头（`tabBtnClass`）与 footer 动作钮（`ACTION_CLASS`）；`card.tsx` 进度条（`bg-primary` 手写 div）。
- 需新增 vendor：`select`（Radix Select）、`tabs`（Radix Tabs）、`progress`（Radix Progress）、`alert`（无 Radix）。Registry 实测可达，peer 均支持 React 18。
- 保留手写（shadcn 无对应件、语义为 list item 非 chrome）：弹层/面板的列表行（`ROW_CLASS`/`TASK_ROW_CLASS`/`MEMBER_CARD_CLASS` 等）、侧栏导航链接（官网左边线三态是官网签名，D20c 定稿）、Pill 的圆点（`DOT_*`，Badge 内嵌 span）。

### 23.1.3 官网对标差距清单（逐模块审计结果）

| 模块 | 差距 | 处置 |
| --- | --- | --- |
| 令牌（eteams.css） | `--primary/--ring` 桥 brand-primary（宿主内近黑）；sky 兜底族与「DSW 蓝」指令不符 | D21a 改桥 + 兜底换 DSW 蓝 |
| 品牌淡底 | chips/选中底桥 interactive-bg-active（中性），官网/品牌语义应为品牌蓝淡底 | D21b 改桥 business-tertiary |
| eteamsView 排版 | 标题缺官网签名 `tracking-tight` | S23-3 补 |
| eteamsView 控件 | 手写按钮/select/进度条/横幅/徽标 | S23-3 迁 shadcn |
| teamsButton 弹层 | tab 头/footer 钮手写；选中底同 D21b | S23-4 |
| card/buildCard | 进度条手写、芯片底同 D21b | S23-5 |
| heroTeamsButton | focus outline 桥 brand-primary（宿主内近黑） | S23-5 换 DSW 蓝 |
| 背景板 | 引擎点缀色采样 brand-primary（宿主内近黑点缀）+ sky 兜底 | S23-6 换源 DSW 蓝 |
| 预览页 | 主题台用一期官网值，与真实宿主值不一致 | S23-6 换真实宿主值 |
| 侧栏/字体/结构 | 已达标（S22-1/2 交付，RAIL 三态=官网签名） | 不动 |

## 23.2 目标与非目标

**目标**：

1. 宿主真实环境内 accent 全面呈现 DSW 蓝（deepseek 族，亮暗自动）：激活侧栏链接、主按钮、徽标、焦点环、进度条、背景板点缀。
2. chrome 控件全面 shadcn/ui 化（vendor 缺件 + 迁移手写位），视觉延续官网风格语言。
3. 每模块对标官网的差距清单全部闭合（23.1.3 表）。
4. 四绿门步进 + 独立 commit + 体积台账；最终用户视觉验收（预览页 + GUI 实装）。

**非目标**：

- 不改 `src/host/`；不动 `mdEditor.tsx`；不引入 `dark:` 变体（D19c 主题桥机制不变，仅换映射源）；中性色阶维持宿主桥（用户只 bless 蓝的复用，neutral-bluish 与 slate 的色相微差记为可接受偏差，见 D21d）。
- avatar.tsx 调色板（含 `#4b7bec` 衬衫色）非 token 体系，不动（docs/22 例外口径）。
- 不打包字体文件；不加 lucide 图标（如无真实需要）。

## 23.3 决策记录（D21 系列，接续 docs/22 D20）

| # | 决策点 | 结论 |
| --- | --- | --- |
| D21a | accent 色源 | `--primary`、`--ring` 从 `--dsw-alias-brand-primary` 改桥 `--dsw-alias-button-info-fill`（DSW 蓝：亮 `#4176e6` / 暗 `#679efe`，宿主主按钮同源、亮暗自动切换）；字面兜底 `#4176e6`。`--primary-foreground` 维持 `label-primary-foreground`（宿主在蓝底上即白字） |
| D21b | 品牌淡底 | 品牌 chips / 选中底 / 窄栏激活底从 `--dsw-alias-interactive-bg-active`（中性暗淡底）改桥 `--dsw-alias-state-business-tertiary`（亮 `#e4edfd` / 暗 `#34415b` 品牌蓝淡底对），兜底 `rgba(65,118,230,0.12)`；hover 淡底维持 `interactive-bg-hover`（官网 hover accent 同为中性） |
| D21c | shadcn 组件化 | 手写 chrome 迁 shadcn/ui：`Button`（BTN_CLASS 位）、`Badge`（Pill）、`Alert`（错误/横幅）、`Progress`（进度条）、`Select`（原生 select 位）、`Tabs`（弹层 tab 头）。新增 vendor `select/tabs/progress/alert` + devDeps `@radix-ui/react-select/-tabs/-progress`（D19d 纪律：上游快照 + 本仓适配注释，保持最小 diff）。**Radix Portal 越界纪律**：Select 的 Portal 走 dialog.tsx 同款 `getPortalContainer()` 自管容器（body 下 `.eteams-ui-portal.eteams-ui`，容器即作用域根）——D19b 既有先例，不采用「去 Portal」方案；lucide 三图标（check/chevron-down/chevron-up）深层导入（X 同款纪律）；Tabs/Progress/Alert 无 portal 天然安全。Alert 增 `warning` 变体（本仓扩展，上游仅 default/destructive，服务面板 amber 横幅） |
| D21d | 中性色口径 | 中性色（label/border/bg 族）维持宿主桥不动：neutral-bluish 与官网 slate 同明度带、色相微差为可接受偏差（用户仅指令蓝的复用）；兜底字面量里残留的旧中性值（`#edf0f4`、`#47546c`）统一换官网 slate 阶（`#f1f5f9`、`#475569`）；sky 兜底全族（`#0ea5e9`、`rgba(14,165,233,*)`）换 DSW 蓝族（`#4176e6`、`rgba(65,118,230,*)`，见 D21a/b 兜底） |
| D21e | 背景板联动 | 引擎 brand 采样源从 `--dsw-alias-brand-primary` 改 `--dsw-alias-button-info-fill`（坦克点缀像素/高地图峰顶着色 → DSW 蓝），字面兜底 `#4176e6`；`BACKDROP_SEED` 保持 `0x0ea5e9` 致敬位不动（纯种子位）；单测色值断言同步；预览页主题台换真实宿主值（neutral-bluish 中性 + deepseek 蓝），预览=宿主内实况 |
| D21f | 步进纪律 | 延续 D19f/D20i：每模块 inScope → 四绿门（typecheck/lint/test/build）→ 体积记录 → 独立 commit，master 直行；vitest 在本会话（非受限）实测可跑（123/123 绿），上期 EPERM 障碍不适用 |

## 23.4 模块拆解（每步一个验收面）

### S23-0 基线（M0）——已执行

- 四绿门基线全绿（本会话实测）；`lib/client.js` 基线 **4,134,608 B**；本文档入库。

### S23-1 DSW 蓝令牌二期（M1）

- 范围：`src/client/eteams.css`（D21a/b remap）、全客户端 sky 兜底字面量清换（eteamsView/teamsButton/buildCard/heroTeamsButton 的 `rgba(14,165,233,*)`→`rgba(65,118,230,*)`、`#0ea5e9`→`#4176e6`；`card.tsx` 注释口径同步）、旧中性兜底字面量换 slate 阶（`#edf0f4`→`#f1f5f9`、`#47546c`→`#475569`）。
- 不变式：宿主别名首跳机制逐字保留（只换映射源与兜底）；`/alpha` 禁令不破；avatar 调色板例外不动。
- 验收：四绿门；`lib/tailwind.gen.css` 含新兜底字面量；grep 全客户端无 `0ea5e9`（除 BACKDROP_SEED 注释位）、无 `rgba(14,165,233`。

### S23-2 shadcn 补库（M2，vendor 不接线）

- 范围：`pnpm add -D @radix-ui/react-select @radix-ui/react-tabs @radix-ui/react-progress`；vendor `components/ui/select.tsx`、`tabs.tsx`、`progress.tsx`、`alert.tsx`（shadcn new-york 源码快照；Select 去 Portal 原位渲染；`cn` 相对导入、类型 verbatimModuleSyntax 规整、token 色禁 /alpha——D19d 同款适配）。
- 验收：四绿门；新组件仅落库（tsdown entry 可达性排除，JS 零增量）；gen.css 多出组件类字符串（animate-in 等由 tailwindcss-animate 承载，已装）。

### S23-3 eteamsView 控件迁移（M3）

- 范围：`BTN_CLASS` ×4 位 → `Button`（outline sm；移出团队位 destructive）；`SELECT_CLASS` ×2 位 → `Select`（含空态「— 选择 —」占位）；`PILL/DOT` → `Badge` + dot span（视觉口径：rounded-full、`text-[11px]`、dot 保留）；`PROGRESS_TRACK/FILL` ×2 位 → `Progress`（value 动态 prop）；`FORM_ERROR_CLASS`/`BANNER_CLASS` → `Alert`（destructive/warning 变体）；标题类补 `tracking-tight`（LIST_TITLE/SECTION_TITLE 按官网 h2 签名）。
- 验收：四绿门；webui.test 仍绿（不锁视觉类名，实测无碍）；冒烟 SMOKE OK；体积记录（JS 增量=Radix 三件套，预算 ≤60KB）。

### S23-4 teamsButton 弹层迁移（M4）

- 范围：tab 头 `tabBtnClass` → `Tabs/TabsList/TabsTrigger`（underline 风格贴官网）；footer `ACTION_CLASS` → `Button`（ghost sm + 官网色映射）；行选中底 `data-[selected]` 换 D21b 映射；ROW hover 维持 `hover:bg-muted`。
- 验收：四绿门；体积记录。

### S23-5 card/buildCard/hero 对标修补（M5）

- 范围：`card.tsx` 进度条 → `Progress`（`bg-primary` 注释更新为 D21a 口径）；`buildCard.tsx` 芯片底换 D21b；`heroTeamsButton.ts` focus outline 换 button-info-fill；一并扫尾残留 sky 字面量。
- 验收：四绿门；体积记录。

### S23-6 背景板联动 + 预览再生成（M6）

- 范围：`backdropEngine.ts` brand 采样源换 button-info-fill（D21e）、`tests/backdropEngine.test.ts` 色值断言同步；`.tmp-tw-docs/preview/` 重生成（engineEntry 重打包 + preview.html 主题台换真实宿主值）；README 二期一览补记。
- 验收：四绿门 + 引擎 23 例绿；预览页目检：坦克点缀/峰顶呈 DSW 蓝、亮暗切换跟随。

### S23-7 总验收（M7）

- 范围：四绿门终跑 + 体积台账定稿 + 23.1.3 差距清单逐条勾销 + 施工记录表（23.6）定稿。
- 验收：用户视觉确认——GUI 实装内 accent 为 DSW 蓝、控件为 shadcn 观感、整体官网风格语言成立；背景板不喧宾夺主。

## 23.5 风险与对策

| 风险 | 对策 |
| --- | --- |
| Radix Select 越界作用域（Portal 挂 body 失样式） | D21c：vendored 版去 Portal 原位渲染；z-[1000] 压宿主层；预览页与 GUI 双验证 |
| Radix 三件套推高 envelope 体积 | S23-3 记录增量；预算 ≤60KB，超限即复核必要件（Progress/Alert 无 Radix 可手写兜底） |
| Select 触发器样式与官网输入框风格不一致 | trigger 对齐官网输入框签名（rounded-md ring-1 shadow-sm——22.1.3 第 5 条） |
| 测试断言随色值漂移 | backdropEngine.test 色值断言在 S23-6 同步改；其余测试不锁视觉面（实测） |
| 宿主未来改 button-info-fill 值 | 桥机制即取即用（变量直引），无需追版本；兜底仅离线预览用 |
| 手写位迁移引入行为回归（受控 select/受控 tab） | 逐位等价迁移（onChange/value 语义不变）；四绿门 + 冒烟每步跑 |

## 23.6 施工记录（随步追加，终稿含体积台账）

| 步骤 | commit | 内容 | 体积（lib/client.js） |
| --- | --- | --- | --- |
| 基线 | d04b85c | 四绿门基线（本会话非受限环境实测）；本文档 | 4,134,608 B |
| S23-1 | bc8f684 | DSW 蓝令牌二期：--primary/--ring 改桥 button-info-fill；新增 --business-tint（business-tertiary 淡底对）+ tailwind.config business.tint；全客户端 sky 兜底/旧中性兜底清换（eteamsView ×17 位、teamsButton ×3、buildCard、heroTeamsButton、card 注释）；mdEditor/backdropEngine/avatar 按例外不动 | 4,134,111 B |
| S23-2 | f12b31b | shadcn 补库：+@radix-ui/react-select/-tabs/-progress（实测可达、React 18 peer 齐备）；vendor select/tabs/progress/alert（Select 走 getPortalContainer 同款 portal；lucide 三图标深层导入 + 垫片增补；Alert 增 warning 变体）；仅落库未接线——JS 零增量，体积增量全部来自 content 扫描出的组件类 CSS（gen.css +5.5KB 字符串内联） | 4,139,593 B |
| S23-3 | 327ee1a | eteamsView 控件迁移：手写 BTN/SELECT/PILL/PROGRESS/FORM_ERROR/BANNER/PREFILL_BANNER → shadcn Button(outline·sm)/Select(哨兵空选项)/Badge(Pill 组件+dot)/Progress(transform 技法)/Alert(destructive 紧凑档·warning amber 淡底·default 品牌淡底)；宿主 primitives Button(9 位 primary→default 等)/Input(6 位) 一并换 shadcn 件（icon prop → children）；LIST_TITLE 补官网 h2 签名 tracking-tight；侧栏导航按钮按 D20c 官网签名保留手写 | 4,159,987 B |
| S23-4 | e1c4baa | teamsButton 弹层迁移：tab 头手写按钮 → shadcn Tabs 分段控件（触发器紧凑档 + 激活 DSW 蓝文字签名）；footer 虚线新增钮 → shadcn Button outline+dashed；触发钮宿主 Button → 库件 ghost（同 token 同观感，摆脱宿主件依赖） | 4,167,589 B |
| S23-5 | （本次） | card.tsx 进度条 → Progress（bg-primary=DSW 蓝）；buildCard 两枚 pill → Badge；heroTeamsButton 文字兜底换官网 slate-900、focus 环 DSW 蓝源（S23-1 已换）；teamsPanel 核验达标（shadcn Button + 宿主桥中性表面，不动） | 4,167,558 B |
| S23-6 | — | — | — |
| S23-7 | — | — | — |
