# dsh-eteams

ETeams for DeepSeek Harness — 领队（captain）把目标拆解为任务、成员（members）
执行的多智能体团队插件，含会话内「团队」面板与执行槽 UI。

- 设计文档：[`docs/README.md`](docs/README.md)（决策表 D1–D15、里程碑计划 M0–M8）
- 当前里程碑：**M4 Web 基础 UI**（状态路由 + 对话卡片 + 只读面板；M1 生命周期已就绪）

## M4 能力一览（Web 基础 UI）

- **状态路由（宿主端，回环）**：`GET /plugins/dsh-eteams/state`（全量团队快照 + 归档摘要）、`/team/<id>/task/<tid>/track`（执行线路）、`/team/<id>/events?afterSeq=`（事件增量）、`/team/<id>/member/<name>/dialog`（成员对话框时间线）；懒绑定，webless profile 自动跳过
- **对话卡片（ETeamsCard）**：从 `eteams_create_team` 工具事件折叠，轮询快照实时渲染阶段徽标/成员行/进度条/最新事件 +「打开面板」
- **活动面板（团队 tab）**：团队切换器 + 四视图只读——概览（目标/进度/最近动态/决策横幅）、成员（卡片网格 + 状态点 + 对话记录）、任务（状态分组 + 执行链站点 ✔/●/◌ + 重试计数 + 详情抽屉执行线路）、动态（事件流）
- **轮询（docs/12.4）**：1s 活跃 / 5s 探测 / 页面隐藏暂停 / 恢复即刷，`useSyncExternalStore` 单循环

## M1 能力一览

- **状态**：`<workspace>/.eteams/<teamId>/`（team.json 快照 + events.jsonl 事件 + inbox/ 邮箱），原子写 + 每团队/每领队进程锁（docs/09）
- **领队工具**：`eteams_create_team / add_member / remove_member / update_member / create_task / update_task / delete_task / assign_task / advance_task / reassign_task / suspend_task / resume_task / cancel_task / send_message / team_status / task_board / list_teams / archive_team / delete_team / mailbox`
- **成员工具**：`eteams_claim_task / decline_task / append_progress / complete_task / fail_task / task_board / send_message / team_status`（经 `registerContinuableSetup` 注入子作用域；领队工具在 spawn 时 `toolFilter.deny` 屏蔽）
- **执行链（D11）**：`chain` 站点按序接力；偏离必须 `deviationNote`（chain.deviated 事件）；attempt token 在 claim 时签发、改派/取消即吊销
- **完成即续派（FR-36）**：站点完成当轮通知领队「下一站 + 续派提示」；重试超限进入 `awaiting_decision` + DecisionRecord（M2 接决策工具）
- **任务文档（D12）**：批准时生成 `teams/<team-slug>/README.md + tasks/tN-slug/contract.md（幂等渲染）+ notes.md（create-only）`

## 构建

```bash
pnpm install
pnpm build       # clean → tsc 声明 → tsdown 双包 → wrapClient 信封
pnpm typecheck
pnpm lint        # ESLint 质量检查（含文件名 camelCase 把关）
pnpm test
pnpm verify      # 校验 lib/ 产物、cordis.patch.yml、package.json 清单
pnpm format      # Prettier 全仓格式化（format:check 只校验）
```

## 安装到 DSH profile

```bash
dsh plugin --profile desktop add C:\eTeam
dsh --profile desktop --dump-config   # 应看到 id 为 eteams 的插件行
```

安装后：

- 对话区头部出现「团队」tab（位于 对话 / 轨迹 旁）；
- 输入区工具行右侧出现「团队」按钮，弹层 v1 含「＋ 新增团队」，点击跳转团队 tab；
- 会话内可调用 `eteams_ping` 冒烟工具验证宿主端连通性；
- 说「用 AgentTeams 做X」或 `/agent-teams`：领队建队 → 问询 → 拆解 → 等你批准 → 派活执行。

## 结构

| 路径               | 说明                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `cordis.patch.yml` | bundle patch：挂载插件行与默认配置（stateDir/workRoot/maxMembers/maxRetries/memberProvider）    |
| `src/host/`        | 宿主端插件（配置 schema、`eteams_ping`；M1+ 起为团队生命周期工具与运行时）                      |
| `src/client/`      | 浏览器端插件（`conversation.view` 团队 tab、`conversation.input.right` 团队按钮、tab 激活桥接） |
| `scripts/`         | clean / wrapClient（ModuleLoader 信封）/ verifyM0                                               |
| `docs/`            | 18 篇设计文档（中文）                                                                           |

## 文件与命名规范

参考《[迈向前端 Leader - 制定前端规范](https://juejin.cn/post/7490458997540372495)》，由 ESLint + Prettier 强制执行（`pnpm lint` / `pnpm format:check`）：

**文件/目录名** —— 代码文件一律小驼峰 camelCase（`eteamsView.tsx`、`teamsButton.tsx`、`wrapClient.mjs`、`versionLabel.ts`），由 `unicorn/filename-case` 规则把关。两类例外遵循各自生态的既定惯例：

- 工具链配置文件：`package.json`、`tsconfig.*.json`、`eslint.config.mjs`、`tsdown.config.ts`、`vitest.config.ts`、`cordis.patch.yml`、`README.md`
- 设计文档：`docs/` 保持既有编号命名

**代码标识符**（与文章规则一一对应）：

- 变量、函数：小驼峰 camelCase（`resolveConfig`、`callerLabel`）
- 类、类型、接口、React 组件名：大驼峰 PascalCase（`ETeamsView`、`TeamsButton`、`ETeamsResolvedConfig`）
- 模块级字面量常量：UPPER_SNAKE_CASE（`PLUGIN_VERSION`、`ETEAMS_VIEW_ID`），需变更的字面量一律先声明为常量再使用

**工具链分工**（文章 2.1 的最佳实践）：

- Prettier 管格式（`.prettierrc.json`：100 列、2 空格、加分号、单引号），ESLint 通过 `eslint-config-prettier` 关闭一切格式类规则，避免二者打架
- ESLint 管质量：`no-var` / `prefer-const` / `eqeqeq` / `@typescript-eslint/consistent-type-imports` / `no-unused-vars`，客户端文件启用 `react-hooks` 全套规则

## 许可

MIT
