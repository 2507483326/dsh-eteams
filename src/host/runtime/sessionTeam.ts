/**
 * Session team binding (docs/26 对话调用团队执行任务): the composer's 团队
 * button selects a team for the conversation; the host records the binding
 * in-memory (mirror of sessionPersona — the client re-asserts on mount, so a
 * host restart self-heals) and the session agent's prompt gains a 团队绑定
 * band（每次组装时对照活团队现读）.
 *
 * 一次性消费（用户迭代 2026-09-07「发送后清空选择」）：客户端在提交瞬间只
 * 清本地按钮面（不删宿主绑定——那条消息还要靠绑定注入 band 并解析派发身
 * 份）。宿主在 user/message 事件到达时把绑定转为「本回合凭证」（consumed）：
 * band 组装与 resolveCaller 读 `绑定 ?? 凭证`，所以消费它的这条消息照常走
 * 团队工作流；下一条 user/message 到达即撤销凭证——再往后的消息回到普通
 * 对话，想再用团队需重新选择。
 *
 * band 文本组装在 prompts/system/sessionTeam.ts（纯函数，判别联合入参）——
 * 本文件只留 bindings/consumed store 与薄壳：领队子代理注册表守卫、绑定
 * 查表、活团队快照解析后，把判别联合传给纯函数。绑定即意图、转交分工等
 * 口径说明随 band 文本在 prompts 平面。
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

/** 本回合凭证：绑定被一条 user/message 消费后的余晖（该回合的 band + 身份
 * 还靠它；下一条 user/message 到达即撤销）。同一 Map 键语义与 bindings 一致。 */
const consumed = new Map<string, SessionTeamBinding>();

/** Bind (or re-bind) one session to a team. */
export function setSessionTeam(sessionId: string, binding: SessionTeamBinding): void {
  if (sessionId === '') return;
  bindings.set(sessionId, binding);
}

/** Remove the binding (deselect in the composer popup). 显式取消连本回合
 * 凭证一并撤销（用户明确收手，派发身份不再保留）。 */
export function clearSessionTeam(sessionId: string): void {
  bindings.delete(sessionId);
  consumed.delete(sessionId);
}

/** The session's bound teamId, if any (identity.ts 绑定优先 resolveCaller). */
export function getSessionTeamId(sessionId: string): string | undefined {
  return bindings.get(sessionId)?.teamId;
}

/**
 * 一次性消费（user/message 事件调用，index.ts 监听器）：有绑定 → 转为本
 * 回合凭证；已有凭证（上一回合的余晖）→ 撤销。此后 band 与身份读
 * `绑定 ?? 凭证`，再往后一条消息两者皆空。
 */
export function consumeSessionTeamBinding(sessionId: string): void {
  if (sessionId === '') return;
  const binding = bindings.get(sessionId);
  if (binding !== undefined) {
    bindings.delete(sessionId);
    consumed.set(sessionId, binding);
    return;
  }
  consumed.delete(sessionId);
}

/** The session's consumed (one-shot) teamId, if any — resolveCaller /
 * envForAgent / usage 归属在消费回合内的回退身份。 */
export function getConsumedSessionTeamId(sessionId: string): string | undefined {
  return consumed.get(sessionId)?.teamId;
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
  // 绑定 ?? 本回合凭证：消费那条消息的组装照常带 band（一次性消费语义）。
  const binding = bindings.get(sessionId) ?? consumed.get(sessionId);
  if (binding === undefined) return '';
  const team = liveTeam(binding.teamId);
  // 失效分支的名字取绑定时记录的团队名（团队已删，磁盘无名可读）。
  return sessionTeamBand(
    team === undefined
      ? { kind: 'dead', name: binding.name }
      : {
          kind: 'live',
          name: team.name,
          taskCount: team.tasks.length,
          // 分工口径随 hasLeader 分支：无领队团队由主会话直接主持（面板
          // 手动建任务的完善路径同语义，docs/panelTaskCommission）。
          hasLeader: team.hasLeader,
        },
  );
}