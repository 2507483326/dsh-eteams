# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目是什么

`dsh-eteams`（插件 id `eteams`）：DeepSeek Harness（DSH）的多智能体团队插件——领队（captain）拆解目标为任务、成员（members）经子代理执行，带执行链、邮箱、决策升级与 SQLite 持久状态。**双端单包**：

- **宿主端**（`src/host/`，产出 `lib/index.js`）：cordis 插件，注入 `['tools', 'subagents', 'agents', 'systemPrompt', 'commands']`，注册 `eteams_*` 工具面、成员运行时、用量计、回环 Web 面、`/eteam` 命令。
- **客户端**（`src/client/`，产出 `lib/client.js` 单文件 CJS 信封）：浏览器插件，注入 `['slots', 'conversationEvents', 'modelDirectories']`，注册「团队」tab / 输入区团队按钮 / hero 按钮 / 对话卡片。

环境：Node `^22.19.0 || >=24`（用内置 `node:sqlite`）、pnpm、Windows。注释与用户可见文案一律中文，注释写「为什么」而非复述代码。

## 常用命令

```bash
pnpm build       # clean → tsc host → tsc client → buildTailwind → tsdown 双包 → wrapClient 信封 → smokeEnvelope
```

```bash
pnpm typecheck   # tsc -p tsconfig.host.json + tsconfig.client.json --noEmit
```

```bash
pnpm lint        # eslint .（含 unicorn/filename-case 文件名 camelCase 把关）
```

```bash
pnpm test        # vitest run
```

```bash
pnpm vitest run tests/lifecycle.test.ts        # 单个测试文件
```

```bash
pnpm vitest run tests/model.test.ts -t "状态机"  # 按用例名过滤
```

```bash
pnpm verify      # node scripts/verifyM0.mjs（校验 lib/ 产物、cordis.patch.yml、package.json 清单）+ vitest run
```

```bash
pnpm format      # prettier --write .（format:check 只校验）
```

```bash
dsh plugin --profile desktop add C:\eTeam   # 安装到 DSH profile（live link）
```

发布前 `prepublishOnly` 会串 build → typecheck → lint → test 全链。

## 架构大图

### 分层纪律（最重要的约定）

- `src/host/model/`（任务状态机、合同渲染、类型）与 `src/host/state/`（SQLite 持久层）是**纯代码**：无 cordis、无 I/O 框架依赖，可被单测直接驱动。
- 只有 `src/host/runtime/` 与 `src/host/tools/` 允许接触宿主服务，且统一经 [base.ts](src/host/runtime/base.ts) 的 `RuntimeContext` 缝（logger / subagents / sessions 等的最小结构视图），不 import cordis 具体类型。
- 客户端每个表面对独立 `guard()` try/catch + `ClientErrorBoundary`，错误永远汇入诊断通道（console + 宿主 `client.log` 文件），**任何注册失败不得致命**。

### 宿主端装配（`src/host/index.ts` apply）

1. 领队工具注册在 **root 作用域**；成员子代理 spawn 时经 `toolFilter.deny` 屏蔽全部领队工具。
2. 成员工具 `createMemberTools`：harness 0.1.2 起 `registerContinuableSetup` 被宿主移除，成员工具（`eteams_claim_task … eteams_team_status`）改随 root 作用域注册；领队/构建器子代理经各自 spawn 的 toolFilter deny 拒见，成员身份由 resolveCaller 按任务副本行解析。
3. `eteams_dispatch_captain`：把对话任务转交一次性领队子代理主持（同一 root 作用域注册——子代理对 `eteams_*` 可见的前提）。
4. 用量计 `installUsageMeter`：root 作用域监听会话事件采集 usage，写 `usage_detail` + `usage_daily_total`（单事务，失败不外抛——计量绝不影响会话）。
5. Web 面 `installWebSurface`：**懒绑定**——web server / workspace registry 是兄弟服务可能晚于本插件挂载，靠 `ctx.on('internal/service')` 重试；webless profile 里插件退化为纯工具，绝不阻塞启动。

### 任务状态机（`src/host/model/taskMachine.ts`）

8 态：`creating / ready / start / wait / paused / wait_user / completed / cancelled`。非法转移抛 `TransitionError`（带可执行中文 hint，工具层转成 actionable 错误文案）。关键设计：

