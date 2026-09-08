/**
 * 子代理用户问答工具面（eteams_ask_user / eteams_ask_answer）：eteam 创建的
 * 所有子代理（领队/成员）需要向用户弹问答时统一走 eteams_ask_user——运行时
 * （runtime/askUser）自动判断用户是否正在看提问会话：在就就地弹（答案同步
 * 返回）；不在就严格转交主会话弹出并**立即返回**（提问方结束回合，答案经
 * eteams_ask_answer 回收后由宿主 followup 送达新回合，不停驻轮询）。
 * eteams_ask_answer 是转交弹窗所在对话的回收入口（主会话/被中转会话均可提
 * 交），构建器访谈（build_report 发布）的问答单也经它桥接回收。注册在根
 * 作用域、不进任何 deny 列表——成员经根注册表可见（MEMBER_DENIED_TOOLS 只
 * deny 管理面工具）。
 *
 * @module dsh-eteams/tools/askUserTools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { ETeamsResolvedConfig } from '../config.js';
import { ETeamsError, PLUGIN_ACTOR, stateRootOf, type RuntimeContext } from '../runtime/base.js';
import {
  askAnswerWakeText,
  askDegradeHint,
  askRelayNextStep,
  runAskUser,
  wakeAskingChild,
  type AskCallerView,
} from '../runtime/askUser.js';
import {
  answerBuildInterview,
  cancelBuildSession,
  readBuildParentSession,
  readBuildSession,
} from '../runtime/roleBuilder.js';
import { wakeBuilderChild } from '../runtime/builderPhases.js';
import { readTeamSync } from '../state/store.js';
import {
  answerAskSync,
  normalizeAskAnswer,
  type AskAnswer,
  type AskQuestion,
} from '../state/asks.js';
import { recordEvent } from '../state/events.js';
import { envForAgent, resolveCaller } from './identity.js';

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }];
}

const str = (description: string) => ({ type: 'string' as const, description });
const strR = (description: string) => ({
  type: 'string' as const,
  description,
  required: true as const,
});
const bool = (description: string) => ({ type: 'boolean' as const, description });

/** 入参问题校验（id/question 必填；options 原样透传给弹窗服务渲染）。 */
function normalizeQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) throw new ETeamsError('questions 必须是问题列表');
  const questions: AskQuestion[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = typeof o['id'] === 'string' ? o['id'] : '';
    const question = typeof o['question'] === 'string' ? o['question'] : '';
    if (id === '' || question === '') {
      throw new ETeamsError('每道题都必须带非空 id 与 question');
    }
    const options = Array.isArray(o['options'])
      ? o['options']
          .filter((opt): opt is Record<string, unknown> => opt !== null && typeof opt === 'object')
          .map((opt) => ({
            label: typeof opt['label'] === 'string' ? opt['label'] : '',
            ...(typeof opt['description'] === 'string' && opt['description'] !== ''
              ? { description: opt['description'] as string }
              : {}),
          }))
          .filter((opt) => opt.label !== '')
      : [];
    questions.push({
      id,
      question,
      ...(typeof o['header'] === 'string' && o['header'] !== '' ? { header: o['header'] as string } : {}),
      options,
      ...(o['multiSelect'] === true ? { multiSelect: true } : {}),
    });
  }
  if (questions.length === 0) throw new ETeamsError('questions 不能为空（一次问全 ≤5 问）');
  return questions;
}

/** Build the ask-user tool pair. Registered on the root context; visible to
 * captain children and members alike (never denied). */
