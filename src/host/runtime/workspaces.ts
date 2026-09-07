/**
 * Workspace registry access + registry-wide team location (docs/26 跨工作区).
 *
 * 面板与「团队绑定」band 早就按注册表在**全部已注册工作区**里定位团队
 * （webui locateTeam），而工具层长期只看调用会话自己的工作区
 * （envForAgent → agent.session.cwd）——会话项目目录 ≠ 团队所在工作区时
 * （用户迭代 2026-09-03：团队建在主工作区、会话开在 test 目录），band 显示
 * 「生效中」、工具却报「当前会话不在任何 eteams 团队中」。本模块把注册表
 * 访问与跨工作区定位收敛为一处，供 webui 与工具层共用：identity.ts
 * envForAgent 按 绑定 → 领队 → 成员 的既有优先级定位本会话身份对应的团队，
 * 命中别的工作区即把 env 重指过去（状态根、文档渲染、workDir 全部以团队
 * 所在工作区为准）；成员派生自驱动会话、其会话 cwd 无法覆盖，成员侧同样
 * 靠这次重指拿到正确的状态根。
 *
 * @module dsh-eteams/host/runtime/workspaces
 */
import { existsSync } from 'node:fs';
import { getDb } from '../state/db.js';
import { ensureWorkspaceReady } from '../state/import.js';
import { stateRootFor } from './base.js';
import { readTeamSync } from '../state/store.js';
import { findRosterMember, readRoster, type RosterMember } from './roster.js';
import type { TeamState } from '../model/types.js';
import type { ETeamsResolvedConfig } from '../config.js';

/** Workspace registry service key candidates, newest first (mirror webui). */
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'] as const;

/** Minimal structural view of the workspace registry service. */
export interface WorkspaceRegistryLike {
  list(): { path: string; title: string }[];
}

/**
 * Read the registry service off a host context. Feature-detected (`ctx.get`)
 * so callers without the service (unit fakes, older runtimes) degrade to
 * own-workspace-only behavior.
 */
export function workspaceRegistryOf(ctx: unknown): WorkspaceRegistryLike | undefined {
  const get = (ctx as { get?: (key: string) => unknown }).get;
  if (typeof get !== 'function') return undefined;
  return (get.call(ctx, WORKSPACE_KEYS[0]) ?? get.call(ctx, WORKSPACE_KEYS[1])) as
    WorkspaceRegistryLike | undefined;
}

/** One team located on disk, with the workspace (and state root) holding it. */
export interface LocatedTeam {
  readonly team: TeamState;
  readonly root: string;
  readonly workspacePath: string;
}

/** Live team ids under one state root（team 表自增号升序，docs/27）。 */
function listTeamIdsSync(stateRoot: string): number[] {
  try {
    const db = getDb(stateRoot);
    ensureWorkspaceReady(stateRoot, db);
    return (
      db.prepare('SELECT team_id FROM team ORDER BY team_id').all() as Array<{ team_id: number }>
    ).map((r) => r.team_id);
  } catch {
    return [];
  }
}

/** Deduplicated probe order: the caller's own workspace first, then the rest. */
function probeOrder(ownWorkspace: string, registry: WorkspaceRegistryLike | undefined): string[] {
  const workspaces: string[] = [];
  const push = (path: string): void => {
    if (path !== '' && !workspaces.includes(path)) workspaces.push(path);
  };
  push(ownWorkspace);
  if (registry) for (const ws of registry.list()) push(ws.path);
  return workspaces;
}

function teamByIdIn(
  workspaces: string[],
  config: Pick<ETeamsResolvedConfig, 'stateDir'>,
  teamId: string,
): LocatedTeam | undefined {
  for (const ws of workspaces) {
    const root = stateRootFor(config, ws);
    const team = readTeamSync(root, teamId);
    if (team) return { team, root, workspacePath: ws };
  }
  return undefined;
}

function teamMatchingIn(
  workspaces: string[],
  config: Pick<ETeamsResolvedConfig, 'stateDir'>,
  match: (team: TeamState) => boolean,
): LocatedTeam | undefined {
  for (const ws of workspaces) {
    const root = stateRootFor(config, ws);
    for (const id of listTeamIdsSync(root)) {
      const team = readTeamSync(root, id);
      if (team && match(team)) return { team, root, workspacePath: ws };
    }
  }
  return undefined;
}

/**
 * Locate a team by id across registered workspaces (live readTeamSync) — the
 * shared core of webui.locateTeam.
 */
export function locateTeamAcrossWorkspaces(
  ctx: unknown,
  config: Pick<ETeamsResolvedConfig, 'stateDir'>,
  teamId: string,
): LocatedTeam | undefined {
  const registry = workspaceRegistryOf(ctx);
  if (!registry) return undefined;
  return teamByIdIn(
    registry.list().map((ws) => ws.path),
    config,
    teamId,
  );
}

/**
 * 成员库条目跨工作区兜底（用户迭代 2026-09-04）：角色库固定落在
 * writeWorkspacePath（注册表首个有 eteams 状态的工作区），而团队可建在任意
 * 工作区（docs/26 跨工作区）——团队所在工作区的 member 表没有该条目时，按
 * 注册表顺序逐工作区兜底查找，命中处连状态根一起返回（工号回填等写回应以
 * 条目所在工作区为准，避免把别区的条目复制成重复行）。
 */
