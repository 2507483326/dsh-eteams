/**
 * Member roster (D16 → docs/27 member/roles 表)：工作区级可复用成员模板目录
 * （member 表 team_id 为空的公共模板行；roles 表存角色定义）。条目带人设
 * 框架字段 + 可选模型路线；团队按名引入并采用其人设。工号发号改为 SQL
 * （member 表最大工号 +1，docs/27），employee-seq.json 计数器文件弃用删除；
 * roster.json 不再读写（导入走 import.ts）。Pure Node — no cordis.
 *
 * @module dsh-eteams/runtime/roster
 */
import type { DatabaseSync } from 'node:sqlite';
import type { PersonaRecord } from '../model/types.js';
import {
  avatarFromJson,
  avatarToJson,
  getDb,
  hashName,
  LEADER_NAME,
  nextEmployeeId,
  personaFromMd,
  personaToMd,
} from '../state/db.js';
import { ensureWorkspaceReady, seedPresetRows } from '../state/import.js';
import { withTeamTx } from '../state/store.js';
import { defaultCaptainPersona } from '../prompts/personas/captain.js';
import { fallbackExecutionPrompt, PERSONA_FRAMEWORK_VERSION } from '../prompts/personas/framework.js';
import { PRESET_MEMBER_ROLES, ROLE_TEMPLATES } from '../prompts/personas/presets.js';

/** Stored avatar pair (docs/14): deterministic seed for the SVG renderer. */
export interface AvatarPair {
  seed: number;
  salt: number;
}

/**
 * One reusable member definition (persona framework + optional route)。
 * `employeeId` 是库里的整数工号（显示补零走 {@link formatEmployeeId}）；
 * 旧版 provider 字段随 docs/35 §3#5 砍掉（provider 由派发时按配置解析）。
 */
export interface RosterMember {
  /** Unique key across the workspace roster (trimmed, non-empty). */
  name: string;
  /**
   * 工号 (employee id, docs/21)：member 表整数工号；undefined = 尚未发号。
   */
  employeeId?: number;
  /** Role label (engineer / researcher / …). Free-form, non-empty. */
  role: string;
  /** 一句话简介（列表卡片与详情头展示；空/缺省=不展示）。 */
  profile?: string;
  /** Persona framework fields (D13) — content is copied on team adoption. */
  duty?: string;
  style?: string;
  skills?: string;
  rules?: string[];
  executionPrompt?: string;
  /** Full Markdown role playbook (agency-agents-zh style) for the detail view. */
  personaMd?: string;
  /** Optional per-member model route, applied when a team adopts the entry. */
  model?: string;
  reasoningEffort?: string;
  /** Pre-generated avatar (docs/14 first slice); auto-assigned when absent. */
  avatar?: AvatarPair;
  updatedAt: number;
}

/** Format an 工号 as the display string: 1 → `ET-0001`. */
export function formatEmployeeId(n: number): string {
  return `ET-${String(Math.max(0, Math.floor(n))).padStart(4, '0')}`;
}

/**
 * Allocate the next 工号 for a workspace (docs/21)：member 表最大工号 +1
 * （docs/27——计数器从库来，employee-seq.json 不再存在）。独立调用只做
 * 「取号」预览；插入成员模板时请在同一事务内用 {@link nextEmployeeIdInTx}
 * 现算现用，避免并发下重号。
 */
export function allocateEmployeeId(stateRoot: string): number {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  return nextEmployeeId(db);
}

/** 事务内取下一个工号（插入成员模板的同步取号路径，docs/35 §2）。 */
export function nextEmployeeIdInTx(db: DatabaseSync): number {
  return nextEmployeeId(db);
}

// --------------------------------------------------------------------------
// 模板行 ↔ RosterMember（persona_md 烘/解 + 两列路线）。
// --------------------------------------------------------------------------

/** RosterMember → PersonaRecord（烘 persona_md 前的内存形状）。 */
function rosterPersona(m: RosterMember, name: string): PersonaRecord {
  const role = m.role.trim() || name;
  return {
    frameworkVersion: PERSONA_FRAMEWORK_VERSION,
    role,
    ...(m.profile !== undefined && m.profile.trim() !== '' ? { profile: m.profile.trim() } : {}),
    duty: m.duty ?? '',
    style: m.style ?? '',
    skills: m.skills ?? '',
    rules: m.rules ?? [],
    ...(m.personaMd !== undefined && m.personaMd !== '' ? { personaMd: m.personaMd } : {}),
    executionPrompt:
      m.executionPrompt !== undefined && m.executionPrompt.trim() !== ''
        ? m.executionPrompt
        : fallbackExecutionPrompt(name, role),
  };
}

