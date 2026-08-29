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
  /** Durable id of the background builder child, for cancel-time interrupt. */
  agentId?: string;
  /** Main-session id the builder child was spawned under (interrupt authority). */
  parentSessionId?: string;
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
  const current = readBuildSession(stateRoot);
  const now = Date.now();
  const requested = report.status ?? current?.status ?? 'active';
  const terminal =
    current !== null && (current.status === 'confirmed' || current.status === 'cancelled');
  // Non-terminal sessions follow the transition table; terminal sessions are
  // only ever replaced by a brand-new build (status 'active', docs/19.9.1).
  if (current !== null && !terminal && !TRANSITIONS[current.status].includes(requested)) {
    throw new Error(`非法状态迁移：${current.status} → ${requested}`);
  }
  if (terminal && report.newBuild !== true) {
    // 已结束的会话只允许显式 newBuild 开新局——防止后台构建代理的迟到播报
    // 把用户已放弃/已入库的构建复活（docs/19.16）。
    throw new Error(`构建会话已结束（${current?.status}），普通播报不再写入`);
  }
  if (current === null || terminal) {
    if (requested !== 'active') {
      throw new Error(
        current === null
          ? `无法以 ${requested} 开启构建会话（首轮状态必须为 active）`
          : `非法状态迁移：${current.status} → ${requested}`,
      );
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
    updatedAt: now,
  };
  await writeSession(stateRoot, next);
  return next;
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

/** Cancel the session; only active/awaiting sessions can be cancelled. */
export async function cancelBuildSession(stateRoot: string): Promise<BuildSession> {
  const current = readBuildSession(stateRoot);
  if (current === null) throw new Error('没有进行中的构建会话');
  if (!TRANSITIONS[current.status].includes('cancelled')) {
    throw new Error(`非法状态迁移：${current.status} → cancelled`);
  }
  const next: BuildSession = {
    ...current,
    status: 'cancelled',
    note: '已放弃本次构建',
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

/** Record the background builder child id + parent session (cancel-time interrupt). */
export async function setBuildAgentId(
  stateRoot: string,
  info: { agentId: string; parentSessionId: string },
): Promise<void> {
  const current = readBuildSession(stateRoot);
  if (current === null) return;
  if (current.agentId === info.agentId && current.parentSessionId === info.parentSessionId) return;
  await writeSession(stateRoot, { ...current, ...info });
}

async function writeSession(stateRoot: string, session: BuildSession): Promise<void> {
  const file: BuildFile = { schemaVersion: 1, session };
  await atomicWriteText(roleBuilderFile(stateRoot), `${JSON.stringify(file, null, 2)}\n`);
}
