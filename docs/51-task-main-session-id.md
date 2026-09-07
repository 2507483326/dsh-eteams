# 51 会话列归位（DB v5→v6）：task.main_session_id + task_members.session_id

> 状态：**定案（2026-09-07 用户拍板）——已实施，四绿门全过**。
> 一句话：主会话 ID 只属于任务行——`task.session_id`（v5）改名 `main_session_id`；`task_members` 只记**本行自己的子代理会话**：`main_session_id` 改名 `session_id`（领队行=领队子代理，成员行=成员子会话），`child_session_id` 列合并消失；team 表不存会话列。`DB_SCHEMA_VERSION` 5→6。

## 51.1 需求与语义定案

用户原话（两轮纠偏定案）：

- 「main_session_id 应该属于task表，task_members 应该记录的是自己的子agent session_id。把task_members 中的main_session_id 修改为 session_id。task表加上 main_session_id」
- 「为啥 team 会加 main_session_id，team 属于多个task啊。task_members 也不需要main_session_id 啊，它可以通过task_id 反查出main_session_id啊」

| 列 | 语义 |
|---|---|
| `task.main_session_id` | **主会话快照**：建任务/派发补章时登记的领队主会话 ID。快照语义：落库后不变，领队重锚不回改（v5 语义原样，只改名）。NULL=未登记（等派发时补章） |
| `task_members.session_id` | **本行自己的子代理会话**：成员行=该成员的持续子会话；领队行=领队子代理（`persistCaptainChildId` 落盘的冷恢复凭证）。未起会话=空串 |
| ~~`task_members.main_session_id`~~ | **删除**——主会话快照归任务行，成员行按 `task_id` 反查 `task.main_session_id` |
| ~~`task_members.child_session_id`~~ | **合并消失**——改名后的 `session_id` 语义即「本行子代理会话」，与它重复 |
| `team` 表 | **不加会话列**——一个团队多个任务、每个任务自带主会话快照；团队级锚点按任务行派生（51.4） |

## 51.2 DDL（v6 形状，schema.sql 与 db.ts 内嵌 SCHEMA_SQL 逐字一致）

```sql
-- task 表（在 current_member_id 与 retry_count 之间）：
main_session_id   TEXT,                -- 主会话 ID 快照（v5 落列 v6 改名：建任务时登记的主会话 ID，落库后不变；直查/展示用）

-- task_members 表（在 employee_id 与 status 之间，两列并一列）：
session_id       TEXT NOT NULL DEFAULT '',  -- 本行自己的子代理会话 ID（v6：成员行=成员子会话，领队行=领队子代理会话）；还没启动时是空串
```

## 51.3 迁移链（getDb 首次连接）

`migrateMemberRolesV3 → SCHEMA_SQL（缺表按 v6 现形状补建）→ migrateTaskContractMd → V4 → migrateTaskSessionIdV5 → migrateTaskSessionColumnsV6`。

- **V5（改名前最后一棒）**：task 缺 `session_id` 且已有 `main_session_id`（v6 库）直接跳过；否则 ALTER 补列。回填判据加 PRAGMA 守卫：**仅当 task_members 还有 `main_session_id` 列时**才从领队行回填任务——v1 遗留库若 task 缺表会被 SCHEMA_SQL 按 v6 形状补建（task_members 已无该列），守卫防对不存在的列跑 UPDATE。
- **V6（幂等，形状检测，随 v4/v5 先例不显式开事务）**：
  1. task：缺 `main_session_id` 时——有 `session_id` 则 `RENAME COLUMN session_id TO main_session_id`（**快照值原样保留**）；两者皆无则 ADD 列。
  2. task_members：缺 `session_id` 时 ADD（`NOT NULL DEFAULT ''`）；有 `child_session_id` 则 `UPDATE session_id = child_session_id`（成员行=成员子会话；领队行=领队子代理）；随后 DROP `main_session_id`（v5 迁移已把全部任务行按它回填过，锚点消费点改按任务行快照派生）、DROP `child_session_id`。
