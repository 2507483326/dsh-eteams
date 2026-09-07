/**
 * Team-level operations (docs/07.2): create → run（审批环节随 docs/35 §5#1
 * 下线，建队即可用）、成员班底管理、私信与只读视图。每个变更在团队锁内，
 * 且在一个同步事务里连同事件/邮件整存整取（docs/35 §3#14）；起会话/唤醒/
 * 文档渲染是异步 I/O，一律放在 COMMIT 之后（事务体内不得 await）。
 *
 * @module dsh-eteams/runtime/teamOps
 */
import { existsSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { JsonValue } from '@deepseek-ai/dsh-session';
import { mergePersona } from '../prompts/personas/framework.js';
import { defaultPersonaFor } from '../prompts/personas/presets.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type {
  Actor,
  MemberRecord,
  ModelRouteSnapshot,
  TaskMemberRecord,
  TaskRecord,
  TeamState,
} from '../model/types.js';
import { locks, teamLockKey } from '../state/lock.js';
import {
  readTeam,
  readTeamSync,
  writeTeamInTx,
  insertTeamRow,
  insertTaskMemberRow,
  ensureRolesRowInTx,
  rolesRowByName,
  syncTeamMemberRoleMirrorInTx,
  withTeamTx,
  findTeamByCaptain,
  teamCreatedBy,
  type TeamKey,
  type TeamTx,
} from '../state/store.js';
import { hashName, LEADER_NAME, nextAutoincrementId, nextEmployeeId, personaFromMd, personaToMd } from '../state/db.js';
import { insertEventInTx, insertMailInTx } from '../state/events.js';
import { applyTransition, sanitizeKey, taskSlug } from '../model/taskMachine.js';
import { ETeamsError, captainActor, memberActor, stateRootOf, type RuntimeEnv } from './base.js';
import { clearSessionTeam, getSessionTeamId } from './sessionTeam.js';
import { renderTeamDocs, teamWorkDirRel } from './docs.js';
import { findRosterMember, ROLE_BUILDER_NAME, upsertRosterMember } from './roster.js';
import { interruptMember, drainMembers } from './members.js';
import { readBuildPresence } from './roleBuilder.js';
import {
  leaderRowOf,
  latestInstanceRow,
  makeMail,
  memberStatusOf,
  notifyCaptain,
  readBox,
  requireMember,
  teamMainSessionOf,
  wakeMember,
} from './notifier.js';

/**
 * 团队变更帧（docs/35 §3#14）：锁内读快照 → 同步事务内执行 `fn`（状态、
 * 事件、邮件同事务）→ 事务尾整存整取快照。`fn` 同步执行、不得 await；异步
 * 收尾（起会话/唤醒/文档渲染）由调用方在提交后处理。非变更路径不要走这里。
 */
export async function withTeam<T>(
  env: RuntimeEnv,
  teamId: TeamKey,
  fn: (team: TeamState, root: string, tx: TeamTx) => T,
): Promise<T> {
  const root = stateRootOf(env);
  return locks.withLock(teamLockKey(root, String(teamId)), async () => {
    const team = readTeamSync(root, teamId);
    if (!team)
      throw new ETeamsError(
        `团队「${String(teamId)}」不存在`,
        '用 eteams_team_status 查看当前团队，或先 eteams_create_team',
      );
    return withTeamTx(root, team.id, (tx) => {
      const result = fn(team, root, tx);
      writeTeamInTx(tx, team);
      return result;
    });
  });
}

/** The team led by this captain (identity guard, docs/05.8). */
export async function requireCaptainTeam(env: RuntimeEnv, captain: Agent): Promise<TeamState> {
  const root = stateRootOf(env);
  const team = await findTeamByCaptain(root, String(captain.id));
  if (!team)
    throw new ETeamsError('你还没有团队', '先用 eteams_create_team 建队（多代理请求时自动建队）');
  return team;
}

