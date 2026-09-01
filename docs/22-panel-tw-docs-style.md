# 22 面板视觉升级：Tailwind 官网风格 + 动态背景板

> 用户指令：①页面整体风格做成 tailwind 官网（tailwindcss.cn/docs/installation）的风格，仔细研读它的侧边栏、颜色、字体；②背景做成右上角格子 + 高地图、渐隐到左下角、上面有微小像素坦克移动的背景板，不能喧宾夺主。请仔细规划这两个功能，分步骤分模块进行开发和验收。
> 本文是这次升级的设计与施工合同：调研结论、模块拆解（每步范围 → 四绿门 → commit）、验收标准全部在此定稿，工作流按步执行。延续 docs/21 的 D19 系列纪律（作用域/令牌桥/小步快跑），本文决策编号接续为 D20 系列。

## 22.1 调研结论（tailwindcss.cn 实测抓取，非凭印象）

> 证据：`.tmp/tw-docs/tw-installation.html`、`tw-home.html` 与主样式表
> `_next/static/css/45d7161e2c498169.css`（v3 镜像站真实产物，2026-09 抓取）。

### 22.1.1 颜色

| 用途 | 浅色 | 暗色 |
| --- | --- | --- |
| 强调（激活/链接/品牌） | `sky-500 #0ea5e9` | `sky-400 #38bdf8` |
| 标题 | `slate-900 #0f172a` | `slate-200 #e2e8f0` |
| 正文/导航常态 | `slate-700 #334155` | `slate-400 #94a3b8` |
| 次级文字 | `slate-600 #475569` | `slate-400` |
| 弱化文字 | `slate-400 #94a3b8` | `slate-500 #64748b` |
| 侧栏细线 | `slate-100 #f1f5f9` | `slate-800 #1e293b` |
| hover 指示 | `slate-400` | `slate-500` |
| 页面底色 | `white` | `slate-900 #0f172a` |

### 22.1.2 字体

- 无衬线：`"Inter var"`（可变字重 100–900），兜底 `ui-sans-serif, system-ui, sans-serif, …`
- 等宽：`"Fira Code VF"`（可变字重 300–700），兜底 `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, …`
- 本仓**不打包字体文件**（无网络资产管线、宿主注入场景体积敏感）：令牌给出完整字体栈，用户/宿主装有 Inter/Fira Code 即用，未装落系统兜底——视觉风格在有字体环境下与官网一致。

### 22.1.3 侧边栏（docs 左栏，实测标记）

```html
<h5 class="mb-3 font-semibold text-slate-900 dark:text-slate-200">入门</h5>
<ul class="space-y-2 border-l border-slate-100 dark:border-slate-800">
  <li data-active><a class="block border-l pl-4 -ml-px
      text-sky-500 border-current font-semibold dark:text-sky-400">安装</a></li>
  <li><a class="block border-l pl-4 -ml-px border-transparent
      hover:border-slate-400 dark:hover:border-slate-500
      text-slate-700 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-300">编辑器设置</a></li>
```

设计要点（逐条进实现）：

1. 分组标题：semibold、主文字色、不加图标不加大小写变换。
2. 列表整体一条**连续左细线**（slate-100/slate-800）。
3. 每个链接自带 1px 左边线（默认透明、`-ml-px` 压在列表线上），`pl-4` 让文字离线 16px。
4. hover：左边线亮起（slate-400/500）+ 文字加深；**激活：文字 sky + 左边线 `border-current` 同色 + semibold**——这是官网侧栏的签名交互。
5. 侧栏顶部还有 `Quick search…` 样式的输入框：`text-sm leading-6 text-slate-400 rounded-md ring-1 ring-slate-900/10 shadow-sm dark:bg-slate-800`（供面板侧栏筛选/提示条参考）。

### 22.1.4 标题与正文排版

- h1 `text-3xl/4xl font-extrabold tracking-tight`、h2 `text-xl font-bold tracking-tight`、h3 `font-semibold`，全部 slate-900（暗 slate-200）。
- 官网首页**网格背景**的真实做法：`bg-grid-slate-900/[0.04]`（暗 `slate-100/[0.03]`）+ `[mask-image:linear-gradient(...)]` 渐隐——「低调背景板」的官方先例，直接为本期背景板定调：**网格线极淡、渐隐 mask、绝不与内容争对比度**。

