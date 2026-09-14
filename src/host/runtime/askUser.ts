/**
 * 子代理用户问答（eteams_ask_user 运行时编排，2026-09-10 统一）：eteam 的
 * 子代理（领队/成员/构建师）需要向用户弹问答时一律——
 * ① 审计行落 ask_questions（status=pending）：面板「待问答」徽标的数据源；
 * ② ctx.userQuestions.ask() 弹**DeepSeek 原生问答弹窗**并阻塞——目标按
 *    「用户当前所在会话」判定（presence 心跳，见 runAskUser）：用户正看着
 *    提问子代理自己的对话 → 就地弹；否则弹提问子代理所属的**主对话**（任务
 *    锚/构建父会话记录的主会话；主对话代理是活运行时根，原生弹窗直接接管
 *    它的输入区，侧边栏琥珀点常驻未决标记）；主对话不在线（CALLER_NOT_LIVE）
 *    或弹窗被拒时退回提问子代理自己的对话再试一次（子代理也是 continuable
 *    运行时根，用户打开该会话即可作答）；答完同回合继续，答案同步返回；
 * ③ 构建师调用时宿主自动把答案写回构建会话（answerBuildInterview，覆写幂
 *    等）——构建子代理无须再 eteams_build_report(answers)；
 * ④ 两次弹窗都被拒/服务缺失 → 行转 cancelled，返回 degradeHint（把问题写
 *    进汇报文本直接问用户的既有兜底）。
 *
 * 宿主不做更多会话路由：弹窗是原生组件，弹在哪由传入的 agent 决定；除
 * presence 命中就地在提问会话弹、否则主对话优先、自身兜底外不引入第三目标，
 * 也不唤醒任何对话的 LLM。
 * （旧转交路径——presence 判定、steer 主会话代弹、eteams_ask_answer 回收、
 * wakeAskingChild 唤醒——随统一整体退役，2026-09-10。）
 *
 * @module dsh-eteams/runtime/askUser
 */
import {
  answerAskSync,
  cancelAskSync,
  newAskId,
  normalizeAskAnswer,
  insertAskSync,
  recordAskDeliverySync,
  type AskAnswer,
  type AskQuestion,
} from '../state/asks.js';
import { stateRootOf, type RuntimeEnv } from './base.js';
import { answerBuildInterview, readBuildPresence, readBuildSession } from './roleBuilder.js';

/** 调用者视图（工具层从 resolveCaller 结果投影；runtime 不反向依赖 tools）。 */
export interface AskCallerView {
  /** 所属团队 id（0 = 无团队桶——构建会话等对话外调用者）。 */
  teamId: number;
  /** 提问子代理会话 id。 */
  askingSessionId: string;
  /** 展示名：成员名 / '领队' / '角色构建师'。 */
  askingName: string;
  askingKind: 'captain' | 'member' | 'conversation';
  /** 相关大任务 id（可选，落问答单供面板定位）。 */
  mainTaskId?: number;
  /**
   * 弹窗目标主对话会话 id（可选）：提问子代理所属任务锚的主会话 / 构建父
   * 会话。主会话亲自问（绑定身份）不带此字段——它自己就是主对话。
   */
  mainSessionId?: string;
}

/** ctx.userQuestions 服务面（结构子集；dsh-user-questions 的 ask 契约）。 */
interface UserQuestionsFace {
  ask(request: {
    questions: AskQuestion[];
    agent?: unknown;
    signal?: AbortSignal;
  }): Promise<{ answers: AskAnswer[] }>;
}

/** Defensive lookup（cordis 4 未声明 inject 的服务属性访问会抛；吞错降级）。 */
function userQuestionsOf(ctx: unknown): UserQuestionsFace | undefined {
  try {
    const direct = (ctx as { userQuestions?: unknown }).userQuestions;
    if (direct !== undefined && direct !== null) return direct as UserQuestionsFace;
    const got = (ctx as { get?: (key: string) => unknown }).get?.('userQuestions');
    return got !== undefined && got !== null ? (got as UserQuestionsFace) : undefined;
  } catch {
    return undefined;
  }
}

/** 主对话的活代理（assignment/notifier 同款 agents.get 取活实例；注册表
 * 按会话 id 命中 = 该对话窗口在线）。缺失/结构未知 → undefined。 */
function liveAgentOf(ctx: unknown, sessionId: string | undefined): unknown {
  if (sessionId === undefined || sessionId === '') return undefined;
  try {
    const live = (ctx as { agents?: { get?: (id: string) => unknown } }).agents?.get?.(sessionId);
    return live ?? undefined;
  } catch {
    return undefined;
  }
}

/** runAskUser 的两种结局：self=弹窗已拿到答案（同回合继续）；
 * degraded=问答不可用，调用方把问题写进文本直接问用户。 */
export type AskOutcome =
  | { mode: 'self'; askId: string; answers: AskAnswer[] }
  | { mode: 'degraded'; askId?: string; reason: string };

