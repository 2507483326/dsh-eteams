# 04 总体架构

## 4.1 系统上下文

```
┌─────────────────────────── DSH Desktop (desktop profile) ───────────────────────────┐
│                                                                                      │
│  Web GUI (React)                          DSH 宿主进程 (Node)                        │
│  ┌────────────────────────┐               ┌─────────────────────────────────────┐   │
│  │ 对话流                  │   HTTP 轮询   │ cordis 组合                          │   │
│  │  └ eteams 对话卡片      │ ───────────▶ │  ├ dsh-web-app (Web 服务)            │   │
│  │ 活动面板(浮动)          │ ◀─────────── │  ├ dsh-session / dsh-agent           │   │
│  │  ├ 概览/成员/任务/动态  │  /plugins/   │  ├ dsh-subagent (可续聊子代理)        │   │
│  │  └ staged 计划编辑器    │  dsh-eteams/*│  ├ dsh-tools (defineTool)            │   │
│  │ 头像渲染器(React SVG)   │              │  └ dsh-eteams 插件 ◀───────────────  │   │
│  └────────────────────────┘               │    ├ 工具注册 eteams_*                │   │
│                                           │    ├ HTTP 路由                        │   │
│                                           │    ├ 系统提示词/slash 命令             │   │
│                                           │    └ 团队状态机+调度+邮箱+恢复         │   │
│                                           └───────────────┬─────────────────────┘   │
│                                                           │                          │
│         ┌─────────────────────────────────────────────────┼──────────────┐          │
│         │  子代理会话存储 (DSH storages，跨重启持久)         ▼              │          │
│         │   captain(领队) ── member A / member B / member C …             │          │
│         └────────────────────────────────────────────────────────────────┘          │
│                                                                                      │
│  工作区磁盘真相：C:\eTeam\.eteams\<teamId>\{team.json, events.jsonl, inbox\*.jsonl}   │
│  任务文件夹(可见产物)：C:\eTeam\teams\<team-slug>\{README.md, tasks\t-*\*.md}        │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

要点：
- **领队就是当前会话主智能体**，不是一个额外进程；插件通过工具与系统提示词把「领队协议」注入会话。
- **成员是领队的可续聊子代理**：会话持久由 DSH 子代理机制负责，插件只负责指派消息与任务凭证。
- **磁盘是唯一真相**：UI、领队、成员三方的所有视图都从 `.eteams/` 快照派生。

## 4.2 模块划分（服务端）

```
src/host/
  index.ts        # cordis apply(ctx)：装配下列全部模块；headless 降级装配
  config.ts       # schemastery 配置：stateDir/maxMembers/maxRetries/memberProvider/slashCommand…
  state/
    store.ts      # 团队目录读写、原子写、快照+事件日志、schemaVersion 迁移
    lock.ts       # 进程内 per-team / per-captain 串行队列
    events.ts     # 事件追加、查询、重放
  model/
    types.ts      # TeamState/MemberRecord/TaskRecord/AttemptRecord/…（见 05）
    task-machine.ts # 任务状态迁移纯函数：canTransition/applyTransition
    avatar.ts     # 种子→AvatarOption 纯函数（与客户端共享一份算法模块）
  runtime/
    members.ts    # 子代理派生/唤醒/打断/退役；成员模型路由快照；人设注入（spawn 全文 + 唤醒摘要，D13）
    assignment.ts # 指派状态机：指派→接取→执行→汇报 + 执行链推进/偏离（见 07，D11）
    docs.ts       # 任务文件夹与 MD 文档渲染：README/contract 随状态幂等同步；notes 只建不写（D12）
    retry.ts      # 重试阶梯与升级判定（见 08）
    notifier.ts   # 领队/成员通知：邮箱投递 + 在线即投（见 07）
    recovery.ts   # 冷恢复：扫描、对账、遗留 attempt 处理（见 10）
  tools/
    captain.ts    # 领队侧 eteams_* 工具（对成员隐藏）
    member.ts     # 成员侧工具（接取/进度/完成/失败/看板/消息）
  routes/
    state.ts      # GET /plugins/dsh-eteams/state（快照，含头像 option）
    ops.ts        # POST 任务 CRUD/指派/取消/团队切换/归档/头像重摇/成员消息（D15）
  prompts/
    persona.ts    # 人设框架（领队/成员统一字段）+ 默认模板 + 唤醒摘要组装（D13）
    captain.ts    # 领队人设与协议段（问询/拆解/执行链指派/升级决策/汇报纪律，D11-D13）
    member.ts     # 成员执行提示模板（人设+合同/交接包/汇报规范）
    handoff.ts    # 交接包组装模板
  command.ts      # /eteams slash 命令注册
