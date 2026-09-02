# 24 面板三期：官网 v3 全面对标 + 背景板 R3（碰撞/防卡死/彩色化）

> 用户指令（三期）：①「页面整体风格就做成 tailwind 官网的风格（tailwindcss.cn/docs/installation），仔细研读它的侧边栏、颜色、字体。新的 UI 完全按照 tailwind css 官网的样式，仔细检查每个模块，都要对标」；②「背景右上角有细腻的格子 + 高地图，渐变到左下角，有彩色的像素小坦克在上面移动，不能喧宾夺主」；③验收反馈：「UI 方面和 tailwind 官网差距比较大。背景也没有放到右上角有很细腻的格子和彩色的像素小坦克，小坦克也没有碰撞效果，还会卡死」。
> 本文是三期合同：多 agent 调研结论（官网规范 / 现状差距 / 引擎诊断，全部实测取证）、决策（D22 系列，接续 D21）、模块拆解（每步范围 → 四绿门 → commit → 体积台账）、验收标准。二期 D21a（DSW 蓝复用）/ D21d（中性色相可接受偏差）被本期用户指令**翻案**（见 D22a）。

## 24.1 调研结论（三路并行 agent，实测取证）

### 24.1.1 官网 v3 视觉规范（tailwindcss.cn 实抓 CSS，v3.4.17）

证据：`.tmp-tw-docs/tw-docs/tw-installation.html` + 站点主样式表（v3 镜像真实产物）。

- **颜色模型**：全站只有 slate 灰阶（结构/文字）+ sky（强调/链接/激活）两族。浅色：底 `#ffffff`、标题 `slate-900 #0f172a`、正文 `slate-700 #334155`、弱化 `slate-400 #94a3b8`、细线 `slate-200 #e2e8f0` / 侧栏线 `slate-100 #f1f5f9` / 顶栏线 `slate-900/10`、强调 `sky-500 #0ea5e9`。暗色：底 `slate-900 #0f172a`、标题 `slate-200 #e2e8f0`、正文 `slate-400 #94a3b8`、强调 `sky-400 #38bdf8`、细线 `slate-800 #1e293b`。
- **字体**：Inter var（@font-face InterVariable.woff2，wght 100–900）+ `font-feature-settings:"cv02","cv03","cv04","cv11"` + `antialiased`；mono = Fira Code VF（wght 300–700）。docs 正文 16px/1.75，prose-sm 14px/24；h1 30–36px extrabold tracking-tight；h2 20px bold tracking-tight；侧栏全档 14px/24；小字（pill）12px/20。
- **侧栏签名**：搜索框（`rounded-md ring-1 ring-slate-900/10 shadow-sm py-1.5 pl-2 pr-3 text-sm text-slate-400`，暗 `bg-slate-800`）+ 分组标题（14px semibold slate-900）+ `ul` 连续左细线（slate-100/800）+ 每个 `a` 自带 `border-l pl-4 -ml-px`（默认透明 / hover `border-slate-400` + 文字加深 / 激活 `text-sky-500 border-current font-semibold`）。
- **代码卡**：`bg-slate-800 rounded-xl shadow-lg` + 文件名 tab（sky-300 底线）+ 粉色 chevron 命令前缀 + `text-slate-50` 文字。inline code 带可见反引号无底色。
- **首页网格底纹先例**：32px 网格 `stroke rgb(15 23 42 / 0.04)` + mask 渐隐——「低调背景板」的官方先例。
- **签名要素**（重要性序）：白底+slate 灰阶 → sky-500 唯一强调 → 侧栏左线导航签名 → Inter var → 深灰代码卡 → 极细边框语言（全部 1px）→ 小圆角体系（控件 6px/卡 12px/pill full）→ shadow-sm/lg 两档。

### 24.1.2 现状差距审计（src/client 全表面）

按影响排序（完整模块表见调研底稿，此处留决策所需的最小集）：

