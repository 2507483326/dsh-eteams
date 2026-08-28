/**
 * Member roster (D16): a workspace-level directory of reusable member
 * definitions. A roster entry carries the persona-framework fields plus the
 * optional model route; teams add members by name and adopt the entry's
 * persona. One roster file per workspace state root, atomic writes via the
 * team store. Pure Node — no cordis.
 *
 * @module dsh-eteams/runtime/roster
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteText } from '../state/store.js';

/** Stored avatar pair (docs/14): deterministic seed for the SVG renderer. */
export interface AvatarPair {
  seed: number;
  salt: number;
}

/** One reusable member definition (persona framework + optional route). */
export interface RosterMember {
  /** Unique key across the workspace roster (trimmed, non-empty). */
  name: string;
  /** Role label (engineer / researcher / …). Free-form, non-empty. */
  role: string;
  /** Persona framework fields (D13) — content is copied on team adoption. */
  duty?: string;
  style?: string;
  skills?: string;
  rules?: string[];
  executionPrompt?: string;
  /** Optional per-member model route, applied when a team adopts the entry. */
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  /** Pre-generated avatar (docs/14 first slice); auto-assigned when absent. */
  avatar?: AvatarPair;
  updatedAt: number;
}

interface RosterFile {
  schemaVersion: 1;
  members: RosterMember[];
}

/** Absolute roster file path for a state root. */
export function rosterFile(stateRoot: string): string {
  return join(stateRoot, 'roster.json');
}

/** Read the roster; missing or malformed file yields an empty roster. */
export function readRoster(stateRoot: string): RosterMember[] {
  const file = rosterFile(stateRoot);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<RosterFile>;
    return Array.isArray(parsed.members) ? parsed.members : [];
  } catch {
    return [];
  }
}

/** Find one roster entry by exact name. */
export function findRosterMember(stateRoot: string, name: string): RosterMember | undefined {
  return readRoster(stateRoot).find((m) => m.name === name);
}

/** Stable avatar seed from a name (mirrors teamOps hashName). */
function hashName(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) | 0;
  return Math.abs(h) % 997;
}

/**
 * Insert or update one roster entry (keyed by trimmed name). Returns the
 * stored entry. Throws when name/role are empty after trimming. An entry
 * without an avatar gets one pre-generated here (docs/14 first slice) so
 * every member always has a stable face; updates keep the existing avatar.
 */
export async function upsertRosterMember(
  stateRoot: string,
  member: Omit<RosterMember, 'updatedAt'>,
): Promise<RosterMember> {
  const name = member.name.trim();
  const role = member.role.trim();
  if (name === '') throw new Error('成员名不能为空');
  if (role === '') throw new Error('角色不能为空');
  const members = readRoster(stateRoot);
  const previous = members.find((m) => m.name === name);
  const stored: RosterMember = {
    ...member,
    name,
    role,
    avatar: member.avatar ??
      previous?.avatar ?? { seed: hashName(name), salt: Math.floor(Math.random() * 1000) },
    updatedAt: Date.now(),
  };
  const idx = members.findIndex((m) => m.name === name);
  if (idx >= 0) members[idx] = stored;
  else members.push(stored);
  const file: RosterFile = { schemaVersion: 1, members };
  await atomicWriteText(rosterFile(stateRoot), `${JSON.stringify(file, null, 2)}\n`);
  return stored;
}