- 旧库 schema_meta 版本号不回写（随 v1→v2 迁移先例）。用户现库（v5）重启宿主自动迁移：任务行盖章保留、成员/领队子会话保留在 session_id。

## 51.4 主会话锚点派生（消费点全部改按任务行）

- **`teamMainSessionOf(team)`**：按任务序取第一个非空 `task.mainSessionId`——「同队任务由同一领队会话创建」的派生锚。唤醒/回收等需要团队级主会话锚的点用它，**心跳兜底**（`readBuildPresence`）排第二：`removeMember` 提交后回收、`sendMessage` 领队唤醒、`deleteTeam` 子会话回收都是 `teamMainSessionOf(fresh) || presence || ''`。
- **`captainFor`（派发起会话/接力）三级梯度不变，①③的锚源换任务行快照**：①本任务 `mainSessionId`（缺退 teamMainSessionOf）在册 → ②心跳在册 → ③快照记得 ID 但两锚都不在册时冷恢复（DA50，`agents.resume`）。补章发生在 ensureSpawned 用②心跳锚起人之前（51.6）。
- **面板投影**：taskView 增 `sessionId: t.mainSessionId ?? null`；成员视图 `childId: row.sessionId`；agentactivity 的领队会话列 = teamMainSessionOf；`captainAgentOf(team)`（面板路由找领队代理）= `agents.get(teamMainSessionOf(team))`，无快照且无绑定时不硬锚——requireTeamById 对空串放行（51.7）。
- **workspaces `locateAgentTeam`**：①任务行 `mainSessionId` 匹配 → ②实例行 `sessionId` 匹配。

## 51.5 建队留痕（team.created captainSession 事件）

建队时刻的主会话 ID 不再有领队行承载，改记进**事件流**：`createTeam` 的 `team.created` payload 增 `captainSession: captainId`（审计 + 事件兜底双用）。三个消费点：

1. **`store.findTeamByCaptain(root, sessionId)`**（重写）：`SELECT team_id FROM task WHERE main_session_id = ? UNION ALL SELECT team_id FROM events WHERE type='team.created' AND json_extract(payload,'$.captainSession')=? LIMIT 1`——任务快照 ∪ 建队事件，覆盖「无任务团队」和「建队→首个任务」的窗口期。
2. **`store.teamCreatedBy(root, teamId, captainSessionId)`**（新增）：定向查某团队是否由该会话创建，`requireTeamById` 第四判据用。
3. **`resolveCaller` / usage `resolveIdentity` 领队层**：直接调 `findTeamByCaptain`（任务快照 ∪ 事件）。

`deleteTeam` 清空事件 → 删队后事件兜底不会误命中。**边界**：v6 前建的旧团队没有 captainSession 字段——身份回退到任务行快照（v5 迁移已保证存量任务全部有值）。

## 51.6 补章（派发时盖章任务行）

面板旧客户端/无心跳建卡的任务行未登记主会话：`ensureSpawned` 在起人前检查 `(task.mainSessionId ?? '') === ''` → 用**本次派发的实际锚点**补章（可能是②心跳锚，不一定是快照原值）；已登记不改写（快照语义：落库后不变）；①③与快照同 ID 时补章是 no-op。只改内存快照随本次派发写事务落库，spawn 失败整帧作废无半步。补章前 commit 的窗口里成员父校验按「快照 ∪ 心跳」判父（members.ts 白名单，心跳已覆盖）。

## 51.7 身份判据

