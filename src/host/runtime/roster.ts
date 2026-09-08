/**
 * Member roster (D16 → docs/27 v3 roles 表)：工作区级角色库目录（roles 表，
 * 成员=角色全局一份；人设/头像/一句话简介都挂在角色行上，班底经
 * team_members.role_id 松引用引入）。条目带人设框架字段；模型路线不再入
 * 角色库（v3：路线属班底 team_members / 领队行）。v7：工号也挪出角色库
 * ——班底行 team_members 自增主键即工号（表自增），roles.employee_id 列
 * 保留但不读写；roster.json 不再读写（导入走 import.ts）。Pure Node — no
 * cordis.
 *
 * @module dsh-eteams/runtime/roster
 */
import type { PersonaRecord } from '../model/types.js';
import { avatarFromJson, avatarToJson, getDb, hashName, leaderFlagOf, LEADER_NAME, personaFromMd, personaToMd, ROOT_ROLE_NAME, rootFlagOf } from '../state/db.js';
import { ensureWorkspaceReady, seedPresetRows } from '../state/import.js';
import { rolesRowByName, syncTeamMemberRoleMirrorInTx, withTeamTx } from '../state/store.js';
import type { TeamTx } from '../state/store.js';
import { defaultCaptainPersona } from '../prompts/personas/captain.js';
import { fallbackExecutionPrompt, PERSONA_FRAMEWORK_VERSION } from '../prompts/personas/framework.js';
import { PRESET_MEMBER_ROLES, ROLE_TEMPLATES } from '../prompts/personas/presets.js';

/** Stored avatar pair (docs/14): deterministic seed for the SVG renderer. */
export interface AvatarPair {
  seed: number;
  salt: number;
}

/**
 * One reusable role definition (persona framework；成员=角色，全局一份)。
 * v7：工号不在角色库（roles.employee_id 弃用不读写）——班底工号 = 工牌发放处
 * `team_members.team_member_id` 自增主键（表自增）；`employeeId` 字段仅为
 * 旧 roster 文件导入保留的透传入参。
 */
export interface RosterMember {
  /** Unique key across the workspace roster (trimmed, non-empty). */
  name: string;
  /** 【v7 弃用】旧 roster 文件导入透传；角色库不再存工号。 */
  employeeId?: number;
  /** Role label (engineer / researcher / …)，= persona_md 的「角色：」行。 */
  role: string;
  /** 一句话简介（列表卡片与详情头展示；空/缺省=不展示）。 */
  profile?: string;
  /** 领队标识（v8 roles.is_leader）：项目牧羊人=1 其余=0；领队条目按它识别不按名。 */
  isLeader?: boolean;
  /**
   * 主对话注入角色标识（v12 roles.is_root）：保留角色 system=1 其余=0。
   * 它的 personaMd 是注入主对话 system 提示词的原文（默认空），按标识识别
   * 不按名；该角色不可入团/删除/改名。
   */
  isRoot?: boolean;
  /** Persona framework fields (D13) — content is copied on team adoption. */
  duty?: string;
  style?: string;
  skills?: string;
  rules?: string[];
  executionPrompt?: string;
  /** Full Markdown role playbook (agency-agents-zh style) for the detail view. */
  personaMd?: string;
  /** Pre-generated avatar (docs/14 first slice); auto-assigned when absent. */
  avatar?: AvatarPair;
  updatedAt: number;
}

/** Format an 工号 as the display string: 1 → `ET-0001`. */
export function formatEmployeeId(n: number): string {
  return `ET-${String(Math.max(0, Math.floor(n))).padStart(4, '0')}`;
}

/**
 * 任务成员显示标识（v7）：`T{mainTaskId}-ET{工号补零}`（如 `T3-ET0007`）。
 * 任务成员的工牌作用域是任务（副本行 = 工牌），班底成员标识用
 * {@link formatEmployeeId}——同号在任务卡上带任务前缀，同名成员靠号区分。
 */
