/**
 * Caller identity resolution (docs/05.8): every tool execution resolves the
 * calling agent into captain-of-team or member-of-team before touching state.
 * Non-team agents get an actionable error.
 *
 * @module dsh-eteams/tools/identity
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { MemberRecord, TeamState } from '../model/types.js';
import { listTeams } from '../state/store.js';
import {
  captainActor,
  memberActor,
  stateRootOf,
  ETeamsError,
  type RuntimeContext,
  type RuntimeEnv,
} from '../runtime/base.js';
import type { ETeamsResolvedConfig } from '../config.js';
import type { Actor } from '../model/types.js';

/** Captain caller: leads exactly one active team. */
export interface CaptainCaller {
  kind: 'captain';
  team: TeamState;
  actor: Actor;
}

/** Member caller: one roster member of one team. */
export interface MemberCaller {
  kind: 'member';
  team: TeamState;
  member: MemberRecord;
  actor: Actor;
}

export type Caller = CaptainCaller | MemberCaller;

/** Build a runtime env for one agent execution. */
export function envForAgent(
  config: ETeamsResolvedConfig,
  ctx: RuntimeContext,
  agent: Agent | undefined,
  signal?: AbortSignal,
): RuntimeEnv {
  if (!agent) throw new ETeamsError('无法识别调用者（exec.agent 缺失）');
  const cwd = agent.session?.header?.cwd ?? process.cwd();
  return { ctx, config, workspace: cwd, signal };
}

/**
 * Resolve the calling agent into a team identity. Members are matched by
 * their durable child session id (`member.id === agent.id`).
 */
export async function resolveCaller(env: RuntimeEnv, agent: Agent): Promise<Caller> {
  const sessionId = String(agent.id ?? '');
  if (sessionId === '') throw new ETeamsError('无法识别调用者身份（会话 id 为空）');
  const root = stateRootOf(env);
  const teams = await listTeams(root);
  const asCaptain = teams.find((t) => t.captainSessionId === sessionId);
  if (asCaptain) return { kind: 'captain', team: asCaptain, actor: captainActor(asCaptain) };
  for (const team of teams) {
    const member = team.members.find((m) => m.id === sessionId && m.status !== 'removed');
    if (member) return { kind: 'member', team, member, actor: memberActor(member) };
  }
  throw new ETeamsError(
    '当前会话不在任何 eteams 团队中',
    '领队用 eteams_create_team 建队；成员由领队拉入团队',
  );
}

/** Shared listTeams re-export for tool factories. */
export { listTeams };
