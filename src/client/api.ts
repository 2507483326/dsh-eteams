/**
 * Panel write API (D16 + M5 first slice): fetch helpers for the member
 * roster and the panel-driven create-team / add-member flows. All calls go
 * to the plugin's own `/eteams-api` namespace (docs/12, docs/18 §7.1 —
 * never under `/plugins`).
 *
 * @module dsh-eteams/client/api
 */

/** Base URL prefix for every eteams route. */
const API_BASE = '/eteams-api';

/** One reusable member definition in the workspace roster (D16). */
export interface RosterMember {
  name: string;
  /** 工号 (docs/21): host-allocated `ET-0001` style id; stable across teams. */
  employeeId?: string;
  role: string;
  duty?: string;
  style?: string;
  skills?: string;
  rules?: string[];
  executionPrompt?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  /** Pre-generated avatar pair (docs/14); host assigns one when absent. */
  avatar?: { seed: number; salt: number };
  /** Full Markdown role playbook (agency-agents-zh style). */
  personaMd?: string;
  updatedAt: number;
}

/** New-member form payload (fields beyond name/role optional). */
export interface NewMemberInput {
  name: string;
  role: string;
  duty?: string;
  style?: string;
  skills?: string;
  executionPrompt?: string;
  /** Full Markdown role playbook (all persona content lives here now). */
  personaMd?: string;
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON error bodies fall through to the status check
  }
  if (!res.ok) {
    const message =
      body !== null && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body;
}

/** List the workspace roster (D16). */
export async function fetchRoster(): Promise<RosterMember[]> {
  const body = (await requestJson(`${API_BASE}/roster`)) as { members?: unknown };
  return Array.isArray(body.members) ? (body.members as RosterMember[]) : [];
}

/** Save (insert or update) one roster entry. */
export async function saveRosterMember(member: NewMemberInput): Promise<void> {
  await requestJson(`${API_BASE}/roster`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(member),
  });
}

/**
 * Create a staged team bound to the current session (panel flow). Returns
 * the created teamId so the panel can select the new team immediately.
 */
export async function createTeamViaPanel(
  sessionId: string,
  name: string,
  goal?: string,
): Promise<{ teamId: string; name: string }> {
  const body = (await requestJson(`${API_BASE}/team`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      sessionId,
      ...(goal !== undefined && goal.trim() !== '' ? { goal: goal.trim() } : {}),
    }),
  })) as { teamId?: unknown };
  return {
    teamId: typeof body.teamId === 'string' ? body.teamId : '',
    name,
  };
}

/**
 * Add a member to a team, adopting a roster entry. `sourceName` copies a
 * roster role under a different name（同一角色可重复加入，名册默认值照抄）；
 * `employeeId` 显式指定工号（缺省沿用角色库同号，再缺省由 host 分配）。
 */
export async function addTeamMember(
  teamId: string,
  payload: { name: string; sourceName?: string; employeeId?: string },
): Promise<void> {
  await requestJson(`${API_BASE}/team/${encodeURIComponent(teamId)}/member`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: payload.name,
      fromRoster: true,
      ...(payload.sourceName !== undefined && payload.sourceName !== payload.name
        ? { sourceName: payload.sourceName }
        : {}),
      ...(payload.employeeId !== undefined && payload.employeeId.trim() !== ''
        ? { employeeId: payload.employeeId.trim() }
        : {}),
    }),
  });
}

/**
 * Set one member's model route（成员卡右侧模型选择）：model 为空 = 重置为
 * 继承领队路线。运行中的成员在下次启动时生效（staged 成员启动即生效）。
 */
export async function setMemberModel(
  teamId: string,
  name: string,
  model: { provider?: string; model?: string; reasoningEffort?: string },
): Promise<void> {
  await requestJson(
    `${API_BASE}/team/${encodeURIComponent(teamId)}/member/${encodeURIComponent(name)}/model`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(model),
    },
  );
}