/** Create a team (docs/07.2 step 1-2；建队即可用，docs/35 §5#1). */
export async function createTeam(
  env: RuntimeEnv,
  captain: Agent,
  params: {
    name: string;
    questionnaire?: string[];
    /** Origin marker for events (tool / panel). */
    via?: string;
  },
): Promise<TeamState> {
  const root = stateRootOf(env);
  const captainId = String(captain.id);
  const name = params.name.trim();
  return locks.withLock(`captain:${root}:${captainId}`, async () => {
    const existing = await findTeamByCaptain(root, captainId);
    if (existing) {
      throw new ETeamsError(
        `你已领队「${existing.name}」`,
        '一个领队同时只带一个团队；完成或删除现有团队后再建新队',
      );
    }
    const now = Date.now();
    let teamId: number | undefined;
    withTeamTx(root, undefined, (tx) => {
      teamId = insertTeamRow(tx, name, true, now);
      // 领队行（docs/35 §5#12）：团队级主持行只记自己的子代理会话（v6 领队
      // 行 session_id = 领队子代理，未派发时空串）；主会话快照归 task 行。
      // 工号与手册沿角色库行（项目牧羊人预设，import.ts 播种）。
      const template = tx.db
        .prepare('SELECT employee_id, persona_md FROM roles WHERE role_name = ? LIMIT 1')
        .get(LEADER_NAME) as { employee_id: number | null; persona_md: string | null } | undefined;
      const row: TaskMemberRecord = {
        id: 0,
        teamId,
        mainTaskId: null,
        nowTaskId: null,
        name: LEADER_NAME,
        employeeId: template?.employee_id ?? null,
        sessionId: '',
        status: 'ready',
        ...(template?.persona_md ? { personaMd: template.persona_md } : {}),
        createdAt: now,
      };
      insertTaskMemberRow(tx, row);
      insertEventInTx(tx, teamId, {
        seq: 0,
        at: now,
        actor: captainActor(),
        type: 'team.created',
        payload: {
          name,
          // v6 建队会话留痕（审计 + findTeamByCaptain 事件兜底：无任务团队
          // 的建队去重/身份解析用它，主表不存会话列）。
          captainSession: captainId,
          ...(params.via !== undefined ? { via: params.via } : {}),
        },
      });
      if (params.questionnaire && params.questionnaire.length > 0) {
        insertEventInTx(tx, teamId, {
          seq: 0,
          at: now,
          actor: captainActor(),
          type: 'plan.questionnaire',
          payload: { questions: params.questionnaire },
        });
      }
    });
    // 绑定让位（docs/26 绑定即可驱动）：resolveCaller 绑定优先——刚建的
    // 新队以本会话为领队，若本会话还绑着旧团队，旧绑定会遮蔽新队（工具
    // 全落到旧队上）。建队成功即清除本会话的旧绑定。
    clearSessionTeam(captainId);
    const team = readTeamSync(root, teamId!);
    if (!team) throw new ETeamsError(`建队失败：团队行写入后读取为空（${name}）`);
    return team;
  });
}

/**
 * 幂等分配任务工作目录（docs/35 §3#8，work_dir 归任务）：父任务下挂
 * `<父 work_dir>/sub/<任务号>-<slug>`，顶层任务在 `teams/<团队>/tasks/`
 * 之下。撞名（对比集 = 其他任务的 work_dir + 目录已存在）在叶子段加
 * -2、-3 后缀保留。只算路径不建目录——目录随文档渲染物化。
 */
export function ensureTaskWorkDir(env: RuntimeEnv, team: TeamState, task: TaskRecord): string {
  if (task.workDir !== undefined) return task.workDir;
  const leaf = taskSlug(task);
  const parentDir =
    task.parentId !== null ? team.tasks.find((t) => t.id === task.parentId)?.workDir : undefined;
  const base =
    parentDir !== undefined ? `${parentDir}/sub/${leaf}` : `${teamWorkDirRel(team)}/tasks/${leaf}`;
  const taken = new Set<string>();
  for (const other of team.tasks) {
    if (other.id === task.id || other.workDir === undefined) continue;
    taken.add(other.workDir);
  }
  let workDir = base;
  if (taken.has(workDir) || existsSync(join(env.workspace, workDir))) {
    let n = 2;
    while (taken.has(`${base}-${n}`) || existsSync(join(env.workspace, `${base}-${n}`))) n++;
    workDir = `${base}-${n}`;
  }
  return workDir;
}

