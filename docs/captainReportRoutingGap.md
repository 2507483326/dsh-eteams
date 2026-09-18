# 成员 → 领队汇报「卡死」根因记录（2026-09-18）

**状态：已修复（A+B+C 全部落地，含 2 条回归用例）。** 修法见文末「候选修法」。
用户 2026-09-18 先拍板「只记录根因」，随后决定修复。

## 症状（用户 2026-09-18 澄清口径）

成员子代理经 `eteams_send_message to="captain"` 报缺口 / 汇报后，**没有任何会话被唤醒**：

- 领队子代理没收到；
- **主会话也什么都没收到**；
- 只有成员子会话一直停在等待态，团队任务就此卡死。

用户原话：「都没有到主会话，主会话什么都没收到，只有子对话一直在等，所以卡死了」。

⚠️ 这与「投给了错的会话（本该给领队、结果给了主会话）」是两回事——**报文根本没投出去**。
第一版记录只看到了「投错人」，方向不对；真正致命的是下面这条**静默放弃**路径。

## 契约（实现本该做到的）

- `src/host/tools/gapTools.ts:131`：成员上报能力缺口后，`eteams_send_message to="captain"`
  把 gapId + 摘要发给领队，**「唤醒他处置」**。
- `docs/subagentCapabilityGap.md:81`：升级路由 = **「领队可见（`eteams_send_message
  to="captain"` 唤醒 + capability_gaps 落行）」**。
- `src/host/tools/captainTools.ts:1249`：工具描述「成员侧 `to="captain"` 发给领队（求助/决策/汇报）」。

## 根因

### 主因：领队唤醒是「单发锚点 + 无兜底 + 无冷恢复 + 无日志」

`src/host/runtime/teamOps.ts:826-840`（`sendMessage` 的 `captain` 分支）：

```ts
const anchorId = teamMainSessionOf(fresh) || readBuildPresence(root)?.sessionId || '';
const captainAgent = anchorId !== '' ? env.ctx.agents.get(anchorId) : undefined;
if (captainAgent) {
  captainAgent.followup(...);
}
// ← 没有 else：既没唤醒、也没冷恢复、也没告警
```

逐条拆开为什么它会「什么都不发生」：

1. `teamMainSessionOf(fresh)`（notifier.ts:216）取的是**全队「任务号最小」那条任务**的主会话快照
   （`team.tasks.find(...)` 返回数组首个非空），**不是当前会话**。多任务团队里这条快照很可能
   早已关闭。
2. 该字串非空 ⇒ `||` 右侧的**面板心跳兜底根本不会被求值**——`readBuildPresence(root)` 那半截
   只在 `teamMainSessionOf` 返回空串时才生效，所以它形同虚设。
3. `env.ctx.agents.get(anchorId)`（base.ts:92）只查**活代理**；会话已关闭即返回 `undefined`。
4. `if (captainAgent)` 不成立 → **直接跳过整个唤醒**，无 `agents.resume` 冷恢复、无 warn。
   报文落进 `'captain'` 箱后就再没人管它。
5. 结果：领队子代理与主会话**都没被唤醒**（正是「主会话什么都没收到」），成员子会话停等 → 卡死。

对照正确写法——`notifier.ts` 的 `resolveAnchorAgent`（240 行起）：

- 接受**候选 id 列表**，逐个查活代理（列表里含面板心跳 `readBuildPresence`）；
- 全离线时对首个非空 id 走 `env.ctx.agents.resume(...)` **冷恢复**（245–268 行）；
- 彻底失败会 `logger.warn(...)` 留痕。

`sendMessage` 这半截既没有心跳兜底、也没有冷恢复与日志——是 2026-09-11（「汇报直达领队」）、
2026-09-13（「主会话没唤醒子代理跑不了」锚点优先级）两轮修复**唯一漏改**的唤醒路径。

### 次因（即使唤醒成功也投错人）：`captain` 分支不走「汇报直达领队」

同一个分支里，唤醒目标只可能是**主会话**，全程不解析领队子代理。正确路由见 `notifier.ts` 的
`wakeCaptain`（339–403 行）：

1. 定位该 root 任务的领队副本行 `is_leader=1 && mainTaskId===root && sessionId!==''`（349–354 行）；
2. 锚点优先级：① 领队子代理的**真实直接父**（`captainChildParentOf`，注册表）→ ② 本任务主会话快照
   → ③ 全队主会话快照 → ④ 面板心跳（364–369 行）；
3. `deliverToChild` 投给**领队子代理**（377–383 行），失败才回落主会话 `followup`（391–398 行）。

`notifyCaptain` / `notifyCaptainInTx`（notifier.ts:409 / 425）都走 `wakeCaptain`；成员完成 / 失败 /
婉拒 / 缺口处置等路径（`assignment.ts:1869 / 1944 / 1983 / 2085`）用的都是它，**唯独
`eteams_send_message` 这条没跟上**。

> 两个缺陷是叠加关系：主因决定「有没有人收到」（现在是没人收到），次因决定「收到的人对不对」
> （修好主因后，若不加 A 的路由改动，就变成主会话收到、领队仍收不到）。

