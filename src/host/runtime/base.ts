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
import { teamDir } from '../state/store.js';

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
    /** One-shot child (docs/19.16 builder phases): settles after its turn. */
    start(
      name: string,
      request: {
        label?: string;
        prompt: { type: 'text'; text: string }[];
        parent: Agent;
        signal: AbortSignal;
        persona?: string;
        toolFilter?: { deny: string[] };
      },
    ): Promise<{ id: string; dispose(): Promise<void>; result: Promise<unknown> }>;
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
    interrupt(
      target: SessionId,
      authority: { kind: 'user'; parentSessionId: SessionId } | { kind: 'ancestor'; agent: Agent },
    ): void;
    /**
     * Runtime-version-gated recycling APIs (docs/20.2.2): present on newer
     * harness runtimes, absent in older type snapshots — feature-detect via
     * `?.` and degrade to interrupt-only when missing.
     */
    /** Release selected resident continuable direct children of one parent. */
    drainContinuableChildren?(parent: Agent, childIds: readonly SessionId[]): Promise<void>;
    /** Close admission below exact parents and release their descendant forests. */
    drainContinuableDescendants?(parents: readonly Agent[]): Promise<void>;
    /** Enumerate direct session-backed subagents (no Agent loading). */
    listChildren?(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentChildEntry[]>;
    /** Enumerate the complete descendant tree in stable pre-order. */
    listDescendants?(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentChildEntry[]>;
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

/** Actor record for the captain of one team. */
export function captainActor(_team?: TeamState): Actor {
  return { kind: 'captain', name: '领队' };
}

/**
 * Minimal structural view of one `listChildren` entry (docs/20.3): only the
 * fields eteams consumes; the runtime may carry more.
 */
export interface SubagentChildEntry {
  kind: 'child' | 'diagnostic';
  id: string;
  activity?: 'running' | 'inactive';
  mode?: 'one-shot' | 'continuable';
  label?: string;
}

/** Actor record for one member. */
export function memberActor(member: MemberRecord): Actor {
  return { kind: 'member', name: member.name };
}

/** Plugin actor (state-machine-driven messages). */
export const PLUGIN_ACTOR: Actor = { kind: 'plugin', name: 'dsh-eteams' };

/** Fresh attempt token (url-safe, 24 hex chars). */
export function generateToken(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Shared lock registry (re-export so tools/ and verify import one place). */
export { locks };
export { teamDir };
