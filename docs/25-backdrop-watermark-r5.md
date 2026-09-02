# 25 背景板四期：水印化 + 波纹 + 坦克下架；hero/弹窗按钮官网化（R4）

> 用户指令（四期）：①「背景格子还是有点太大了，继续做小一点，然后背景格子没有在页面的右上角，坦克暂时不要了。格子鼠标扫过的时候有波纹效果。背景格子做成类似水印的感觉，从右上角 慢慢变淡到左下角」；②「对话框中的团队按钮太大了，而且边框特别突兀，团队弹窗里面的tab效果换成tailwind的风格」。（第 3 点内容为空，无第三项。）
> 接续 docs/24（D22 系列）。决策号 D23。步进纪律不变（四绿门 + 体积台账 + 独立 commit）。

## 25.1 决策（D23 系列）

| # | 决策点 | 结论 |
| --- | --- | --- |
| D23-1 | 格子更细 | CELL 自适应 24/20 → **14**（面板宽 <600 → **12**）。指令合并（MERGE_ALPHA_TOL 0.015 / MIN_OP_ALPHA 0.01）机制不变；预算锁按 c14 实测重定（sim 复跑取证后入锁，c24 旧锁 ≤400 保留作对照） |
| D23-2 | 收紧右上角 | FADE_NEAR/FAR 0.12/0.55 → **0.10/0.40**——可见区 ≈ FAR²=16%（原 30%），「有东西」严格压回页面右上角；左下深角保持精确 0。测试锁同步重定标（0.75W/0.25H 带内 ≥0.45） |
| D23-3 | 水印化 | GRID_LINE_ALPHA 0.07→**0.05**；高地图三档 0.04/0.08/0.13→**0.03/0.06/0.10**——「水印」观感（远看是纹理、不与正文争读）。COMPOSITE_ALPHA_CAP 恒 1 不变（D21g） |
| D23-4 | 坦克暂时下架 | 引擎坦克代码**全量保留**（createTanks/stepTanks/planTankOps 及其 26+ 锁原样不动）；壳 `TANK_COUNT=3→0`——不生成、不步进、不绘制。回头要坦克时改一个常量即回 |
| D23-5 | 鼠标波纹 | 引擎新增纯函数波纹：`Ripple{x,y,born}`、`RIPPLE_MAX_AGE=0.9s`、`RIPPLE_EXPANSION=110px/s`、`planRippleOps(ripple,now,w,h,palette)` 产 `StaticOp kind:'ring'`（双环 r 与 0.6r，α=fade·(1−age/MAX)·0.35，随右上渐隐同源衰减——左下水域波纹自然不可见）。壳接线：canvas 保持 `pointer-events-none`，`pointermove` 挂在画布父元素（作用域根）上，节流（≥90ms 且位移 ≥24px 才落点）；有活波纹（或坦克在）才跑 rAF 循环，波纹自然衰减完即停帧；`prefers-reduced-motion` 与 `document.hidden` 时不生成波纹 |
| D23-6 | hero/弹窗触发按钮 | `.eteams-hero-btn`（heroTeamsButton.ts）缩档：min-height 28→24px、padding 0 10px→0 8px、font-size 13→12px；**边框突兀根因 = preflight:false 下 UA button 默认边框未被压**——teamsButton 触发器补 `border-none`（ghost 变体本身无边框设计，button.tsx ghost 档显式补 border-none，修根）。触发器 h-8→**h-7 px-2.5 text-xs** |
| D23-7 | 弹窗 tab 官网化 | teamsButton 弹窗 tab 头从 shadcn 分段控件（bg-muted 圆角槽）改官网 docs 下划线签名：TabsList `h-auto rounded-none border-b bg-transparent px-3`；TabsTrigger `border-b-2 border-transparent -mb-px pb-2.5 pt-3 text-sm` 激活 `text-primary border-primary font-semibold`（hover text-foreground）。shadcn tabs.tsx 基件不动（他处无消费方，改动收敛在 teamsButton 调用位） |
| D23-8 | 验收方式 | sim 复跑（新 fade/cell 口径的 ops 预算取证）；四绿门；preview 页重生成（波纹演示 + 无坦克确认 + 新 tab/按钮观感）；浏览器截图取证入 docs |

## 25.2 模块拆解

### S25-1 背景板 R5（D23-1..5）
- 范围：`src/client/backdropEngine.ts`（FADE/alpha 常量重定标、StaticOp kind 扩 ring、波纹纯函数）、`src/client/eteamsBackdrop.tsx`（CELL 14/12、TANK_COUNT=0、波纹接线、按需 rAF）、`tests/backdropEngine.test.ts`（fade 锁重定标 + 波纹锁 + c14 预算锁）。
- 不变式：坦克引擎与其测试锁零改动；token 采样源不变；`pointer-events-none` 不破（波纹监听在父元素）。

