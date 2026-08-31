/**
 * Build-session state (docs/19.6.2/19.9.1, D18-5): one workspace-level slot
 * in `<stateRoot>/rolebuilder.json` tracking a conversational member build.
 * The Role Builder reports steps via `eteams_build_report`; the panel polls
 * `GET /eteams-api/rolebuilder` and confirms via `POST .../confirm` (D18-6).
 * Pure Node — no cordis.
 *
 * @module dsh-eteams/runtime/roleBuilder
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteText } from '../state/store.js';
import { avatarSeedFor, upsertRosterMember } from './roster.js';

export type BuildStatus = 'active' | 'awaiting_confirmation' | 'confirmed' | 'cancelled';

/**
 * One persona draft — field names align 1:1 with `eteams_member_save`
 * params so the confirm path can persist it verbatim (docs/19.9.3).
 */
export interface BuildDraft {
  name: string;
  role: string;
  duty?: string;
  style?: string;
  skills?: string;
  rules?: string[];
  executionPrompt?: string;
  personaMd?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  /**
   * Pre-assigned avatar pair (docs/14): generated once when the draft first
   * gets a name, so the face is stable from card/preview through confirm.
   */
  avatar?: { seed: number; salt: number };
}

/** One build session (docs/19.9.1). */
export interface BuildSession {
  schemaVersion: 1;
  /** Session identity — set once at creation, never merged over. */
  startedAt: number;
  status: BuildStatus;
  step: string;
  stepsDone: string[];
  request: string;
  draft: BuildDraft | null;
  note: string;
  updatedAt: number;
  /** Pending/answered intent interview (docs/19.16). */
  interview?: InterviewState;
}

interface BuildFile {
  schemaVersion: 1;
  session: BuildSession | null;
}

/**
 * Allowed transitions (docs/19.9.1): active → awaiting_confirmation →
 * confirmed | cancelled. Self-transitions carry step/draft updates;
 * confirmed/cancelled are terminal (a new build opens a new session).
 */
const TRANSITIONS: Record<BuildStatus, BuildStatus[]> = {
  active: ['active', 'awaiting_confirmation', 'cancelled'],
  awaiting_confirmation: ['awaiting_confirmation', 'confirmed', 'cancelled'],
  confirmed: [],
  cancelled: [],
};

/** Absolute build-session file path for a state root. */
export function roleBuilderFile(stateRoot: string): string {
  return join(stateRoot, 'rolebuilder.json');
}

/**
 * Side-car file remembering which main-session agent spawned the current
 * build phase (docs/19.16): host routes (interview answers / resume) need a
 * live parent Agent to attribute the NEXT one-shot phase child to. Written on
 * every spawn; never carries a child id — phase children are one-shot and
 * need no interrupt/followup handle at all.
 */
function parentRefFile(stateRoot: string): string {
  return join(stateRoot, 'rolebuilder-parent.json');
}

/** Remember the spawning main-session id (one-shot phase attribution). */
export async function setBuildParentSession(
  stateRoot: string,
  parentSessionId: string,
): Promise<void> {
  await atomicWriteText(parentRefFile(stateRoot), `${JSON.stringify({ parentSessionId }, null, 2)}\n`);
}

/** Read the remembered main-session id, if any. */
export function readBuildParentSession(stateRoot: string): string | null {
  const file = parentRefFile(stateRoot);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { parentSessionId?: unknown };
    return typeof parsed.parentSessionId === 'string' && parsed.parentSessionId !== ''
      ? parsed.parentSessionId
      : null;
  } catch {
    return null;
  }
}

/** Read the session; missing or malformed file yields null. */
export function readBuildSession(stateRoot: string): BuildSession | null {
  const file = roleBuilderFile(stateRoot);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<BuildFile>;
    return parsed.session ?? null;
  } catch {
    return null;
  }
}

/** One `eteams_build_report` payload (all fields optional). */
export interface BuildReport {
  status?: BuildStatus;
  step?: string;
  stepsDone?: string[];
  request?: string;
  draft?: BuildDraft;
  note?: string;
  /**
   * Publish an intent interview (docs/19.16): the builder child posts its
   * questions; the workbench renders them; answers arrive via
   * `answerBuildInterview` and are relayed back to the child by the host.
   */
  interview?: { questions: InterviewQuestion[] };
  /**
   * Marks a deliberate brand-new build (the /eteam handler opening over a
   * terminal session). Ordinary builder reports never set this — so a
   * cancelled session cannot be resurrected by a late background report.
   */
  newBuild?: boolean;
}