/** Move the leader out of / back into the team's member roster. */
export async function setTeamLeaderRemoved(teamId: string, removed: boolean): Promise<void> {
  await requestJson(`${API_BASE}/team/${encodeURIComponent(teamId)}/leader/${removed ? 'remove' : 'restore'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** Delete one roster member. The leader (项目牧羊人) is rejected by the host. */
export async function deleteRosterMember(name: string): Promise<void> {
  await requestJson(`${API_BASE}/roster/${encodeURIComponent(name)}/remove`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** Move a team member out of a team (领队不属于团队成员记录，无需删除). */
export async function removeTeamMember(teamId: string, name: string): Promise<void> {
  await requestJson(
    `${API_BASE}/team/${encodeURIComponent(teamId)}/member/${encodeURIComponent(name)}/remove`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
}

// ---------- session persona takeover (docs/13.8.2) ----------

/**
 * Assert the persona band for one session: the session agent's system prompt
 * gains a per-assembly persona section (runtime/sessionPersona.ts), so the
 * conversation speaks as the selected member — no draft text involved.
 */
export async function setSessionPersona(
  sessionId: string,
  member: { name: string; role?: string; duty?: string; personaMd?: string },
): Promise<void> {
  await requestJson(`${API_BASE}/session-persona`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      name: member.name,
      ...(member.role !== undefined ? { role: member.role } : {}),
      ...(member.duty !== undefined ? { duty: member.duty } : {}),
      ...(member.personaMd !== undefined ? { personaMd: member.personaMd } : {}),
    }),
  });
}

/** Clear the persona band (deselect — back to the default agent voice). */
export async function clearSessionPersona(sessionId: string): Promise<void> {
  await requestJson(`${API_BASE}/session-persona/clear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
}

// ---------- role-builder build session (docs/19.6, D18) ----------

/** One persona draft — field names align with eteams_member_save params. */
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
  /** Pre-assigned avatar pair — stable face from first preview through confirm. */
  avatar?: { seed: number; salt: number };
}

/** One selectable option in an intent-interview question (docs/19.16). */
export interface InterviewOption {
  label: string;
  description?: string;
}

/** One intent-interview question rendered as an option list in the workbench. */
export interface InterviewQuestion {
  id: string;
  question: string;
  /** Optional group heading (rendered small above the question). */
  header?: string;
  options: InterviewOption[];
  multi?: boolean;
}

/** Intent-interview state carried on the build session (docs/19.16). */
export interface InterviewState {
  questions: InterviewQuestion[];
  answers?: { id: string; choice: string }[];
  answeredAt?: number;
}

/** One build session (docs/19.9.1). */
export interface BuildSession {
  schemaVersion: number;
  startedAt: number;
  status: 'active' | 'awaiting_confirmation' | 'confirmed' | 'cancelled';
  step: string;
  stepsDone: string[];
  request: string;
  draft: BuildDraft | null;
  note: string;
  updatedAt: number;
  /** Pending/answered intent interview (docs/19.16). */
  interview?: InterviewState;
  /** Owning /eteam invocation id — cards match it to their own build. */
  commandId?: string;
}

/** Poll the single build-session slot (null when no session exists). */
export async function fetchBuildState(): Promise<BuildSession | null> {
  const body = (await requestJson(`${API_BASE}/rolebuilder`)) as {
    empty?: boolean;
    session?: BuildSession;
  };
  return body.empty === true || body.session === undefined ? null : body.session;
}

/** Resume a cancelled build — host spawns a fresh one-shot phase child. */
export async function resumeBuild(): Promise<void> {
  await requestJson(`${API_BASE}/rolebuilder/resume`, { method: 'POST' });
}

/**
 * 活跃会话心跳（用户迭代：兜底弹窗 steer 到用户正在看的对话）：输入栏按钮
 * 只在当前打开的对话里挂载，定期上报它所在的 sessionId；宿主记 last-writer-
 * wins，兜底 steer 前读取定位。fire-and-forget——失败静默，心跳断了就退回
 * 父会话路径。
 */
export async function reportPresence(sessionId: string): Promise<void> {
  await requestJson(`${API_BASE}/presence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, ts: Date.now() }),
  });
}

/** Submit intent-interview answers — host relays them to the builder child. */
export async function submitInterview(answers: { id: string; choice: string }[]): Promise<void> {
  await requestJson(`${API_BASE}/rolebuilder/interview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers }),
  });
}

/**
 * Manually restart the builder agent — spawns a fresh one-shot phase child
 * that re-checks progress and re-publishes the interview if unanswered.
 */
export async function restartBuild(): Promise<void> {
  await requestJson(`${API_BASE}/rolebuilder/restart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** Confirm the pending draft — host persists to the roster atomically. */
export async function confirmBuild(draft: BuildDraft): Promise<void> {
  await requestJson(`${API_BASE}/rolebuilder/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  });
}

/** Abandon the current build session. */
export async function cancelBuild(): Promise<void> {
  await requestJson(`${API_BASE}/rolebuilder/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/**
 * Member subagent activity dots (docs/20.4 P4): childId → 'running' |
 * 'inactive'. Empty map on older runtimes without listChildren (no dots).
 */
export async function fetchAgentActivity(teamId: string): Promise<Record<string, string>> {
  const body = (await requestJson(
    `${API_BASE}/team/${encodeURIComponent(teamId)}/agentactivity`,
  )) as { activity?: unknown };
  return body.activity !== null && typeof body.activity === 'object'
    ? (body.activity as Record<string, string>)
    : {};
}
