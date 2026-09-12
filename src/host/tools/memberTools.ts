/**
 * Member tool face (docs/11 member column): claim/decline/progress/
 * complete/fail + board/message/status. harness 0.1.2 起随 root 作用域注册
 * （宿主移除了 registerContinuableSetup per-child 装配）——领队/构建器子代理
 * 经 spawn toolFilter deny 拒见，非成员调用由 resolveCaller 拒绝。
 *
 * @module dsh-eteams/tools/memberTools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { ETeamsResolvedConfig } from '../config.js';
import { ETeamsError, type RuntimeContext } from '../runtime/base.js';
import {
  claimTask,
  declineTask,
  appendProgress,
  completeTask,
  failTask,
} from '../runtime/assignment.js';
import { envForAgent, resolveCaller } from './identity.js';
import { renderContract } from '../prompts/handoff/mails.js';

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }];
}

const str = (description: string) => ({ type: 'string' as const, description });
const strR = (description: string) => ({
  type: 'string' as const,
  description,
  required: true as const,
});
/** 任务号 / 尝试号全库自增（docs/27）——参数与输出一律整数（docs/35 §5#11）。 */
const int = (description: string) => ({ type: 'integer' as const, description });
const intR = (description: string) => ({
  type: 'integer' as const,
  description,
  required: true as const,
});

/** Build the member tool set for one child scope. */
export function createMemberTools(
  config: ETeamsResolvedConfig,
  hostCtx: Context,
): ReturnType<typeof defineTool>[] {
  const runtime = hostCtx as unknown as RuntimeContext;

  const memberOf = async (exec: { agent?: unknown; signal?: AbortSignal }) => {
    const env = envForAgent(config, runtime, exec.agent as never, exec.signal);
    const caller = await resolveCaller(env, exec.agent as never);
    if (caller.kind !== 'member') {
      throw new ETeamsError('该工具仅团队成员可用', '领队请使用对应的管理工具');
    }
    return { env, caller };
  };

  const claimTool = defineTool({
    name: 'eteams_claim_task',
    description:
      '接取指派给你的任务：返回 attempt_id 与 token（后续进度的凭证）+ 完整合同 + 邮箱摘要。接不了用 eteams_decline_task。',
    parameters: { taskId: intR('任务号（面板「任务 #N」的 N）') },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: { type: 'boolean' as const, description: '是否成功' },
          taskId: int('任务号'),
          attemptId: int('attempt id'),
          token: str('执行凭证（妥善保管）'),
          contract: str('任务合同全文'),
          inboxPreview: {
            type: 'array' as const,
            items: { type: 'string' as const },
            description: '最近邮箱消息摘要',
          },
        },
        additionalProperties: false as const,
      },
      render: (_a, v) =>
        text(
          `已接取任务 ${v.taskId}（attempt_id ${v.attemptId}，token ${v.token}）\n` +
            '后续 eteams_append_progress / eteams_complete_task / eteams_fail_task ' +
            '必须原样携带上面的 attempt_id 与 token。\n\n' +
            `${v.contract}`,
        ),
    },
    execute: async (args, exec) => {
      const { env, caller } = await memberOf(exec);
      const { attempt, token, task, inboxPreview } = await claimTask(
        env,
        caller.team,
        caller.member,
        args.taskId,
      );
      return {
        ok: true as const,
        taskId: task.id,
        attemptId: attempt.id,
        token,
        contract: renderContract(task),
        inboxPreview,
      };
    },
  });

  const declineTool = defineTool({
    name: 'eteams_decline_task',
    description:
      '婉拒指派（能力/负载/前置不满足）：任务回到就绪池，领队改派。已接取的任务不能用本工具。',
    parameters: { taskId: intR('任务号（面板「任务 #N」的 N）'), reason: strR('婉拒原因（具体到缺什么）') },
    output: {
      schema: {
        type: 'object' as const,
        properties: { ok: { type: 'boolean' as const, description: '是否成功' } },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(v.ok ? '已婉拒，领队会改派' : '婉拒失败'),
    },
    execute: async (args, exec) => {
      const { env, caller } = await memberOf(exec);
      await declineTask(env, caller.team, caller.member, args.taskId, args.reason);
      return { ok: true as const };
    },
  });

  const progressTool = defineTool({
    name: 'eteams_append_progress',
    description: '记录执行进度（≤200 字）：开工即记，阶段节点再记。需要 attempt_id 与 token。',
    parameters: {
      taskId: intR('任务号'),
      attemptId: intR('attempt id'),
      token: strR('接取时获得的 token'),
      text: strR('进度内容（≤200 字）'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: { ok: { type: 'boolean' as const, description: '是否成功' } },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(v.ok ? '进度已记录' : '记录失败'),
    },
    execute: async (args, exec) => {
      const { env, caller } = await memberOf(exec);
      await appendProgress(env, caller.team, caller.member, { ...args });
      return { ok: true as const };
    },
  });

  const completeTool = defineTool({
    name: 'eteams_complete_task',
    description:
      '交付完成：output 写清做了什么/改了哪些文件/如何验证；changedPaths 列改动文件。链任务完成中间站后领队会推进下一站。',
    parameters: {
      taskId: intR('任务号'),
      attemptId: intR('attempt id'),
      token: strR('接取时获得的 token'),
      output: strR('产出说明'),
      changedPaths: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: '改动文件列表',
      },
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: { type: 'boolean' as const, description: '是否成功' },
          done: { type: 'boolean' as const, description: '任务整体是否完成（false=中间站）' },
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(v.done ? '任务完成，领队已收到通知' : '站点完成，等待领队推进下一站'),
    },
    execute: async (args, exec) => {
      const { env, caller } = await memberOf(exec);
      const { done } = await completeTask(env, caller.team, caller.member, { ...args });
      return { ok: true as const, done };
    },
  });

  const failTool = defineTool({
    name: 'eteams_fail_task',
    description:
      '上报失败：error 写具体障碍与已尝试方案。未超重试上限会自动安排同成员重试；超限落 wait（待领队）由领队分诊——小 bug 重新指派 loop、流程问题升级用户。',
    parameters: {
      taskId: intR('任务号'),
      attemptId: intR('attempt id'),
      token: strR('token'),
      error: strR('失败原因与已尝试方案'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: { type: 'boolean' as const, description: '是否成功' },
          retried: { type: 'boolean' as const, description: '是否已安排重试' },
          retryCount: { type: 'integer' as const, description: '当前重试次数' },
          maxRetries: { type: 'integer' as const, description: '重试上限' },
        },
        additionalProperties: false as const,
      },
      render: (_a, v) =>
        text(
          v.retried
            ? `将重试（${v.retryCount}/${v.maxRetries}），注意查收新指派`
            : '已达重试上限，任务转待领队分诊',
        ),
    },
    execute: async (args, exec) => {
      const { env, caller } = await memberOf(exec);
      const { retried, retryCount, maxRetries } = await failTask(env, caller.team, caller.member, {
        ...args,
      });
      return { ok: true as const, retried, retryCount, maxRetries };
    },
  });

  // eteams_task_board / eteams_team_status / eteams_send_message 的成员视角
  // 已并入 captainTools 的同名工具（harness 0.1.2 起同名工具在 root 只能有
  // 一个，成员/领队行为按 caller.kind 分支）——本工厂只剩成员专属的五件套。

  return [claimTool, declineTool, progressTool, completeTool, failTool];
}
