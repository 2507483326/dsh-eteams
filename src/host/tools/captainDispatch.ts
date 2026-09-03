/**
 * 领队子代理派发工具（docs/26 用户迭代 2026-09-03）：主窗口只转交，领队
 * 工作（提交任务单、问询弹窗、拆解、指派、汇报）由一次性领队子代理承担
 * （构建代理同款 one-shot 模式）。每次派发生成全新子代理——状态全部落在
 * eteams 文件（team/tasks/问卷），子代理按【团队现状】快照续步，最终输出
 * 作为工具结果透传给主窗口显示。
 *
 * @module dsh-eteams/tools/captainDispatch
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { ETeamsResolvedConfig } from '../config.js';
import { ETeamsError, stateRootOf, type RuntimeContext } from '../runtime/base.js';
import type { TeamState } from '../model/types.js';
import { readTeam } from '../state/store.js';
import { teamView } from '../runtime/teamOps.js';
import { envForAgent, resolveCaller } from './identity.js';
import {
  buildCaptainLabel,
  registerCaptainChild,
  unregisterCaptainChild,
  CAPTAIN_CHILD_DENIED_TOOLS,
} from '../runtime/captainAgent.js';
import { CAPTAIN_CHILD_PERSONA } from '../prompts/captain.js';

/** JSON-schema snippet helpers (mirror captainTools). */
const strR = (description: string) => ({
  type: 'string' as const,
  description,
  required: true as const,
});
const bool = (description: string) => ({ type: 'boolean' as const, description });

/** Untyped `subagents.start` result, narrowed to the fields dispatch reads. */
interface SubagentResultLike {
  stopReason?: string;
  diagnostic?: string;
  output?: unknown;
}

/** Extract the child's final assistant text (SubagentResult.output contract). */
function relayText(output: unknown): string {
  if (!Array.isArray(output)) return '';
  return output
    .map((block) =>
      block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .join('\n')
    .trim();
}

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }];
}

/**
 * Create the dispatch tool. Registered on the root context beside the other
 * captain tools; members deny it at spawn (MEMBER_DENIED_TOOLS).
 */
export function createCaptainDispatchTool(
  config: ETeamsResolvedConfig,
  hostCtx: Context,
): ReturnType<typeof defineTool> {
  const runtime = hostCtx as unknown as RuntimeContext;
  return defineTool({
    name: 'eteams_dispatch_captain',
    description:
      '把用户交给团队的任务（或对任务的答复/追问、团队邮件通知）转交领队子代理主持——子代理完成提交、问询（ask_user_question 弹窗）、拆解、指派，并返回一段给用户的汇报文本。本会话把该文本展示给用户即可（简短确认，不要复述全文），不要直接调用 eteams_* 工具，也不要自己动手执行任务。',
    parameters: {
      message: strR('转交内容：用户任务/答复原话，或团队通知的要点'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('领队子代理是否正常完成'),
          relayed: strR('领队子代理给用户的汇报文本'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(v.relayed),
    },
    execute: async (args, exec) => {
      if (!exec.agent) throw new ETeamsError('无法识别调用者（exec.agent 缺失）');
      const env = envForAgent(config, runtime, exec.agent, exec.signal);
      const caller = await resolveCaller(env, exec.agent);
      if (caller.kind !== 'captain') {
        throw new ETeamsError('只有团队领队会话可以转交领队子代理');
      }
      const team: TeamState | undefined = await readTeam(stateRootOf(env), caller.team.id);
      if (!team) throw new ETeamsError(`团队「${caller.team.id}」不存在`);
      const subagents = env.ctx.subagents;
      if (subagents?.start === undefined) {
        throw new ETeamsError('子代理服务不可用，无法派发领队子代理');
      }
      // 现状快照随派发现读（docs/26.2 状态驱动）：领队子代理每次从快照续步，
      // 不依赖跨派发上下文；mailbox 尾部让汇报/通知语境可见。
      const prompt = [
        '【团队现状】',
        JSON.stringify(teamView(env, team), null, 1),
        '',
        '【用户/主对话最新消息】',
        args.message,
      ].join('\n');
      const run = await subagents.start(config.memberProvider, {
        label: buildCaptainLabel(team.id),
        prompt: [{ type: 'text', text: prompt }],
        parent: exec.agent,
        signal: exec.signal ?? new AbortController().signal,
        persona: CAPTAIN_CHILD_PERSONA,
        toolFilter: { deny: [...CAPTAIN_CHILD_DENIED_TOOLS] },
      });
      if (run === undefined) {
        throw new ETeamsError('领队子代理派发失败（子代理服务返回空）');
      }
      const childId = String(run.id);
      // 子代理的 eteams_* 调用按该团队领队解析（identity.ts / 跨工作区重指）。
      registerCaptainChild(childId, team.id);
      try {
        // base.ts narrows the untyped result to `unknown` — the one-shot
        // SubagentResult contract is { output, stopReason, diagnostic? }.
        const result = (await run.result) as SubagentResultLike;
        const relayed = relayText(result.output);
        if (result.stopReason !== 'completed') {
          return {
            ok: false as const,
            relayed:
              relayed ||
              `（领队子代理异常结束：${result.stopReason ?? 'unknown'}${
                result.diagnostic ? '——' + result.diagnostic : ''
              }）`,
          };
        }
        return { ok: true as const, relayed };
      } finally {
        unregisterCaptainChild(childId);
        // 官方契约（docs/20.2.1）：消费方必须始终 dispose 一次性 run。
        try {
          await run.dispose();
        } catch {
          // dispose 失败不影响已透传的结果
        }
      }
    },
  });
}
