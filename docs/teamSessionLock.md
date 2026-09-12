# 团队对话锁定 + 已建任务走增补子任务（用户迭代 2026-09-10；2026-09-12 加严「每个会话只有一个主任务」）

一个对话选定团队后，**永久固定为该团队的团队对话**：1 个主对话只能有 1 个团队；输入栏团队徽章常驻显示该团队且不可点击切换；后续消息若该对话已有主任务，则新工作请求走「增补子任务」流程而不是另建主任务。本文档自含记录本迭代的语义、判据与全部改动点。

## 替代关系

本迭代**替代**用户迭代 2026-09-07 的一次性团队选择（发送后清空）：原「宿主监听 `user/message` 一次性消费绑定（`consumeSessionTeamBinding`）+ 客户端快照 running 上升沿清空按钮面」的整条链路已删除。原语义下每条新任务请求都从「`eteams_submit_task` 建主任务 → `eteams_dispatch_captain` 转交」两步走重新开始；本语义下绑定与主任务都跨回合存活。

## 锁定语义（双端不变量）

**宿主**（`src/host/runtime/sessionTeam.ts`）：`bindings` Map（sessionId → {teamId, name, boundAt}）中的条目**常驻**，不随发送、回合或时间消耗。写路径只有两处：

- `setSessionTeam`（POST `/eteams-api/session-team`）：已有绑定且指向**另一支**团队、且旧团队在 `locateTeam` 下仍健在 → 409 `本对话已固定为团队「X」——一个对话只能绑定一个团队`。同队重绑放行（刷新队名/时间）；旧队已死放行（逃生口）。
- `clearSessionTeamForTeam(teamId)`：删团队时遍历清掉指向该队的全部绑定（`teamOps.deleteTeam` 提交后调用）——**唯一的解锁逃生口**。

工具层硬兜底（band 是软约束，守卫防模型绕过）：

- `eteams_create_team`（`captainTools.ts`）：调用会话已绑定且绑定团队跨工作区仍健在 → 抛可执行错误「本对话已固定为团队……新建团队请在团队页或未绑定团队的新对话中进行」。面板建队路径（`teamOps.createTeam`）不受影响——原「建队清创建者绑定」逻辑已删除（锁定下不成立；死绑定由 resolveCaller fall-through + 徽章解锁兜住）。
- `eteams_submit_task` 新建主任务分支：调用会话在绑定团队里已有锚定主任务（**含 `completed`**，见下节判据）→ 抛错并按 hasLeader 给出增补指引（有领队提示 `eteams_dispatch_captain（taskId=#N）`，无领队提示 `eteams_create_task（parentTaskId=#N）`）。
- `eteams_create_task` 入库守卫（用户迭代 2026-09-12「拆解漏传 parentTaskId，小任务散成顶层」）：`createTask`（`assignment.ts`）在写库前按 `main_session_id` 解析本对话的锚定主任务（领队子代理的小任务行快照记的是领队子会话，经副本行/注册表换回它主持的大任务，`anchoredMainTaskOfCaller`）——已有主任务却不带 `parentTaskId` → 抛错**不入库**（否则会静默建成顶层任务，主任务详情页的小任务列表按 `parentId` 过滤就只剩带父号的那条）；本对话尚无主任务（首次）放行，顶层任务创建路径（主会话/面板/单杆任务）不受影响。提示词同步（`eteams_create_task` 描述 + 领队子代理纪律「parentTaskId 必带」）。

**客户端**（`src/client/pages/teamsButton.tsx`）：选中团队后徽章为**只读锁定面**——chip + 队名、无清除钮、点击不打开 团队/角色 弹层（`TeamsTriggerButton` 子组件在 Provider 子树内经 `useActivityMonitor` 判定锁定态）。解锁逃生口：轮询快照已落地（`fetchedAt !== 0`）但绑定团队不在列表 = 已删除 → 徽章置灰恢复可点、弹层团队 tab 顶部提示「绑定的团队已删除——请重新选择团队」（弹层自算同判据），选中新队走既有 `selectTeam`（宿主守卫因旧队已死放行）。

**挂载对账**：恢复团队选择时宿主 GET `/session-team?sessionId=…` 为真相源——有绑定直接采信（刷 face + 本地镜像，不 POST）；宿主无绑定则按本地镜像 POST 重申（重启/失联自愈）；请求失败只进诊断通道（`recordClientDiag`），不再误设 `personaError`（那是角色面的错误位；锁定徽章应常驻显示）。角色面行为不变。

## 锚定判据：本对话「已创建任务」

