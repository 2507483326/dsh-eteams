/**
 * 能力缺口的运行时编排（v16；docs/subagentCapabilityGap.md）。
 *
 * 分工（与设计稿的一处偏离，记在此处以免误读）：设计稿写「Layer 1 分级＝宿主
 * 调一次模型」，但 `RuntimeContext` 里**没有 llm 面**——宿主调不了模型。而分级
 * 要判的恰是「换做法能不能过」，**只有刚撞到拒绝的那个子代理知道**（它试过哪些
 * 替代）。所以分级由上报方自己做（口径写在 `eteams_report_gap` 的 description
 * 里），宿主负责三件它才做得了的事：
 *
 * 1. **Layer 0 确定性预筛**（本模块，零模型调用）：高风险直接拒、命中常设路线
 *    直接按路线走、同操作已有 open 缺口去重——都依据宿主已知事实（argv、
 *    工作区根、路线表），不猜。
 * 2. **校验与落表**（state/gaps 的落表闸：high 拒收、why 必挂验收标准、argv 必填）。
 * 3. **结构性活动的原子落地**（「定路线 + 沉淀常设路线」同一事务，见
 *    {@link applyGapRoute}）。
 *
 * 本模块只做这三件，**不碰**消息与弹窗：唤醒领队是调用方照既有纪律走
 * `eteams_send_message`，问用户走 `eteams_ask_user`（人面前那一段复用问答表）。
 *
 * @module dsh-eteams/runtime/gaps
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { RuntimeContext, RuntimeEnv } from './base.js';
import { stateRootFor } from './base.js';
import type { TeamState } from '../model/types.js';
import {
  insertGapInTx,
  newGapId,
  operationClassOf,
  readGapSync,
  readOpenGapsSync,
  resolveRoutingMemoSync,
  setGapRouteInTx,
  upsertRoutingMemoInTx,
  type CapabilityGapRecord,
  type GapDecidedBy,
  type GapOperation,
  type GapRisk,
  type GapRoute,
} from '../state/gaps.js';
import { withTeamTx } from '../state/store.js';

/**
 * 本模块只用到 env 的这两项（状态根推导 + 工作区根归一）。窄化之后不依赖
 * ctx，单测可直接构造，不必铺 RuntimeContext 全形状。
 */
export type GapRuntimeEnv = Pick<RuntimeEnv, 'config' | 'workspace'>;

/** 上报方的分级判定（口径见 `eteams_report_gap` 的 description）。 */
export type GapVerdict = 'self-resolvable' | 'report-gap' | 'refuse';

/**
 * Layer 0 预筛结论（纯函数产出，调用方据此决定后续动作）：
 * - `self-resolvable` —— 换法子能过：**不落表**，调用方自己换法继续。
 * - `refused` —— 高风险或上报方自判 refuse：**不落表、不升级**，直接失败并报告。
 * - `known-route` —— 命中常设路线：按路线转交，**不再升级**（这是路线表存在的理由）。
 * - `deduped` —— 同操作已有 open 缺口：复用那一行，不重复上报。
 * - `report` —— 需要落表。
 */
export type GapPrefilter =
  | { kind: 'self-resolvable' }
  | { kind: 'refused'; reason: string }
  | { kind: 'known-route'; route: GapRoute; memoId: number; gapId?: string }
  | { kind: 'deduped'; gapId: string }
  | { kind: 'report' };

/** 一次缺口上报的入参（工具层校验后传入）。 */
export interface GapReportInput {
  teamId: number;
  taskId?: number;
  attemptId?: number;
  stationIndex?: number;
  askingSessionId: string;
  askingName: string;
  risk: GapRisk;
  verdict: GapVerdict;
  operation: GapOperation;
  why: string;
  tried?: string[];
  suggestedRoute?: GapRoute;
}

/**
 * 一次上报的结局：预筛结论原样透出（不含 `report` 那一格），落表时换成
 * `reported` + 新 gapId。用 `Exclude` 而不是复制一份联合——判别符与分支只有
 * 一处定义，两边不会漂移。
 */