/** Add one member（班底模板行 + staged 实例行；不立即起会话，docs/35 §5#12）. */
export async function addMember(
  env: RuntimeEnv,
  captain: Agent,
  params: {
    teamId?: TeamKey;
    name: string;
    role: string;
    executionPrompt?: string;
    /** Persona framework content (D13) — overrides the role template. */
    duty?: string;
    style?: string;
    skills?: string;
    rules?: string[];
    /** Full Markdown role playbook (agency-agents-zh style). */
    personaMd?: string;
    model?: string;
    reasoningEffort?: string;
    /** Pre-generated avatar (docs/14); generated from the name when absent. */
    avatar?: { seed: number; salt: number };
    /**
     * 工号 (docs/21). 显式 > 角色库同名角色行 > 事务内新分配（分配一次；
     * 角色行缺号时回填，同人同号）。
     */
    employeeId?: string;
    /** Origin marker for events (tool / panel). */
    via?: string;
  },
): Promise<{ team: TeamState; member: MemberRecord }> {
  const team =
    params.teamId !== undefined
      ? await requireTeamById(env, captain, params.teamId)
      : await requireCaptainTeam(env, captain);
  const { team: fresh, member } = await withTeam(env, team.id, (teamNow, _root, tx) => {
    const leader = leaderRowOf(teamNow);
    // 调用者身份已由 requireTeamById/requireCaptainTeam 校验（v6 判据）；这
    // 里只拦领队不在册/已移除。
    if (!leader || leader.status === 'removed') {
      throw new ETeamsError('只有该团队的领队可以添加成员');
    }
    const name = params.name.trim();
    if (name === '') throw new ETeamsError('成员名不能为空');
    if (name === LEADER_NAME) {
      throw new ETeamsError('领队由建队自动入册，不能作为成员添加');
    }
    // 查重按实例行（docs/35 §5#12）：存在非 removed 实例行即已入职。
    if (teamNow.taskMembers.some((r) => r.name === name && r.status !== 'removed')) {
      throw new ETeamsError(`成员「${name}」已在团队中`);
    }
    // 团队上限（用户迭代 2026-09 六：领队也算成员）——按非 removed 实例行
    // 去重名计数（同一人多条大任务行只算一人），领队行占 1 个名额。
    const activeNames = new Set(
      teamNow.taskMembers
        .filter((r) => r.status !== 'removed' && r.name !== LEADER_NAME)
        .map((r) => r.name),
    );
    const leaderTaken = 1; // 领队在册（removed 已在上方拒绝）——占 1 个名额
    if (activeNames.size + leaderTaken >= env.config.maxMembers) {
      throw new ETeamsError(
        `团队人数已达上限（${env.config.maxMembers}，含领队）`,
        '先 eteams_remove_member 再添加，或调整配置 maxMembers',
      );
    }
    const now = tx.now;
    const employeeIdParam = Number.parseInt(params.employeeId ?? '', 10);
    // 角色行（v3 成员=角色，全局一份）：同名行已存在 → 人设以角色行为准
    // （显式 role 参数只在角色行缺失时生效，面板本就传角色库同名条目的
    // role）；缺行 → 按本次参数现烘 persona，随后 ensureRolesRowInTx 入库
    // （加成员即入库）。
    const rolesRow = rolesRowByName(tx.db, name);
    const persona =
      rolesRow !== undefined
        ? personaFromMd(rolesRow.persona_md ?? '', name, name)
        : mergePersona(defaultPersonaFor(name, params.role ?? '', params.executionPrompt), {
            ...(params.duty !== undefined ? { duty: params.duty } : {}),
            ...(params.style !== undefined ? { style: params.style } : {}),
            ...(params.skills !== undefined ? { skills: params.skills } : {}),
            ...(params.rules !== undefined ? { rules: params.rules } : {}),
            ...(params.personaMd !== undefined ? { personaMd: params.personaMd } : {}),
          });
    // 班底行：同名班底复用（不重开）；否则新建（team_member_id 事务内发号，
    // writeTeamInTx 按显式 id 重插）。
    let member: MemberRecord | undefined = teamNow.members.find((m) => m.name === name);
    if (member === undefined) {
      const created: MemberRecord = {
        memberId: nextAutoincrementId(tx.db, 'team_members'),
        roleId: null, // ensureRolesRowInTx 后回填
        name,
        employeeId: undefined,
        role: persona.role,
        persona,
        modelRoute: routeFromParams(params.model, params.reasoningEffort),
        avatar: params.avatar ?? { seed: hashName(name), salt: Math.floor(Math.random() * 1000) },
        createdAt: now,
      };
      teamNow.members.push(created);
      member = created;
    } else {
      // 成员详情与角色详情同源（v3）：班底行的 persona/role 刷新自角色行。
      member.persona = persona;
      member.role = persona.role;
      if (rolesRow !== undefined) member.roleId = rolesRow.role_id;
    }
    // 工号（docs/21）：显式 > 角色行 > 事务内新分配（分配一次；角色行缺号
    // 时经 ensureRolesRowInTx 回填，同人同号）。显式工号是对角色行工号的
    // 重定义（v3 工号只挂角色行）：同名角色行已有号也被压过，全局生效。
    const explicitEmployeeId =
      Number.isFinite(employeeIdParam) && employeeIdParam > 0 ? employeeIdParam : undefined;
    let employeeId = explicitEmployeeId ?? rolesRow?.employee_id ?? undefined;
    if (employeeId === undefined) employeeId = nextEmployeeId(tx.db);
    member.roleId = ensureRolesRowInTx(tx, name, persona, {
      ...(member.avatar !== undefined ? { avatar: member.avatar } : {}),
      employeeId,
    });
    member.employeeId = employeeId;
    if (
      explicitEmployeeId !== undefined &&
      rolesRow !== undefined &&
      rolesRow.employee_id !== explicitEmployeeId
    ) {
      tx.db
        .prepare('UPDATE roles SET employee_id = ?, update_time = ? WHERE role_id = ?')
        .run(explicitEmployeeId, tx.now, member.roleId);
    }
    const route = member.modelRoute;
    // 执行实例行：staged（未起会话），团队级未锚定（main_task_id 为空），
    // 首派时才锚定到大任务并起子会话（assignment.ts 首派按链起人）。
    const row: TaskMemberRecord = {
      id: 0,
      teamId: teamNow.id,
      mainTaskId: null,
      nowTaskId: null,
      name,
      employeeId: member.employeeId ?? null,
      sessionId: '',
      status: 'staged',
      ...(member.persona.personaMd !== undefined && member.persona.personaMd !== ''
        ? { personaMd: member.persona.personaMd }
        : {}),
      ...(route.model !== '' ? { model: route.model } : {}),
      ...(route.reasoningEffort !== undefined && route.reasoningEffort !== ''
        ? { reasoningEffort: route.reasoningEffort }
        : {}),
      avatar: member.avatar,
      createdAt: now,
    };
    teamNow.taskMembers.push(row);
    insertEventInTx(tx, teamNow.id, {
      seq: 0,
      at: now,
      actor: captainActor(teamNow),
      type: 'member.added',
      payload: {
        name,
        role: member.role,
        memberId: member.memberId,
        ...(params.via !== undefined ? { via: params.via } : {}),
      },
    });
    return { team: teamNow, member };
  });
  renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
  return { team: fresh, member };
}

