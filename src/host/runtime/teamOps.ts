/**
 * Team-level operations (docs/07.2): create → plan → approve → run, member
 * roster management, mailbox messaging, and read-only views. Every mutation
 * runs inside the team lock with events-then-snapshot ordering (docs/09.2).
 *
 * @module dsh-eteams/runtime/teamOps
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { JsonValue } from '@deepseek-ai/dsh-session';
import { mergePersona, defaultPersonaFor } from '../prompts/persona.js';
import type { Actor, MemberRecord, ModelRouteSnapshot, TeamState } from '../model/types.js';
import { locks, teamLockKey } from '../state/lock.js';
import {
  readTeam,
  writeTeam,
  allocateTeamDir,
  findTeamByCaptain,
  listTeams,
} from '../state/store.js';
import { recordEvent } from '../state/events.js';
import { sanitizeKey } from '../model/taskMachine.js';
import { ETeamsError, captainActor, memberActor, stateRootOf, type RuntimeEnv } from './base.js';
import { clearSessionTeam } from './sessionTeam.js';
import { renderTeamDocs, teamWorkDirRel } from './docs.js';
import {
  allocateEmployeeId,
  findRosterMember,
  LEADER_NAME,
  ROLE_BUILDER_NAME,
  upsertRosterMember,
} from './roster.js';
import { spawnTeamMembers, interruptMember, drainMembers } from './members.js';
import { deliverMail, notifyCaptain, readBox, requireMember, wakeMember } from './notifier.js';

/** Read one team under its lock and hand it to `fn` for mutation. */
export async function withTeam<T>(
  env: RuntimeEnv,
  teamId: string,
  fn: (team: TeamState, root: string) => Promise<T>,
): Promise<T> {
  const root = stateRootOf(env);
  return locks.withLock(teamLockKey(root, teamId), async () => {
    const team = await readTeam(root, teamId);
    if (!team)
      throw new ETeamsError(
        `团队「${teamId}」不存在`,
        '用 eteams_team_status 查看当前团队，或先 eteams_create_team',
      );
    return fn(team, root);
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

/** Create a team (docs/07.2 step 1-2). approval=automatic skips staging. */
export async function createTeam(
  env: RuntimeEnv,
  captain: Agent,
  params: {
    name: string;
    goal: string;
    approval?: 'required' | 'automatic';
    questionnaire?: string[];
    maxRetries?: number;
    /** Origin marker for events (tool / panel). */
    via?: string;
  },
): Promise<TeamState> {
  const root = stateRootOf(env);
  return locks.withLock(`captain:${root}:${String(captain.id)}`, async () => {
    const existing = await findTeamByCaptain(root, String(captain.id));
    if (existing && existing.phase !== 'completed' && existing.phase !== 'halted') {
      throw new ETeamsError(
        `你已领队「${existing.name}」（${existing.phase}）`,
        '一个领队同时只带一个团队；先完成或归档现有团队',
      );
    }
    const id = await allocateTeamDir(root, params.name);
    const now = Date.now();
    const team: TeamState = {
      schemaVersion: 2,
      id,
      name: params.name.trim(),
      goal: params.goal.trim(),
      captainSessionId: String(captain.id),
      phase: 'staged',
      planReviewState: 'awaiting_review',
      createdAt: now,
      updatedAt: now,
      version: 0,
      taskSeq: 0,
      attemptSeq: 0,
      mailSeq: 0,
      maxRetries: params.maxRetries ?? env.config.maxRetries,
      members: [],
      tasks: [],
      pendingDecisions: [],
    };
    await recordEvent(root, id, captainActor(team), 'team.created', {
      payload: {
        name: team.name,
        goal: team.goal,
        approval: params.approval ?? 'required',
        ...(params.via !== undefined ? { via: params.via } : {}),
      },
    });
    if (params.questionnaire && params.questionnaire.length > 0) {
      await recordEvent(root, id, captainActor(team), 'plan.questionnaire', {
        payload: { questions: params.questionnaire },
      });
    }
    await writeTeam(root, team);
    // 绑定让位（docs/26 绑定即可驱动）：resolveCaller 绑定优先——刚建的
    // 新队以本会话为领队，若本会话还绑着旧团队，旧绑定会遮蔽新队（工具
    // 全落到旧队上）。建队成功即清除本会话的旧绑定。
    clearSessionTeam(String(captain.id));
    if (params.approval === 'automatic') {
      const fresh = await readTeam(root, id);
      if (fresh) return approvePlan(env, captain, fresh.id);
    }
    return (await readTeam(root, id))!;
  });
}

/**
 * 幂等分配团队工作目录（D12, docs/26）：已分配则原样复用；未分配时与其他
 * 团队的工作目录消歧（目录名冲突/已存在即加 -2、-3 后缀）。approvePlan 与
 * 对话提交路径共用（staged 团队首次提交任务即物化目录树）；调用方负责把
 * 返回值写回 team.workDir。
 */
export async function ensureWorkDir(env: RuntimeEnv, team: TeamState): Promise<string> {
  if (team.workDir) return team.workDir;
  const root = stateRootOf(env);
  const base = teamWorkDirRel(team);
  const others = await listTeams(root);
  const taken = new Set(others.filter((t) => t.id !== team.id).map((t) => t.workDir));
  let workDir = base;
  if (taken.has(workDir) || existsSync(join(env.workspace, workDir))) {
    let n = 2;
    while (taken.has(`${base}-${n}`)) n++;
    workDir = `${base}-${n}`;
  }
  return workDir;
}

/** Approve a staged plan (user/panel action; NEVER a captain tool, docs/11). */
export async function approvePlan(
  env: RuntimeEnv,
  captain: Agent,
  teamId: string,
): Promise<TeamState> {
  return withTeam(env, teamId, async (team, root) => {
    if (team.captainSessionId !== String(captain.id))
      throw new ETeamsError('只有该团队的领队会话可以批准');
    if (team.phase !== 'staged') throw new ETeamsError(`团队处于 ${team.phase}，无需批准`);
    // Work dir allocation (D12/26): idempotent allocation — a staged team that
    // already materialized a dir via submitted conversation tasks reuses it.
    team.workDir = await ensureWorkDir(env, team);
    // Tasks: draft → ready (docs/06.2 approve edge).
    const now = Date.now();
    for (const task of team.tasks) {
      if (task.status === 'draft') {
        task.status = 'ready';
        task.updatedAt = now;
        await recordEvent(root, team.id, captainActor(team), 'task.ready', {
          taskId: task.id,
          payload: { via: 'plan.approved' },
        });
      }
    }
    await recordEvent(root, team.id, captainActor(team), 'plan.approved', {
      payload: { workDir: team.workDir },
    });
    // Spawn all staged members atomically (rollback keeps them staged).
    await spawnTeamMembers(env, team, captain);
    team.phase = 'running';
    team.planReviewState = 'approved';
    await writeTeam(root, team);
    renderTeamDocs(env.workspace, team, (msg) => env.ctx.logger.warn(msg));
    return team;
  });
}

/** Add one member (staged plan or running team, FR-15). */
export async function addMember(
  env: RuntimeEnv,
  captain: Agent,
  params: {
    teamId?: string;
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
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    /** Pre-generated avatar (docs/14); generated from the name when absent. */
    avatar?: { seed: number; salt: number };
    /**
     * 工号 (docs/21). Callers that already resolved a roster entry pass its
     * 工号 through; otherwise one is adopted from the roster, freshly
     * allocated, or (for entry-less adds) allocated new.
     */
    employeeId?: string;
    /** Origin marker for events (tool / panel). */
    via?: string;
  },
): Promise<{ team: TeamState; member: MemberRecord }> {
  const resolve = async (): Promise<TeamState> => {
    if (params.teamId) {
      const t = await readTeam(stateRootOf(env), params.teamId);
      if (!t) throw new ETeamsError(`团队「${params.teamId}」不存在`);
      if (t.captainSessionId !== String(captain.id))
        throw new ETeamsError('只有该团队的领队可以添加成员');
      return t;
    }
    return requireCaptainTeam(env, captain);
  };
  const team = await resolve();
  return withTeam(env, team.id, async (fresh, root) => {
    if (fresh.captainSessionId !== String(captain.id))
      throw new ETeamsError('只有该团队的领队可以添加成员');
    const name = params.name.trim();
    if (name === '') throw new ETeamsError('成员名不能为空');
    if (fresh.members.some((m) => m.name === name && m.status !== 'removed')) {
      throw new ETeamsError(`成员「${name}」已在团队中`);
    }
    const active = fresh.members.filter((m) => m.status !== 'removed');
    // 团队上限（用户迭代 2026-09 六：领队也算成员）——「一个团队 10 个人」
    // 含领队：领队初始化时默认拉进团、占 1 个名额；移出领队（leaderRemoved）
    // 空出的名额可以补成员。看板/团队页/添加弹窗的计数同口径。
    const leaderTaken = fresh.leaderRemoved === true ? 0 : 1;
    if (active.length + leaderTaken >= env.config.maxMembers) {
      throw new ETeamsError(
        `团队人数已达上限（${env.config.maxMembers}，含领队）`,
        '先 eteams_remove_member 再添加，或调整配置 maxMembers',
      );
    }
    const route: ModelRouteSnapshot =
      params.provider && params.model
        ? {
            provider: params.provider,
            model: params.model,
            ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
            source: 'override',
          }
        : { provider: 'inherit', model: 'inherit', source: 'inherited' };
    // 工号（docs/21）：显式传入 > 角色库同号采纳 > 新分配。角色库条目缺号时
    //（旧版数据）分配后回填角色库，保证同名成员在角色库与各团队共号。
    const rosterEntry = findRosterMember(root, name);
    let employeeId = params.employeeId ?? rosterEntry?.employeeId;
    if (employeeId === undefined || employeeId === '') {
      employeeId = await allocateEmployeeId(root);
      if (rosterEntry !== undefined && name !== LEADER_NAME && name !== ROLE_BUILDER_NAME) {
        await upsertRosterMember(root, { ...rosterEntry, employeeId }).catch(() => undefined);
      }
    }
    const member: MemberRecord = {
      id: '',
      name,
      employeeId,
      role: params.role.trim() || 'member',
      persona: mergePersona(defaultPersonaFor(name, params.role, params.executionPrompt), {
        ...(params.duty !== undefined ? { duty: params.duty } : {}),
        ...(params.style !== undefined ? { style: params.style } : {}),
        ...(params.skills !== undefined ? { skills: params.skills } : {}),
        ...(params.rules !== undefined ? { rules: params.rules } : {}),
        ...(params.personaMd !== undefined ? { personaMd: params.personaMd } : {}),
      }),
      modelRoute: route,
      status: 'staged',
      avatar: params.avatar ?? { seed: hashName(name), salt: Math.floor(Math.random() * 1000) },
      createdAt: Date.now(),
    };
    fresh.members.push(member);
    await recordEvent(root, fresh.id, captainActor(fresh), 'member.added', {
      payload: {
        name,
        role: member.role,
        route,
        ...(params.via !== undefined ? { via: params.via } : {}),
      },
    });
    if (fresh.phase === 'running') {
      // FR-15 mid-run addition: spawn immediately.
      const captainAgent = env.ctx.agents.get(fresh.captainSessionId) ?? captain;
      await spawnTeamMembers(env, fresh, captainAgent);
      await recordEvent(root, fresh.id, captainActor(fresh), 'member.spawned', {
        payload: { name, childId: member.id },
      });
    }
    await writeTeam(root, fresh);
    renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
    return { team: fresh, member };
  });
}

function hashName(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) | 0;
  return Math.abs(h) % 997;
}

/** Update a member's persona fields (docs/11.2). */
export async function updateMember(
  env: RuntimeEnv,
  captain: Agent,
  params: {
    teamId?: string;
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
  const team = params.teamId
    ? await requireTeamById(env, captain, params.teamId)
    : await requireCaptainTeam(env, captain);
  return withTeam(env, team.id, async (fresh, root) => {
    const member = requireMember(fresh, params.name);
    if (params.role !== undefined) member.role = params.role.trim() || member.role;
    member.persona = mergePersona(member.persona, {
      duty: params.duty,
      style: params.style,
      skills: params.skills,
      rules: params.rules,
      executionPrompt: params.executionPrompt,
      personaMd: params.personaMd,
    });
    await recordEvent(root, fresh.id, captainActor(fresh), 'member.updated', {
      payload: { name: params.name },
    });
    await writeTeam(root, fresh);
    renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
    return fresh;
  });
}

/**
 * Set one member's model route (user iteration 2026-09: per-member model
 * select on the member card). Empty provider/model resets to inherited;
 * otherwise stores an override - staged members adopt it at spawn, running
 * members on their next respawn.
 */
export async function setMemberModel(
  env: RuntimeEnv,
  captain: Agent,
  params: {
    teamId?: string;
    name: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
  },
): Promise<TeamState> {
  const team = params.teamId
    ? await requireTeamById(env, captain, params.teamId)
    : await requireCaptainTeam(env, captain);
  return withTeam(env, team.id, async (fresh, root) => {
    const member = requireMember(fresh, params.name);
    const route: ModelRouteSnapshot =
      params.provider !== undefined &&
      params.provider !== '' &&
      params.model !== undefined &&
      params.model !== ''
        ? {
            provider: params.provider,
            model: params.model,
            ...(params.reasoningEffort !== undefined && params.reasoningEffort !== ''
              ? { reasoningEffort: params.reasoningEffort }
              : {}),
            source: 'override',
          }
        : { provider: 'inherit', model: 'inherit', source: 'inherited' };
    member.modelRoute = route;
    await recordEvent(root, fresh.id, captainActor(fresh), 'member.updated', {
      payload: { name: params.name, route },
    });
    await writeTeam(root, fresh);
    renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
    return fresh;
  });
}

/**
 * Sync a member's own handbook copy back to its roster role (用户迭代 2026-09
 * 四：成员详情与角色详情是两份独立数据——加入团队时复制一份，之后各自演
 * 化；这里把成员当前手册写回角色库同名角色). An existing roster entry keeps
 * every other field (only personaMd is overwritten); a member without a
 * roster entry (e.g. -2 副本) gets one created from the member record. The
 * member's own copy is filled in when it was still empty (旧数据成员）。
 */
export async function syncMemberToRoster(
  env: RuntimeEnv,
  captain: Agent,
  params: {
    teamId?: string;
    name: string;
    /** Sync payload; defaults to the member's own saved handbook copy. */
    personaMd?: string;
  },
): Promise<TeamState> {
  const team = params.teamId
    ? await requireTeamById(env, captain, params.teamId)
    : await requireCaptainTeam(env, captain);
  return withTeam(env, team.id, async (fresh, root) => {
    const member = requireMember(fresh, params.name);
    const text = (params.personaMd ?? member.persona.personaMd ?? '').trim();
    if (text === '') {
      throw new ETeamsError('成员手册为空，先在成员详情里编辑保存');
    }
    const existing = findRosterMember(root, member.name);
    if (existing !== undefined) {
      // 已有同名角色：只覆盖手册，其余字段（职责风格/工号/头像）原样保留。
      // 用户迭代 2026-09-03：成员详情「同步到该角色」是显式用户动作，领队
      // 同样放行（与角色详情编辑一致，allowLeader 语义见 roster.ts）。
      await upsertRosterMember(root, { ...existing, personaMd: text }, { allowLeader: true });
    } else if (member.name !== LEADER_NAME && member.name !== ROLE_BUILDER_NAME) {
      // 无同名角色（副本成员等）：按成员记录新建角色库条目。
      await upsertRosterMember(root, {
        name: member.name,
        role: member.role,
        personaMd: text,
        ...(member.avatar !== undefined ? { avatar: member.avatar } : {}),
      });
    } else {
      throw new ETeamsError('系统保留角色不同步到角色库');
    }
    // 成员自己还没有手册副本（旧数据）：同步即补齐，详情从此独立可改。
    if (member.persona.personaMd !== text) {
      member.persona = mergePersona(member.persona, { personaMd: text });
    }
    await recordEvent(root, fresh.id, captainActor(fresh), 'member.synced_roster', {
      payload: { name: member.name },
    });
    await writeTeam(root, fresh);
    renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
    return fresh;
  });
}

/**
 * Move the leader (Project Shepherd) out of / back into the team's member
 * roster (user iteration 2026-09: the leader is deletable). The captain
 * session itself is untouched - this flag only controls whether the leader
 * card joins the member grid; re-add via the panel's add-member flow.
 */
export async function setLeaderRemoved(
  env: RuntimeEnv,
  captain: Agent,
  params: { teamId?: string; removed: boolean },
): Promise<TeamState> {
  const team = params.teamId
    ? await requireTeamById(env, captain, params.teamId)
    : await requireCaptainTeam(env, captain);
  return withTeam(env, team.id, async (fresh, root) => {
    if (fresh.leaderRemoved === params.removed) return fresh;
    // 加回领队同样占团队名额（用户迭代 2026-09 六：领队也算成员）：满员时
    // 拒绝加回，先移出一名成员。
    if (!params.removed) {
      const active = fresh.members.filter((m) => m.status !== 'removed');
      if (active.length + 1 > env.config.maxMembers) {
        throw new ETeamsError(
          `团队人数已达上限（${env.config.maxMembers}，含领队）`,
          '先 eteams_remove_member 再加回领队，或调整配置 maxMembers',
        );
      }
    }
    fresh.leaderRemoved = params.removed;
    await recordEvent(
      root,
      fresh.id,
      captainActor(fresh),
      'leader.' + (params.removed ? 'removed' : 'restored'),
      {
        payload: {},
      },
    );
    await writeTeam(root, fresh);
    renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
    return fresh;
  });
}

/**
 * Set the leader's model route (user iteration 2026-09: the leader picks a
 * model too). The leader IS the panel session agent — its own session model
 * is never switched; this route is the team default that members running on
 * 「跟随领队」resolve to at spawn (unset → session default). Empty
 * provider/model clears the override back to inherited.
 */
export async function setLeaderModel(
  env: RuntimeEnv,
  captain: Agent,
  params: {
    teamId?: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
  },
): Promise<TeamState> {
  const team = params.teamId
    ? await requireTeamById(env, captain, params.teamId)
    : await requireCaptainTeam(env, captain);
  return withTeam(env, team.id, async (fresh, root) => {
    const route: ModelRouteSnapshot =
      params.provider !== undefined &&
      params.provider !== '' &&
      params.model !== undefined &&
      params.model !== ''
        ? {
            provider: params.provider,
            model: params.model,
            ...(params.reasoningEffort !== undefined && params.reasoningEffort !== ''
              ? { reasoningEffort: params.reasoningEffort }
              : {}),
            source: 'override',
          }
        : { provider: 'inherit', model: 'inherit', source: 'inherited' };
    fresh.leaderModelRoute = route;
    await recordEvent(root, fresh.id, captainActor(fresh), 'leader.updated', {
      payload: { route },
    });
    await writeTeam(root, fresh);
    renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
    return fresh;
  });
}

/** Remove a member: staged drop, or revoke work + interrupt when running. */
export async function removeMember(
  env: RuntimeEnv,
  captain: Agent,
  name: string,
  teamId?: string,
): Promise<TeamState> {
  const team = teamId
    ? await requireTeamById(env, captain, teamId)
    : await requireCaptainTeam(env, captain);
  return withTeam(env, team.id, async (fresh, root) => {
    const member = requireMember(fresh, name);
    const now = Date.now();
    if (member.currentAttemptId) {
      // Revoke open work (docs/06.4): attempt revoked, task back to ready.
      const task = fresh.tasks.find((t) => t.currentAttemptId === member.currentAttemptId);
      if (task) {
        const attempt = task.attempts.find((a) => a.id === member.currentAttemptId);
        if (attempt && (attempt.status === 'pending_accept' || attempt.status === 'running')) {
          attempt.status = 'revoked';
          attempt.endedAt = now;
        }
        if (
          task.status === 'assigned' ||
          task.status === 'in_progress' ||
          task.status === 'retrying'
        ) {
          task.status = 'ready';
          task.assignee = undefined;
          task.currentAttemptId = undefined;
          task.updatedAt = now;
        }
        await recordEvent(root, fresh.id, captainActor(fresh), 'task.unassigned', {
          taskId: task.id,
          attemptId: member.currentAttemptId,
          payload: { reason: 'member.removed', member: name },
        });
      }
    }
    if (member.status !== 'staged' && member.id) {
      const captainAgent = env.ctx.agents.get(fresh.captainSessionId) ?? captain;
      interruptMember(env, member, captainAgent);
      // 回收驻留 Activation（docs/20.4 P2）：live 注册表立刻干净、不可再被
      // 唤醒；持久记录随父会话回收。旧运行时无 drain API 时静默降级。
      await drainMembers(env, captainAgent, [member.id]);
    }
    member.status = 'removed';
    member.currentAttemptId = undefined;
    member.removedAt = now;
    await recordEvent(root, fresh.id, captainActor(fresh), 'member.removed', { payload: { name } });
    await writeTeam(root, fresh);
    renderTeamDocs(env.workspace, fresh, (msg) => env.ctx.logger.warn(msg));
    return fresh;
  });
}

async function requireTeamById(
  env: RuntimeEnv,
  captain: Agent,
  teamId: string,
): Promise<TeamState> {
  const team = await readTeam(stateRootOf(env), teamId);
  if (!team) throw new ETeamsError(`团队「${teamId}」不存在`);
  if (team.captainSessionId !== String(captain.id))
    throw new ETeamsError('只有该团队的领队可以执行此操作');
  return team;
}

/** Captain → member or member → captain/member message (docs/09.1). */
export async function sendMessage(
  env: RuntimeEnv,
  team: TeamState,
  from: Actor,
  to: string,
  content: string,
  refs: { taskId?: string } = {},
): Promise<void> {
  return withTeam(env, team.id, async (fresh, root) => {
    if (to === 'captain') {
      const captainAgent = env.ctx.agents.get(fresh.captainSessionId);
      await deliverMail(env, fresh, 'captain', {
        id: `m${Date.now().toString(36)}`,
        seq: readBox(env, fresh.id, 'captain').length + 1,
        at: Date.now(),
        from,
        to: { kind: 'captain', name: '领队' },
        kind: from.kind === 'user' ? 'user_message' : 'report',
        taskId: refs.taskId,
        content,
      });
      if (captainAgent) {
        try {
          const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
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
      const member = requireMember(fresh, to);
      await deliverMail(env, fresh, member.name, {
        id: `m${Date.now().toString(36)}`,
        seq: readBox(env, fresh.id, member.name).length + 1,
        at: Date.now(),
        from,
        to: { kind: 'member', name: member.name },
        kind: 'notice',
        taskId: refs.taskId,
        content,
      });
      await wakeMember(env, fresh, member, `[来自 ${from.name ?? from.kind}] ${content}`);
    }
    await recordEvent(root, fresh.id, from, 'message.sent', {
      taskId: refs.taskId,
      payload: { to, length: content.length },
    });
  });
}

/** Read-only team view used by both tool faces (JSON-safe for tool output). */
export function teamView(env: RuntimeEnv, team: TeamState): Record<string, JsonValue> {
  return {
    id: team.id,
    name: team.name,
    goal: team.goal,
    phase: team.phase,
    planReviewState: team.planReviewState ?? null,
    workDir: team.workDir ?? null,
    members: team.members
      .filter((m) => m.status !== 'removed')
      // 团队现状精简（用户迭代 2026-09-03「团队现状太繁杂了，目前只需要
      // 知道工号和角色和状态就行」）：成员只带 工号/角色/状态，route 与
      // currentTask 去掉——currentTask 可从 tasks 的 assignee+status 读出，
      // 模型路线属于派发细节，不进领队快照。name 保留：eteams_* 工具按
      // 成员名指派，没有名字工号无法落地。
      .map((m): JsonValue => ({
        name: m.name,
        employeeId: m.employeeId ?? null,
        role: m.role,
        status: m.status,
      })),
    tasks: team.tasks.map((t): JsonValue => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      assignee: t.assignee ?? null,
      chain: t.chain.length,
      cursor: t.chainCursor,
      kind: t.kind ?? 'task',
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

/** Archive a completed/halted team (docs/09.1 archive/<id>). */
export async function archiveTeam(
  env: RuntimeEnv,
  captain: Agent,
  teamId: string,
): Promise<string> {
  const team = await requireTeamById(env, captain, teamId);
  return withTeam(env, team.id, async (fresh, root) => {
    if (fresh.phase !== 'completed' && fresh.phase !== 'halted') {
      throw new ETeamsError('只能归档 completed/halted 团队', '先取消全部任务或等待团队完成');
    }
    // 回收全部成员的驻留 Activation（docs/20.4 P2）：完结团队不应有可唤醒
    // 的成员留在 live 注册表；持久记录随父对话回收。旧运行时静默降级。
    const captainAgent = env.ctx.agents.get(fresh.captainSessionId) ?? captain;
    await drainMembers(
      env,
      captainAgent,
      fresh.members.map((m) => m.id),
    );
    await recordEvent(root, fresh.id, captainActor(fresh), 'team.archived', {});
    const dest = join(root, 'archive');
    mkdirSync(dest, { recursive: true });
    const target = join(dest, fresh.id);
    if (existsSync(target)) throw new ETeamsError(`归档目录 ${target} 已存在`);
    renameSync(join(root, fresh.id), target);
    return target;
  });
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

/** Delete a staged/completed team directory permanently. */
export async function deleteTeam(env: RuntimeEnv, captain: Agent, teamId: string): Promise<void> {
  const team = await requireTeamById(env, captain, teamId);
  return withTeam(env, team.id, async (fresh, root) => {
    if (!['staged', 'completed', 'halted'].includes(fresh.phase)) {
      throw new ETeamsError('running 团队不能直接删除', '先取消任务（cancel_task）或停止团队');
    }
    const captainAgent = env.ctx.agents.get(fresh.captainSessionId) ?? captain;
    await drainMembers(
      env,
      captainAgent,
      fresh.members.map((m) => m.id),
    );
    rmTree(join(root, fresh.id));
  });
}

/** Helper re-export for tools (slug kept consistent with docs). */
export { sanitizeKey, memberActor, notifyCaptain };
