# 设计：工号挪到班底 + 任务成员按主任务作用域（schema v7）

状态：r6（开发与验收完成；验收 6 项修订已吸收；r6 改表自增口径，见备注）
日期：2026-09-07

## 一、背景与决策（用户拍板）

1. **每个任务都是新人新会话**。派发到新的大任务 = 新会话；只有同任务内的重试/接力复用会话。实例行不需要为「恢复会话」跨任务存活。
2. **工号从 roles 挪到 team_members，班底发牌**。角色卡不再带号；同一角色可放多份成员，各拿各的号。
3. **允许同名成员**（同队同角色可以叫同一个名字），**全链路按工号找人**——名字只作显示。
4. **领队是普通成员**：入班底、拿号、随任务照搬副本；特殊点只有一条——有领队（has_leader）时由领队拆解和分配任务。
5. **建任务时把班底全员（含领队）复制进任务成员表**；团队新增成员也搬进**全部现存任务**（completed 只是暂时完结态，任务可能续用）；团队删除成员**不**删任务成员副本；删任务则副本级联删。
6. **分配的操作对象就是任务成员副本**，UI 只是显示为团队成员——派发/认领/接力/占用全部落在副本行上。
7. **工号 = `team_members` 表自增主键**（r6 拍板「表自增，不需要队内凑整」，取代方案 A 队内计数器）：班底行落库即领号，AUTOINCREMENT 全局只增不复用（队内唯一自然成立）；删除作废不回收；**显式选号取消**；存量队迁移不保号——旧号由迁移按名 join 重键到新班底行主键（数据连续、号码更换）。

## 二、目标模型（v7）

```
roles         人才市场岗位卡：role_id / role_name / persona_md / profile / avatar
              （employee_id 列弃用——保留列、全链路不再读写，见迁移节）

team_members  班底 = 工牌发放处（领队也是一行）：team_member_id（自增主键 =
              工号，AUTOINCREMENT 只增不复用）/ team_id / role_id / model
              允许同名同角色多行；人员身份键 = 工号（即行主键）
              【r6 表自增】不加任何新列——工号不再需要独立列，也不再需要
              team.member_seq 计数器（方案 A 遗产，全部删除）

task_members  任务成员副本：建任务时整班复制（含领队），employee_id 抄自班底行
              主键，main_task_id = 本任务；派发起会话后 session_id 落在自己的
              副本行上
              行生命周期跟随所属大任务：任务删除 → 副本级联删除
              领队的「团队级主持行」（main_task_id 为空、name=项目牧羊人）保留——
              它不是工牌，是领队子会话的锚 + has_leader 载体，实现需要
```

对外显示：任务成员标识 `T{mainTaskId}-ET{工号补零}`（如 `T3-ET0007`）+ 名字；班底成员 `ET{工号补零}` + 名字。**存量队伍迁移后号码变为新班底行主键值**（v6 旧号来自 roles 全局序列，弃用；数据经迁移按名 join 重键，保证不重不混、邮件/链站点/副本全部跟上）。

**删除成员后的身份截断口径**（终审 R1）：副本行不再有 removed 软删语义，但被移除成员的存活子会话不能继续用工面——`resolveCaller` 成员匹配与邮件读端增加「工号已不在本队班底 → 视为已离职」判定，跳过此类副本行（其 session 锚仅保留冷恢复价值，不再授予成员工具面）。

## 三、行为变更清单

