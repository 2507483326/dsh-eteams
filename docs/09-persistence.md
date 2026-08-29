# 09 持久化设计

磁盘是唯一真相（NFR-01/03/04/05）。本文定义文件格式、写入协议、锁与恢复材料；断点续行的完整流程见 [10](10-checkpoint-recovery.md)。

## 9.1 文件与职责

| 文件 | 角色 | 写入模式 |
|---|---|---|
| `<teamId>/team.json` | 全量快照（读路径主源） | 原子替换（整体重写） |
| `<teamId>/events.jsonl` | append-only 事件日志（审计 + 恢复重放） | 追加（每行一事件） |
| `<teamId>/inbox/*.jsonl` | 邮箱（至少一次投递） | 追加 |
| `archive/<teamId>/**` | 归档（只读搬移） | rename 整目录 |
| `teams/<team-slug>/**`（工作区可见层，D12） | 任务文档：README/contract.md 为状态渲染视图；notes.md 为成员追加区 | 幂等渲染覆盖（生成物）/ 仅创建（notes）/ 成员自由追加 |

不变量：

1. **先日志后快照**：每次状态变更先追加事件，成功后再写快照；快照失败则事件已留痕（恢复时可重放）。
2. **快照自包含**：team.json 含恢复所需全部信息（成员/任务/attempt/决策/版本号），不依赖日志即可运行；日志用于审计与一致性校验。
3. **追加文件永不改写**：events/inbox 只 append；纠错用补偿事件（如 `task.revoked`），不改历史。
4. **任务文档不是状态真相（NFR-11）**：`teams/` 下 README/contract.md 可随时从 team.json 幂等重建，不参与恢复重放；notes.md 是成员增量记忆（恢复时原样保留，交接/续行必读）。文档渲染失败不阻断状态事务（告警降级）。

## 9.2 原子写协议（atomicWriteText）

```
write(tmp, content)           # 同目录临时文件 <name>.<pid>.<seq>.tmp
fsync?(tmp)                   # 可选（默认关，性能权衡；崩溃窗口见 9.6）
rename(tmp, file)             # 原子替换
失败(Windows EPERM/EACCES/EBUSY/EEXIST/ENOTEMPTY):
   重试 ≤3 次(间隔 50ms) -> 仍失败: 直接 writeFile(file, content) 降级
   # 与参考实现相同策略：Windows 上 rename 覆盖已存在目标会 EPERM（杀软/索引器短暂持锁）
降级也失败: 抛错，操作回滚（内存态不动，事件日志补偿）
```

## 9.3 进程内锁与写队列

```
withTeamLock(`team:${stateRoot}:${teamId}`, fn)   # per-team 串行
withTeamLock(`captain:${stateRoot}:${captainId}`, fn) # per-captain（一活动团队约束）
```

- 实现：Map<string, Promise 链>（进程内异步互斥）；锁内执行「读快照 -> 校验迁移 -> 写事件 -> 写快照 -> 投递通知」整个事务。
- **事务性**：锁内任一步抛错则内存与磁盘都不落半状态（事件先追加的按补偿事件处理：追加 `tx.aborted`）。
- 团队目录级追加（inbox/events）同样在 team 锁内，避免交错行。

## 9.4 版本号与冷启动校验

- `TeamState.version`：每次成功事务 +1；`events.jsonl` 的 `seq` 同步递增。
- 冷启动读取流程：
  1. 读 team.json（失败：目录损坏 -> 尝试从 events 重放重建；见 9.7）。
  2. 读 events.jsonl 末尾 seq；若 `seq > snapshotVersion` -> 重放差量事件到快照（理论上不发生：快照总在事件后写；防御性保留）。
  3. 若 `seq < snapshotVersion`（日志落后于快照，如日志被截断）-> 信任快照，日志追加 `journal.resynced` 标记事件。
- 跨进程冲突检测：内存态 version 与磁盘不一致（外部被改）-> 拒绝写并报错「状态被外部修改，请重开团队」（NFR-03 单写者的失败安全）。

## 9.5 事件类型清单（v0.2）