1. **D1 排版基线塌陷**：SHELL 钉死 `text-[13px] leading-[1.55]`（eteamsView.tsx SHELL_CLASS），全档 11–17px 再分配；标题靠字重撑、无 tracking-tight（SECTION_TITLE 反向加宽 tracking-[0.5px]）；弹窗标题被压到 13px。**这是「怎么换色都不像」的根因。**
2. **D2 中性色被宿主别名覆盖**：`--foreground/--muted-foreground/--border/--background` 首跳 `--dsw-alias-*`（neutral-bluish 暖灰：亮 #0f1115/#81858c，暗底 #232324）——与官网 slate 冷灰阶（#0f172a/#64748b/#e2e8f0/slate-900）色相不符；muted-foreground 亮色 #81858c 明显过浅。
3. **D3 accent 是 DSW 蓝 #4176e6**（D21a），非官网 sky-500 #0ea5e9。
4. **D4 徽标过彩**：PILL 五档实底彩 pill、任务页 10 个状态组全彩 pill 铺满；官网几乎无彩色 pill（仅 slate-400/10 与 sky-400/10 两枚圆 pill）。
5. **D5 图标是 emoji/字符**：🐳💬✍️△⟳←＋；官网全套 SVG 图标。
6. **D6 字体回落**：Inter var 不打包（D20b）→ Windows 落 Segoe UI/雅黑，mono 落 Consolas——官网观感的字体层差距。
7. **D7 侧栏缺搜索框**；分组标题≈11px；宽栏 172px（官网 304px）。
8. **D8 卡片边界感弱**：边框 4% 黑（比官网 slate-200 还淡）+ 极轻阴影；ROLE_LIST_CSS 硬编码 rgba(65,118,230,*) 的「浮起 + 蓝影」仪表盘 hover。
9. **D9 杂项**：事件流满宽下边线表格观感；汇报时间线双层灰底嵌套卡；遮罩 bg-black/80；整页团队页灰底；`window.confirm`、原生 details（功能性，不动）。
10. **雷区确认**：`lib/tailwind.gen.css` 现有类全齐无 purge 缺失；tests/webui 不锁视觉类名（自由度大）；backdropEngine.test 锁色值/alpha/CELL（动引擎必须同步）；heroTeamsButton className 有测试锁（范围外）；mdEditor.tsx / avatar.tsx 调色板范围外。

### 24.1.3 背景板引擎诊断（Node 仿真 7 组，sim 脚本留 `.tmp-tw-docs/sim/`）

1. **卡死根因 R1（引擎级死锁，15/15 尺寸实证）**：`stepTank` 每帧按当前位置查 `fadeAlpha<0.3` 并 `snapLane` 回拉；当 zone 等值线落在「车道点前方 >1 步、<30px」区间时，坦克每帧前进 ≤1.6px 又被 snap 拉回原点，`redirect` 探针（+30px 点）却判「有路」→ **永久钉死**（800×20 实测 3/3 辆钉死 958s；解析判据 phase<15 与观测 15/15 吻合）。修复 = 交点语义重构（见 D22g-1）。
2. **R4 `document.hidden`（高嫌疑，待环境验证）**：hidden 时 loop 全停；DSH Electron 的 BrowserView 可能 hidden 误报/rAF 节流且不自愈 → 整板静止。修复 = 壳内看门狗自愈（D22g-6）。
3. **R3 感知速度**：10–16px/s @30fps = 每帧 0.33–0.53px，sprite 每 ~6.8 帧才跳 1px——「看不出在动」。
4. **碰撞缺失（设计如此）**：stepTank 无 tank-tank 交互；大画布 0.2–4.7% 时间两两 <30px 穿车，小画布 93–99% 叠车。方案 = 车道占用仲裁（D22g-2）。
5. **「背景不在右上角」**：FADE_FAR=0.85 使格线在 **87.1%** 面积可见、坦克活动区 65.1%——渐隐拉满全板。建议 NEAR .12/FAR .55 → 可见区 48.4%、活动区 31.0%。
6. **细腻度**：CELL=30 偏粗（官网 hero 64px 是整页尺度，400–800px 面板 24px 才细腻）；指令量 6517 条 @1920×1080 可合并至 ~275（24×）。
7. **色彩**：palette 仅 label+brand 两色，坦克全 slate；建议三色族 amber/rose/emerald-500（与 DSW/sky 蓝 hue 间距最大化；violet/sky 弃用），对比度定标见 D22g-4。
8. **退化尺寸**：w/h<CELL 时 laneCount=0 全部塌缩单车道（50×40 叠车 99.7%）——直接不生成坦克。

## 24.2 决策记录（D22 系列）

