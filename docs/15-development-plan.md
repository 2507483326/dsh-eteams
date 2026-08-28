# 15 开发计划（任务拆解与里程碑）

WBS 拆解原则：每个里程碑交付**可安装、可演示**的增量；先核心闭环后界面；每步都有明确验收标准（DoD）。工期为单人专注估算（相对值，非日历承诺）。

## 15.0 前置事项（M0 内完成）

- 卸载旧 `dsh-eteams` 0.1.1 失效引用：`dsh plugin --profile desktop remove dsh-eteams`（清理 `file:C:/Users/epat/eTeam/...tgz` 残留依赖）。
- 工作区就绪：`C:\eTeam` 为插件仓库根（本 docs/ 即其一部分）；`.gitignore` 含 `.eteams/`、`node_modules/`、`dist/`。

## 15.1 里程碑总览

| 里程碑 | 主题 | 交付物 | 依赖 |
|---|---|---|---|
| M0 | 工程脚手架 | 可安装空插件（挂载成功、1 个冒烟工具） | - |
| M1 | 状态与核心工具 | 无 UI 最小闭环：问询->建队->拆解(含执行链)->批准(建文件夹+文档)->指派->执行->汇报->续派 | M0 |
| M2 | 重试与升级 | 重试阶梯 + awaiting_decision 三决策 + 挂起传染 | M1 |
| M3 | 断点续行 | 会话内续行 + 冷恢复全流程 | M1 |
| M4 | Web 基础 UI | 状态路由 + 对话卡片 + 面板（概览/成员/任务/动态只读） | M1 |
| M5 | 计划编辑与指派交互 | staged 编辑器（人设/执行链列）+ 任务 CRUD + UI 指派 + 人设/文档入口（D5/D10/D11/D13） | M4 |
| M6 | 头像系统 | 数据提取 + 渲染器 + 重摇/编辑 | M4 |
| M7 | 多团队 | 切换/归档/切换器 UI（D3） | M4 |
| M8 | 打磨与发布 | i18n、a11y、verify 全绿、打包发布 | M2-M7 |

> M2/M3 与 M4 并行度低（不同代码面），单人串行建议顺序 M0→M1→M2→M3→M4→M5→M6→M7→M8；M2、M3 可在 M4 前后互换。

## 15.2 M0 工程脚手架（0.5 单位）

任务：
1. 仓库初始化：package.json（name/dsh 字段/exports 双入口/files）、tsconfig×2、tsdown 配置、vitest 配置、pnpm-workspace。
2. `src/host/index.ts`：cordis apply 骨架（config 解析 + inject 占位 + 日志）。
3. `cordis.patch.yml`：insert eteams（stateDir/maxMembers/maxRetries/memberProvider 默认值）。
4. 冒烟工具 `eteams_ping`（返回版本号；验证 tools 注入与 exec.agent）。
5. CI 脚本：`pnpm build && pnpm typecheck && pnpm test`。

DoD：`dsh plugin --profile desktop add .` 成功；`dsh --profile desktop --dump-config` 出现 eteams；GUI 会话中模型可调 `eteams_ping`。

## 15.3 M1 状态与核心工具（2.5 单位）

任务：
1. `state/store.ts`：目录布局、atomicWriteText（Windows 重试）、withTeamLock、version/seq。
2. `model/types.ts` + `task-machine.ts`：05/06 的记录与迁移纯函数（含执行链/站点推进）+ 单测。
3. `state/events.ts`：事件追加与查询。
4. `runtime/members.ts`：spawn/followup/interrupt 封装、模型路由快照、人设注入（spawn 全文 + 唤醒摘要，D13）、registerContinuableSetup 工具面（成员工具注入 + 领队工具隐藏）。
5. `runtime/assignment.ts` + `notifier.ts`：指派->接取->执行->汇报循环 + 执行链推进/偏离 + 完成即续派协议；邮箱投递（在线即投/滞留补投）。
6. `runtime/docs.ts`：任务文件夹创建 + README/contract.md 渲染（幂等）+ notes.md 只建不写（D12）。
7. `tools/captain.ts` / `tools/member.ts`：11 章核心工具集（团队/成员(含人设)/任务(含链)/assign/advance/claim/progress/complete/fail/board/status/message）。
8. `prompts/persona.ts` + `prompts/captain.ts` + `prompts/member.ts`：人设框架与默认模板（含问询纪律、文档纪律、链式指派、完成即续派）。
9. verify 脚本 v1：离线全流程（伪 runtime 注入替代子代理）。

DoD：headless 下用真实会话完成「问询（模拟答复）->建队->staged（含链）->批准（生成任务文件夹与文档）->指派->站点完成->advance 推进->末站完成->领队收到通知并续派」；状态文件、事件日志与 teams/ 文档符合 05/09/D12；非法迁移/坏 token/无偏离说明的偏离全被拒。

## 15.4 M2 重试与升级（1 单位）

任务：retry.ts（退避定时器、retry_scheduled/retry_started）、DecisionRecord 生命周期、eteams_resolve_decision、suspend 传染与解除（blocked 物化）、needs_user 流程、配置项接线。

DoD：08 章全部场景 verify 脚本覆盖（3 连败->决策->三选一各自断言）；退避在重启后按持久化 nextRetryAt 重建。

