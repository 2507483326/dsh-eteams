/**
 * Member tool face (docs/11 member column): claim/decline/progress/
 * complete/fail + board/message/status. Registered per member child scope
 * (runtime/members installMemberRuntime); the captain never sees these.
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
import { sendMessage, teamView } from '../runtime/teamOps.js';
import { envForAgent, resolveCaller } from './identity.js';
import { renderContract } from '../prompts/handoff/mails.js';
import { stationPointsTo } from '../model/taskMachine.js';

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
      render: (_a, v) => text(`已接取 ${v.taskId}（${v.attemptId}）\n\n${v.contract}`),
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
      '上报失败：error 写具体障碍与已尝试方案。未超重试上限会自动安排同成员重试；超限进入领队决策。',
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
            : '已达重试上限，交由领队决策',
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

  const boardTool = defineTool({
    name: 'eteams_task_board',
    description: '查看你的任务看板：被指派任务、当前 attempt、执行链进度。',
    parameters: {},
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: { type: 'boolean' as const, description: '是否成功' },
          view: { type: 'object' as const, properties: {}, additionalProperties: true },
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(JSON.stringify(v.view, null, 2)),
    },
    execute: async (_args, exec) => {
      const { caller } = await memberOf(exec);
      const me = caller.member;
      // 我名下的任务：assignee 或执行链余下站点指向我的工号（v7 链站点写
      // 工号；旧名字站点退按名比对）。
      const mine = caller.team.tasks.filter(
        (t) =>
          t.assignee === me.name ||
          t.chain.some((s, i) => i > t.chainCursor && stationPointsTo(s, me)),
      );
      // 角色/路线读班底行（docs/35 §3#5：人设/路线在班底，task_members=副本行）。
      const template = caller.team.members.find((m) => m.employeeId === me.employeeId);
      // 当前任务口径（docs/36 建议 2）：wait(已派待接取)/start(执行中)/paused
      // 三态之一；completed/failed 等终态任务不再是「当前任务」。
      const current = mine.find((t) => ['wait', 'start', 'paused'].includes(t.status));
      const view = {
        member: me.name,
        employeeId: me.employeeId,
        role: template?.role ?? me.name,
        currentTask: current?.id ?? null,
        tasks: mine.map((t) => ({
          id: t.id,
          subject: t.subject,
          status: t.status,
          assignee: t.assignee ?? null,
          station:
            t.chain.length > 0
              ? {
                  // 末站完成即 completed（chainCursor 不再推进）——完成态直接
                  // 按满进度口径显示（docs/35 §5#10 观察项）。
                  done: t.status === 'completed' ? t.chain.length : t.chainCursor + 1,
                  total: t.chain.length,
                  mine: t.chain.findIndex(
                    (s, i) => i > t.chainCursor && stationPointsTo(s, me),
                  ),
                }
              : null,
          contract: renderContract(t),
        })),
      };
      return { ok: true as const, view };
    },
  });

  const messageTool = defineTool({
    name: 'eteams_send_message',
    description:
      '私信：to="captain" 发给领队（求助/决策/汇报），或 to=成员工号（面板「ET-xxxx」的数字，同名成员各收各箱）。不直接打扰用户。',
    parameters: {
      to: strR('收件人（captain 或成员工号/成员名）'),
      content: strR('消息内容'),
      taskId: int('相关任务号（可选）'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: { type: 'boolean' as const, description: '是否成功' },
          to: str('收件人'),
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(`已发送给 ${v.to}`),
    },
    execute: async (args, exec) => {
      const { env, caller } = await memberOf(exec);
      if (args.to.trim() === caller.member.name) throw new ETeamsError('不能给自己发消息');
      await sendMessage(env, caller.team, caller.actor, args.to, args.content, {
        taskId: args.taskId,
      });
      return { ok: true as const, to: args.to };
    },
  });

  const statusTool = defineTool({
    name: 'eteams_team_status',
    description: '团队概览（只读）：成员、任务进度。',
    parameters: {},
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: { type: 'boolean' as const, description: '是否成功' },
          view: { type: 'object' as const, properties: {}, additionalProperties: true },
        },
        additionalProperties: false as const,
      },
      render: (_a, v) => text(JSON.stringify(v.view, null, 2)),
    },
    execute: async (_args, exec) => {
      const { env, caller } = await memberOf(exec);
      return { ok: true as const, view: teamView(env, caller.team) };
    },
  });

  return [
    claimTool,
    declineTool,
    progressTool,
    completeTool,
    failTool,
    boardTool,
    messageTool,
    statusTool,
  ];
}