/** 参数路线 → ModelRouteSnapshot（docs/35 §3#5：只挑模型，provider 派发时定）。 */
function routeFromParams(
  model: string | undefined,
  effort: string | undefined,
): ModelRouteSnapshot {
  const trimmedModel = model?.trim() ?? '';
  const trimmedEffort = effort?.trim() ?? '';
  return {
    model: trimmedModel,
    ...(trimmedModel !== '' && trimmedEffort !== '' ? { reasoningEffort: trimmedEffort } : {}),
  };
}

/** 同名班底模板行（team.members）；缺省报「成员不存在」。 */
function requireMemberTemplate(team: TeamState, name: string): MemberRecord {
  const member = team.members.find((m) => m.name === name);
  if (!member) throw new ETeamsError(`成员「${name}」不存在`, '用 eteams_team_status 查看在册成员');
  return member;
}

/** Update a member's persona fields (docs/11.2；写班底模板行). */
export async function updateMember(
  env: RuntimeEnv,
  captain: Agent,
  params: {
    teamId?: TeamKey;
    name: string;
    role?: string;
    duty?: string;
    style?: string;
    skills?: string;
    rules?: string[];
    executionPrompt?: string;
    personaMd?: string;
  },
): Promise<TeamState> {
  const team =
    params.teamId !== undefined
      ? await requireTeamById(env, captain, params.teamId)
      : await requireCaptainTeam(env, captain);
  const fresh = await withTeam(env, team.id, (teamNow, _root, tx) => {
    const member = requireMemberTemplate(teamNow, params.name);
    // 角色定义全局一份（v3 成员=角色）：成员详情改动即改角色行手册，全局
    // 生效——role 变化也烘进手册（persona.role 即 MemberRecord.role 的来源）。
    if (params.role !== undefined) member.persona.role = params.role.trim() || member.persona.role;
    member.persona = mergePersona(member.persona, {
      duty: params.duty,
      style: params.style,
      skills: params.skills,
      rules: params.rules,
      executionPrompt: params.executionPrompt,
      personaMd: params.personaMd,
    });
    member.role = member.persona.role;
    // 人设单一来源：按名更新 roles.persona_md（成员详情与角色详情同源）。
    tx.db
      .prepare('UPDATE roles SET persona_md = ?, update_time = ? WHERE role_name = ?')
      .run(personaToMd(member.persona, member.name), tx.now, member.name);
    // v4 副本列刷新：角色行刚改写，班底行镜像随之同步（全局生效的落库面）。
    syncTeamMemberRoleMirrorInTx(tx, { roleId: rolesRowByName(tx.db, member.name)?.role_id });
    // 模板手册变化同步到该成员未锚定的 staged 实例行（执行时的人设副本）。
    const row = teamNow.taskMembers.find(
      (r) => r.name === params.name && r.status === 'staged' && r.mainTaskId === null,
    );
    if (
      row !== undefined &&
      member.persona.personaMd !== undefined &&
      member.persona.personaMd !== ''
    ) {
      row.personaMd = member.persona.personaMd;
    }
    insertEventInTx(tx, teamNow.id, {
      seq: 0,
      at: tx.now,
      actor: captainActor(teamNow),
      type: 'member.updated',
      payload: { name: params.name },
    });
    return teamNow;
  });
  renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
  return fresh;
}

/**
 * Set one member's model route (user iteration 2026-09: per-member model
 * select on the member card). Empty model resets to 会话默认（用户迭代
 * 2026-09-04：settings agent-default-model，spawn 侧 sessionDefaultRouteOf）；
 * 有值即 override——provider 不再入档（docs/35 §3#5），派发起会话时按
 * config.memberProvider 解析。写班底模板行，同时同步到该成员 staged 实例行；
 * 已起会话的成员在下次起会话生效。
 */
