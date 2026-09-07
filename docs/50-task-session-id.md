# 50 任务行主会话快照：task 补 session_id 列（DB v4→v5）

> 状态：**已被 v6 取代（2026-09-07，docs/51）**——`task.session_id` 改名 `main_session_id`；`task_members` 的 `main_session_id` 改名 `session_id`（本行自己的子代理会话）、`child_session_id` 合并消失；team 表不存会话列。本文的「领队行 main_session_id 锚点」取值口径随 v6 作废（主会话快照归任务行，团队级锚按任务行快照 ∪ 心跳 ∪ 建队事件派生），迁移链也延长为 v4→v5→v6。v5 的快照语义（落库后不变、只补 NULL 行）原样延续。
>
> 状态（v5 时点）：**定案（2026-09-06 用户拍板）——已实施，typecheck 与全量用例绿**。
> 一句话：任务表（task）补 `session_id` 列，**建任务时盖章该团队领队行锚定的主会话 ID**——每行任务从此自带「它的主会话是哪个对话」，直查/展示不用 JOIN；`DB_SCHEMA_VERSION` 4→5。

## 50.1 需求与语义

用户原话：「任务表还要加上session_id，记录下主会话ID」。

**语义定案（快照，同 work_dir「分配后固定」先例）**：

- `task.session_id` = **建任务那一刻**该团队领队行（task_members，`name='项目牧羊人'`、`main_task_id` 为空）锚定的主会话 ID（`main_session_id`）。
- **落库后不变**：领队重锚（移除/恢复/换窗口派发重锚）不回改旧任务——每行任务记的是它诞生时刻的主会话，不是实时镜像（区别于 v4 班底行副本列的「随写刷新」语义：任务行的会话没有「真相在别处」的同步关系，只是一次盖章）。
- 无领队行/未锚定（`main_session_id` 为空串）→ 列为 NULL。
- 面板建任务、领队工具建任务（eteams_submit_task / eteams_create_task 经 createTask）、旧版团队导入三路同源取值；小任务、主任务同样盖章。

## 50.2 DDL（v5 的 task 表，新增一列）

`schema.sql` 与 `db.ts` 内嵌 `SCHEMA_SQL` 逐字一致，task 表在 `current_member_id` 与 `retry_count` 之间插入：

```sql
session_id        TEXT,                -- 主会话 ID 快照（v5：建任务时领队行 main_session_id 锚点，落库后不变；直查/展示用；无领队行为 NULL）
```

## 50.3 写入路径（三路同源，都取领队行锚点）

| 建任务路径 | 取值 |
|---|---|
| 派发核 createTask（assignment.ts，面板/工具共用唯一入口） | `leaderRowOf(team)?.mainSessionId \|\| undefined`——随内存任务落建，经 writeTeam 整存整取落列 |
| 旧版团队导入（importLegacyTeam） | 旧档 `captainSessionId`（与导入写的领队行 main_session_id 同源；空则 NULL） |
| v4 旧库存量任务 | getDb 首次连接迁移回填（见 50.4） |

面板投影（webui taskView）增量带 `sessionId` 字段（客户端 `TaskView.sessionId` 可选消费，旧快照缺省 null）。

## 50.4 迁移（v4 旧库 → v5）

`getDb` 首次连接时 `migrateTaskSessionIdV5`，形状检测（PRAGMA table_info 缺列才 ALTER），随 migrateTaskContractMd 先例不显式开事务：

1. task 表缺 `session_id` 列 → `ALTER TABLE task ADD COLUMN session_id TEXT;`
2. **只补 NULL 行**：`UPDATE task SET session_id = (SELECT tm.main_session_id FROM task_members tm WHERE tm.team_id = task.team_id AND tm.name = '项目牧羊人' AND tm.main_task_id IS NULL) WHERE session_id IS NULL`——从领队行回填存量任务；无领队行/未锚定保持 NULL（悬空 NULL）。
3. **已盖章行不覆盖**（`WHERE session_id IS NULL` 守卫）——快照语义：重开连接重复执行只补仍为 NULL 的行（自愈），不随领队重锚改写历史任务。

- 全新库 DDL 即新形状，迁移只跑幂等回填兜底（零行）。
- 旧库 schema_meta 版本号不回写（随 v1→v2 迁移先例）。

## 50.5 验收

- **四绿门**：typecheck 全绿；vitest 28 文件 / **384 用例**全过；build 通过（`SMOKE OK`）。
- **迁移锁**（tests/store.test.ts 新增 v4→v5 describe，仿 v3→v4 形状检测模式）：v4 形状旧库（task 缺列 + 领队行锚 cap-old + 无领队团队）→ 断言补列、有领队行任务回填锚点、无领队行任务 NULL；迁移后手工盖章的行重开**不被覆盖**、已回填行重开值不变（幂等）。
- **行为锁**：store.test.ts 快照用例——TaskRecord.sessionId 随 writeTeam 整存整取往返；webui.test.ts 整体开始用例——对话建任务（eteams_submit_task）盖章领队锚点（cap-conv）。
- **面板手工链路未验证声明**：面板/对话建任务 → 直查 `SELECT task_id, session_id FROM task`（面板任务卡暂不展示该字段，投影已带）——待装机 GUI 冒烟。
- 旧 v4 库（含用户现库）重启宿主后自动 ALTER + 回填，无需手工操作。