| # | 变更 | 现状（v6） | v7 |
|---|------|-----------|-----|
| 1 | 发号 | 加成员发到 roles 行（同人同号，全局序列） | **表自增（r6）**：工号 = `team_members.team_member_id` 自增主键——加人/建队先经 `nextAutoincrementId` 预占主键再写入（写路径 DELETE + 原号重 INSERT 需要稳定号），落库即领号。**删除不复用号**（AUTOINCREMENT 语义）。**显式工号参数取消**（工具/面板不再收 employeeId 入参）。无计数器列、无快照回路问题——整删重插天然不冲号 |
| 2 | 领队 | 不入班底；task_members 领队行工号抄 roles | 领队**入班底**（建队即入，号 = 班底行自增主键）；task_members 团队级主持行保留（会话锚 + has_leader 载体），工号同步班底行。**主持行缺失重建时工号从班底领队行同步（不新发号）；领队班底行被删后重加 = 续新号并同步主持行**（终审 R7） |
| 3 | 同名成员 | addMember 按名查重拒绝 | **允许同名**。定位成员一律按工号；按名查重取消（**同名班底复用分支一并删除**，teamOps.ts:283-289，终审 R7）；上限计数按班底行数（addMember 与 setLeaderRemoved 复原守卫都改） |
| 4 | 建任务复制班底 | 建任务不建实例行 | `eteams_create_task`（容器，含对话任务组）在同一事务把班底**全员**（含领队）复制为 task_members 副本行：employee_id 抄班底、main_task_id=本任务、status=staged、session_id 空 |
| 5 | 团队新增成员 | 建 staged 团队级行 | 入班底发号；并复制进该团队**全部现存任务**（含已完结——completed 只是暂时完结态，用户拍板）作为副本行 |
| 6 | 团队删除成员 | 实例行软删 status='removed' | 删班底行（硬删）；**任务副本行不动**；「在办尝试吊销、任务回池」流程保留；`removed` 枚举值仅剩主持行使用。**身份截断见第二节口径**。同名重加 = 新工号新人，历史邮件按号分箱不会串 |
| 7 | deleteTask | 只清 nowTaskId | 级联 DELETE 该任务（含级联小任务）的全部副本行；被删行 session_id 非空（回池 ready 场景）时提交后照 removeMember 口径 interrupt + drain 子会话 |
| 8 | 完成任务的副本行 | 保留 | 保留（任务行留档，副本与 attempts 同生命周期） |
| 9 | 按工号找人 | 邮箱按名分箱、执行链写名字、占用按名、requireMember 按 name 取 rows[last] | **全面改按工号**：mail_messages 分箱键改 (team_id, employee_id)；member_chain_list 站点写工号（渲染时并显示名）；占用判定按副本行状态（副本独立并行，v6 队级「同时只干一件」取消）；claim/progress/complete 等成员工具按 identity 解析出的精确副本行（taskMemberId）定行。**attempts 表加 task_member_id 列**：claim 的 attempt 匹配（assignment.ts:1114/1120-1122 现按 `assignee === name` / `a.member === name`，同名会越权接走别人的 attempt——token 握手安全边界）、requireLiveAttempt、freeMember（1516-1527）全改按行 id；`task.assignee`/`current_member` 保留名字做显示，判定一律走副本行（终审 B2） |
| 10 | 身份解析与 spawn | 成员子代理 label `eteams-member:<teamId>:<memberName>` 无任务作用域；setup hook 按名取首行 | **label 加任务作用域**：`eteams-member:<teamId>:<mainTaskId>:<employeeId>`；setup hook 按 (mainTaskId, employeeId) 精确取副本行；`memberTemplateOf` 按工号取班底模板（同名两行不再错拿人设）；`registerMemberSession` 与用量归属补 employeeId（终审 B1）。MemberCaller 携带 taskMemberId + employeeId |
| 11 | 角色库发号语义 | roster upsert 发号/回填、「拉人沿用角色库同号」 | 整体下线：角色不再带号，roster 读写与 client api 注释同步。**removeRosterMember 活跃守卫改按班底判定**（现按 task_members 按名计数——v7 副本常驻每任务恒非空，永远拒删，终审 R6） |
| 12 | 未派发成员邮件 | requireMember 按实例行判定 | 副本行建任务即有，邮件按 (team, 工号) 入箱天然通；无会话副本只入箱不唤醒 |
| 13 | README 成员清单 | 按实例行聚合 | 改按 task_members 副本行（建任务即全员在）渲染，带 T{n}-ET 标识 |
| 14 | 人设/路线同步 staged 行 | updateMember/setMemberModel 同步同名 staged 行 | 副本行的人设副本在建任务/派发时定版，不再随写同步（班底行仍是真相） |

## 四、落地点（文件级）

