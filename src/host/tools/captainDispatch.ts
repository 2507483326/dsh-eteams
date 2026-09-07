/**
 * 领队子代理派发工具（docs/26 用户迭代 2026-09-03）：主窗口只转交，领队
 * 工作（提交任务单、问询弹窗、拆解、指派、汇报）由「领队子代理」承担。
 *
 * 持续子代理（用户迭代 2026-09-03「不使用一次性子代理，应该是持续代理」）：
 * 每团队一个持久可继续子代理——首次 dispatch `startContinuable` 建立
 * （durable child session id 落盘 `team.captainChildId`），后续 dispatch
 * `followup` 续聊；宿主重启后同会话重连经 durable lineage 冷恢复同一会话
 * （上下文不丢），lineage 不符（换会话绑定/会话记录被回收）则重建并更新
 * 落盘 id。
 *
 * 弹窗归属（用户迭代 2026-09-03「这个提问弹不出来」）：一次性子代理是
 * owned child（owner=派发会话），ask_user_question 在子代理里被
 * DELEGATED_CALLER 拒绝；continuable 子代理由 activation-owner 作用域
 * 登记（无 owner）、是运行时根，弹窗可以直接弹。问询调用失败时子代理把
 * 问题写进 report 降级（persona 有对应降级条款）。
 *
 * 汇报通道：dispatch 立即返回受理确认；子代理每轮结束经 `report` 工具把
 * 汇报发回主对话（harness 的 subagent-report 通道，消息形如
 * 「Background subagent <id> reported: …」），主会话原样展示给用户。
 *
 * @module dsh-eteams/tools/captainDispatch
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { ETeamsResolvedConfig } from '../config.js';
import { ETeamsError, stateRootOf, type RuntimeContext } from '../runtime/base.js';
import type { TeamState } from '../model/types.js';
import { readTeamSync } from '../state/store.js';
import { envForAgent, resolveCaller } from './identity.js';
import { dispatchCaptainCore } from '../runtime/captainAgent.js';
import { captainDispatchPrompt } from '../prompts/steering/dispatch.js';

/** JSON-schema snippet helpers (mirror captainTools). */
const strR = (description: string) => ({
  type: 'string' as const,
  description,
  required: true as const,
});
const int = (description: string) => ({ type: 'integer' as const, description });
const bool = (description: string) => ({ type: 'boolean' as const, description });

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }];
}

/**
 * Create the dispatch tool. Registered on the root context beside the other
 * captain tools; members deny it at spawn (MEMBER_DENIED_TOOLS). 派发核
 * （会话续接/登记/落盘）下沉 runtime/captainAgent.ts——面板手动建任务路径
 * 同函数复用（runtime 不 import tools 层，docs/panelTaskCommission）。
 */
export function createCaptainDispatchTool(
  config: ETeamsResolvedConfig,
  hostCtx: Context,
): ReturnType<typeof defineTool> {
  const runtime = hostCtx as unknown as RuntimeContext;
  return defineTool({
    name: 'eteams_dispatch_captain',
    description:
      '把用户交给团队的任务（或对任务的答复/追问、团队邮件通知）转交领队子代理主持——子会话按大任务锚定（随任务生灭），同一任务的后续转交在同一会话续聊。子代理直接向用户弹问询（ask_user_question），每轮汇报经子代理汇报消息送达本对话；本会话原样展示到达的汇报即可（简短确认，不要复述全文），不要直接调用 eteams_* 工具，也不要自己动手执行任务。',
    parameters: {
      taskId: int('锚定的大任务号（主任务/任务单；band 流程要求先建任务再转交时透传。不传 = 自动取该团队最近的一个主任务）'),
      message: strR('转交内容：用户任务/答复原话，或团队通知的要点'),
    },
    output: {
      schema: {
        type: 'object' as const,
        properties: {
          ok: bool('转交是否被领队子代理受理'),
          relayed: strR('受理确认文本（领队的问询/汇报随后直接到达本对话）'),
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
      const team: TeamState | undefined = readTeamSync(stateRootOf(env), caller.team.id);
      if (!team) throw new ETeamsError(`团队「${caller.team.id}」不存在`);
      // 锚定任务：显式 taskId 优先；缺省取该团队最近的一个主任务（band 两步
      // 走要求先建任务再转交，答复/通知也应带任务号——兜底仅防漏传）。
      const mainTasks = team.tasks.filter((t) => t.parentId === null);
      const task =
        (args.taskId !== undefined ? mainTasks.find((t) => t.id === args.taskId) : undefined) ??
        [...mainTasks].sort((a, b) => b.id - a.id)[0];
      if (!task) throw new ETeamsError('团队还没有主任务——先用 eteams_submit_task 建任务，再转交领队');
      // 现状不随 prompt 内嵌（用户迭代 2026-09-08）：子代理先调
      // eteams_team_status 自取（快照永远现读，单一事实源）。
      const prompt = captainDispatchPrompt(args.message);
      // 派发核（锚定本任务的领队副本行，随任务生灭）：与面板手动建任务路
      // 径共用同一链路（docs/panelTaskCommission）。
      return dispatchCaptainCore(env, config, exec.agent, team, task.id, prompt, exec.signal);
    },
  });
}
