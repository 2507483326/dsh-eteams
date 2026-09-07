/**
 * 领队子代理（docs/26 用户迭代 2026-09-03「主窗口发问题不合适——由领队
 * 子代理完成主持」+「不使用一次性子代理，应该是持续代理」）：对话驱动
 * 团队时，主窗口会话只负责转交，领队工作（提交任务单、问询弹窗、拆解、
 * 指派、汇报）由**持续领队子代理**承担（每团队一个 continuable 子代理，
 * 首次 dispatch 建立、后续 followup 续聊）。
 *
 * 本模块持有三样基础设施：
 * - 子代理标签（`eteams-captain:<领队名>`，用户迭代 2026-09-07：子代理以
 *   领队的名字命名，不再用数字 team id）；
 * - 身份注册表：dispatch 建立的子代理会话 id → 团队 id，resolveCaller /
 *   envForAgent 据此把子代理的 eteams_* 调用按该团队领队解析（含跨工作区
 *   重指），band 组装据此对子代理静默（它自己就是领队，不能再看到
 *   「转交」指示）；
 * - 派发核 dispatchCaptainCore（docs/panelTaskCommission 自 tools/captainDispatch
 *   下沉至此）：续聊/重建/登记/落盘——对话 dispatch 工具与面板手动建任务
 *   两条路径共用（runtime 不 import tools 层，webui 面板路由直接消费）。
 *
 * 子代理是持续会话，注册表条目在其生命周期内常驻：写入发生在建立与每次
 * 续聊（重启后重登记），撤除只在同队重建（旧会话换新）或派发失败——
 * 与一次性时代「轮次结算即撤」不同。
 *
 * @module dsh-eteams/host/runtime/captainAgent
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ETeamsResolvedConfig } from '../config.js';
import { ETeamsError, sessionDefaultRouteOf, stateRootFor, stateRootOf, type RuntimeEnv } from './base.js';
import { readTeamSync, withTeamTx } from '../state/store.js';
import { locks, teamLockKey } from '../state/lock.js';
import { leaderRowOf } from './notifier.js';
import { LEADER_NAME } from './roster.js';
import {
  findRosterMemberInRoots,
  rosterAuthoritativeRoot,
} from './workspaces.js';
import { composeCaptainPersona } from '../prompts/personas/captain.js';
import { captainChildPersona } from '../prompts/spawn/captainChild.js';
import { dispatchAck } from '../prompts/steering/dispatch.js';
import type { TeamState } from '../model/types.js';

/** Label prefix identifying eteams captain children. */
export const CAPTAIN_LABEL_PREFIX = 'eteams-captain:';

/** `eteams-captain:<领队名>` — the child's display label（以领队的名字命名）. */
export function buildCaptainLabel(leaderName: string): string {
  return `${CAPTAIN_LABEL_PREFIX}${leaderName}`;
}

/** Inverse of {@link buildCaptainLabel}. */
export function parseCaptainLabel(label: string | undefined): { leaderName: string } | undefined {
  if (!label || !label.startsWith(CAPTAIN_LABEL_PREFIX)) return undefined;
  const leaderName = label.slice(CAPTAIN_LABEL_PREFIX.length);
  return leaderName === '' ? undefined : { leaderName };
}

/**
 * Live dispatch registry: child session id → teamId, written at spawn and on
 * every followup re-registration (persisted child id survives host restarts,
 * so the map must be re-populated). Dropped only when the same team rebuilds
 * its child (stale lineage) — the child is persistent, not turn-scoped.
 */
const captainChildren = new Map<string, string>();

/** Register a freshly spawned captain child (identity.ts 领队解析依据). */
export function registerCaptainChild(childId: string, teamId: string): void {
  if (childId === '' || teamId === '') return;
  captainChildren.set(childId, teamId);
}

/** The team a captain child serves (undefined for non-captain sessions). */
export function captainChildTeamOf(childId: string): string | undefined {
  return captainChildren.get(childId);
}

/** Drop the registry entry after the run settles (or on spawn failure). */
export function unregisterCaptainChild(childId: string): void {
  captainChildren.delete(childId);
}

/**
 * Captain tool names denied to the 领队子代理 (one visibility, loud deny).
 * Every entry MUST be a registered tool name — spawn applies the list via
 * `tools.restrict({ deny })`, which fails loudly on unknown names inside
 * the child creation window (same footgun note as MEMBER_DENIED_TOOLS;
 * e.g. `eteams_approve_plan` is never registered, so it must NOT appear
 * here). The child must not create/delete teams, open builds, answer
 * interviews, or re-dispatch captains (recursion guard). Subagent spawn
 * tools ('subagent', 'subagent_fork') are intentionally absent — no such
 * registered names were found in the harness, and denying unregistered
 * names aborts the spawn; the child is a continuable runtime ROOT, and
 * while it may report back to its parent, it must not delegate captains
 * (the deny list is the hard guard).
 */
export const CAPTAIN_CHILD_DENIED_TOOLS: readonly string[] = [
  'eteams_create_team',
  'eteams_delete_team',
  'eteams_dispatch_captain',
  'eteams_build_dispatch',
  'eteams_build_report',
  'eteams_interview_answer',
];

/** ================================== 派发核（docs/panelTaskCommission 自 tools/captainDispatch 下沉） ================================== */

/** Narrow text blocks for subagent payloads (harness turns are text-only). */
const textTurn = (value: string): { type: 'text'; text: string }[] => [
  { type: 'text', text: value },
];

/** 领队子代理 followup 的消息来源（与 notifier 的队长唤醒保持一致）。 */
const CAPTAIN_SOURCE = { kind: 'plugin' as const, plugin: 'dsh-eteams' };