- `src/host/state/schema.sql` + `src/host/state/db.ts` 内嵌 `SCHEMA_SQL`：双份逐字一致；迁移按列形状检测（table_info 幂等，惯例同 db.ts 现有迁移）。
- `src/host/model/types.ts`：TeamState 不加字段（表自增无状态要背）；MemberRecord.employeeId 保留但恒等于 memberId（读端由主键派生，避免下游邮箱/身份/label/UI 全链换字段）；TaskMemberRecord 工号注释改「抄班底行主键」；chain 站点类型改工号。
- `src/host/state/store.ts`：读写两端工号换表（insertTeamRow/writeTeamInTx 无 member_seq 列；班底行写端 `employeeId = memberId` 派生同步）；`ensureRolesRowInTx` 剥离工号；`assembleTeam` 班底行 employeeId = 主键。
- `src/host/state/queries.ts`：boardTeam Q5 成员聚合改按工号、领队判定按主持行判据（现按 `row.name === LEADER_NAME` 且按名去重——v7 领队副本行会混入，终审 R5）。
- `src/host/state/events.ts`：成员事件 payload 补工号（名字照留，双保险可读）。
- `src/host/state/import.ts`：导入路径全套对齐（班底行落库领自增号、**无 member_seq 步骤**、建任务复制副本、不再产团队级行、ensureRolesRowInTx 剥工号）。
- `src/host/runtime/teamOps.ts`：createTeam（领队入班底领自增号 + 主持行同步）；addMember（预占主键发号 + 复制进全部现存任务，删 staged 行创建与同名复用分支，允许同名，**显式选号分支删除**）；removeMember（硬删班底行、副本不动、在办吊销）；setLeaderRemoved（满员守卫按班底行数；主持行重建号口径见 #2）；updateMember/setMemberModel 删 staged 同步段。
- `src/host/runtime/assignment.ts`：createTask 复制班底副本（#4）；deleteTask 级联删副本 + drain（#7）；`resolveAssigneeRow` 按工号取本任务副本行；占用判定改副本行；**claim/requireLiveAttempt/freeMember 按行 id（#9，B2）**。
- `src/host/runtime/notifier.ts`：requireMember/findInstanceRow 按工号（取消 rows[last] 按名 quirk）；wakeMember 按副本行；邮件分箱键改工号。
- **`src/host/runtime/members.ts`（终审 B1，r3 遗漏）**：spawn label 加任务作用域 `eteams-member:<teamId>:<mainTaskId>:<employeeId>`；setup hook 按 (mainTaskId, employeeId) 精确取副本行（现 members.ts:253-255 按名取首行，同名必串）；`memberTemplateOf` 按工号取班底模板（85-87）；`registerMemberSession` 补 employeeId。
- `src/host/runtime/usage.ts`：用量归属补 employeeId（现按 memberName 归并，74-86）。
- `src/host/tools/identity.ts`：成员匹配加「工号已不在班底 → 已离职」截断（第二节口径）；MemberCaller 携带 taskMemberId + employeeId。
- `src/host/tools/captainTools.ts`：add_member（**工号入参取消**、返回工号）、chain 参数按工号、成员展示带 T{n}-ET。
- `src/host/runtime/webui.ts`：roster 读写端剥离工号；领队卡工号改读班底领队行（226/258）；任务成员卡 `T{n}-ET{xxxx}`；POST 加成员（**显式工号字段移除**）；**成员作用域路由与对话框按工号定位**（`/member/<name>/remove|model|persona|sync-roster` 867/895/928/963、memberDialog 1977-2012，终审 R4）。
- `src/host/runtime/docs.ts`：README 成员清单按副本行（#13）；执行文档成员行带标识。
- `src/host/runtime/roster.ts`：ROSTER_ROW_SQL 去 employee_id（142）；upsertRosterMember 剥离工号（226-233）；ensurePresetMembers 回填循环删除（319-328）；allocateEmployeeId 退役（74-83）；removeRosterMember 守卫改班底判定（368-373，R6）。
- `src/host/prompts/handoff/mails.ts`：完成汇报正文成员署名附 T{n}-ET（74/104/107/116，nit）。
- `src/client/lib/api.ts`：成员作用域 POST 路由按工号定位（140/175/195/228，R3）；roster 注释语义（106-122）。
- `src/client/lib/monitor.ts`：乐观路线补丁 target 改工号（190，R3）。
- `src/client/pages/team/memberCards.tsx`：回调与定位键改工号/taskMemberId（163/213/222，R3）。
- `src/client/features/tasks/taskAssign.tsx`：拖拽 payload、站点反查、React key 改工号；**按名互斥选择改为按工号**（632 行现按名互斥，同名第二人无法入链，R3）。
- `tests/`：见第七节。
- `CLAUDE.md`：「流程大白话」「成员=角色」按 v7 改写（同名按号找人、工牌跟任务走、领队是普通成员）。

