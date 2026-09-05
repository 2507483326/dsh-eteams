# 41 Markdown 渲染 Typeset 排版（shadcn/typeset 引入）

> 用户指令：「引入 https://ui.shadcn.com/docs/components/base/typography 排版 优化目前的MD渲染」。
> 本文是设计合同：现状取证、引入对象、端口决策（含特异性纪律与宿主中和表）、实施步骤、验收清单全部在此定稿。执行按 41.5 推进。
> 范围：`src/client/styles/eteams.css`（追加端口段）+ 新增 `src/client/pages/teamsView/markdownDoc.tsx` + 四消费点替换。非目标见 41.7。
> 绿基线（开工前实测）：`pnpm typecheck` / `pnpm lint` / `pnpm build` 全绿（2026-09-05，master 08bf08c）。

## 41.0 结论先行

把 shadcn 新排版系统 **typeset**（「One CSS file you own」）以**手工端口**方式落进 `eteams.css`（平铺、限定 `.eteams-ui`、token 重绑到 D22a 官网化语义 token），新增 13 行包装组件 `MarkdownDoc` 包住宿主 `MarkdownText`，替换**四处**只读渲染点（手册卡 ×2 + 任务合同 ×2）。零构建链变更（端口段是手写平铺 CSS，tailwind v3 CLI 剥掉 @layer 包装后内容原样压平进 gen.css），暗色零分支（token 经 `.eteams-ui` 语义层自动换值）。

## 41.1 引入对象：shadcn/typeset

- 文档页 https://ui.shadcn.com/docs/components/base/typography（新文档站该页即 typeset 页，实抓取证 2026-09-05）。
- canonical 源文件：`shadcn-ui/ui@main` 仓库 `apps/v4/app/(app)/(typeset)/typeset.css`，commit `7c9eaba1c0a6404c990c144a654792e3313c650d`（2026-09-04），491 行 / 12.2 KB。**无 npm 包、无 registry 条目**——官方定位就是「复制到你项目里的一个 CSS 文件」，由 typeset builder 生成；本设计以该 canonical 文件为端口基线，而不是 builder 产物（builder 只改预设值，结构同源）。
- 系统形态：容器类 `typeset` + 预设类（改 `--typeset-size / --typeset-leading / --typeset-flow` 三控制）。全部元素规则经 `:where()` 零特异性 + not-typeset 逃生门；间距只走 `margin-block-start` 单向流（streaming 稳定，无 `:last-child` / `:has()` 布局依赖）。
- 与 @tailwindcss/typography（prose）的取舍（官方对照）：尺寸随容器而非 rem 定档、直接吃应用 theme token（暗色自动）、覆盖用普通工具类即胜。这正是本项目要的——docs/24 官网化 token 已在 `eteams.css` @layer base 定档，MD 渲染面应直接消费它。

## 41.2 现状取证

### 41.2.1 MD 渲染面盘点

只读 Markdown 渲染共**四处**，都是宿主 `@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText`（mdast→React 语义渲染，GFM + KaTeX，raw HTML 关闭）：

| # | 位置 | 内容 |
|---|---|---|
| 1 | `src/client/pages/teamsView/teamMembers.tsx:491` | 成员/领队手册卡只读视图（`handbookSeed(view.source)`，h1 成员名 + 字段列表 + h2 章节 + personaMd 全文） |
| 2 | `src/client/pages/teamsView/membersTab.tsx:1169` | 成员详情·角色手册卡只读视图（同源内容） |
| 3 | `src/client/pages/teamsView/taskDrawer.tsx:48` | 任务详情·合同区（`ContractMd`，contractMd 一篇 Markdown 只读渲染） |
| 4 | `src/client/pages/teamsView/tasksTab.tsx:692` | 任务列表卡展开区（contractMd 只读渲染） |

编辑面 `MdEditor`（features/mdEditor，mdxeditor WYSIWYG + 自有主题桥）**不在本设计范围**——它有自己的排版体系与暗色桥，另立迭代。

### 41.2.2 宿主样式事实（node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/markdown/MarkdownText.module.css，实抓）

