/**
 * Session team binding (docs/26 对话调用团队执行任务): the composer's 团队
 * button selects a team for the conversation; the host records the binding
 * in-memory (mirror of sessionPersona — the client re-asserts on mount, so a
 * host restart self-heals) and the session agent's prompt gains a 团队绑定
 * band（每次组装时对照活团队现读）.
 *
 * band 文本组装在 prompts/system/sessionTeam.ts（纯函数，判别联合入参）——
 * 本文件只留 bindings store 与薄壳：领队子代理注册表守卫、绑定查表、活
 * 团队快照解析后，把判别联合传给纯函数。绑定即意图、转交分工等口径说明
 * 随 band 文本在 prompts 平面。
 *
 * The band is built per assembly against the LIVE team snapshot (readTeamSync
 * via the webui locateTeam helper) so 批准/阶段变化即时反映，无需重绑。
 *
 * @module dsh-eteams/host/runtime/sessionTeam
 */
import type { TeamState } from '../model/types.js';
import { captainChildTeamOf } from './captainAgent.js';
import { sessionTeamBand } from '../prompts/system/sessionTeam.js';

export { sessionIdOfScope } from './sessionPersona.js';

/** A bound team for one conversation session (the composer 团队 selection). */
export interface SessionTeamBinding {
  readonly teamId: string;
  /** Team name at bind time — display fallback when the team disappears. */
  readonly name: string;
  readonly boundAt: number;
}

const bindings = new Map<string, SessionTeamBinding>();

/** Bind (or re-bind) one session to a team. */
export function setSessionTeam(sessionId: string, binding: SessionTeamBinding): void {
  if (sessionId === '') return;
  bindings.set(sessionId, binding);
}

/** Remove the binding (deselect in the composer popup). */
export function clearSessionTeam(sessionId: string): void {
  bindings.delete(sessionId);
}

/** The session's bound teamId, if any (identity.ts 绑定优先 resolveCaller). */
export function getSessionTeamId(sessionId: string): string | undefined {
  return bindings.get(sessionId)?.teamId;
}

/**
 * The 团队绑定 band for one assembly. `''` contributes nothing — only a
 * session with an active binding sees it. `liveTeam` resolves the current
 * on-disk snapshot (undefined = team deleted/archived → 失效提示).
 */
export function sessionTeamSection(
  sessionId: string | undefined,
  liveTeam: (teamId: string) => TeamState | undefined,
): string {
  if (sessionId === undefined) return '';
  // 领队子代理：band 对其静默（它是领队本人，不该再看到「转交」指示）。
  if (captainChildTeamOf(sessionId) !== undefined) return '';
  const binding = bindings.get(sessionId);
  if (binding === undefined) return '';
  const team = liveTeam(binding.teamId);
  // 失效分支的名字取绑定时记录的团队名（团队已删，磁盘无名可读）。
  return sessionTeamBand(
    team === undefined
      ? { kind: 'dead', name: binding.name }
      : { kind: 'live', name: team.name, taskCount: team.tasks.length },
  );
}