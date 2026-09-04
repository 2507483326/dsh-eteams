/**
 * 运行时 steer 文本（访谈唤醒）：构建代理发布意图访谈后，给主对话的唤醒
 * 全文（含问题 JSON，主代理转弹选择框）。纯文本函数——去重指纹与 steer
 * 时机（tools/captainTools.ts）属运行时编排，不随文本走。
 *
 * @module dsh-eteams/prompts/steering/interview
 */

/** 构建代理发布访谈后，给主对话的唤醒文本（含问题 JSON，主代理转弹选择框）。 */
export function interviewSteerText(step: string, request: string, questions: unknown): string {
  return [
    `【eteams 角色构建师】后台构建代理已在「${step}」阶段发布意图访谈（成员需求：${request.slice(0, 80)}）。`,
    '请立即用 ask_user_question 工具把下列问题逐题弹给用户选择：每问映射为 { id, question, options: [{label, description?}], multi_select: q.multi === true }，选项文案保持原样（含「（推荐）」后缀，推荐项已在首位）。',
    '用户答完后调用 eteams_interview_answer 工具提交（answers: [{id, choice}]，choice=所选项 label，多选以「、」连接）。不要在聊天文本里复述问题，不要改写选项。',
    '注意：构建已受理并派发，不要调用 eteams_build_dispatch 或 /eteam，不要重新开构建——你的任务只有弹问与提交答案。',
    '问题清单 JSON：',
    JSON.stringify(questions, null, 2),
  ].join('\n');
}