## 五、迁移（v6 库 → v7，r6 表自增口径）

`getDb` 内按列形状检测触发（table_info 幂等，与现有迁移惯例一致；**检测只看 `mail_messages.employee_id` 与 `attempts.task_member_id` 两列**——team/roles/team_members 三表 v6/v7 形状一致，不加列），单事务：

1. `mail_messages` 加 `employee_id INTEGER`；`attempts` 加 `task_member_id INTEGER`（缺哪列补哪列）。
2. 现存团队级 staged 行删除（`main_task_id IS NULL AND name != '项目牧羊人'`）。
3. **5.2（验收 M1）：存量队补建领队班底行**——v6 领队不入班底；有主持行且班底无领队行的队 INSERT 领队班底行（无显式号 → 落库即领自增主键号），主持行 employee_id 同步此号；主持行/角色行缺失的队跳过（加回领队时走 setLeaderRemoved 续号路径自补）。
4. **5.5（终审 B3）：每个现存容器任务按班底全员补建副本行**——employee_id 抄班底行主键、status=staged、session_id 空；现存锚定行保持原状态原会话不动（副本补建跳过该成员该任务已有行）。**只补容器**（`parent_id IS NULL`）——副本行只锚定大任务，小任务共享容器的副本行（验收 m4 修订）。
5. 任务锚定副本行 employee_id 按名 join 本队班底行重键到新主键号（**EXISTS 守卫**：join 不到的孤儿保留旧号，不刷成 NULL）；主持行已在第 3 步同步。
6. `mail_messages` 按收件成员名 join 班底行回填 employee_id 并把 box_key 改写为工号串（解析不到的旧行保留名字分箱，仅显示兜底；领队箱 `captain` 不动）。
7. `attempts.task_member_id` 存量按 task_id + member 名 join 副本行回填（副本行挂根任务；解析不到保留 NULL，判定退按名）。
8. `member_chain_list` 存量 JSON：名字站点迁移为工号站点（按本队班底按名解析，同名首行优先；解析不到的站点保留名字并在渲染时标注 legacy）。
9. `roles.employee_id` 保留列不读写（DROP 是单向门：旧版 lib 打新库 `no such column` 直接挂，live-link 回滚即炸）；列注释标 deprecated。**存量队工号一律换新**（班底行主键），旧号在 roles 行留档不再被读。

v2 直升库：v3 迁移把旧 member 行搬进 team_members 时**不再携带 employee_id**（该列已不存在）；工号统一由 v7 迁移按名 join 重键。

## 六、验收口径

- 新建团队 → 领队班底行领全局自增号（全新库 = ET-0001，非全新库续编不加列凑整）；加两名同角色同名成员 → 各自续号，面板可区分。
- 建大任务 → 班底全员（含领队）出现在任务成员副本；删除该任务 → 副本清空、进行中会话被 drain。
- 团队新增成员 → **全部现存任务**（含已完结）的副本出现他；删除成员 → 副本保留、班底行消失、号作废（再加新人不拿旧号，AUTOINCREMENT 保证），**其存活子会话工面被截断**。
- 邮件按号分箱：同名两成员互不串箱；已删成员的旧邮件不进新人箱。
- 执行链按工号接力；同名成员分别派发互不占用（副本并行）；**同名成员的 claim 不串 attempt**。
- 同名成员 spawn：label 各归各、setup hook 各自锚定正确副本行、人设模板各取各的。
- 存量 v6 库迁移：号码不重不混（换发为班底行主键号，数据按名 join 重键）、**旧任务副本补建全员**、旧任务邮件按号送达、`pnpm verify` 全绿。

