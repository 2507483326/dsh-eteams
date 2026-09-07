/**
 * 首次启动导入器（docs/35 §6、docs/36 建议 6）：库里还没有 db_schema_version
 * 时，若工作区仍存在旧文件布局（各团队目录的 team.json / events.jsonl /
 * inbox、工作区 roster.json）就在一个事务里整库导入；旧文件不存在则空库
 * 起步。两条路都以 roles 角色库行收尾并写版本号；已有版本号
 * 直接返回（重启不重复导入）。旧文件导入后停读写、原样保留作备份
 * （docs/35 §3#1），本层不删除、不改写它们。
 *
 * 换算细则（docs/36 建议 6）：t1/a1/d1 文本号按映射换整数号（正文不换）；
 * events/inbox 的 per-team seq 丢弃换全库号；inbox 文件名 → box_key、
 * MailMessage.id 原样保留为 message_id；存量任务目录按字面路径进
 * task.work_dir（旧目录不迁移）；archive/ 目录跳过；工号 `ET-0001` → 整数
 * （v7 表自增：按名重键——班底行落库拿到新自增号后，副本/邮箱/链站点按
 * 名字 join 换到新号）；
 * employee-seq.json 不导入。
 *
 * @module dsh-eteams/state/import
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { contractMdFromLegacyArrays } from '../model/contract.js';
import { sanitizeKey } from '../model/taskMachine.js';
import type {
  Actor,
  AvatarRecord,
  EventRecord,
  MailKind,
  MailMessage,
  MemberStatus,
  PersonaRecord,
  TaskMemberRecord,
} from '../model/types.js';
import {
  avatarToJson,
  hashName,
  leaderFlagOf,
  LEADER_NAME,
  personaToMd,
  readSchemaVersion,
  writeSchemaVersion,
} from './db.js';
import { insertEventInTx, insertMailInTx, parseJsonl } from './events.js';
import {
  ensureRolesRowInTx,
  insertTaskMemberRow,
  rolesRowByName,
  syncTeamMemberRoleMirrorInTx,
} from './store.js';
import type { TeamTx } from './store.js';
import { defaultCaptainPersona } from '../prompts/personas/captain.js';
import { fallbackExecutionPrompt, PERSONA_FRAMEWORK_VERSION } from '../prompts/personas/framework.js';
import { defaultPersonaFor, PRESET_MEMBER_ROLES, ROLE_TEMPLATES } from '../prompts/personas/presets.js';

// --------------------------------------------------------------------------
// 旧版文件模型（docs/05：13 态 + 文本号 + provider 路线）——仅导入用。
// --------------------------------------------------------------------------

interface LegacyModelRoute {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  source?: 'inherited' | 'override';
}

interface LegacyPersona {
  role?: string;
  duty?: string;
  style?: string;
  skills?: string;
  rules?: string[];
  executionPrompt?: string;
  personaMd?: string;
}

interface LegacyMember {
  /** 旧语义：成员的持续子会话 id（'' = staged 未起会话）。 */
  id?: string;
  name: string;
  employeeId?: string;
  role: string;
  persona?: LegacyPersona;
  modelRoute?: LegacyModelRoute;
  status?: string;
  avatar?: { seed: number; salt: number; updatedAt?: number };
  createdAt?: number;
}

interface LegacyAttempt {
  id?: string;
  taskId?: string;
  kind?: string;
  member?: string;
  status?: string;
  token?: string;
  stationIndex?: number;
  createdAt?: number;
  claimedAt?: number;
  endedAt?: number;
  progress?: Array<{ at: number; text: string }>;
  result?: { output?: string; changedPaths?: string[] };
  error?: string;
}

interface LegacyTask {
  id: string;
  subject: string;
  kind?: 'group' | 'task';
  parentId?: string;
  description?: string;
  /** 旧合同四数组（十六轮 DA29 已合并为 contractMd 单字段；导入时合成回填）。 */
  acceptance?: string[];
  inScope?: string[];
  outOfScope?: string[];
  deliverables?: string[];
  /** 合同 MD 全文（v2 导出格式；与四数组并存时优先）。 */
  contractMd?: string;
  idempotencyNote?: string;
  dependencies?: string[];
  chain?: Array<{ member: string; stageBrief: string }>;
  chainCursor?: number;
  status: string;
  assignee?: string;
  attempts?: LegacyAttempt[];
  retryCount?: number;
  blockedFrom?: string;
  suspendNote?: string;
  createdAt?: number;
  updatedAt?: number;
  completedAt?: number;
}

