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
import { SessionId } from '@deepseek-ai/dsh-session';
import { randomUUID } from 'node:crypto';
import type { ETeamsResolvedConfig } from '../config.js';
import {
  ETeamsError,
  sessionDefaultRouteOf,
  stateRootFor,
  stateRootOf,
  type RuntimeEnv,
} from './base.js';
import { readTeamSync, withTeamTx } from '../state/store.js';
import { getDb } from '../state/db.js';
import { locks, teamLockKey } from '../state/lock.js';
import { leaderRowOf } from './notifier.js';
import { LEADER_NAME } from './roster.js';
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
 * Live dispatch registry: child session id → { teamId, workspace root },
 * written at spawn and on every followup re-registration (persisted child id
 * survives host restarts, so the map must be re-populated). Dropped only when
 * the same team rebuilds its child (stale lineage) — the child is persistent,
 * not turn-scoped. root 供领队手册插槽按子会话直查团队库（免注册表扫描）。
 */
const captainChildren = new Map<string, { teamId: string; root: string }>();

/** Register a freshly spawned captain child (identity.ts 领队解析依据). */
export function registerCaptainChild(childId: string, teamId: string, root = ''): void {
  if (childId === '' || teamId === '') return;
  captainChildren.set(childId, { teamId, root });
}

/** The team a captain child serves (undefined for non-captain sessions). */
export function captainChildTeamOf(childId: string): string | undefined {
  return captainChildren.get(childId)?.teamId;
}