- DOM：`MarkdownText` 恒渲染单根 `<div class=css-modules哈希类>`（bundle `index.js:5623-5626`），块级子元素 p / h1-h6 / ul,ol,li / table（外包 `.tableScroll`） / blockquote / hr / img / a / strong / del / sup / input[checkbox]；围栏代码走 `CodeBlock` 组件，根 class 复合含**全局类 `md-code-block`**（`index.js:5015`）；行内代码 `:not(pre) > code`。发射元素全集（index.js 实证）：a / blockquote / br / code / del / em / h1-h6 / hr / img / input / li / ol / p / pre / strong / sup / table / thead / tbody / tr / ul——mark / kbd / details / dl / figure / sub / abbr 永不出现（端口对应规则属零代价预留）。
- 内根声明：`font: var(--dsw-font-markdown-base); color: var(--dsw-alias-label-primary); min-width: 0; overflow-wrap: anywhere`。**font/color 是元素上的复声明**——外层容器设什么字号字色都传不进内根（继承被截断），这是端口必须正面处理的第一堵墙。
- 元素规则特异性实测：`.markdown h1-h3 { font: var(--dsw-font-markdown-h1..h3); margin: 32px 0 16px }`、`.markdown h4 { …; margin: 16px 0 }`、`:where(h5,h6) { font: --dsw-font-markdown-base-strong; margin: 16px 0 }`（module.css:16-39，均 (0,1,1)）；`.markdown p { margin: 16px 0 }` = (0,1,1)；`.markdown :not(pre) > code`（行内 code chip）= **(0,1,2)** 且 `font-size: 0.875em !important`（module.css:152）；`.markdown li:not(:first-child) { margin-top: 6px }` = **(0,2,1)**；`.markdown a` = business 蓝链 + 透明边框命中区 + `a:focus-visible` 宿主蓝 box-shadow 焦点环（module.css:81-83）；`.markdown > *:first-child, .markdown p:first-child { margin-top: 0 !important }` 与对应 last-child 对称规则 = (0,2,1)+**`!important`**（module.css:219-227）——`!important` 压过端口无 important 声明，首末元素上下距归零由宿主规则达成（与 typeset 单向流同果，见 41.3.8）。宿主面最强普通规则 = (0,2,1)（`li:not(:first-child)`、`input[type='checkbox']`、`p:first-child` 同档）。
- `.tableScroll th/td` 另声明 `border-bottom: 1px solid var(--dsw-alias-border-l3/l2)` 与 `font: var(--dsw-font-markdown-table-head/table)`（module.css:186-204）——单元格底线与表格字体不在 canonical 表格声明集内，是端口必须显式中和的第三堵墙（41.3.7#8）。
- `CodeBlock` 自有 chrome（banner 语言条 + shiki 高亮 + 深底），且 `.block :where(pre) { margin: 0 !important }`——代码块是完整宿主组件，端口不得触碰。
- 语义割裂现状：面板已「官网化」（docs/24：slate + sky 唯一强调 + Inter/Fira Code，token 在 `eteams.css` @layer base 的 `.eteams-ui` 上），MD 渲染面仍走宿主 `--dsw-*`（neutral-bluish 灰蓝、宿主字号），同一张卡里两种色系两种字号；h1-h3 一律 32px 上边距对卡片密度过重。

### 41.2.3 mini-preflight 相互作用（eteams.css D22c）

- `.eteams-ui :where(h1..h6, p):not(:where(.eteams-mdx…)) { margin: 0 }`（(0,1,0)）：宿主 (0,1,1) 规则压过它，所以现状标题/段落边距来自宿主。端口规则 (0,3,0) 全量接管后，mini-preflight 只在端口未声明的轴上兜底，无冲突。
- 刻意不加 ul/ol 复位的决策不变：端口块自行声明列表 margin/padding/list-style（(0,3,0) 接管），mini-preflight 注释段补一句指向 docs/41。

## 41.3 端口决策（定稿）

### 41.3.1 落点与形态