export async function setMemberModel(
  env: RuntimeEnv,
  captain: Agent,
  params: {
    teamId?: TeamKey;
    name: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
  },
): Promise<TeamState> {
  const team =
    params.teamId !== undefined
      ? await requireTeamById(env, captain, params.teamId)
      : await requireCaptainTeam(env, captain);
  const fresh = await withTeam(env, team.id, (teamNow, _root, tx) => {
    const member = requireMemberTemplate(teamNow, params.name);
    member.modelRoute = routeFromParams(params.model, params.reasoningEffort);
    const row = teamNow.taskMembers.find(
      (r) => r.name === params.name && r.status === 'staged' && r.mainTaskId === null,
    );
    if (row !== undefined) {
      row.model = member.modelRoute.model;
      if (member.modelRoute.reasoningEffort !== undefined) {
        row.reasoningEffort = member.modelRoute.reasoningEffort;
      } else {
        delete row.reasoningEffort;
      }
    }
    insertEventInTx(tx, teamNow.id, {
      seq: 0,
      at: tx.now,
      actor: captainActor(teamNow),
      type: 'member.updated',
      payload: { name: params.name, route: member.modelRoute },
    });
    return teamNow;
  });
  renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
  return fresh;
}

/**
 * Set the 领队 model route（用户迭代 2026-09-04「领队模型选择」回归）：
 * 写 task_members 领队行（name=项目牧羊人、main_task_id 为空）的
 * model/reasoning_effort——团队级默认路线，领队子代理派发起会话按它解析。
 * 空 model = 会话默认（settings agent-default-model，spawn 侧
 * sessionDefaultRouteOf）；行不存在（领队从未就位）静默不写。
 */
export async function setLeaderModel(
  env: RuntimeEnv,
  captain: Agent,
  params: {
    teamId?: TeamKey;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
  },
): Promise<TeamState> {
  const team =
    params.teamId !== undefined
      ? await requireTeamById(env, captain, params.teamId)
      : await requireCaptainTeam(env, captain);
  const route = routeFromParams(params.model, params.reasoningEffort);
  const fresh = await withTeam(env, team.id, (teamNow, _root, tx) => {
    const leader = leaderRowOf(teamNow);
    if (leader === undefined) return teamNow;
    leader.model = route.model;
    if (route.reasoningEffort !== undefined) {
      leader.reasoningEffort = route.reasoningEffort;
    } else {
      delete leader.reasoningEffort;
    }
    insertEventInTx(tx, teamNow.id, {
      seq: 0,
      at: tx.now,
      actor: captainActor(teamNow),
      type: 'member.updated',
      payload: { name: leader.name, route },
    });
    return teamNow;
  });
  renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
  return fresh;
}

/**
 * Sync a member's own handbook copy back to its roster role (用户迭代 2026-09
 * 四：成员详情与角色详情是两份独立数据——加入团队时复制一份，之后各自演
 * 化；这里把成员当前手册写回角色库同名角色). An existing roster entry keeps
 * every other field (only personaMd is overwritten); a member without a
 * roster entry (e.g. -2 副本) gets one created from the member record. The
 * roster write is an independent transaction and runs after the team tx.
 */
export async function syncMemberToRoster(
  env: RuntimeEnv,
  captain: Agent,
  params: {
    teamId?: TeamKey;
    name: string;
    /** Sync payload; defaults to the member's own saved handbook copy. */
    personaMd?: string;
  },
): Promise<TeamState> {
  const team =
    params.teamId !== undefined
      ? await requireTeamById(env, captain, params.teamId)
      : await requireCaptainTeam(env, captain);
  const root = stateRootOf(env);
  let text: string | undefined;
  const fresh = await withTeam(env, team.id, (teamNow, _root, tx) => {
    const member = requireMemberTemplate(teamNow, params.name);
    const value = (params.personaMd ?? member.persona.personaMd ?? '').trim();
    if (value === '') {
      throw new ETeamsError('成员手册为空，先在成员详情里编辑保存');
    }
    // 成员自己还没有手册副本（旧数据）：同步即补齐，详情从此独立可改。
    if (member.persona.personaMd !== value) {
      member.persona = mergePersona(member.persona, { personaMd: value });
    }
    text = value;
    insertEventInTx(tx, teamNow.id, {
      seq: 0,
      at: tx.now,
      actor: captainActor(teamNow),
      type: 'member.synced_roster',
      payload: { name: member.name },
    });
    return teamNow;
  });
  // 事务外（独立事务）：写回角色库同名角色。
  const existing = findRosterMember(root, params.name);
  if (existing !== undefined) {
    // 已有同名角色：只覆盖手册，其余字段（职责风格/工号/头像）原样保留。
    // 用户迭代 2026-09-03：成员详情「同步到该角色」是显式用户动作，领队
    // 同样放行（与角色详情编辑一致，allowLeader 语义见 roster.ts）。
    await upsertRosterMember(root, { ...existing, personaMd: text ?? '' }, { allowLeader: true });
  } else if (params.name !== LEADER_NAME && params.name !== ROLE_BUILDER_NAME) {
    // 无同名角色（副本成员等）：按成员记录新建角色库条目。
    const member = requireMemberTemplate(fresh, params.name);
    await upsertRosterMember(root, {
      name: member.name,
      role: member.role,
      personaMd: text ?? '',
      ...(member.avatar !== undefined ? { avatar: member.avatar } : {}),
    });
  } else {
    throw new ETeamsError('系统保留角色不同步到角色库');
  }
  renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
  return fresh;
}

