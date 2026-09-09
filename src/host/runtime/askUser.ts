/**
 * 子代理用户问答路由（eteams_ask_user 运行时编排）：eteam 创建的子代理
 * （领队/成员）需要向用户弹问答时——
 * ① 用户正在看本会话（presence 心跳 15s 内且命中提问会话）→ 就地弹
 *    `ctx.userQuestions.ask()`（答案同步返回）；
 * ② 不在 → 严格转交团队主会话弹出（任务行快照 teamMainSessionOf；异常缺
 *    快照退心跳会话兜底），steer 在线主会话 / `agents.resume` 冷恢复离线
 *    主会话；**提问方立即返回并结束回合**——不做任何停驻轮询（回合边界才
 *    消费排队消息，阻塞停驻会把唤醒饿死在队列里，用户迭代 2026-09-08）；
 *    用户作答后 `eteams_ask_answer` 回收并经 {@link wakeAskingChild} 把答案
 *    以 followup 送达提问子代理的新回合。
 * ③ 主会话缺失/投递失败 → 降级：问题写进汇报文本直接问用户（captainChild
 *    既有兜底路径）。
 *
 * 弹窗服务硬约束（dsh-user-questions）：全局单 provider、不做路由——弹窗
 * 永远落在提问者自己的对话框，用户不在那里就看不见；插件无法在 provider
 * 层劫持（DUPLICATE_PROVIDER），只能在工具层路由。presence 只是优化信号
 * （心跳缺失/过期一律按「不在」处理，宁可转交不可白弹）。
 *
 * @module dsh-eteams/runtime/askUser
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { askSteerText } from '../prompts/steering/ask.js';
import type { TeamState } from '../model/types.js';
import {
  answerAskSync,
  cancelAskSync,
  newAskId,
  normalizeAskAnswer,
  insertAskSync,
  type AskAnswer,
  type AskQuestion,
} from '../state/asks.js';
import { recordEvent } from '../state/events.js';
import {
  deliverNotice,
  deliverToChild,
  stateRootOf,
  type RuntimeEnv,
} from './base.js';
import { teamMainSessionOf } from './notifier.js';
import { readBuildPresence } from './roleBuilder.js';

/** popSelf 判定的心跳新鲜度（构建器访谈同款 15s——宁可转交不可白弹）。 */
export const ASK_PRESENCE_TTL_MS = 15_000;

/** 调用者视图（工具层从 resolveCaller 结果投影；runtime 不反向依赖 tools）。 */
export interface AskCallerView {
  team: TeamState;
  /** 提问子代理会话 id。 */
  askingSessionId: string;
  /** 展示名：成员名 / '领队'。 */
  askingName: string;
  askingKind: 'captain' | 'member';
  /** 相关大任务 id（可选，落问答单供面板定位）。 */
  mainTaskId?: number;
}