interface LegacyDecision {
  id: string;
  taskId: string;
  attemptId?: string;
  error?: string;
  retryCount?: number;
  status?: 'open' | 'resolved';
  createdAt?: number;
  resolvedAt?: number;
  choice?: string;
  note?: string;
}

interface LegacyTeam {
  id?: string;
  name?: string;
  captainSessionId?: string;
  captainChildId?: string;
  leaderRemoved?: boolean;
  workDir?: string;
  createdAt?: number;
  updatedAt?: number;
  members?: LegacyMember[];
  tasks?: LegacyTask[];
  pendingDecisions?: LegacyDecision[];
}

interface LegacyEvent {
  at?: number;
  actor?: Actor;
  type?: string;
  taskId?: string;
  attemptId?: string;
  payload?: Record<string, unknown>;
}

interface LegacyMail {
  id?: string;
  at?: number;
  from?: Actor;
  to?: Actor;
  kind?: string;
  taskId?: string;
  attemptId?: string;
  content?: string;
  readAt?: number;
}

interface LegacyRosterMember {
  name: string;
  employeeId?: string;
  role?: string;
  duty?: string;
  style?: string;
  skills?: string;
  rules?: string[];
  executionPrompt?: string;
  personaMd?: string;
  model?: string;
  reasoningEffort?: string;
  avatar?: { seed: number; salt: number; updatedAt?: number };
  updatedAt?: number;
}

// --------------------------------------------------------------------------
// 旧值换算助手。
// --------------------------------------------------------------------------

