/**
 * Session persona takeover (docs/13.8.2): the panel selects a member for a
 * session and the session agent's system prompt gains a persona band —
 * evaluated per assembly, keyed by the assembling agent. In dsh the
 * assembling scope IS the agent object (`assembleContextFor` passes
 * `scope: agent`) and a session agent's id IS its sessionId (same axis, see
 * dsh-agent), so the band applies to exactly that session's agent and
 * contributes nothing for member subagents or other sessions.
 *
 * The store is in-memory on purpose: the client re-asserts its persisted
 * selection on mount, so a host restart self-heals without a state file.
 * Band 文本组装在 prompts/system/sessionPersona.ts（纯函数）——本文件只留
 * store 与薄壳（查 Map → 委托）。
 *
 * @module dsh-eteams/host/runtime/sessionPersona
 */
import { sessionPersonaBand } from '../prompts/system/sessionPersona.js';
import type { SessionPersona } from '../prompts/system/sessionPersona.js';

export type { SessionPersona } from '../prompts/system/sessionPersona.js';
// 提示词装配保护属提示词面（prompts/system/sessionPersona.ts 所有）；本
// re-export 是预防性保 API——当前唯一导入方 sessionTeam.ts 已随本次改写，
// 后续新调用方应直接 import prompts 平面。
export { neutralizeInterpolation } from '../prompts/system/sessionPersona.js';

const personas = new Map<string, SessionPersona>();

/** Set (or replace) the persona band for one session. */
export function setSessionPersona(sessionId: string, persona: SessionPersona): void {
  if (sessionId === '') return;
  personas.set(sessionId, persona);
}

/** Remove the persona band for one session (deselect). */
export function clearSessionPersona(sessionId: string): void {
  personas.delete(sessionId);
}

/**
 * Read the agent id off an assembly scope. The scope is the agent object
 * itself; its string `id` is the sessionId for session agents and something
 * else (member/child axes) for every other agent — those never match a
 * stored session key, which is exactly the isolation we want.
 */
export function sessionIdOfScope(scope: unknown): string | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined;
  const id = (scope as { id?: unknown }).id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * The dynamic band text for one assembly. `''` contributes nothing (the
 * registry drops empty sections/contexts), so only the session with an active
 * persona sees the band.
 */
export function sessionPersonaSection(sessionId: string | undefined): string {
  if (sessionId === undefined) return '';
  const persona = personas.get(sessionId);
  if (persona === undefined) return '';
  return sessionPersonaBand(persona);
}