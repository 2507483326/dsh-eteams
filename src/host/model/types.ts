/**
 * Data model records (docs/05, SQLite 定案 docs/27/35). Everything is plain
 * JSON-serializable: camelCase fields, Unix-millisecond times, and integer
 * autoincrement ids for task/attempt/decision/event/mail numbers (docs/27
 * §27.4: 编号全部由数据库发，内存字段就是库里的自增主键值).
 *
 * @module dsh-eteams/model/types
 */

/** Task lifecycle status (docs/27 §27.9.11: 10 态收敛，docs/35 §4 映射方案 A). */
export type TaskStatus =
  | 'draft'
  | 'ready'
  | 'wait'
  | 'start'
  | 'paused'
  | 'wait_decision'
  | 'wait_user'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** One execution-chain station: planned member plus stage brief (docs/06.7). */
export interface ChainStation {
  /** Planned member display name (may be added to the roster later). */
  member: string;
  /** What this stage contributes to the task (rendered into contract.md). */
  stageBrief: string;
}

/** Why one attempt exists. */
export type AttemptKind = 'initial' | 'stage' | 'retry' | 'reassign';

/** Attempt lifecycle status. */
export type AttemptStatus =
  'pending_accept' | 'running' | 'succeeded' | 'failed' | 'revoked' | 'paused';

/** One progress note on the execution line (≤200 chars per docs/06.3). */
export interface ProgressNote {
  at: number;
  text: string;
}

/** One execution attempt: the unit of claim/token/report auditing. */
export interface AttemptRecord {
  /** 自增尝试号（attempts.attempt_id；docs/27：编号全部由数据库发）。 */
  id: number;
  taskId: number;
  kind: AttemptKind;
  member: string;
  status: AttemptStatus;
  /** Issued by claim; required by progress/complete/fail afterwards. */
  token: string;
  /** Chain cursor this attempt executed (stage/retry bookkeeping). */
  stationIndex: number;
  createdAt: number;
  claimedAt?: number;
  endedAt?: number;
  progress: ProgressNote[];
  result?: { output: string; changedPaths?: string[] };
  error?: string;
}

/** Fixed-framework persona (docs/05.3, D13). Fields are stable; content editable. */
export interface PersonaRecord {
  frameworkVersion: 1;
  role: string;
  duty: string;
  style: string;
  skills: string;
  rules: string[];
  executionPrompt: string;
  /**
   * Optional full role playbook in Markdown (agency-agents-zh style: 使命/
   * 核心职责/关键规则/交付标准). Injected at spawn via renderPersonaBlock;
   * members without one run on the fixed fields alone.
   */
  personaMd?: string;
}

/**
 * Snapshot of the model route a member runs on (docs/05.3, FR-08；docs/35
 * §3#5 精简：只留 model + reasoningEffort 两项，provider 由派发时按
 * config.memberProvider 解析，内存不再携带；model 空串 = 跟随（子会话继承
 * 领队会话模型），有值 = 覆盖）。
 */
export interface ModelRouteSnapshot {
  model: string;
  reasoningEffort?: string;
}

/** Member/task-member lifecycle status (docs/27 task_members.status 同集). */
export type MemberStatus = 'staged' | 'ready' | 'working' | 'paused' | 'removed';

/** Avatar seed + option (docs/14; option payload arrives with M6). */
export interface AvatarRecord {
  seed: number;
  salt: number;
  updatedAt?: number;
}

/**
 * One team member template (docs/35 §3#9：member = 纯模板，一人一行，无状态
 * 无会话锚点；执行实例在 TaskMemberRecord)。`employeeId` 是库里的工号整数
 * （显示补零为 `ET-0001`，roster.formatEmployeeId）。
 */
export interface MemberRecord {
  /** member 表行号（member_id，只作行标识；工号见 employeeId）。 */
  memberId: number;
  name: string;
  /**
   * 工号 (docs/21)：库里的整数工号，插入成员模板时取 member 表最大工号 +1，
   * 同人跨团队同号。undefined = 尚未发号（旧数据补齐前）。
   */
  employeeId?: number;
  role: string;
  persona: PersonaRecord;
  modelRoute: ModelRouteSnapshot;
  avatar: AvatarRecord;
  createdAt: number;
}

/**
 * One task-member execution instance (docs/27 task_members 表；docs/35
 * §5#12：实例行按大任务粒度建——同一人每条大任务一行、各绑独立子会话；
 * 领队也是一行（name=项目牧羊人、mainTaskId 为空的团队级主持行）。
 */
export interface TaskMemberRecord {
  /** task_members.task_member_id 自增主键；内存新建行为 0，落库时发号。 */
  id: number;
  teamId: number;
  /** 实例行所属大任务 id（根大任务；独立无链任务=自身 id）；NULL=领队行。 */
  mainTaskId: number | null;
  /** 当前执行任务 id（链推进/改派时更新）。 */
  nowTaskId: number | null;
  name: string;
  /** 工号副本（引用 member.employee_id，松引用）。 */
  employeeId: number | null;
  /** 主代理会话 id；未启动时是空串（领队行存领队会话 id）。 */
  mainSessionId: string;
  /** 持续子代理会话 id；spawn 后回填，空串 = 尚未启动。 */
  childSessionId: string;
  roleId: number | null;
  status: MemberStatus;
  /** 执行时的人设手册（沿用模板手册，可按任务微调；库内 persona_md 列）。 */
  personaMd?: string;
  /** 执行时采用的模型（空串 = 跟随领队会话模型）。 */
  model?: string;
  reasoningEffort?: string;
  avatar?: AvatarRecord;
  createdAt: number;
}