/**
 * 组装领队子代理人格：静态纪律 + 领队角色手册。手册的 live 源是角色库
 * （2026-09-08 讨论定案：班底行/副本行是建队/拉人那一刻的烘焙快照，改手册
 * 不回填，领队行本身没烘 personaMd——派发时现读角色库，创建子代理时的
 * 手册即最终版，后续修改与当前子代理无关）。探查顺序：权威根
 * （rosterAuthoritativeRoot = writeWorkspacePath，面板编辑都落这里）→
 * 自己的根——注意自己根里可能有首启播种的陈旧「项目牧羊人」行，权威根
 * 必须在前，否则用户改过的手册被遮蔽（实测「领队的 md 没注入」）。yaml
 * 覆盖随同一根序找；来源打日志，一眼可诊断。
 */
function captainPersonaOf(env: RuntimeEnv, config: ETeamsResolvedConfig): string {
  const roots = [
    ...new Set([rosterAuthoritativeRoot(env.ctx, config), stateRootOf(env)]),
  ].filter((root): root is string => root !== undefined && root !== '');
  const found = findRosterMemberInRoots(roots, LEADER_NAME);
  const fromRoster = found?.entry.personaMd?.trim();
  let personaMd: string;
  let source: string;
  if (found !== undefined && fromRoster !== undefined && fromRoster !== '') {
    personaMd = fromRoster;
    source = `roster(${found.root})`;
  } else {
    // composeCaptainPersona 的缺省手册是常量（ROLE_DOCS['项目牧羊人']），
    // 类型可空仅为字段可选——空串时 captainChildPersona 退静态纪律。
    personaMd = composeCaptainPersona(stateRootFor(config, env.workspace)).personaMd ?? '';
    source = 'builtin';
    for (const root of roots) {
      if (existsSync(join(root, 'captain-persona.yaml'))) {
        personaMd = composeCaptainPersona(root).personaMd ?? '';
        source = `yaml(${root})`;
        break;
      }
    }
  }
  env.ctx.logger.info(`eteams: 领队子代理 persona 来源=${source}`);
  return captainChildPersona(personaMd);
}

/**
 * 落盘持续领队子代理的 durable id：写领队行（task_members 领队行，name=
 * 领队名且 main_task_id 为空）的 session_id——v6 该列记本行自己的子代理
 * 会话。团队锁内同步事务直改该列，不整存整取快照。团队消失（删除竞态）
 * 时静默放弃——子代理已建立但惰性无害，下一次 dispatch 按空缺处理。
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
    if (leader === undefined || leader.sessionId === childId) return;
    withTeamTx(root, team.id, (tx) => {
      tx.db
        .prepare(
          'UPDATE task_members SET session_id = ?, update_time = ? ' +
            'WHERE team_id = ? AND name = ? AND main_task_id IS NULL',
        )
        .run(childId, Date.now(), team.id, LEADER_NAME);
    });
  });
}

/**
 * 派发核心（对话工具与面板手动建任务共用，docs/panelTaskCommission）：
 * 解析领队子代理锚（主持行 sessionId）→ followup 续聊、失败重建
 * （startContinuable，parent 必须是真实直接父——lineage 授权）→ 登记注册表
 * + 落盘 durable id。prompt 由调用方组装（对话 = captainDispatchPrompt；
 * 面板完善 = captainCommissionPrompt，两者都自带团队现状快照）。
 * @param parent 派发父代理（lineage 直接父）：对话路径 = exec.agent；面板
 *   路径 = captainFor 解析的主会话代理。两者只是来源不同，语义同一层。
 * @param prompt 组装好的完整 prompt 文本（含团队现状快照）。
 */
export async function dispatchCaptainCore(
  env: RuntimeEnv,
  config: ETeamsResolvedConfig,
  parent: Agent,
  team: TeamState,
  prompt: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; relayed: string }> {
  const subagents = env.ctx.subagents;
  if (subagents?.startContinuable === undefined || subagents?.followup === undefined) {
    throw new ETeamsError('子代理服务不可用，无法派发领队子代理');
  }
  const sig = signal ?? new AbortController().signal;
  const persona = captainPersonaOf(env, config);
  const leader = leaderRowOf(team);
  const previous = leader?.sessionId ?? '';
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
      await subagents.followup(parent, previous as unknown as SessionId, textTurn(prompt), {
        source: { ...CAPTAIN_SOURCE },
        signal: sig,
      });
      registerCaptainChild(previous, String(team.id));
      return { ok: true, relayed: dispatchAck(previous) };
    } catch {
      unregisterCaptainChild(previous);
    }
  }
  // 首次派发：startContinuable 建立持久子代理（inbox 接受初始 prompt 即
  // 返回，不等待轮次完成——汇报经 report 通道随后送达）。
  const start = await subagents.startContinuable({
    provider: config.memberProvider,
    // 子代理以领队的名字命名（用户迭代 2026-09-07）；领队行缺席退内置领队名。
    label: buildCaptainLabel(leader?.name ?? LEADER_NAME),
    request: {
      prompt: textTurn(prompt),
      parent,
      persona,
      toolFilter: { deny: [...CAPTAIN_CHILD_DENIED_TOOLS] },
      ...(agentOptions !== undefined ? { agentOptions } : {}),
    },
    signal: sig,
  });
  const childId = String(start.childId);
  // 子代理的 eteams_* 调用按该团队领队解析（identity.ts / 跨工作区重指）。
  registerCaptainChild(childId, String(team.id));
  await persistCaptainChildId(env, String(team.id), childId);
  return { ok: true, relayed: dispatchAck(childId) };
}