```

设计约束：
- `state/`、`model/` 不依赖 cordis（纯 Node），保证可单测、可在 verify 脚本中脱离宿主运行。
- `runtime/` 是唯一接触 `ctx.subagents` 的模块；对上暴露 `assign/claim/interrupt/continue` 等语义操作。
- 所有写路径必须经过 `store.ts` 的锁与原子写，禁止散落 `writeFile`。

## 4.3 模块划分（客户端）

```
src/client/
  index.tsx            # 注入入口：apply() 装配 + 五表面槽位注册 + inject 清单（根目录仅此一文件）
  lib/                 # 横切基建：无表面归属、不渲染业务 UI
    bridge.ts          # 跨表面桥：window 事件常量、pending 信号、tab 激活/可见性
    monitor.ts         # /eteams-api/state 轮询 + activity 快照投影（refreshActivitySoon）
    api.ts             # /eteams-api 写 API 封装（roster/team/task/build/usage）
    cn.ts              # clsx + tailwind-merge 类名合并
    modelCatalog.ts    # 会话模型目录只读（host modelDirectories 服务）
    addPeople.ts       # /eteam 命令模板 + 一键预填 helper（React-free）
    phaseLabels.ts     # 团队阶段词表
    versionLabel.ts    # 版本标签常量
    tailwind.ts        # Tailwind 产物运行时幂等注入（ensureEteamsStyles，构建接线端点）
    diagnostics.tsx    # 诊断环形缓冲 + host 上报 + ClientErrorBoundary
  hooks/
    useHostDark.ts     # 宿主暗色 body 属性订阅（亮暗主题跟随）
  components/
    ui/                # shadcn/ui 手动 vendored 13 件 + 自管 portal 容器（portal.ts）+ 图标声明垫片（lucide-icon.d.ts），kebab-case
  store/               # dva 单例 store（D19e）
    app.ts             # create → model → start 引导（RootState 聚合）
    models/            # activity/ui/build/roster 四 model + index 聚合
  features/            # 领域特性块：组件 + 纯逻辑 + 领域常量，各有独立文档线与测试
    avatar/            # 头像系统（docs/14）：Avatar 渲染器 + option 模型 + SVG 合成器 + 脚本生成的 vendored 部件表
    backdrop/          # 背景板（docs/25）：纯计算引擎（零 DOM 可单测）+ canvas/DPR/降运动薄壳
    mdEditor/          # mdxeditor 人设编辑器（mdxeditor 样式运行时注入）
    tasks/             # 任务领域（docs/29）：拖拽指派组件 + 拖拽纯逻辑层 + 13 态→展示态派生层
  pages/               # 表面：一个文件/目录 = 一个宿主挂载面
    eteamsCard.tsx     # 会话卡片 ETeamsCard（conversation 卡槽）
    buildCard.tsx      # /eteam 命令卡片 EteamBuildCard（commandview keyed 槽）
    teamsButton.tsx    # 输入栏「团队」按钮 + 团队/角色弹层
    teamsPanel.tsx     # 智能入口 / 整页团队页（enterTeamsPanel）
    heroTeamsButton.ts # hero 行 DOM 注入按钮（无 React 树）
    teamsView/         # 团队面板（conversation.view 槽；原 5060 行 eteamsView.tsx 巨石拆分 14 文件）
      index.tsx        # 壳：ETeamsView + ETeamsViewBody（侧栏/tab 路由/信号消费）
      shared.tsx       # 页内跨 tab 共享层（类名常量/tone 徽标/小组件/领域常量）
      boardTab.tsx     # 看板 tab（目标/进度/最近动态）
      usageCalendar.tsx # Token 消耗日历卡（docs/28）
      teamTab.tsx      # 团队 tab（团队列表栅格 + 团队详情）
      teamMembers.tsx  # 领队卡/成员卡/成员详情
      modelRoutePicker.tsx # 模型路线选择器（领队/成员共用）
      addMembersDialog.tsx # 添加成员弹窗（点餐式，含 StepButtons）
      buildDraft.tsx   # 构建草稿簇（docs/19 构建工作台的草稿/步骤/命令芯片）
      membersTab.tsx   # 角色 tab（成员库 + 构建工作台）
      tasksTab.tsx     # 任务 tab（分组清单 + 编辑弹窗 + 展示态徽标）
      taskDrawer.tsx   # 任务详情抽屉 + 站点行
      memberDialog.tsx # 成员对话框（D15）
      reportsTab.tsx   # 汇报 tab（成员选择 + 汇报时间线）
  styles/
    eteams.css         # Tailwind 唯一输入 + shadcn token 桥（亮暗双块），buildTailwind `-i` 端点
  types/               # 环境声明垫片（dvaCore/eteamsCss/mdEditorCss/usageCalendarCss，声明体均为包名/通配，与位置无关）