```
team.created / team.staged / plan.approved / plan.returned / plan.discarded
team.switched / team.archived / team.halted / team.resumed / team.completed
member.added / member.removed / member.spawned / member.retired
task.created / task.updated / task.deleted / task.dependency_changed
task.assigned / task.reassigned / task.claimed / task.declined
task.progress / task.completed / task.failed / task.retry_scheduled / task.retry_started
task.suspended / task.resumed / task.cancelled / task.blocked / task.unblocked
decision.requested / decision.resolved
mailbox.delivered / mailbox.requeued
recovery.cold_started / recovery.attempt_stale / recovery.member_reattached
tx.aborted / journal.resynced
```

每事件必带：`seq/at/actor{kind,name}`；任务相关带 `taskId/attemptId`。事件 payload 保持可渲染（动态视图直接用）。

## 9.6 崩溃窗口分析（fsync 关闭时）

| 崩溃点 | 磁盘结果 | 恢复行为 |
|---|---|---|
| 事件追加后、快照替换前 | 日志新、快照旧 | 重放差量事件（9.4.2），状态一致 |
| 快照替换后、通知投递前 | 快照新、通知缺 | 冷恢复补投邮箱未读（[10](10-checkpoint-recovery.md)）；在线即投丢失可接受（成员重开会话时补） |
| 临时文件残留 | `.tmp` 孤儿 | 启动清扫 `*.tmp` |

结论：默认不 fsync 的崩溃窗口最坏丢「一次通知的即时性」，不丢已确认状态；与参考实现同级。可配置 `fsync: true` 换更强保证。

## 9.7 损坏恢复

- **team.json 解析失败**：目录改名 `corrupt-<teamId>-<ts>/`；从 events.jsonl 重放重建快照（重放 = 按事件序对空状态应用迁移函数）；重放失败 -> 保留原始目录，面板显示「团队损坏，数据保留在 …」。
- **events.jsonl 半行**（崩溃时追加中断）：截断至最后一个合法换行；记 `journal.truncated` 事件。
- **邮箱半行**：同上截断；该消息视为未投递（至少一次语义允许重投）。

## 9.8 归档与清理

- 归档 = rename 团队目录到 `archive/`；面板「历史团队」列表读取 archive 快照（只读渲染，无操作按钮）。
- v0.2 不做自动清理；`eteams_delete_team` 提供显式删除（二次确认；默认先归档）。
- 工作区 `.eteams/` 建议 gitignore（状态含会话 ID 与本地路径），文档注明。
- **子代理记录不归本插件管（harness 存储语义）**：团队成员是 `startContinuable` 持久子代理（邮箱模型/完成即续派依赖可续聊），其会话记录持久化在**领队会话**的存储子树里（`origin: 'subagent'`，带 `parentSession`）。两层回收（docs/20）：① **驻留 Activation**——`removeMember`/`archiveTeam`/`deleteTeam` 在 interrupt 之后调用 `drainContinuableChildren(captainAgent, memberIds)`（特性检测，旧运行时降级为仅 interrupt），live 注册表立刻干净、成员不可再被唤醒；② **记录级**——持久化子会话随父会话销毁而回收 → 清理动作 = 在 DSH 里归档/删除对应对话（会话即工作区：一个项目一批团队用一个会话）。完结记录为惰性 JSON（interrupt 过 + 无 followup 路由 + 终态守卫），不运行、不消耗、跨会话不可见。**角色构建代理已改一次性阶段制**（docs/19.16）：不产生可续聊记录，每阶段是 mode=one-shot 的终态条目，派发方持有 run 并在结算后 dispose。

## 9.9 容量与性能预算

| 场景 | 预算 |
|---|---|
| 100 任务 × 5 attempt × 10 事件 | team.json ≈ 300KB；快照写 <20ms（SSD） |
| 事件日志 10k 行 | 轮询读快照不受影响（日志只在恢复/审计读） |
| 1s 轮询 / 会话 | 单团队快照序列化 <10ms；无活动团队降频 5s（[03](03-tech-stack.md) 3.5） |

超出预算（>500 任务）属 v0.3 优化议题（快照分片/事件滚动归档），v0.2 明确不支持。
