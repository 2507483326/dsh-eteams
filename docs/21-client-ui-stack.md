# 21 客户端 UI 栈升级：Tailwind CSS + shadcn/ui + dva

> 用户指令：为整个客户端引入 [shadcn/ui](https://ui.shadcn.com/)、[Tailwind CSS](https://www.tailwindcss.cn/docs/installation)、[dva](https://dvajs.xiniushu.com/guide/) 三件套，优化整个项目；优化前仔细阅读相关文档；**小步快跑，一个点一个点地优化；优化完成做审核和测试**。
> 本文是这次优化的设计与施工合同：技术选型、集成架构、分步计划（S0–S15）、审核与测试计划全部在此定稿，工作流按步执行。

## 21.1 背景与目标

客户端（`src/client/`，React 18 浏览器包）当前有三类债务：

| # | 现状 | 证据 | 痛点 |
|---|---|---|---|
| 1 | 样式全部 inline style | `eteamsView.tsx` 218 处 `style=`；全客户端 280+ 处 | 无法复用、无 hover/media/伪类、主题跟随靠逐处手写 `var(--dsw-…, 兜底)` |
| 2 | 状态散落 | `monitor.ts` 模块级单例 + `useSyncExternalStore`；`eteamsView.tsx` 35 处 `useState` | 跨表面共享（card/teamsButton/eteamsView 三处消费轮询）靠模块约定；副作用与状态混在一起 |
| 3 | 无组件基座 | 徽标/卡片/弹层/抽屉全手写；仅 Button/Input 复用宿主 primitives | 同一 UI 重复实现多份（如 PHASE_LABELS 在 card.tsx 与 eteamsView.tsx 各一份） |

目标：建立 **Tailwind 样式管线 + shadcn/ui 组件基座 + dva 状态中枢**，全部在「单文件 CJS envelope」的构建约束内落地；迁移过程每步可验证、可回滚。

**非目标**：不改 `src/host/` 行为；不迁移 `mdEditor.tsx`（mdxeditor 自带样式体系，已稳定）；`heroTeamsButton.ts`（纯 DOM 注入、无 React 树）不在范围；不做组件渲染级单测（无 jsdom 设施），以构建门 + 单测（逻辑层）+ 冒烟清单代替。

## 21.2 现状盘点（约束与资产）

### 21.2.1 构建约束（本次最大的工程前提）

- 客户端由 tsdown 打成**单个 CJS envelope** `lib/client.js`（`scripts/wrapClient.mjs` 包壳，宿主 ModuleLoader 只加载这一个文件）。
- **没有独立 CSS 通道**：tsdown 在未装 `@tsdown/css` 时对 `.css` id 无条件抛错（css-guard）。既有先例：mdxeditor 的 `style.css` 经虚拟模块以字符串进包、首次挂载运行时注入 `<style data-dsh-eteams-mdx>`（幂等）——Tailwind 采用同一手法（D19a）。
- `external` 清单：`@deepseek-ai/*`、`react`、`react-dom`（宿主注入）。新增依赖全部作为 **devDependencies 打进 envelope**。
- TS：`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`（shadcn 源码需要按此规整 `import type`）。
- ESLint：`unicorn/filename-case` 强制 camelCase 文件名 → shadcn 组件（kebab-case）需要目录级 override。
- 环境：pnpm 11.8 + npmmirror 镜像（`.npmrc` 已固定项目内缓存）+ Node 24（engines 满足）。

### 21.2.2 主题机制（样式桥的地基，来自 mdEditor 既有结论）

- 宿主把主题 token 写在 `body.style`（`--dsw-alias-*` 变量族），**亮暗切换自动跟随，无需 JS**。
- 宿主暗色标记：`body[data-ds-dark-theme]`（dsh-client-ui-layout ThemePresenter）。
- 客户端已消费的宿主变量全集（映射表输入）：
  `--dsw-alias-accent`、`-bg-base`、`-bg-layer-1/2`、`-border-l1/l2`、`-brand-primary`、`-button-primary-hover`、`-interactive-bg-active/hover`、`-label-primary(-foreground)/secondary/tertiary`、`-state-{business,error,err,success,warn}-primary`、`--dsw-static-{amber,green,red}-100`、`--dsw-font-markdown-base-*`，以及原始色阶 `--slate-1..12`、`--blue-3..11`、`--red-10`。
- **注意**：这些宿主变量是**完整色值**（代码里的兜底写法是 `rgba(...)` 字面量），不是 HSL 通道 → shadcn 经典 v3 的 `hsl(var(--x))` 通道方案不可用，采用「变量别名直引」（D19c）。

### 21.2.3 状态与轮询（dva 迁移的第一目标）

- `monitor.ts`：单例轮询循环（1s 活跃 / 5s 探测 / 隐藏 20s，`visibilitychange` 恢复即刷），引用计数生命周期（多表面共享），`useSyncExternalStore` 发布快照；`card.tsx`、`eteamsView.tsx`、`teamsButton.tsx` 三处消费。
- `api.ts`：面板全部 HTTP 调用（roster CRUD、build 会话、成员操作）。

### 21.2.4 测试设施

- vitest，`pool: 'threads'`（DSH 沙箱禁进程派生，线程池可用），`include: tests/**/*.test.ts`（仅 .ts，共 10 个测试文件全绿）。

## 21.3 技术选型（含版本锁定）

| 技术 | 选型 | 版本 | 理由 |
|---|---|---|---|
| 原子 CSS | Tailwind CSS **v3-lts** | `~3.4.19` | 用户指定文档即 v3 镜像（tailwindcss.cn/docs/installation）；v4 是 CSS-first + `@tailwindcss/cli` 管线，文档基线不同；v3-lts 官方维护线、CLI 成熟、与既虚拟模块手法零冲突 |
| CSS 合并 | tailwind-merge **2.x** | `~2.6.1` | 3.x 仅支持 Tailwind v4；2.6.1 对应 TW 3.4 |
| 组件 | shadcn/ui **new-york (v3)** 手动 vendoring | registry JSON 快照 | 官方 Manual Installation 认可 copy-in；CLI 依赖标准布局与别名解析，本仓 `rootDir=src/client` 无 paths 别名，手动拷贝更直接；registry JSON（`/r/styles/new-york/{name}.json`）含完整源码与依赖清单 |
| 样式工具 | clsx + class-variance-authority | `^2.1.1` / `^0.7.1` | shadcn cn()/cva 标准件 |
| 动画 | tailwindcss-animate | `^1.0.7` | v3 侧 shadcn 动画类标准插件（可选件，先装） |
| 状态 | **dva-core** | `^2.0.4`（唯一正式版，锁死） | dva 本体（2.4.1）捆绑 react-router/history，面向完整应用；dva-core 无 react 耦合、无路由，model = state/reducers/effects/subscriptions 完整保留（用户链接的「特性」页六 API 的本体）。**注意：2.0.4 无 `app.getStore()`**（那是旧 dva-no-router 的 API），官方用法是 `app._store`；`start()` 无二次调用守卫（单例自行保证）；不随包 .d.ts，需自写 `dvaCore.d.ts` |
| React 绑定 | react-redux | `~8.1.3` | **必须 8 不用 9**：9.x peer 要求 `redux ^5`，与 dva-core 的 `redux 4.x` peer 冲突；8.1.3 peers = `react ^16.8/17/18` + `redux ^4||^5`，同时满足 React 18 与 redux 4，且基于 useSyncExternalStore（并发无 tearing） |
| Redux 锁 | redux | `~4.2.1`（显式 devDep） | 防 pnpm 自动解析 redux 5 触发 peer 冲突（dva-core 唯一 peer 即 `redux: 4.x`） |
| 图标 | lucide-react | 按需（首个用到再装） | shadcn dialog 关闭钮用；仅 X 图标 tree-shake 后增量极小 |

dva 生态事实（registry 核实）：`dva-core@2.0.4` 依赖 `redux-saga@^0.16.0`（老但极稳，effects 写法用经典 takeLatest/takeEvery/put/call/select，勿用 1.x 专属 API）、`@babel/runtime`（随包内联）、`global`（createStore 引用，浏览器 bundle 下 typeof 探测安全）；体积增量约 **17–25KB gzip**（dva-core 12KB + react-redux 8 3.2KB + redux 1.8KB 口径）；React 18 并发无实质冲突（react-redux 8 基于 useSyncExternalStore）。

Tailwind 选型实证（本地构建核对）：v3 产物**完全不含 @layer**（构建期展开为平铺普通 CSS），以字符串注入宿主页无级联层风险；v4 产物工具类包在 `@layer utilities` 里，宿主任何未分层 CSS 都会无条件压过它（级联层规则），对注入场景是硬伤——进一步坐实 v3-lts。

## 21.4 决策记录（D19 系列，本文为单一事实源）

| # | 决策点 | 结论 |
|---|---|---|
| D19a | Tailwind 构建管线 | **构建期 CLI 生成 → 字符串内联 → 运行时幂等注入**：`pnpm build` 在 tsc 之后、tsdown 之前插入 `scripts/buildTailwind.mjs`（`tailwindcss -c tailwind.config.ts -i src/client/eteams.css -o lib/tailwind.gen.css --minify`，产物 gitignore）；tsdown 新增 `tailwindCssInline` 虚拟模块插件（id 不以 `.css` 结尾规避 css-guard，沿用 mdxEditor 手法）；`src/client/tailwind.ts` 的 `ensureEteamsStyles()` 幂等注入 `<style data-dsh-eteams-tw>`，`index.tsx apply()` 最先调用 |
| D19b | 作用域策略 | **`.eteams-ui` 包裹 + important 选择器**：`corePlugins.preflight: false`（绝不让全局 reset 进宿主 DOM）；`important: '.eteams-ui'`（生成的工具类形如 `.eteams-ui .flex`，双向隔离：宿主样式进不来、我们溢不出去）；每个 React 表面根元素挂 `className="eteams-ui"`；Radix 浮层默认 portal 到 body 会逃出作用域 → 自管 portal 容器 `<div class="eteams-ui-portal eteams-ui">` 挂 body，改 shadcn Dialog 的 Portal `container` 指进去（有源码，改几行） |
| D19c | 主题桥 | **shadcn 语义 token 别名宿主变量**（附录 A）：在 `eteams.css` 的 `@layer base` 手写 `.eteams-ui { --background: var(--dsw-alias-bg-layer-1, #ffffff); … }`；Tailwind `colors` 映射 `var(--token)`（**不用** `hsl(var())` 通道形式——宿主变量是完整色值）；**规则：token 色禁用 `/alpha` 修饰**（v3 下 var 完整色值不支持透明度修饰；需要半透明层级时新增专用 token 或 `color-mix()`）；亮暗跟随零 JS（宿主变量换值即可），**不引入 `dark:` 变体**（`darkMode` 留默认，若未来需要再按 `body[data-ds-dark-theme]` 后代选择器实测） |
| D19d | shadcn 落库方式 | **手动 vendoring 到 `src/client/components/ui/`**：源码从 registry new-york JSON 取，改相对导入（`cn` 位于 `src/client/cn.ts`）、规整 `verbatimModuleSyntax` 类型导入；目录加 ESLint kebab-case override；`components.json` 作为文档记录入库（注明仅 CLI 需要，本仓不跑 CLI）；不装 lucide-react 直至第一个真实需要 |
| D19e | dva 拓扑 | **dva-core 单例 app + Provider 包表面根**：`src/client/store/app.ts` 惰性创建（create → 注册全部 model → start 恰好一次 → 取 `app._store`；`start()` 无二次守卫，单例模块自行保证）；models 在 `store/models/` 聚合、启动前全量注册（start 后 `app.model()` 虽官方支持，但不依赖它）；每个 React 表面根部包 `<Provider store={...}>`；组件优先 `useSelector`，保持 hooks 签名兼容（`useActivityState()` 改读 store，调用方零改动）；`onError` 接入既有 diagnostics 通道；**自写 `dvaCore.d.ts` 类型声明**（2.0.4 不随包 .d.ts，`@types/dva` 只覆盖 dva 全家桶）；RootState 含内部 `@@dva` 键，用索引签名聚合 |
| D19f | 迁移纪律 | **小步快跑**：一步一个点（一步 ≈ 一个可独立验收的改动面）；每步**四绿门**（`pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全过）+ 记录 `lib/client.js` 体积 + 独立 commit；工作分支 `feat/ui-stack-tailwind-shadcn-dva`（自当前 `team` 分支 HEAD 切出），单步回滚 = revert 该步提交 |
| D19g | 组件按需引入 | 先落**零 Radix 基础件**（button/badge/card/input/textarea/separator/skeleton）；交互组件（dialog/tooltip/tabs/dropdown-menu）在对应迁移步骤接线时才 vendoring，避免未使用代码进包 |

## 21.5 集成架构

### 21.5.1 构建管线（附录 B 有图）

```
pnpm build
  = clean → tsc(host) → tsc(client)
    → node scripts/buildTailwind.mjs        # 新增：tailwind CLI → lib/tailwind.gen.css（gitignore）
    → tsdown                                # 新增插件 tailwindCssInline：虚拟模块把 gen.css 变成字符串导出
    → wrapClient → smokeEnvelope            # 既有：单文件 envelope 包壳与冒烟
```

- `tailwind.config.ts`：`content: ['src/client/**/*.{ts,tsx}']`；`corePlugins.preflight: false`；`important: '.eteams-ui'`；`colors` 走 token 变量（附录 A）；`borderRadius` 按 shadcn v3 惯例从 `--radius` 衍生（`--radius: 0.75rem`，对齐 card.tsx 现行 12px）；`plugins: [tailwindcss-animate]`；keyframes 按需（首个动画组件落地时补）。
- **content 扫描纪律（实证坑位）**：扫描是「正则提取完整类名字符串」——拼接/插值类名（`tone-${t}`）检测不到，**动态样式一律用完整字面量映射表**（如 Tone→`'text-sky-600' | 'text-emerald-600' | …` 查表）；`.eteams-ui` 字面量必须出现在被扫描的 TSX 里（表面根 `className="eteams-ui"` 天然满足），否则 purge 清空产物；不要把 content 指向构建产物。
- 依赖注意：**CLI 路线只需 `tailwindcss@~3.4.19` 一个 devDep**（postcss/autoprefixer 仅 PostCSS 路线需要）。
- `src/client/eteams.css`（唯一输入，camelCase 文件名遵守 lint）：`@tailwind base; @tailwind components; @tailwind utilities;` + `@layer base` 的 token 桥段（全部手写作用域，**不用 `@apply`**，shadcn 脚手架那句全局 `* { @apply border-border } body { … }` 绝不原样照搬——限定到 `.eteams-ui` 内）。
- 类型声明：`src/client/eteamsCss.d.ts` `declare module` 虚拟 id（沿用 `mdEditorCss.d.ts` 手法）。

### 21.5.2 运行时样式注入

`src/client/tailwind.ts`：`ensureEteamsStyles()` 读虚拟模块字符串，`document.head` 注入 `<style data-dsh-eteams-tw>`（存在即跳过——幂等）；`index.tsx` 的 `apply()` 在任何 slot 注册前调用（guard 包裹，失败只记录不致命）。与 mdxeditor 的 `<style data-dsh-eteams-mdx>` 互不干扰（preflight 已关）。

### 21.5.3 dva 状态拓扑

| model | namespace | state | 副作用 |
|---|---|---|---|
| activity | `activity` | `ActivityState`（teams/archivedTeams/error/fetchedAt…，即现 monitor 快照） | 轮询循环**先留模块**（引用计数 + visibility 逻辑已稳），fetch 成功后 `dispatch set`；「刷新一次」提供 effect 供面板手动刷新 |
| ui | `ui` | 面板全局 UI：activeNav、selectedTeamId、抽屉/对话框开关、goto 待办桥接 | 无（纯 reducers）；组件内瞬态（输入草稿等）仍留 useState |
| roster | `roster` | 成员库列表 + 加载/错误态 | effects：list/upsert/delete（`api.ts` 调用迁入） |
| build | `build` | 构建会话状态（rolebuilder 面板） | effects：fetch/confirm/cancel/restart/interview |

Provider：`ETeamsView`、`TeamsButton`、`ETeamsCard`、`EteamBuildCard`、`teamsPanel` 各自根部包 Provider（单例 store，多 Provider 同 store 无害）。

### 21.5.4 测试策略

- 逻辑层单测（vitest，node 环境即可）：`cn` 合并行为；`activity` reducers；dva bootstrap（创建→注册→start→getState）；`roster` effects（mock `api.ts`）。
- 组件渲染不做单测（无 jsdom/testing-library，引入超出本次范围）；由「四绿门 + R3 冒烟清单」兜底。
- 既有 10 个测试文件全程保持绿色（`webui.test.ts`、`store.test.ts` 等直接覆盖被迁文件的行为契约）。

## 21.6 分步实施计划（S0–S15，每步一个点）

> 每步合同：**范围（inScope 文件）→ 四绿门 → 体积记录 → commit（`feat(ui-stack): 步骤主题`）**。任何一步四绿不过：自动带错误重试一次，再不过即停（该点不强行推进，后续依赖步一并不执行），报告留待人工决策。

| 步 | 主题 | 范围 | 验收 |
|---|---|---|---|
| S0 | 基线与分支 | 切分支；`pnpm install`；四绿基线；记录 `lib/client.js` 基线体积 | 四绿 + 体积基线写入报告 |
| S1 | Tailwind 构建管线 | devDeps（tailwind ~3.4.19/tailwind-merge ~2.6.1/clsx/cva/animate/@radix-ui/react-slot）；`tailwind.config.ts`；`src/client/eteams.css`（空骨架）；`scripts/buildTailwind.mjs`；tsdown `tailwindCssInline` 插件；`eteamsCss.d.ts`；`.gitignore` 补 `lib/tailwind.gen.css`；`package.json` build 串步 | `node scripts/buildTailwind.mjs` 产出 `lib/tailwind.gen.css`（--minify、无 preflight 全局规则）；四绿；envelope 构建不受影响（`.eteams-ui` 选择器断言自 S3 起） |
| S2 | 运行时注入 + cn | `src/client/tailwind.ts`；`index.tsx` 接入；`src/client/cn.ts`；`tests/cnUtil.test.ts` | 注入幂等（重复 apply 只有一个 style 节点）；cn 合并用例通过；四绿 |
| S3 | 令牌桥（附录 A） | `eteams.css` `@layer base` 完整 token 桥 + `.eteams-ui *` border 默认色 | 生成 CSS 含映射变量名断言；宿主变量全部真实存在（对照 21.2.2 清单）；四绿 |
| S4 | shadcn 基础组件 | `components/ui/{button,badge,card,input,textarea,separator,skeleton}.tsx`；ESLint kebab-case override；`components.json` 记录 | typecheck 过（verbatimModuleSyntax 规整）；四绿；体积增量记录 |
| S5 | 试点迁移：card.tsx | `ETeamsCard` 用 Card/Badge/Button + Tailwind 类重写（根节点挂 `.eteams-ui`；`activateETeamsTab` 行为不变；降级路径不变） | 四绿；`webui.test.ts` 保持绿；体积增量记录 |
| S6 | dva 引导 | devDeps（dva-core ^2.0.4 / react-redux ~8.1.3 / redux ~4.2.1）；`dvaCore.d.ts` 自写声明；`store/app.ts` + `store/models/`（空 activity/ui 骨架）；`ETeamsView` 根部 Provider；`tests/dvaApp.test.ts` | bootstrap 单测过（`_store` 可取、state 含 `@@dva`）；面板行为零变化；四绿 |
| S7 | activity model | `monitor.ts` 状态迁入 store（reducers + set action；轮询循环留模块、成功后 dispatch）；`useActivityState()` 改 `useSelector`（签名不变）；`tests/activityModel.test.ts` | 三消费方（card/eteamsView/teamsButton）零改动；既有测试 + 新单测全绿；四绿 |
| S8 | ui model（a：导航与选择） | activeNav/selectedTeamId/goto 桥接状态迁入 ui model；eteamsView 对应 useState 删除 | 行为不变；四绿 |
| S9 | ui model（b：抽屉与对话框） | 任务详情抽屉、成员对话框等开关状态迁入 | 行为不变；四绿 |
| S10 | roster/build effects | roster、build 的 api 调用迁入 model effects；组件改 dispatch；`tests/rosterEffects.test.ts`（mock api） | 行为不变；四绿 |
| S11 | teamsButton + teamsPanel 样式 | 弹层与全屏页 Tailwind 化 + shadcn 基础件替换；根节点挂 `.eteams-ui` | 四绿；体积记录 |
| S12 | eteamsView 批次一（侧栏/概览/动态） | 三个区块 inline style → Tailwind 类；徽标/卡片段落用 shadcn | 四绿 |
| S13 | eteamsView 批次二（成员/任务） | 两区块迁移；任务详情抽屉 → shadcn Dialog（本步 vendoring dialog + portal 容器改造 + lucide-react） | portal 容器断言（注入的 portal div 带 `eteams-ui` 类）；四绿 |
| S14 | eteamsView 批次三（杂项）+ avatar/buildCard/diagnostics | 余下区块与小组件迁移；tooltip/tabs 按需 vendoring；死代码清理（含合并两份 PHASE_LABELS） | 全仓 `style={{` 残留清点（目标：eteamsView/teamsButton/card/buildCard/avatar/diagnostics 中仅剩必要动态值）；四绿 |
| S15 | 收尾与文档同步 | docs/README.md 阅读顺序表 + 决策记录 D19；`docs/03-tech-stack.md` 增补选型行；体积对比表；全仓死代码清理 | 全套 `pnpm verify` 绿；文档一致性核对 |

> **S15 实际结果回写（终态）**：S0–S14 均按上表推进并独立提交；偏差与细化如下——
> - S4：附录 A 增补 `--destructive-foreground`（destructive 变体的 on-色文本，见附录 A 微调注记）。
> - S13：vendoring `dialog` + `@radix-ui/react-dialog` + `lucide-react`，并新增自管 portal 容器 `components/ui/portal.ts`（Radix 默认 portal 到 body 会逃出 `.eteams-ui` 作用域）。
> - S14：**tooltip/tabs 最终未 vendoring**——迁移中未出现消费面，按 D19g 按需纪律不落库；PHASE_LABELS 合并至 `phaseLabels.ts`，旧 `TONE_FG`/`TONE_BG`/`PILL_FG` 色表与 `styles`/`fns` inline 工厂删除（面板残余 inline 仅进度条宽度 ×2 与壳高度锚点 ×1，均为运行时动态值）。
> - S15：`teamsButton.tsx` 改直连 `phaseLabels.ts`（eteamsView 兼容 re-export 撤销）；RootState 类型收口（`store/app.ts` 补 roster/build 键，eteamsView 局部 `PanelRootState` 别名删除）；全仓死代码清理（client：`ADD_PEOPLE_PREFIX`、`clientDiagEntries` 删除，`STATE_URL`/`ETEAMS_DATA_ATTR`/`withComposerTextarea`/`composerDraft`/`openTeamsOverlay` 收敛为模块私有，`T` token 表裁剪到注入样式表实际消费的 7 键；host：`noticeMail`/`memberWakeHeader`/`agentIdentity`/`SYSTEM_ACTOR`/`readTeamByIdSync`/`appendTaskNote`/`captainLockKey` 七个零引用符号删除，`captainProtocolFull` 依 docs/19.5.3 契约保留）；docs/README.md 阅读顺序行 + D19 决策行、docs/03 §3.11 选型节、体积终态见附录 C。

## 21.7 审核与测试计划

### 21.7.1 每步门（小步快跑的「快」来自自动化兜底）

1. `pnpm typecheck`（host + client 双配置）；
2. `pnpm lint`；
3. `pnpm test`（含既有 10 文件回归）;
4. `pnpm build`（含 envelope 冒烟）；
5. `lib/client.js` 体积记录（对比基线；异常膨胀 = 隐性 finding）。

### 21.7.2 R1 终审检查表（全量 diff 审计）

- [ ] preflight 未启用；生成 CSS 无全局元素选择器（除 `.eteams-ui` 作用域内）；
- [ ] `.eteams-ui` 作用域完整：五个表面根都挂类；portal 容器收编 dialog；
- [ ] 附录 A 映射的宿主变量全部真实存在且语义正确（抽查暗色效果）；
- [ ] token 色无 `/alpha` 修饰；无 `@apply` 滥用；
- [ ] dva：models 启动前全量注册；无启动后 `app.model()`；订阅/轮询无泄漏（卸载路径引用计数正确）；
- [ ] `useSelector` 签名兼容旧 hooks；`react-redux` 版本 peer 匹配；
- [ ] TS strict / noUncheckedIndexedAccess / verbatimModuleSyntax 全过；ESLint 无新豁免（除 components/ui kebab-case）；
- [ ] 降级路径未破坏：无 conversationEvents 服务时 card 降级、webless profile 不受影响、client 包加载失败恢复模式路径未动；
- [ ] 体积增量合理（预估 +150~250KB min；超出即查 tree-shaking）；
- [ ] React hooks 规则（依赖数组/条件 hook）在迁移文件中无回归。

### 21.7.3 R2 修复轮 + R3 终验

- R2：按 R1 findings 逐条修复 + 复跑四绿（每条 finding 独立 commit）。
- R3：`pnpm verify`（verifyM0 + vitest）全套；体积对比表（基线 vs 终态）；冒烟清单（装机后人工五查：亮/暗主题跟随、卡片徽标、面板四视图、成员对话框、构建工作台）。

## 21.8 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Tailwind preflight 全局 reset 污染宿主 | 宿主整页样式破坏 | `preflight: false`（D19a）；R1 检查生成 CSS 无全局规则 |
| 工具类与宿主类名冲突 | 意外命中宿主元素 | `important: '.eteams-ui'` 双向隔离（D19b）；注意 `--tw-*` 变量默认值会全局注入（实证确认基本无害） |
| 动态拼接类名被 purge | 样式静默缺失 | 完整字面量映射表（21.5.1 content 扫描纪律） |
| Radix portal 逃出作用域 | dialog 样式失效 | 自管 portal 容器（同类名）+ Portal container 改造（D19b/S13） |
| 宿主变量是完整色值，v3 通道方案失效 / alpha 修饰失效 | 透明度类不生效 | 变量别名直引 + 禁用 `/alpha`（D19c）；半透明需求走专用 token |
| dva-core 的 redux-saga 0.16 老 API | 用错 1.x API 运行时报错 | effects 仅用 takeLatest/takeEvery/put/call/select 经典面（21.3） |
| react-redux 9.x 与 dva-core 的 redux peer 冲突 | install/运行时报 peer 冲突 | 锁 react-redux ~8.1.3 + redux ~4.2.1（21.3，registry 实测） |
| dva-core 无 .d.ts / `getStore()` 不存在 | typecheck 红、运行时 undefined | 自写 dvaCore.d.ts；用官方 `_store` 用法（D19e） |
| `global` 包浏览器 bundle | createStore 引用 global | global@4 typeof 探测安全；build 已 define process.env.NODE_ENV（tsdown 既有配置） |
| dva 启动后补注 model 不支持 | 运行时崩 | models 全量启动前注册（D19e） |
| envelope 膨胀 | 宿主加载变慢 | devDeps 全内联但按需 vendoring + 每步体积记录 + R1 阈值检查（预估：CSS 5–30KB + dva 栈 ~20KB min 级增量） |
| shadcn 源码与 TS strict/命名规范冲突 | lint/typecheck 红 | vendoring 时同步规整；components/ui 目录 kebab-case override（D19d） |
| npmmirror/网络波动 | 依赖安装失败 | 版本已在 21.3 锁定，重试即可；必要时走官方源 |
| vitest 线程池 + saga 组合 | 测试挂起 | effects 单测用 mock api + 有界 dispatch，不真起定时器 |

## 21.9 参考资料（本次已核实阅读）

- Tailwind CSS：[安装（v3 中文镜像）](https://www.tailwindcss.cn/docs/installation) · [Content 配置](https://www.tailwindcss.cn/docs/content-configuration) · [Preflight](https://www.tailwindcss.cn/docs/preflight) · [Dark Mode](https://www.tailwindcss.cn/docs/dark-mode) · [Standalone CLI 博客](https://tailwindcss.com/blog/standalone-cli) · [v3-lts dist-tag = 3.4.19（registry 核实）](https://registry.npmmirror.com/tailwindcss)
- shadcn/ui：[Docs](https://ui.shadcn.com/docs) · [Manual Installation](https://ui.shadcn.com/docs/installation/manual) · [Theming](https://ui.shadcn.com/docs/theming) · [components.json](https://ui.shadcn.com/docs/components-json) · [registry new-york 源码 JSON（实测）](https://ui.shadcn.com/r/styles/new-york/dialog.json)
- dva：[指南·特性（用户指定链接，已读）](https://dvajs.xiniushu.com/guide/) · [Dva 概念](https://dvajs.xiniushu.com/guide/concepts.html) · [dva API](https://dvajs.xiniushu.com/api/) · [dva-core 源码 index.js](https://github.com/dvajs/dva/blob/master/packages/dva-core/src/index.js) · [subscription.js](https://github.com/dvajs/dva/blob/master/packages/dva-core/src/subscription.js) · [dva-core（registry 核实：2.0.4，redux-saga 0.16）](https://registry.npmmirror.com/dva-core) · [react-redux 8.1.3 peers（registry 核实：react ^18 + redux ^4||^5）](https://registry.npmmirror.com/react-redux)
- 本仓既有先例：`tsdown.config.ts`（虚拟模块规避 css-guard）、`src/client/mdEditor.tsx`（样式字符串运行时注入 + `--dsw-*` 主题桥）、`docs/12.4`（轮询节拍）、`docs/13`（UI 设计基线）

## 附录 A：shadcn token ↔ 宿主变量映射表（S15 终态回写；S3 落地于 `src/client/eteams.css`）

> 与初版相比的微调：新增 `--destructive-foreground`（S4，button/badge 的 destructive 变体需要 on-色文本，宿主无专用别名，与 `--primary-foreground` 同源）；`--accent`/`--business` 兜底实现为嵌套 `var()`（别名缺失时再落到下一层兜底，非纯字面）。

| shadcn token | 宿主变量 | 兜底 |
|---|---|---|
| --background | --dsw-alias-bg-layer-1 | #ffffff |
| --foreground | --dsw-alias-label-primary | #1f2328 |
| --card | --dsw-alias-bg-layer-2 | #ffffff |
| --card-foreground | --dsw-alias-label-primary | #1f2328 |
| --popover | --dsw-alias-bg-layer-2 | #ffffff |
| --popover-foreground | --dsw-alias-label-primary | #1f2328 |
| --primary | --dsw-alias-brand-primary | #4b7bec |
| --primary-foreground | --dsw-alias-label-primary-foreground | #ffffff |
| --secondary | --dsw-alias-interactive-bg-hover | rgba(128,128,128,0.12) |
| --secondary-foreground | --dsw-alias-label-primary | #1f2328 |
| --muted | --dsw-alias-interactive-bg-hover | rgba(128,128,128,0.12) |
| --muted-foreground | --dsw-alias-label-tertiary | #6b7280 |
| --accent | --dsw-alias-accent | 嵌套 var(--dsw-alias-brand-primary, #4b7bec) |
| --accent-foreground | --dsw-alias-label-primary | #1f2328 |
| --destructive | --dsw-alias-state-error-primary | #d64545 |
| --destructive-foreground（S4 增补） | --dsw-alias-label-primary-foreground | #ffffff |
| --border | --dsw-alias-border-l2 | rgba(128,128,128,0.35) |
| --input | --dsw-alias-border-l2 | rgba(128,128,128,0.35) |
| --ring | --dsw-alias-brand-primary | #4b7bec |
| --radius | （直定） | 0.75rem |
| 扩展 --success | --dsw-alias-state-success-primary | #2e9e5b |
| 扩展 --warning | --dsw-alias-state-warn-primary | #c78a1d |
| 扩展 --business | --dsw-alias-state-business-primary | 嵌套 var(--primary) |

> 扩展 token（success/warning/business）超出 shadcn 标准集，服务既有 Tone 徽标语义；Tailwind `colors` 里以 `success/warning/business` 注册，badge 变体（S4 起 success/warning/business 三档）与 TONE_CLASS 查表直接消费。半透明需求（badge hover 压暗）按本表规则用 `color-mix(in srgb, var(--token) 80%, transparent)` 实现——实测 v3 任意值 + color-mix 可行。

## 附录 B：构建管线图

```
 src/client/eteams.css ──(tailwind CLI, content 扫描 src/client/**/*.{ts,tsx})──▶ lib/tailwind.gen.css [gitignored]
                                                                                            │
 src/client/index.tsx ── apply() ── ensureEteamsStyles() ◀── tailwind.ts ──(tsdown 虚拟模块, 字符串内联)─┘
                                                     │
                                                     ▼
                                          <style data-dsh-eteams-tw>  ← 幂等注入 document.head
```

## 附录 C：体积终态（S15 记录，口径 = `Get-Item lib/client.js).Length / 1KB` 四舍五入）

| 项 | 值 |
|---|---|
| `lib/client.js` 终态（S15 全量 build 后，单文件 CJS envelope，min） | **4012 KB**（4,108,322 B） |
| `lib/tailwind.gen.css`（`--minify`，gitignored，运行时字符串内联进 envelope） | 28.2 KB（28,911 B），落在预估 5–30KB 区间内 |
| S0 基线 | 基线值记录于 S0 步骤报告（工作流上下文），未持久化进仓库；各步增量以对应提交的体积记录为准 |

> 说明：envelope 同时承载 mdxeditor 全家（既有大头）与本次 UI 栈增量；本表只锚定终态绝对值与 Tailwind 产物体积，步骤级增量以各步 commit 记录与 S0 报告为准。