/** member 表行 → RosterMember（手册全文解析回六字段）。 */
function rowToRosterMember(row: {
  role_name: string;
  role_label: string | null;
  employee_id: number | null;
  persona_md: string | null;
  model: string | null;
  reasoning_effort: string | null;
  avatar: string | null;
  update_time: number;
}): RosterMember {
  const name = row.role_name;
  const persona = personaFromMd(row.persona_md ?? '', name, row.role_label ?? name);
  return {
    name,
    ...(row.employee_id !== null ? { employeeId: row.employee_id } : {}),
    role: row.role_label ?? name,
    ...(persona.profile !== undefined ? { profile: persona.profile } : {}),
    duty: persona.duty,
    style: persona.style,
    skills: persona.skills,
    rules: persona.rules,
    executionPrompt: persona.executionPrompt,
    ...(persona.personaMd !== undefined ? { personaMd: persona.personaMd } : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.reasoning_effort !== null ? { reasoningEffort: row.reasoning_effort } : {}),
    ...(row.avatar !== null ? { avatar: avatarFromJson(row.avatar) } : {}),
    updatedAt: row.update_time,
  };
}

/** 公共模板行的公共 SELECT（roles 左联出角色标签）。 */
const ROSTER_ROW_SQL =
  'SELECT m.role_name, r.role_name AS role_label, m.employee_id, m.persona_md, m.model, ' +
  'm.reasoning_effort, m.avatar, m.update_time FROM member m ' +
  'LEFT JOIN roles r ON r.role_id = m.role_id WHERE m.team_id IS NULL';

/** Read the workspace roster（公共模板行，member_id 升序）. */
export function readRoster(stateRoot: string): RosterMember[] {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const rows = db
    .prepare(`${ROSTER_ROW_SQL} ORDER BY m.member_id`)
    .all() as Array<Parameters<typeof rowToRosterMember>[0]>;
  return rows.map(rowToRosterMember);
}

/** Find one roster entry by exact name. */
export function findRosterMember(stateRoot: string, name: string): RosterMember | undefined {
  return readRoster(stateRoot).find((m) => m.name === name);
}

/** Public avatar-seed helper (captain card in the snapshot reuses it). */
export function avatarSeedFor(name: string): number {
  return hashName(name);
}

// --------------------------------------------------------------------------
// 写路径（upsert / remove / 预设播种），统一走 withTeamTx 同步事务。
// --------------------------------------------------------------------------

/**
 * Insert or update one roster entry (keyed by trimmed name). Returns the
 * stored entry. Throws when name/role are empty after trimming. An entry
 * without an avatar gets one pre-generated here (docs/14 first slice) so
 * every member always has a stable face; updates keep the existing avatar.
 * `roles` 表缺角色行时顺带补上（role_id 需要落到它上面）。
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
  const stored: RosterMember = await withTeamTx(stateRoot, undefined, (tx) => {
    const db = tx.db;
    const now = tx.now;
    // 工号（docs/21）：新建时从 member 表最大工号 +1 分配；更新保留原号。
    // 调用方显式传入（导入/迁移）时尊重传入值（0 视同未传）。
    const previous = db
      .prepare(`${ROSTER_ROW_SQL} AND m.role_name = ? LIMIT 1`)
      .get(name) as Parameters<typeof rowToRosterMember>[0] | undefined;
    const employeeId =
      (typeof member.employeeId === 'number' && member.employeeId > 0
        ? member.employeeId
        : undefined) ??
      previous?.employee_id ??
      nextEmployeeId(db);
    const previousAvatar =
      previous === undefined || previous.avatar === null
        ? undefined
        : avatarFromJson(previous.avatar);
    const stored: RosterMember = {
      ...member,
      name,
      role,
      employeeId,
      avatar: member.avatar ?? previousAvatar ?? {
        seed: hashName(name),
        salt: Math.floor(Math.random() * 1000),
      },
      updatedAt: now,
    };
    // roles 行（角色标签的登记处）缺则补空定义，保证 role_id 可落；内容
    // 一律烘在 member.persona_md（docs/27：roles 只留角色名/手册/头像）。
    let roleId: number;
    const roleRow = db.prepare('SELECT role_id FROM roles WHERE role_name = ?').get(role) as
      | { role_id: number }
      | undefined;
    if (roleRow !== undefined) {
      roleId = roleRow.role_id;
    } else {
      roleId = Number(
        db
          .prepare(
            "INSERT INTO roles (role_name, source, created_time, update_time) " +
              "VALUES (?, 'user', ?, ?)",
          )
          .run(role, now, now).lastInsertRowid,
      );
    }
    const persona = rosterPersona(stored, name);
    const personaMd = personaToMd(persona, name);
    const avatarJson = avatarToJson(stored.avatar);
    if (previous === undefined) {
      db.prepare(
        'INSERT INTO member (team_id, role_name, employee_id, persona_md, model, ' +
          'reasoning_effort, avatar, role_id, created_time, update_time) ' +
          'VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(name, employeeId, personaMd, stored.model ?? null, stored.reasoningEffort ?? null,
        avatarJson, roleId, now, now);
    } else {
      db.prepare(
        'UPDATE member SET employee_id = ?, persona_md = ?, model = ?, reasoning_effort = ?, ' +
          'avatar = ?, role_id = ?, update_time = ? WHERE team_id IS NULL AND role_name = ?',
      ).run(employeeId, personaMd, stored.model ?? null, stored.reasoningEffort ?? null,
        avatarJson, roleId, now, name);
    }
    return stored;
  });
  return stored;
}

/**
 * The team leader is itself a preset member: default-joined, undeletable.
 * 保留名常量自 db.js（store/events/import/roster 共用，docs/35 §6）。
 */