export function findRosterMemberAcrossWorkspaces(
  ctx: unknown,
  config: Pick<ETeamsResolvedConfig, 'stateDir'>,
  name: string,
  preferWorkspacePath?: string,
): { entry: RosterMember; root: string; workspacePath: string } | undefined {
  const probe = (workspacePath: string) => {
    const root = stateRootFor(config, workspacePath);
    const entry = findRosterMember(root, name);
    return entry !== undefined ? { entry, root, workspacePath } : undefined;
  };
  if (preferWorkspacePath !== undefined && preferWorkspacePath !== '') {
    const own = probe(preferWorkspacePath);
    if (own !== undefined) return own;
  }
  const registry = workspaceRegistryOf(ctx);
  if (!registry) return undefined;
  for (const workspace of registry.list()) {
    const found = probe(workspace.path);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * 角色库权威状态根（writeWorkspacePath 同口径，自 webui 上收——runtime 内
 * 共用，避免 webui ↔ captainAgent 循环依赖）：注册表首个「已有 eteams 状态」
 * 的工作区。面板的角色库读写都落这里；其余工作区根里的角色行是首启播种的
 * 陈旧副本，不作为 live 源（实测：领队手册被本区种子行遮蔽 →「领队的 md
 * 没注入」）。无注册表服务（单测 fake/旧运行时）返回 undefined，探查退回
 * 自己的根。
 */
export function rosterAuthoritativeRoot(
  ctx: unknown,
  config: Pick<ETeamsResolvedConfig, 'stateDir'>,
): string | undefined {
  const registry = workspaceRegistryOf(ctx);
  if (!registry) return undefined;
  for (const ws of registry.list()) {
    if (ws.path === '') continue;
    const root = stateRootFor(config, ws.path);
    if (existsSync(root)) return root;
  }
  return undefined;
}

/**
 * 角色库一句话简介索引（用户迭代 2026-09-08「团队现状去掉 role、把角色
 * profile 加进来」）：profile 的 live 源是 roles 表 profile 列（成员名=
 * 角色名）。探查顺序：权威根（writeWorkspacePath，面板编辑都落这里）→
 * 自己的根 → 注册表其余根，first-hit wins——权威根的条目压过本区首启播种
 * 的陈旧副本。teamView 用它取 profile；班底行 persona 里烘焙的旧简介由
 * 消费位兜底。无库/未就绪的根跳过。
 */
export function rosterProfilesAcrossWorkspaces(
  ctx: unknown,
  config: Pick<ETeamsResolvedConfig, 'stateDir'>,
  ownWorkspace: string,
): Map<string, string | null> {
  const profiles = new Map<string, string | null>();
  const probe = (workspacePath: string): void => {
    if (workspacePath === '') return;
    try {
      for (const entry of readRoster(stateRootFor(config, workspacePath))) {
        if (!profiles.has(entry.name)) profiles.set(entry.name, entry.profile ?? null);
      }
    } catch {
      // 该根无 eteams 状态/库未就绪：跳过（跨工作区查找同语义）。
    }
  };
  probe(rosterAuthoritativeRoot(ctx, config) ?? '');
  probe(ownWorkspace);
  const registry = workspaceRegistryOf(ctx);
  if (registry) for (const ws of registry.list()) probe(ws.path);
  return profiles;
}

/**
 * Resolve one agent's team identity across workspaces, keeping the tool
 * layer's documented priority (resolveCaller / docs/05.8):
 * 绑定团队 → 领队（任务行 main_session_id 快照，v6 派生）→ 成员（实例行
 * session_id）。
 * The caller's own workspace probes first so same-workspace teams resolve
 * without touching the registry; other registered workspaces follow.
 */
export function locateAgentTeam(
  config: Pick<ETeamsResolvedConfig, 'stateDir'>,
  ctx: unknown,
  agentId: string,
  ownWorkspace: string,
  boundTeamId?: string,
): LocatedTeam | undefined {
  if (agentId === '') return undefined;
  const workspaces = probeOrder(ownWorkspace, workspaceRegistryOf(ctx));
  if (workspaces.length === 0) return undefined;
  // 1. 绑定团队：弹层显式选择是用户最近的意图，任何工作区命中即生效。
  if (boundTeamId !== undefined) {
    const bound = teamByIdIn(workspaces, config, boundTeamId);
    if (bound) return bound;
  }
  // 2. 领队身份：任一任务行 main_session_id 快照命中（同队任务由同一领队
  //    会话创建；removed 行同样归属，身份判定不看你行状态）。
  const asCaptain = teamMatchingIn(workspaces, config, (team) =>
    team.tasks.some((task) => task.mainSessionId === agentId),
  );
  if (asCaptain) return asCaptain;
  // 3. 成员身份（实例行 session_id === 本会话，跨工作区同样成立）。
  return teamMatchingIn(workspaces, config, (team) =>
    team.taskMembers.some((r) => r.sessionId === agentId && r.status !== 'removed'),
  );
}