`src/client/styles/eteams.css` 末尾新增 `@layer components` 端口段（utilities 输出在其后，工具类赢平局的次序不变）。**手工平铺**：canonical 的 CSS 嵌套（`&:where(...)`）不依赖构建链转译，全部展开为平选择器；不用 @apply。tailwind v3 CLI 对手写块的处理（承重事实，docs/21:64 与 eteams.css:154-161 既有结论 + tailwindcss 3.4.19 `setupContextUtils.js` collectLayerPlugins 实证）：**@layer 包装被剥离压平**——若 @layer 作为真级联层存活，无 layer 的宿主样式会无条件压过整个端口段，特异性算式全部失效；实际产物无 @layer，输出次序 base → components → utilities，内容原样不改写选择器。**零构建链变更**。

### 41.3.2 选择器纪律：恒 (0,3,0)

所有元素规则写成同一形态：

```css
.eteams-ui .eteams-md.typeset :where(X):not(:where(<逃生门>)) { … }
```

特异性 = `.eteams-ui`(0,1,0) + `.eteams-md`(0,1,0) + `.typeset`(0,1,0) = **(0,3,0)**，`where()` 归零：

- **压过宿主最强规则 (0,2,1)**（`.markdown li:not(:first-child)`、`input[type='checkbox']`、`p:first-child` 档；行内 code chip 实为 (0,1,2)），且不再依赖「宿主 CSS 先注入、平局归后手」的注入顺序假设——宿主 CSS Modules 的注入时机不在本仓控制内，(0,3,0) 让平局根本不发生。
- 代价（明示接受）：面板工具类 (0,2,0) 在 typeset 子树内输给端口规则。现状两表面不对 md 元素挂工具类（消费点核实过），not-typeset 逃生门仍可用；若未来要在手册内部用工具类调某元素，挂 `not-typeset` 或提升到容器层。

### 41.3.3 内根复位（拆第二堵墙）

```css
.eteams-ui .eteams-md.typeset > :first-child { font: inherit; color: inherit; }
```

宿主内根复声明 `font:` / `color` 截断继承，端口根样式传不进去；此规则 (0,4,0) 结构寻址（不依赖 CSS Modules 哈希类名，D22c 注释已断言其不可寻址）把内根的 font/color 复位为继承，全部排版从 `.typeset` 容器流下去。`min-width: 0` / `overflow-wrap: anywhere` 等非 font/color 声明保留（正是想要的 CJK/长 URL 行为）。font 简写按 CSS Fonts 4 会把 font-feature-settings 等 reset-implicitly 子属性重置为 initial（Chromium 111 起实现），但 `font: inherit` 作为 CSS-wide 关键字把**全部**长手（含 font-feature-settings）置为 inherit，`.eteams-ui` 的 cv02/03/04/11 特性经继承流入内根正文；宿主 h1-h4 自身 font 简写使其复位为 normal，与现状一致，不处置。

### 41.3.4 逃生门扩充

canonical 逃生门 `.not-typeset, [data-not-typeset], .not-typeset *, [data-not-typeset] *` 增补 **`.md-code-block, .md-code-block *`**：宿主 CodeBlock 是完整组件（banner/shiki/自带 !important），端口 pre/code 规则全量豁免之，代码块 chrome 维持宿主样式。

### 41.3.5 token 重绑（typeset 吃本项目 theme）

| canonical 引用 | 端口绑定 | 备注 |
|---|---|---|
| `--color-foreground` | `var(--foreground, currentColor)` | D22a slate-900 / 暗色 slate-200 |
| `--color-muted-foreground` | `var(--muted-foreground, …)` | slate-500 / slate-400 |
| `--color-border` | `var(--border, …)` | slate-200 / slate-800 |
| `--color-primary` | `var(--primary, currentColor)` | sky-500 / sky-400 |
| `--color-ring` | `var(--ring, currentColor)` | sky-500 / sky-400 |
| `--color-muted` | `var(--muted, …)` | slate-100 / slate-800（行内 code / pre 底） |
| `--radius` | `var(--radius)` | 已定义 0.75rem |
| `--font-heading` | `var(--eteams-font-sans)` | 无独立标题字体 |
| `--font-mono` | `var(--eteams-font-mono)` | Fira Code Variable 打头 |
| `--typeset-muted`（派生） | `var(--muted-foreground, color-mix兜底)` | 去 canonical 的 color-mix 必经路径——token 恒有定义，color-mix 仅作兜底文本 |
| `--typeset-rule`（派生） | `var(--border, color-mix兜底)` | 同上 |

