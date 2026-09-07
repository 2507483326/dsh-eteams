/**
 * Data model records (docs/05, SQLite 定案 docs/27/35). Everything is plain
 * JSON-serializable: camelCase fields, Unix-millisecond times, and integer
 * autoincrement ids for task/attempt/decision/event/mail numbers (docs/27
 * §27.4: 编号全部由数据库发，内存字段就是库里的自增主键值).
 *
 * @module dsh-eteams/model/types
 */

/** Task lifecycle status (docs/27 §27.9.11: 11 态收敛，docs/35 §4 映射方案 A).
 * `creating` = 面板手动创建的主任务容器占位（docs/panelTaskCommission）：已
 * 入册、待领队/主会话完善，完善收口转 ready。 */
export type TaskStatus =
  | 'creating'
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

/**
 * One execution-chain station: planned member plus stage brief (docs/06.7).
 * v7：站点写**工号**（执行链按工号接力，允许同名成员）；迁移解析不到班底行
 * 的旧站点保留成员名字符串（legacy），渲染时标注并按名兜底。
 */
export interface ChainStation {
  /** 站点成员工号（数字 = v7 工号站点；字符串 = legacy 名字站点）。 */
  member: number | string;
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
  /**
   * 执行副本行 id（attempts.task_member_id，v7）：尝试归属按副本行 id 判定
   * （claim 握手安全边界——同名成员不串 attempt）；undefined = 旧数据未回填，
   * 判定退按名兜底。
   */
  taskMemberId?: number;
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
  /** 一句话简介（列表卡片/详情头展示用；空串视同无）。 */
  profile?: string;
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
 * Snapshot of the model route a member runs on (docs/05.3, FR-08；v9 provider
 * 回归：同 id 模型跨提供方（用户实测 tokenrouter/tr-test 都有
 * z-ai/glm-5.3-free、目录显示名不同）时模型 id 有歧义——显示与 spawn 都需要
 * 目录 provider。model 空串 = 会话默认（用户迭代 2026-09-04：settings
 * agent-default-model 即时快照，provider 随默认走），有值 = 覆盖。
 */
export interface ModelRouteSnapshot {
  model: string;
  /** 覆盖路线的目录 provider；undefined/'' = 未记录（旧数据，读端反查兜底）。 */
  provider?: string;
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
 * One team member template (docs/35 §3#9：班底 = 工牌发放处，一人一行；人设
 * 手册经 role_id 解析自 roles 角色行（成员=角色，全局一份）。v7：工号就是
 * 班底行的自增主键（表自增，team_members.team_member_id）——全机器唯一、
 * AUTOINCREMENT 只增不复用，删除作废；显示补零为 `ET-0007`
 * （roster.formatEmployeeId）。
 */
export interface MemberRecord {
  /** team_members.team_member_id（自增主键 = 工号；内存新建行 0 落库发号）。 */
  memberId: number;
  /** roles.role_id（松引用；人设/头像在角色行上，写端保证行存在）。 */
  roleId: number | null;
  name: string;
  /**
   * 工号（v7 表自增）：恒等于 memberId（读端由主键派生）。保留字段名是为了
   * 邮箱分箱/展示链路与副本行共用同一语义。
   */
  employeeId?: number;
  /** 角色标签 = persona.role（persona_md 的「角色：」行；成员名=角色名）。 */
  role: string;
  persona: PersonaRecord;
  modelRoute: ModelRouteSnapshot;
  avatar: AvatarRecord;
  /** 领队标识（v8 team_members.is_leader）：项目牧羊人=1 其余=0；领队行查找按它不按名。 */
  isLeader?: boolean;
  createdAt: number;
}

/**
 * One task-member execution instance (docs/27 task_members 表；docs/35
 * §5#12：实例行按大任务粒度建——同一人每条大任务一行、各绑独立子会话；
 * 领队也是一行（name=项目牧羊人、mainTaskId 为空的团队级主持行）。
 * v7：副本行在建任务/加成员时从班底整行复制（工号抄班底行自增主键），
 * 行生命周期跟随所属大任务（删任务→副本级联删）。
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
  /** 工号（v7 表自增：建任务/加成员时抄自班底行 team_member_id；主持行同步班底领队行）。 */
  employeeId: number | null;
  /** 本行自己的子代理会话 id（v6：成员行=成员子会话，领队行=领队子代理会话）；未启动时是空串。 */
  sessionId: string;
  status: MemberStatus;
  /** 执行时的人设手册（沿用角色行手册，可按任务微调；库内 persona_md 列）。 */
  personaMd?: string;
  /** 执行时采用的模型（空串 = 会话默认，用户迭代 2026-09-04）。 */
  model?: string;
  /** 覆盖路线的目录 provider（v9，同 ModelRouteSnapshot.provider 口径）；undefined/'' = 未记录。 */
  provider?: string;
  reasoningEffort?: string;
  avatar?: AvatarRecord;
  /** 领队标识（v8 task_members.is_leader）：项目牧羊人行=1 其余=0；领队行查找按它不按名。 */
  isLeader?: boolean;
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
  /**
   * 任务合同全文（task.contract_md，Markdown）。十六轮 DA29：原四数组
   * （验收标准/范围内/范围外/交付物）合并为一篇 MD 统一管理——工具写入
   * （eteams_create_task/eteams_update_task 的 contractMd 参数）、面板渲染
   * （MarkdownText）、派发邮件与 contract.md 均透传原文；旧库/旧导入由
   * contractMdFromLegacyArrays 合成回填。
   */
  contractMd?: string;
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
  /**
   * 主会话 ID 快照（task.main_session_id，v5 落列 v6 改名）：建任务时登记
   * 的主会话 ID（对话工具=调用方会话；面板=绑定会话透传；导入=旧
   * captainSessionId），落库后不变——重锚/补章不回改已登记行；旧库任务行由
   * v5 迁移按领队行回填；未登记为空（不落键）。
   */
  mainSessionId?: string;
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
  /** 班底行（team_members；v7 工牌发放处——工号在班底行上，人设经 roles 装回）。 */
  members: MemberRecord[];
  /** 任务树（task 表按 task_id 升序装回；attempts 拆表装回）。 */
  tasks: TaskRecord[];
  /** 待处置升级决策（decisions 表 open 行）。 */
  pendingDecisions: DecisionRecord[];
}
