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
  TaskRecord,
  TeamState,
} from '../model/types.js';
import { locks, teamLockKey } from '../state/lock.js';
import {
  readTeam,
  readTeamSync,
  writeTeamInTx,
  insertTeamRow,
  ensureRolesRowInTx,
  rolesRowByName,
  syncTeamMemberRoleMirrorInTx,
  withTeamTx,
  findTeamByCaptain,
  teamCreatedBy,
  type TeamKey,
  type TeamTx,
} from '../state/store.js';
import { hashName, leaderFlagOf, LEADER_NAME, nextAutoincrementId, personaFromMd, personaToMd, ROOT_ROLE_NAME } from '../state/db.js';
import { insertEventInTx, insertMailInTx } from '../state/events.js';
import { defaultCaptainPersona } from '../prompts/personas/captain.js';
import { applyTransition, sanitizeKey, taskSlug } from '../model/taskMachine.js';
import { ETeamsError, captainActor, memberActor, stateRootOf, type RuntimeEnv } from './base.js';
import { clearSessionTeamForTeam, getSessionTeamId } from './sessionTeam.js';
import { rosterProfilesAcrossWorkspaces } from './workspaces.js';
import { renderTeamDocs, teamWorkDirRel } from './docs.js';
import { findRosterMember, ROLE_BUILDER_NAME, upsertRosterMember } from './roster.js';
import { interruptMember, drainMembers } from './members.js';
import { readBuildPresence } from './roleBuilder.js';
import {
  leaderRowOf,
  latestInstanceRow,
  makeMail,
  memberBoxOf,
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
      // 领队入班底（v7 决策 2）：建队即领工牌——工号就是班底行的自增主键
      // （表自增，新库首行即 1）。v8+：主持行取消（用户迭代 2026-09-08 定案
      // 「领队子会话随大任务生灭」）——领队的会话锚在各大任务的领队副本行
      // 上（createTask 铺副本时烘手册），团队级不再有常驻领队行。
      teamId = insertTeamRow(tx, name, true, now);
      const template = tx.db
        .prepare('SELECT persona_md FROM roles WHERE role_name = ? LIMIT 1')
        .get(LEADER_NAME) as { persona_md: string | null } | undefined;
      const leaderPersona = template?.persona_md
        ? personaFromMd(template.persona_md, LEADER_NAME, LEADER_NAME)
        : defaultCaptainPersona();
      const leaderRoleId = ensureRolesRowInTx(tx, LEADER_NAME, leaderPersona);
      const leaderMemberId = nextAutoincrementId(tx.db, 'team_members');
      tx.db
        .prepare(
          'INSERT INTO team_members (team_member_id, team_id, role_id, is_leader, created_time, update_time) ' +
            'VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(leaderMemberId, teamId, leaderRoleId, leaderFlagOf(LEADER_NAME), now, now);
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
    // 绑定常驻（用户迭代 2026-09-10 锁定语义）：不再随建队清本会话旧绑定
    // ——锁定对话（含面板建队路径）的绑定保持不动；死绑定由 resolveCaller
    // fall-through 与删队清绑兜住（createTeamTool 对健在绑定另有硬守卫）。
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

/**
 * Add one member（v7：一行新班底 + 全任务副本行；不立即起会话）——班底行是
 * 工牌发放处（工号 = 行自增主键，表自增），人设仍挂角色库（成员=角色），
 * 任务副本行建成员即全员铺开（含已完结大任务）。
 */
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
    /** 覆盖路线的目录 provider（v9 回归；添加时通常缺省 = 会话默认）。 */
    provider?: string;
    reasoningEffort?: string;
    /** Pre-generated avatar (docs/14); generated from the name when absent. */
    avatar?: { seed: number; salt: number };
    /** Origin marker for events (tool / panel). */
    via?: string;
  },
): Promise<{ team: TeamState; member: MemberRecord }> {
  const team =
    params.teamId !== undefined
      ? await requireTeamById(env, captain, params.teamId)
      : await requireCaptainTeam(env, captain);
  const { team: fresh, member } = await withTeam(env, team.id, (teamNow, _root, tx) => {
    // 领队就位判据（v8+ 主持行取消）：班底有 is_leader 行即配置了领队。
    if (!teamNow.members.some((m) => m.isLeader === true)) {
      throw new ETeamsError('只有该团队的领队可以添加成员');
    }
    const name = params.name.trim();
    if (name === '') throw new ETeamsError('成员名不能为空');
    if (name === LEADER_NAME) {
      throw new ETeamsError('领队由建队自动入册，不能作为成员添加');
    }
    // 主对话注入角色（v12）：system 的手册是主对话 system 提示词的注入原文，
    // 不是团队成员——面板弹窗已过滤，工具/HTTP 面在此硬拒（唯一收口）。
    if (name === ROOT_ROLE_NAME) {
      throw new ETeamsError('「system」为主对话注入的保留角色，不能加入团队');
    }
    // 团队上限（v7 按班底行数计，领队班底行占 1 个名额）：加一人 = 班底 +1。
    if (teamNow.members.length + 1 > env.config.maxMembers) {
      throw new ETeamsError(
        `团队人数已达上限（${env.config.maxMembers}，含领队）`,
        '先 eteams_remove_member 再添加，或调整配置 maxMembers',
      );
    }
    const now = tx.now;
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
    // 班底行（v7 工牌发放处）：每次添加都是一行新班底——同名成员各拿各的号
    // （人设共享同一角色行），旧版「同名班底复用」分支已废。工号 = 行的
    // 自增主键（表自增，AUTOINCREMENT 只增不复用），显式选号不再支持。
    const memberId = nextAutoincrementId(tx.db, 'team_members');
    const member: MemberRecord = {
      memberId,
      roleId: null, // ensureRolesRowInTx 后回填
      name,
      employeeId: memberId,
      role: persona.role,
      persona,
      modelRoute: routeFromParams(params.provider, params.model, params.reasoningEffort),
      avatar: params.avatar ?? { seed: hashName(name), salt: Math.floor(Math.random() * 1000) },
      createdAt: now,
    };
    teamNow.members.push(member);
    member.roleId = ensureRolesRowInTx(tx, name, persona, {
      ...(member.avatar !== undefined ? { avatar: member.avatar } : {}),
    });
    const route = member.modelRoute;
    // 任务副本（v7 决策 5）：新成员即把班底抄进所有现存大任务（含已完结）
    // ——副本行工号抄班底、待首派起会话；任务级操作按 (工号, 大任务)
    // 定位副本行。
    for (const parent of teamNow.tasks.filter((t) => t.parentId === null)) {
      teamNow.taskMembers.push({
        id: 0,
        teamId: teamNow.id,
        mainTaskId: parent.id,
        nowTaskId: null,
        name,
        employeeId: memberId,
        sessionId: '',
        ...(member.persona.personaMd !== undefined && member.persona.personaMd !== ''
          ? { personaMd: member.persona.personaMd }
          : {}),
        ...(route.model !== '' ? { model: route.model } : {}),
        ...(route.reasoningEffort !== undefined && route.reasoningEffort !== ''
          ? { reasoningEffort: route.reasoningEffort }
          : {}),
        avatar: member.avatar,
        createdAt: now,
      });
    }
    insertEventInTx(tx, teamNow.id, {
      seq: 0,
      at: now,
      actor: captainActor(teamNow),
      type: 'member.added',
      payload: {
        name,
        role: member.role,
        memberId: member.memberId,
        employeeId: memberId,
        ...(params.via !== undefined ? { via: params.via } : {}),
      },
    });
    return { team: teamNow, member };
  });
  renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
  return { team: fresh, member };
}