canonical 内联 color-mix（链接下划线 30% / mark 底）原样保留：老 Chromium 优雅退化（下划线声明整体弃置→全色下划线；mark 底色弃置→回落 UA 黄底），且宿主渲染器永不发射 mark（41.2.2 发射元素全集），不做兼容分支。

### 41.3.6 预设值（typeset-eteams 并入端口块）

本仓消费语境统一为面板只读卡（手册 + 任务合同），预设不单列类，直接写进端口 `.typeset` 块并注释标明等价于 builder 的 preset：

- `--typeset-size: 13px`（对齐 mdEditor `.eteams-mdx-content` 的 13px 面板密度，读/编同密度；mdEditor 实为 `var(--dsw-font-markdown-base-line-height, 1.7)` 跟随宿主 token，端口对只读面硬编码 13px，两表面字级一致即可）
- `--typeset-leading: 1.7`（同上口径）
- `--typeset-flow: 1.25em`（canonical 默认 ≈16px，与宿主现行段落距 16px 衔接）

字号层级随容器：h1 22.75px / h2 16.25px / h3 14.6px / h4 13px（13px 基 × canonical 档位）。D22d 的 14px 卡片语境（合同区所在任务卡）里取 13px 是统一 MD 面密度的有意决策——四表面共用同一预设，不按卡片分档。

### 41.3.7 对 canonical 的偏差表（全部明示）

| # | canonical | 端口 | 理由 |
|---|---|---|---|
| 1 | 容器 `font-size: calc(var(--typeset-size) * 1.125)` 为基础档 + `<48rem` media 恢复 1× | **删 media 块，基础档直写 `font-size: var(--typeset-size)`** | 桌面面板（含窄侧栏）非手机场景，恒定 13px 密度，不做响应式放大 |
| 2 | 链接 `color: inherit` | 链接 `color: var(--primary)` + 下划线 30% mix、hover 全色 | sky 是面板唯一强调（docs/24），蓝链 affordance 不回退 |
| 3 | 逃生门四项 | 增补 `.md-code-block` 两项 | 41.3.4 |
| 4 | token 引用 `--color-*`/`--font-*` | 重绑 D22a token | 41.3.5 |
| 5 | hr 仅 `border: 0; border-block-start` | 增补 `height: auto; background: transparent` | 宿主 hr 声明 `height: 1px; background: border-l2` 会与端口 border 叠成 2px 双线（宿主中和，见 41.3.8） |
| 6 | `li > p` 仅 margin-block-start 0.5em | 增补 `margin-block-end: 0` | 宿主 `li > p { margin: 8px 0 }` 的 block-end 8px 残留会造成列表内上下距不均 |
| 7 | 表格规则：table 上 `border-block-end`、tbody/tfoot 单元格上 `border-block-start`，不声明单元格 border-bottom 与 font | 端口 `thead th` / `:is(tbody,tfoot) :is(td,th)` 增补 `border-bottom: 0; font: inherit` | 宿主 `.tableScroll th/td` 的 alias 底边线 + `font: var(--dsw-font-markdown-table*)` 不在端口声明集内，`border-collapse: separate`（端口接管）下每条行分隔线 = 端口 1px slate 顶线 + 宿主 1px alias 底线叠成 2px 双色线、表格字体停留宿主档——必须显式中和 |
| 8 | `a:focus-visible` 仅 outline（ring 色） | 增补 `box-shadow: none` | 宿主 `a:focus-visible` 的宿主蓝 box-shadow（module.css:81-83）会与端口 sky outline 叠加出双焦点环 |
| 9 | 其余全量保留（kbd/details/dl/footnotes/figure/math/typeset-scroll/print/forced-colors） | 原样平铺 | one CSS file you own；宿主渲染器未发射的元素零代价（41.2.2 发射全集坐实），未来表面免再移植 |