### S25-2 按钮与弹窗官网化（D23-6/7）
- 范围：`src/client/heroTeamsButton.ts`（chip 缩档）、`src/client/components/ui/button.tsx`（ghost 补 border-none）、`src/client/teamsButton.tsx`（触发器缩档 + 下划线 tab）。

### S25-3 预览重生成 + 总验收（D23-8）
- 范围：`.tmp-tw-docs/preview/` 重生成 + sim 复跑 + 四绿门 + 浏览器取证 + 本文档施工记录；`corepack pnpm build` + 重装 DSH。

## 25.3 风险与对策

| 风险 | 对策 |
| --- | --- |
| c14 指令量暴涨 | 合并机制不变；sim 实测定锁；若超 2×旧预算则提高合并容差而不是砍细腻度 |
| ring 指令进旧测试的 rect 假设 | planStaticLayer 只产 rect；ring 仅出自 planRippleOps，旧测试零波纹输入 |
| 波纹抢交互/进无障碍树 | 监听在父元素、canvas 仍 aria-hidden + pointer-events-none；reduced-motion 直接不生成 |
| twMerge 误删 tab 变体类 | 变体类（data-[state=active]:*）完整字面量，改后 gen.css 抽查 |

## 25.4 施工记录（定稿）

| 步骤 | commit | 内容 | 体积（lib/client.js） |
| --- | --- | --- | --- |
| S25-1/2 | （本次） | ①引擎 D23-1/2/3：FADE 0.12/0.55→0.10/0.40（可见区 ≈30%→16%）、GRID 0.07→0.05、地形 0.04/0.08/0.13→0.03/0.06/0.10；②引擎波纹 D23-5：`Ripple/RIPPLE_MAX_AGE 0.9s/RIPPLE_EXPANSION 110px/s/planRippleOps`（双环 4 边、α=0.35×(1−age)×fade 同源衰减、kind:'ring'）；③壳：CELL 24/20→14/12、TANK_COUNT=0（引擎+测试锁全保留）、pointermove 挂父元素（节流 90ms/24px、≤12 粒、按需 rAF、停帧空闲态）、看门狗空闲豁免、**画布定位内联化**（D25 修复：宿主内 absolute/inset-0 工具类未生效 →「左侧一小块」；内联 position/inset/width/height 免疫宿主 CSS；RO 改观察父元素 + 2s 一次性 `backdrop-geom` 诊断）；④hero chip 缩档（24px/12px/8px 横距，token 化 focus 环）；⑤ghost 变体补 border-none（「边框突兀」根因=UA button 边框未压）；⑥teamsButton 触发钮 h-7 rounded-full 13px（镜像宿主 chip）；⑦弹窗 tab 头官网下划线签名（两等半 flex-1、单分割线、pt-2/pb-2 降高，D25 修订）；⑧测试重定标（45 例：fade 常量/面积锁、水印 cap 0.10、c14 预算 ≤700（sim 实测 541 @1920×1080）、波纹 4 锁、病理场景锚侧重布——反钉死家族/对头分离窗/堵点场景按新 zone 几何迁移）；⑨sim 复跑：全尺寸零钉死（worstStill ≤4.5s）、ops c24 193 / c14 541 / c12 648 @1920×1080；⑩四绿门全绿（145 例）；lib/client.js 4,313,066 B；已重装 DSH（dsh-eteams → C:\eTeam 符号链接，client.js 实测新构建） | 4,313,066 B |

**验证证据汇总（S25-3 终验）**：
- 四绿门：typecheck ✓ / eslint ✓ / vitest 145 passed（15 files）/ build + SMOKE OK。
- sim（smoke-r3.mjs 复跑 @D23 口径）：退化面板返回 []；非退化 worstStill 1.3–4.5s 零钉死、全 inZone；ops 预算 c24=193（旧锁 ≤400 保持）、c14=541（新锁 ≤700）。
- 预览页（localhost:8791/preview.html）：canvas 覆盖面板（covers=true）、波纹渲染（pointermove 后画布新增非零 α 像素）、坦克零渲染、两等半下划线 tab 可交互、暗色按钮移除（宿主切换）。
- 宿主修复取证：canvas 定位改内联样式（`position:absolute;inset:0;width:100%;height:100%`）——工具类定位在宿主 DOM 失效的根因规避；若仍异常，2s 后 `backdrop-geom` 诊断给出 canvas/parent 实测尺寸。

**给用户的验收入口**：重启 DSH Desktop 后在面板内验收（背景右上水印格 + 鼠标波纹 + 无坦克 + 触发钮/弹窗 tab 新观感）。坦克回归：`src/client/eteamsBackdrop.tsx` 的 `TANK_COUNT` 改回 3 即恢复。
