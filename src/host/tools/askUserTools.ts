/**
 * 子代理用户问答工具面（eteams_ask_user，2026-09-10 统一）：eteam 的所有子
 * 代理（领队/成员/构建师）需要向用户弹问答时统一走 eteams_ask_user——弹
 * DeepSeek 原生问答弹窗并阻塞等答案、答完同回合继续；弹窗目标按「用户当前
 * 所在会话」判定（2026-09-12）：用户正看着提问子代理自己的对话 → 就地弹，
 * 否则弹提问子代理所属的**主对话**（任务锚/构建父会话记录的主会话），主对话
 * 不在线由 runtime 退回提问会话自身。旧转交路径（eteams_ask_answer 回收、
 * steer 主会话代弹）已随统一退役。注册在根作用域、不进任何 deny 列表——
 * 成员经根注册表可见（MEMBER_DENIED_TOOLS 只 deny 管理面工具）。
 *
 * @module dsh-eteams/tools/askUserTools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { ETeamsResolvedConfig } from '../config.js';
import { ETeamsError, stateRootOf, type RuntimeContext } from '../runtime/base.js';
import { askDegradeHint } from '../prompts/steering/askFallback.js';
import { runAskUser, type AskCallerView } from '../runtime/askUser.js';
import { captainChildTaskOf } from '../runtime/captainChildRegistry.js';
import { readBuildParentSession, readBuildSession } from '../runtime/roleBuilder.js';
import type { TeamState } from '../model/types.js';
import type { AskQuestion } from '../state/asks.js';
import { envForAgent, resolveCaller } from './identity.js';

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }];
}

const str = (description: string) => ({ type: 'string' as const, description });
const bool = (description: string) => ({ type: 'boolean' as const, description });

/** 多选字段别名容错（2026-09-11 实况）：模型会把规范字段 multiSelect 漂移成
 * snake_case 的 multi_select（或构建访谈旧名 multi）——问题项 schema 虽已放宽
 * （additionalProperties: true），这里仍把别名收口回规范字段，避免多选语义丢失。 */
function multiSelectOf(o: Record<string, unknown>): boolean {
  return o['multiSelect'] === true || o['multi_select'] === true || o['multi'] === true;
}

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
      ...(multiSelectOf(o) ? { multiSelect: true } : {}),
    });
  }
  if (questions.length === 0) throw new ETeamsError('questions 不能为空（一次问全 ≤5 问）');
  return questions;
}

/** Build the ask-user tool. Registered on the root context; visible to captain
 * children, members and the builder child alike (never denied). */