/** `t12` / `a3` / `d7` → 整数；非标准号返回 undefined（按序补号兜底）。 */
function parseLegacyId(raw: string | undefined, prefix: string): number | undefined {
  if (raw === undefined) return undefined;
  const match = new RegExp(`^${prefix}(\\d+)$`).exec(raw.trim());
  const n = match !== null ? Number(match[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** 旧 13 态 → 新 10 态（docs/35 §4 映射方案 A）。 */
const LEGACY_STATUS_MAP: Record<string, string> = {
  draft: 'draft',
  ready: 'ready',
  assigned: 'wait',
  in_progress: 'start',
  retrying: 'wait',
  paused: 'paused',
  awaiting_decision: 'wait_decision',
  needs_user: 'wait_user',
  suspended: 'paused',
  blocked: 'wait',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

function mapLegacyStatus(status: string | undefined, fallback: string): string {
  if (status === undefined) return fallback;
  return LEGACY_STATUS_MAP[status] ?? fallback;
}

/** 旧六字段/PersonaRecord 混合体 → 现行 PersonaRecord（烘库前的内存形状）。 */
function personaFromFields(
  fields: LegacyPersona,
  name: string,
  role: string,
): PersonaRecord {
  const executionPrompt =
    fields.executionPrompt !== undefined && fields.executionPrompt.trim() !== ''
      ? fields.executionPrompt
      : fallbackExecutionPrompt(name, role);
  return {
    frameworkVersion: PERSONA_FRAMEWORK_VERSION,
    role: fields.role ?? role,
    duty: fields.duty ?? '',
    style: fields.style ?? '',
    skills: fields.skills ?? '',
    rules: fields.rules ?? [],
    ...(fields.personaMd !== undefined && fields.personaMd !== ''
      ? { personaMd: fields.personaMd }
      : {}),
    executionPrompt,
  };
}

/** 旧任务目录 slug：`t3-login`（docs/36 建议 6：字面路径，不改名迁移）。 */
function legacyTaskSlug(id: number, subject: string): string {
  return `t${id}-${sanitizeKey(subject).slice(0, 40)}`;
}

/** 旧目录布局的任务工作目录：tasks/tN-slug，小任务挂父目录 sub/ 下。 */
function legacyTaskDir(
  base: string,
  task: LegacyTask,
  id: number,
  parentId: number | null,
  parentSubject: string | undefined,
): string {
  if (parentId !== null && parentSubject !== undefined) {
    return `${base}/tasks/${legacyTaskSlug(parentId, parentSubject)}/sub/${legacyTaskSlug(id, task.subject)}`;
  }
  return `${base}/tasks/${legacyTaskSlug(id, task.subject)}`;
}

// --------------------------------------------------------------------------
// 预置种子：roles 角色库行（领队 + 预置角色；docs/36 建议 6「roster.ts:238
// 逻辑平移」——建库/导入同一事务收尾时写入，幂等）。
// --------------------------------------------------------------------------

/** Preset avatar salts so the presets look the same in every workspace. */
const PRESET_SALTS: Record<string, number> = {
  角色构建师: 67,
};

/** One preset role to seed into the workspace 角色库. */
export interface PresetMemberSeed {
  name: string;
  role: string;
  persona: PersonaRecord;
  avatar: AvatarRecord;
}

/** The preset roles（领队 + PRESET_MEMBER_ROLES；名字即角色）。 */
export function presetMemberSeeds(): PresetMemberSeed[] {
  const captain = defaultCaptainPersona();
  const seeds: PresetMemberSeed[] = [
    {
      name: LEADER_NAME,
      role: captain.role,
      persona: captain,
      avatar: { seed: hashName(LEADER_NAME), salt: 7 },
    },
  ];
  for (const role of PRESET_MEMBER_ROLES) {
    if (ROLE_TEMPLATES[role] === undefined) continue;
    seeds.push({
      name: role,
      role,
      persona: defaultPersonaFor(role, role),
      avatar: { seed: hashName(role), salt: PRESET_SALTS[role] ?? 0 },
    });
  }
  return seeds;
}

/**
 * 首次建库/导入事务的收尾种子（幂等）：领队/预置角色的 roles 角色行
 * （缺则建，已有同名行不覆盖——成员=角色，全局一份）。v7：角色行不带工号
 * （工牌发放在各队班底行上）；一句话简介入 profile 列（v3）。
 */
export function seedPresetRows(tx: TeamTx, now: number): void {
  const { db } = tx;
  const selectRole = db.prepare('SELECT role_id FROM roles WHERE role_name = ?');
  const insertRole = db.prepare(
    'INSERT INTO roles (role_name, persona_md, profile, avatar, is_leader, created_time, update_time) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const seed of presetMemberSeeds()) {
    if (selectRole.get(seed.name) !== undefined) continue;
    insertRole.run(
      seed.name,
      personaToMd(seed.persona, seed.name),
      seed.persona.profile ?? null,
      avatarToJson(seed.avatar),
      leaderFlagOf(seed.name),
      now,
      now,
    );
  }
}

// --------------------------------------------------------------------------
// 首次启动判断与入口：ensureWorkspaceReady（store/events/roster 各入口调用）。
// --------------------------------------------------------------------------

/** 旧布局探测：工作区 roster.json 或任一团队目录的 team.json。 */
function hasLegacyFiles(stateRoot: string): boolean {
  if (!existsSync(stateRoot)) return false;
  if (existsSync(join(stateRoot, 'roster.json'))) return true;
  try {
    for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // archive/（归档不导入，docs/36 建议 6）/ corrupt/ / 本层的 db/ 不算团队
      if (entry.name === 'archive' || entry.name === 'corrupt' || entry.name === 'db') continue;
      if (existsSync(join(stateRoot, entry.name, 'team.json'))) return true;
    }
  } catch {
    return false; // 状态根不可读按空库起步处理
  }
  return false;
}

/**
 * 保证该状态根的库已就绪（DDL 建表已完成；版本号已写；旧文件已导入或判定
 * 为空库起步）。幂等且廉价——已有版本号时只是一条 SELECT。自身开事务，
 * 调用方不得处于 withTeamTx 之内（withTeamTx 在 BEGIN 之前调用本函数，
 * 天然满足）。
 */
export function ensureWorkspaceReady(stateRoot: string, db: DatabaseSync): void {
  if (readSchemaVersion(db) !== undefined) return;
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    // 双检：并发进程可能已在本线程 BEGIN 前完成导入
    if (readSchemaVersion(db) !== undefined) {
      db.exec('ROLLBACK');
      return;
    }
    if (hasLegacyFiles(stateRoot)) importLegacyWorkspace(stateRoot, db);
    seedPresetRows({ db, now }, now);
    writeSchemaVersion(db, now);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 事务已自动回滚：清理动作本身失败不必掩盖原异常
    }
    throw error;
  }
}

// --------------------------------------------------------------------------
// 旧文件导入：roster.json → 角色库行；各团队目录 → team 行 + 班底/实例行
// + 任务/尝试/决策 + 事件 + 邮箱，全部在调用方（ensureWorkspaceReady）的
// 同一个事务里完成。
// --------------------------------------------------------------------------

/** roster.json → 角色库行（roles，按名入库）；返回原条目供班底复用工号。 */
function importRosterFile(db: DatabaseSync, stateRoot: string, now: number): LegacyRosterMember[] {
  const file = join(stateRoot, 'roster.json');
  if (!existsSync(file)) return [];
  let parsed: { members?: LegacyRosterMember[] };
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as { members?: LegacyRosterMember[] };
  } catch {
    return []; // 损坏的 roster 跳过，预置种子仍会补齐领队/角色构建师
  }
  const members = Array.isArray(parsed.members) ? parsed.members : [];
  for (const m of members) {
    if (typeof m.name !== 'string' || m.name.trim() === '') continue;
    const name = m.name.trim();
    const role = (m.role ?? name).trim() || name;
    const persona = personaFromFields(m, name, role);
    // 同名角色行已存在则跳过（幂等；不覆盖已有角色定义）。
    // v7：角色行不带工号——旧 roster 工号只随返回值留给班底发号参考。
    if (rolesRowByName(db, name) !== undefined) continue;
    db.prepare(
      'INSERT INTO roles (role_name, persona_md, profile, avatar, created_time, update_time) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      name,
      personaToMd(persona, name),
      persona.profile ?? null,
      avatarToJson(m.avatar ?? { seed: hashName(name), salt: 0 }),
      m.updatedAt ?? now,
      now,
    );
  }
  return members;
}