| # | 决策点 | 结论 |
| --- | --- | --- |
| D22a | 色彩体系 | **官网 v3 色板全面接管，翻案 D21a/D21d**（用户三期指令「完全按照官网」）。token 值改官网字面值，**不再首跳宿主别名**；暗色经 `body[data-ds-dark-theme]` 祖先选择器切官网暗色（slate-900 底/sky-400 强调）。token 桥架构保留（变量名不变，只换值与增加暗色块）。success/warning/destructive 保留（语义必需，官网无对应物）：green-600/amber-600/red-600，暗色 +100 档 |
| D22b | 字体打包 | 翻案 D20b「不打包字体」：devDeps `@fontsource-variable/inter` + `@fontsource-variable/fira-code`；buildTailwind.mjs 构建时读 latin woff2 → base64 → @font-face 前置进 gen.css（体积台账预算 ≤ +260KB，超限砍 Fira Code 保 Inter）。字体栈：`'Inter Variable','Inter var',…`；`.eteams-ui` 上加 `font-feature-settings:"cv02","cv03","cv04","cv11"` + antialiased。CJK 仍落系统字体（官网同款行为） |
| D22c | mini-preflight | preflight:false 的代价清算：`.eteams-ui` 作用域内补一段 scoped 基础复位（`*,::before,::after{box-sizing:border-box;border-width:0;border-style:solid;border-color:var(--border)}`、h1–h6/p/ul/ol margin 0、ul/ol list-style none、img/svg display block、code/kbd/pre/samp 字体栈）。实施后必须回归验证 mdEditor（`.eteams-mdx` 自有样式体系，特异性更高应可覆盖）与所有既有表面无破相 |
| D22d | 排版基线 | SHELL 13px→**14px/leading-6**（官网侧栏/prose-sm 尺度，面板语境）；页签标题 20px bold tracking-tight（官网 h2）；卡/区标题 16px semibold tracking-tight；lead 描述 16px/1.75（官网 prose 尺度）；数据行 14px；meta/pill 12px/20（**消灭 11px 档**）；mono 芯片 13px；弹窗标题回归 shadcn text-lg；SECTION_TITLE 去反向 tracking 加宽；全文标题补 tracking-tight |
| D22e | 徽标降噪 | PILL 全族改官网式圆 pill：中性档 `bg-slate-500/[0.08] text-slate-600`（暗 slate-300），状态色**只进 6px dot**；品牌档 `bg-sky-500/10 text-sky-600`（暗 text-sky-400，官网新闻 pill 签名）；任务页 10 个状态组头改「中性文字 + 计数 + 彩 dot」；/alpha 禁令走 color-mix 任意值（先例 button.tsx） |
| D22f | 图标与表面 | emoji 清零（🐳💬✍️），按钮位用 lucide **深层导入**（dialog.tsx 先例）：Search/ArrowLeft/Plus/ChevronRight 等；执行链 ✔●◌ 字符保留（产品语义）只调色（done slate-500 / current sky-500 / pending slate-300）。卡片 hover 去 translateY 浮起改官网式（border-slate-300 + bg-slate-50）；ROLE_LIST_CSS 硬编码蓝全部换 sky 族；遮罩 bg-black/80→bg-slate-900/50；事件流去满宽下边线改留白分组；汇报时间线改白底+左细线；teamsPanel 灰底改白底+官网顶栏 |
| D22g | 背景板 R3 | ①**防死锁**：stepTank 拆 `intendTankMove/applyMove`，zone 检查从「每帧按当前位置+snap 回拉」改「**仅交点处**」；redirect 探针从「+30px 点」改「沿候选方向下一个交点」（可达点）；末车道 target ≤ laneCount·cell（消 dip）。②**碰撞**：新增 `stepTanks(tanks,dt,w,h,cell)` 车道占用仲裁——同车道跟车 stopDist=1.2cell 钳停、resumeGap=1.8cell 迟滞、hold>6s 强制改道；对头双停 0.4s 后距锚远者倒车（等距 id 小者）；交点 ETA<2s 冲突按 (ETA,id) 让行；zone 停让优先（不因礼让出区）。`stepTank` 保留为单坦克兼容路径。③**彩色坦克**：`TANK_ACCENTS=['#f59e0b','#f43f5e','#10b981']`（amber/rose/emerald-500）按 index 循环分配，`Tank.accent`；alpha 重定标：车身(accent) 0.55 / 履带·炮管(label) 0.60 / 炮塔点缀(accent) 0.75（白底合成对比 1.5–2.8:1，仍远低于正文 ~7:1）。④**网格/右上角**：CELL 30→**24**（面板宽 <600 用 20）、TANK_PIXEL=3 与 CELL **解耦**（否则 c24 下坦克缩成 14×10）；FADE_NEAR/FAR 0.08/0.85→**0.12/0.55**（格线可见区 87%→48%）；GRID_LINE_ALPHA 0.07 保持；高地图改 3 档量化带 0.04/0.08/0.13（峰顶=sky）；速度 10–16→**14–24 px/s**；坦克数 ≤3 不变。⑤**性能**：静层指令合并（网格同列 α 差 ≤0.015 合段、地形按行合并、最终 α<0.01 跳过）目标 ≤400 条 @1920×1080；`createTanks` 退化尺寸（min(w,h)<4·cell）返回 []。⑥**壳自愈**：MutationObserver 加 palette 相等短路 + 150ms 防抖；rAF 重排在 hidden 检查之后；1s 看门狗（lastRender>2500ms 强制推帧；`ctx.isContextLost` 即 replan）。⑦采样源换自有 token `--eteams-backdrop-label/--eteams-backdrop-accent`（slate-600/sky-500，暗 slate-400/sky-400，字面兜底同名值） |
| D22h | 验收方式 | 预览页重生成（真实 gen.css + 真实引擎 IIFE + 亮暗/坦克数切换）；浏览器截图 + preview_inspect 计算样式取证；sim 仿真脚本对新引擎复跑（零钉死/零叠车锁）；四绿门 + 体积台账 |
| D22i | 步进纪律 | 延续 D19f/D21f：每步 inScope → 四绿门 → 体积记录 → 独立 commit，master 直行；三实现 agent 并行（文件面互斥：令牌/构建 vs 视图表面 vs 引擎），commit 由主会话按步分拣 |

