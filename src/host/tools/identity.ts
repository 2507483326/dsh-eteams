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
import { getSessionTeamId } from '../runtime/sessionTeam.js';
import { captainChildTeamOf } from '../runtime/captainAgent.js';
import { locateAgentTeam } from '../runtime/workspaces.js';
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
  const sessionId = String(agent.id ?? '');
  const cwd = agent.session?.header?.cwd ?? process.cwd();
  // 跨工作区团队对齐（docs/26）：band/面板按注册表全工作区定位，工具环境
  // 在此对齐——本会话身份对应的团队若在别的注册工作区（会话项目目录 ≠
  // 团队工作区），env 重指到团队所在工作区：状态根、文档渲染、workDir 全部
  // 以团队为准；resolveCaller 随后在重指后的根上按同一优先级解析。
  const located = locateAgentTeam(
    config,
    ctx,
    sessionId,
    cwd,
    getSessionTeamId(sessionId) ?? captainChildTeamOf(sessionId),
  );
  return { ctx, config, workspace: located?.workspacePath ?? cwd, signal };
}

/**
 * Resolve the calling agent into a team identity. Members are matched by
 * their durable child session id (`member.id === agent.id`).
 *
 * 绑定优先（docs/26 用户迭代 2026-09-03）：输入栏「团队」弹层的显式选择
 * 是用户最近的意图——凡绑定了团队的会话，按该团队的领队身份行动，团队
 * 建在哪个对话不再重要（原「他队」死路已撤）。绑定先于创建者
 * `captainSessionId` 匹配：一个会话既领队 A 队又绑定 B 队时，工具作用于
 * B（弹层选择即最新意图）。
 *
 * 领队子代理（docs/26 用户迭代 2026-09-03）：dispatch 派发的一次性子代理
 * 经 `captainChildTeamOf` 注册表命中——它的 eteams_* 调用一律按该团队
 * 领队解析（含跨工作区重指，envForAgent 同一 fallback）。注册先于创建者
 * 匹配：子代理 id 永不等于 `captainSessionId`，此分支只命中真子代理。
 */
export async function resolveCaller(env: RuntimeEnv, agent: Agent): Promise<Caller> {
  const sessionId = String(agent.id ?? '');
  if (sessionId === '') throw new ETeamsError('无法识别调用者身份（会话 id 为空）');
  const root = stateRootOf(env);
  const teams = await listTeams(root);
  const boundTeamId = getSessionTeamId(sessionId);
  if (boundTeamId !== undefined) {
    const bound = teams.find((t) => t.id === boundTeamId);
    if (bound) return { kind: 'captain', team: bound, actor: captainActor(bound) };
  }
  const childTeamId = captainChildTeamOf(sessionId);
  if (childTeamId !== undefined) {
    const childTeam = teams.find((t) => t.id === childTeamId);
    if (childTeam) return { kind: 'captain', team: childTeam, actor: captainActor(childTeam) };
  }
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