/** 各团队目录名（排除归档/损坏目录与库目录；archive/ 跳过不导入）。 */
function legacyTeamDirs(stateRoot: string): string[] {
  const dirs: string[] = [];
  for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'archive' || entry.name === 'corrupt' || entry.name === 'db') continue;
    if (existsSync(join(stateRoot, entry.name, 'team.json'))) dirs.push(entry.name);
  }
  return dirs;
}

/** 整库导入（同一事务内被 ensureWorkspaceReady 调用）。 */
function importLegacyWorkspace(stateRoot: string, db: DatabaseSync): void {
  const now = Date.now();
  const roster = importRosterFile(db, stateRoot, now);
  for (const dir of legacyTeamDirs(stateRoot)) {
    importLegacyTeam(db, stateRoot, dir, roster, now);
  }
}

// --------------------------------------------------------------------------
// 单团队导入：team 行 → 班底/实例行 → 任务/尝试 → 决策 → 事件 → 邮箱。
// --------------------------------------------------------------------------

/** 旧文本号映射表（t1/a1/d1 → 整数，docs/36 建议 6）。 */
interface LegacyIdMaps {
  task: Map<string, number>;
  attempt: Map<string, number>;
  decision: Map<string, number>;
}

/**
 * 定号策略：先按旧文本号里的数字取号（面板「任务 #N」与旧目录 tN 同号），
 * 非标准号再按序补号；同类号码冲突时后者按序顺延。
 */
function buildIdMaps(tasks: LegacyTask[], decisions: LegacyDecision[]): LegacyIdMaps {
  const task = new Map<string, number>();
  const attempt = new Map<string, number>();
  const decision = new Map<string, number>();
  let maxTask = 0;
  for (const t of tasks) {
    const parsed = parseLegacyId(t.id, 't');
    if (parsed !== undefined && !task.has(t.id)) {
      task.set(t.id, parsed);
      maxTask = Math.max(maxTask, parsed);
    }
  }
  for (const t of tasks) {
    if (!task.has(t.id)) {
      maxTask += 1;
      task.set(t.id, maxTask);
    }
  }
  let maxAttempt = 0;
  for (const t of tasks) {
    for (const a of t.attempts ?? []) {
      if (a.id === undefined) continue;
      const parsed = parseLegacyId(a.id, 'a');
      if (parsed !== undefined && !attempt.has(a.id)) {
        attempt.set(a.id, parsed);
        maxAttempt = Math.max(maxAttempt, parsed);
      }
    }
  }
  for (const t of tasks) {
    for (const a of t.attempts ?? []) {
      if (a.id === undefined || attempt.has(a.id)) continue;
      maxAttempt += 1;
      attempt.set(a.id, maxAttempt);
    }
  }
  let maxDecision = 0;
  for (const d of decisions) {
    const parsed = parseLegacyId(d.id, 'd');
    if (parsed !== undefined && !decision.has(d.id)) {
      decision.set(d.id, parsed);
      maxDecision = Math.max(maxDecision, parsed);
    }
  }
  for (const d of decisions) {
    if (decision.has(d.id)) continue;
    maxDecision += 1;
    decision.set(d.id, maxDecision);
  }
  return { task, attempt, decision };
}

/** 旧文本号换算（先任务号再尝试/决策号；未命中原样保留）。 */
function mapLegacyRef(
  raw: string,
  maps: LegacyIdMaps,
): string | number {
  return maps.task.get(raw) ?? maps.attempt.get(raw) ?? maps.decision.get(raw) ?? raw;
}

