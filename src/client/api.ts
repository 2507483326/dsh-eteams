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

/** Create a staged team bound to the current session (panel flow). */
export async function createTeamViaPanel(
  sessionId: string,
  name: string,
  goal?: string,
): Promise<void> {
  await requestJson(`${API_BASE}/team`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      sessionId,
      ...(goal !== undefined && goal.trim() !== '' ? { goal: goal.trim() } : {}),
    }),
  });
}

/** Add a member to a team, adopting a roster entry when fromRoster is set. */
export async function addTeamMember(
  teamId: string,
  payload: { name: string; fromRoster: true },
): Promise<void> {
  await requestJson(`${API_BASE}/team/${encodeURIComponent(teamId)}/member`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
