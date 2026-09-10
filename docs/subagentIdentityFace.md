# 子代理身份面：团队按钮按身份降级（用户迭代 2026-09-10）

输入栏团队按钮在**子代理会话**里不再照常可交互：不是 eteams 成员/角色的子代理，按钮整个隐藏；是（成员子代理 / 领队子代理 / 角色构建师子代理），按钮降级为**只读身份面**——头像 + 名字，不可点击、无弹层。主对话完全不变（团队选择 / 角色人设 / 团队锁定交互照旧，见 [teamSessionLock.md](teamSessionLock.md)）。本文档自含记录语义、判据与全部改动点。

## 语义三分

| 会话 | 按钮面 | 内容 |
| --- | --- | --- |
| 主对话（含已锁定团队对话） | `interactive` | 既有选择/锁定交互，零改动 |
| eteams 成员子代理 | `identity` | 头像 + 成员名，tooltip「成员「X」的子代理会话（团队「Y」）」 |
| 领队子代理 | `identity` | 头像 + 项目牧羊人，tooltip「领队「项目牧羊人」的子代理会话（团队「Y」）」 |
| 角色构建师子代理 | `identity` | 头像 + 角色构建师，tooltip「角色构建师的子代理会话」（无团队后缀） |
| 无关子代理 / 身份失效 / 身份加载中 | `hidden` | 整个按钮不渲染——加载期同样不渲染，子代理会话上绝不闪出可交互按钮 |

判定纯函数 `subagentFaceMode(isSubagent, identityReady, identity)`（`src/client/lib/subagentFace.ts`，tests/teamsButton.test.ts 逐分支锁定）。

## 身份判据：只认磁盘真相

宿主端点 `GET /eteams-api/session-identity?sessionId=…`（`src/host/runtime/webui.ts` 的 `sessionIdentityOf`）把会话 id 解析成身份；解析顺序与判据：

1. **构建子代理**：各状态根构建会话文件的 `builderChildId` 即身份凭证（单槽；confirmed/cancelled 后子代理会话仍在，脸面照常成立）。
2. **团队副本行扫描**（跨工作区，`collectRoots` 根去重同 /board 口径）：`sessionId` 精确锚一行 `task_members` 副本行——
   - `is_leader === true` → 领队（不滤 removed，`leaderRowOf` 冷恢复同口径）；
   - 其余按 `resolveCaller` 同款**离职截断**：`status === 'removed'` 或工号已不在班底（`team.members` 无同工号行）→ `undefined`（视为离职，按钮同隐）。

只认磁盘（副本行 session_id 随 spawn 同流回填、builderChildId 落盘），**运行时注册表（usage 的 memberSessions / captainAgent 的 captainChildren）不兜底**——它们的条目不随删任务/离职清理，兜底会让已失效的会话借尸还魂；重启/冷恢复也因此天然免疫。无绑定返回 `{ empty: true }`（HTTP 200，客户端据此隐藏）。

头像取值与团队快照同源：成员随班底行（roles 实时值）→ 副本行冻结值 → 按名字色相生成（`avatarSeedFor(name)`，salt=7 兜底约定）；领队取名册领队头像 → 同款兜底；构建师取名册条目 → 同款兜底。

## 子代理识别（客户端）

`isSubagent` 逐轴择源（sessionModelBadge 同款）：标准座位 kit 的 `useSession` 快照 `subagent` 面非空即已寻址子代理会话；kit 缺席时退 `isAddressedSubagentSession(sessionId)`（eteams-label 会话快照探测）。**只有子代理会话才查身份端点**；主会话不发请求，交互零打扰。

## 与既有机制的分工

- **团队锁定**（teamSessionLock.md）锁的是主对话的团队绑定；身份面只管子代理会话的展示，两者不交叉：子代理会话不参与绑定/对账（挂载恢复与心跳对子代理直接跳过恢复分支——presence 心跳保留，它表示「用户正在看的对话」而非身份）。
- **子会话模型徽章**（sessionModelBadge）与身份面同屏并存：徽章在会话头部报模型路线，身份面在输入栏报「这个人是谁」。

## 改动点清单

| 位置 | 改动 |
| --- | --- |
| `host/runtime/webui.ts` | 新增 `sessionIdentityOf`（磁盘真相解析）+ GET `/session-identity` 路由 |
| `client/lib/api.ts` | 新增 `fetchSessionIdentity`（empty 归 null、字段逐个校验） |
| `client/lib/subagentFace.ts` | 新增 `subagentFaceMode` / `subagentFaceTitle` 纯函数（独立成模块——teamsButton 本体带 UI 依赖链，node 单测拉不动） |
| `client/pages/teamsButton.tsx` | 子代理三分渲染：`identity` 只读身份脸面（SubagentIdentityFace）/ `hidden` 不渲染 / `interactive` 原交互；恢复 effect 对子代理跳过 |
| `scripts/verifyM0.mjs` | inject 门禁更新为 `['slots', 'uiConversation', 'modelDirectories', 'sessions']`（统一问答迭代改了注入清单，门禁同轮补齐） |

## 测试

- `tests/webui.test.ts`：GET /session-identity 五用例——成员子代理身份、领队子代理身份（commission 派发流 + 注册表清理）、构建师子代理身份、无关子代理/缺参 empty、离职截断 empty（移出班底前后对照）。
- `tests/teamsButton.test.ts`：subagentFaceMode 三分显隐、subagentFaceTitle 三种 tooltip。
