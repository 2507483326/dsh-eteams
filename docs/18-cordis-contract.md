# 18 Cordis 运行时契约（官方文档对齐）

> 来源：DeepSeek Harness 官方 Cordis 教程（develop/cordis-tutorial 01–07 章）。
> 本文把它提炼为本仓库的强制开发契约，并附 2026-08-28 启动事故的复盘。
> **与官方文档冲突时以官方为准**；本文变更需同步 README 索引。

## 0. 官方文档索引

| 章 | 主题 | URL（deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/ 下） |
|---|---|---|
| 01 | 第一个插件 | `01-first-plugin` |
| 02 | 生命周期与 effect | `02-lifecycle-and-effects` |
| 03 | 服务 | `03-services` |
| 04 | 事件 | `04-events` |
| 05 | 配置 | `05-config` |
| 06 | 组合与 HMR | `06-composition-and-hmr` |
| 07 | 进入 harness | `07-into-the-harness` |

## 1. 生命周期与 effect（第 2 章）

- Fiber 状态机：`PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED`，失败分支 `FAILED`。
  - `PENDING`：已声明但所需服务尚不可用（合法状态，见第 3 章）。
  - `FAILED`：`apply` 抛异常或配置校验失败。
- Cordis 管理的注册（`ctx.on` / `ctx.plugin` / 服务注册 / `ctx.tools.register`）**本身就是 effect**：随插件卸载自动撤销，不需要手写 disposer。
- Cordis 不管资源（定时器、watcher、连接、外部 HTTP 路由句柄）：必须 `ctx.effect(fn)` 包裹并返回 disposer。
  - disposer 按注册逆序启动，但**多个异步 disposer 并发运行**；必须按序拆除的步骤放进同一个 disposer 内依次 await。
- `ctx.plugin(fn)` 函数形态插件：Cordis 直接调用该函数，无需 `apply`；返回 fiber 句柄。`fiber.dispose()` 等待全部清理（含异步）完成后才结束，并递归卸载子插件。

**本仓库应用**：`installWebSurface` 的路由注册必须经 `ctx.effect` 处置；`internal/service` 监听用 `ctx.on`（自动撤销）。

## 2. 服务与 inject（第 3 章）

- 服务 = `Service` 子类 + `super(ctx, '<name>')`；消费方 `inject: ['<name>']` 硬依赖。
- **inject 决定 PENDING**：列出的服务任一缺失，插件停在 PENDING（不报错、不输出）；加载顺序无关。
- **inject 是持续契约**：运行中服务消失 → 依赖插件随之卸载；服务恢复 → 重新加载。
- 可选依赖**不进 inject**：使用 `ctx.get('<name>')` 探测（undefined 时插件照常运行）。
- 服务名是**扁平命名空间**：自有服务必须加前缀（harness 已占用 `tools` / `llm` / `agents` 等普通名）。

**本仓库应用（教训，见 §8）**：客户端模块的 `exports.inject` 是 fiber 服务门禁白名单——**代码里访问 `ctx.<service>` 属性之前，必须先在该列表声明**；未声明的属性读取在 guarded ctx 上直接抛错。

## 3. 事件（第 4 章）

- `ctx.on(event, listener)` 是 effect，随插件卸载移除；`declare module` 的 `interface Events` 合并提供类型。
- 五种分发模式：`emit`（同步广播）/ `parallel`（并发等齐）/ `serial`（顺序，首个非空返回胜出）/ `bail`（serial 同步版）/ `waterfall`（环绕中间件，可转换可短路）。
- **waterfall 纪律**：只观察/标注的监听器**必须调用 `next()`**；不调用直接返回 = 有意短路。日志类监听器漏调 `next()` 会静默吞掉全部下游默认行为。
- harness 用 waterfall 承载可被协作插件替换的决策（`agent/request`、`approval/request`）。

## 4. 配置（第 5 章）

- `export const Config: Schema<Config> = Schema.object({...})`（Schemastery）：既是 TS 类型又是运行时校验器；`apply(ctx, config)` 收到**完整且已验证**的配置。
- 校验失败 → fiber `FAILED`（不是静默默认值）。
- `!!js` 标签仅在 `config` 与条目 `disabled` 字段内合法（加载时求值）。

**本仓库应用**：`src/host/config.ts` 的 `ETeamsConfig` schema 遵循此形态；`cordis.patch.yml` 的 `memberProvider` 等枚举值靠 schema 校验挡错。

## 5. 组合与 HMR（第 6 章）

- 组合条目应携带稳定 **`id`**：无 id 的条目每次编辑配置都被视为先删后装（HMR 全量重挂）。
- `disabled: true` 保留条目但跳过挂载；组（group）可整体装卸；`isolate` 给组提供独立服务实例。
- HMR = 先卸载（回卷全部 effect）再加载；编辑 `cordis.yml` 本身也触发按 id 的增量更新。
- **PENDING 诊断**：`ctx.registry` 枚举 fiber，`FiberState.PENDING` + `fiber.inject` 缺失服务名 = 「插件为什么没输出」的标准答案。

