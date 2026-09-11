/**
 * 「添加任务」的新建对话编排（用户迭代 2026-09-11：点击添加任务不是加小任务、
 * 也不建面板「创建中」容器，而是**新建一个对话**，把任务描述作为首条消息带
 * 过去，并把所选团队绑定到新对话）。
 *
 * 为什么是新建对话而不是宿主 commission：团队绑定 band 在首轮系统提示词组装
 * 时按「有无锚定主任务」给分工——新对话无锚定主任务，band 即「两步走」（先
 * `eteams_submit_task` 建任务单 → 再 `eteams_dispatch_captain` 转交领队；
 * 未设领队的团队由该会话直接主持）。于是「从零建立一个任务单」由对话流程
 * 天然完成，与用户在对话里直接提任务的工作流**完全同源**，不新增宿主路径。
 *
 * 顺序有语义（不能换）：建会话 → 绑团队 → 投递首条消息 → 切过去。绑团队必须
 * 在投递之前 await 完成，否则首轮组装时 band 还不在，描述发出去就成了普通
 * 会话（团队没带过去）。
 *
 * React-free 且全部依赖经结构探测面注入，能在 node 单测里用假 sessions/HTTP
 * 面驱动（本仓无 React 测试设施，页内逻辑不可测）。
 *
 * @module dsh-eteams/client/taskConversation
 */
import { setSessionTeam } from './api';
import { errorMessageOf } from './errors';
import { createSession, openSession, promptSession, sessionCwdOf } from './sessionState';

/** 新建对话编排结果：成功带新会话 id（`warning` = 已落地但某步降级）。 */
export type TaskConversationOutcome =
  | { ok: true; sessionId: string; warning?: string }
  | { ok: false; error: string };

/** 编排入参：用户填的任务描述 + 所选团队 + 来源会话（沿用其工作区）。 */
export interface TaskConversationInput {
  /** 任务描述原文——将以用户消息原样投递给新对话。 */
  readonly description: string;
  /** 要绑定到新对话的团队 id。 */
  readonly teamId: string;
  /** 来源会话 id（整页团队页表面没有会话，缺省即用宿主默认工作区）。 */
  readonly fromSessionId?: string;
}

/**
 * 开一个团队任务对话：新会话沿用来源会话的工作区 → 绑团队 → 投递描述 →
 * 切到新会话。
 *
 * 失败分层（调用方按层提示）：建会话失败 / 绑团队失败 → `ok:false`（什么都没
 * 落地或只留一个空会话，弹窗留在原地让用户重试）；投递失败或切换失败 →
 * `ok:true` + `warning`（会话已开，消息可重发，不该把用户困在旧对话里）。
 */
export async function openTaskConversation(
  input: TaskConversationInput,
): Promise<TaskConversationOutcome> {
  const cwd = sessionCwdOf(input.fromSessionId ?? '');
  const sessionId = await createSession(cwd !== null ? { cwd } : undefined);
  if (sessionId === null) {
    return { ok: false, error: '当前运行时无法新建对话（会话服务不可用），任务未创建。' };
  }
  try {
    await setSessionTeam(sessionId, input.teamId);
  } catch (error) {
    return { ok: false, error: `新对话已建立，但团队绑定失败：${errorMessageOf(error)}` };
  }
  const prompted = await promptSession(sessionId, input.description);
  if (!openSession(sessionId)) {
    return { ok: false, error: '新对话已建立但无法切换过去——请在会话列表中打开它。' };
  }
  if (!prompted) {
    return {
      ok: true,
      sessionId,
      warning: '新对话已打开，但任务描述未投递——请在输入框里重新发送。',
    };
  }
  return { ok: true, sessionId };
}
