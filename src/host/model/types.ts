/**
 * Data model records (docs/05). Everything is plain JSON-serializable:
 * camelCase fields, Unix-millisecond times, string ids. `schemaVersion`
 * starts at 2 (docs/05.10) — readers migrate forward, never backward.
 *
 * @module dsh-eteams/model/types
 */

/** Current on-disk schema version. */
export const SCHEMA_VERSION = 2;

/** Team lifecycle phase. */
export type TeamPhase = 'staged' | 'running' | 'paused' | 'halted' | 'completed';

/** Staged-plan review state (user approves from the panel; never the captain). */
export type PlanReviewState = 'awaiting_review' | 'returned' | 'approved';

/** Task lifecycle status (docs/06.1). */
export type TaskStatus =
  | 'draft'
  | 'ready'
  | 'assigned'
  | 'in_progress'
  | 'retrying'
  | 'paused'
  | 'awaiting_decision'
  | 'needs_user'
  | 'suspended'
  | 'blocked'
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
  id: string;
  taskId: string;
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

/** Snapshot of the LLM route a member runs on (docs/05.3, FR-08). */
export interface ModelRouteSnapshot {
  provider: string;
  model: string;
  reasoningEffort?: string;
  source: 'inherited' | 'override';
}

/** Member lifecycle status. */
export type MemberStatus = 'staged' | 'ready' | 'working' | 'paused' | 'removed';

/** Avatar seed + option (docs/14; option payload arrives with M6). */
export interface AvatarRecord {
  seed: number;
  salt: number;
  updatedAt?: number;
}

/** One team member. */
export interface MemberRecord {
  /** Durable child session id (backfilled after spawn; '' while staged). */
  id: string;
  name: string;
  role: string;
  persona: PersonaRecord;
  modelRoute: ModelRouteSnapshot;
  status: MemberStatus;
  currentAttemptId?: string;
  avatar: AvatarRecord;
  createdAt: number;
  removedAt?: number;
}

/** One pending captain/user decision (docs/08; lifecycle wired in M2). */
export interface DecisionRecord {
  id: string;
  taskId: string;
  attemptId?: string;
  error: string;
  retryCount: number;
  status: 'open' | 'resolved';
  createdAt: number;
  resolvedAt?: number;
  choice?: 'suspend' | 'reassign' | 'notify_user';
  note?: string;
}

/** One task with its execution chain (docs/05.4, D11). */
export interface TaskRecord {
  id: string;
  subject: string;
  description?: string;
  acceptance?: string[];
  inScope?: string[];
  outOfScope?: string[];
  deliverables?: string[];
  idempotencyNote?: string;
  dependencies: string[];
  /** Planned execution chain; empty = single-executor task. */
  chain: ChainStation[];
  /** Index of the last completed station; -1 before the first. */
  chainCursor: number;
  status: TaskStatus;
  assignee?: string;
  currentAttemptId?: string;
  attempts: AttemptRecord[];
  retryCount: number;
  /** Status to restore when a materialized `blocked` unblocks. */
  blockedFrom?: TaskStatus;
  suspendNote?: string;
  decisionId?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  outcome?: string;
}

/** Actor attribution shared by events and mailbox rows. */
export interface Actor {
  kind: 'captain' | 'member' | 'user' | 'plugin' | 'system';
  name?: string;
}

/** One audit/log event (docs/09.5). */
export interface EventRecord {
  seq: number;
  at: number;
  actor: Actor;
  type: string;
  taskId?: string;
  attemptId?: string;
  payload?: Record<string, unknown>;
}

/** Mailbox message kind. */
export type MailKind = 'assignment' | 'report' | 'question' | 'notice' | 'user_message';

/** One mailbox row (docs/09.1; at-least-once delivery). */
export interface MailMessage {
  id: string;
  seq: number;
  at: number;
  from: Actor;
  to: Actor;
  kind: MailKind;
  taskId?: string;
  attemptId?: string;
  content: string;
  readAt?: number;
}

/** Full team snapshot — the disk truth in `team.json` (docs/05.2). */
export interface TeamState {
  schemaVersion: number;
  id: string;
  name: string;
  goal: string;
  captainSessionId: string;
  phase: TeamPhase;
  planReviewState?: PlanReviewState;
  createdAt: number;
  updatedAt: number;
  version: number;
  taskSeq: number;
  attemptSeq: number;
  mailSeq: number;
  maxRetries: number;
  workDir?: string;
  members: MemberRecord[];
  tasks: TaskRecord[];
  pendingDecisions: DecisionRecord[];
  activeSwitch?: { fromTeamId: string; at: number };
}