- **依赖不再当闸门**（用户 2026-09-14「闸门拦住去掉吧，不然任意调度时会出问题」）：`dependencies` 只作排布提示（面板执行序按兄弟依赖拓扑排），派发口不按依赖拒绝——是否等前置由领队判断；原 `wait + blockedFrom` 物化已退役。
- **`wait` = 待领队分诊**（用户迭代 2026-09-11）：成员失败按 `maxRetries` 自动重试，超限落 `wait`；领队分诊——小 bug `eteams_reassign_task` 重新指派 loop（wait→ready），流程/环境问题 `eteams_escalate_task` 升级 `wait_user`（wait→wait_user），挂起 `paused`、取消 `cancelled`。
- `ready` 派发不改状态，成员领取才 `ready→start`；`start` 可回 `ready`（失败重试/改派/中间站交接）。
- `creating` = 面板手动创建的主任务容器占位（完善收口转 ready）。
- 大任务（容器，`parent_id` 为空）只用 creating/ready/start/paused + completed（completed 是可回退标识，追加小任务即回 ready；无 cancelled），不加 `wait`。

### 成员=角色（数据模型核心）

三层松引用，真相在 `roles`；**人由工号指认，名字只作显示**（v7 起允许同名成员）：

- `roles`：**全局角色库**（人设手册 persona_md、头像、一句话简介）；预置角色首次启动写入，构建师/面板新增也落这里。`employee_id` 列已弃用（工牌挪进班底——列保留、全链路不再读写）。同一角色可复制成多份成员。
- `team_members`：**班底 = 工牌发放处**（团队 × 角色 + 派发模型路线），领队也是一行（建队即入领号）。**工号 = 行自增主键**（`team_member_id`，表自增、全局只增不复用、不按队内凑整）；允许同名同角色多行；`role_name / persona_md / profile` 是随写同步的副本列（直查/展示用，真相在 roles）。
- `task_members`：**任务成员副本**——建大任务时把班底**全员（含领队）**复制进来（`employee_id` 抄班底、`main_task_id` = 所属大任务、status=staged）；派发起会话后 session 锚与 attempt 归属（`attempts.task_member_id`）都落自己的副本行；行生命周期跟随大任务（删任务级联删副本）。领队的「团队级主持行」（`name='团队领队'` 且 `main_task_id IS NULL`）保留——它不是工牌，是领队子会话锚 + has_leader 载体，领队行查找统一按此判据；`removed` 枚举仅剩主持行使用。
- 对外标识：班底成员 `ET-0007`，任务成员 `T3-ET0007`（主任务 3 的 7 号）；member spawn label `eteams-member:<名字>（T<主任务id>-ET<工号>）`——label 是宿主会话头部面包屑的显示名（`displayTitle = label ?? childId`），故名字在前、工牌后缀保 (任务, 工号) 作用域；邮箱按 (team_id, employee_id) 分箱，执行链站点记工号。

### Web 回环面（`src/host/runtime/webui.ts`）

只注册**一条 prefix 路由** `/eteams-api`，内部按 path 段分发：GET 读端（快照 / 事件增量 / 执行线路 / 成员对话框 / 用量日历）+ POST 写端（`session-team`、`session-persona`、`client-log` 等）。会话绑定 = 把团队/人设带注入会话 agent 的系统提示词（`sessionTeam.ts` / `sessionPersona.ts`），不经过对话消息。

### 客户端（`src/client/`）

- **dva 单例 store**（`store/app.ts`）：惰性创建、start 恰好一次，四 model（`activity / ui / roster / build`）；多表面（槽位面板 + 整页覆盖层）共用同一 store 无害。
- **MemoryRouter**（`pages/teamsView/routes.tsx`）：插件不拥有浏览器 URL 且同屏可能多表面，故用内存历史；`location → store` 单向 sync（防回环），初始路径由 `ui.activeNav` 持久值推导（刷新恢复）。
- **轮询**（`lib/monitor.ts` + `hooks/usePoll.ts`）：`useSyncExternalStore` 单循环，1s 活跃 / 5s 空闲 / 页面 hidden 暂停 / 恢复即刷。
- **页面两级**：域目录 `pages/<域>/`（board / roster / tasks / team / reports）放页面文件，`teamsView/` 只留壳（index / rail / routes）。组件文件全 camelCase。
- **样式**：Tailwind 产物（`lib/tailwind.gen.css`）在 `apply()` 最先以 `<style data-dsh-eteams-tw>` 注入 head——宿主只加载单个 CJS 信封、无独立 CSS 通道，故样式以字符串进包、运行时注入（tsdown 虚拟模块）。`components/ui/` 是 vendored shadcn 风格 Radix 组件，Select 走自管 portal。
- **mdEditor**（`features/mdEditor`）：mdxeditor + CodeMirror。tsdown.config.ts 里有三处关键补丁：CodeMirror 双副本去重别名（pnpm 商店 vs npm 顶层两套实体会 `instanceof` 失配）、mdxeditor CSS 走虚拟 JS 模块内联、上游 uvu assert 缺陷 stub。