/**
 * Move the leader (Project Shepherd) out of / back into the team's member
 * roster (user iteration 2026-09: the leader is deletable)。docs/35 §5#12
 * 之后领队状态落在领队行 status（removed↔ready）+ team.has_leader；领队
 * 会话本身不动。restore 时行已删除则重建（v6 领队行只记自己的子代理会话，
 * 重建时 session_id 留空——主会话锚点归任务行快照）。
 */
export async function setLeaderRemoved(
  env: RuntimeEnv,
  captain: Agent,
  params: { teamId?: TeamKey; removed: boolean },
): Promise<TeamState> {
  const team =
    params.teamId !== undefined
      ? await requireTeamById(env, captain, params.teamId)
      : await requireCaptainTeam(env, captain);
  const fresh = await withTeam(env, team.id, (teamNow, _root, tx) => {
    let leader = leaderRowOf(teamNow);
    if (leader === undefined) {
      // 领队行缺失（异常路径/旧数据）：重建；session_id 留空（领队子代理
      // 未派发），主会话锚点由任务行快照/心跳派生。
      leader = {
        id: 0,
        teamId: teamNow.id,
        mainTaskId: null,
        nowTaskId: null,
        name: LEADER_NAME,
        employeeId: null,
        sessionId: '',
        status: params.removed ? 'removed' : 'ready',
        createdAt: tx.now,
      };
      teamNow.taskMembers.push(leader);
    }
    if (params.removed) {
      if (leader.status === 'removed') return teamNow;
      leader.status = 'removed';
      teamNow.hasLeader = false;
    } else {
      // 加回领队同样占团队名额（用户迭代 2026-09 六：领队也算成员）：满员
      // 时拒绝加回，先移出一名成员。
      const activeNames = new Set(
        teamNow.taskMembers
          .filter((r) => r.status !== 'removed' && r.name !== LEADER_NAME)
          .map((r) => r.name),
      );
      if (activeNames.size + 1 > env.config.maxMembers) {
        throw new ETeamsError(
          `团队人数已达上限（${env.config.maxMembers}，含领队）`,
          '先 eteams_remove_member 再加回领队，或调整配置 maxMembers',
        );
      }
      if (leader.status !== 'removed') return teamNow;
      leader.status = 'ready';
      teamNow.hasLeader = true;
    }
    insertEventInTx(tx, teamNow.id, {
      seq: 0,
      at: tx.now,
      actor: captainActor(teamNow),
      type: 'leader.' + (params.removed ? 'removed' : 'restored'),
      payload: {},
    });
    return teamNow;
  });
  renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
  return fresh;
}

/**
 * Remove a member（docs/35 §5#12 实例行语义）：该成员全部实例行置 removed、
 * 在办尝试吊销、任务回就绪池；提交后 interrupt/drain 其子会话。领队走
 * setLeaderRemoved 的移除语义（行 status + has_leader）。
 */
export async function removeMember(
  env: RuntimeEnv,
  captain: Agent,
  name: string,
  teamId?: TeamKey,
): Promise<TeamState> {
  const team =
    teamId !== undefined
      ? await requireTeamById(env, captain, teamId)
      : await requireCaptainTeam(env, captain);
  if (name === LEADER_NAME) {
    return setLeaderRemoved(env, captain, { teamId: team.id, removed: true });
  }
  const fresh = await withTeam(env, team.id, (teamNow, _root, tx) => {
    const rows = teamNow.taskMembers.filter((r) => r.name === name && r.status !== 'removed');
    if (rows.length === 0) {
      throw new ETeamsError(`成员「${name}」不存在`, '用 eteams_team_status 查看在册成员');
    }
    const now = tx.now;
    // 在办尝试吊销（docs/06.4）：pending_accept/running → revoked；任务
    // 回就绪池（wait/start → ready，10 态边）。
    for (const task of teamNow.tasks) {
      const attempt = task.attempts.find(
        (a) => a.member === name && (a.status === 'pending_accept' || a.status === 'running'),
      );
      if (attempt === undefined) continue;
      attempt.status = 'revoked';
      attempt.endedAt = now;
      if (task.status === 'wait' || task.status === 'start') {
        applyTransition(task, 'ready', now);
        task.assignee = undefined;
      }
      insertEventInTx(tx, teamNow.id, {
        seq: 0,
        at: now,
        actor: captainActor(teamNow),
        type: 'task.unassigned',
        taskId: task.id,
        attemptId: attempt.id,
        payload: { reason: 'member.removed', member: name },
      });
    }
    for (const row of rows) row.status = 'removed';
    insertEventInTx(tx, teamNow.id, {
      seq: 0,
      at: now,
      actor: captainActor(teamNow),
      type: 'member.removed',
      payload: { name },
    });
    return teamNow;
  });
  // 提交后：中断并回收该成员全部子会话（回收驻留 Activation，docs/20.4 P2）。
  // 锚点按 v6 派生（任务行快照 + 心跳兜底）；都不在线退回调用的 captain。
  const anchorId = teamMainSessionOf(fresh) || readBuildPresence(stateRootOf(env))?.sessionId || '';
  const captainAgent = (anchorId !== '' ? env.ctx.agents.get(anchorId) : undefined) ?? captain;
  for (const row of fresh.taskMembers) {
    if (row.name !== name || row.sessionId === '') continue;
    interruptMember(env, row, captainAgent);
    await drainMembers(env, captainAgent, [row.sessionId]);
  }
  renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
  return fresh;
}