/**
 * 参数路线 → ModelRouteSnapshot（v9 provider 回归）：provider/model/effort
 * 整组落库——同 id 模型跨提供方（用户实测 tokenrouter/tr-test 都有
 * z-ai/glm-5.3-free）时模型 id 有歧义，显示与 spawn 都按 provider 消歧。
 * provider 缺省（旧客户端/旧数据）= 未记录，读端目录反查兜底。
 */
function routeFromParams(
  provider: string | undefined,
  model: string | undefined,
  effort: string | undefined,
): ModelRouteSnapshot {
  const trimmedProvider = provider?.trim() ?? '';
  const trimmedModel = model?.trim() ?? '';
  const trimmedEffort = effort?.trim() ?? '';
  return {
    model: trimmedModel,
    ...(trimmedModel !== '' && trimmedProvider !== '' ? { provider: trimmedProvider } : {}),
    ...(trimmedModel !== '' && trimmedEffort !== '' ? { reasoningEffort: trimmedEffort } : {}),
  };
}

/** 班底行定位（v7）：工号优先（同名成员各是一行），无号退按名（旧数据）。 */
function requireMemberTemplate(team: TeamState, name: string, employeeId?: number): MemberRecord {
  const member =
    employeeId !== undefined
      ? team.members.find((m) => m.employeeId === employeeId)
      : team.members.find((m) => m.name === name);
  if (!member) throw new ETeamsError(`成员「${name}」不存在`, '用 eteams_team_status 查看在册成员');
  return member;
}

