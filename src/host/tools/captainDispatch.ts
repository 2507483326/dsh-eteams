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
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { ETeamsResolvedConfig } from '../config.js';
import {
  ETeamsError,
  sessionDefaultRouteOf,
  stateRootFor,
  stateRootOf,
  type RuntimeContext,
  type RuntimeEnv,
} from '../runtime/base.js';
import type { TeamState } from '../model/types.js';
import { readTeamSync, withTeamTx } from '../state/store.js';
import { leaderRowOf } from '../runtime/notifier.js';
import { teamView } from '../runtime/teamOps.js';
import { envForAgent, resolveCaller } from './identity.js';
import {
  buildCaptainLabel,
  registerCaptainChild,
  unregisterCaptainChild,
  CAPTAIN_CHILD_DENIED_TOOLS,
} from '../runtime/captainAgent.js';
import { captainChildPersona } from '../prompts/spawn/captainChild.js';
import { captainDispatchPrompt, dispatchAck } from '../prompts/steering/dispatch.js';
import { findRosterMember, LEADER_NAME } from '../runtime/roster.js';
import { composeCaptainPersona } from '../prompts/personas/captain.js';
import { locks, teamLockKey } from '../state/lock.js';

/** JSON-schema snippet helpers (mirror captainTools). */
const strR = (description: string) => ({
  type: 'string' as const,
  description,
  required: true as const,
});
const bool = (description: string) => ({ type: 'boolean' as const, description });

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }];
}

/** Narrow text blocks for subagent payloads (harness turns are text-only). */
const textTurn = (value: string): { type: 'text'; text: string }[] => [
  { type: 'text', text: value },
];

/** 领队子代理 followup 的消息来源（与 notifier 的队长唤醒保持一致）。 */
const CAPTAIN_SOURCE = { kind: 'plugin' as const, plugin: 'dsh-eteams' };

/**
 * 组装领队子代理人格：静态纪律 + 领队角色手册（用户迭代 2026-09-03
 * 「领队agent 没有把领队的md放到上下文中」——roster 项目牧羊人条目的
 * personaMd 是用户可编辑的领队手册，缺省回退内置手册）。
 */
function captainPersonaOf(env: RuntimeEnv, config: ETeamsResolvedConfig): string {
  const fromRoster = findRosterMember(stateRootOf(env), LEADER_NAME)?.personaMd;
  const fallback = composeCaptainPersona(stateRootFor(config, env.workspace)).personaMd;
  return captainChildPersona(fromRoster ?? fallback);
}

/**
 * 落盘持续领队子代理的 durable id：写领队行（task_members 领队锚点行，
 * name=领队名且 main_task_id 为空）的 child_session_id——团队锁内同步事务
 * 直改该列，不整存整取快照。团队消失（删除竞态）时静默放弃——子代理已
 * 建立但惰性无害，下一次 dispatch 按空缺处理。
 */
async function persistCaptainChildId(
  env: RuntimeEnv,
  teamId: string,
  childId: string,
): Promise<void> {
  const root = stateRootOf(env);
  await locks.withLock(teamLockKey(root, teamId), async () => {
    const team = readTeamSync(root, teamId);
    if (team === undefined) return;
    const leader = leaderRowOf(team);
    if (leader === undefined || leader.childSessionId === childId) return;
    withTeamTx(root, team.id, (tx) => {
      tx.db
        .prepare(
          'UPDATE task_members SET child_session_id = ?, update_time = ? ' +
            'WHERE team_id = ? AND name = ? AND main_task_id IS NULL',
        )
        .run(childId, Date.now(), team.id, LEADER_NAME);
    });
  });
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
      '把用户交给团队的任务（或对任务的答复/追问、团队邮件通知）转交持续领队子代理主持——首次转交建立每团队一个的持久子代理会话，后续转交在同一会话续聊。子代理直接向用户弹问询（ask_user_question），每轮汇报经子代理汇报消息送达本对话；本会话原样展示到达的汇报即可（简短确认，不要复述全文），不要直接调用 eteams_* 工具，也不要自己动手执行任务。',
    parameters: {
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
      const subagents = env.ctx.subagents;
      if (subagents?.startContinuable === undefined || subagents?.followup === undefined) {
        throw new ETeamsError('子代理服务不可用，无法派发领队子代理');
      }
      const signal = exec.signal ?? new AbortController().signal;
      // 现状快照随派发现读（docs/26.2 状态驱动）：首轮快照给领队子代理建立
      // 团队上下文；持续子代理后续轮次在既有上下文上续步，快照只作对账。
      const prompt = captainDispatchPrompt(
        JSON.stringify(teamView(env, team), null, 1),
        args.message,
      );
      const persona = captainPersonaOf(env, config);
      const leader = leaderRowOf(team);
      const previous = leader?.childSessionId ?? '';
      // 领队子代理运行路线（用户迭代 2026-09-04 恢复领队模型选择）：领队行
      // model 有值即 override（provider 固定 config.memberProvider，docs/35
      // §3#5）；空 = 会话默认——宿主 agent-default-model 即时快照 pin；服务
      // 缺失退回不带 agentOptions 的旧行为。
      const leaderModel = leader?.model ?? '';
      const agentOptions =
        leaderModel !== ''
          ? {
              provider: config.memberProvider,
              model: leaderModel,
              ...(leader?.reasoningEffort ? { reasoningEffort: leader.reasoningEffort } : {}),
            }
          : sessionDefaultRouteOf(env.ctx);
      // 先试续聊（含宿主重启后的冷恢复）；失败（会话记录被回收/lineage 不
      // 符）再重建。注册表先撤旧条目再登记新会话。
      if (previous !== '') {
        try {
          await subagents.followup(exec.agent, previous as unknown as SessionId, textTurn(prompt), {
            source: { ...CAPTAIN_SOURCE },
            signal,
          });
          registerCaptainChild(previous, String(team.id));
          return { ok: true as const, relayed: dispatchAck(previous) };
        } catch {
          unregisterCaptainChild(previous);
        }
      }
      // 首次派发：startContinuable 建立持久子代理（inbox 接受初始 prompt 即
      // 返回，不等待轮次完成——汇报经 report 通道随后送达）。
      const start = await subagents.startContinuable({
        provider: config.memberProvider,
        label: buildCaptainLabel(String(team.id)),
        request: {
          prompt: textTurn(prompt),
          parent: exec.agent,
          persona,
          toolFilter: { deny: [...CAPTAIN_CHILD_DENIED_TOOLS] },
          ...(agentOptions !== undefined ? { agentOptions } : {}),
        },
        signal,
      });
      const childId = String(start.childId);
      // 子代理的 eteams_* 调用按该团队领队解析（identity.ts / 跨工作区重指）。
      registerCaptainChild(childId, String(team.id));
      await persistCaptainChildId(env, String(team.id), childId);
      return { ok: true as const, relayed: dispatchAck(childId) };
    },
  });
}