export type GapReportOutcome =
  Exclude<GapPrefilter, { kind: 'report' }> | { kind: 'reported'; gapId: string };

/**
 * Layer 0 确定性预筛（零模型调用）。判据全部来自宿主已知事实：
 * 操作类取自**宿主可核对**的 `operation.argv` 与 `env.workspace`（模型自述的
 * `summary`/`writes` 一概不参与判定）。
 *
 * 优先级（先命中先返回）：高风险 → 上报方自判 refuse → 命中常设路线 →
 * 同操作已有 open 缺口 → 落表。
 */
export function prefilterGap(env: GapRuntimeEnv, input: GapReportInput): GapPrefilter {
  // 高风险与上报方自判 refuse：不落表、不升级（永远不请人类授权外泄类操作）。
  if (input.risk === 'high') {
    return { kind: 'refused', reason: 'high 风险：一律拒绝，不请人类授权外泄类操作' };
  }
  if (input.verdict === 'refuse') {
    return { kind: 'refused', reason: '上报方判定 refuse：直接失败并报告风险' };
  }
  if (input.verdict === 'self-resolvable') {
    return { kind: 'self-resolvable' };
  }

  const stateRoot = stateRootFor(env.config, env.workspace);
  const operationClass = operationClassOf(input.operation.argv, env.workspace);

  // 已定路线：同样的事批过就不再烦人（注意——这是「按路线转交」，不是「放行」）。
  const memo = resolveRoutingMemoSync(stateRoot, input.teamId, input.taskId, operationClass);
  if (memo !== undefined) {
    return { kind: 'known-route', route: memo.route, memoId: memo.memoId };
  }

  // 同操作的 open 缺口去重（同一站点连续被同一堵墙挡住时只留一条）。
  const duplicate = readOpenGapsSync(stateRoot, input.teamId).find(
    (gap) =>
      (gap.taskId ?? undefined) === input.taskId &&
      operationClassOf(gap.operation.argv, env.workspace) === operationClass,
  );
  if (duplicate !== undefined) return { kind: 'deduped', gapId: duplicate.gapId };

  return { kind: 'report' };
}

/**
 * 预筛 + 落表，一次走完。`self-resolvable` / `refused` / `known-route` / `deduped`
 * 都不产生新行；只有 `report` 落表。
 *
 * 落表前的检查在这里再做一遍（防调用方绕过 {@link prefilterGap} 直接调本函数）：
 * state 层的落表闸仍是最后一道。
 */
export function reportGap(env: GapRuntimeEnv, input: GapReportInput): GapReportOutcome {
  const pre = prefilterGap(env, input);
  if (pre.kind !== 'report') return pre;

  const stateRoot = stateRootFor(env.config, env.workspace);
  const now = Date.now();
  const record: CapabilityGapRecord = {
    gapId: newGapId(),
    teamId: input.teamId,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    askingSessionId: input.askingSessionId,
    askingName: input.askingName,
    ...(input.stationIndex !== undefined ? { stationIndex: input.stationIndex } : {}),
    risk: input.risk,
    operation: input.operation,
    why: input.why,
    ...(input.tried !== undefined ? { tried: input.tried } : {}),
    ...(input.suggestedRoute !== undefined ? { suggestedRoute: input.suggestedRoute } : {}),
    status: 'open',
    createdAt: now,
    updatedAt: now,
  };
  withTeamTx(stateRoot, input.teamId, (tx) => {
    insertGapInTx(tx, record);
  });
  return { kind: 'reported', gapId: record.gapId };
}

/** 一次结构性路线决定（领队自定或用户拍板）。 */
export interface GapRouteInput {
  gapId: string;
  route: GapRoute;
  decidedBy: GapDecidedBy;
  note?: string;
  /**
   * 是否沉淀为常设路线：决定「这类活儿以后都这么办」时开。开了下次同类操作
   * 直接命中 {@link prefilterGap} 的 `known-route`，不再升级。
   *
   * **它沉淀的是路由，不是权限**——执行侧读到它的动作是「按路线转交」。
   */
  memoize?: boolean;
}

