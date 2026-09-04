/**
 * 领队子代理派发的运行时 prompt/受理文本（docs/26 用户迭代 2026-09-03）：
 * dispatch 受理确认（主会话工具结果）与首轮/续聊 prompt 的组装（【团队
 * 现状】快照 + 用户最新消息）。纯文本函数——团队快照读取、持续子代理
 * 续聊/重建编排留在 tools/captainDispatch.ts。
 *
 * @module dsh-eteams/prompts/steering/dispatch
 */

/**
 * 受理确认（dispatch 的工具结果）：告诉主会话转交已完成、后续问询与汇报
 * 如何到达。不再同步透传子代理的最终文本——持续子代理的汇报经 report
 * 通道随后送达。
 */
export function dispatchAck(childId: string): string {
  const short = childId.slice(0, 8);
  return [
    `已转交持续领队子代理（会话 ${short}…）主持团队工作流。`,
    '它将直接主持后续流程：问询会以 ask_user_question 弹窗出现在本对话（用户作答后领队继续）；',
    '每轮汇报经子代理汇报消息送达本对话——到达后原样展示给用户，不要复述全文，也不要重复转交相同内容。',
  ].join('\n');
}

/**
 * 领队子代理的派发 prompt：团队现状快照（teamViewJson，`JSON.stringify(
 * teamView(env, team), null, 1)` 的产出）+ 用户/主对话最新消息。首轮快照
 * 给领队子代理建立团队上下文；持续子代理后续轮次在既有上下文上续步，
 * 快照只作对账（docs/26.2 状态驱动）。
 */
export function captainDispatchPrompt(teamViewJson: string, message: string): string {
  return [
    '【团队现状】',
    teamViewJson,
    '',
    '【用户/主对话最新消息】',
    message,
  ].join('\n');
}