## 6. 进入 harness（第 7 章）

- 工具插件 `inject: ['tools']`；`ctx.tools.register(defineTool({...}))` 的 disposer 自动附着到插件。
- `defineTool` 的 `parameters` 规约转换为模型可见 JSON Schema 并在 execute 前校验；`output.schema` 声明规范值，`output.render` 为原生渲染器。
- 观察类插件用 `ctx.on('tools/result', ...)`（声明合并由 `import type {} from '@deepseek-ai/dsh-tools'` 引入）。
- 工具插件还依赖 `systemPrompt`（由 `@deepseek-ai/dsh-tools` 注入）——组合里缺提供方会 PENDING。

## 7. 本仓库补充契约（与官方对齐后的本地规则）

### 7.1 路由命名空间（⚠️ 事故根因）

- client-modules（node 半区）**独占 `/plugins` 前缀**：每个浏览器插件（图行 id = 包名）的 bundle 由它下发，URL 为 `/plugins/<包名>/client.js?rev=<内容哈希>`。
- **插件自有 HTTP API 禁止注册在 `/plugins/*` 之下**——prefix 路由按最长前缀匹配，会把 bundle 请求劫持成 404，导致渲染端启动失败、应用进恢复模式。
- 本仓库插件 API 统一使用顶级前缀 **`/eteams-api`**（webServer 无重复 `(kind, path)` 之外的组合限制；重复注册同 `(kind, path)` 抛错）。
- webServer / workspaceRegistry 是兄弟服务，headless 不存在：懒绑定 = 立即尝试 + `ctx.on('internal/service')` 重试 + `ctx.effect` 处置（缺服务永不阻塞 boot）。

### 7.2 客户端模块契约

- 信封：`window.__ModuleLoader__.load({ id: pkg.name, factory(require) {...} })`（wrapClient 生成）；懒 CJS——一切副作用（含 CSS 注入）必须在 factory 闭包内。
- `package.json` 的 `dsh.client.inject`：apply 之前预挂载的浏览器模块清单（图行 external 之外的客户端依赖），对齐参考插件五项：locale / runtime / ui-conversation / ui-layout / ui-model-selection；`dsh.client.platform` 必须为 `"web"`。
- `exports.inject`（客户端模块导出）：**guarded ctx 的服务门禁白名单**。规则：代码访问的每个 `ctx.<service>` 都必须出现在列表里；未声明访问 → `service "X" is not declared by your plugin` 抛错。本仓库客户端固定声明 `['slots', 'conversationEvents']`。
- 渲染隔离：每个自有表面（tab / 按钮 / 卡片）包 `ClientErrorBoundary`；`apply` 内每个注册步骤包 `guard()`——客户端故障降级为日志，不允许拖垮 GUI。
- 客户端错误遥测：全局 error/unhandledrejection 捕获 → `POST /eteams-api/client-log` → `<workspace>/.eteams/logs/client.log`（400 行环形）。

### 7.3 defineTool schema DSL（运行时强约束）

- `required: true` 只允许出现在**根参数属性**上（`strR` helper）。
- 输出 schema 与嵌套值 schema（如 chain 站点项）**禁止任何 `required`**（数组形式与标量都不行）——运行时抛 `schema.required is not supported by the value schema DSL`，且该错误发生在宿主 apply 期，直接使插件树加载失败。

### 7.4 交付门禁（每个里程碑合并前必跑）

1. `npm run verify`（verifyM0 + vitest）
2. `npm run lint && npm run typecheck && npm run format:check`
3. verifyM0 必须包含：envelope/id/工厂形态、**`exports.inject` 声明完整性**、manifest 五项对齐、bundle 体积预算
4. 涉及路由/服务/事件的改动：对照 §7.1 / §7.2 / 第 3 章逐条自检

## 8. 事故复盘（2026-08-28「装上插件就启动不了」）

| # | 现象 | 根因 | 对应契约 |
|---|---|---|---|
| 1 | 插件一装上，桌面端就进恢复模式；卸载即恢复 | 宿主路由 `/plugins/dsh-eteams`（prefix）劫持了 client-modules 下发的 bundle URL `/plugins/dsh-eteams/client.js`（最长前缀匹配）→ 404 → 渲染端模块到达失败 | §7.1 |
| 2 | 修复 #1 前，「空包」同样失败 | 与包内容无关——bundle 根本没能送达 | §7.1 |
| 3 | M4 首包 apply 抛错 | 客户端代码访问 `ctx.conversationEvents` 但 `exports.inject` 只声明了 `['slots']`，guarded ctx 门禁抛错 | §7.2 / 第 3 章 |
| 4 | 更早：插件树加载失败（00:47） | defineTool 输出/嵌套 schema 带 `required`，运行时 DSL 抛错 | §7.3 |

**方法论沉淀**：宿主日志只能看到宿主半区；渲染端失败要靠客户端遥测（§7.2）+ A/B bisect（`scripts/bisect-client.mjs`：real/noop/slots/card 四档）定位。「官方文档 + 参考插件」逐层对齐优先于猜测。
