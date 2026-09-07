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
import { insertTaskMemberRow, readTeamSync, withTeamTx } from '../state/store.js';
import { getDb } from '../state/db.js';
import { locks, teamLockKey } from '../state/lock.js';
import { leaderRouteOf } from './notifier.js';
import { LEADER_NAME } from './roster.js';
import { composeCaptainPersona } from '../prompts/personas/captain.js';
import { captainChildPersona } from '../prompts/spawn/captainChild.js';
import { dispatchAck } from '../prompts/steering/dispatch.js';
import type { TaskMemberRecord, TeamState } from '../model/types.js';

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
 * Live dispatch registry: child session id → { teamId, workspace root,
 * taskId }, written at spawn and on every followup re-registration (persisted
 * child id survives host restarts, so the map must be re-populated). Dropped
 * only when the same team rebuilds its child (stale lineage) — the child is
 * persistent, not turn-scoped. root/taskId 供领队手册插槽按子会话直查本任务
 * 的领队副本行（免注册表扫描）。
 */
const captainChildren = new Map<string, { teamId: string; root: string; taskId: string }>();

/** Register a freshly spawned captain child (identity.ts 领队解析依据). */
export function registerCaptainChild(
  childId: string,
  teamId: string,
  root = '',
  taskId = '',
): void {
  if (childId === '' || teamId === '') return;
  captainChildren.set(childId, { teamId, root, taskId });
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

/** The big task a captain child's session anchors (手册插槽按任务读副本行). */
export function captainChildTaskOf(childId: string): string | undefined {
  const taskId = captainChildren.get(childId)?.taskId;
  return taskId === '' ? undefined : taskId;
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
 * 的不管」+「领队子会话随大任务生灭，主持行取消」）：
 * - 缓存 = **领队副本行（task_members，is_leader=1 且 main_task_id=本大任务）
 *   的 persona_md 列**：建大任务铺副本时把当时班底的手册烘进该列，之后无人
 *   改写（镜像同步只刷 team_members 班底行，不碰 task_members）——每个大
 *   任务各自定格「开工那天」的手册。
 * - 读取必须走**原始列**：readTeamSync 对副本行的 persona 一律 LEFT JOIN
 *   roles 实时取（TeamState.personaMd 是角色库现值，不是缓存）。
 * - persona 段文本只含插槽引用 `{{eteams_leader_handbook}}`（index.ts 装机
 *   注册的同名 prompt 变量，按装配作用域现读本任务的缓存列）——宿主对替换
 *   值**不做二次扫描**，md 里的真实 `{{占位}}` 原样保留，转义不再需要。
 */
const LEADER_HANDBOOK_SLOT = '{{eteams_leader_handbook}}';

/** 读领队副本行的缓存手册原始列（本大任务，v8 按 is_leader 定位，不走 hydration join）。空/缺行返回 ''。 */
function readLeaderReplicaHandbook(root: string, teamId: string, taskId: string): string {
  try {
    const row = getDb(root)
      .prepare(
        'SELECT persona_md FROM task_members ' +
          'WHERE team_id = ? AND is_leader = 1 AND main_task_id = ? LIMIT 1',
      )
      .get(teamId, taskId) as { persona_md: string | null } | undefined;
    return row?.persona_md ?? '';
  } catch {
    return '';
  }
}

/**
 * 插槽 provider 入口（index.ts 注册 `eteams_leader_handbook` 变量时调用）：
 * 领队子代理 → 本任务领队副本行的缓存 md；缓存为空（老任务补铺前的窗口）/
 * 未登记（非领队子代理或装配竞态窗）→ 内置手册兜底——绝不让装配失败。
 */
export function leaderHandbookForChild(config: ETeamsResolvedConfig, scopeId: string): string {
  const teamId = captainChildTeamOf(scopeId);
  const root = captainChildRootOf(scopeId);
  const taskId = captainChildTaskOf(scopeId);
  if (teamId === undefined || root === undefined || taskId === undefined) {
    return composeCaptainPersona(stateRootFor(config, process.cwd())).personaMd ?? '';
  }
  const cached = readLeaderReplicaHandbook(root, teamId, taskId);
  if (cached !== '') return cached;
  return composeCaptainPersona(stateRootFor(config, process.cwd())).personaMd ?? '';
}

function captainPersonaOf(
  env: RuntimeEnv,
  config: ETeamsResolvedConfig,
  team: TeamState,
  taskId: number,
): string {
  const cached = readLeaderReplicaHandbook(stateRootOf(env), String(team.id), String(taskId));
  env.ctx.logger.info(
    `eteams: 领队子代理 persona 来源=${cached !== '' ? 'team_member_cache' : 'builtin'}`,
  );
  return captainChildPersona(LEADER_HANDBOOK_SLOT);
}

/** 读旧版领队主持行的缓存手册（main_task_id 为空；升级迁移的搬运源）。空/缺行返回 ''。 */
function readLeaderAnchorHandbook(root: string, teamId: string): string {
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
 * 领队副本行的子会话锚落库（按副本行主键直改，不走整存整取）。团队消失
 * （删除竞态）时静默放弃——子代理已建立但惰性无害，下一次 dispatch 按空缺
 * 处理。
 */
async function persistReplicaSession(
  env: RuntimeEnv,
  teamId: number,
  replicaId: number,
  childId: string,
): Promise<void> {
  await locks.withLock(teamLockKey(stateRootOf(env), String(teamId)), async () => {
    withTeamTx(stateRootOf(env), teamId, (tx) => {
      tx.db
        .prepare('UPDATE task_members SET session_id = ?, update_time = ? WHERE task_member_id = ?')
        .run(childId, Date.now(), replicaId);
    });
  });
}

/**
 * 派发核心（对话工具与面板手动建任务共用，docs/panelTaskCommission）：
 * 锚 = **本大任务的领队副本行**（is_leader=1 且 main_task_id=taskId——用户
 * 迭代 2026-09-08 定案「领队子会话随大任务生灭，主持行取消」）：副本行缺
 * 失（老任务）先补铺（手册 = 主持行缓存 → 班底 → 内置 依次兜底）并直接落
 * 预留子会话；session 已有 → followup 续聊（含宿主重启冷恢复），失败清锚
 * 重建；session 空（createTask 铺的新副本）→ startContinuable 建立子代理
 * 后回写 session。prompt 由调用方组装（对话 = captainDispatchPrompt；面板
 * 完善 = captainCommissionPrompt，两者都自带现状自取指令）。领队手册经
 * persona 系统段的 {{eteams_leader_handbook}} 插槽进入子代理上下文。
 * @param parent 派发父代理（lineage 直接父）：对话路径 = exec.agent；面板
 *   路径 = captainFor 解析的主会话代理。两者只是来源不同，语义同一层。
 * @param taskId 锚定的大任务号（对话路径由 band 要求主会话先建任务再转交
 *   时透传；面板完善 = 被完善的主任务号）。
 * @param prompt 组装好的完整 prompt 文本（现状自取指令 + 用户消息）。
 */
export async function dispatchCaptainCore(
  env: RuntimeEnv,
  config: ETeamsResolvedConfig,
  parent: Agent,
  team: TeamState,
  taskId: number,
  prompt: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; relayed: string }> {
  const subagents = env.ctx.subagents;
  if (subagents?.startContinuable === undefined || subagents?.followup === undefined) {
    throw new ETeamsError('子代理服务不可用，无法派发领队子代理');
  }
  const sig = signal ?? new AbortController().signal;
  const root = stateRootOf(env);
  const teamId = String(team.id);
  const taskKey = String(taskId);
  // 领队子代理运行路线（用户迭代 2026-09-04 恢复领队模型选择；v9 路线存
  // 班底领队行 leaderRouteOf——provider/model/effort 整组）：空 model = 会话
  // 默认——宿主 agent-default-model 即时快照 pin；服务缺失退回不带
  // agentOptions 的旧行为。
  const leaderRoute = leaderRouteOf(team);
  const agentOptions =
    leaderRoute.model !== ''
      ? {
          // v9 provider 回归：覆盖路线带目录 provider（同 id 模型跨提供方消
          // 歧）；旧数据未记录时省略——运行时按会话默认解析（此前填
          // config.memberProvider 是 'spawn'/'fork' 传输名，不是 LLM provider）。
          ...(leaderRoute.provider !== undefined && leaderRoute.provider !== ''
            ? { provider: leaderRoute.provider }
            : {}),
          model: leaderRoute.model,
          ...(leaderRoute.reasoningEffort ? { reasoningEffort: leaderRoute.reasoningEffort } : {}),
        }
      : sessionDefaultRouteOf(env.ctx);

  // 锚解析：本大任务的领队副本行。查重**在锁内基于 fresh 读**——调用方手
  // 里的 team 可能是建任务前的旧快照（面板 commission 路径），照旧快照找
  // 不到就会双铺。缺失（老任务）→ 补铺一行（手册 = 主持行缓存 → 班底 →
  // 内置 依次兜底；session 直接落预留 id）。
  const childId = SessionId(randomUUID());
  const ensureReplica = async (): Promise<TaskMemberRecord> => {
    let row: TaskMemberRecord | undefined;
    await locks.withLock(teamLockKey(root, teamId), async () => {
      const fresh = readTeamSync(root, teamId);
      row = fresh?.taskMembers.find((r) => r.isLeader === true && r.mainTaskId === taskId);
      if (row !== undefined) return;
      const legacy = readLeaderAnchorHandbook(root, teamId);
      const baked =
        legacy !== ''
          ? legacy
          : fresh?.members.find((m) => m.isLeader === true)?.persona.personaMd?.trim() ||
            composeCaptainPersona(stateRootFor(env.config, env.workspace)).personaMd ||
            '';
      const created: TaskMemberRecord = {
        id: 0,
        teamId: team.id,
        mainTaskId: taskId,
        nowTaskId: null,
        name: LEADER_NAME,
        employeeId: fresh?.members.find((m) => m.isLeader === true)?.employeeId ?? null,
        sessionId: String(childId),
        status: 'ready',
        isLeader: true,
        ...(baked !== '' ? { personaMd: baked } : {}),
        createdAt: Date.now(),
      };
      withTeamTx(root, team.id, (tx) => {
        insertTaskMemberRow(tx, created);
      });
      row = created;
      env.ctx.logger.info(
        `eteams: 领队副本行缺失已补铺（team=${teamId} task=${taskId} child=${String(childId)}）`,
      );
    });
    return row as TaskMemberRecord;
  };
  const replica = await ensureReplica();
  const persona = captainPersonaOf(env, config, team, taskId);

  // session 已有 → followup 续聊（含宿主重启后的冷恢复）；注册表**先**登记
  // 再续聊——续聊触发的首轮装配就在子代理上下文里读手册插槽，登记滞后会
  // 漏一次（装配竞态）；失败清锚重建（老锚清掉，子会话换新）。
  const previous = replica.sessionId;
  if (previous !== '') {
    registerCaptainChild(previous, teamId, root, taskKey);
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
  // 首次派发（或老锚失效重建）：startContinuable 建立持久子代理（inbox 接
  // 受初始 prompt 即返回，不等待轮次完成——汇报经 report 通道随后送达）。
  // childId 由调用方预留并**先登记后 spawn**——子代理首次装配早于
  // startContinuable 兑现，插槽必须有登记可查。
  const spawnChildId = previous === '' ? childId : SessionId(randomUUID());
  registerCaptainChild(String(spawnChildId), teamId, root, taskKey);
  let start: { childId: string; messageId: unknown };
  try {
    start = await subagents.startContinuable({
      provider: config.memberProvider,
      // 子代理以领队的名字命名（用户迭代 2026-09-07）；领队行缺席退内置领队名。
      label: buildCaptainLabel(LEADER_NAME),
      childId: spawnChildId,
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
    unregisterCaptainChild(String(spawnChildId));
    throw error;
  }
  // 子代理的 eteams_* 调用按该团队领队解析（identity.ts / 跨工作区重指）。
  registerCaptainChild(String(start.childId), teamId, root, taskKey);
  if (String(start.childId) !== previous) {
    await persistReplicaSession(env, team.id, replica.id, String(start.childId));
  }
  return { ok: true, relayed: dispatchAck(String(start.childId)) };
}
