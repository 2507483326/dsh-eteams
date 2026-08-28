# 08 失败重试与升级决策

本文规范化 D6：同成员自动重试（默认 3 次、可配置）-> 超限后领队三选一（挂起跳过 / 换成员重试 / 通知用户）。状态机基础见 [06](06-task-lifecycle.md)。

## 8.1 失败分类

| 类别 | 判定 | 处理 |
|---|---|---|
| **A 可重试失败** | 成员显式 `eteams_fail_task(attempt_id, error, retryable=true)`：环境抖动、依赖未就绪、断言偶发、超时等 | 进入自动重试阶梯 |
| **B 不可重试失败** | 成员显式 `retryable=false`：需求矛盾、合同不可实现、依赖产物根本缺失 | 跳过重试，直接 awaiting_decision |
| **C 运行时中断** | 成员子代理被 interrupt/进程崩溃（attempt 停驻） | 不是失败：走 paused 恢复路径（[10](10-checkpoint-recovery.md)）；若无法恢复（子代理会话损坏）按 B 处理 |
| **D 验证失败** | 成员自报完成但领队/下游发现产物不合格（v0.2 无自动验证门禁） | 领队改派或重新指派（等于 reassign，retryCount 重置）；记 note 事件 |

v0.2 不内置自动测试门禁（与参考实现的 quality-gates 不同路线，见 [17 开放问题](17-risks.md)）；验收标准在任务合同中由成员自证 + 领队审阅。

## 8.2 自动重试阶梯（同成员）

```
失败(retryable=true, retryCount=k)
  └─ k+1 > maxRetries(默认3)? ──是──▶ awaiting_decision（升级）
                                   ──否──▶ retrying：调度 backoff 后同一成员新 attempt(kind=retry)
backoff：min(30s * 2^(k-1), 5min) + 抖动；期间任务显示「自动重试中(第k+1/3次)」
重试上下文：同成员续会话（followup），携带失败摘要与「上次失败原因，请改变策略而非原样重跑」提示
```

细节：

1. **重试即新 attempt**（kind=retry, attemptToken 新发），执行线路完整可见；旧 attempt 标 failed。
2. 重试唤醒消息模板：
   ```
   [重试] 任务 t3 第 2 次自动重试（此前失败：test_export 断言失败）
   上次进度与失败详情见 attempt a5 执行线路。
   要求：分析失败原因后调整方案；不要原样重跑。
   ```
3. **重试期间成员不可被指派其他任务**（working 态）。
4. **用户与领队可在任意时刻干预**：改派（吊销重试）、取消、挂起（等于提前决策）。
5. `maxRetries` 团队级配置（创建时或配置文件；0 = 失败立即升级）。

## 8.3 升级：awaiting_decision

触发即：

1. 生成 `DecisionRecord`（context 含：失败次数、最后错误、**将被阻断的下游任务清单**）。
2. 通知领队（邮箱 + 在线即投），消息模板：
   ```
   [升级] 任务 t3「实现导出模块」已连续失败 3 次（成员B）
   最后错误：test_export 断言失败（详见执行线路）
   被阻断的下游：t5「集成联调」、t6「文档」（共 2 项）
   请决策：eteams_resolve_decision(decisionId, 'suspend' | 'reassign' | 'notify_user', note?)
   - suspend：挂起 t3，t5/t6 转为被阻断，其余任务不受影响
   - reassign：换成员重试（retryCount 清零）
   - notify_user：把问题升级给用户
   ```
3. 面板横幅 + 任务卡黄点常亮（FR-23）；动态视图高亮。

## 8.4 三种决策的语义

### 8.4.1 suspend（挂起并继续其他任务，原始需求 D6/FR-24）

- 动作：task->suspended；决策记录 resolved(choice=suspend)。
- 传染：下游依赖闭包（排除终态）物化为 blocked，各自记录原因「上游 t3 已挂起」。
- **无依赖任务完全不受影响**：其余分支照常指派执行。
- 解除：领队 `eteams_resume_task(taskId)`（可选：指派新成员）-> suspended->ready（blocked 下游回原状态）。
- 兜底：领队也可直接 failed（放弃该任务线）：blocked 下游保持 blocked（领队须另行处理或取消），提醒领队显式处理下游。

### 8.4.2 reassign（换成员重试）

- 动作：吊销原成员 attempt（若有）-> task->assigned(新成员, attempt kind=reassign) -> **retryCount 清零**（记 note 事件「换人重置重试预算」）。带执行链的任务同时记 `chain.deviated`（偏离站点成员，原因=重试超限换人；预规划链不变，[06](06-task-lifecycle.md) 6.7）。
- 新成员接取时收到**交接包**（[07](07-scheduling.md) 7.6）：前几次失败的全部关键事件与产物状态（含 notes.md 摘要），避免重蹈覆辙。
- 换人对象由领队指定（领队全主导）；若领队不指定成员而只说「换人」，工具报错要求明确人选。

### 8.4.3 notify_user（通知用户处理）

- 动作：task->needs_user；领队在对话中向用户呈现：失败史摘要、已试过什么、可选处理（提供材料/调整目标/放弃/亲自答复）。
- 面板：任务卡「等待用户」状态 + 横幅（含「去对话答复」按钮，聚焦输入框）。
- 用户答复（对话内）-> 领队按答复执行：通常是 reassign（带用户新指示）或 suspend/failed。
- 超时无响应：不自动降级（保持 needs_user，用户是最终决策者）。

## 8.5 决策循环与上限

- reassign 后再次超限 -> 新 DecisionRecord（again，事件流标注「第 2 轮升级」）；无自动上限（每次升级都显式可见），但面板显示累计升级轮数提醒用户介入。
- 同一任务决策记录全量保留在 `pendingDecisions`（resolved 的归档在案），审计可查。

## 8.6 领队不可达时的兜底

- awaiting_decision/needs_user 发生时领队会话不在线（如用户已关窗）：邮箱滞留；面板横幅直接展示（磁盘真相不依赖领队在线）；用户重开会话即补投。
- 用户可在面板**代答**（v0.2 简化：横幅提供「取消任务」快捷操作；完整代答 UI 列为候选）。

## 8.7 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `maxRetries` | 3 | 同成员自动重试上限（D6）；团队级可覆盖 |
| `retryBackoffBaseMs` | 30000 | 指数退避基数 |
| `retryBackoffMaxMs` | 300000 | 退避上限 |
| `decisionOptions` | 固定三项 | v0.2 不开放自定义决策项 |