## 15.5 M3 断点续行（1.5 单位）

任务：paused 语义与 interrupt 落盘、续行消息组装（断点=最后线路事件）、交接包组装器、`runtime/recovery.ts` 冷恢复全流程（10.4）、领队邮箱补投、恢复报告。

DoD：10.8 全部验证通过（单测重放、verify 冷恢复、GUI 手工三杀两停实验零丢失零重复副作用）。

## 15.6 M4 Web 基础 UI（2 单位）

任务：
1. `routes/state.ts`：/state 快照路由（TeamSnapshot 全量）+ 会话校验。
2. 客户端骨架：注入入口、monitor 轮询控制器（1s/5s/休眠）、useSyncExternalStore 订阅。
3. ETeamsCard 对话卡片（阶段徽标/进度/成员行/最新事件/打开面板）。
4. ActivityPanel：切换器占位 + 四视图只读版（概览/成员网格/任务分组列表/动态流）+ 任务详情抽屉（执行线路时间线 + 执行槽渲染，track 路由懒加载）+ 成员对话框只读时间线（dialog 路由）。
5. locale 接入（zh/en 文案表 v1）。

DoD：真实会话跑 M1 流程，面板 1s 内反映指派/接取/进度/完成；刷新与重开会话后状态一致；亮暗主题正常。

## 15.7 M5 计划编辑与指派交互（2 单位）

任务：plan 路由（编辑器数据：成员+人设+任务+执行链）、StagedPlanEditor（成员表(人设编辑)/任务表(执行链列)/影响摘要/批准-返回-放弃）、ops 写路由全套（任务 CRUD(含链)/assign/advance/cancel/resume/decision 代答/persona/captain-persona/member message）、docs 只读预览路由与抽屉、执行槽拖拽（slotDnD：合法目标高亮/放置语义/偏离确认，D14）、成员对话框发送与忙碌排队提示（D15）、权限矩阵前后端双层校验、MemberPicker、人设编辑器、二次确认、乐观更新回弹。

DoD：D5/D10/D11/D13/D14/D15 全交互可用：面板增删改任务与执行链（越权被拒且提示可行动）、UI 指派后领队收到系统通知、拖拽入槽完成指派与偏离确认（键盘等效可达）、成员对话框收发与忙碌排队、人设修改提示下次唤醒生效、文档预览与磁盘一致；批准前领队无法自批（approve 仅 UI 可达）。

## 15.8 M6 头像系统（1.5 单位）

任务：extract 脚本 + vendored 资产 + UPSTREAM.json、shared/avatar（option 类型 + randomOption + mulberry32）、React Avatar 渲染器、卡片/面板/任务行接线、重摇与简化编辑器、NOTICE 署名、体积审计。

DoD：14.8 验证全过；同成员重启前后头像一致；gz 体积在预算内。

## 15.9 M7 多团队（1 单位）

任务：eteams_switch_team/archive_team、per-captain 锁强化（切换事务）、面板切换器（含归档列表只读视图）、团队间成员/邮箱隔离测试。

DoD：D3 场景走通：建 A->切 B->A 的执行全停驻->切回 A 续行；归档团队只读可查。

## 15.10 M8 打磨与发布（1 单位）

任务：a11y 清单（键盘/aria-live/双编码）、性能预算实测、edge case 扫尾（空态/并发指派竞态/超长文本）、README（用户文档：安装/使用/配置/FAQ）、npm pack 校验、发布 0.2.0。

DoD：16 章验收清单全绿；`dsh plugin add` 从打包产物安装成功。

## 15.11 风险缓冲与顺序调整

- 若 rc 版宿主 API 漂移（tools/subagents），M1 提前暴露：M0 冒烟工具即验证 defineTool + exec.agent；M1 第一任务即验证 startContinuable。
- 若头像提取复杂度超预期（上游结构变化），M6 兜底：先用上游 README 截图素材临时占位（资产许可允许范围内）或降级为几何徽标（首字母+种子色），完整移植后替换。
- M5/M6/M7 相互独立，可按实际进度重排；M2/M3 是断点续行叙事的关键路径，不可延后。

## 15.12 里程碑与需求追溯矩阵

| 需求 | 里程碑 |
|---|---|
| FR-01~05 团队与入口 | M1（FR-04 切换/归档在 M7） |
| FR-06~10 成员 | M1（头像 M6） |
| FR-11~15 任务清单 | M1（staged 编辑 M5） |
| FR-16~21 调度执行 | M1（UI 指派 M5） |
| FR-22~25 重试升级 | M2 |
| FR-26~28 断点续行 | M3 |
| FR-29~33 界面 | M4（编辑器/指派 M5；切换器 M7；i18n M4+M8） |
| FR-34~36 执行链与续派 | M1（数据/推进/协议），M5（链编辑 UI） |
| FR-37~40 问询/文档/人设 | M1（问询协议/文档生成/人设框架），M5（人设与文档 UI） |
| FR-41~42 执行槽与成员对话框 | M4（槽渲染/对话框时间线只读），M5（拖拽/发送） |
| NFR-* | 贯穿（一致性 M1、恢复 M3、性能/审计 M8 收口） |
