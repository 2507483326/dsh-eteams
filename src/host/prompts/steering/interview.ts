/**
 * 运行时 steer 文本（访谈唤醒）：构建代理发布意图访谈后，给中转目标对话的
 * 唤醒全文（含问题 JSON，收到方转弹选择框）。中转目标可以是主对话（popFailed
 * 兜底与 19.21 发布边沿父中转——用户不在子会话时弹窗跟随用户）或成员子会话
 * （19.18 发布边沿 presence 投递）——文本以「收到方」为
 * 第二人称，各路同款。纯文本函数——去重指纹与投递时机（tools/
 * captainTools.ts）属运行时编排，不随文本走。
 *
 * @module dsh-eteams/prompts/steering/interview
 */

/** 构建代理发布访谈后，给中转目标对话的唤醒文本（含问题 JSON，收到方转弹选择框）。 */
export function interviewSteerText(step: string, request: string, questions: unknown): string {
  return [
    `【eteams 角色构建师】后台构建代理已在「${step}」阶段发布意图访谈（成员需求：${request.slice(0, 80)}）。`,
    '请立即用 ask_user_question 工具把下列问题逐题弹给用户选择：每问映射为 { id, question, options: [{label, description?}], multi_select: q.multi === true }，选项文案保持原样（含「（推荐）」后缀，推荐项已在首位）。',
    '用户答完后调用 eteams_interview_answer 工具提交（answers: [{id, choice}]，choice=所选项 label，多选以「、」连接）。不要在聊天文本里复述问题，不要改写选项。',
    '弹窗不可用（被拒/报错/被用户关闭）时不要重试弹窗：把上述问题以纯文本列出，请用户在对话里直接回复所选项 label（多选题列出全部想要的选项），你收到回复后解析成 answers 并调用 eteams_interview_answer 提交。',
    '注意：构建已受理并派发，不要调用 eteams_build_dispatch 或 /eteam，不要重新开构建——你的任务只有弹问（或文本问答）与提交答案。',
    '问题清单 JSON：',
    JSON.stringify(questions, null, 2),
  ].join('\n');
}