/**
 * 落地一次结构性决定：**同一事务内**写缺口路由栏（+ 可选沉淀常设路线）。
 *
 * 原子性是硬需求：路线写在缺口上、常设路线写在另一张表，两者若分事务落，崩溃
 * 会留下「缺口说已定路线 / 路线表查不到」的不一致。`*InTx` 形态正是为此。
 *
 * 竞态：领队自定路线与用户弹窗作答可能同时到达，`setGapRouteInTx` 内建
 * `WHERE status = 'open'` 的先决者胜。**输家不写常设路线**——否则会留下一条与
 * 缺口实际处置不符的备忘。
 *
 * @returns `won` = 是否赢下这一格（false = 已被别人处置，什么都没写）；
 *   `memoId` = 沉淀出的备忘号（未开 `memoize`、输了、或缺口无可归一的 argv 时
 *   为 undefined）。**两个字段分开**：只看 memoId 无法区分「赢了但没沉淀」与
 *   「输了」，调用方需要据此给不同的下一步指引。
 */
export function applyGapRoute(
  env: GapRuntimeEnv,
  input: GapRouteInput,
): { won: boolean; memoId?: number } {
  const stateRoot = stateRootFor(env.config, env.workspace);
  const gap = readGapSync(stateRoot, input.gapId);
  if (gap === undefined) {
    throw new Error(`能力缺口 ${input.gapId} 不存在——请核对 gapId 后重试`);
  }
  if (gap.status !== 'open') return { won: false }; // 已被别人处置：静默落空

  const argv = gap.operation.argv;
  let memoId: number | undefined;
  let won = false;
  withTeamTx(stateRoot, gap.teamId, (tx) => {
    won = setGapRouteInTx(tx, input.gapId, {
      route: input.route,
      ...(input.note !== undefined ? { note: input.note } : {}),
      decidedBy: input.decidedBy,
      decidedAt: tx.now,
    });
    if (!won || input.memoize !== true || argv.length === 0) return;
    memoId = upsertRoutingMemoInTx(tx, {
      memoId: 0,
      teamId: gap.teamId,
      ...(gap.taskId !== undefined ? { taskId: gap.taskId } : {}),
      operationClass: operationClassOf(argv, env.workspace),
      route: input.route,
      ...(input.note !== undefined ? { note: input.note } : {}),
      decidedBy: input.decidedBy,
      gapId: input.gapId,
      createdAt: tx.now,
      updatedAt: tx.now,
    });
  });
  return { won, ...(memoId !== undefined ? { memoId } : {}) };
}

// --------------------------------------------------------------------------
// main-executes 的交付动作（P2）：把操作交给主会话，由它主动执行
// --------------------------------------------------------------------------

/**
 * 缺口锚定的**主会话**会话 id。缺口挂的是小任务，而会话锚记在**大任务行**上
 * （与 `eteams_ask_user` 同口径）——所以先取 `parentId ?? 自身` 那一行的
 * `mainSessionId` 快照，再退回本任务自己的（旧数据/独立任务）。两级都空则
 * undefined，调用方降级为「让领队手动交付」。
 */
export function mainSessionIdOfGap(
  team: TeamState,
  taskId: number | undefined,
): string | undefined {
  if (taskId === undefined) return undefined;
  const task = team.tasks.find((t) => t.id === taskId);
  if (task === undefined) return undefined;
  const anchor = task.parentId === null ? task : team.tasks.find((t) => t.id === task.parentId);
  const candidates = [anchor?.mainSessionId, task.mainSessionId];
  return candidates.find((id): id is string => id !== undefined && id !== '');
}