## 七、测试影响面

- `tests/webui.test.ts`：Bob staged 行断言（543-546/349）、上限口径（784-803）、roster 发号语义（604-658、627-640）、显式工号写 roles（690-698）——全部按 v7 重写。
- `tests/store.test.ts`：v3 迁移断言 roles.employee_id（402-479）按「列保留不读写」改写；DDL fixture 补 v7 形状。
- `tests/lifecycle.test.ts`：addMember 返回工号语义（199-211）；链/占用按工号重写。
- 新增：建任务复制全员副本、删任务级联删副本+drain、同名成员各自号与互不串箱、删除成员号作废+会话工面截断（AUTOINCREMENT 不回退）、领队领全局自增号、迁移按名重键、**存量任务迁移补建副本+邮件按号送达**、**同名成员 spawn label/模板各归各**、**同名 claim 不串 attempt**。

## 八、备注（讨论轨迹）

- r1：初稿（同名仍禁、staged 行取消、发号双表 MAX）。
- 审核一轮：blocker 三处（roster.ts 遗漏、领队号撞班底号、未派发成员邮件路径）+ 风险八处，已吸收。
- r2：按一轮审核修订（形状检测迁移、roles 列保留不读写、requireMember 班底/实例任一在册、README 按班底渲染等）。
- r3（用户拍板）：允许同名按工号找人；领队入班底按普通成员对待；建任务整班复制副本、新增搬进未结束任务、删除成员副本不动；工号采用队内只增计数器（方案 A）；占用限制改为副本独立并行。
- r3.1（用户拍板）：新增成员搬进全部现存任务——completed 只是暂时完结态；方案 A、副本独立并行均获确认。
- r4（终审吸收）：补 members.ts 落地面（label 任务作用域、setup hook/模板/会话登记按 (mainTaskId, employeeId)）；补 attempts 加列与 claim/freeMember 按行 id（防同名越权接 attempt）；迁移补 5.5 存量任务补建全员副本；补删除成员后身份截断口径；补 queries/usage/webui 路由/client 定位键等按工号改造点。终审结论：改完即可开发。
- 开发落地（wave 1-3，~30 文件）：门禁全绿（typecheck 0 错 / 391 测试 / build / verify 29 项）；5 条实现偏差经裁定全部成立（member_seq 含副本 MAX、String(employeeId) 箱键、stationRefOf 入库归一、迁移步骤 9 首行优先、v3 迁移携带 employee_id）。
- r5（验收修订，2026-09-07）：验收「有条件通过」的 6 项修订——**M1** 迁移补步骤 5.2 存量队领队班底行（否则加回领队错发新号断身份）；**M2** assertNotBusy 撤掉 v6 跨任务「同一时刻只干一件」残留，改纯副本行占用（设计三#9 的落地补齐）；**m1** deleteTask 提交后先 interruptMember 再 drain（照 removeMember 口径）；**m2** sendMessage 工号拒收改真拒绝（副本行留档会命中死行，以班底在册为准）；**m3** resolveAssigneeRow 兜底行在 applyAssignment 发号尝试前预占自增号（attempt.task_member_id 安全边界不再等写库回填）；**m4** 迁移/import 副本补建只针容器（`parent_id IS NULL`）。另记偏差：docs.ts README 成员清单按班底行渲染（设计 #13 原写副本行）。
- r6（用户拍板「表自增，不需要队内凑整」，2026-09-07）：工号放弃方案 A 队内计数器，**直接 = `team_members.team_member_id` 自增主键**——`team.member_seq` 列、快照回路、去重/续编、显式选号全部删除（v7 尚未发布、live 库仍 pre-v7，干净重定义）；代价 = 号不按队内凑整、领队不保证 ET-0001（全新库自然是 1）、存量队迁移换号（按名 join 重键，邮件/副本/链站点数据连续）。`MemberRecord.employeeId` 字段保留（恒等 memberId，读端派生）避免下游全链换字段。门禁重跑全绿（typecheck 0 错 / 391 测试 / build / verify）。