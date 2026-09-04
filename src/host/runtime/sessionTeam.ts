/**
 * Session team binding (docs/26 对话调用团队执行任务): the composer's 团队
 * button selects a team for the conversation; the host records the binding
 * in-memory (mirror of sessionPersona — the client re-asserts on mount, so a
 * host restart self-heals) and the session agent's prompt gains a 团队绑定
 * band（每次组装时对照活团队现读）——两个分支：
 *
 * - 团队已不存在（被删除或归档）→ 失效提示，请用户在弹层取消选择；
 * - 团队健在 → 生效中：**持续领队子代理主持**（用户迭代 2026-09-03「主窗口
 *   发问题不合适——由领队子代理完成主持」+「不使用一次性子代理，应该是
 *   持续代理」）。主会话不再自己扮演领队（提交/问询/拆解/指派全不走），
 *   只把用户交给团队的任务经 `eteams_dispatch_captain` 转交**持续领队
 *   子代理**（每团队一个 continuable 子代理会话，首轮建立、后续续聊）。
 *   问询由子代理的 `ask_user_question` 确定性弹窗直接弹给用户（它是运行
 *   时根，可弹窗）；汇报经 continuable 子代理自带的 report 返回通道送达
 *   主对话，不再依赖主会话模型的文本行为。
 *
 * 绑定即意图（用户迭代 2026-09-03「选择团队然后使用团队开始任务，主对话
 * 直接开始完成任务，没有使用到团队功能」）：band 不再要求用户消息点名
 * 团队——选中团队 = 本对话的任务都交给该团队；任何任务/执行类请求一律
 * dispatch 转交，只有纯问答/闲聊本会话直答。常驻领队段同步声明绑定会话
 * 以本 band 为准，压掉「只在用户明确要求多代理协作时进入领队流程」的旧
 * 口径（实测模型引用它作为不转交的理由）。
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
    `本会话绑定团队「${neutralizeInterpolation(team.name)}」（${team.tasks.length} 个任务在案）。`,
    // 用户迭代 2026-09-03「选择团队然后使用团队开始任务，主对话直接开始完成
    // 任务」：实测模型看到 band 仍以「消息没点名团队」为由自己动手（把触发
    // 条件当成显式短语匹配）。改为绑定即意图：选中团队 = 本对话的任务都
    // 交给团队，是否点名团队无关；只有纯问答/闲聊本会话直答。
    '绑定即用户意图：在弹层选中团队 = 用户把本对话的任务交给该团队——与消息里是否点名团队无关，也不要揣测用户是否真想用团队。',
    '',
    '分工：团队工作流（提交任务单、问询、拆解、指派、汇报）由持续领队子代理主持——本会话只负责转交与展示：',
    '1. 用户提出任何任务/工作请求 → 立即 eteams_dispatch_captain（message=用户原话）转交，本会话不自己动手执行；用户答复领队的问询、或收到团队邮件/面板通知 → 同样转交（message=答复原文或通知要点）；',
    '2. dispatch 立即返回受理确认；领队的问询（ask_user_question 弹窗）与汇报（「Background subagent … reported:」子代理消息）随后直接到达本对话——原样展示给用户即可（或一句简短确认），不要复述全文、不要替领队补充或回答；',
    '3. 只有不需要动手产出任何东西的纯问答、闲聊才由本会话直接回应；写代码/改文件/跑命令等一切执行类请求都必须转交——不要直接调用其它 eteams_* 工具，也不要自己动手执行。',
  ].join('\n');
}