/** The workspace state root a captain child's team lives in (手册插槽用). */
export function captainChildRootOf(childId: string): string | undefined {
  const root = captainChildren.get(childId)?.root;
  return root === '' ? undefined : root;
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
 * 领队手册缓存 + 插槽（2026-09-08 定案「读团队成员表中的缓存MD，角色新修改
 * 的不管」）：
 * - 缓存就是**领队主持行（task_members，main_task_id 为空）的 persona_md
 *   列**：createTeam 建队时把当时角色库的手册烘进该列，之后无人改写（镜像
 *   同步 syncTeamMemberRoleMirrorInTx 只刷 team_members 班底行，不碰
 *   task_members）——天然就是「创建时即最终版」的冻结位。
 * - 读取必须走**原始列**：readTeamSync 对班底/主持行的 persona 一律 LEFT
 *   JOIN roles 实时取（TeamState.personaMd 是角色库现值，不是缓存）。
 * - persona 段文本只含插槽引用 `{{eteams_leader_handbook}}`（index.ts 装机
 *   注册的同名 prompt 变量，按装配作用域现读缓存列）——宿主对替换值**不做
 *   二次扫描**，md 里的真实 `{{占位}}` 原样保留，转义不再需要。
 */
const LEADER_HANDBOOK_SLOT = '{{eteams_leader_handbook}}';

/** 读领队主持行的缓存手册原始列（v8 按 is_leader 定位，不走 hydration join）。空/缺行返回 ''。 */
function readLeaderRowHandbook(root: string, teamId: string): string {
  try {
    const row = getDb(root)
      .prepare(
        'SELECT persona_md FROM task_members ' +
          'WHERE team_id = ? AND is_leader = 1 AND main_task_id IS NULL LIMIT 1',
      )
      .get(teamId) as { persona_md: string | null } | undefined;
    return row?.persona_md ?? '';
  } catch {
    return '';
  }
}

/**
 * 插槽 provider 入口（index.ts 注册 `eteams_leader_handbook` 变量时调用）：
 * 领队子代理 → 领队行缓存 md；缓存为空（极老团队）/未登记（非领队子代理
 * 或装配竞态窗）→ 内置手册兜底——绝不让装配失败。
 */
export function leaderHandbookForChild(config: ETeamsResolvedConfig, scopeId: string): string {
  const teamId = captainChildTeamOf(scopeId);
  const root = captainChildRootOf(scopeId);
  if (teamId === undefined || root === undefined) {
    return composeCaptainPersona(stateRootFor(config, process.cwd())).personaMd ?? '';
  }
  const cached = readLeaderRowHandbook(root, teamId);
  if (cached !== '') return cached;
  return composeCaptainPersona(stateRootFor(config, process.cwd())).personaMd ?? '';
}

function captainPersonaOf(env: RuntimeEnv, config: ETeamsResolvedConfig, team: TeamState): string {
  const cached = readLeaderRowHandbook(stateRootOf(env), String(team.id));
  env.ctx.logger.info(
    `eteams: 领队子代理 persona 来源=${cached !== '' ? 'team_member_cache' : 'builtin'}`,
  );
  return captainChildPersona(LEADER_HANDBOOK_SLOT);
}

/**
 * 落盘持续领队子代理的 durable id：写领队行（task_members 领队行，is_leader
 * 标识=1 且 main_task_id 为空）的 session_id——v6 该列记本行自己的子代理
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
    if (leader !== undefined && leader.sessionId === childId) return;
    withTeamTx(root, team.id, (tx) => {
      const updated = tx.db
        .prepare(
          'UPDATE task_members SET session_id = ?, update_time = ? ' +
            'WHERE team_id = ? AND is_leader = 1 AND main_task_id IS NULL',
        )
        .run(childId, Date.now(), team.id);
      if (Number(updated.changes) > 0) return;
      // 主持行缺失自愈（用户迭代 2026-09-08「选择模型没保存到表」同根因）：
      // 按班底领队行补建主持行并直接落子代理会话锚——班底也没有领队行时
      // INSERT..SELECT 零行插入，维持静默放弃口径。
      const inserted = tx.db
        .prepare(
          "INSERT INTO task_members (team_id, main_task_id, name, employee_id, status, " +
            'session_id, is_leader, created_time, update_time) ' +
            "SELECT team_id, NULL, role_name, employee_id, 'ready', ?, 1, ?, ? " +
            'FROM team_members WHERE team_id = ? AND is_leader = 1 LIMIT 1',
        )
        .run(childId, Date.now(), Date.now(), team.id);
      if (Number(inserted.changes) > 0) {
        env.ctx.logger.warn(
          `eteams: 领队主持行缺失——已自愈补建并落子代理会话锚（team=${teamId} child=${childId}）`,
        );
      }
    });
  });
}

/**
 * 派发核心（对话工具与面板手动建任务共用，docs/panelTaskCommission）：
 * 解析领队子代理锚（主持行 sessionId）→ followup 续聊、失败重建
 * （startContinuable，parent 必须是真实直接父——lineage 授权）→ 登记注册表
 * + 落盘 durable id。prompt 由调用方组装（对话 = captainDispatchPrompt；
 * 面板完善 = captainCommissionPrompt，两者都自带现状自取指令）。领队手册
 * 经 persona 系统段的 {{eteams_leader_handbook}} 插槽进入子代理上下文，
 * 槽值 = 领队行缓存 md（readLeaderRowHandbook 现读原始列）。
 * @param parent 派发父代理（lineage 直接父）：对话路径 = exec.agent；面板
 *   路径 = captainFor 解析的主会话代理。两者只是来源不同，语义同一层。
 * @param prompt 组装好的完整 prompt 文本（现状自取指令 + 用户消息）。
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
  const persona = captainPersonaOf(env, config, team);
  const root = stateRootOf(env);
  const leader = leaderRowOf(team);
  const previous = leader?.sessionId ?? '';
  // 领队子代理运行路线（用户迭代 2026-09-04 恢复领队模型选择）：领队行
  // model 有值即 override；v9 加 provider（同 id 模型跨提供方消歧）；空 =
  // 会话默认——宿主 agent-default-model 即时快照 pin；服务缺失退回不带
  // agentOptions 的旧行为。
  const leaderModel = leader?.model ?? '';
  const agentOptions =
    leaderModel !== ''
      ? {
          // v9 provider 回归：覆盖路线带目录 provider（同 id 模型跨提供方消
          // 歧）；旧数据未记录时省略——运行时按会话默认解析（此前填
          // config.memberProvider 是 'spawn'/'fork' 传输名，不是 LLM provider）。
          ...(leader?.provider !== undefined && leader.provider !== ''
            ? { provider: leader.provider }
            : {}),
          model: leaderModel,
          ...(leader?.reasoningEffort ? { reasoningEffort: leader.reasoningEffort } : {}),
        }
      : sessionDefaultRouteOf(env.ctx);
  // 先试续聊（含宿主重启后的冷恢复）；失败（会话记录被回收/lineage 不
  // 符）再重建。注册表**先**登记再续聊——续聊触发的首轮装配就在子代理上
  // 下文里读手册插槽，登记滞后会漏一次（装配竞态）；失败再撤条目。
  if (previous !== '') {
    registerCaptainChild(previous, String(team.id), root);
    try {
      await subagents.followup(parent, previous as unknown as SessionId, textTurn(prompt), {
        source: { ...CAPTAIN_SOURCE },
        signal: sig,
      });
      return { ok: true, relayed: dispatchAck(previous) };
    } catch {
      unregisterCaptainChild(previous);
    }
  }
  // 首次派发：startContinuable 建立持久子代理（inbox 接受初始 prompt 即
  // 返回，不等待轮次完成——汇报经 report 通道随后送达）。childId 由调用方
  // 预留并**先登记后 spawn**——子代理首次装配早于 startContinuable 兑现，
  // 插槽必须有登记可查；spawn 兑现后按返回 id 再登记一次（后端改发 id 的
  // 兜底），失败撤预留条目。
  const childId = SessionId(randomUUID());
  registerCaptainChild(String(childId), String(team.id), root);
  let start: { childId: string; messageId: unknown };
  try {
    start = await subagents.startContinuable({
      provider: config.memberProvider,
      // 子代理以领队的名字命名（用户迭代 2026-09-07）；领队行缺席退内置领队名。
      label: buildCaptainLabel(leader?.name ?? LEADER_NAME),
      childId,
      request: {
        prompt: textTurn(prompt),
        parent,
        persona,
        toolFilter: { deny: [...CAPTAIN_CHILD_DENIED_TOOLS] },
        ...(agentOptions !== undefined ? { agentOptions } : {}),
      },
      signal: sig,
    });
  } catch (error) {
    unregisterCaptainChild(String(childId));
    throw error;
  }
  // 子代理的 eteams_* 调用按该团队领队解析（identity.ts / 跨工作区重指）。
  registerCaptainChild(String(start.childId), String(team.id), root);
  await persistCaptainChildId(env, String(team.id), String(start.childId));
  return { ok: true, relayed: dispatchAck(String(start.childId)) };
}