## 24.3 模块拆解（每步一个验收面）

### S24-0 基线（已完成）

- 四绿门基线全绿（typecheck/lint/test 126 例）；`lib/client.js` 基线 4,168,727 B；本文档入库。

### S24-1 令牌官网化 + 字体打包 + mini-preflight（D22a/b/c）

- 范围：`src/client/eteams.css`（token 值换官网字面 + 暗色块 + mini-reset + 字体栈/font-feature/antialiased + 背景板采样 token）、`tailwind.config.ts`（如需 radius/darkMode 注记）、`scripts/buildTailwind.mjs`（字体 base64 前置）、`package.json`（fontsource devDeps）、`tests/backdropEngine.test.ts` 调色板兜底断言同步（默认 var 名/字面值）。
- 不变式：token **变量名与消费方不变**（只换值）；不引入 `dark:` 变体（暗色走祖先选择器）；`/alpha` 禁令不破；`.eteams-ui` 字面量纪律不破。
- 验收：四绿门；gen.css 含官网字面值 + @font-face + 暗色块；preview 亮暗双态截图色值比对官网（sky-500/slate 系）。

### S24-2 视图表面官网化（D22d/e/f）

- 范围：`eteamsView.tsx`（SHELL 排版基线、侧栏搜索框+字号+宽度、PILL/TONE 降噪、标题 tracking-tight、事件流/时间线、Dialog 标题、ROLE_LIST_CSS 迁移、emoji 清零+lucide 深层导入）、`teamsPanel.tsx`（白底+官网顶栏）、`card.tsx`/`buildCard.tsx`（🐳✍️ 清零、pill 口径）、`teamsButton.tsx`（字号档同步）。
- 验收：四绿门；gen.css 含全部新类（字面量纪律抽查）；预览页目检五 tab + 弹层 + 卡片。

### S24-3 背景板 R3（D22g）

- 范围：`src/client/backdropEngine.ts`（防死锁重构 + stepTanks 碰撞 + 彩色族 + fade/cell/速度/alpha 重定标 + 指令合并 + 退化尺寸）、`src/client/eteamsBackdrop.tsx`（看门狗/MO 防抖/采样源）、`tests/backdropEngine.test.ts`（断言同步 + 新增防死锁/碰撞/形状/色族/合并预算锁）、`.tmp-tw-docs/sim/` 复跑。
- 验收：四绿门 + 全部新锁绿；sim 全尺寸 1000s 零钉死、零叠车（碰撞参数内）；预览页目检「细腻右上格 + 三色坦克 + 碰撞让行 + 左下留白」。

### S24-4 预览页重生成 + 总验收（D22h）

- 范围：`.tmp-tw-docs/preview/` 重生成（新 gen.css + 新引擎 IIFE + 新 token 台）；浏览器截图（亮/暗、坦克碰撞连拍）取证入库 docs；README 三期一览；施工记录定稿（体积台账）。
- 验收：用户视觉确认——「完全按照官网」观感成立（侧栏/颜色/字体/排版五维）+ 背景板「右上细腻格子高地图、左下渐隐留白、彩色坦克碰撞行驶、不喧宾夺主」。

## 24.4 风险与对策

| 风险 | 对策 |
| --- | --- |
| mini-reset 破坏 mdEditor/既有表面 | D22c 实施后全表面回归（预览 + webui 测试）；`.eteams-mdx` 特异性更高，理论覆盖，仍需目检 |
| 字体包推高 envelope | 预算 ≤+260KB（基线 4.17MB 的 6%）；超限砍 Fira Code 保 Inter；台账记录 |
| 翻案 D21a/D21d 影响宿主内观感一致性 | 用户三期指令明示「完全按照官网」；DSW 蓝仅剩宿主主按钮原生件（范围外），面板内全 sky |
| 碰撞仲裁死锁（互相等待） | 迟滞 + 6s 强制改道 + 对头倒车规则均有数学出路；sim 1000s 全尺寸零钉死锁回归 |
| 翻案后 amber 亮底存在感弱（1.5:1） | 备选 amber-600 #d97706；验收后可按亮暗切 500/600 档 |
| `document.hidden` Electron 语义 | 看门狗自愈兜底；若用户环境复现静止，宿主侧 backgroundThrottling:false（环境项，记入验收单） |
| 新类名 purge 缺失 | 全部完整字面量（映射表模式）；gen.css 抽查新类（24.3 S24-2 验收项） |