/**
 * 执行一次用户问答（统一路径，2026-09-10）：落审计行 → 主对话弹原生问答
 * 弹窗（阻塞；主对话不在线退回提问会话自身）→ 答案落行回传。主对话代理经
 * agents.get 取活实例（弹窗服务按 agent 鉴权：必须恰是注册表里的活运行时
 * 根，否则 CALLER_NOT_LIVE）。弹窗服务缺失在落单前拦下（不留孤儿行）；两
 * 次弹窗都被拒/报错把行转 cancelled 后降级。
 */
export async function runAskUser(
  env: RuntimeEnv,
  caller: AskCallerView,
  questions: AskQuestion[],
  options: { agent?: unknown } = {},
): Promise<AskOutcome> {
  const root = stateRootOf(env);
  const service = userQuestionsOf(env.ctx);
  if (service === undefined) {
    return { mode: 'degraded', reason: '弹窗服务不可用（宿主未提供 userQuestions）' };
  }

  // 弹窗目标按「用户当前所在会话」判定（用户 2026-09-12「判断用户当前在哪个
  // 会话，如果在当前会话就弹当前会话，不在就弹主会话」）：presence 心跳命中
  // 提问会话自身（用户正看着这个子对话）→ 就地弹；否则弹主对话（用户通常在
  // 主对话里），主对话不在线退回提问会话自身。
  const presence = readBuildPresence(root);
  const userInAskingSession = presence !== null && presence.sessionId === caller.askingSessionId;
  const mainAgent = liveAgentOf(env.ctx, caller.mainSessionId);
  // 弹窗主对话优先（用户 2026-09-12）：用户不在提问子会话、且主对话有活代理
  // 时弹主对话，否则弹提问子会话自身。primaryIsMain 决定落点会话的记录（v14）。
  const primaryIsMain =
    !userInAskingSession && mainAgent !== undefined && mainAgent !== options.agent;
  const primary = primaryIsMain ? mainAgent : options.agent;

  const askId = newAskId();
  const now = Date.now();
  // 落点意图**先落库**（v14）：弹窗是阻塞的，面板需在待答期间就能拿到落点去
  // 跳转，不能等答完才写；主对话不在线退回提问子会话时再由 recordAskDeliverySync
  // 更正为提问会话。
  const deliverySessionId = primaryIsMain
    ? (caller.mainSessionId ?? caller.askingSessionId)
    : caller.askingSessionId;
  // 就地弹也落审计行（面板徽标的数据源）：pending → answered。
  insertAskSync(root, {
    askId,
    teamId: caller.teamId,
    askingSessionId: caller.askingSessionId,
    askingName: caller.askingName,
    askingKind: caller.askingKind,
    ...(caller.mainTaskId !== undefined ? { mainTaskId: caller.mainTaskId } : {}),
    questions,
    status: 'pending',
    // relaySessionId 审计留档：恒等于提问会话自身（旧转交时代的字段，保留
    // 兼容历史行读端）；v14 弹窗实际落点另落 delivery_session_id/is_main。
    relaySessionId: caller.askingSessionId,
    deliverySessionId,
    deliveryIsMain: primaryIsMain,
    createdAt: now,
    updatedAt: now,
  });
  const askOnce = (agent: unknown): Promise<{ answers: AskAnswer[] }> =>
    service.ask({
      questions,
      ...(agent !== undefined ? { agent } : {}),
      ...(env.signal !== undefined ? { signal: env.signal } : {}),
    });
  try {
    let reply: { answers: AskAnswer[] };
    try {
      reply = await askOnce(primary);
    } catch (primaryError) {
      // 主对话不在线（CALLER_NOT_LIVE）/弹窗被拒 → 退回提问子代理自己的
      // 对话再试一次（侧边栏未决标记仍引导用户）；同目标或无兜底则原样上抛。
      if (primary === options.agent || options.agent === undefined) throw primaryError;
      reply = await askOnce(options.agent);
      // 退回提问子会话成功：更正落点记录（面板据此跳到子会话作答）。
      recordAskDeliverySync(root, askId, caller.askingSessionId, false);
    }
    const answers = reply.answers
      .map(normalizeAskAnswer)
      .filter((a): a is AskAnswer => a !== undefined);
    answerAskSync(root, askId, answers);
    // 构建师分支（统一问答 2026-09-10）：构建子代理的问答由宿主自动写回
    // 构建会话——它同回合拿到 answers 继续起草，不再自己 build_report(answers)。
    // 判据与旧桥接一致（builderChildId 严格相等）；构建会话已终态/无访谈态
    // 时静默跳过（问答单照常回收，弹窗答案仍回传给调用者）。
    const buildSession = readBuildSession(root);
    if (buildSession?.builderChildId === caller.askingSessionId) {
      try {
        await answerBuildInterview(
          root,
          answers.map((a) => ({
            id: a.id,
            choice: a.custom !== undefined && a.custom !== '' ? `${a.custom}` : a.selected,
          })),
        );
      } catch {
        // 无访谈态/已终态：不拦问答返回。
      }
    }
    return { mode: 'self', askId, answers };
  } catch (error) {
    cancelAskSync(root, askId);
    return {
      mode: 'degraded',
      askId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
