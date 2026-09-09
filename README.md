# dsh-eteams

ETeams for DeepSeek Harness（DSH）：领队（captain）把目标拆解为任务、成员（members）经子代理执行的多智能体团队插件。含会话内「团队」面板、会话绑定、成员对话框、执行链与 SQLite 持久状态。

- 包名 `dsh-eteams`，插件 id `eteams`；双端单包：宿主端（Node 插件，`lib/index.js`）+ 浏览器端（客户端 bundle，`lib/client.js`）。
- 运行环境 Node `^22.19.0 || >=24`（依赖内置 `node:sqlite`），包管理 pnpm。

## 能力一览

- **团队与任务生命周期**：`eteams_create_team / add_member / remove_member / update_member / create_task / submit_task / update_task / delete_task / assign_task / advance_task / reassign_task / suspend_task / resume_task / cancel_task / send_message / team_status / task_board / list_teams / delete_team / mailbox / member_save / member_list` 等领队工具；成员侧 `eteams_claim_task / decline_task / append_progress / complete_task / fail_task / task_board / send_message / team_status`（spawn 时注入成员子作用域，领队工具被 `toolFilter.deny` 屏蔽）。
- **执行链**：任务带成员序列（chain），站点按序接力；偏离必须写 `deviationNote`；接活时签发一次性 attempt token，改派/取消/重试即吊销；同成员自动重试（默认 3 次），超限进 `wait_decision` + 决策记录（挂起 / 换人 / 通知用户）。
- **会话绑定与转交**：`POST /eteams-api/session-team` 把对话绑定到团队（会话提示词注入团队协作带）；`eteams_dispatch_captain` 把对话任务转交一次性领队子代理主持；面板选人写 `session-persona`（会话提示词注入人设带）。
- **成员构建（角色构建师）**：`/eteam` 斜杠命令或面板入口 → 面试问询（`eteams_build_report / build_wait / interview_answer`）→ 确认后常驻构建子代理产角色手册，落全局角色库。
- **用量台账**：root 作用域监听会话事件采集模型 usage，单事务写明细 + 日总计；面板看板页展示日历热力图。
- **Web 面板（浏览器端）**：宿主回环路由 `/eteams-api` 前缀下读端（全量快照 / 事件增量 / 执行线路 / 成员对话框 / 用量日历）+ 写端（session-team、session-persona、client-log 等）；面板壳内 MemoryRouter 五页签：看板 /team /roster /tasks /reports；轮询 1s 活跃 / 5s 空闲 / 页面隐藏暂停 / 恢复即刷。
- **对话卡片**：从 `eteams_create_team` 工具事件折叠的 ETeamsCard，轮询快照实时渲染阶段徽标、成员行、进度条。

## 命令总览

### 会话命令

- `/eteam [需求描述]`：新增成员 · 角色构建师的命令面入口（`--add-people` 前缀可选，参数可省略、落到模板句「我需要创建一个成员 【成员名称】，它的职责是【职责】」）。斜杠输入本身不到达模型，handler 把激活消息显式 steer 到主代理：面试问询经 `eteams_build_report / build_wait / interview_answer` 往返，确认后常驻构建子代理产角色手册、落全局角色库。无 commands 服务的部署（UI-less）退化为纯文本前缀路径，仍有效。
- `eteams_ping`：连通性冒烟工具，安装后首选验证。

### 领队工具（root 作用域；成员子作用域被 `toolFilter.deny` 屏蔽）

| 分组     | 工具                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 团队     | `eteams_create_team` · `eteams_list_teams` · `eteams_delete_team`                                                                           |
| 成员     | `eteams_add_member` · `eteams_remove_member` · `eteams_update_member` · `eteams_member_save` · `eteams_member_list`                         |
| 角色构建 | `eteams_build_report` · `eteams_build_wait` · `eteams_build_dispatch` · `eteams_interview_answer`                                           |
| 任务编排 | `eteams_create_task` · `eteams_submit_task` · `eteams_update_task` · `eteams_delete_task`                                                   |
| 派发执行 | `eteams_assign_task` · `eteams_advance_task` · `eteams_reassign_task` · `eteams_suspend_task` · `eteams_resume_task` · `eteams_cancel_task` |
| 协同     | `eteams_send_message` · `eteams_team_status` · `eteams_task_board` · `eteams_mailbox` · `eteams_dispatch_captain`                           |