```

目录职责口径：`lib/` 是横切基建（多表面共享、不渲染业务 UI）；`features/` 是有独立文档线与测试的领域块；`pages/` 是宿主挂载面（表面私有子组件放该页面目录内，跨 tab 共用进 teamsView/shared.tsx）；`components/ui/`（vendored shadcn）、`store/`（dva）、`styles/`（唯一 Tailwind 输入）、`types/`（声明垫片）各司其职；目录与文件一律 camelCase（`components/ui/` 沿用 shadcn kebab-case 例外）。客户端原则：**只渲染、不决策**。一切状态变更走 ops 路由写盘；面板刷新即重建，不维护本地状态副本（跨表面共享的轮询快照经 dva store 单例分发）。

## 4.4 关键生命周期

### 团队生命周期

```
(用户) /eteams <目标> 或 自然语言
   └─▶ 领队协议激活 → 问询用户细节（FR-37）→ eteams_create_team
         └─▶ [staged] 成员+任务草案（含执行链，可编辑，双方）
               └─▶ 用户批准（面板/对话）→ 创建任务文件夹+MD 文档（D12）→ 成员子代理原子派生
                     └─▶ [running] 领队指派(默认沿链推进+完成即续派) → 成员接取/执行/汇报 循环
                           ├─ 全部任务终态 → 领队汇总 → [completed]
                           ├─ 失败超限 → awaiting_decision → 挂起/换人/通知用户
                           └─ 用户停止 → [halted]（可 resume）
         切换：running ⇄ paused（当前团队冻结，另一团队激活）
         归档：任意非运行态 → archive/（只读历史）
```

### 任务生命周期（摘要，全图见 [06](06-task-lifecycle.md)）

```
draft ─▶ ready ─▶ assigned ─▶ in_progress ─▶ completed
                 ▲             │  │
                 └── 拒接/改派 ◀┘  ├─▶ retrying(同成员自动) ─┐
                                 └─▶ failed ────────────────┴▶ awaiting_decision
                                             挂起/换人/通知用户 → suspended / assigned / needs_user
blocked：依赖未满足或被挂起/失败传染；cancelled：任意非终态的用户取消
```

## 4.5 数据流（写路径与读路径）

**写路径 A：领队指派（对话驱动）**
```
领队模型调用 eteams_assign_task(task, member)
  → lock(team) → 校验(状态机+依赖+成员在线) → team.json 更新(task→assigned)
  → events.jsonl 追加 assignment 事件
  → notifier: 向成员邮箱投递指派消息 → 成员子代理在线 → followup 唤醒
  → unlock → 返回工具结果（渲染给领队）
