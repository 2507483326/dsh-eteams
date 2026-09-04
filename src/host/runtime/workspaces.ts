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
import { getDb } from '../state/db.js';
import { ensureWorkspaceReady } from '../state/import.js';
import { joinPath } from './base.js';
import { readTeamSync } from '../state/store.js';
import type { TeamState } from '../model/types.js';
import type { ETeamsResolvedConfig } from '../config.js';
import { leaderRowOf } from './notifier.js';

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
    const root = joinPath(ws, config.stateDir);
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
    const root = joinPath(ws, config.stateDir);
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
 * Resolve one agent's team identity across workspaces, keeping the tool
 * layer's documented priority (resolveCaller / docs/05.8):
 * 绑定团队 → 领队（task_members 领队行 main_session_id，docs/36 建议 3）→
 * 成员（task_members 实例行 child_session_id）。
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
  // 2. 领队身份：领队行 main_session_id 即建队/主持会话（removed 行同样
  //    是该会话的归属，身份判定不看你行状态）。
  const asCaptain = teamMatchingIn(workspaces, config, (team) => {
    const leader = leaderRowOf(team);
    return leader !== undefined && leader.mainSessionId === agentId;
  });
  if (asCaptain) return asCaptain;
  // 3. 成员身份（实例行 child_session_id === 本会话，跨工作区同样成立）。
  return teamMatchingIn(workspaces, config, (team) =>
    team.taskMembers.some((r) => r.childSessionId === agentId && r.status !== 'removed'),
  );
}