async function requireTeamById(
  env: RuntimeEnv,
  captain: Agent,
  teamId: TeamKey,
): Promise<TeamState> {
  const team = await readTeam(stateRootOf(env), teamId);
  if (!team) throw new ETeamsError(`团队「${String(teamId)}」不存在`);
  // v6 身份判据：面板合成代理（captainId 为空串，路由已按 teamId 定位）直接
  // 放行；工具路径按 ①任务行主会话快照 ②领队行子代理会话（宿主重启后领队
  // 子代理身份）③会话→团队绑定 匹配。removed 行不拦（领队 remove/restore
  // 要能走通），需要活跃领队的具体操作自带更严守卫。
  const captainId = String(captain.id ?? '');
  if (captainId === '') return team;
  const leaderSession = leaderRowOf(team)?.sessionId ?? '';
  const bound = getSessionTeamId(captainId);
  if (
    team.tasks.some((t) => t.mainSessionId === captainId) ||
    (leaderSession !== '' && leaderSession === captainId) ||
    (bound !== undefined && String(team.id) === bound) ||
    // 建队事件留痕（v6）：无任务团队在首个任务落地前，建队会话仍是领队。
    teamCreatedBy(stateRootOf(env), team.id, captainId)
  ) {
    return team;
  }
  throw new ETeamsError('只有该团队的领队可以执行此操作');
}

/** Captain → member or member → captain/member message (docs/09.1). */
export async function sendMessage(
  env: RuntimeEnv,
  team: TeamState,
  from: Actor,
  to: string,
  content: string,
  refs: { taskId?: number } = {},
): Promise<void> {
  const wakes: Array<() => Promise<boolean>> = [];
  await withTeam(env, team.id, (fresh, root, tx) => {
    if (to === 'captain') {
      insertMailInTx(
        tx,
        fresh.id,
        'captain',
        makeMail(
          from,
          { kind: 'captain', name: '领队' },
          from.kind === 'user' ? 'user_message' : 'report',
          content,
          refs,
        ),
      );
      // 领队锚点（v6 派生）：任务行快照 + 心跳兜底。
      const anchorId = teamMainSessionOf(fresh) || readBuildPresence(root)?.sessionId || '';
      const captainAgent = anchorId !== '' ? env.ctx.agents.get(anchorId) : undefined;
      if (captainAgent) {
        try {
          captainAgent.followup(
            createUserMessage({
              content: [{ type: 'text', text: `[来自 ${from.name ?? from.kind}] ${content}` }],
              source: { kind: 'plugin', plugin: 'dsh-eteams' },
            }),
          );
        } catch (error) {
          env.ctx.logger.warn(`eteams: captain wake failed: ${String(error)}`);
        }
      }
    } else {
      requireMember(fresh, to);
      insertMailInTx(
        tx,
        fresh.id,
        to,
        makeMail(from, { kind: 'member', name: to }, 'notice', content, refs),
      );
      const row = latestInstanceRow(fresh, to);
      if (row !== undefined) {
        wakes.push(() =>
          wakeMember(env, fresh, row, `[来自 ${from.name ?? from.kind}] ${content}`),
        );
      }
    }
    insertEventInTx(tx, fresh.id, {
      seq: 0,
      at: tx.now,
      actor: from,
      type: 'message.sent',
      ...(refs.taskId !== undefined ? { taskId: refs.taskId } : {}),
      payload: { to, length: content.length },
    });
    return undefined;
  });
  // 提交后：最佳努力唤醒。
  for (const wake of wakes) await wake();
}