### 41.3.8 宿主中和表（端口后存活/死亡的宿主声明复核）

| 宿主声明 | 特异性 | 端口后 | 处置 |
|---|---|---|---|
| 内根 `font:` / `color` | (0,1,0) | 死 | 41.3.3 复位继承 |
| `h1-h3 font/margin 32px`、`h4`（及 :where(h5,h6)）`16px` | (0,1,1) | 死 | 端口 h 档接管 |
| `p { margin:16px 0 }` | (0,1,1) | 死 | 端口 flow 单向流 |
| `:not(pre)>code` chip | (0,1,2)+`!important` 字号 | 死（字号例外） | 端口 chip 接管底/距/族；宿主 `font-size: 0.875em !important` 存活，0.875em≈0.85em 视觉等价，接受 |
| `li:not(:first-child)` 6px | (0,2,1) | 死 | 端口 li 0.5em |
| `.tableScroll table { collapse, width:max-content }` | (0,1,1) | 半死 | 端口接管的属性（collapse→separate、边框、padding、th nowrap）归端口；宽度/滚动宿主存续（`.tableScroll` 滚动机制保留） |
| `.tableScroll th/td` 单元格 border-bottom + `font:` | (0,1,1) | 死 | 41.3.7#7 显式中和（双线/宿主表格字体） |
| `> *:first-child / p:first-child`（及 last 对称）margin `!important` | (0,2,1)+`!important` | **活（同向）** | 首末元素上下距归零与单向流同果；端口同轴声明被其压制，结果一致，验收取证时归属须注明（41.5.3） |
| `a` 透明边框命中区 | (0,1,1) | **活** | 端口不声明 border，命中区保留 |
| `a:focus-visible` 宿主蓝 box-shadow | (0,1,1) | 死 | 41.3.7#8 `box-shadow: none`，焦点环统一端口 outline（ring 色） |
| `hr height/background` | (0,1,1) | 死 | 41.3.7#5 中和 |
| `li > p { margin: 8px 0 }` | (0,1,2) | 半死 | block-start 归端口，block-end 由 41.3.7#6 归零 |
| `strong 600` / `li::marker` 行高 / `input[checkbox]` margin | (0,1,1)/(0,2,1) | 活/共存 | 值与端口一致或互补，不处置 |
| CodeBlock 全套 | `.block :where(pre)` + `!important` | 活 | 41.3.4 全量豁免 |

### 41.3.9 包装组件

新增 `src/client/pages/teamsView/markdownDoc.tsx`（camelCase 随 mdEditor.tsx 先例；四处消费点均在 teamsView，就近放置，暂不上提 components/）：

```tsx
export function MarkdownDoc({ text }: { text: string }): ReactNode {
  return (
    <div className="typeset eteams-md">
      <MarkdownText text={text} />
    </div>
  );
}
```

`MarkdownText` 由组件自行从 primitives import（消费点原导入移除或转由 wrapper 承担）。`typeset`（系统类名）+ `eteams-md`（特异性双类）都必须是字面量。样式注入不新增通道——端口段随 gen.css 走既有 `ensureEteamsStyles()`（index.tsx apply 已调）。

### 41.3.10 消费点替换

| 位置 | 现状 | 改为 |
|---|---|---|
| `teamMembers.tsx:491` | `<MarkdownText text={display} />` | `<MarkdownDoc text={display} />` |
| `membersTab.tsx:1169` | `<MarkdownText text={handbookSeed(detail)} />` | `<MarkdownDoc text={handbookSeed(detail)} />` |
| `taskDrawer.tsx:48` | `ContractMd` 内 `<MarkdownText text={text} />` | `<MarkdownDoc text={text} />`（「任务合同：」标签 span 保持在 wrapper 外） |
| `tasksTab.tsx:692` | `{t.contractMd !== null && <MarkdownText text={t.contractMd} />}` | `{t.contractMd !== null && <MarkdownDoc text={t.contractMd} />}` |

