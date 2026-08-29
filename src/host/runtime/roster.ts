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
import { defaultCaptainPersona, PRESET_MEMBER_ROLES, ROLE_TEMPLATES } from '../prompts/persona.js';

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
  /** Full Markdown role playbook (agency-agents-zh style) for the detail view. */
  personaMd?: string;
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

/** Public avatar-seed helper (captain card in the snapshot reuses it). */
export function avatarSeedFor(name: string): number {
  return hashName(name);
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
  // 领队保留名（docs/19.10）：removeRosterMember 拒删，upsert 对称拒绝覆盖，
  // 防止对话流/面板写路径意外改写领队人设。
  if (name === LEADER_NAME) throw new Error('领队成员为保留名，不可通过 upsert 覆盖');
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

/** The team leader is itself a preset member: default-joined, undeletable. */
export const LEADER_NAME = '项目牧羊人';

/** Fixed salts so the preset members look the same in every workspace. */
const PRESET_SALTS: Record<string, number> = {
  前端开发者: 11,
  后端架构师: 23,
  'UI 设计师': 37,
  趣味注入师: 51,
  角色构建师: 67,
};

/**
 * Seed the four preset members (agency-agents-zh roles, name = role) plus the
 * leader (项目牧羊人) into a workspace roster on first access. Idempotent and
 * non-destructive: existing entries (including user edits to a preset) are
 * never overwritten; only missing presets are inserted.
 */
export async function ensurePresetMembers(stateRoot: string): Promise<void> {
  const members = readRoster(stateRoot);
  let changed = false;
  // The leader first: it belongs to the member list (用户模型：领队也是成员),
  // is default-joined to every new team as the 团队页 leader card, and is
  // protected from deletion (removeRosterMember rejects it).
  const leader = members.find((m) => m.name === LEADER_NAME);
  const captain = defaultCaptainPersona();
  if (leader === undefined) {
    members.push({
      name: LEADER_NAME,
      role: captain.role,
      duty: captain.duty,
      style: captain.style,
      skills: captain.skills,
      ...(captain.personaMd !== undefined ? { personaMd: captain.personaMd } : {}),
      avatar: { seed: hashName(LEADER_NAME), salt: 7 },
      updatedAt: Date.now(),
    });
    changed = true;
  } else if (
    captain.personaMd !== undefined &&
    staleDistilledDoc(leader.personaMd) &&
    leader.duty === captain.duty &&
    leader.style === captain.style &&
    leader.skills === captain.skills
  ) {
    leader.personaMd = captain.personaMd;
    changed = true;
  }
  for (const role of PRESET_MEMBER_ROLES) {
    const template = ROLE_TEMPLATES[role];
    if (template === undefined) continue;
    const existing = members.find((m) => m.name === role);
    if (existing === undefined) {
      members.push({
        name: role,
        role,
        duty: template.duty,
        style: template.style,
        skills: template.skills,
        ...(template.rules !== undefined ? { rules: template.rules } : {}),
        ...(template.personaMd !== undefined ? { personaMd: template.personaMd } : {}),
        avatar: { seed: hashName(role), salt: PRESET_SALTS[role] ?? 0 },
        updatedAt: Date.now(),
      });
      changed = true;
      continue;
    }
    // Backfill / upgrade the role playbook for untouched presets from earlier
    // versions (user-edited personas are never overwritten). staleDistilledDoc
    // detects the short pre-verbatim handbooks so they upgrade to the source.
    if (
      template.personaMd !== undefined &&
      (existing.personaMd === undefined || staleDistilledDoc(existing.personaMd)) &&
      existing.duty === template.duty &&
      existing.style === template.style &&
      existing.skills === template.skills
    ) {
      existing.personaMd = template.personaMd;
      changed = true;
    }
  }
  if (!changed) return;
  const file: RosterFile = { schemaVersion: 1, members };
  await atomicWriteText(rosterFile(stateRoot), `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Detects the short hand-written playbooks from before the verbatim import
 * (they carry 「## 交付标准」 but never the source's 「核心使命」 heading).
 * User-written custom docs rarely match this shape, so they stay untouched.
 */
function staleDistilledDoc(md: string | undefined): boolean {
  return md !== undefined && md.includes('## 交付标准') && !md.includes('核心使命');
}

/**
 * Remove one roster entry by name. The leader (项目牧羊人) is a member too,
 * but it is protected: deletion is rejected (用户模型：领队不可删除).
 */
export async function removeRosterMember(stateRoot: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('成员名不能为空');
  if (trimmed === LEADER_NAME) throw new Error('领队成员不可删除');
  const members = readRoster(stateRoot);
  const next = members.filter((m) => m.name !== trimmed);
  if (next.length === members.length) throw new Error(`成员「${trimmed}」不存在`);
  const file: RosterFile = { schemaVersion: 1, members: next };
  await atomicWriteText(rosterFile(stateRoot), `${JSON.stringify(file, null, 2)}\n`);
}