export function taskMemberBadge(mainTaskId: number, employeeId: number): string {
  return `T${mainTaskId}-ET${String(Math.max(0, Math.floor(employeeId))).padStart(4, '0')}`;
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

/** roles 角色行 → RosterMember（手册全文解析回六字段；profile 列值优先）。
 * v7：roles.employee_id 弃用不读——工号在班底（team_members.employee_id）。
 * v8：is_leader 标识随行读出（项目牧羊人=1）。
 * v12：is_root 行特判——persona_md 是注入主对话的原文（默认空），不经
 * personaFromMd 解析（解析会把无结构标记的原文丢弃、空文回退成烘制脚手架，
 * 编辑回显与再保存都会污染原文），逐字透传。 */
function rowToRosterMember(row: {
  role_name: string;
  persona_md: string | null;
  profile: string | null;
  avatar: string | null;
  is_leader: number;
  is_root: number;
  update_time: number;
}): RosterMember {
  const name = row.role_name;
  if (row.is_root === 1) {
    return {
      name,
      role: name,
      ...(row.profile !== null && row.profile !== '' ? { profile: row.profile } : {}),
      isRoot: true,
      personaMd: row.persona_md ?? '',
      ...(row.avatar !== null ? { avatar: avatarFromJson(row.avatar) } : {}),
      updatedAt: row.update_time,
    };
  }
  const persona = personaFromMd(row.persona_md ?? '', name, name);
  return {
    name,
    role: persona.role,
    // profile 独立成列（v3）：列值优先，旧库烘进手册的 `- 简介：` 行兜底。
    ...(row.profile !== null && row.profile !== ''
      ? { profile: row.profile }
      : persona.profile !== undefined
        ? { profile: persona.profile }
        : {}),
    ...(row.is_leader === 1 ? { isLeader: true } : {}),
    duty: persona.duty,
    style: persona.style,
    skills: persona.skills,
    rules: persona.rules,
    executionPrompt: persona.executionPrompt,
    ...(persona.personaMd !== undefined ? { personaMd: persona.personaMd } : {}),
    ...(row.avatar !== null ? { avatar: avatarFromJson(row.avatar) } : {}),
    updatedAt: row.update_time,
  };
}

/** roles 角色库行的公共 SELECT（成员=角色，全局一份；v7 不读弃用的
 * employee_id 列，v8 读 is_leader 领队标识，v12 读 is_root 注入标识）。 */
const ROSTER_ROW_SQL =
  'SELECT role_name, persona_md, profile, avatar, is_leader, is_root, update_time FROM roles';

/** Read the workspace roster（角色库全表，role_id 升序）. */
export function readRoster(stateRoot: string): RosterMember[] {
  const db = getDb(stateRoot);
  ensureWorkspaceReady(stateRoot, db);
  const rows = db
    .prepare(`${ROSTER_ROW_SQL} ORDER BY role_id`)
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
 * Insert or update one roster entry (roles 角色行，keyed by trimmed name —
 * 成员名=角色名). Returns the stored entry. Throws when name/role are empty
 * after trimming. An entry without an avatar gets one pre-generated here
 * (docs/14 first slice) so every member always has a stable face; updates
 * keep the existing avatar. 角色入库主路径：插库即建角色行（v3）。
 */
export async function upsertRosterMember(
  stateRoot: string,
  member: Omit<RosterMember, 'updatedAt'>,
  options?: { allowLeader?: boolean; allowRoot?: boolean },
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
  // 主对话注入角色（v12）：同理默认拒绝——system 的 persona_md 是注入主
  // 对话的原文，对话流/构建器（eteams_member_save）不许碰；面板显式保存
  // 经 allowRoot 放行（POST /roster）。
  if (name === ROOT_ROLE_NAME && options?.allowRoot !== true) {
    throw new Error('「system」为主对话注入的保留角色，不可通过 upsert 覆盖');
  }
  const stored: RosterMember = await withTeamTx(stateRoot, undefined, (tx) => {
    const db = tx.db;
    const now = tx.now;
    // v7：工号不入角色库（roles.employee_id 弃用）——班底工号 = 工牌发放处
    // team_members 自增主键（表自增，teamOps 建班底行时自然拿到）；角色行只
    // 管人设/头像/简介。更新保留原头像。
    const previous = db
      .prepare(`${ROSTER_ROW_SQL} WHERE role_name = ? LIMIT 1`)
      .get(name) as Parameters<typeof rowToRosterMember>[0] | undefined;
    const previousAvatar =
      previous === undefined || previous.avatar === null
        ? undefined
        : avatarFromJson(previous.avatar);
    const stored: RosterMember = {
      ...member,
      name,
      role,
      // 入库表示不带工号（v7 角色库无工号）：调用方透传的旧字段就地剥离。
      employeeId: undefined,
      avatar: member.avatar ?? previousAvatar ?? {
        seed: hashName(name),
        salt: Math.floor(Math.random() * 1000),
      },
      updatedAt: now,
    };
    const persona = rosterPersona(stored, name);
    // v12：主对话注入角色的 persona_md 存用户编辑的原文（注入内容逐字等
    // 于编辑文本），不烘 personaToMd 结构脚手架。
    const personaMd = name === ROOT_ROLE_NAME ? (member.personaMd ?? '').trim() : personaToMd(persona, name);
    const avatarJson = avatarToJson(stored.avatar);
    const profile = persona.profile ?? null;
    if (previous === undefined) {
      db.prepare(
        'INSERT INTO roles (role_name, persona_md, profile, avatar, is_leader, is_root, created_time, update_time) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(name, personaMd, profile, avatarJson, leaderFlagOf(name), rootFlagOf(name), now, now);
    } else {
      db.prepare(
        'UPDATE roles SET persona_md = ?, profile = ?, avatar = ?, update_time = ? ' +
          'WHERE role_name = ?',
      ).run(personaMd, profile, avatarJson, now, name);
    }
    // v4/v10 副本列刷新：角色行刚落库，team_members 里引用它的班底行镜像
    // （role_name/persona_md/profile/avatar 四列）随之同步
    const roleId = rolesRowByName(db, name)?.role_id;
    syncTeamMemberRoleMirrorInTx(tx, roleId !== undefined ? { roleId } : undefined);
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
 * 主对话注入角色（v12）：同为系统保留成员——按 is_root 标识识别的保留行，
 * 手册(MD)注入主对话 system 提示词；面板可编辑原文（allowRoot），不可入团
 * （teamOps.addMember 拒收）、不可删除、不可改名（保留名）。
 */
export { ROOT_ROLE_NAME };

/**
 * The role-builder persona is a system member too: listed under the leader,
 * protected from deletion (用户反馈：角色构建师不能删除). Unlike the leader
 * it may be edited via upsert (its handbook can evolve).
 */
export const ROLE_BUILDER_NAME = '角色构建师';

/** Names removeRosterMember always rejects (host-side guard). */
const PROTECTED_FROM_DELETE: readonly string[] = [LEADER_NAME, ROLE_BUILDER_NAME, ROOT_ROLE_NAME];

/**
 * Seed the preset members (agency-agents-zh roles, name = role; 2026-09 起
 * 默认仅角色构建师) plus the leader (项目牧羊人) into a workspace roster on
 * first access. Idempotent and non-destructive: existing entries (including
 * user edits to a preset) are never overwritten; only missing presets are
 * inserted. 播种本体在 state/import.ts 的 seedPresetRows（与首启导入同一
 * 事务，保证建库一次成团）；这里只做旧版陈旧手册升级。v7：工号回填循环
 * 已废——角色库不再存工号，班底工号由建队/建任务路径发号。
 */
export async function ensurePresetMembers(stateRoot: string): Promise<void> {
  await withTeamTx(stateRoot, undefined, (tx) => {
    const now = tx.now;
    // 预设播种（幂等：缺才补）在这里再跑一遍——withTeamTx 入口的
    // ensureWorkspaceReady 只在建库/导入首启时播种，此处保证「删库不删
    // member 行」等异常路径下缺失的预置行也能补回。
    seedPresetRows(tx, now);
    const members = readRoster(stateRoot);
    const captain = defaultCaptainPersona();
    // The leader first: it belongs to the member list (用户模型：领队也是成员),
    // is default-joined to every new team as the 团队页 leader card, and is
    // protected from deletion (removeRosterMember rejects it). v8：领队条目按
    // is_leader 标识识别，不按名。
    const leader = members.find((m) => m.isLeader === true);
    if (
      leader !== undefined &&
      captain.personaMd !== undefined &&
      staleDistilledDoc(leader.personaMd) &&
      leader.duty === captain.duty &&
      leader.style === captain.style &&
      leader.skills === captain.skills
    ) {
      upgradePresetHandbook(tx, {
        name: LEADER_NAME,
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
        upgradePresetHandbook(tx, {
          name: role,
          personaMd: template.personaMd,
          now,
        });
      }
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

/** 事务内按名写 roles 角色行手册（陈旧手册升级用，不碰工号/头像）；
 * 写完顺手刷新 team_members 里该角色的副本列（v4 镜像随角色行走）。 */
function upgradePresetHandbook(
  tx: TeamTx,
  patch: { name: string; personaMd: string; now: number },
): void {
  tx.db
    .prepare('UPDATE roles SET persona_md = ?, update_time = ? WHERE role_name = ?')
    .run(patch.personaMd, patch.now, patch.name);
  syncTeamMemberRoleMirrorInTx(tx, { roleId: rolesRowByName(tx.db, patch.name)?.role_id });
}

/**
 * Remove one roster entry by name (v3：删 roles 角色行). The leader
 * (项目牧羊人) and the role builder (角色构建师) are system members and
 * protected: deletion is rejected (用户模型：领队/角色构建师不可删除).
 * v7 班底守卫（R6）：任何 team_members 班底行仍引用该角色（role_id 命中，
 * 含 removed 行——班底是「成员=角色」的花名册，离职行也占位）时拒删，
 * 先从各团队移除成员（removeMember 删班底行）再删角色；task_members 副本
 * 行不挡删除（副本随任务走，任务删除时级联清理）。
 */
export async function removeRosterMember(stateRoot: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('成员名不能为空');
  if (PROTECTED_FROM_DELETE.includes(trimmed)) {
    throw new Error(`「${trimmed}」为系统保留成员，不可删除`);
  }
  withTeamTx(stateRoot, undefined, (tx) => {
    const roleId = rolesRowByName(tx.db, trimmed)?.role_id;
    if (roleId !== undefined) {
      const rostered = tx.db
        .prepare('SELECT COUNT(*) AS n FROM team_members WHERE role_id = ?')
        .get(roleId) as { n: number };
      if (rostered.n > 0) {
        throw new Error(`角色「${trimmed}」仍在团队班底中，先从团队移除再删除`);
      }
    }
    const info = tx.db.prepare('DELETE FROM roles WHERE role_name = ?').run(trimmed);
    if (Number(info.changes) === 0) throw new Error(`成员「${trimmed}」不存在`);
    // 角色删除不进行同步（用户迭代：删除时不动 team_members）——上面的班底
    // 守卫已保证删角色时没有任何班底行引用（引用行须先随 removeMember 移除），
    // 这里本就无行可刷；v4 副本列的悬空 NULL 兜底由读端防御跳过承担。
  });
}