/** Read-only team view used by both tool faces (JSON-safe for tool output). */
export function teamView(env: RuntimeEnv, team: TeamState): Record<string, JsonValue> {
  return {
    id: team.id,
    name: team.name,
    hasLeader: team.hasLeader,
    members: team.members
      .filter((m) => m.name !== LEADER_NAME)
      // 团队现状精简（用户迭代 2026-09-03「团队现状太繁杂了」）：成员只带
      // 工号/角色/聚合状态；状态取实例行聚合口径（docs/35 §5#12），currentTask
      // 可从 tasks 的 assignee+status 读出，模型路线属于派发细节。name 保留：
      // eteams_* 工具按成员名指派，没有名字工号无法落地。
      .map((m): JsonValue => ({
        name: m.name,
        employeeId: m.employeeId ?? null,
        role: m.role,
        status: memberStatusOf(team, m.name),
      })),
    tasks: team.tasks.map((t): JsonValue => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      assignee: t.assignee ?? null,
      chain: t.chain.length,
      cursor: t.chainCursor,
      parent: t.parentId ?? null,
    })),
    pendingDecisions: team.pendingDecisions
      .filter((d) => d.status === 'open')
      .map((d): JsonValue => ({ ...d })),
    // 邮箱尾部同样精简（同上迭代）：只带最近 5 条、正文截断——领队子代理
    // 是持续会话，通知语境已在既有上下文里，快照只需提示有新邮件。
    captainMailbox: readBox(env, team.id, 'captain')
      .slice(-5)
      .map((m): JsonValue => ({
        id: m.id,
        seq: m.seq,
        at: m.at,
        from: { kind: m.from.kind, name: m.from.name ?? null },
        kind: m.kind,
        taskId: m.taskId ?? null,
        content: m.content.length > 300 ? `${m.content.slice(0, 300)}…` : m.content,
      })),
  };
}

/**
 * 递归删除目录树：node:fs 的 rmSync 在本机（Node 24 / Win32）对非 ASCII
 * 路径会静默失败（unlinkSync/rmdirSync/renameSync 均正常）——团队 id 多为
 * 中文团队名，删除必须绕开 rmSync，手动后序删除（先清文件再删空目录）。
 * {@link deleteTeam} 与任务文件夹清理（docs/26 deleteTask）共用。
 */
export function rmTree(target: string): void {
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const child = join(target, entry.name);
    if (entry.isDirectory()) {
      rmTree(child);
    } else {
      unlinkSync(child);
    }
  }
  rmdirSync(target);
}

/**
 * Delete a team permanently（docs/27 删除规则）：库事务里逐表按 team_id 删
 * （含领队行；班底行在 team_members，随队删除；roles 角色库行全局共享，
 * 不随队删）。归档已随 docs/35 §3#7 下线；对话内确认放在工具层（波次 3）。
 * 存在未收尾任务的团队拒绝删除。
 */
export async function deleteTeam(env: RuntimeEnv, captain: Agent, teamId: TeamKey): Promise<void> {
  const team = await requireTeamById(env, captain, teamId);
  const root = stateRootOf(env);
  await locks.withLock(teamLockKey(root, String(team.id)), async () => {
    const fresh = readTeamSync(root, team.id);
    if (!fresh) throw new ETeamsError(`团队「${String(teamId)}」不存在`);
    // 运行中任务守卫（等价旧 phase 门控）：派发/执行/挂起/待决策中的任务
    // 先取消，再删队。
    const active = fresh.tasks.filter(
      (t) =>
        t.status === 'wait' ||
        t.status === 'start' ||
        t.status === 'paused' ||
        t.status === 'wait_decision' ||
        t.status === 'wait_user',
    );
    if (active.length > 0) {
      throw new ETeamsError(
        `存在未收尾的任务（${active.map((t) => `#${t.id}`).join('、')}），不能直接删除`,
        '先 eteams_cancel_task 取消任务，再删除团队',
      );
    }
    const childIds = fresh.taskMembers
      .filter((r) => r.status !== 'removed')
      .map((r) => r.sessionId);
    withTeamTx(root, fresh.id, (tx) => {
      for (const table of [
        'task',
        'attempts',
        'decisions',
        'events',
        'mail_messages',
        'task_status_changes',
        'task_members',
        'team_members',
      ]) {
        tx.db.prepare(`DELETE FROM ${table} WHERE team_id = ?`).run(fresh.id);
      }
      // 角色库行（roles）是全局共享的，不随团队删除。
      tx.db.prepare('DELETE FROM team WHERE team_id = ?').run(fresh.id);
    });
    // 提交后：回收成员子代理驻留（子会话已随团队删除，只能尽量清场）。
    // 锚点按 v6 派生（任务行快照）；无快照退回调用的 captain。
    const anchorId = teamMainSessionOf(fresh);
    const captainAgent = (anchorId !== '' ? env.ctx.agents.get(anchorId) : undefined) ?? captain;
    await drainMembers(env, captainAgent, childIds);
  });
}

/** Helper re-export for tools (slug kept consistent with docs). */
export { sanitizeKey, memberActor, notifyCaptain };