/** Update a member's persona fields (docs/11.2；写班底行 + 角色行手册). */
export async function updateMember(
  env: RuntimeEnv,
  captain: Agent,
  params: {
    teamId?: TeamKey;
    name: string;
    /** v7 同名成员按工号精确定位（缺省按名——旧口径兼容）。 */
    employeeId?: number;
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
    const member = requireMemberTemplate(teamNow, params.name, params.employeeId);
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
    // v7：任务副本行的人设副本在建任务/派发时定版，不再随写同步（班底行是
    // 真相，设计稿 #14 删 staged 同步段）。
    insertEventInTx(tx, teamNow.id, {
      seq: 0,
      at: tx.now,
      actor: captainActor(teamNow),
      type: 'member.updated',
      payload: { name: member.name },
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
 * 有值即 override——provider 整组入档（v9 回归：同 id 模型跨提供方需消歧，
 * spawn 按它传 agentOptions.provider）。写班底行；副本行在建任务/派发时
 * 定版，不再随写同步（v7 #14）；已起会话的成员在下次起会话生效。
 */
export async function setMemberModel(
  env: RuntimeEnv,
  captain: Agent,
  params: {
    teamId?: TeamKey;
    name: string;
    /** v7 同名成员按工号精确定位（缺省按名——旧口径兼容）。 */
    employeeId?: number;
    /** 覆盖路线的目录 provider（v9 回归）：显示与 spawn 消歧用。 */
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
    const member = requireMemberTemplate(teamNow, params.name, params.employeeId);
    member.modelRoute = routeFromParams(params.provider, params.model, params.reasoningEffort);
    insertEventInTx(tx, teamNow.id, {
      seq: 0,
      at: tx.now,
      actor: captainActor(teamNow),
      type: 'member.updated',
      payload: { name: member.name, route: member.modelRoute },
    });
    return teamNow;
  });
  renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
  return fresh;
}

/**
 * Set the 领队 model route（用户迭代 2026-09-04 恢复领队模型选择；v9 存储
 * 位统一到班底领队行 team_members.is_leader=1 的 modelRoute——与成员一致，
 * 用户手改/查看都在 team_members；此前存 task_members 主持行 model 列的
 * 2026-09-04 旧设计废止，主持行只留会话锚 session_id，旧值经 v9 迁移一次性
 * 搬迁）。空 model = 会话默认（settings agent-default-model，spawn 侧
 * sessionDefaultRouteOf）；班底领队行缺失（领队未就位）静默不写。
 */
export async function setLeaderModel(
  env: RuntimeEnv,
  captain: Agent,
  params: {
    teamId?: TeamKey;
    /** 覆盖路线的目录 provider（v9 回归）：显示与 spawn 消歧用。 */
    provider?: string;
    model?: string;
    reasoningEffort?: string;
  },
): Promise<TeamState> {
  const team =
    params.teamId !== undefined
      ? await requireTeamById(env, captain, params.teamId)
      : await requireCaptainTeam(env, captain);
  const route = routeFromParams(params.provider, params.model, params.reasoningEffort);
  const fresh = await withTeam(env, team.id, (teamNow, _root, tx) => {
    const rosterLeader = teamNow.members.find((m) => m.isLeader === true);
    // 班底领队行缺失（领队从未就位）静默不写——维持原口径。
    if (rosterLeader === undefined) return teamNow;
    rosterLeader.modelRoute = route;
    insertEventInTx(tx, teamNow.id, {
      seq: 0,
      at: tx.now,
      actor: captainActor(teamNow),
      type: 'member.updated',
      payload: { name: rosterLeader.name, route },
    });
    return teamNow;
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
    /** v7 同名成员按工号精确定位（缺省按名——旧口径兼容）。 */
    employeeId?: number;
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
    const member = requireMemberTemplate(teamNow, params.name, params.employeeId);
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
 * roster (user iteration 2026-09: the leader is deletable)。v7：移除同时
 * 硬删班底领队行（工牌作废）；加回 = 续新号重开班底行（R7，不回收旧号）。
 * v8+：主持行取消（用户迭代 2026-09-08「领队子会话随大任务生灭」）——
 * 移除/加回收拢为班底配置开关（删/建班底领队行 + hasLeader），各任务的
 * 领队副本行与子会话随任务生灭，不在此处清理。
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
    const rosterRow = teamNow.members.find((m) => m.isLeader === true);
    if (params.removed) {
      // 班底领队行硬删（v7 R7）：号作废不回收；重加领队走加回分支续新号。
      // v8+：主持行取消——移除/加回就是班底配置开关（删/建班底领队行 +
      // hasLeader），各任务的领队副本行与子会话随任务生灭、不在此处清理。
      if (rosterRow === undefined || !teamNow.hasLeader) return teamNow;
      teamNow.members = teamNow.members.filter((m) => m.isLeader !== true);
      teamNow.hasLeader = false;
    } else {
      // 已就位：幂等 no-op（重复「加回」不改任何状态）。
      if (rosterRow !== undefined && teamNow.hasLeader) return teamNow;
      // 加回领队同样占团队名额（v7 按班底行数计）：只在班底缺行时可能触顶。
      if (rosterRow === undefined && teamNow.members.length + 1 > env.config.maxMembers) {
        throw new ETeamsError(
          `团队人数已达上限（${env.config.maxMembers}，含领队）`,
          '先 eteams_remove_member 再加回领队，或调整配置 maxMembers',
        );
      }
      // 班底领队行：缺则重建（重加 = 续自增号新工牌），在册则沿用原号。
      if (rosterRow === undefined) {
        const memberId = nextAutoincrementId(tx.db, 'team_members');
        const rolesRow = rolesRowByName(tx.db, LEADER_NAME);
        const persona =
          rolesRow !== undefined
            ? personaFromMd(rolesRow.persona_md ?? '', LEADER_NAME, LEADER_NAME)
            : defaultCaptainPersona();
        teamNow.members.push({
          memberId,
          roleId: ensureRolesRowInTx(tx, LEADER_NAME, persona),
          name: LEADER_NAME,
          employeeId: memberId, // 工号 = 新班底行自增主键（表自增续编，不回收）
          role: persona.role,
          persona,
          modelRoute: { model: '', reasoningEffort: undefined },
          avatar: { seed: hashName(LEADER_NAME), salt: 7 },
          isLeader: true,
          createdAt: tx.now,
        });
      }
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
 * Remove a member（v7 决策 6）：硬删班底行（工牌作废不回收）；任务副本行
 * 不动（保留历史），在办尝试按副本行 id 精确吊销、任务回就绪池的流程保留；
 * 提交后 interrupt/drain 其子会话（工面由 identity 按「工号不在班底」截断）。
 * 领队走 setLeaderRemoved 的移除语义。
 */
export async function removeMember(
  env: RuntimeEnv,
  captain: Agent,
  name: string,
  teamId?: TeamKey,
  employeeId?: number,
): Promise<TeamState> {
  const team =
    teamId !== undefined
      ? await requireTeamById(env, captain, teamId)
      : await requireCaptainTeam(env, captain);
  if (name === LEADER_NAME) {
    return setLeaderRemoved(env, captain, { teamId: team.id, removed: true });
  }
  let removedEmployeeId: number | undefined;
  const fresh = await withTeam(env, team.id, (teamNow, _root, tx) => {
    // v7 定位：工号优先（同名成员各是一行班底），无号退按名（旧口径兼容）。
    const member =
      employeeId !== undefined
        ? teamNow.members.find((m) => m.employeeId === employeeId)
        : teamNow.members.find((m) => m.name === name);
    if (member === undefined) {
      throw new ETeamsError(`成员「${name}」不存在`, '用 eteams_team_status 查看在册成员');
    }
    removedEmployeeId = member.employeeId;
    const now = tx.now;
    // 该成员的任务副本行 id 集：在办尝试按行 id 精确吊销——同名成员不串。
    const replicaIds = new Set(
      teamNow.taskMembers.filter((r) => r.employeeId === member.employeeId).map((r) => r.id),
    );
    // 在办尝试吊销（docs/06.4）：pending_accept/running → revoked；任务
    // 回就绪池（wait/start → ready，10 态边）。旧尝试无 task_member_id 时
    // 退按名匹配（legacy 宽容）。
    for (const task of teamNow.tasks) {
      const attempt = task.attempts.find(
        (a) =>
          (a.status === 'pending_accept' || a.status === 'running') &&
          (a.taskMemberId !== undefined
            ? replicaIds.has(a.taskMemberId)
            : a.member === member.name),
      );
      if (attempt === undefined) continue;
      attempt.status = 'revoked';
      attempt.endedAt = now;
      // 在办（start）或被派发待接取（ready + 在办 attempt）都归位 ready
      // （用户迭代 2026-09-11：wait 已撤销，派发不再改状态）。
      if (task.status === 'start' || task.status === 'ready') {
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
        payload: { reason: 'member.removed', member: member.name },
      });
    }
    // 硬删班底行（v7）：工牌作废不回收（自增主键只增不复用）；任务副本行
    // 不动。
    teamNow.members = teamNow.members.filter((m) => m !== member);
    insertEventInTx(tx, teamNow.id, {
      seq: 0,
      at: now,
      actor: captainActor(teamNow),
      type: 'member.removed',
      payload: {
        name: member.name,
        ...(member.employeeId !== undefined ? { employeeId: member.employeeId } : {}),
      },
    });
    return teamNow;
  });
  // 提交后：中断并回收该成员全部副本行子会话（回收驻留 Activation，docs/20.4
  // P2）。锚点按 v6 派生（任务行快照 + 心跳兜底）；都不在线退回调用的 captain。
  const anchorId = teamMainSessionOf(fresh) || readBuildPresence(stateRootOf(env))?.sessionId || '';
  const captainAgent = (anchorId !== '' ? env.ctx.agents.get(anchorId) : undefined) ?? captain;
  for (const row of fresh.taskMembers) {
    if (row.employeeId !== removedEmployeeId || row.sessionId === '') continue;
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
      // v7 收件人按工号定位（同名不串箱）：to 允许工号十进制串（面板路由），
      // 也兼容旧成员名（无同名冲突时按名解析）。工牌已删的工号按「不存在」
      // 拒收——删除成员后副本行仍按留档保留，按号直查会命中死行，这里以
      // 班底行为准（工牌在册才收），邮件不落旧箱，防新人继承旧号后串箱。
      const numeric = Number.parseInt(to.trim(), 10);
      const isNumericRef =
        Number.isFinite(numeric) && numeric > 0 && String(numeric) === to.trim();
      if (isNumericRef && !fresh.members.some((m) => m.employeeId === numeric)) {
        throw new ETeamsError(
          `收件人 ET${String(numeric).padStart(4, '0')} 不在本队班底（已离职或不存在）`,
          '用 eteams_team_status 查看在册成员工号',
        );
      }
      const byId = isNumericRef
        ? fresh.taskMembers.find((r) => r.employeeId === numeric)
        : undefined;
      const member = byId ?? requireMember(fresh, to);
      const box = memberBoxOf(member);
      insertMailInTx(
        tx,
        fresh.id,
        box.box,
        makeMail(from, { kind: 'member', name: member.name }, 'notice', content, refs),
        box.employeeId,
      );
      const wakeRow = latestInstanceRow(fresh, member.employeeId ?? member.name);
      if (wakeRow !== undefined) {
        wakes.push(() =>
          wakeMember(env, fresh, wakeRow, `[来自 ${from.name ?? from.kind}] ${content}`),
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
  // 成员一句话简介（用户迭代 2026-09-08「去掉 role、把角色 profile 加进
  // 来」）：v7 成员名=角色名，role 与 name 冗余；profile 的 live 源是角色库
  // profile 列（跨工作区兜底），班底行烘焙的旧简介作回退，两处都无则 null。
  const profiles = rosterProfilesAcrossWorkspaces(env.ctx, env.config, env.workspace);
  return {
    id: team.id,
    name: team.name,
    hasLeader: team.hasLeader,
    members: team.members
      // v7 领队也是一行班底（普通成员）：不再过滤，工牌/简介照常透出。
      // 团队现状精简（用户迭代 2026-09-03「团队现状太繁杂了」；2026-09-10
      // 「成员没有状态」再撤 status）：成员只带工号/一句话简介；在忙什么可
      // 从 tasks 的 assignee+status 读出，模型路线属于派发细节。
      // name 保留：eteams_* 工具按工号/成员名指派，没有名字工号无法落地。
      .map((m): JsonValue => {
        const fromRoster = profiles.get(m.name);
        const baked = m.persona.profile;
        const profile =
          fromRoster !== undefined && fromRoster !== ''
            ? fromRoster
            : baked !== undefined && baked !== ''
              ? baked
              : null;
        return {
          name: m.name,
          employeeId: m.employeeId ?? null,
          profile,
        };
      }),
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
      (t) => t.status === 'start' || t.status === 'paused' || t.status === 'wait_user',
    );
    if (active.length > 0) {
      throw new ETeamsError(
        `存在未收尾的任务（${active.map((t) => `#${t.id}`).join('、')}），不能直接删除`,
        '先 eteams_cancel_task 取消任务，再删除团队',
      );
    }
    const childIds = fresh.taskMembers.map((r) => r.sessionId);
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
    // 提交后：清掉指向本队的会话绑定（用户迭代 2026-09-10 锁定语义的逃生
    // 口——团队没了，绑定它的对话解锁，客户端徽章经快照失联回可选状态）。
    clearSessionTeamForTeam(String(fresh.id));
    // 提交后：回收成员子代理驻留（子会话已随团队删除，只能尽量清场）。
    // 锚点按 v6 派生（任务行快照）；无快照退回调用的 captain。
    const anchorId = teamMainSessionOf(fresh);
    const captainAgent = (anchorId !== '' ? env.ctx.agents.get(anchorId) : undefined) ?? captain;
    await drainMembers(env, captainAgent, childIds);
  });
}

/** Helper re-export for tools (slug kept consistent with docs). */
export { sanitizeKey, memberActor, notifyCaptain };
