/**
 * Runtime base (docs/04 architecture): the only seam toward cordis-injected
 * services. `state/` + `model/` stay pure; `runtime/` + `tools/` speak env.
 *
 * @module dsh-eteams/runtime/base
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { ETeamsResolvedConfig } from '../config.js';
import type { Actor, MemberRecord, TeamState } from '../model/types.js';
import { locks } from '../state/lock.js';
import { readTeamSync, teamDir } from '../state/store.js';

/** Minimal logger face (cordis logger satisfies it; verify fakes its own). */
export interface RuntimeLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** The context seam the runtime needs (subset of the cordis context). */
export interface RuntimeContext {
  logger: RuntimeLogger;
  /** Continuation runtime: spawn/followup/interrupt (inject `subagents`). */
  subagents: {
    startContinuable(spec: {
      provider: string;
      label: string;
      request: {
        prompt: { type: 'text'; text: string }[];
        parent: Agent;
        persona?: string;
        toolFilter?: { deny: string[] };
        agentOptions?: { provider?: string; model?: string; reasoningEffort?: string };
      };
      signal?: AbortSignal;
    }): Promise<{ childId: string; messageId: string }>;
    followup(
      parent: Agent,
      childId: SessionId,
      content: { type: 'text'; text: string }[],
      options: { source: { kind: 'plugin'; plugin: string }; signal?: AbortSignal },
    ): Promise<unknown>;
    interrupt(target: SessionId, authority: { kind: 'ancestor'; agent: Agent }): void;
  };
  /** Live agent registry (inject `agents`): wake the captain. */
  agents: { get(sessionId: string): Agent | undefined };
  /** Live subagent listing — used to detect stranded mailboxes. */
  listAgents?: () => { id: string; label?: string; status: string }[];
}

/** Everything a runtime operation needs besides its arguments. */
export interface RuntimeEnv {
  ctx: RuntimeContext;
  config: ETeamsResolvedConfig;
  /** Workspace root (the captain/member session cwd). */
  workspace: string;
  signal?: AbortSignal;
}

/** Absolute state root for an env. */
export function stateRootOf(env: RuntimeEnv): string {
  return joinPath(env.workspace, env.config.stateDir);
}

/** Tiny join helper (avoids importing node:path twice in hot paths). */
export function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .filter((p) => p !== '')
    .join('/');
}

/** Tool-layer error carrying an actionable Chinese hint. */
export class ETeamsError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'ETeamsError';
    this.hint = hint;
  }
}

/** Parse an AgentTeams-style identity probe of the calling agent. */
export function agentIdentity(agent: Agent | undefined): { sessionId: string; cwd: string } {
  if (!agent) throw new ETeamsError('无法识别调用者身份（exec.agent 缺失）');
  const sessionId = String(agent.id ?? '');
  if (sessionId === '') throw new ETeamsError('无法识别调用者身份（会话 id 为空）');
  const cwd = agent.session?.header?.cwd ?? process.cwd();
  return { sessionId, cwd };
}

/** Actor record for the captain of one team. */
export function captainActor(_team?: TeamState): Actor {
  return { kind: 'captain', name: '领队' };
}

/** Actor record for one member. */
export function memberActor(member: MemberRecord): Actor {
  return { kind: 'member', name: member.name };
}

/** Plugin actor (state-machine-driven messages). */
export const PLUGIN_ACTOR: Actor = { kind: 'plugin', name: 'dsh-eteams' };
export const SYSTEM_ACTOR: Actor = { kind: 'system' };

/** Fresh attempt token (url-safe, 24 hex chars). */
export function generateToken(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Re-exported for callers that hold a team id only. */
export function readTeamByIdSync(env: RuntimeEnv, teamId: string): TeamState | undefined {
  return readTeamSync(stateRootOf(env), teamId);
}

/** Shared lock registry (re-export so tools/ and verify import one place). */
export { locks };
export { teamDir };