/** One pending captain/user decision (docs/08; lifecycle wired in M2). */
export interface DecisionRecord {
  /** 自增决策号（decisions.decision_id）。 */
  id: number;
  taskId: number;
  attemptId?: number;
  error: string;
  retryCount: number;
  status: 'open' | 'resolved';
  createdAt: number;
  resolvedAt?: number;
  choice?: 'suspend' | 'reassign' | 'notify_user';
  note?: string;
}

/**
 * One task with its execution chain (docs/05.4, D11；docs/27 task 表)。
 * 大任务/小任务由 parentId 表达（docs/27 定案：parent_id 空 = 大任务，
 * 原 kind 列不落库——容器收口等判据随迁到结构判据，见 taskMachine）。
 */
export interface TaskRecord {
  /** 自增任务号（task.task_id；面板显示「任务 #N」）。 */
  id: number;
  subject: string;
  /** 父任务 id：小任务挂靠的父任务；null = 大任务。 */
  parentId: number | null;
  description?: string;
  /** 验收标准（task.acceptance JSON 数组）。 */
  acceptance?: string[];
  /** 范围内（task.in_scope）。 */
  inScope?: string[];
  /** 范围外（task.out_of_scope）。 */
  outOfScope?: string[];
  deliverables?: string[];
  idempotencyNote?: string;
  /** 依赖前置任务 id 列表（task.depend_tasks）。 */
  dependencies: number[];
  /** Planned execution chain; empty = single-executor task. */
  chain: ChainStation[];
  /** Index of the last completed station; -1 before the first. */
  chainCursor: number;
  status: TaskStatus;
  /** 当前执行成员名（task.current_member 松引用）。 */
  assignee?: string;
  /** 执行尝试（attempts 表按 task_id 装回；docs/27 §27.6.2 唯一拆表数组）。 */
  attempts: AttemptRecord[];
  retryCount: number;
  /**
   * 阻塞前的状态（docs/35 §5#11）：wait 三义（已派待接取/重试排队/阻塞等
   * 上游）由它区分——非空即「阻塞等上游」，解除时还原到它并清空。
   */
  blockedFrom?: TaskStatus;
  /** 当前状态说明（task.status_note；挂起原因等并入这列）。 */
  statusNote?: string;
  /** 任务工作目录（相对工作区；分配后固定，旧任务按字面路径导入）。 */
  workDir?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

/** Who triggered an event or sent a message. */
export type ActorKind = 'captain' | 'member' | 'user' | 'plugin' | 'system';

export interface Actor {
  kind: ActorKind;
  name?: string;
}

/** One audit event (docs/27 events 表；event_id 全库自增，内存 seq = 它). */
export interface EventRecord {
  /** 全库递增事件号（events.event_id；团队内排序也按它）。 */
  seq: number;
  at: number;
  actor: Actor;
  type: string;
  taskId?: number;
  attemptId?: number;
  payload?: Record<string, unknown>;
}

/** Mailbox message kind. */
export type MailKind = 'assignment' | 'report' | 'question' | 'notice' | 'user_message';

/**
 * One mailbox message (docs/27 mail_messages 表)。`seq` = 库里的
 * mail_message_id（全库自增，箱内顺序按它排）；`id` 是幂等键
 * message_id，接收方按它去重。
 */
export interface MailMessage {
  id: string;
  seq: number;
  at: number;
  from: Actor;
  to: Actor;
  kind: MailKind;
  taskId?: number;
  attemptId?: number;
  content: string;
  readAt?: number;
}

/**
 * In-memory mirror of one team's rows (docs/35 §2 整存整取：readTeam 从 11 张
 * 表重装，writeTeam 在一个事务里 DELETE + 带原号重 INSERT)。团队只是定执行
 * 流程的容器——goal/phase/审批门/领队会话锚点全部不在此（领队锚点在
 * taskMembers 的领队行上）。
 */
export interface TeamState {
  /** team.team_id 自增号。 */
  id: number;
  /** 展示名（team.team_name；旧文本团队 id 转为普通列）。 */
  name: string;
  /** 班底里是否含领队（team.has_leader）；领队行在 taskMembers 里。 */
  hasLeader: boolean;
  createdAt: number;
  updatedAt: number;
  /** 执行实例行（含领队主持行；docs/35 §5#12 按大任务粒度建）。 */
  taskMembers: TaskMemberRecord[];
  /** 成员模板（班底 + 工作区公共模板都从这里装；member 表）。 */
  members: MemberRecord[];
  /** 任务树（task 表按 task_id 升序装回；attempts 拆表装回）。 */
  tasks: TaskRecord[];
  /** 待处置升级决策（decisions 表 open 行）。 */
  pendingDecisions: DecisionRecord[];
}