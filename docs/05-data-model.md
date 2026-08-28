# 05 数据模型

所有记录都是纯 JSON（可手工检视、可 git）。字段命名 camelCase；时间一律 Unix 毫秒；ID 一律字符串。`schemaVersion` 随结构演进递增，读取时做前向兼容迁移（NFR-09）。

## 5.1 文件布局（磁盘真相）

```
<workspace>/.eteams/                      # stateDir，可配置
  <teamId>/                               # teamId = sanitizeKey(团队名)，全局唯一
    team.json                             # 全量快照（TeamState，下述全部记录都在此）
    events.jsonl                          # append-only 事件日志（审计+恢复重放）
    inbox/
      captain.jsonl                       # 领队收件箱
      <memberKey>.jsonl                   # 各成员收件箱（memberKey = sanitizeKey(成员名)）
  archive/
    <teamId>/                             # 归档团队整体搬移至此（只读）

<workspace>/teams/<team-slug>/            # 任务文件夹（workRoot 可配置，默认 teams/；D12）
  README.md                               # 目标与任务索引（插件渲染，随状态幂等同步）
  tasks/
    t1-<slug>/contract.md                 # 任务合同（插件渲染；状态变更时重渲染）
    t1-<slug>/notes.md                    # 执行笔记（成员追加；插件只建不写）
```

- 事件日志与快照的关系、原子写与锁见 [09 持久化](09-persistence.md)。
- 头像不存图片文件，存 `AvatarOption`（JSON），渲染端同构复现（见 [14](14-avatar-system.md)）。

## 5.2 TeamState（team.json 顶层）

```ts
interface TeamState {
  schemaVersion: number;         // 当前 2
  id: string;                    // teamId（目录名）
  name: string;                  // 展示名
  goal: string;                  // 目标描述（领队拆解的输入）
  captainSessionId: string;      // 领队会话 ID（归属与恢复锚点）
  phase: 'staged' | 'running' | 'paused' | 'halted' | 'completed';
  planReviewState?: 'awaiting_review' | 'returned' | 'approved'; // staged 阶段
  createdAt: number;
  updatedAt: number;             // 每次写盘更新
  version: number;               // 乐观版本号，每次变更 +1（冷恢复冲突检测）
  taskSeq: number;               // 任务 ID 发号器
  attemptSeq: number;            // 尝试 ID 发号器
  maxRetries: number;            // 团队级重试上限（默认 3，D6）
  workDir: string;               // 任务文件夹（相对工作区路径；批准时创建并记录，D12）
  members: MemberRecord[];
  tasks: TaskRecord[];
  pendingDecisions: DecisionRecord[];  // 待领队/用户决策队列（见 08）
  activeSwitch?: { fromTeamId: string; at: number }; // 多团队切换审计
}
```

## 5.3 MemberRecord

```ts
interface MemberRecord {
  id: string;                    // 子代理 childId（spawn 后回填）
  name: string;                  # 团队内唯一显示名
  role: string;                  // 如 researcher / engineer / reviewer
  persona: PersonaRecord;        // 人设：固定框架、内容可修改（D13，见下）
  modelRoute: ModelRouteSnapshot;// 生效模型路由快照（FR-08）
  status: 'staged' | 'ready' | 'working' | 'paused' | 'removed';
  currentAttemptId?: string;     // working/paused 时指向活动尝试
  avatar: AvatarRecord;          // 头像（种子 + option，见 14）
  createdAt: number;
  removedAt?: number;
}

interface ModelRouteSnapshot {
  provider: string;              // 子代理运行后端之外的 LLM provider id
  model: string;
  reasoningEffort?: string;      // 缺省 = 目标模型默认档
  source: 'inherited' | 'override'; // 继承当前对话 or 用户显式指定
}

interface PersonaRecord {        // 人设：框架字段固定（D13），内容可修改
  frameworkVersion: 1;
  role: string;                 // 角色定位（一句话）
  duty: string;                 // 职责边界（做什么/不做什么）
  style: string;                // 工作风格（语气/详细度偏好）
  skills: string;               // 能力与擅长
  rules: string[];              // 工作纪律（框架底线 + 追加）
  executionPrompt: string;      // 执行提示（每次唤醒注入的定向指令）
}
```

