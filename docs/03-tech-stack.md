# 03 技术选型

每节按「结论 -> 理由 -> 备选与放弃原因」组织。所有选型均可追溯到 [02 需求](02-requirements.md) 与 [README 决策记录](README.md)。

## 3.1 总览

| 层 | 选择 | 关键依赖 |
|---|---|---|
| 语言 | TypeScript 5.x（ESM，Node ≥22） | - |
| 宿主插件框架 | DSH 插件体系（cordis） | `@deepseek-ai/cordis` ^4.0.1 |
| 模型侧工具 | DSH 工具注册 | `@deepseek-ai/dsh-tools`（`defineTool`）、schemastery 参数 |
| 成员运行时 | 可续聊子代理 | `@deepseek-ai/dsh-subagent`（`startContinuable` / `followup` / `interrupt`） |
| 客户端 | React 18 + 宿主 UI 原语 | `@deepseek-ai/dsh-client-*`（runtime / ui-conversation / ui-layout / ui-model-selection / locale / primitives / slots） |
| 客户端状态同步 | HTTP 轮询 + 外部存储订阅 | 自建 `/plugins/dsh-eteams/*` 路由 + `useSyncExternalStore` |
| 持久化 | 本地 JSON 快照 + JSONL 事件日志 | `node:fs/promises`（无外部 DB） |
| 头像 | vue-color-avatar（MIT）数据移植 + React SVG 渲染器 | vendored 数据 + 自研渲染器 |
| 构建 | tsc + tsdown；客户端 CSS Modules（lightningcss） | 与参考实现同链 |
| 测试 | vitest（单测）+ 自建 verify 脚本（离线校验）+ 手工 GUI 清单 | - |
| 包管理/安装 | pnpm workspace 单包；`dsh plugin --profile desktop add .` | - |

## 3.2 宿主插件框架：cordis + cordis.patch.yml

**结论**：以 cordis 插件形态开发，`apply(ctx)` 为入口，`cordis.patch.yml` 声明 `- insert: {id: eteams, name: dsh-eteams, config: …}` 挂载进 profile 组合。

**理由**：
- 这是 DSH 唯一的官方插件机制；`dsh plugin add` 会把包 pnpm 安装进 profile 并把它和解进 `dsh.profile.bundles`。
- 依赖注入（`ctx.inject(['tools', 'subagents', 'commands', ...])`）让插件在缺服务的最小组合下可优雅降级（headless 无 Web 服务时保持工具可用）。
- 参考实现（dsh-agent-teams 0.1.14）已在生产验证此链路。

**备选**：
- *独立进程/独立 Web 服务*：放弃。无法访问会话智能体、子代理与系统提示词；UI 无法注入宿主界面；信任模型（回环 + 会话校验）难以复用。
- *只做客户端皮肤/脚本*：放弃。无法实现工具与状态机，需求主体不成立。

## 3.3 成员执行引擎：durable continuable subagent

**结论**：成员 = 领队派生的可续聊子代理（`ctx.subagents.startContinuable`），持久会话由 DSH 子代理机制存储；唤醒用 `followup`，打断用 `interrupt`；成员工具面通过 `registerContinuableSetup` 在子代理上下文注入。

**理由**：
- 「断点续行且成员上下文不丢」的核心诉求由该机制直接满足：子代理会话跨轮次、跨进程重启持久（见 [10](10-checkpoint-recovery.md)）。
- 每成员独立会话天然实现「每个团队都是新的上下文」（D3）与「成员最小上下文」（NFR-07）。
- `spawn`/`fork` 双 provider 已由宿主提供，profile 可配置。

**备选**：
- *每任务一次性子代理*：放弃。上下文不跨任务，重试/继续丢上下文，违背 FR-26/27。
- *workflow 工具编排*：放弃。workflow 是脚本化 fan-out，无持久会话、无邮箱、无逐任务人工干预面。
- *外部 Agent 框架*（LangGraph 等）：放弃。绕过 DSH 工具/审批/沙箱体系，无法保证安全边界与 UI 一致性。

## 3.4 客户端：React 18 + 宿主注入

**结论**：客户端为 React 18 组件包（`dsh.client.inject` 声明注入面），复用宿主 UI 原语（按钮、Tooltip、Modal、Pill、StateDot 等）与 locale 服务；不引入 Vue 运行时。

**理由**：
- DSH Web 前端是 React；客户端插件运行在宿主 React 树内，跨框架（Vue）组合成本高、包体大（D8 明确要求移植而非嵌入）。
- 注入面（conversation / layout / model-selection / locale / runtime / primitives / slots）覆盖本项目全部 UI 需求：对话卡片、浮动面板、staged 编辑器。
- 与宿主同栈意味着主题（亮/暗、亚克力材质）、国际化、无障碍基线免费获得。

**备选**：
- *iframe 嵌独立 Vue 应用*：放弃。头像编辑器场景曾考虑；跨 iframe 通信、鉴权、主题适配复杂，且 D8 已选择移植路线。
- *纯 markdown/对话内交互*（无面板）：放弃。FR-30/31 的管理面（多团队切换、任务表格、执行线路）在纯对话里不可用。

## 3.5 客户端状态同步：轮询 + 快照路由

**结论**：服务端注册 `/plugins/dsh-eteams/state` 等只读/操作路由；客户端共享一个轮询控制器（活跃团队 1s、无团队探测 5s、空闲休眠），用 `useSyncExternalStore` 订阅稳定快照。