import 收敛：`teamMembers.tsx:11` / `tasksTab.tsx:45` / `taskDrawer.tsx:15` 的 MarkdownText 是各自唯一的 primitives 导入 → 整行移除；`membersTab.tsx:14-19` 仍用 IconPlusOutline16 / IconSparkle16 / writeClipboard → 仅从导入块剔除 `MarkdownText`。

### 41.3.11 暗色

零分支：端口段只引用 `.eteams-ui` 语义 token，`body[data-ds-dark-theme] .eteams-ui` 块换值即整体换肤（D22a 不变式，不引 dark: 变体）。

## 41.4 实施步骤（文件级，串行）

1. `src/client/styles/eteams.css`：末尾追加「typeset 端口」`@layer components` 段（按 41.3 定稿逐条平铺，含宿主中和与逃生门扩充），mini-preflight 注释段补一行指向 docs/41，文件头注补一行「typeset 端口段」说明。
2. 新增 `src/client/pages/teamsView/markdownDoc.tsx`（41.3.9，含端口说明头注）。
3. `teamMembers.tsx` / `membersTab.tsx` / `taskDrawer.tsx` / `tasksTab.tsx`：替换四消费点、收敛 import（41.3.10）。
4. 门禁 + 样张目检（41.5）。

长文件只做小步 Edit，不整文件重写（历史教训：长中文重文件一次性 Write 易产出损坏代码）。

## 41.5 验收清单

1. **四绿门禁**：`pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build` 全绿；build 台账记录 gen.css 字节增量（canonical 12.2KB 平铺 + 每选择器 ~30B 作用域前缀 ×~140 选择器，minify 后估 +12~14KB，以台账实跑为准）。
2. **静态样张目检**：临时 HTML 样张（h1-h6 / 多级列表 / 表格 / 行内 code / 围栏代码 / 引用 / hr / 链接 / 任务列表 / 中文混排），直接挂构建产物 lib/tailwind.gen.css。**样张根元素必须挂字面类 `eteams-ui`**（语义 token、工具类与端口段选择器全部锚定它，tailwind.config.ts important 纪律），MD 容器另挂 `typeset eteams-md`；暗色按 `body[data-ds-dark-theme]` 祖先模拟。截图核对：字号层级、单向流间距、code chip 底、表格分隔线（无双线）、暗色换肤。
3. **结构断言**：样张 DOM 上核对逃生门（md-code-block 内 pre 不吃端口 pre 规则）、内根复位生效（computed font-family = Inter Variable 打头栈、font-size 13px）；首末元素上下距归零**归属注明**（宿主 `!important` 规则达成，41.3.8）。
4. **宿主内实测如实标注**：无真实 DSH 宿主环境，宿主注入顺序下的最终渲染标「未验证」——(0,3,0) 纪律已把平局可能性归零，此为设计兜底而非实测结论。
5. 验收记录回填本文档 41.6（不另立文件）。

## 41.6 验收记录

2026-09-05 执行；独立验收子 agent 按本清单逐项复核，结论「通过」。

**四绿门禁**：typecheck ✓（host + client 两 project 零输出退出）；lint ✓ 0 errors / 2 warnings（react-hooks/exhaustive-deps：memberDialog.tsx:38、taskDrawer.tsx:117，均为既有遗留、不在本次变更集）；vitest ✓ 23 文件 317 用例全过；build ✓ `SMOKE OK: id=dsh-eteams, exports=[apply, inject]`。

**gen.css 台账**：152,718 → 171,647 B（**+18,929 B**，高于 41.5.1 估的 +12~14KB——79 组选择器每条带 6 段豁免名单的 `:not(:where(...))` 前缀，比估算模型贵）。产物 minify 后全文件 0 注释，41.5.1 的「注释锚点顺序」断言以特征选择器字节偏移等价取证：base token 116026 → base 暗色覆盖 116801 → components 117534 → typeset 端口段 118713–137436 → utilities 137980，单调递增，端口为 utilities 前最后一个 components 段（v3 拍平后无任何 `@layer` at 规则幸存，计数 = 0）。