- `status.working`：持有进行中 attempt；`paused`：被中断停驻（attempt 保留，可 continue）；`ready`：空闲可接指派。
- 成员被移除：`removed` 终态；其子代理会话保留（可查看记录），不可再派新任务（策略与参考实现一致：保留会话以便审计）。
- 人设注入：spawn 时注入人设全文；每次唤醒消息头部附人设摘要（修改后下次唤醒生效，D13/FR-39）。
- 领队人设同构（PersonaRecord + 领队专属固定纪律段：问询/拆解/指派/汇报/升级处置，见 [07](07-scheduling.md) 7.7）；默认值内置，用户覆盖存 `<workspace>/.eteams/captain-persona.yaml`。

## 5.4 TaskRecord 与 AttemptRecord

```ts
interface TaskRecord {
  id: string;                    // "t1", "t2"…（taskSeq 发号）
  subject: string;               // 非空标题
  description: string;           // 合同正文（目标/验收/范围/非目标）
  dependencies: string[];        // 前置任务 id 列表（DAG，写入时查环）
  chain: ChainStation[];         // 执行链：站点序列（D11）；空 = 单执行人任务（领队自由指派）
  chainCursor: number;           // 链游标：-1 未开始；k = 第 k 站已完成（0-based）；末站完成 -> completed
  status: TaskStatus;            // 见 06 状态机
  assignee?: string;             // 成员名；assigned 及之后存在
  attempts: AttemptRecord[];     // 执行线路主体（时间序追加）
  retryCount: number;            // 当前执行人连续失败次数（换人重置，见 08）
  createdAt: number;
  updatedAt: number;
  createdBy: 'captain' | 'user'; // staged 由领队、运行中可由用户新增
  cancelReason?: string;
}

type TaskStatus =
  | 'draft'        // staged 计划中的草案
  | 'ready'        // 依赖满足，待领队指派
  | 'assigned'     // 已指派，待成员接取
  | 'in_progress'  // 成员已接取并执行中
  | 'retrying'     // 失败后同成员自动重试排队
  | 'awaiting_decision' // 重试超限，等领队决策（D6）
  | 'needs_user'   // 领队升级给用户
  | 'suspended'    // 领队挂起（依赖者转 blocked）
  | 'blocked'      // 依赖未满足或被上游挂起/失败传染
  | 'completed'
  | 'failed'       // 终态失败（领队放弃）
  | 'cancelled';

interface ChainStation {         // 执行链的一站（D11）
  member: string;                // 站点成员名
  stageBrief: string;            // 本站阶段说明（该成员在本任务中的职责切片）
}

interface AttemptRecord {        // 执行线路的一个节点
  id: string;                    // "a1", "a2"…（attemptSeq 发号）
  taskId: string;
  memberName: string;
  kind: 'initial' | 'stage' | 'retry' | 'reassign' | 'resume'; // 产生原因（stage = 执行链站点）
  attemptToken: string;          // 一次性凭证（成员更新必须携带；吊销即失效）
  status: 'pending_accept' | 'running' | 'paused' | 'succeeded' | 'failed' | 'revoked';
  createdAt: number;
  startedAt?: number;            // 接取（claim）时刻
  endedAt?: number;
  events: AttemptEvent[];        // 执行线路明细（追加）
  outcome?: {                    // 终态附注
    summary: string;             // 成员汇报摘要
    output?: string;             // 产物/结论正文
    changedPaths?: string[];     // 声明的变更文件
    error?: string;              // 失败原因
  };
}

interface AttemptEvent {         // 执行线路时间线事件
  at: number;
  kind: 'assigned' | 'claimed' | 'progress' | 'message' | 'retry_scheduled'
      | 'paused' | 'resumed' | 'succeeded' | 'failed' | 'revoked' | 'note';
  by: string;                    // 成员名 / 'captain' / 'user' / 'system'
  text?: string;                 // 进度备注、失败原因等人类可读内容
}
```