/**
 * Merge one report into the session slot. A report on a terminal session
 * with an explicit `status: 'active'` opens a NEW session (覆盖); anything
 * else on a terminal session is rejected. `draft` merges shallowly so
 * partial field reports accumulate (docs/19.6.2).
 */
export async function reportBuildProgress(
  stateRoot: string,
  report: BuildReport,
): Promise<BuildSession> {
  const now = Date.now();
  // 显式 newBuild = 开一个全新构建：无条件覆盖任何现有会话（含待确认——
  // 新请求让位旧草稿，与 /eteam 处理器语义一致）。后台构建代理被纪律禁止
  // 传该标记，其迟到播报仍走下方终态守卫（docs/19.16）。
  if (report.newBuild === true) {
    const fresh: BuildSession = {
      schemaVersion: 1,
      startedAt: now,
      status: 'active',
      step: report.step ?? '收到需求',
      stepsDone: report.stepsDone ?? [],
      request: report.request ?? '',
      draft: ensureDraftAvatar(report.draft ?? null),
      note: report.note ?? '',
      updatedAt: now,
    };
    await writeSession(stateRoot, fresh);
    return fresh;
  }
  const current = readBuildSession(stateRoot);
  const requested = report.status ?? current?.status ?? 'active';
  const terminal =
    current !== null && (current.status === 'confirmed' || current.status === 'cancelled');
  // Non-terminal sessions follow the transition table; terminal sessions are
  // only ever replaced by a brand-new build (status 'active', docs/19.9.1).
  if (current !== null && !terminal && !TRANSITIONS[current.status].includes(requested)) {
    throw new Error(`非法状态迁移：${current.status} → ${requested}`);
  }
  if (terminal) {
    // 已结束的会话只允许显式 newBuild 开新局——防止后台构建代理的迟到播报
    // 把用户已放弃/已入库的构建复活（docs/19.16）。
    throw new Error(`构建会话已结束（${current?.status}），普通播报不再写入`);
  }
  if (current === null) {
    if (requested !== 'active') {
      throw new Error(`无法以 ${requested} 开启构建会话（首轮状态必须为 active）`);
    }
    const fresh: BuildSession = {
      schemaVersion: 1,
      startedAt: now,
      status: 'active',
      step: report.step ?? '收到需求',
      stepsDone: report.stepsDone ?? [],
      request: report.request ?? '',
      draft: ensureDraftAvatar(report.draft ?? null),
      note: report.note ?? '',
      updatedAt: now,
    };
    await writeSession(stateRoot, fresh);
    return fresh;
  }
  const next: BuildSession = {
    ...current,
    status: requested,
    step: report.step ?? current.step,
    stepsDone: report.stepsDone ?? current.stepsDone,
    request: report.request ?? current.request,
    draft: ensureDraftAvatar(
      report.draft === undefined
        ? current.draft
        : current.draft === null
          ? report.draft
          : { ...current.draft, ...report.draft },
    ),
    note: report.note ?? current.note,
    interview:
      report.interview !== undefined
        ? { questions: report.interview.questions }
        : current.interview,
    updatedAt: now,
  };
  await writeSession(stateRoot, next);
  return next;
}

/**
 * Store the user's interview answers (docs/19.16): the host route calls this
 * and then wakes the builder child with a formatted followup. Idempotent
 * re-answers overwrite (the panel allows correcting before the child resumes).
 */
export async function answerBuildInterview(
  stateRoot: string,
  answers: { id: string; choice: string }[],
): Promise<BuildSession> {
  const current = readBuildSession(stateRoot);
  if (current === null || current.interview === undefined) {
    throw new Error('没有待回答的意图访谈');
  }
  if (current.status !== 'active') {
    throw new Error(`构建已结束（${current.status}），访谈答案不再接收`);
  }
  const next: BuildSession = {
    ...current,
    interview: { ...current.interview, answers, answeredAt: Date.now() },
    note: '意图访谈已作答——构建代理恢复中',
    updatedAt: Date.now(),
  };
  await writeSession(stateRoot, next);
  return next;
}

/** One selectable option in an intent-interview question. */
export interface InterviewOption {
  label: string;
  description?: string;
}

/** One intent-interview question rendered as an option list in the workbench. */
export interface InterviewQuestion {
  id: string;
  question: string;
  /** Optional group heading: models often carry ask_user_question's header habit — render it above the question. */
  header?: string;
  options: InterviewOption[];
  /** Allow multiple selections (answers joined with 「、」). */
  multi?: boolean;
}

/**
 * Intent-interview state carried on the session (docs/19.16): the builder
 * child publishes questions here; the workbench renders them as a clickable
 * questionnaire; the host relays answers back to the child via followup.
 */