/**
 * 交付正文（纯函数，可单测）。三件必须写清的事：
 * - **来源**（任务 / 上报人 / gapId）——主会话要知道这是**别人**在要什么，不是它自己的意图；
 * - **精确 `argv`/`cwd`** 逐项列出——执行侧按它构造命令，不按散文；
 * - **不要转回成员**——成员在同样的限制里，转回去只会再被拦一次。
 *
 * `summary` 作为「上报方的说明」附在旁边（给人读），**不当作命令**。
 */
export function handoffTextOf(gap: CapabilityGapRecord, team: TeamState): string {
  const task = gap.taskId !== undefined ? team.tasks.find((t) => t.id === gap.taskId) : undefined;
  const where =
    task !== undefined ? `任务 #${task.id} ${task.subject}` : `任务 #${gap.taskId ?? '?'}`;
  return [
    `【能力缺口 · 请主会话代执行】${where} · ${gap.askingName} 上报（gapId=${gap.gapId}）`,
    '',
    '被拦住的操作（cwd / argv 由上报方填写，宿主只校验形状——执行前请自行判断）：',
    `  cwd:  ${gap.operation.cwd}`,
    `  argv: ${gap.operation.argv.join(' ')}`,
    ...(gap.operation.summary !== '' ? [`  （上报方的说明：${gap.operation.summary}）`] : []),
    '',
    `为什么需要：${gap.why}`,
    ...(gap.tried !== undefined && gap.tried.length > 0
      ? [`已试过的替代（确实不行）：${gap.tried.join('；')}`]
      : []),
    '',
    '领队已定路线 **main-executes**：这一条的含义是「一次性操作，交给有权限的一侧执行」。',
    '主会话就是能拿到授权的那一侧——**执行时若被要求授权，按原生审批流走即可**（用户会被问到这次真实的工具调用）。',
    '**不要把它转回上报的成员**：成员在同样的限制里，转回去只会再被拦一次。',
  ].join('\n');
}

/** 一次交付的结局。 */
export interface GapHandoffResult {
  delivered: boolean;
  targetSessionId?: string;
  /** 未投递的原因（无锚会话 / 调用方即主会话 / 宿主缺能力 / 投递失败）。 */
  reason?: string;
}

/**
 * 把 `main-executes` 的操作交给主会话（P2）。
 *
 * 方向是**子 → 父**（主会话是领队子代理的父），走 `subagents.sendMessage` 的
 * 相邻投递（child → direct parent，宿主按子会话 header 的 parentSession 校验）。
 *
 * **全部失败路径都只降级、不抛**：路线已经落库了，交付失败不该让处置动作回滚
 * ——调用方按返回值把「请手动交付」写进给模型的指引。
 */
export async function handoffToMain(
  subagents: RuntimeContext['subagents'],
  sender: Agent,
  team: TeamState,
  gap: CapabilityGapRecord,
  signal?: AbortSignal,
): Promise<GapHandoffResult> {
  const target = mainSessionIdOfGap(team, gap.taskId);
  if (target === undefined) {
    return { delivered: false, reason: '任务缺 mainSessionId 快照，找不到锚定的主会话' };
  }
  if (String(sender.id ?? '') === target) {
    return {
      delivered: false,
      targetSessionId: target,
      reason: '调用方就是主会话本身（不必自投）',
    };
  }
  const face = subagents as {
    sendMessage?: (
      sender: Agent,
      targetId: SessionId,
      content: ContentBlock[],
      options: { signal: AbortSignal },
    ) => Promise<unknown>;
  };
  if (typeof face.sendMessage !== 'function') {
    return {
      delivered: false,
      targetSessionId: target,
      reason: '宿主未提供 sendMessage（相邻投递能力缺失）',
    };
  }
  try {
    await face.sendMessage(
      sender,
      target as SessionId,
      [{ type: 'text', text: handoffTextOf(gap, team) }],
      { signal: signal ?? new AbortController().signal },
    );
    return { delivered: true, targetSessionId: target };
  } catch (error) {
    return {
      delivered: false,
      targetSessionId: target,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