`anchoredMainTaskOf(team, sessionId)`（纯函数，宿主 band 与 submit_task 守卫共用同一判据）：团队任务里 `parentId === null && chain.length === 0 && mainSessionId === sessionId` 取 id 最大者——**不按状态过滤**（用户迭代 2026-09-12「每个会话只有一个主任务，完成只是暂时的」）：容器 `completed` 只是「当前小任务都完成」的可回退标识，仍锚定；唯一例外是 `cancelled`（`createTask` 拒收已取消容器挂小任务，继续锚定会把会话卡死，故释放），容器被删除时任务行消失、锚点自然释放。chain 空排除**面板单杆任务**：面板 start 路由派发时会把主会话快照补章到任务行（派发锚点），带链的独立小任务因此也带 mainSessionId——容器由 createTask 校验保证不带执行链，据此与单杆任务区分。

- `mainSessionId` 建任务时快照调用方会话（`assignment.ts` createTask），面板 commission 路径透传绑定会话——工具路径与面板路径都落在同一判据上。
- 主任务（容器）活跃期停在 `ready`（面板路径 `creating`），期间本就可挂小任务，任务状态机**零改动**；容器 `completed` 后可继续追加小任务（`createTask` 命中即 `applyTransition → ready`，见 `assignment.ts`）——故 `anchoredMainTaskOf` 恒指向本会话那个容器，本对话不再开第二个主任务；只有容器被删除（或 `cancelled` 兜底）才回退两步走。

## 增补子任务工作流

锚定主任务存在时（band 文案分支 `mainTaskId !== undefined`，`prompts/system/sessionTeam.ts`）：

- **有领队**：用户提出任何新任务/工作请求（含全新事项）→ 主对话直接 `eteams_dispatch_captain（taskId=#N，message=用户原话）` 转交持续领队子代理，由其在主任务下问询并 `eteams_create_task（parentTaskId=#N）` 增补小任务；红线收窄为只调 dispatch（`eteams_ask_answer` 例外）。领队子代理出生提示词（`prompts/spawn/captainChild.ts`）补同款增补条款。同一主任务的 dispatch 天然续聊同一领队子代理（按大任务锚定），无新机制。
- **无领队**：主对话先问询（ask_user_question）→ 结论 `eteams_update_task` 写回主任务 → `eteams_create_task（parentTaskId=#N）` 增补小任务。
- 两个分支都固定声明：本对话已固定为团队对话（一个对话只对应一个团队），不要建议用户更换团队或取消选择。

## 改动点清单

| 位置 | 改动 |
| --- | --- |
| `host/runtime/sessionTeam.ts` | 绑定常驻；删 consumed/consumeSessionTeamBinding/getConsumedSessionTeamId/isHumanUserTurn；新增 getSessionTeamBinding、clearSessionTeamForTeam、anchoredMainTaskOf；section live 分支传 mainTaskId |
| `host/prompts/system/sessionTeam.ts` | band live 分支加 mainTaskId 与锚定增补文案；固定锁定声明；dead 分支改「团队已删除，可在团队按钮重选」 |
| `host/index.ts` | 删一次性消费监听器（session/event） |
| `host/tools/identity.ts`、`host/runtime/usage.ts` | 消费凭证回退收敛为 `getSessionTeamId(...)` |
| `host/runtime/webui.ts` | POST /session-team 锁守卫（409）+ 新增 GET /session-team |
| `host/tools/captainTools.ts` | create_team / submit_task 新建分支两条守卫 |
| `host/runtime/teamOps.ts` | createTeam 不再清绑定；deleteTeam 清指向该队的绑定 |
| `host/prompts/spawn/captainChild.ts` | 领队子代理增补条款；拆解纪律补「parentTaskId 必带」（漏传被入库守卫拒绝） |
| `client/lib/api.ts` | 新增 fetchSessionTeam（GET /session-team） |
| `client/pages/teamsButton.tsx` | 锁定徽章（TeamsTriggerButton）、失联解锁、挂载宿主对账、删发送清空沿检测与 useSession prop |
| `host/runtime/sessionTeam.ts` | 新增 `anchoredMainTaskOfCaller`（调用会话 → 本对话锚定主任务；领队子代理经副本行/注册表换回它主持的大任务） |
| `host/runtime/assignment.ts` | `createTask` 入库守卫：已有锚定主任务却不带 `parentTaskId` → 抛错不入库（首次放行） |
| `host/tools/captainTools.ts` | `eteams_create_task` 描述与参数补「拆解必带 parentTaskId / 首次建主任务用 eteams_submit_task」 |

## 测试

- `tests/sessionTeam.test.ts`：绑定常驻、anchoredMainTaskOf 选取、band 锚定/回退分支、resolveCaller 绑定优先（一次性消费用例删除）。
- `tests/webui.test.ts`：session-team 同队重绑 200 / 异队重绑 409 / 旧队删除后重绑 200 / GET 回读。
- `tests/lifecycle.test.ts`：`入库守卫：一个会话一个主任务` 三例——领队子代理漏传 `parentTaskId` 被拒且**不落库**（#43–#45 事故回归）、首次（无主任务）放行、主会话同判据；原「同会话建多个顶层任务」的用例改走第二个对话（多主任务只能来自多对话）。