export interface InterviewState {
  questions: InterviewQuestion[];
  answers?: { id: string; choice: string }[];
  answeredAt?: number;
}

/** One-time avatar assignment: stable face from first preview through confirm. */
function ensureDraftAvatar(draft: BuildDraft | null): BuildDraft | null {
  if (draft === null || draft.avatar !== undefined || draft.name === '') return draft;
  return {
    ...draft,
    avatar: { seed: avatarSeedFor(draft.name), salt: Math.floor(Math.random() * 1000) },
  };
}

/**
 * Confirm the pending draft (docs/19.6.3, D18-6): only valid from
 * `awaiting_confirmation`. Persists the member via `upsertRosterMember`
 * and flips the session to confirmed in one operation — the one place the
 * conversational flow ever writes the roster.
 */
export async function confirmBuildSession(
  stateRoot: string,
  draft: BuildDraft,
): Promise<{ session: BuildSession; memberName: string }> {
  const current = readBuildSession(stateRoot);
  if (current === null || current.status !== 'awaiting_confirmation') {
    throw new Error('没有待确认的构建草稿（状态非 awaiting_confirmation）');
  }
  const stored = await upsertRosterMember(stateRoot, {
    name: draft.name,
    role: draft.role,
    ...(draft.duty !== undefined ? { duty: draft.duty } : {}),
    ...(draft.style !== undefined ? { style: draft.style } : {}),
    ...(draft.skills !== undefined ? { skills: draft.skills } : {}),
    ...(draft.rules !== undefined ? { rules: draft.rules } : {}),
    ...(draft.executionPrompt !== undefined ? { executionPrompt: draft.executionPrompt } : {}),
    ...(draft.personaMd !== undefined ? { personaMd: draft.personaMd } : {}),
    ...(draft.avatar !== undefined ? { avatar: draft.avatar } : {}),
    ...(draft.provider !== undefined ? { provider: draft.provider } : {}),
    ...(draft.model !== undefined ? { model: draft.model } : {}),
    ...(draft.reasoningEffort !== undefined ? { reasoningEffort: draft.reasoningEffort } : {}),
  });
  const next: BuildSession = {
    ...current,
    status: 'confirmed',
    step: '已入库',
    stepsDone: [...current.stepsDone, '确认入库'],
    draft: { ...(current.draft ?? {}), ...draft },
    note: `已入库 ${stored.name}（${stored.role}）`,
    updatedAt: Date.now(),
  };
  await writeSession(stateRoot, next);
  return { session: next, memberName: stored.name };
}

/**
 * Cancel the session; only active/awaiting sessions can be cancelled.
 * `note` lets callers distinguish user abandonment from dispatch-failure
 * rollback（派发失败的会话必须标回 cancelled，否则无子代理的 active 会话
 * 会卡住 /eteam 的门禁）.
 */
export async function cancelBuildSession(
  stateRoot: string,
  note = '已放弃本次构建',
): Promise<BuildSession> {
  const current = readBuildSession(stateRoot);
  if (current === null) throw new Error('没有进行中的构建会话');
  if (!TRANSITIONS[current.status].includes('cancelled')) {
    throw new Error(`非法状态迁移：${current.status} → cancelled`);
  }
  const next: BuildSession = {
    ...current,
    status: 'cancelled',
    note,
    updatedAt: Date.now(),
  };
  await writeSession(stateRoot, next);
  return next;
}

/**
 * Resume a cancelled build (docs/19.16): the session file keeps the full
 * context (stepsDone/draft/request), and the panel wakes the durable builder
 * child via followup — the child continues from where it was interrupted.
 * Only cancelled sessions resume; a confirmed build already landed in the
 * roster and starts a fresh build via /eteam instead.
 */
export async function resumeBuildSession(stateRoot: string): Promise<BuildSession> {
  const current = readBuildSession(stateRoot);
  if (current === null) throw new Error('没有可恢复的构建会话');
  if (current.status !== 'cancelled') {
    throw new Error(`仅已放弃的构建可恢复（当前状态：${current.status}）`);
  }
  const next: BuildSession = {
    ...current,
    status: 'active',
    step: current.step === '已入库' ? '继续构建' : current.step,
    note: '已恢复——从中断处继续',
    updatedAt: Date.now(),
  };
  await writeSession(stateRoot, next);
  return next;
}

async function writeSession(stateRoot: string, session: BuildSession): Promise<void> {
  const file: BuildFile = { schemaVersion: 1, session };
  await atomicWriteText(roleBuilderFile(stateRoot), `${JSON.stringify(file, null, 2)}\n`);
}