**理由**：
- 磁盘是唯一真相（NFR-01），「读快照」模型让 UI 无需本地状态机副本，刷新/重开即恢复。
- 参考实现已验证该模式在 Electron 回环环境下的延迟与负载（1s 轮询 + 引用计数目标 + 降频探测）。
- 避免引入 WebSocket/SSE 的连接管理复杂度；v0.2 的交互密度（1s 感知足够）不构成升级理由。

**备选**：
- *SSE/WebSocket 推送*：列为 v0.3 候选（当执行线路事件流密度提高时）；v0.2 放弃以控制复杂度。
- *客户端直读磁盘*：不可行。浏览器无文件系统访问，且绕过会话归属校验。

## 3.6 持久化：JSON 快照 + JSONL 日志，无外部 DB

**结论**：每团队目录 `<workspace>/.eteams/<teamId>/`：`team.json`（全量快照，schemaVersion）+ `events.jsonl`（append-only 事件）+ `inbox/<actor>.jsonl`（邮箱）。原子写：临时文件 + 同目录 rename（Windows EPERM 重试 + 降级直写）；进程内 per-team 异步串行队列。任务工作文档（README/任务合同/执行笔记，D12）另存于 `<workspace>/teams/<team-slug>/`（workRoot 可配置），属可见的工作区产物层（[10](10-checkpoint-recovery.md) L3），与隐藏状态目录分离。

**理由**：
- 状态规模（≤100 任务）远未到需要 DB 的量级；文件即真相与 DSH 工作区模型（可 git、可检视、可手工恢复）契合。
- 事件日志天然满足审计（NFR-05）与恢复（快照 + 日志重放）两个需求，是断点续行的磁盘基础（见 [09](09-persistence.md)、[10](10-checkpoint-recovery.md)）。
- 单写者假设（NFR-03）使「锁」可以退化为进程内队列，无需文件锁的跨平台泥潭。

**备选**：
- *SQLite*：放弃。引入原生依赖与迁移负担，收益仅在有复杂查询需求时成立。
- *仅内存 + 定期落盘*：放弃。崩溃窗口丢状态，违背 NFR-04。

## 3.7 头像：vue-color-avatar 数据移植 + React SVG 渲染器

**结论**：从 vue-color-avatar（MIT）固定 commit 提取形状 SVG 数据与配色，作为 vendored 资产入库（保留上游版权声明）；自研确定性 PRNG（种子 = 成员 ID + salt）生成 `AvatarOption`；React 组件按 option 组合 SVG 渲染。编辑器为简化版（重摇 + 逐类别微调）。

**理由**：
- 视觉与上游一致（同数据同算法），无 Vue 运行时、无 iframe、无网络依赖（离线可用）。
- 确定性种子保证：同一成员在任何端渲染出同一头像；重摇 = 换 salt（D8）。
- MIT 许可允许数据移植，义务是保留版权与许可声明（进 NOTICE）。

**备选**：
- *内嵌 Vue 微应用*（完整编辑器）：放弃。需打包 Vue 运行时，包体与双框架维护成本高；完整换装编辑器收益低。
- *预生成图片库*：放弃。不可再编辑、组合空间受限、多分辨率发糊。
- *DiceBear 等在线头像 API*：放弃。离线不可用、外部依赖、风格不受控。

**风险与兜底**：上游数据结构无稳定 API 承诺 -> 提取脚本锁定 commit + vendored 快照入库 + 提取物带校验和（详见 [14](14-avatar-system.md)）。

## 3.8 构建链与工程形态

**结论**：
- 单包仓库（`dsh-eteams`），`src/host/**`（服务端）与 `src/client/**`（客户端）分开编译，`lib/index.js` + `lib/client.js` 双入口（exports `.` 与 `./client`），`package.json` 声明 `dsh` 字段（bundle.patch / client.inject / platform）。
- 构建：`tsc`（类型检查）+ `tsdown`（打包）；CSS Modules 经 lightningcss。
- 脚本：`build` / `typecheck` / `test`（vitest）/ `verify`（离线完整性校验：状态机、恢复重放、工具 schema、路由契约）/ `avatar:extract`（上游数据提取）。

**理由**：与参考实现同链，已被 DSH 插件生态验证（安装、客户端热载、类型引用）；双入口是客户端注入协议的要求。

**备选**：
- *pnpm monorepo 多包*：v0.2 放弃（单包足够，降低安装摩擦）；若未来拆出独立头像库再迁移。
- *esbuild 直出*：可行但放弃一致性收益（tsdown 底层即 esbuild/rolldown 系）。

## 3.9 测试与安装

- **测试**：vitest 单测覆盖状态机迁移/锁/重试阶梯/恢复重放/头像种子确定性；verify 脚本做离线组合校验（模拟工具调用全流程）；GUI 手工清单（见 [16](16-testing-acceptance.md)）。
- **安装**：开发期 `dsh plugin --profile desktop add .`（本地路径链接）；发布前 `npm pack` 校验 files 清单。**注意**：desktop profile 中存在旧 `dsh-eteams` 0.1.1 的失效引用（`file:C:/Users/epat/eTeam/dsh-eteams-0.1.1.tgz`），安装新版前需先移除（见 [15 开发计划](15-development-plan.md) M0）。

## 3.10 明确不引入的技术

| 技术 | 不引入原因 |
|---|---|
| Vue / veaury | D8 已选移植路线；双框架运行时成本 |
| WebSocket / SSE | 轮询已满足 v0.2 交互密度 |
| SQLite / LevelDB | 规模不需要；文件即真相更契合工作区模型 |
| 图数据库 / DAG 引擎 | 依赖判断是简单拓扑计算，纯函数即可 |
| Electron 原生 API | 插件运行在宿主进程，无需直接触达 |
| 外部头像服务 | 离线与风格受控要求 |