邮件本身没问题——落库都是往 `'captain'` 箱（teamOps.ts:814–825），领队子代理读的是同一个箱；
问题全在**唤醒**这一步。

## 为什么一直没被抓到

`sendMessage` 的 captain 分支**没有任何测试覆盖**。`tests/` 里与本主题相关的只有
`tests/gapTools.test.ts:250`，断言的是那句提示文案含 `eteams_send_message`，不涉及投递目标。

## 连带项（修的时候要一起看）

1. **兜底链要真的能兜住**：修主因的最小形态 = 换成 `resolveAnchorAgent` 的「多候选 + 冷恢复 +
   失败留痕」，而不是继续用单发 `agents.get`。
2. **`wakeCaptain` 需要 `taskId` 才能算出 `root`** 去定位领队副本行；而 `eteams_send_message`
   的 `taskId` 是可选参数（captainTools.ts:1253），成员报缺口通常不带。不补兜底的话，即使换成
   `wakeCaptain`，不带 `taskId` 的汇报仍会退化到主会话。
   可用兜底源：工具手里有 `caller.member.mainTaskId`（`identity.ts:34-39` 的 `MemberCaller`，
   其 `TaskMemberRecord.mainTaskId` 就是该副本行锚定的大任务）。
3. `sendMessage` 里 `from.kind === 'user' ? 'user_message' : 'report'`（teamOps.ts:821）是**死代码**：
   `sendMessage` 全仓唯一调用点是 `captainTools.ts:1271`，传的 `caller.actor` 由 `resolveCaller`
   （`identity.ts:91`）产出，只会是 `captainActor`(kind='captain') 或 `memberActor`(kind='member')，
   **不可能为 user**。`user_message` 这个 kind 全仓只有这一处产出、且不可达（`import.ts:581` 认它
   只是为读旧库）。面板/用户侧给 captain 发消息走的是 `captainFor` + `followup`
   （`webui.ts:1517-1521`），不经 `sendMessage`。→ 动手时应把该三元连同不可达分支一并清掉，
   而不是改变其落点。
4. **事务外投递纪律**：该分支的 `followup` 目前写在 `withTeam` 事务体内（teamOps.ts:829–840），
   而模块头（teamOps.ts:4-5）要求「起会话/唤醒一律放在 COMMIT 之后」；`wakeMember`/`queueNotice`
   都是 push 进 `wakes` 提交后执行。改这一处时顺手对齐。

## 修法（已实施，2026-09-18）

- **A+B（修主因 + 路由）**：`wakeCaptain` 改为导出（`src/host/runtime/notifier.ts:344`），
  `sendMessage` 的 `captain` 分支不再自己算锚点，改为落箱后
  `wakes.push(() => wakeCaptain(env, fresh, '[来自 X] content', refs.taskId))`
  （`src/host/runtime/teamOps.ts:813-830`）。锚点优先级、面板心跳兜底、冷恢复、失败 warn
  全部与 `notifyCaptain` 同源；顺带把唤醒挪到提交后（原先写在事务体内，违反模块头纪律），
  并清掉不可达的 `from.kind === 'user' ? 'user_message' : 'report'` 三元（见连带项 3）。
- **C（taskId 兜底）**：工具层在 `args.taskId` 缺省时用 `caller.member.mainTaskId` 补齐
  （`src/host/tools/captainTools.ts:1271-1279`）。
- **回归用例**（`tests/lifecycle.test.ts`，均先在旧代码上验证过会失败）：
  ① 「成员 `to="captain"` 的汇报直达领队子代理，不被陈旧主会话快照毒化」——断言唤醒落在
  领队子代理、主会话没被 followup、邮件仍落领队箱；
  ② 「成员用 `eteams_send_message` 不带 taskId 时按自己副本行的大任务兜底」。

验证：`npm run typecheck` / `eslint`（改动文件）/ `npm run test`（776 passed）/
`npm run build`（两个 Build complete + `SMOKE OK`）。

## 相关落点速查

| 关注点 | 位置 |
| --- | --- |
| 缺陷所在（单发静默唤醒） | `src/host/runtime/teamOps.ts:826-840` |
| 正确锚点解析（多候选 + 冷恢复 + warn） | `src/host/runtime/notifier.ts:240-268`（`resolveAnchorAgent`） |
| 正确汇报路由 | `src/host/runtime/notifier.ts:339-403`（`wakeCaptain`，未导出） |
| 现有正确调用方 | `notifier.ts:409 / 425`（`notifyCaptain` / `notifyCaptainInTx`） |
| 全队主会话快照（易过期） | `src/host/runtime/notifier.ts:216`（`teamMainSessionOf`） |
| 工具面 | `src/host/tools/captainTools.ts:1246-1276`（`eteams_send_message`） |
| 契约出处 | `src/host/tools/gapTools.ts:131`、`docs/subagentCapabilityGap.md:81` |
| 测试缺口 | 无覆盖；仅 `tests/gapTools.test.ts:250` 断言提示文案 |
