/**
 * 领队子代理派发的运行时 prompt/受理文本（docs/26 用户迭代 2026-09-03）：
 * dispatch 受理确认（主会话工具结果）与首轮/续聊 prompt 的组装（【团队
 * 现状】快照 + 用户最新消息）；另有面板手动建任务的完善 prompt
 * captainCommissionPrompt（docs/panelTaskCommission，同款快照组装）。
 * 纯文本函数——团队快照读取、持续子代理续聊/重建编排留在 tools/captainDispatch.ts。
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

/**
 * 面板手动建任务的完善 prompt（docs/panelTaskCommission）：与对话派发同款
 * 组装——团队现状快照（新建领队子代理的首轮上下文必须含班底构成，否则
 * eteams_create_task 的 chain 站点写不了工号）+ 完善指令。完善者可以是领队
 * 子代理（走 dispatchCaptainCore），也可以是无领队团队的主会话（同一文本，
 * 措辞已按「由你直接完善」写好，两种收件人通用）。
 */
export function captainCommissionPrompt(
  teamViewJson: string,
  taskId: number,
  subject: string,
  description: string,
): string {
  return [
    '【团队现状】',
    teamViewJson,
    '',
    '【完善面板创建的任务】',
    `用户刚在面板手动创建了任务 #${taskId}（当前为「创建中」占位，主任务/任务单容器已入册）：`,
    `- 主题（描述首行截断占位）：${subject}`,
    `- 任务描述（用户原话）：${description}`,
    '',
    '请完善这个任务（不要再用 eteams_submit_task 新建主任务，容器已存在）：',
    '1. 如有必要先向用户问询明确目标（ask_user_question 弹窗；问题较少时也可跳过问询直接完善）——面板发起的任务完善过程可能出现问询弹窗，属正常流程；',
    `2. 用 eteams_update_task 把结论写回主任务 #${taskId}（subject/description，可带 contractMd）；`,
    `3. 用 eteams_create_task（parentTaskId=${taskId}）把任务拆解成小任务（chain 站点即成员槽，成员写工号）；`,
    `4. 全部小任务拆好后用 eteams_submit_task（taskId=${taskId}, subject, description）收口：把创建中的主任务转就绪。`,
    '',
    '红线照旧：只完善计划，不自批开跑——收口后等用户批准/指派，不要自己 eteams_assign_task。',
  ].join('\n');
}