**结构断言（产物级，验收 agent 全量核对）**：79 组选择器全部 (0,3,0) 形态且豁免名单含 `.md-code-block`；容器三控制 `13px / 1.7 / 1.25em` 直写、无 media 包裹（偏差#1，全文件 `48rem` 计数 = 0）；内根 `>:first-child{font:inherit;color:inherit}` 在产物；偏差#5（hr `height:auto;background:transparent`）、#6（`li>p{margin-block-end:0}`）、#7（thead th 与 tbody/tfoot 单元格 `border-bottom:0;font:inherit`）、#8（`a:focus-visible` ring + `box-shadow:none`）逐条命中。

**静态样张**（`.tmp-typeset-preview/`，launch.json `typeset-preview`：挂构建产物 gen.css + 宿主 MarkdownText.module.css 关键声明拟态，在中抗中验证而非空页；CSS 改动后需重拷 `cp lib/tailwind.gen.css .tmp-typeset-preview/`）。computed style 断言：

| 断言 | 亮色 | 暗色 |
|---|---|---|
| 容器 font-size / line-height | 13px / 22.1px（1.7×） | 同 |
| 容器 color | slate-900 (15,23,42) | slate-200 (226,232,240) |
| 内根 font-size（复位胜宿主 15px 声明） | 13px | 同 |
| h1 | 22.75px / 600 / 首子 block-start 0 | 同 |
| h2 margin-block-start | 28.4375px（flow×1.4，em 取 h2 自身 16.25px） | 同 |
| 链接 color | sky-500 (14,165,233) | sky-400 (56,189,248) |
| 行内 code chip | 底 slate-100、Fira Code 栈、radius 3.98px | 底 slate-800 |
| blockquote 左缘 | 2px slate-200 | slate-800 |
| hr | background transparent + 单根 1px 上边（宿主双线源被中和；margin-top 39px = flow×2.4） | 同 |
| td / th | `border-bottom-width:0`、`border-block-start-width:1px`、td font-size 13px（`font:inherit` 胜宿主表格字体）、th nowrap | 同 |
| `.md-code-block pre` | 宿主深底 rgb(13,17,23) 原样（豁免生效） | 同 |
| 首末子边距 | 0（宿主 `!important` 同向达成，41.3.8） | 同 |
| 相邻 li 间距 | 6.5px（端口 0.5em 胜宿主 6px） | 同 |

截图目检（亮/暗各一）：字号层级、单向流间距、chip 底、表格单分隔线（无双线）、hr 单线、围栏代码原貌均符合；暗色仅 token 换肤、结构零变化（41.3.11 零 dark: 分支成立）。两点注记：① 样张 panel 底为拟态硬编码 #fff 不随暗色翻转，真实面板 `bg-background` 随 token 翻转——样张拟态限界，非实现缺陷；② 样张无上游 font-sans，内根 computed font-family 落到浏览器默认——`--typeset-font-body: inherit` 按设计继承面板语境字体，41.5.3 的「Inter Variable 打头栈」在样张上只能验「继承生效」，栈本身由真实面板语境供给。

**诚实性标注**：无真实 DSH 宿主环境，宿主注入顺序下的最终渲染**未验证**——(0,3,0) 纪律把平局可能性归零是设计兜底，非实测结论（41.5.4）。MdEditor 编辑面未动（41.7）。

**独立验收**：验收子 agent 重跑四绿门禁、全量核对 gen.css 79 组选择器形态与偏差落地、grep 消费点收敛（`MarkdownText` 的 primitives import 全仓仅剩 markdownDoc.tsx 包装实现一处，其余命中均为注释）——结论「通过」，本节由实现侧据其报告与实测数据回填。

## 41.7 非目标

- 不动 `MdEditor`（mdxeditor 编辑面排版/主题桥）——编辑面有自己的体系，如需对齐另立迭代。
- 不动宿主 `MarkdownText` 渲染语义（frontmatter 透传渲染等现状行为保持）。
- 不引 npm 排版依赖（typeset 定位即一个自持 CSS 文件）；不动 tailwind 配置与构建链。
- 不做 <48rem 响应式字号（41.3.7#1 已决策删除）。