## 项目存储（SQLite 单库）

- **位置**：`<stateDir>/db/eteams.db`。`stateDir` 配绝对路径 = **全局单库**（所有工作区共用一份 eteams.db / 角色库 / 用量台账，当前 profile 配 `C:/Users/epat/.eteams`）；配相对路径 = per-workspace 旧口径。连接按状态根缓存（同进程单连接、全同步调用），`WAL + synchronous=NORMAL + busy_timeout=3000` 单写多读；外键保持 OFF——引用完整性由写入代码负责。
- **Schema v7，12 表**：`schema_meta`（键值元数据）、`team`、`roles`（角色库；`employee_id` 弃用列保留）、`team_members`（班底，行自增主键即工牌 + 副本列）、`task`（大/小任务：合同 MD、成员链（站点=工号数字，legacy 名字串兼容）、链游标 -1=未开始、重试计数、状态说明、blockedFrom、work_dir 分配后固定）、`task_members`（任务成员副本，建任务整班复制；领队主持行 `name='团队领队'`、`main_task_id` 空）、`attempts`（一行一次尝试：kind=initial/stage/retry/reassign、一次性 token、`task_member_id` 归属精确到副本行、进度 JSON、结果、变更文件）、`events`（只追加审计）、`mail_messages`（收件箱按 (team_id, employee_id) 分箱，`message_id` 幂等）、`decisions`（升级决策）、`task_status_changes`、`usage_detail` + `usage_daily_total`（用量，DB 即唯一存储）。
- **写路径纪律**：无外键/CHECK/UNIQUE，规则全在写入代码；团队写 = 单 `BEGIN IMMEDIATE` 事务内 DELETE 该团队全部行 + **原号重 INSERT**（崩溃要么整体回滚要么整体生效，主键号稳定供 UI 引用）。时间列一律 `*_time`（Unix 毫秒）、枚举 TEXT（合法值写在列注释）、JSON 存 TEXT。
- **schema.sql 与 db.ts 双份**：[schema.sql](src/host/state/schema.sql) 必须与 `src/host/state/db.ts` 内嵌 `SCHEMA_SQL` 常量**逐字一致**（bundle 内读不到同目录资产故内嵌；schema.sql 是审核对照副本）。改表 = `DB_SCHEMA_VERSION` +1，旧库在 `getDb` 里 ALTER + 回填。
- **任务工作文档**（用户 2026-09-15 扁平化）：`<workspace>/teams/<主任务号>-slug/` —— **一个主任务一个目录**（团队名不进路径，主任务与其全部小任务共用），目录下 `留言板.md`（create-only，领队+全员共用一块）、每任务一份 `<任务号>-slug.纪要.md`（上半段宿主幂等渲染的合同视图 + 下半段纪要正文），以及只建目录、内容自由的 `计划/`、`文档/`。旧布局（`tasks/tN-slug/`、`sub/`、`contract.md`、`notes.md`、团队 `README.md`）不迁移、不兼容。

## 流程大白话（先看这个，小学生版）

把插件想象成一个「包工队」，从人到活儿一共五步：

1. **造角色 = 开人才市场**。用户先造角色：每个角色就是一张「岗位卡」，写着会干什么、性格怎么样。岗位卡放在 `roles` 表里，**全机器只存一份**，而且卡上**没有工号**——同一张卡可以请多份，各是各的人。

2. **开团队 = 挑人进班子、发工牌**。用户开一个团队，从人才市场挑角色请进来，请进来就是**班底**（`team_members` 表）——这家公司的员工名册。每个人进班底当天领**工号**（表自增：工号就是班底行的自增主键 `team_member_id`，全局只增不复用，不按队内凑整；领队也照领——建队即入班底领号）。**同名的人也允许**（两个「张三」各拿各号），所以工号才是人的身份证，名字只是显示用。

3. **领队可请可辞**。领队就是普通班底成员：入班底、拿工号、随任务照搬副本；特殊点只有一条——有领队（`has_leader` 开关）时由他拆解目标、分配任务，没有就由主会话（用户对话窗口）来拆。辞掉/请回只动开关。