- **`requireTeamById`**（面板路由 + 显式 teamId 的工具路径）：面板合成代理（captainId 空串，路由已按 teamId 定位）直接放行；工具路径按四判据任一匹配即领队：①任务行主会话快照 ②领队行子代理会话（宿主重启后领队子代理身份）③会话→团队绑定 ④建队事件留痕（teamCreatedBy）。removed 行不拦（领队 remove/restore 要走通）。
- **`resolveCaller` 层序**：会话绑定 → 领队子代理注册（captainChildTeamOf）→ `findTeamByCaptain`（快照 ∪ 事件）→ 领队行子代理匹配（`leaderRowOf(t)?.sessionId === sessionId` → 领队身份）→ 实例行 `sessionId` 匹配（非 removed）。
- **`addMember` 领队守卫简化**：身份已由 requireTeamById/requireCaptainTeam 校验，函数内只拦领队不在册/已移除。
- **建队不写绑定**：`createTeam` 保持 `clearSessionTeam(captainId)` 原样（客户端 localStorage 绑定会在挂载时重申，不强写）。

## 51.8 写入路径对照

| 路径 | 落法 |
|---|---|
| createTeam 领队行 / addMember 成员行 / setLeaderRemoved 重建行 | `sessionId: ''`（未起会话空串；主会话快照归任务行） |
| persistCaptainChildId（领队子代理冷恢复凭证） | 匹配 `leader.sessionId === childId`，SQL `UPDATE task_members SET session_id = ?`；无旧值时 `previous = ''` |
| 建任务（面板路由 / 领队工具） | 路由收 `body.sessionId`（工具路径经 envForAgent/env.sessionId 同源）随 createTask 落 `task.mainSessionId`；缺省不写 → NULL，等补章 |
| 旧版团队导入 | 任务行直盖旧档主会话；领队行 `sessionId = captainChildId ?? ''`；成员行 `sessionId = childSessionId` |
| 面板 addMember 路由修复 | POST /team/:id/member 显式传 `teamId: team.id`（此前靠 requireCaptainTeam 按调用者会话定位——无任务团队锚点空串时误报「你还没有团队」） |
| captainTools.ts / index.ts | **零改动**（用户裁定其它线程维护；v6 会话戳经 envForAgent/env.sessionId 走通，两文件无会话列引用） |

## 51.9 验收

- **四绿门**：typecheck 全绿；lint（改动文件）零告警；vitest 28 文件 **386 用例**全过；build 通过（SMOKE OK）；`SCHEMA_SQL` 与 schema.sql 逐字一致核对通过。
- **迁移锁**（store.test.ts）：v4→v5→v6 链迁移断言——task 有 main_session_id 无 session_id；task_members 有 session_id 无 main/child；领队行 session_id=原 child_session_id；任务行快照保留；迁移后补章重开不覆盖（幂等）。
- **行为锁**：workspaces/sessionTeam/usage/captainDispatch/lifecycle/store/webui 六个测试文件的种子与断言全面换 v6 形状（领队行 sessionId=''、任务行 mainSessionId 盖章）；webui DA38/DA40 补章断言（面板建卡派发后 `sub.mainSessionId === 'cap-second'`，领队行仍空串）；DA50 冷恢复断言改按任务行快照；lifecycle 的无任务团队建卡/发消息靠建队事件留痕走通。
- **GUI 装机冒烟未验证**：用户现库（v5）重启宿主自动迁移后，面板建队→建任务→派发→重启后冷恢复全链需人工过一遍。

## 51.10 已接受的边界

- **locateAgentTeam 是同步函数**：跨工作区工具建的无任务团队无法经事件兜底定位（事件查询是异步 store API）——工具建的团队正常就在调用者工作区，此边角接受。
- **陈旧快照的派发父**：任务行快照指向的会话可能已被回收——冷恢复按持久化会话 ID 复活，复活失败才报「锚点不可用」；派发父指向的是「任务诞生时刻的对话」，与快照语义一致。
- **drainMembers best-effort**：回收子会话的排空失败不回滚状态（随 docs/07.2 先例）。
- **旧团队无 captainSession**：v6 前建的团队身份靠任务快照（v5 迁移已回填全部存量任务）——无任务且无留痕的远古团队领队身份不可恢复，接受（面板按 teamId 定位不受影响）。