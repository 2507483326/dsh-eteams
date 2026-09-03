/**
 * Session team binding (docs/26 对话调用团队执行任务): the composer's 团队
 * button selects a team for the conversation; the host records the binding
 * in-memory (mirror of sessionPersona — the client re-asserts on mount, so a
 * host restart self-heals) and the session agent's prompt gains a 团队绑定
 * band with three branches:
 *
 * - 本会话就是该团队的领队会话（captainSessionId === 本会话）→ 领队主持；
 *   领队已被移出名册（leaderRemoved）时同一会话继续充当领队（用户迭代：
 *   「没有领队就由用户的主窗口充当领队」——领队会话恒在，只是名册不展示）。
 * - 团队建在别的对话（captainSessionId !== 本会话）→ 可行动提示，不接管；
 *   工具层身份校验本来就会拒绝，band 让模型一次讲明白而不是反复撞墙。
 *
 * The band is built per assembly against the LIVE team snapshot (readTeamSync
 * via the webui locateTeam helper) so 批准/阶段变化即时反映，无需重绑。
 *
 * @module dsh-eteams/host/runtime/sessionTeam
 */
import type { TeamState } from '../model/types.js';
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
  if (team.captainSessionId !== sessionId) {
    return [
      '【eteams 团队绑定·他队】',
      `本会话绑定了团队「${neutralizeInterpolation(team.name)}」，但该团队建在另一个对话里、由那个会话领队。`,
      '本会话调用该团队的领队工具会被身份校验拒绝；请告诉用户二选一：回到创建该团队的对话里操作，或在面板删除该团队后回到本对话用 eteams_create_team 重建。不要反复尝试领队工具。',
    ].join('\n');
  }
  const planLine = team.planReviewState === 'awaiting_review' ? '（计划待批准）' : '';
  const leadership =
    team.leaderRemoved === true
      ? '该团队暂无领队——由你（用户主窗口会话）充当领队，直接主持。'
      : '你就是该团队的领队（项目牧羊人），直接主持。';
  return [
    '【eteams 团队绑定·生效中】',
    `本会话绑定团队「${neutralizeInterpolation(team.name)}」（目标：${neutralizeInterpolation(
      team.goal || '（待完善）',
    )} · 状态：${team.phase}${planLine}）。${leadership}`,
    '',
    '对话任务工作流——用户把任务交给该团队时按此主持：',
    '1. 提交：用户给出任务 → 立即 eteams_submit_task（subject 一句话主题 + description 当前理解）→ 生成任务 ID 与专属任务文件夹，面板「任务」页立刻可见；',
    '2. 问询（FR-37）：交付形式与受众 / 范围边界 / 验收偏好 / 约束 / 优先级，一轮问完；结论用 eteams_update_task 写回主任务 description；',
    '3. 拆解：每个小任务 eteams_create_task（带 parentTaskId=主任务 id）——chain 站点即成员槽（成员按序接力，单成员任务给单站点）；跨任务依赖用 dependencies 声明；成员未就绪先 eteams_add_member；',
    '4. 审阅：告诉用户「计划已就绪，可在面板任务页修改 / 删除小任务」；',
    '5. 批准：团队处于 staged（待批准）时不要指派任务——等用户在面板点「批准计划」，批准后合同冻结；',
    '6. 执行：eteams_assign_task / eteams_advance_task 按链指派、完成即续派；全部小任务完成后主任务自动收口为 completed；',
    '7. 汇报：里程碑与状态变化用 eteams_send_message 通知用户。',
  ].join('\n');
}
