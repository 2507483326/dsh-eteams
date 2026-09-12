/**
 * 领队子代理派发的运行时 prompt/受理文本（docs/26 用户迭代 2026-09-03）：
 * dispatch 受理确认（主会话工具结果）与面板手动建任务的完善指令。领队子
 * 代理的回合提示词已收敛为一句话领规程（captainTurnBrief，见
 * spawn/captainChild）——转交内容与团队现状经 eteams_captain_guide 快照获
 * 取，不再随消息组装。无领队团队的主会话路径（同一份完善指令直接进主对
 * 话，主会话不在 guide 工具的收件人语义里）保留完整 prompt（带自取现状
 * 指令）。纯文本函数——持续子代理续聊/重建编排留在 runtime/captainAgent.ts。
 *
 * @module dsh-eteams/prompts/steering/dispatch
 */

/**
 * 自取现状指令（无领队主会话路径专用；用户迭代 2026-09-08「让子agent去
 * 获取团队现状，而不是直接输出在子agent里面」）：进入 prompt 不内嵌
 * teamView JSON——现状永远现读（eteams_team_status），单一事实源。领队子
 * 代理不消费本段：现状随 eteams_captain_guide 快照送达。
 */
const TEAM_STATE_DIRECTIVE =
  '本消息不携带现状快照：先调用 eteams_team_status 获取团队现状（成员工号与一句话简介/任务与执行链/待决策/领队邮箱）再开始工作——首轮必调；后续轮次在既有上下文上续步，需要核对最新状态时再调。';

/**
 * 受理确认（dispatch 的工具结果）：告诉主会话转交已完成、后续问询与汇报
 * 如何到达。不再同步透传子代理的最终文本——持续子代理的汇报经 report
 * 通道随后送达。
 */
export function dispatchAck(childId: string): string {
  const short = childId.slice(0, 8);
  return [
    `已转交持续领队子代理（会话 ${short}…）主持团队工作流。`,
    '它将直接主持后续流程：问询弹窗弹在用户当前所在会话（用户在看领队子对话就弹那里，否则弹在本对话；原生问答界面，用户作答后领队同回合继续）；',
    '领队的特殊情况汇报经子代理汇报消息送达本对话（例行执行不汇报，面板可见）——到达后原样展示给用户，不要复述全文，也不要重复转交相同内容。',
  ].join('\n');
}

/**
 * 面板手动建任务的完善指令正文（docs/panelTaskCommission）：本回合转交内
 * 容——领队子代理路径由派发核写进回合 sidecar、经 eteams_captain_guide 的
 * snapshot.latestMessage 送达（turn='commission'），本函数不带现状指令。
 */
export function captainCommissionMessage(
  taskId: number,
  subject: string,
  description: string,
): string {
  return [
    '【完善面板创建的任务】',
    `用户刚在面板手动创建了任务 #${taskId}（当前为「创建中」占位，主任务/任务单容器已入册）：`,
    `- 主题（描述首行截断占位）：${subject}`,
    `- 任务描述（用户原话）：${description}`,
    '',
    '请完善这个任务（不要再用 eteams_submit_task 新建主任务，容器已存在）：',
    '1. 先在执行之前向用户问询明确目标（领队子代理用 eteams_ask_user、主会话用 ask_user_question 弹窗；问题较少时也可跳过问询直接完善）——面板发起的任务完善过程可能出现问询弹窗，属正常流程；',
    `2. 用 eteams_update_task 把结论写回主任务 #${taskId}（subject/description，可带 contractMd）；`,
    `3. 用 eteams_create_task（parentTaskId=${taskId}）把任务拆解成小任务（chain 站点即成员槽，成员写工号）；`,
    `4. 全部小任务拆好后用 eteams_submit_task（taskId=${taskId}, subject, description, questionnaire）收口：把创建中的主任务转就绪——收口必须带上问过的问题（questionnaire），用户已给全/要求直接开始则传 skipQuestionnaire=true；未问询且未声明跳过会被宿主拒绝。`,
    '',
    '红线照旧：只完善计划，不自批开跑——收口后等用户批准/指派，不要自己 eteams_assign_task。',
  ].join('\n');
}

/**
 * 无领队团队的主会话完善 prompt（docs/panelTaskCommission）：同一份完善指
 * 令直接进主对话——主会话不经 eteams_captain_guide（那是领队子代理的领取
 * 面），保留自取现状指令头。
 */
export function captainCommissionPrompt(
  taskId: number,
  subject: string,
  description: string,
): string {
  return [
    '【团队现状】',
    TEAM_STATE_DIRECTIVE,
    '',
    captainCommissionMessage(taskId, subject, description),
  ].join('\n');
}

/**
 * 面板「开始/继续」的开跑批准正文（用户 2026-09-12「任务重新开始有领队的
 * 情况下怎么没有走领队了，开始之前需要先唤醒一下主对话」）：宿主静默解析/
 * 复活主会话锚点后，把开跑批准派给本大任务的领队子代理（turn='start'），
 * 由领队按既有执行链指派——不再由宿直接把成员派出去而绕过领队。本回合转交
 * 内容经回合 sidecar 由 eteams_captain_guide 的 snapshot.latestMessage 送达。
 * `taskId` = 被点开跑的任务号（主任务或小任务），`rootTaskId` = 其所属主任务号。
 */
export function captainStartMessage(
  taskId: number,
  subject: string,
  rootTaskId: number,
  resumed: boolean,
): string {
  const action = resumed ? '开始（继续）' : '开始';
  const scope = taskId === rootTaskId ? '' : `（属于主任务 #${rootTaskId}）`;
  return [
    '【用户批准开跑】',
    `用户已在面板点击「${action}」，批准${resumed ? '恢复' : '开跑'}任务 #${taskId}（${subject}）${scope}。`,
    '',
    '请按既有计划执行指派（不要重新拆解、不要重复建任务）：',
    `1. 用 eteams_task_board 核对主任务 #${rootTaskId} 的执行链与当前就绪站；`,
    '2. 按链就绪即派：用 eteams_assign_task 指派当前站成员（依赖未满足/成员未就绪的卡按既有纪律处理；成员未就绪先 eteams_add_member）；',
    '3. 指派后按汇报纪律：例行执行不向主对话汇报（面板与任务页实时可见），report 只做单向通知（升级「待用户」的告知、失败结论、收口总结）；需要用户答复的问题一律用 eteams_ask_user 弹窗问，不得写进 report。',
  ].join('\n');
}