要点：
- **执行线路 = `attempts[]`（含每尝试 `events[]`）**，UI 的时间线直接映射（FR-20）。
- `attemptToken` 是防迟到/防伪造的关键：改派、重试、接管都会吊销旧 token；过期 token 的更新被拒（NFR-01）。
- `retryCount` 挂在任务上但**换成员即重置**（重置动作本身记录为事件，见 [08](08-retry-escalation.md)）。

## 5.5 事件日志（events.jsonl）

```ts
interface TeamEvent {
  seq: number;                   // 团队内单调递增
  at: number;
  actor: { kind: 'captain' | 'member' | 'user' | 'system'; name: string };
  type: string;                  // 'team.created' | 'plan.approved' | 'task.assigned'
                                 // | 'task.claimed' | 'task.progress' | 'task.completed'
                                 // | 'task.failed' | 'task.retry_scheduled' | 'task.suspended'
                                 // | 'decision.requested' | 'decision.resolved' | …
  taskId?: string;
  attemptId?: string;
  payload?: Record<string, unknown>; // 各事件自定义载荷
}
```

事件日志是**审计与恢复的真相源**，快照是**读性能优化**（详见 [09](09-persistence.md)）。`动态` 视图直接渲染事件流（FR-30）。

## 5.6 邮箱消息（inbox/*.jsonl）

```ts
interface MailMessage {
  id: string;                    // 消息 id（幂等键）
  from: string;                  // 'captain' | 成员名 | 'system' | 'user'（用户直发，D15）
  to: string;                    // 'captain' | 成员名
  at: number;
  kind: 'assignment' | 'report' | 'question' | 'answer' | 'system' | 'freeform'
        | 'user_message';       // user_message = 用户经成员对话框直发（D15）
  taskId?: string;
  attemptId?: string;
  content: string;               // 正文（assignment 附合同、report 附汇报，见 07 模板）
  readAt?: number;
}
```

- 追加写、至少一次投递；接收方按 `id` 幂等。
- 在线即投：接收方子代理在线时消息直接作为下一轮输入（`followup`）；离线时滞留邮箱，待其下次被唤醒先补投未读（与参考实现同模型）。

## 5.7 DecisionRecord（升级决策，见 08）

```ts
interface DecisionRecord {
  id: string;
  taskId: string;
  attemptId: string;             // 触发决策的失败尝试
  kind: 'retries_exhausted';     // v0.2 唯一类型；预留 'member_unresponsive' 等
  options: Array<'suspend' | 'reassign' | 'notify_user'>; // 恒为三者
  context: { failures: number; lastError: string; dependentsBlocked: string[] };
  status: 'open' | 'resolved';
  resolution?: { by: 'captain' | 'user'; choice: string; at: number; note?: string };
  createdAt: number;
}
```

## 5.8 AvatarRecord（见 14）

```ts
interface AvatarRecord {
  seed: string;                  // memberId + salt 的确定性种子
  salt: number;                  // 重摇即换 salt
  option: AvatarOption;          // vue-color-avatar 风格的组合配置（类别->形状/颜色）
  updatedAt?: number;
}
```

## 5.9 状态推导规则（读取时计算，不落盘）

| 派生量 | 规则 |
|---|---|
| 任务可指派 | `status==='ready' && dependencies 全部 completed` |
| 任务 blocked | 依赖中存在 `suspended/failed/awaiting_decision/needs_user` 之一（传染） |
| 团队进度 | `completed / (total - cancelled)` |
| 成员可指派 | `status==='ready'`（非 working/paused/staged/removed） |
| 待决策横幅 | `pendingDecisions.filter(status==='open')` |
| 下一站建议 | 任务 ready 且 `chainCursor+1 < chain.length` 时 = `chain[chainCursor+1]`（06.7） |
| 站点进度 | `(chainCursor+1) / chain.length`（无链任务不显示） |

> blocked 为派生状态但会被**物化**进 `task.status`（依赖事件发生时刷新下游状态），保证 UI 排序/筛选简单；依赖恢复（挂起解除）时反向刷新。

## 5.10 与旧 0.1 的关系

旧 `dsh-eteams` 0.1.1 的状态结构不迁移（D2 全新开始）：安装 v0.2 前卸载旧包并清理 `.eteams/`（旧包 patch 为空从未挂载，实际不会有历史数据）。`schemaVersion` 从 2 起步，与旧版区分。