export function createAskUserTools(
  config: ETeamsResolvedConfig,
  hostCtx: Context,
): ReturnType<typeof defineTool>[] {
  const runtime = hostCtx as unknown as RuntimeContext;

  const askUserTool = defineTool({
    name: 'eteams_ask_user',
    description:
      '需要用户本人决策时向用户弹问答（自动路由）：用户正在看本会话就就地弹窗（答案同步返回，同回合继续）；不在就把问答转交主会话弹出并立即返回——随后结束本回合（不要停驻/轮询等待），用户作答后答案会以新消息送达你。一次问全 ≤5 问（每问 {id, question, header?, options: [{label, description?}], multiSelect?}），推荐项放首位并在 label 尾标注「（推荐）」。返回 mode=degraded 时按 degradeHint 降级：把问题写进汇报/消息文本直接问用户，不要再重试弹窗。',
    parameters: {
      questions: {
        type: 'array' as const,
        required: true as const,
        description: '问题列表（一次问全 ≤5 问）',
        items: {
          type: 'object' as const,
          properties: {
            id: str('问题唯一 id'),
            question: str('问题文本'),
            header: str('问题题头（可省）'),
            options: {
              type: 'array' as const,
              description: '2-4 个选项，推荐项放首位并在 label 尾加「（推荐）」',
              items: {
                type: 'object' as const,
                properties: {
                  label: str('选项文案'),
                  description: str('选项说明（可省）'),
                },
                additionalProperties: false,
              },
            },
            multiSelect: { type: 'boolean' as const, description: '允许多选（缺省单选）' },
          },
          additionalProperties: false,
        },
      },
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          mode: str('路由结局：self=就地弹已拿到答案 / relayed=已转交主会话待作答（结束回合等唤醒） / degraded=问答不可用'),
          askId: str('问答单 ID'),
          answers: {
            type: 'array' as const,
            description: '用户答案：[{id, selected, custom?}]（仅 self 时存在）',
            items: {
              type: 'object' as const,
              properties: {
                id: str('问题唯一 id'),
                selected: str('所选项 label（多选以「、」连接）'),
                custom: str('用户自填文本（可省）'),
              },
              additionalProperties: false,
            },
          },
          relayedTo: str('转交目标主会话 ID（relayed 时存在）'),
          nextStep: str('转交后的行动指引（relayed 时存在）'),
          degradeHint: str('降级指引（degraded 时存在）'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => {
        if (v.mode === 'degraded') return text(v.degradeHint ?? '问答不可用');
        if (v.mode === 'relayed') return text(v.nextStep ?? '问答已转交主会话');
        return text('用户已在本对话作答（答案见 answers）');
      },
    },
    // 会话内行内呈现：默认卡会把整包渲染成大 JSON 行——收敛为一行。
    presentCall: (args) => ({
      card: 'generic' as const,
      title: `用户问答 · ${Array.isArray(args.questions) ? args.questions.length : '?'} 问`,
    }),
    presentResult: (_args, result) => {
      if (result.isError) return undefined;
      return { card: 'generic' as const, title: '问答已受理（细节见工具结果）', content: [] };
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      if (!exec.agent) throw new ETeamsError('无法识别调用者（exec.agent 缺失）');
      const caller = await resolveCaller(env, exec.agent);
      const questions = normalizeQuestions(args.questions);
      const view: AskCallerView = {
        team: caller.team,
        askingSessionId: String(exec.agent.id ?? ''),
        askingName: caller.kind === 'member' ? caller.member.name : '领队',
        askingKind: caller.kind === 'member' ? 'member' : 'captain',
        ...(caller.kind === 'member' && caller.member.mainTaskId !== null
          ? { mainTaskId: caller.member.mainTaskId }
          : {}),
      };
      const outcome = await runAskUser(env, view, questions, { agent: exec.agent });
      if (outcome.mode === 'degraded') {
        return {
          ok: true as const,
          mode: 'degraded' as const,
          ...(outcome.askId !== undefined ? { askId: outcome.askId } : {}),
          degradeHint: askDegradeHint(outcome.reason),
        };
      }
      if (outcome.mode === 'relayed') {
        return {
          ok: true as const,
          mode: 'relayed' as const,
          askId: outcome.askId,
          relayedTo: outcome.targetSessionId,
          nextStep: askRelayNextStep(outcome.targetSessionId),
        };
      }
      return {
        ok: true as const,
        mode: 'self' as const,
        askId: outcome.askId,
        answers: outcome.answers,
      };
    },
  });

  const askAnswerTool = defineTool({
    name: 'eteams_ask_answer',
    description:
      '提交转交问答的答案（eteams_ask_user 转交弹窗所在对话的回收入口）：askId 随转交消息给出，answers 与问题一一对应（selected=所选项 label，多选以「、」连接；用户自填答案放 custom）。提交后提问子代理自动续跑，无需再做其它事；问答单只能提交一次（已结束的问答单会被拒绝）。',
    parameters: {
      askId: strR('问答单 ID（转交消息文末给出）'),
      answers: {
        type: 'array' as const,
        required: true as const,
        description: '答案列表：[{id: 问题id, selected: 所选项文案, custom?: 用户自填}]',
        items: {
          type: 'object' as const,
          properties: {
            id: str('问题唯一 id'),
            selected: str('所选项 label（多选以「、」连接；纯自填时为空串）'),
            custom: str('用户自填文本（可省）'),
          },
          additionalProperties: false,
        },
      },
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          askId: str('问答单 ID'),
          status: str('问答单状态（answered）'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`问答答案已提交（${(v.askId ?? '').slice(0, 8)}…）——提问子代理续跑中`),
    },
    execute: async (args, exec) => {
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      if (!exec.agent) throw new ETeamsError('无法识别调用者（exec.agent 缺失）');
      const answers = (Array.isArray(args.answers) ? args.answers : [])
        .map(normalizeAskAnswer)
        .filter((a): a is AskAnswer => a !== undefined);
      if (answers.length === 0) throw new ETeamsError('answers 不能为空');
      const root = stateRootOf(env);
      // 提交者身份只用于事件留痕（问答单行里的 teamId 是真相源）；转交流程
      // 中的对话都有团队身份，解析失败也不拦提交。
      let actor = PLUGIN_ACTOR;
      try {
        const caller = await resolveCaller(env, exec.agent);
        actor = caller.actor;
      } catch {
        // 未解析身份（面板外的陌生会话）也允许提交——答案按 askId 落行。
      }
      let record;
      try {
        record = answerAskSync(root, args.askId, answers);
      } catch (error) {
        throw new ETeamsError(
          error instanceof Error ? error.message : String(error),
          '请核对转交消息文末的 askId；已结束的问答单不可再提交',
        );
      }
      void recordEvent(root, record.teamId, actor, 'ask.answered', {
        payload: { askId: args.askId },
      }).catch(() => undefined);
      // 回收后唤醒提问子代理（答案送进它的新回合；提问方转交即结束回合，
      // 不存在停驻排队）。构建器访谈的问答单走构建桥接（会话状态同步 +
      // wakeBuilderChild 自带冷恢复重建），其余走通用 followup。
      const buildSession = readBuildSession(root);
      if (
        buildSession?.builderChildId !== undefined &&
        buildSession.builderChildId === record.askingSessionId
      ) {
        try {
          await answerBuildInterview(
            root,
            answers.map((a) => ({
              id: a.id,
              choice: a.custom !== undefined && a.custom !== '' ? `${a.custom}` : a.selected,
            })),
          );
        } catch {
          // 构建会话已终态/无访谈态：问答单照常回收，不拦唤醒。
        }
        const parentSessionId = readBuildParentSession(root);
        const parent =
          parentSessionId !== null
            ? (env.ctx as RuntimeContext).agents?.get(parentSessionId)
            : undefined;
        if (parent !== undefined) {
          void wakeBuilderChild({
            ctx: env.ctx,
            config,
            parent,
            stateRoot: root,
            kind: 'continue',
            logger: env.ctx.logger,
            onSpawnFailure: () => {
              void cancelBuildSession(root, '构建唤醒失败——可稍后点「继续构建」重试').catch(
                () => undefined,
              );
            },
          });
        } else {
          env.ctx.logger.warn('eteams: 构建父会话不在线，问答答案已落库（面板可重启代理续跑）');
        }
      } else {
        const team = record.teamId !== 0 ? readTeamSync(root, record.teamId) : undefined;
        if (team !== undefined) {
          await wakeAskingChild(
            env,
            team,
            record.askingSessionId,
            askAnswerWakeText(record.questions, answers),
          );
        }
      }
      return { ok: true as const, askId: record.askId, status: record.status };
    },
  });

  return [askUserTool, askAnswerTool];
}
