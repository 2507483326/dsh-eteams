/**
 * 运行时 steer 文本（用户问答转交）：子代理发布问答后，给主会话的唤醒全文
 * （含问答单 ID 与问题 JSON，收到方转弹选择框并回收答案）。文本以「收到方」
 * 为第二人称，与 interviewSteerText 同款——纯文本函数，去重指纹与投递时机
 * （runtime/askUser.ts）属运行时编排，不随文本走。
 *
 * @module dsh-eteams/prompts/steering/ask
 */

/** 子代理问答转交主会话时的唤醒文本（收到方转弹选择框，答案经 eteams_ask_answer 回流）。 */
export function askSteerText(
  askingName: string,
  teamName: string,
  askId: string,
  questions: unknown,
): string {
  return [
    `【eteams 用户问答转交】${teamName} 的成员「${askingName}」需要用户本人决策，但用户不在它的会话——问答已转交本对话弹出。`,
    '请立即用 ask_user_question 工具把下列问题逐题弹给用户选择：每问映射为 { id, question, header?, options: [{label, description?}], multi_select: q.multiSelect === true }，选项文案保持原样（含「（推荐）」后缀，推荐项已在首位）；弹出前先向用户说明这是成员「' +
      askingName +
      '」转交的问答。',
    '用户答完后调用 eteams_ask_answer 工具提交（askId 见文末，answers: [{id, selected}]，selected=所选项 label，多选以「、」连接；用户自填答案放 custom）。不要在聊天文本里复述问题，不要改写选项，不要替成员补充或回答。',
    '弹窗不可用（被拒/报错/被用户关闭）时不要重试弹窗：把问题以纯文本列出，请用户在对话里直接回复所选项 label（多选题列出全部想要的选项），你收到回复后解析成 answers 并调用 eteams_ask_answer 提交。',
    '提交答案后无需再做其它事——提问子代理会由宿主唤醒续跑。',
    `问答单 ID（askId）：${askId}`,
    '问题清单 JSON：',
    JSON.stringify(questions, null, 2),
  ].join('\n');
}