## 22.2 目标与非目标

**目标**：

1. 面板（`ETeamsView` 会话 tab 与整页两种挂载面共用）整体风格对齐官网：侧栏、颜色、字体、标题排版。
2. 新增面板背景板：右上角网格 + 高地图着色、向左下角渐隐、其上有微小像素坦克沿网格线缓慢移动；`pointer-events: none`、低透明度、跟随亮暗主题、`prefers-reduced-motion` 降静态。

**非目标**：

- 不改 `src/host/`；不动 `mdEditor.tsx`（自带样式体系）；`teamsButton.tsx` 弹层与 `card.tsx` 会话卡片本期只保证不受副作用影响，不做全面改版；`heroTeamsButton` 纯 DOM 注入不在范围。
- 不打包字体文件、不引入 `dark:` 变体（D19c 主题桥不变）、不改任务/执行链语义。

## 22.3 决策记录（D20 系列）

| # | 决策点 | 结论 |
| --- | --- | --- |
| D20a | 主题接入方式 | 延续 D19c 令牌桥：亮暗跟随宿主 `--dsw-alias-*`，**字面兜底值换成官网色板**（sky-500/slate 系，见 22.1.1）；不引入 `dark:` 变体 |
| D20b | 字体令牌 | `eteams.css` @layer base 新增 `--eteams-font-sans/-mono` 字体栈令牌（22.1.2），tailwind.config.ts `fontFamily.sans/mono` 消费；壳从 `[font-family:inherit]` 换 `font-sans`，等宽面统一 `font-mono` |
| D20c | 侧栏形态 | 按官网签名做：分组标题 + 连续左细线 + 链接自带左边线（透明→hover 亮）+ 激活 `text-primary border-current font-semibold`；宽度自 84px 加宽到 **172px**（官网 15rem 等比收窄，面板内容区窄） |
| D20d | 背景板架构 | **纯逻辑引擎 + 薄 React 壳**：`backdropEngine.ts` 只做确定性的纯计算（高度场/渐隐 alpha/坦克步进/调色板采样映射），`eteamsBackdrop.tsx` 只做 canvas/DPR/rAF/可见性/降运动接线——引擎可进 vitest（node 环境无 DOM），组件不写渲染单测（21.5.4 口径） |
| D20e | 背景板「不喧宾夺主」硬指标 | 全局合成不透明度上限 0.5；网格线 alpha ≤ 0.05（对齐官网 [0.04]）；高地图着色 alpha ≤ 0.07；坦克 ≤ 3 辆、每辆 ≤ 0.4 alpha；`pointer-events:none` + `aria-hidden`；静层（网格+高地图）缓存离屏 canvas，仅 resize/换主题重绘；动层 30fps；页面隐藏即暂停 |
| D20f | 坦克行为 | 沿网格线行驶（网格线即路），等速 10–16px/s，随机间隔 4–9s 在网格交点转向；活动范围约束在渐隐 alpha ≥ 0.3 区域（溜出即朝区域内转向）；sprite 为 7×5 逻辑像素（每像素约 2.2px），slate 系车身 + 少量 sky 点缀 |
| D20g | 渐隐方向 | 官网 mask 是「顶部实、向下渐隐」；本期按用户指令为**右上角实、向左下角渐隐**：`alpha(u,v) = 1 − smoothstep(0.08, 0.85, d)`，`d = ((W−x) + y) / (W+H)`（d=0 在右上角、1 在左下角），网格/高地图/坦克统一乘该系数 |
| D20h | 主题采样 | 画布颜色从宿主变量实时采样（`getComputedStyle(document.body)` 读 `--dsw-alias-*`），MutationObserver 监听 `body[data-ds-dark-theme]` 失效缓存重绘静层；采样失败落官网字面色兜底 |
| D20i | 步进纪律 | 延续 D19f：每模块一步，范围（inScope）→ 四绿门（`pnpm typecheck && pnpm lint && pnpm test && pnpm build`）→ 体积记录 → 独立 commit；工作分支 `feat/panel-tw-docs-style` |