/**
 * payload 里的旧文本号换算（docs/36 建议 6）：taskId/attemptId/decisionId
 * 是文本号键；cascade/children（及防御性的 taskIds/attemptIds/deps）是
 * 文本号数组键。正文（notes/汇报等自由文本）一律不换算。
 */
function mapLegacyPayload(
  payload: Record<string, unknown> | undefined,
  maps: LegacyIdMaps,
): Record<string, unknown> | undefined {
  if (payload === undefined) return undefined;
  const mapOne = (raw: string): string | number => mapLegacyRef(raw, maps);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (
      (key === 'taskId' || key === 'attemptId' || key === 'decisionId' || key === 'parentTaskId') &&
      typeof value === 'string'
    ) {
      out[key] = mapOne(value);
      continue;
    }
    if (
      (key === 'cascade' || key === 'children' || key === 'taskIds' || key === 'attemptIds' || key === 'deps') &&
      Array.isArray(value)
    ) {
      out[key] = value.map((v) => (typeof v === 'string' ? mapOne(v) : v));
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** 成员状态原样收敛（非法值回 ready）。 */
function mapMemberStatus(status: string | undefined): MemberStatus {
  return status === 'staged' || status === 'working' || status === 'paused' || status === 'removed'
    ? status
    : 'ready';
}

/** 邮件类型收敛（未知类型回 notice）。 */
function mapMailKind(kind: string | undefined): MailKind {
  return kind === 'assignment' || kind === 'report' || kind === 'question' || kind === 'user_message'
    ? kind
    : 'notice';
}

/**
 * 实例行锚定（docs/35 §5#12）：取该成员最近活跃任务的根大任务。旧数据
 * 每人只有一个子会话，导入为一行（锚在最近任务上）；其余大任务的实例行
 * 由波次 2 首派时按链补建。
 */
function anchorTaskOf(
  tasks: LegacyTask[],
  memberName: string,
  maps: LegacyIdMaps,
): { taskId: number; rootId: number } | undefined {
  let best: LegacyTask | undefined;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const t of tasks) {
    const involved =
      t.assignee === memberName || (t.attempts ?? []).some((a) => a.member === memberName);
    if (!involved) continue;
    const at = t.updatedAt ?? t.createdAt ?? 0;
    if (at >= bestAt) {
      bestAt = at;
      best = t;
    }
  }
  if (best === undefined) return undefined;
  const taskId = maps.task.get(best.id);
  if (taskId === undefined) return undefined;
  let root: LegacyTask = best;
  const seen = new Set<string>();
  while (root.parentId !== undefined && !seen.has(root.parentId)) {
    seen.add(root.parentId);
    const parent = tasks.find((t) => t.id === root.parentId);
    if (parent === undefined) break;
    root = parent;
  }
  return { taskId, rootId: maps.task.get(root.id) ?? taskId };
}

/** 旧模型路线 →（model, reasoning_effort）两列（docs/35 §3#5：inherited = 跟随）。 */
function legacyRouteColumns(route: LegacyModelRoute | undefined): {
  model: string | null;
  effort: string | null;
} {
  if (route === undefined) return { model: null, effort: null };
  const model =
    route.source === 'inherited' || route.model === undefined || route.model === ''
      ? null
      : route.model;
  return { model, effort: route.reasoningEffort ?? null };
}

/**
 * 导入一个旧团队目录（team.json + events.jsonl + inbox/*.jsonl；同一事务）。
 * 损坏快照整团队跳过（备份文件保持原样，供手工排查）。
 */
function importLegacyTeam(
  db: DatabaseSync,
  stateRoot: string,
  dirName: string,
  roster: LegacyRosterMember[],
  now: number,
): void {
  let old: LegacyTeam;
  try {
    old = JSON.parse(readFileSync(join(stateRoot, dirName, 'team.json'), 'utf8')) as LegacyTeam;
  } catch {
    return;
  }
  const teamName = (old.name ?? dirName).trim() || dirName;
  const hasLeader = old.leaderRemoved !== true;
  const teamInfo = db
    .prepare(
      'INSERT INTO team (team_name, has_leader, created_time, update_time) VALUES (?, ?, ?, ?)',
    )
    .run(teamName, hasLeader ? 1 : 0, old.createdAt ?? now, now);
  const teamId = Number(teamInfo.lastInsertRowid);

  const tasks = old.tasks ?? [];
  const decisions = (old.pendingDecisions ?? []).filter((d) => (d.status ?? 'open') === 'open');
  const maps = buildIdMaps(tasks, decisions);
  const tx: TeamTx = { db, now };

  // ---- 班底行（v7：工牌发放处——领队也是一行；工号 = 行的自增主键
  // （表自增），旧号不保留——副本/邮箱/链站在本导入内按新号重键）----
  const insertTeamMember = db.prepare(
    'INSERT INTO team_members (team_id, role_id, model, reasoning_effort, is_leader, created_time, update_time) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const employeeByMember = new Map<string, number>();
  for (const m of old.members ?? []) {
    const name = m.name;
    const role = (m.role ?? name).trim() || name;
    const persona = personaFromFields(m.persona ?? {}, name, role);
    // 同名角色行缺则从班底行自建（手册/头像带上）；已有同名行（roster.json
    // 导入）以角色行为准，班底行只留派发路线。
    const roleId = ensureRolesRowInTx(tx, name, persona, {
      avatar: m.avatar ?? { seed: hashName(name), salt: 0 },
    });
    const route = legacyRouteColumns(m.modelRoute);
    const info = insertTeamMember.run(
      teamId,
      roleId,
      route.model,
      route.effort,
      leaderFlagOf(name),
      m.createdAt ?? now,
      now,
    );
    employeeByMember.set(name, Number(info.lastInsertRowid));
  }
  if (!employeeByMember.has(LEADER_NAME)) {
    // 旧快照缺领队条目：班底领队行仍要建（主持行工号与它同步，终审 #2）
    const leaderTemplate = roster.find((r) => r.name === LEADER_NAME);
    const roleId = ensureRolesRowInTx(
      tx,
      LEADER_NAME,
      personaFromFields(leaderTemplate ?? {}, LEADER_NAME, leaderTemplate?.role ?? LEADER_NAME),
      { avatar: { seed: hashName(LEADER_NAME), salt: 7 } },
    );
    const info = insertTeamMember.run(
      teamId,
      roleId,
      null,
      null,
      leaderFlagOf(LEADER_NAME),
      old.createdAt ?? now,
      now,
    );
    employeeByMember.set(LEADER_NAME, Number(info.lastInsertRowid));
  }
  // v4 副本列刷新：本队班底行刚落库，镜像按角色行统一回填
  syncTeamMemberRoleMirrorInTx(tx, { teamId });

  // ---- 领队实例行（docs/35 §5#2：captainSessionId/captainChildId 落这里；
  // 工号同步班底领队行——它是主持行不是工牌）----
  const leaderTemplate = roster.find((r) => r.name === LEADER_NAME);
  const leaderRow = db
    .prepare('SELECT persona_md FROM roles WHERE role_name = ?')
    .get(LEADER_NAME) as { persona_md: string | null } | undefined;
  const leaderPersona = personaFromFields(
    leaderTemplate ?? {},
    LEADER_NAME,
    leaderTemplate?.role ?? LEADER_NAME,
  );
  insertTaskMemberRow(tx, {
    id: 0,
    teamId,
    mainTaskId: null,
    nowTaskId: null,
    name: LEADER_NAME,
    employeeId: employeeByMember.get(LEADER_NAME) ?? null,
    // v6 领队行 session_id = 领队子代理会话；主会话快照归任务行（下方盖章）。
    sessionId: old.captainChildId ?? '',
    status: hasLeader ? 'ready' : 'removed',
    personaMd: leaderRow?.persona_md ?? personaToMd(leaderPersona, LEADER_NAME),
    createdAt: old.createdAt ?? now,
  });

  // ---- 成员实例行：有子会话且任务可锚定的旧成员各建一行（v7 不再产团队
  // 级行——副本随任务补建，见下方任务循环之后）----
  for (const m of old.members ?? []) {
    if (m.name === LEADER_NAME) continue;
    const childSessionId = m.id ?? '';
    if (childSessionId === '') continue;
    const anchor = anchorTaskOf(tasks, m.name, maps);
    if (anchor === undefined) continue; // 无任务可锚：只留班底行（工牌）
    const persona = personaFromFields(m.persona ?? {}, m.name, m.role ?? m.name);
    const route = legacyRouteColumns(m.modelRoute);
    const row: TaskMemberRecord = {
      id: 0,
      teamId,
      mainTaskId: anchor.rootId,
      nowTaskId: anchor.taskId,
      name: m.name,
      employeeId: employeeByMember.get(m.name) ?? null,
      sessionId: childSessionId,
      status: mapMemberStatus(m.status),
      personaMd: personaToMd(persona, m.name),
      ...(route.model !== null ? { model: route.model } : {}),
      ...(route.effort !== null ? { reasoningEffort: route.effort } : {}),
      ...(m.avatar !== undefined ? { avatar: { seed: m.avatar.seed, salt: m.avatar.salt } } : {}),
      createdAt: m.createdAt ?? now,
    };
    insertTaskMemberRow(tx, row);
  }

  // ---- 任务 / 尝试（t1/a1 → 整数；work_dir 存字面旧目录）----
  const insertTask = db.prepare(
    'INSERT INTO task (task_id, team_id, parent_id, subject, description, depend_tasks, ' +
      'member_chain_list, chain_cursor, status, current_member, current_member_id, ' +
      'main_session_id, retry_count, status_note, contract_md, idempotency_note, ' +
      'blocked_from, work_dir, completed_time, created_time, update_time) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertAttempt = db.prepare(
    'INSERT INTO attempts (attempt_id, team_id, task_id, kind, member, status, token, ' +
      'station_index, progress, result_output, result_changed_paths, error, claimed_time, ' +
      'ended_time, created_time, update_time) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const base = old.workDir ?? `teams/${sanitizeKey(teamName)}`;
  const subjectOf = new Map(tasks.map((t) => [t.id, t.subject]));
  for (const t of tasks) {
    const taskId = maps.task.get(t.id);
    if (taskId === undefined) continue;
    const parentId = t.parentId !== undefined ? (maps.task.get(t.parentId) ?? null) : null;
    const parentSubject = t.parentId !== undefined ? subjectOf.get(t.parentId) : undefined;
    const blockedFrom =
      t.status === 'blocked' ? mapLegacyStatus(t.blockedFrom ?? 'ready', 'ready') : null;
    insertTask.run(
      taskId,
      teamId,
      parentId,
      t.subject,
      t.description ?? null,
      JSON.stringify(
        (t.dependencies ?? [])
          .map((d) => maps.task.get(d))
          .filter((n): n is number => n !== undefined),
      ),
      // 执行链站点（v7）：名字站点换工号站点（按本队班底解析；解析不到的
      // 保留名字，渲染端标 legacy 兜底）
      JSON.stringify(
        (t.chain ?? []).map((s) => {
          const resolved = employeeByMember.get(s.member);
          return resolved !== undefined ? { ...s, member: resolved } : s;
        }),
      ),
      t.chainCursor ?? -1,
      mapLegacyStatus(t.status, 'draft'),
      t.assignee ?? null,
      // 主会话快照：旧版任务盖章建队会话（task.main_session_id，v5 落列
      // v6 改名；导入直盖，落库后不变）
      old.captainSessionId || null,
      t.retryCount ?? 0,
      t.suspendNote ?? null,
      // 合同 MD（十六轮 DA29）：新格式直取 contractMd；旧格式由四数组合成。
      t.contractMd ??
        contractMdFromLegacyArrays({
          acceptance: t.acceptance,
          inScope: t.inScope,
          outOfScope: t.outOfScope,
          deliverables: t.deliverables,
        }) ??
        null,
      t.idempotencyNote ?? null,
      blockedFrom,
      legacyTaskDir(base, t, taskId, parentId, parentSubject),
      t.completedAt ?? null,
      t.createdAt ?? now,
      t.updatedAt ?? now,
    );
    for (const a of t.attempts ?? []) {
      const attemptId = a.id !== undefined ? maps.attempt.get(a.id) : undefined;
      if (attemptId === undefined) continue;
      insertAttempt.run(
        attemptId,
        teamId,
        taskId,
        a.kind ?? 'initial',
        a.member ?? t.assignee ?? '',
        a.status ?? 'pending_accept',
        a.token ?? '',
        a.stationIndex ?? -1,
        JSON.stringify(a.progress ?? []),
        a.result?.output ?? null,
        a.result?.changedPaths !== undefined ? JSON.stringify(a.result.changedPaths) : null,
        a.error ?? null,
        a.claimedAt ?? null,
        a.endedAt ?? null,
        a.createdAt ?? now,
        a.endedAt ?? a.createdAt ?? now,
      );
    }
  }

  // ---- 任务副本补建（v7：建任务即班底全员复制——含领队；工号抄班底行的
  // 自增主键（表自增），status=staged、session_id 空；上方导入的旧锚定行
  // 保持原状态原会话不动。只补容器任务：副本行只锚定大任务，小任务共享
  // 容器的副本行）----
  db.prepare(
    'INSERT INTO task_members (team_id, main_task_id, now_task_id, name, employee_id, ' +
      'session_id, status, created_time, update_time) ' +
      'SELECT tm.team_id, t.task_id, NULL, tm.role_name, tm.team_member_id, ?, ?, ?, ? ' +
      'FROM task t JOIN team_members tm ON tm.team_id = t.team_id ' +
      'WHERE t.parent_id IS NULL AND tm.role_name IS NOT NULL ' +
      'AND NOT EXISTS (SELECT 1 FROM task_members x WHERE x.team_id = tm.team_id ' +
      'AND x.main_task_id = t.task_id AND x.name = tm.role_name)',
  ).run('', 'staged', now, now);

  // ---- 尝试归属回填（v7：attempts.task_member_id 按成员名 + 根任务 join
  // 副本行；解析不到保留 NULL，判定退按名兜底）----
  db.prepare(
    'UPDATE attempts SET task_member_id = ' +
      '(SELECT x.task_member_id FROM task_members x ' +
      'WHERE x.team_id = attempts.team_id AND x.name = attempts.member ' +
      'AND x.main_task_id = ' +
      '(SELECT COALESCE(t.parent_id, t.task_id) FROM task t WHERE t.task_id = attempts.task_id)) ' +
      'WHERE team_id = ? AND task_member_id IS NULL',
  ).run(teamId);

  // ---- 升级决策（旧 pendingDecisions 即 open 行）----
  const insertDecision = db.prepare(
    'INSERT INTO decisions (decision_id, team_id, task_id, attempt_id, error, retry_count, ' +
      'status, choice, note, resolved_time, created_time, update_time) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const d of old.pendingDecisions ?? []) {
    const decisionId = maps.decision.get(d.id);
    const taskId = maps.task.get(d.taskId);
    if (decisionId === undefined || taskId === undefined) continue;
    if ((d.status ?? 'open') !== 'open') continue; // resolved 行不入库（快照只存 open）
    insertDecision.run(
      decisionId,
      teamId,
      taskId,
      d.attemptId !== undefined ? (maps.attempt.get(d.attemptId) ?? null) : null,
      d.error ?? '',
      d.retryCount ?? 0,
      'open',
      d.choice ?? null,
      d.note ?? null,
      d.resolvedAt ?? null,
      d.createdAt ?? now,
      d.resolvedAt ?? now,
    );
  }

  // ---- 事件（per-team seq 丢弃换全库号；actor 拍平两列）----
  const eventsFile = join(stateRoot, dirName, 'events.jsonl');
  if (existsSync(eventsFile)) {
    for (const e of parseJsonl<LegacyEvent>(readFileSync(eventsFile, 'utf8'))) {
      if (typeof e.type !== 'string' || e.type === '') continue;
      const event: EventRecord = {
        seq: 0,
        at: e.at ?? now,
        actor: e.actor ?? { kind: 'system' },
        type: e.type,
        ...(e.taskId !== undefined ? { taskId: maps.task.get(e.taskId) } : {}),
        ...(e.attemptId !== undefined ? { attemptId: maps.attempt.get(e.attemptId) } : {}),
        payload: mapLegacyPayload(e.payload, maps),
      };
      insertEventInTx(tx, teamId, event);
    }
  }

  // ---- 邮箱（文件名 → box_key；v7：成员箱按工号串重钉、employee_id 落列
  // ——旧名字箱解析不到的保留名字仅显示兜底；message_id 原样；seq 丢弃换
  // 全库号）----
  const inboxDir = join(stateRoot, dirName, 'inbox');
  if (existsSync(inboxDir)) {
    for (const fileName of readdirSync(inboxDir)) {
      if (!fileName.endsWith('.jsonl')) continue;
      const legacyBox = fileName.slice(0, -'.jsonl'.length);
      const boxEmployeeId = legacyBox === 'captain' ? null : (employeeByMember.get(legacyBox) ?? null);
      const box = boxEmployeeId !== null ? String(boxEmployeeId) : legacyBox;
      for (const m of parseJsonl<LegacyMail>(readFileSync(join(inboxDir, fileName), 'utf8'))) {
        if (typeof m.id !== 'string' || m.id === '') continue;
        const mail: MailMessage = {
          id: m.id,
          seq: 0,
          at: m.at ?? now,
          from: m.from ?? { kind: 'system' },
          to: m.to ?? { kind: 'member', name: legacyBox },
          kind: mapMailKind(m.kind),
          ...(m.taskId !== undefined ? { taskId: maps.task.get(m.taskId) } : {}),
          ...(m.attemptId !== undefined ? { attemptId: maps.attempt.get(m.attemptId) } : {}),
          content: m.content ?? '',
          ...(m.readAt !== undefined ? { readAt: m.readAt } : {}),
        };
        insertMailInTx(tx, teamId, box, mail, boxEmployeeId);
      }
    }
  }
}