### 问答工具（根作用域注册、不进 deny 列表，领队/成员子代理统一可用）

- `eteams_ask_user`：向用户弹问答——用户正在看提问会话就就地弹（答案同步返回）；不在则转交主会话弹出并立即返回（提问方结束回合）。
- `eteams_ask_answer`：转交弹窗所在对话的答案回收入口（主会话/被中转会话均可提交）；构建访谈问答单也经它桥接回收。

### 成员工具（spawn 时注入成员子作用域）

- 执行面：`eteams_claim_task`（接活签发一次性 attempt token）· `eteams_decline_task` · `eteams_append_progress` · `eteams_complete_task` · `eteams_fail_task`
- 视图与协同：`eteams_task_board` · `eteams_send_message` · `eteams_team_status`

### 开发命令（pnpm）

`build` / `typecheck` / `lint` / `lint:fix` / `format` / `format:check` / `test` / `verify` / `prepublishOnly`——逐条说明见 [开发](#开发)。

### 工具脚本（`node scripts/…`）

- 构建链零件（由 `pnpm build` / `pnpm verify` 串联，一般不单独跑）：`clean` · `buildTailwind` · `wrapClient` · `smokeEnvelope` · `verifyM0`
- 资产再生成：`genAvatarWidgets.mjs`（vendored SVG → `avatarWidgets.ts`，换素材后重跑）· `gen-role-docs.cjs`（一次性：拉取 agency-agents-zh 角色手册 → `roleDocs.ts`）
- 预览与诊断（排障用）：`avatarPreview.mjs`（头像画廊浏览器预览）· `scanSlots.cjs` / `list-routes.cjs` / `list-primitives.cjs`（从 DSH asar 枚举槽位/路由/原语）· `bisect-client.mjs`（客户端信封 A/B 二分）

### dsh CLI

- `dsh plugin --profile desktop add C:\eTeam`：live link 安装到 profile
- `dsh --profile desktop --dump-config`：核对插件装配结果

## 项目结构

```
cordis.patch.yml        bundle patch：挂载插件行 + 默认配置（stateDir/workRoot/maxMembers/maxRetries/memberProvider）
src/host/               宿主端插件
  index.ts              apply() 装配：领队工具（root 作用域）、成员运行时、用量计、web 面、/eteam 命令
  config.ts             配置 schema（cordis loader 校验）
  tools/                eteams_* 工具面（captainTools / memberTools / captainDispatch / identity）
  model/                纯领域模型：taskMachine 任务状态机、contract 任务合同渲染、types
  state/                SQLite 持久层：db（连接/DDL/迁移）、store（整存整取）、events、queries、lock、usageStore
  runtime/              运行时：members（成员子代理）、assignment（派发/接活/完成）、roster（角色库）、
                        roleBuilder + builderPhases（成员构建）、sessionPersona / sessionTeam（会话绑定带）、
                        webui（/eteams-api 回环路由）、usage（用量）、workspaces（多工作区登记）
  prompts/              领队/构建师/会话带等提示词（system / personas / spawn / handoff / steering）
  commands/             /eteam 斜杠命令（新增成员入口，显式 steer 激活消息）
src/client/             浏览器端插件
  index.tsx             apply() 注册槽位表面：conversation.view 团队 tab、input.right 团队按钮、
                        hero DOM 注入按钮、对话卡片、命令视图入口
  pages/                页面（二级域目录 board / roster / tasks / team / reports，teamsView 只留壳：index/rail/routes）
  store/                dva 单例 store：activity / ui / roster / build 四 model
  lib/                  api（fetch 封装）、monitor（快照轮询 store）、bridge（视图 id/标签）、diagnostics 等
  components/ui/        vendored shadcn 风格组件（Radix 三件套，Select 走自管 portal）
  features/             avatar（角色头像 SVG）、backdrop（背景板动画引擎）、mdEditor（mdxeditor）、tasks
scripts/                构建与校验脚本（clean / buildTailwind / wrapClient / smokeEnvelope / verifyM0 / gen-role-docs 等）
tests/                  vitest 单测（按源模块镜像命名；support/tmpWorkspace.ts 造临时工作区）
assets/avatar/          头像素材（scripts 生成预览 widget）
lib/                    构建产物（gitignore）：index.js（宿主 CJS）、client.js（ModuleLoader 信封）、tailwind.gen.css、types/
```

## 项目流程

1. **安装挂载**：`dsh plugin --profile <name> add <本包>` → cordis.patch.yml 把插件行插入 profile bundle → 宿主启动时 `apply()` 装配：领队工具与成员工具都注册在 root 作用域（harness 0.1.2 起 `registerContinuableSetup` 被宿主移除，子代理可见性由 spawn 的 `toolFilter.deny` 收口）、用量计监听 root 事件流、web 面懒绑定（webless profile 自动跳过，不阻塞启动）。
2. **建队拆解**：用户说「用 AgentTeams 做 X」（或面板「＋ 新增团队」）→ 领队 `eteams_create_team` → 问询补齐 → 拆解为大任务（容器，`parent_id` 为空）与小任务（挂靠父任务，带依赖列表与成员链）→ 等用户批准 → `submit_task` 就绪。
3. **派发执行**：`eteams_assign_task` 派发 → 成员子代理 `eteams_claim_task` 接活（签发 attempt token）→ 按执行链站点接力：站点完成即通知领队「下一站 + 续派」，`advance_task` 推进游标 → 末站完成任务 completed。成员进度经 `eteams_append_progress` 落 attempt 记录。
4. **失败与升级**：同成员失败自动重试（`maxRetries` 预算内），换人/重试即作废旧 token；超限任务进 `wait_decision` 并生成决策记录，等领队/用户拍板：挂起（可恢复到阻塞前状态）、换人（reassign）、或通知用户。
5. **对话协同**：主会话把对话任务 `eteams_dispatch_captain` 转给一次性领队子代理主持；面板把成员选中/团队选择经 POST 写回宿主，注入对应会话的系统提示词带。
6. **面板渲染**：客户端单循环轮询 `/eteams-api` 快照与事件增量，dva model 分发，MemoryRouter 域页切换；写操作 POST 回宿主即改持久层。

## 项目设计

- **双端单包插件**：宿主端与客户端各自 `apply()` + `inject` 服务声明（宿主 `tools/subagents/agents/systemPrompt/commands`；客户端 `slots/conversationEvents/modelDirectories`），cordis 容器按声明门禁服务访问。
- **纯核薄壳**：`model/` 与 `state/` 保持纯函数、无 I/O 框架依赖；只有 `runtime/` 与 `tools/` 经 `runtime/base.ts` 的 `RuntimeContext` 缝接触宿主服务。
- **任务状态机**：10 态收敛（draft / ready / wait / start / paused / wait_decision / wait_user / completed / failed / cancelled），非法转移抛 `TransitionError`（带可执行中文提示）；「阻塞」不设独立状态——物化为 `wait + blockedFrom`，恢复时重验依赖。
- **成员=角色**：`roles` 是全局角色库（人设手册、工号、头像、一句话简介）；`team_members` 是团队班底行（松引用角色 + 派发模型路线）；`task_members` 是执行实例（状态、子代理会话锚点、当前任务）；真相在 roles，班底行存副本随写刷新。
- **写路径纪律**：SQLite 无外键/CHECK/UNIQUE——规则全部由写入代码保证；团队写 = 单 `BEGIN IMMEDIATE` 事务内 DELETE 该团队全部行 + 原号重 INSERT（崩溃要么整体回滚要么整体生效）；事件表只追加（审计）；邮箱消息按收件箱投递，`message_id` 幂等去重。
- **构建管线**：clean → tsc 双端声明 → Tailwind CLI 产 `lib/tailwind.gen.css`（并内联 fontsource 字体）→ tsdown 双包（宿主普通 CJS；客户端单文件 CJS）→ wrapClient 把客户端包卷进 `window.__ModuleLoader__` 信封（原子替换，运行中的 DSH 实例永远看不到半成品）→ smokeEnvelope 冒烟。

## 项目存储

- **单库 SQLite**：`<stateDir>/db/eteams.db`。`stateDir` 配绝对路径 = 全局单库——所有工作区共用一个 eteams.db、一份角色库、一份用量台账（当前 profile 配 `C:/Users/epat/.eteams`）；配相对路径 = per-workspace 旧口径（`<workspace>/<stateDir>`）。连接按状态根缓存（同进程单连接），WAL + `synchronous=NORMAL` + `busy_timeout=3000` 构成单写多读。
- **Schema v6，12 张表**：`schema_meta`（元数据键值）、`team`、`roles`（角色库）、`team_members`（班底）、`task`（大/小任务，含合同 MD、成员链、游标、重试计数、状态说明、阻塞还原点、工作目录）、`task_members`（执行实例，领队行 `name='项目牧羊人'` 且 `main_task_id` 为空）、`attempts`（一行一次尝试，含一次性 token、进度、结果、变更文件）、`events`（追加审计事件）、`mail_messages`（邮箱）、`decisions`（升级决策）、`task_status_changes`（状态流转记录）、`usage_detail` + `usage_daily_total`（用量明细与日总计，DB 即唯一存储）。
- **任务工作文档**：`<workspace>/teams/<team-slug>/` 下 `README.md` + `tasks/tN-slug/contract.md`（任务合同，幂等渲染）+ `notes.md`（create-only）。
- **schema 副本约束**：[schema.sql](src/host/state/schema.sql) 与 `src/host/state/db.ts` 内嵌 `SCHEMA_SQL` 常量必须逐字一致（宿主是单文件 bundle 读不到同目录资产，故内嵌一份；schema.sql 是审核对照副本）。版本迁移在 `getDb` 内 ALTER + 回填。

## 开发

```bash
pnpm install
```

```bash
pnpm build       # clean → tsc host/client → tailwind → tsdown 双包 → wrapClient 信封 → 冒烟
```

```bash
pnpm typecheck
```

```bash
pnpm lint        # ESLint（含文件名 camelCase 把关）
```

```bash
pnpm test
```

```bash
pnpm verify      # 校验 lib/ 产物、cordis.patch.yml、package.json 清单 + 全量测试
```

```bash
pnpm format      # Prettier 全仓格式化（format:check 只校验）
```

跑单个测试文件：

```bash
pnpm vitest run tests/lifecycle.test.ts
```

安装到 DSH profile（live link）：

```bash
dsh plugin --profile desktop add C:\eTeam
```

```bash
dsh --profile desktop --dump-config
```

安装后：对话区头部出现「团队」tab、输入区工具行出现「团队」按钮、会话内可用 `eteams_ping` 冒烟验证连通性。

## 命名与格式规范

由 ESLint + Prettier 强制执行（`pnpm lint` / `pnpm format:check`）：

- **文件/目录名**：代码文件一律小驼峰 camelCase（`eteamsView.tsx`、`wrapClient.mjs`），`unicorn/filename-case` 把关。例外：工具链配置文件（`package.json`、`tsconfig.*.json`、`eslint.config.mjs`、`tsdown.config.ts`、`vitest.config.ts`、`cordis.patch.yml`、`README.md`）。
- **代码标识符**：变量/函数 camelCase；类/类型/接口/React 组件 PascalCase（`ETeamsView`）；模块级字面量常量 UPPER_SNAKE_CASE（`PLUGIN_VERSION`），需变更的字面量先声明为常量再使用。
- **工具链分工**：Prettier 管格式（100 列、2 空格、加分号、单引号），ESLint 经 `eslint-config-prettier` 关闭一切格式类规则；ESLint 管质量（`no-var` / `prefer-const` / `eqeqeq` / `consistent-type-imports` 等，客户端文件启用 `react-hooks` 全套）。

## 许可

MIT