```

**写路径 B：成员汇报（子代理驱动）**
```
成员模型调用 eteams_update_task(attempt_id, status, …)
  → lock(team) → attempt 凭证校验（防迟到/伪造）
  → 状态机迁移 → team.json + 执行线路事件落盘
  → 若终态：notifier 通知领队（邮箱 + 在线即投）
  → retry 阶梯判定（失败时，见 08）→ 返回工具结果
```

**写路径 C：用户面板操作（UI 驱动）**
```
用户点击「指派给成员 B」
  → POST /plugins/dsh-eteams/team/<id>/tasks/<tid>/assign
  → 会话归属校验 → 与路径 A 相同的 lock+状态机+落盘
  → 领队邮箱收到「用户已指派」系统通知（D10：领队知情）
```

**写路径 D：文档同步（自动，D12）**
```
状态事务提交（plan.approved / task.created / task.updated / 终态变更）
  -> runtime/docs.ts 幂等渲染 README.md 与受影响 contract.md（覆盖生成物）
  -> notes.md 仅在缺失时创建（成员追加区，永不覆盖）
  -> 渲染失败仅告警不阻断状态事务（文档可重建，NFR-11）
```

**读路径：面板轮询**
```
client monitor (1s) → GET /state?session=<id>
  → 服务端扫描/缓存该会话团队快照（含成员头像 option、任务+执行线路摘要）
  → React useSyncExternalStore 重渲染
```

## 4.6 并发与一致性模型

- **进程内**：per-team 互斥队列（`withTeamLock`），所有读写串行；per-captain 锁保证「一会话一活动团队」（D3）。
- **跨进程**：不支持（NFR-03）。同一工作区开两个 DSH 进程操作同一团队属未定义行为，启动恢复时以磁盘版本号检测冲突并拒绝写（详见 [09](09-persistence.md)）。
- **迟到写入**：attempt_id 凭证一次性校验；改派/重试先吊销旧凭证，旧成员的后续更新被拒绝并提示所有权已变更（与参考实现同策略）。
- **UI**：乐观更新仅限本地视觉（如按钮置灰），真相以下一次轮询为准；操作失败回弹并提示。

## 4.7 激活与降级矩阵

| 宿主能力 | 注入 | 缺失时行为 |
|---|---|---|
| `tools` | 必需 | 缺失则插件不激活（记录错误日志） |
| `subagents` | 必需 | 同上（成员引擎不可用） |
| `systemPrompt` | 可选 | 缺失则仅靠工具描述驱动协议（能力降级） |
| `commands` | 可选 | 无 `/eteams` slash，自然语言仍可激活 |
| `webServer` + `workspaceRegistry` | 可选 | headless：纯工具模式，无面板 |
| `dsh-client-*`（浏览器） | 可选 | 非 Web profile 无 UI，功能不损失 |

## 4.8 与宿主的边界契约

| 依赖 | 用途 | 版本锚点 |
|---|---|---|
| `defineTool` / `ctx.tools.register` | 工具注册与 `exec.agent` 调用者识别 | `@deepseek-ai/dsh-tools` ^0.1.0-rc |
| `ctx.subagents.startContinuable/followup/interrupt/registerContinuableSetup` | 成员派生/唤醒/打断/工具面注入 | `@deepseek-ai/dsh-subagent` ^0.1.0-rc |
| `agent.session.header.cwd` | 领队工作区（状态根定位） | dsh-session 类型 |
| `webServer.register({kind:'exact',…})` | HTTP 路由 | dsh-web 组合 |
| 客户端注入（conversation/layout/…） | 卡片与面板挂载 | `dsh.client.inject` 声明 |
| locale 服务 | 中英文案 | dsh-client-locale |

rc 版本 API 可能漂移：每个里程碑的 verify 步骤包含「API 冒烟」——在真实 desktop profile 中跑一遍最小团队流程（见 [16](16-testing-acceptance.md)）。