export { LEADER_NAME };

/**
 * The role-builder persona is a system member too: listed under the leader,
 * protected from deletion (用户反馈：角色构建师不能删除). Unlike the leader
 * it may be edited via upsert (its handbook can evolve).
 */
export const ROLE_BUILDER_NAME = '角色构建师';

/** Names removeRosterMember always rejects (host-side guard). */
const PROTECTED_FROM_DELETE: readonly string[] = [LEADER_NAME, ROLE_BUILDER_NAME];

/**
 * Seed the preset members (agency-agents-zh roles, name = role; 2026-09 起
 * 默认仅角色构建师) plus the leader (项目牧羊人) into a workspace roster on
 * first access. Idempotent and non-destructive: existing entries (including
 * user edits to a preset) are never overwritten; only missing presets are
 * inserted. 播种本体在 state/import.ts 的 seedPresetRows（与首启导入同一
 * 事务，保证建库一次成团）；这里只做旧版陈旧手册升级 + 工号回填。
 */
export async function ensurePresetMembers(stateRoot: string): Promise<void> {
  await withTeamTx(stateRoot, undefined, (tx) => {
    const db = tx.db;
    const now = tx.now;
    // 预设播种（幂等：缺才补）在这里再跑一遍——withTeamTx 入口的
    // ensureWorkspaceReady 只在建库/导入首启时播种，此处保证「删库不删
    // member 行」等异常路径下缺失的预置行也能补回。
    seedPresetRows(tx, now);
    const members = readRoster(stateRoot);
    const captain = defaultCaptainPersona();
    // The leader first: it belongs to the member list (用户模型：领队也是成员),
    // is default-joined to every new team as the 团队页 leader card, and is
    // protected from deletion (removeRosterMember rejects it).
    const leader = members.find((m) => m.name === LEADER_NAME);
    if (
      leader !== undefined &&
      captain.personaMd !== undefined &&
      staleDistilledDoc(leader.personaMd) &&
      leader.duty === captain.duty &&
      leader.style === captain.style &&
      leader.skills === captain.skills
    ) {
      upgradePresetHandbook(db, {
        name: LEADER_NAME,
        role: leader.role,
        personaMd: captain.personaMd,
        now,
      });
    }
    for (const role of PRESET_MEMBER_ROLES) {
      const template = ROLE_TEMPLATES[role];
      if (template === undefined) continue;
      const existing = members.find((m) => m.name === role);
      // Backfill / upgrade the role playbook for untouched presets from earlier
      // versions (user-edited personas are never overwritten). staleDistilledDoc
      // detects the short pre-verbatim handbooks so they upgrade to the source.
      if (
        existing !== undefined &&
        template.personaMd !== undefined &&
        (existing.personaMd === undefined || staleDistilledDoc(existing.personaMd)) &&
        existing.duty === template.duty &&
        existing.style === template.style &&
        existing.skills === template.skills
      ) {
        upgradePresetHandbook(db, {
          name: role,
          role: existing.role,
          personaMd: template.personaMd,
          now,
        });
      }
    }
    // 工号回填（docs/21）：补齐所有缺号的成员（含旧版入库的非预设成员），
    // 顺序按 member_id 逐行取 member 表最大工号 +1。
    const rows = db
      .prepare('SELECT member_id FROM member WHERE employee_id IS NULL ORDER BY member_id')
      .all() as Array<{ member_id: number }>;
    for (const row of rows) {
      db.prepare('UPDATE member SET employee_id = ?, update_time = ? WHERE member_id = ?').run(
        nextEmployeeId(db),
        now,
        row.member_id,
      );
    }
  });
}

/**
 * Detects the short hand-written playbooks from before the verbatim import
 * (they carry 「## 交付标准」 but never the source's 「核心使命」 heading).
 * User-written custom docs rarely match this shape, so they stay untouched.
 */
function staleDistilledDoc(md: string | undefined): boolean {
  return md !== undefined && md.includes('## 交付标准') && !md.includes('核心使命');
}

/** 事务内按名写公共模板行（陈旧手册升级用，不碰工号/头像/模型）。 */
function upgradePresetHandbook(
  db: DatabaseSync,
  patch: { name: string; role: string; personaMd: string; now: number },
): void {
  const roleIdRow = db.prepare('SELECT role_id FROM roles WHERE role_name = ?').get(patch.role) as
    | { role_id: number }
    | undefined;
  if (roleIdRow === undefined) return;
  db.prepare(
    'UPDATE member SET persona_md = ?, role_id = ?, update_time = ? ' +
      'WHERE team_id IS NULL AND role_name = ?',
  ).run(patch.personaMd, roleIdRow.role_id, patch.now, patch.name);
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
  withTeamTx(stateRoot, undefined, (tx) => {
    const info = tx.db
      .prepare('DELETE FROM member WHERE team_id IS NULL AND role_name = ?')
      .run(trimmed);
    if (Number(info.changes) === 0) throw new Error(`成员「${trimmed}」不存在`);
  });
}