## 22.4 模块拆解（每步一个验收面）

### S22-0 基线（M0）

- 范围：`scripts/buildTailwind.mjs`（既有沙箱退化修复，独立成 commit）；四绿门基线 + `lib/client.js` 体积记录；本文档入库。
- 验收：四绿门全绿（基线 = 主分支现状）；文档合并入 docs/。

### S22-1 设计令牌：字体 + 官网色板兜底（M1）

- 范围：`src/client/eteams.css`（字体令牌 + shadcn 语义 token 兜底值换官网色板：primary→sky-500、foreground→slate-900、muted-foreground→slate-500 等）、`tailwind.config.ts`（fontFamily sans/mono）、`eteamsView.tsx` 仅壳与等宽芯片两处类名换 font 工具类。
- 不变式：宿主别名桥逐字保留（只动兜底字面值）；`/alpha` 禁令不破。
- 验收：四绿门；`lib/tailwind.gen.css` 含新字体栈与新兜底值；面板无视觉回归（token 别名在宿主环境下优先于兜底，理论上仅暗色精调的兜底差可见）。

### S22-2 侧栏 Tailwind-docs 化（M2）

- 范围：`eteamsView.tsx` 的 `RAIL_CLASS`/`railBtnClass`/`tabs` 渲染段（宽度 172px、分组标题「团队面板」、左细线列表、链接左边线三态）。
- 验收：四绿门；gen.css 含 `border-current`/左线三态类；激活态 = sky 文字 + 同色左线 + semibold。

### S22-3 背景引擎（M3，纯逻辑）

- 范围：新增 `src/client/backdropEngine.ts`（值噪声高度场、D20g 渐隐、坦克步进/sprite/转向、调色板采样映射、静层绘制指令序列）+ 新增 `tests/backdropEngine.test.ts`。
- 验收：四绿门 + 新单测绿（确定性、值域、渐隐单调性、坦克贴线与边界回转、降运动冻结）。

### S22-4 画布组件与接线（M4）

- 范围：新增 `src/client/eteamsBackdrop.tsx`（canvas 壳：DPR≤2、ResizeObserver、静层离屏缓存、30fps 动层、visibilitychange 暂停、reduced-motion 静帧、D20h 主题采样）；`eteamsView.tsx` 接线（作用域根 `position:relative`、画布 absolute inset-0 打底、壳 relative 盖上）；README M4 一览补一行。
- 验收：四绿门；smokeEnvelope 冒烟仍绿；`.eteams-ui` 字面量不被 purge（画布根无工具类依赖，作用域根类名在 eteamsView 不变）。

### S22-5 预览与总验收（M5）

- 范围：`.tmp/`（gitignored）生成独立预览页（tsc 单文件编译引擎 + 静态 HTML 驱动真实引擎代码），供用户在浏览器打开做视觉验收；最终报告（四绿门结果、体积、commit 清单）。
- 验收：用户视觉确认背景板「低调、右上格子高地图、左下渐隐、坦克微小不抢戏」；侧栏/配色/字体与官网风格对齐。

## 22.5 风险与对策

| 风险 | 对策 |
| --- | --- |
| 画布每帧重绘卡顿 | 静层离屏缓存（D20e），动层只画 ≤3 个 sprite；DPR 封顶 2 |
| 宿主变量缺失导致画布配色突兀 | D20h 字面兜底 = 官网色板；采样失败静默降级 |
| 坦克动画分散注意力 | D20e/D20f 硬指标 + reduced-motion 静帧 + 隐藏页暂停；alpha 上限兜底 |
| 宽侧栏挤压内容区 | 172px 仅在面板 ≥720px 时生效，窄面板回落 84px 窄栏（容器查询不可用，以挂载面宽度一次性测量 + resize 重测实现） |
| gen.css purge 清掉动态类 | 全部类名走完整字面量映射表（21.5.1 纪律），画布 inline style 不进 Tailwind |