/** 路由判定（纯函数）：self=就地弹 / relay=转交主会话 / degrade=降级文本问答。 */
export function decideAskRoute(input: {
  askingSessionId: string;
  /** 团队主会话快照（teamMainSessionOf；空串=无快照）。 */
  mainSessionId: string;
  /** 新鲜 presence 命中的会话 id（调用方已按 TTL 过滤；undefined=不在/过期）。 */
  presenceSessionId?: string;
}): { mode: 'self' } | { mode: 'relay'; targetSessionId: string } | { mode: 'degrade' } {
  // 用户正看着提问会话：就地弹（弹窗落在用户眼前的对话框）。
  if (input.presenceSessionId !== undefined && input.presenceSessionId === input.askingSessionId) {
    return { mode: 'self' };
  }
  // 严格主会话路由：无快照（异常数据）退心跳会话兜底，再无则降级。
  let target = input.mainSessionId;
  if (target === '') target = input.presenceSessionId ?? '';
  if (target === '') return { mode: 'degrade' };
  // 主会话自己提问（绑定会话/无领队团队主持会话）：目标即自己，直接弹。
  if (target === input.askingSessionId) return { mode: 'self' };
  return { mode: 'relay', targetSessionId: target };
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

/** runAskUser 的三种结局：self=就地弹已拿到答案；relayed=已转交主会话、
 * 问答单挂起（提问方结束回合，答案稍后经 wakeAskingChild 送达）；
 * degraded=问答不可用，调用方把问题写进文本直接问用户。 */
export type AskOutcome =
  | { mode: 'self'; askId: string; answers: AskAnswer[] }
  | { mode: 'relayed'; askId: string; targetSessionId: string }
  | { mode: 'degraded'; askId?: string; reason: string };

/** 降级指引（工具层透传给提问子代理；captainChild 既有兜底路径的口径）。 */
export function askDegradeHint(reason: string): string {
  return [
    `问答不可用（${reason}）。`,
    '不要重试弹窗：把问题连同推荐项写进你的汇报/下一条消息，直接以文本向用户提问（推荐项放首位并标注「（推荐）」），用户答复会经对话转回。',
  ].join('\n');
}

/** 转交成功后给提问子代理的行动指引（立即结束回合，等唤醒，不停驻）。 */
export function askRelayNextStep(targetSessionId: string): string {
  return [
    `问答已转交主会话（${targetSessionId.slice(0, 8)}…）弹出。`,
    '请在你的输出中告知用户：问答已转至主会话，请到主会话作答；然后立即结束本回合——不要停驻、不要轮询等待（eteams_build_wait 也不要调）。用户作答后宿主会把答案以新消息送达你，收到后继续。',
  ].join('\n');
}

/**
 * 路由并执行一次用户问答。options.agent 是提问者 Agent（就地弹时透传给
 * 弹窗服务做运行时根鉴权；转交路径不使用）。转交分支不阻塞：落问答单、
 * 投递主会话后立即返回。
 */
export async function runAskUser(
  env: RuntimeEnv,
  caller: AskCallerView,
  questions: AskQuestion[],
  options: { agent?: unknown } = {},
): Promise<AskOutcome> {
  const root = stateRootOf(env);
  const presence = readBuildPresence(root, ASK_PRESENCE_TTL_MS);
  const route = decideAskRoute({
    askingSessionId: caller.askingSessionId,
    mainSessionId: teamMainSessionOf(caller.team),
    ...(presence !== null ? { presenceSessionId: presence.sessionId } : {}),
  });
  const now = Date.now();

  if (route.mode === 'degrade') {
    return {
      mode: 'degraded',
      reason: '团队没有可用的主会话锚点（无任务快照且无心跳）',
    };
  }

  const askId = newAskId();
  const askRowBase = {
    askId,
    teamId: caller.team.id,
    askingSessionId: caller.askingSessionId,
    askingName: caller.askingName,
    askingKind: caller.askingKind,
    ...(caller.mainTaskId !== undefined ? { mainTaskId: caller.mainTaskId } : {}),
    questions,
    status: 'pending' as const,
    createdAt: now,
    updatedAt: now,
  };

  if (route.mode === 'self') {
    const service = userQuestionsOf(env.ctx);
    if (service === undefined) {
      return { mode: 'degraded', reason: '弹窗服务不可用（宿主未提供 userQuestions）' };
    }
    // 就地弹也落审计行（面板/动态可见）：pending → answered。
    insertAskSync(root, { ...askRowBase, relaySessionId: caller.askingSessionId });
    try {
      const reply = await service.ask({
        questions,
        ...(options.agent !== undefined ? { agent: options.agent } : {}),
        ...(env.signal !== undefined ? { signal: env.signal } : {}),
      });
      const answers = reply.answers
        .map(normalizeAskAnswer)
        .filter((a): a is AskAnswer => a !== undefined);
      answerAskSync(root, askId, answers);
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

  // ---- 转交主会话弹出（不阻塞：落单 → 投递 → 立即返回） ------------------
  const target = route.targetSessionId;
  insertAskSync(root, { ...askRowBase, relaySessionId: target });
  const delivered = await deliverAskRelay(env, target, [
    {
      type: 'text',
      text: askSteerText(caller.askingName, caller.team.name, askId, questions),
    },
  ]);
  if (!delivered) {
    cancelAskSync(root, askId);
    return {
      mode: 'degraded',
      askId,
      reason: `主会话（${target.slice(0, 8)}…）不在线且冷恢复投递失败`,
    };
  }
  void recordEvent(
    root,
    caller.team.id,
    { kind: caller.askingKind, name: caller.askingName },
    'ask.relayed',
    { payload: { askId, to: target, name: caller.askingName } },
  ).catch(() => undefined);
  return { mode: 'relayed', askId, targetSessionId: target };
}

/** 把转交全文投递到主会话：在线 steer；离线 `agents.resume` 冷恢复后
 * followup 唤醒（captainFor/wakeCaptain 同款路径）。投递失败返回 false。 */
async function deliverAskRelay(
  env: RuntimeEnv,
  targetSessionId: string,
  blocks: { type: 'text'; text: string }[],
): Promise<boolean> {
  const live = env.ctx.agents.get(targetSessionId);
  if (live !== undefined) {
    try {
      // 0.1.2 起 steer 不唤醒空白会话——转交全文走 send('next-step', wakeup)：
      // running 目标在最近 step 边界入列，idle/空白目标开新回合（wakeup 对
      // 三种状态都正确）；旧宿主退回 steer。
      deliverNotice(
        live,
        createUserMessage({
          content: blocks,
          source: {
            kind: 'plugin',
            plugin: 'dsh-eteams',
            form: 'notice',
            summary: '子代理问答转交——请在本对话作答',
          },
        }),
        'next-step',
      );
      return true;
    } catch (error) {
      env.ctx.logger.warn(`eteams: ask relay steer failed: ${String(error)}`);
      // steer 失败继续尝试冷恢复投递。
    }
  }
  const resume = env.ctx.agents.resume;
  if (resume === undefined) return false;
  try {
    const handle = await resume({
      resumeSessionId: targetSessionId as unknown as SessionId,
      ...(env.signal !== undefined ? { signal: env.signal } : {}),
    });
    handle.agent.followup(
      createUserMessage({ content: blocks, source: { kind: 'plugin', plugin: 'dsh-eteams' } }),
    );
    env.ctx.logger.warn(`eteams: 主会话不在线，已冷恢复投递问答转交（${targetSessionId}）`);
    return true;
  } catch (error) {
    env.ctx.logger.warn(`eteams: ask relay cold-resume failed: ${String(error)}`);
    return false;
  }
}

/**
 * 答案回收后唤醒提问子代理（eteams_ask_answer 调用）：向主会话锚点（任务
 * 行快照 → presence 心跳 → 冷恢复）取活父代理，`subagents.followup` 把答案
 * 送进提问子代理的**新回合**——提问方早已结束回合（转交即返回），不存在
 * 排队饿死。唤醒失败只告警：问答单已落库（answers 持久），面板仍可见。
 * @returns 是否投递成功。
 */
export async function wakeAskingChild(
  env: RuntimeEnv,
  team: TeamState,
  askingSessionId: string,
  text: string,
): Promise<boolean> {
  const root = stateRootOf(env);
  const anchorId = teamMainSessionOf(team) || readBuildPresence(root)?.sessionId || '';
  if (anchorId === '') {
    env.ctx.logger.warn('eteams: 问答唤醒找不到主会话锚点（无快照且无心跳）');
    return false;
  }
  let anchor = env.ctx.agents.get(anchorId);
  if (anchor === undefined) {
    // 主会话不在线：冷恢复当父锚（captainFor 三级梯 DA50 同款；句柄不 dispose）。
    try {
      const handle = await env.ctx.agents.resume?.({
        resumeSessionId: anchorId as unknown as SessionId,
        ...(env.signal !== undefined ? { signal: env.signal } : {}),
      });
      if (handle !== undefined) anchor = handle.agent;
    } catch (error) {
      env.ctx.logger.warn(`eteams: 问答唤醒冷恢复主会话失败（${anchorId}）：${String(error)}`);
      return false;
    }
  }
  if (anchor === undefined) return false;
  try {
    await deliverToChild(
      env.ctx.subagents,
      anchor,
      askingSessionId as unknown as SessionId,
      [{ type: 'text', text }],
      env.signal,
    );
    return true;
  } catch (error) {
    env.ctx.logger.warn(`eteams: 问答唤醒投递失败（${askingSessionId}）：${String(error)}`);
    return false;
  }
}

/** 答案回执文本（followup 唤醒正文；提问子代理上下文里有自己的问题）。 */
export function askAnswerWakeText(questions: AskQuestion[], answers: AskAnswer[]): string {
  const questionById = new Map(questions.map((q) => [q.id, q.question]));
  const lines = answers.map(
    (a) =>
      `- ${questionById.get(a.id) ?? a.id}：${a.selected || '（自填）'}${
        a.custom !== undefined ? `（自填：${a.custom}）` : ''
      }`,
  );
  return [
    '【eteams 问答已作答】用户已回答你转交主会话的问答，请继续推进：',
    ...lines,
    '如仍有需要用户本人决策的事项，再次调用 eteams_ask_user 即可。',
  ].join('\n');
}

/**
 * 构建器访谈发布（eteams_build_report 的 interview 面调用）：与
 * {@link runAskUser} 同一套统一路由——presence 命中构建子会话 → 就地弹
 * （builder 自己弹 ask_user_question）；否则严格转交构建父（主会话）弹出。
 * 落同一张 ask_questions 表（teamId=0 工作区桶——构建会话不属团队），答案
 * 经 eteams_ask_answer 的构建桥接回收（构建会话状态同步 + wakeBuilderChild）。
 * `forceParent` 供 popFailed 补转用：跳过 presence（子代理自弹刚被拒，
 * 再判 self 只会原地重蹈），强制转交构建父。
 */
export async function publishBuilderAsk(
  env: RuntimeEnv,
  input: {
    /** 构建子代理 durable 会话 id（builderChildId）。 */
    askingSessionId: string;
    /** 展示名（转交弹窗里向用户说明来源）。 */
    askingName: string;
    /** 构建父主会话 id（侧车；空串=无侧车）。 */
    parentSessionId: string;
    questions: AskQuestion[];
    forceParent?: boolean;
  },
): Promise<{ outcome: 'self' | 'relayed' | 'degraded'; askId?: string; targetSessionId?: string }> {
  const root = stateRootOf(env);
  const presence = input.forceParent === true ? null : readBuildPresence(root, ASK_PRESENCE_TTL_MS);
  const route = decideAskRoute({
    askingSessionId: input.askingSessionId,
    mainSessionId: input.parentSessionId,
    ...(presence !== null ? { presenceSessionId: presence.sessionId } : {}),
  });
  if (route.mode === 'self') return { outcome: 'self' };
  if (route.mode === 'degrade') return { outcome: 'degraded' };
  const askId = newAskId();
  const now = Date.now();
  insertAskSync(root, {
    askId,
    teamId: 0,
    askingSessionId: input.askingSessionId,
    askingName: input.askingName,
    askingKind: 'conversation',
    questions: input.questions,
    status: 'pending',
    relaySessionId: route.targetSessionId,
    createdAt: now,
    updatedAt: now,
  });
  const delivered = await deliverAskRelay(env, route.targetSessionId, [
    {
      type: 'text',
      text: askSteerText(input.askingName, '成员构建', askId, input.questions),
    },
  ]);
  if (!delivered) {
    cancelAskSync(root, askId);
    return { outcome: 'degraded', askId };
  }
  return { outcome: 'relayed', askId, targetSessionId: route.targetSessionId };
}