4. **来活 = 拆任务 + 抄花名册**。用户说一个大目标，领队（或主会话）拆成小任务，干活的人**按工号从班底里挑**，可以排接力顺序（执行链，站点记工号）。**建大任务那一刻，整班人（含领队）就在这个任务下抄一份「任务花名册」**（`task_members` 副本行，工号抄班底）——不是开工才有人，是建任务就全员在册；之后团队加新人，也会抄进全部现存任务。

5. **开工 = 起新会话**。任务派给谁，就给那个人的**副本行**起一个自己的子会话，会话号记在副本行上（attempt 归属也精确到副本行）。**每个任务都是新人新会话**——换任务就是新会话，只有同任务内的重试/接力才复用。

**关键两条：工牌跟人走，花名册跟任务走。** 移除成员 = 删他的班底行，**工号作废不回收**（新人的号永远往后排，不复用）；他任务里的副本行不动（历史留档），但工号已不在班底的存活会话**失去成员工面**（视为离职，不能继续接活）。删除任务 = 任务和它的全部副本行一起删（有驻留会话的先收回）；任务只是完成的，副本行保留、与任务同寿命。

## 项目流程（运行时主干）

1. **挂载**：`dsh plugin add` → cordis.patch.yml 挂载插件行 → 宿主 `apply()` 装配（领队工具 root 作用域 / 成员运行时 / 用量计 / web 面懒绑定）。
2. **建队→拆解→批准**：领队 `eteams_create_team` → `eteams_create_task`（容器+子任务、依赖、成员链）→ 用户批准 → `submit_task` 就绪。
3. **派发→接活→执行链**：`assign_task` → 成员 `claim_task`（签发 attempt token）→ 链站点按序接力，完成即通知领队「下一站+续派」，`advance_task` 推游标 → 末站完成。偏离必须 `deviationNote`（chain.deviated 事件）。
4. **失败→重试→升级**：同成员自动重试（`maxRetries=3`），换人/重试即吊销旧 token；超限进 `wait_decision` + 决策记录 → 挂起/换人/通知用户。
5. **会话协同**：面板 POST `session-team` / `session-persona` 绑定对话；`eteams_dispatch_captain` 转交一次性领队子代理。
6. **成员构建**：`/eteam` 命令或面板 → 构建师面试（`eteams_build_report / build_wait / interview_answer`）→ 确认后 `startBuilderChild` 常驻构建子代理产手册 → 落 `roles` 表。

## 规范（ESLint + Prettier 强制）

- 文件/目录名 camelCase（`unicorn/filename-case`）；例外：工具链配置文件与 `assets/avatar` 等非代码资产。代码标识符：变量/函数 camelCase、类/类型/组件 PascalCase（`ETeamsView`）、模块级字面量常量 UPPER_SNAKE_CASE——**需变更的字面量一律先声明为常量再使用**。
- Prettier 管格式（100 列、2 空格、分号、单引号、LF），ESLint 经 `eslint-config-prettier` 关闭一切格式规则只管质量；客户端文件启用 `react-hooks` 全套。
- 文档**当场自含说清楚**，不写「见 docs/N」式引用链。

## 易踩的坑

- `lib/` 是构建产物（整目录 gitignore）：改源码后必须 `pnpm build` 才会被 DSH 加载；`pnpm verify` 是产物门禁。
- `wrapClient` 有防双卷装守卫（bundle 里已含 `__ModuleLoader__` 会退出报错）——重复 build 前先 clean（`pnpm build` 自带 clean 步）。
- `src/host/state/db.ts` 加载时安装了 node:sqlite `ExperimentalWarning` 进程级过滤器（只拦 SQLite 一条）——别在别处重复处理。
- `.npmrc` 把 npm cache 钉在项目内 `.npm-cache`（工作区沙箱只允许写 `C:\eTeam`，默认缓存位置会 EPERM），registry 走 npmmirror。
- 沙箱里 `process.execPath` 可能是 DSH Desktop 的 ELECTRON_RUN_AS_NODE 包装——spawn node 前先用 `-e` 探针验真（见 scripts/buildTailwind.mjs 的做法）。
- 新增配置项：改 [config.ts](src/host/config.ts) schema + [cordis.patch.yml](cordis.patch.yml) 默认值，两处同步。
- 测试镜像源模块命名（`tests/lifecycle.test.ts` ↔ 生命周期），公共脚手架在 `tests/support/tmpWorkspace.ts`；纯核（model/state）测试不拉起 cordis。
- 迭代新功能走 设计 → 审核 → 开发 → 验收 子 agent 流程，过程文档落 `docs/`（文档编号命名惯例已废弃，可自由命名）。