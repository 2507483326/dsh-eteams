/**
 * Session team binding (docs/26 对话调用团队执行任务): the composer's 团队
 * button selects a team for the conversation; the host records the binding
 * in-memory (mirror of sessionPersona — the client re-asserts on mount, so a
 * host restart self-heals) and the session agent's prompt gains a 团队绑定
 * band（每次组装时对照活团队现读）——两个分支：
 *
 * - 团队已不存在（被删除或归档）→ 失效提示，请用户在弹层取消选择；
 * - 团队健在 → 生效中：**领队子代理主持**（用户迭代 2026-09-03「主窗口
 *   发问题不合适——由领队子代理完成主持」）。主会话不再自己扮演领队
 *   （提交/问询/拆解/指派全不走），只把用户交给团队的任务经
 *   `eteams_dispatch_captain` 转交一次性领队子代理，并把子代理的汇报
 *   原样带给用户。问询走子代理的 `ask_user_question` 确定性弹窗，不再
 *   依赖主会话模型的文本行为。
 *
 * 领队子代理自身（captainAgent 注册表命中的 id）不装配本 band——它就是
 * 领队，不能看到「调 dispatch 转交」的指示。
 *
 * The band is built per assembly against the LIVE team snapshot (readTeamSync
 * via the webui locateTeam helper) so 批准/阶段变化即时反映，无需重绑。
 *
 * @module dsh-eteams/host/runtime/sessionTeam
 */
import type { TeamState } from '../model/types.js';
import { captainChildTeamOf } from './captainAgent.js';
import { neutralizeInterpolation, sessionIdOfScope } from './sessionPersona.js';

export { sessionIdOfScope };

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
  if (team === undefined) {
    return [
      '【eteams 团队绑定·失效】',
      `本会话绑定的团队「${neutralizeInterpolation(binding.name)}」已不存在（被删除或归档）。`,
      '告诉用户在输入栏「团队」弹层取消选择或换一个团队；不要对已删除的团队调用任何 eteams_* 工具。',
    ].join('\n');
  }
  return [
    '【eteams 团队绑定·生效中】',
    `本会话绑定团队「${neutralizeInterpolation(team.name)}」（目标：${neutralizeInterpolation(
      team.goal || '（待完善）',
    )} · 状态：${team.phase}）。`,
    '',
    '分工：团队工作流（提交任务单、问询、拆解、指派、汇报）由领队子代理主持——本会话只负责转交与展示：',
    '1. 用户把任务交给团队（「用团队做X」「交给团队」等）→ eteams_dispatch_captain（message=用户原话）转交；用户答复领队的问询、或收到团队邮件/面板通知 → 同样转交（message=答复原文或通知要点）；',
    '2. dispatch 的工具结果就是领队子代理给用户的汇报——原样展示即可（或一句简短确认），不要复述全文、不要替领队补充或回答；',
    '3. 不要直接调用其它 eteams_* 工具，也不要自己动手执行用户交给团队的任务；与任务无关的问答、闲聊正常回应。',
  ].join('\n');
}