export function createAskUserTools(
  config: ETeamsResolvedConfig,
  hostCtx: Context,
): ReturnType<typeof defineTool>[] {
  const runtime = hostCtx as unknown as RuntimeContext;

  /** 弹窗目标主对话的会话 id：按大任务锚回读主会话（v6 锚点在任务行）。
   * 任务缺锚（面板建卡未派发）→ undefined——runtime 退回提问会话自身。 */
  const mainSessionIdOf = (team: TeamState, mainTaskId: number | null): string | undefined => {
    if (mainTaskId === null) return undefined;
    return team.tasks.find((t) => t.id === mainTaskId)?.mainSessionId;
  };

  const askUserTool = defineTool({
    name: 'eteams_ask_user',
    description:
      '需要用户本人决策时向用户弹问答：DeepSeek 原生问答弹窗直接弹在**用户当前所在会话**（用户正看着你的对话就弹这里，否则弹主对话）并阻塞等你拿到答案；主对话不在线时自动退回弹在你自己的对话（侧边栏会有未决标记）。答完答案同步返回，你在同回合继续。一次问全 ≤5 问（每问 {id, question, header?, options: [{label, description?}], multiSelect?}）。返回 mode=degraded 时按 degradeHint 降级：把问题写进汇报/消息文本直接问用户，不要再重试弹窗。\n' +
      '提问口径（用户 2026-09-14）——弹窗会弹到主对话，用户手里只有问题本身、没有你的上下文，必须让没参与这个任务的外行也能直接选：\n' +
      '1. 自包含：问题里点明是哪个任务/哪一步、在问什么（带任务主题名或用途，不能只写编号），并交代为什么问；\n' +
      '2. 说人话：不用内部代号、缩写、变量名、文件路径与行话；必须用的术语就地用一句话解释（照跟小学生讲的口径）；\n' +
      '3. 选项写清后果：label 直接写「选它会怎样」（做什么/不做什么、影响哪部分），description 补一句具体影响或例子；禁止只写「方案 A / 方案 B」「看情况」这类没有信息量的选项；\n' +
      '4. 具体可判：能用数字/范围/样例说清的就写出来（数量、上限、时长、示例值），不让用户反问「具体指什么」；\n' +
      '5. 推荐项放首位并在 label 尾标「（推荐）」，description 一句话写明推荐理由。',
    parameters: {
      questions: {
        type: 'array' as const,
        required: true as const,
        description: '问题列表（一次问全 ≤5 问；每问按上方提问口径写自包含、说人话的问题与选项）',
        items: {
          type: 'object' as const,
          properties: {
            id: str('问题唯一 id'),
            question: str('问题文本（自包含：点名哪个任务/哪一步、为什么问；说人话：不用代号、缩写与行话）'),
            header: str('问题题头（可省）：一句话主题，渲染在问题上方'),
            options: {
              type: 'array' as const,
              description:
                '2-4 个选项：每个都写清「选它会怎样」，推荐项放首位并在 label 尾加「（推荐）」；禁止 A/B 代号式无信息量选项',
              items: {
                type: 'object' as const,
                properties: {
                  label: str('选项文案（直接写具体做法与后果；推荐项尾标「（推荐）」）'),
                  description: str('选项说明（可省）：一句具体影响或例子'),
                },
                additionalProperties: false,
              },
            },
            multiSelect: { type: 'boolean' as const, description: '允许多选（缺省单选）' },
          },
          // 问题项放宽（2026-09-11 实况）：模型常把 multiSelect 写成 multi_select，
          // 严格 additionalProperties:false 会让整次调用被宿主按 invalid arguments
          // 拒收——别名交给 normalizeQuestions 归一，未知键忽略（defineTool 要求
          // object 显式声明 additionalProperties，故写 true）。
          additionalProperties: true,
        },
      },
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('是否成功'),
          mode: str('结局：self=已拿到答案（同回合继续） / degraded=问答不可用'),
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
          degradeHint: str('降级指引（degraded 时存在）'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => {
        if (v.mode === 'degraded') return text(v.degradeHint ?? '问答不可用');
        // 答案正文必须进 render：model-facing content 就是 render 的输出，规范值
        // （含 answers）执行局部存活、不回放——只写「答案见 answers」会让调用子代
        // 理拿到空答案（2026-09-14 实况：弹窗已作答但正文未回传）。
        const answers = v.answers ?? [];
        if (answers.length === 0) return text('用户已作答（无答案内容）');
        return text(
          `用户已作答：\n${answers
            .map((a) => {
              const picked = a.selected ?? '';
              const custom = a.custom !== undefined && a.custom !== '' ? `（自填：${a.custom}）` : '';
              return `- ${a.id ?? ''}：${picked}${custom}`;
            })
            .join('\n')}`,
        );
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
      const askingSessionId = String(exec.agent.id ?? '');
      const questions = normalizeQuestions(args.questions);
      // 调用者解析：先按团队身份（成员/领队）；构建师子代理不在任何团队会抛
      // ——此时按构建会话判定（builderChildId 严格相等），两者皆非原样抛错。
      let view: AskCallerView;
      try {
        const caller = await resolveCaller(env, exec.agent);
        // 弹窗目标主对话：成员按自己的大任务锚；领队子代理按注册表记录的
        // 大任务锚（主会话亲自问——绑定/建队身份——本会话即主对话，不带
        // 该字段，弹窗目标就是它自己）。
        const mainTaskId =
          caller.kind === 'member'
            ? caller.member.mainTaskId
            : (() => {
                const taskKey = captainChildTaskOf(askingSessionId);
                return taskKey !== undefined && taskKey !== '' ? Number(taskKey) : null;
              })();
        const mainSessionId = mainSessionIdOf(caller.team, mainTaskId);
        view = {
          teamId: caller.team.id,
          askingSessionId,
          askingName: caller.kind === 'member' ? caller.member.name : '领队',
          askingKind: caller.kind === 'member' ? 'member' : 'captain',
          ...(caller.kind === 'member' && caller.member.mainTaskId !== null
            ? { mainTaskId: caller.member.mainTaskId }
            : {}),
          ...(mainSessionId !== undefined ? { mainSessionId } : {}),
        };
      } catch (error) {
        const root = stateRootOf(env);
        const buildSession = readBuildSession(root);
        if (
          buildSession?.builderChildId !== undefined &&
          buildSession.builderChildId === askingSessionId
        ) {
          // 构建师的弹窗目标 = 发起构建的父会话（/eteam 对话，受理时落盘）。
          const parentSessionId = readBuildParentSession(root);
          view = {
            teamId: 0,
            askingSessionId,
            askingName: '角色构建师',
            askingKind: 'conversation',
            ...(parentSessionId !== null && parentSessionId !== ''
              ? { mainSessionId: parentSessionId }
              : {}),
          };
        } else {
          throw error;
        }
      }
      const outcome = await runAskUser(env, view, questions, { agent: exec.agent });
      if (outcome.mode === 'degraded') {
        return {
          ok: true as const,
          mode: 'degraded' as const,
          ...(outcome.askId !== undefined ? { askId: outcome.askId } : {}),
          degradeHint: askDegradeHint(outcome.reason),
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

  return [askUserTool];
}
