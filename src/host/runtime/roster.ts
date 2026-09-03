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
  /**
   * 工号 (employee id, docs/21): `ET-0001` style, allocated from the
   * workspace counter on first save and stable afterwards. Optional for
   * legacy entries; {@link ensureRosterEmployeeIds} backfills them.
   */
  employeeId?: string;
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

/** Workspace-level 工号 counter file (docs/21): one monotonic sequence. */
interface EmployeeSeqFile {
  schemaVersion: 1;
  seq: number;
}

/** Absolute 工号 counter path for a state root. */
function employeeSeqFile(stateRoot: string): string {
  return join(stateRoot, 'employee-seq.json');
}

/** Read the persisted 工号 counter; missing or malformed file yields 0. */
function readEmployeeSeq(stateRoot: string): number {
  const file = employeeSeqFile(stateRoot);
  if (!existsSync(file)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<EmployeeSeqFile>;
    return typeof parsed.seq === 'number' && Number.isFinite(parsed.seq) && parsed.seq >= 0
      ? Math.floor(parsed.seq)
      : 0;
  } catch {
    return 0;
  }
}

/** Format a counter value as an 工号: 1 → `ET-0001`. */
export function formatEmployeeId(n: number): string {
  return `ET-${String(Math.max(0, Math.floor(n))).padStart(4, '0')}`;
}

/**
 * Allocate the next 工号 for a workspace (docs/21): bump the persisted
 * monotonic counter and return the formatted id (`ET-0001` style). The
 * counter lives next to roster.json so roster saves, role-builder confirms
 * and direct team adds all draw from the same sequence — no collisions.
 */
export async function allocateEmployeeId(stateRoot: string): Promise<string> {
  const seq = readEmployeeSeq(stateRoot) + 1;
  await atomicWriteText(
    employeeSeqFile(stateRoot),
    `${JSON.stringify({ schemaVersion: 1, seq } satisfies EmployeeSeqFile, null, 2)}\n`,
  );
  return formatEmployeeId(seq);
}

/**
 * Backfill 工号 in place on the given member list (docs/21). Returns whether
 * anything changed so callers can skip the rewrite. Existing 工号s are never
 * touched; the counter only moves forward.
 */
async function ensureEmployeeIdsIn(
  members: RosterMember[],
  stateRoot: string,
): Promise<boolean> {
  let changed = false;
  for (const m of members) {
    if (typeof m.employeeId === 'string' && m.employeeId !== '') continue;
    m.employeeId = await allocateEmployeeId(stateRoot);
    changed = true;
  }
  return changed;
}

/**
 * Backfill 工号 for every roster member missing one (docs/21) and persist
 * the roster when anything changed. Existing 工号s are never touched.
 */
export async function ensureRosterEmployeeIds(stateRoot: string): Promise<boolean> {
  const members = readRoster(stateRoot);
  if (!(await ensureEmployeeIdsIn(members, stateRoot))) return false;
  const file: RosterFile = { schemaVersion: 1, members };
  await atomicWriteText(rosterFile(stateRoot), `${JSON.stringify(file, null, 2)}\n`);
  return true;
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
  options?: { allowLeader?: boolean },
): Promise<RosterMember> {
  const name = member.name.trim();
  const role = member.role.trim();
  if (name === '') throw new Error('成员名不能为空');
  if (role === '') throw new Error('角色不能为空');
  // 领队保留名（docs/19.10）：removeRosterMember 拒删；upsert 默认同样拒绝
  // 覆盖，防止对话流/构建器写路径意外改写领队人设。面板的显式编辑（用户
  // 迭代 2026-09-03「项目牧羊人也可以编辑」）经 allowLeader 放行——用户
  // 主动保存与成员详情「同步到该角色」走这条路，代理侧写路径保持拒绝。
  if (name === LEADER_NAME && options?.allowLeader !== true) {
    throw new Error('领队成员为保留名，不可通过 upsert 覆盖');
  }
  const members = readRoster(stateRoot);
  const previous = members.find((m) => m.name === name);
  // 工号（docs/21）：新建时从工作区计数器分配；更新保留原号。调用方显式
  // 传入（导入/迁移）时尊重传入值（空串视同未传）。
  const employeeId =
    (typeof member.employeeId === 'string' && member.employeeId !== ''
      ? member.employeeId
      : undefined) ??
    previous?.employeeId ??
    (await allocateEmployeeId(stateRoot));
  const stored: RosterMember = {
    ...member,
    name,
    role,
    employeeId,
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

/**
 * The role-builder persona is a system member too: listed under the leader,
 * protected from deletion (用户反馈：角色构建师不能删除). Unlike the leader
 * it may be edited via upsert (its handbook can evolve).
 */
export const ROLE_BUILDER_NAME = '角色构建师';

/** Names removeRosterMember always rejects (host-side guard). */
const PROTECTED_FROM_DELETE: readonly string[] = [LEADER_NAME, ROLE_BUILDER_NAME];

/** Fixed salts so the preset members look the same in every workspace. */
const PRESET_SALTS: Record<string, number> = {
  角色构建师: 67,
};

/**
 * Seed the preset members (agency-agents-zh roles, name = role; 2026-09 起
 * 默认仅角色构建师) plus the leader (项目牧羊人) into a workspace roster on
 * first access. Idempotent and non-destructive: existing entries (including
 * user edits to a preset) are never overwritten; only missing presets are
 * inserted.
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
  // 工号回填（docs/21）：补齐所有缺号的成员（含旧版入库的非预设成员），
  // 与本次插入在同一份内存列表上完成后一次写盘。
  if (await ensureEmployeeIdsIn(members, stateRoot)) changed = true;
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
 * Remove one roster entry by name. The leader (项目牧羊人) and the role
 * builder (角色构建师) are system members and protected: deletion is
 * rejected (用户模型：领队/角色构建师不可删除).
 */
export async function removeRosterMember(stateRoot: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('成员名不能为空');
  if (PROTECTED_FROM_DELETE.includes(trimmed)) {
    throw new Error(`「${trimmed}」为系统保留成员，不可删除`);
  }
  const members = readRoster(stateRoot);
  const next = members.filter((m) => m.name !== trimmed);
  if (next.length === members.length) throw new Error(`成员「${trimmed}」不存在`);
  const file: RosterFile = { schemaVersion: 1, members: next };
  await atomicWriteText(rosterFile(stateRoot), `${JSON.stringify(file, null, 2)}\n`);
}
