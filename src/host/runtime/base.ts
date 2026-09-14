/**
 * Runtime base (docs/04 architecture): the only seam toward cordis-injected
 * services. `state/` + `model/` stay pure; `runtime/` + `tools/` speak env.
 *
 * @module dsh-eteams/runtime/base
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session';
import type { ETeamsResolvedConfig } from '../config.js';
import type { Actor, TeamState } from '../model/types.js';
import { locks } from '../state/lock.js';
import { teamDir } from '../state/store.js';

/** Minimal logger face (cordis logger satisfies it; verify fakes its own). */
export interface RuntimeLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** The context seam the runtime needs (subset of the cordis context). */
export interface RuntimeContext {
  logger: RuntimeLogger;
  /** Continuation runtime: spawn/followup/interrupt (inject `subagents`). */
  subagents: {
    /** One-shot child: settles after its turn (continuable = startContinuable). */
    start(
      name: string,
      request: {
        label?: string;
        prompt: { type: 'text'; text: string }[];
        parent: Agent;
        signal: AbortSignal;
        persona?: string;
        toolFilter?: { deny: string[] };
      },
    ): Promise<{ id: string; dispose(): Promise<void>; result: Promise<unknown> }>;
    startContinuable(spec: {
      provider: string;
      label: string;
      /**
       * 调用方预留的子代理身份（docs/19.17.1）：受理即预落盘 builderChildId，
       * 子代理开跑时 eteams_build_wait 的守卫凭据已在盘上。缺省由运行时分配。
       */
      childId?: string;
      request: {
        prompt: { type: 'text'; text: string }[];
        parent: Agent;
        persona?: string;
        toolFilter?: { deny: string[] };
        agentOptions?: { provider?: string; model?: string; reasoningEffort?: string };
      };
      signal?: AbortSignal;
    }): Promise<{ childId: string; messageId: string }>;
    followup(
      parent: Agent,
      childId: SessionId,
      content: { type: 'text'; text: string }[],
      options: { source: { kind: 'plugin'; plugin: string }; signal?: AbortSignal },
    ): Promise<unknown>;
    /**
     * harness 0.1.2+ 的子代理唤醒入口（取代 followup，steer 语义：running
     * 目标在最近 step 边界入列 / idle 开新回合 / 不在场的直接子代理冷恢复）。
     * 可选能力：旧运行时缺此方法，deliverToChild 按能力探测退回 followup。
     */
    sendMessage?(
      sender: Agent,
      targetId: SessionId,
      content: ContentBlock[],
      options: { signal: AbortSignal },
    ): Promise<unknown>;
    interrupt(
      target: SessionId,
      authority: { kind: 'user'; parentSessionId: SessionId } | { kind: 'ancestor'; agent: Agent },
    ): void;
    /**
     * Runtime-version-gated recycling APIs (docs/20.2.2): present on newer
     * harness runtimes, absent in older type snapshots — feature-detect via
     * `?.` and degrade to interrupt-only when missing.
     */
    /** Release selected resident continuable direct children of one parent. */
    drainContinuableChildren?(parent: Agent, childIds: readonly SessionId[]): Promise<void>;
    /** Close admission below exact parents and release their descendant forests. */
    drainContinuableDescendants?(parents: readonly Agent[]): Promise<void>;
    /** Enumerate direct session-backed subagents (no Agent loading). */
    listChildren?(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentChildEntry[]>;
    /** Enumerate the complete descendant tree in stable pre-order. */
    listDescendants?(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentChildEntry[]>;
  };
  /** Live agent registry (inject `agents`): wake the captain. */
  agents: {
    get(sessionId: string): Agent | undefined;
    /**
     * 冷恢复（可选能力，运行时版本门控——旧运行时缺此 API，调用方
     * feature-detect）：按持久化会话 ID 加载会话回活代理（AgentRegistry.resume
     * 的结构子集，真实 ResumeAgentOptions 字段更宽）。返回 AgentHandle 的
     * `dispose` 能力只留给运行时回收——复活的主会话当派发父锚常驻，绝不调
     * dispose（create 语义里 dispose 会拆会话）。
     */
    resume?(options: {
      resumeSessionId: SessionId;
      signal?: AbortSignal;
      /**
       * 显式模型路线（续派冷恢复修复）：宿主把 AgentOptions.provider/model
       * 直接当作提示词变量 `{{model}}` 的取值（dsh-agent-loop
       * `context.agent?.options.model`），**不会**回落到适配器默认——省略即
       * 该变量无值，而部署级 `deployment:persona`（dsh-web-app 配的
       * `... powered by the {{model}} model ...` 模板）在渲染时严格插值，
       * 无值即整段装配抛「prompt variable has no value」、冷恢复出来的锚点
       * 一开回合就失败。见 {@link resumeOptionsOf}。
       */
      agentOptions?: { provider?: string; model?: string; reasoningEffort?: string };
      /**
       * 未发布 setup 钩子（续派冷恢复修复·第二半）：宿主在 agent 发布前 await
       * 它，回滚语义与创建同款。冷恢复出来的 agent 只有日记本（会话历史），
       * 没有 preset 装配（工具/提示词段/skill 都不在会话日志里），所以要在
       * 这一刻把 preset 重挂回去——见 {@link presetRemountSetup}。
       */
      setup?: (agentCtx: unknown) => void | Promise<void>;
    }): Promise<{ agent: Agent; dispose(): Promise<void> }>;
  };
  /** Live subagent listing — used to detect stranded mailboxes. */
  listAgents?: () => { id: string; label?: string; status: string }[];
}

/** Everything a runtime operation needs besides its arguments. */
export interface RuntimeEnv {
  ctx: RuntimeContext;
  config: ETeamsResolvedConfig;
  /** Workspace root (the captain/member session cwd). */
  workspace: string;
  /**
   * 调用方会话 id（envForAgent 注入；面板 envFor / 迁移等无会话构造不落）。
   * v6 建任务快照的兜底源：工具建任务按它登记主会话 ID（面板路由显式透传
   * body.sessionId；导入传旧值）。
   */
  sessionId?: string;
  signal?: AbortSignal;
}

/**
 * 状态根推导唯一入口（用户迭代 2026-09-04 全局单库）：`stateDir` 为绝对
 * 路径（盘符 / UNC / POSIX 根）时，所有工作区共用这一个根——一个
 * eteams.db、一份成员库、一份用量台账；相对路径保持 per-workspace 旧口径
 * （`<workspace>/<stateDir>`，docs/27 原「单库 per workspace」）。
 */
export function stateRootFor(
  config: Pick<ETeamsResolvedConfig, 'stateDir'>,
  workspacePath: string,
): string {
  const dir = config.stateDir;
  if (/^[a-zA-Z]:[\\/]/.test(dir) || dir.startsWith('\\\\') || dir.startsWith('/')) {
    return dir.replace(/[\\/]+$/, '');
  }
  return joinPath(workspacePath, dir);
}

/** Absolute state root for an env（绝对 stateDir 时即全局根，见 stateRootFor）。 */
export function stateRootOf(env: RuntimeEnv): string {
  return stateRootFor(env.config, env.workspace);
}

/**
 * 宿主会话默认模型路线（用户迭代 2026-09-04「会话默认」）：dsh-agent-default-model
 * 服务的 currentSelection()——settings「agent-default-model」的即时快照。
 * 领队/成员模型路线为空时派发固定到它（不再继承领队会话模型）。服务未挂
 * 返回 undefined，派发退回不带 agentOptions 的旧行为。解析一律吞错（cordis
 * 4 下未提供/未激活的服务在属性访问时直接抛「cannot get property … without
 * inject」而非 undefined；插件 inject 已声明该服务，正常宿主经 inject 镜像
 * 命中——此处兜底只保护旧运行时/单测 fake/启动序竞态，绝不影响派发）。
 */
export function sessionDefaultRouteOf(
  ctx: unknown,
): { provider: string; model: string; reasoningEffort?: string } | undefined {
  try {
    const withProp = ctx as {
      agentDefaultModel?: { currentSelection?: () => unknown };
    };
    const withGet = ctx as { get?: (key: string) => unknown };
    const service =
      withProp.agentDefaultModel ??
      (typeof withGet.get === 'function' ? (withGet.get('agentDefaultModel') as unknown) : undefined);
    const selection = (
      service as { currentSelection?: () => unknown } | undefined
    )?.currentSelection?.() as
      { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | undefined;
    if (
      selection === undefined ||
      typeof selection.provider !== 'string' ||
      selection.provider === '' ||
      typeof selection.model !== 'string' ||
      selection.model === ''
    ) {
      return undefined;
    }
    return {
      provider: selection.provider,
      model: selection.model,
      ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== ''
        ? { reasoningEffort: selection.reasoningEffort }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** preset 重挂服务的最小面（`@deepseek-ai/dsh-agent-presets`）。 */
interface PresetMounterFace {
  mount(agentCtx: unknown, id?: string): unknown;
}

/** 会话查询服务的最小面（`@deepseek-ai/dsh-session-query`）。 */
interface SessionQueryFace {
  observeSession(sessionId: string, options?: unknown): Promise<ObservationFace>;
}

/** 一次会话观测的租约（只需 projections 与 `Symbol.dispose`）。 */
interface ObservationFace {
  projections?: { values?: Record<string, unknown> };
}

/**
 * 按名读宿主服务，绝不让装配因探测服务而失败：cordis 4 下未声明 inject 的
 * 服务属性访问会直接抛，一律吞错按「服务未挂」处理（与
 * {@link sessionDefaultRouteOf} 同口径）。`ctx.get` 是正规入口，属性访问是
 * 给单测 fake / 旧运行时的兜底。
 */
function serviceOf(ctx: unknown, key: string): unknown {
  const withGet = ctx as { get?: (k: string) => unknown };
  if (typeof withGet.get === 'function') {
    try {
      const hit = withGet.get(key);
      if (hit !== undefined) return hit;
    } catch {
      // 未声明 inject / 未激活的服务：吞掉，落到属性访问兜底
    }
  }
  try {
    return (ctx as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** 尽力记一条 warn（日志失败绝不影响冷恢复主流程）。 */
function warnOf(ctx: unknown, message: string): void {
  try {
    (ctx as { logger?: { warn?: (m: string) => void } }).logger?.warn?.(message);
  } catch {
    // ignore
  }
}

/** 读会话记录里盖的 preset 印章（`agentPreset` 投影）。读不到一律 undefined。 */
async function recordedPresetId(ctx: unknown, sessionId: string): Promise<string | undefined> {
  const query = serviceOf(ctx, 'sessionQuery') as SessionQueryFace | undefined;
  if (query === undefined || typeof query.observeSession !== 'function') return undefined;
  let observation: ObservationFace | undefined;
  try {
    observation = await query.observeSession(sessionId);
    const value = observation?.projections?.values?.['agentPreset'];
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  } finally {
    // 观测是租约，读完即还（不还就漏一份活视图）。Symbol.dispose 用鸭子类型
    // 取，避免依赖 lib esnext.disposable。
    const disposeSymbol = (Symbol as unknown as { dispose?: symbol }).dispose;
    const dispose =
      observation !== undefined && disposeSymbol !== undefined
        ? (observation as unknown as Record<symbol, unknown>)[disposeSymbol]
        : undefined;
    if (typeof dispose === 'function') {
      try {
        (dispose as () => void).call(observation);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 冷恢复的 preset 重挂 setup（续派冷恢复修复·第二半）。
 *
 * 背景：preset 是**注册进 agent 作用域**的装配（工具/提示词段/skill），不写
 * 进会话日志；`agents.resume` 只把历史读回来，没人重跑注册。于是冷恢复出来
 * 的锚点会带着 `published without joining an agent preset … empty global
 * layer` 告警醒来——能说话、没有工具。宿主自己的会话控制器（
 * `dsh-api-session-controller.resumeObserved`）恢复时会用
 * `composeAgent` 的 setup 调 `presets.mount(agentCtx, presetId)` 补这一刀，
 * 本函数照抄同一招。
 *
 * 印章（preset id）读 `agentPreset` 会话投影，**读不到就不挂**——挂错 preset
 * 会让会话历史里已记录的工具调用失效（README 明确禁止中途换组装），所以绝不
 * 猜默认。服务缺失（TUI/CLI 宿主、旧运行时）或重挂失败只降级：agent 照常
 * 醒来，只是没有工具（即修复前的行为），绝不拖累冷恢复本身。
 *
 * @returns 可直接塞进 `agents.resume` 的 `setup`；无法重挂时 undefined。
 */
export async function presetRemountSetup(
  ctx: unknown,
  sessionId: SessionId,
): Promise<((agentCtx: unknown) => Promise<void>) | undefined> {
  const presets = serviceOf(ctx, 'agentPresets') as PresetMounterFace | undefined;
  if (presets === undefined || typeof presets.mount !== 'function') return undefined;
  const presetId = await recordedPresetId(ctx, String(sessionId));
  if (presetId === undefined) return undefined;
  return async (agentCtx: unknown): Promise<void> => {
    try {
      await presets.mount(agentCtx, presetId);
    } catch (error) {
      warnOf(ctx, `eteams: 冷恢复重挂 preset 失败（${String(sessionId)} / ${presetId}）：${String(error)}`);
    }
  };
}

/**
 * 冷恢复选项（续派冷恢复修复）：把宿主会话默认模型路线（settings
 * agent-default-model 的即时快照，{@link sessionDefaultRouteOf}）与 preset
 * 重挂 setup（{@link presetRemountSetup}）随 `agents.resume` 一并交给宿主。
 *
 * 路线为什么是硬需求：宿主把 `AgentOptions.model` 直接当作提示词变量
 * `{{model}}` 的取值且不回落适配器默认，冷恢复不带路线时该变量无值，部署级
 * `deployment:persona` 段渲染即抛「prompt variable "{{model}}" has no value
 * for this assembly (section "deployment:persona")」，续派唤醒整条断掉。
 *
 * 路线解析失败（旧运行时/单测 fake/启动序竞态，服务未挂）时不带
 * agentOptions，保持旧行为（与成员 spawn 的降级口径一致）。
 */
export async function resumeOptionsOf(
  ctx: unknown,
  resumeSessionId: SessionId,
  signal?: AbortSignal,
): Promise<{
  resumeSessionId: SessionId;
  signal?: AbortSignal;
  agentOptions?: { provider: string; model: string; reasoningEffort?: string };
  setup?: (agentCtx: unknown) => Promise<void>;
}> {
  const route = sessionDefaultRouteOf(ctx);
  const setup = await presetRemountSetup(ctx, resumeSessionId);
  return {
    resumeSessionId,
    ...(signal !== undefined ? { signal } : {}),
    ...(route !== undefined ? { agentOptions: route } : {}),
    ...(setup !== undefined ? { setup } : {}),
  };
}

/**
 * 向一个活会话投递 plugin notice（form: 'notice' 的折叠行）。
 *
 * harness 0.1.2 实测（2026-09-08）：`agent.steer` 对**从未开过回合的空白
 * 会话**不再启动驱动器（notice 被 splice 进 inbox 却永远停在未开始屏）。
 * 按 target 分发：
 * - `next-turn`（空白/空闲会话的 engage）：优先 `agent.followup`——宿主自家
 *   schedule 插件的唤醒原语（"Queue an ordinary follow-up turn and wake
 *   the driver"，空会话同样开回合）；
 * - `next-step`（运行中会话的就近插话 / 转交）：优先 `send(msg,'next-step',
 *   true)`（wakeup 对 running/idle/blank 都正确），旧宿主退回 steer。
 * 全部缺失则静默放弃。
 */
export function deliverNotice(
  agent: Agent,
  message: UserMessage,
  target: 'next-turn' | 'next-step' = 'next-turn',
): void {
  const face = agent as {
    followup?: (message: UserMessage) => void;
    send?: (message: UserMessage, target: 'next-turn' | 'next-step', wakeup: boolean) => void;
    steer?: (message: UserMessage) => void;
  };
  if (target === 'next-step') {
    if (typeof face.send === 'function') {
      face.send(message, 'next-step', true);
      return;
    }
    face.steer?.(message);
    return;
  }
  if (typeof face.followup === 'function') {
    face.followup(message);
    return;
  }
  if (typeof face.send === 'function') {
    face.send(message, 'next-turn', true);
    return;
  }
  face.steer?.(message);
}

/** Tiny join helper (avoids importing node:path twice in hot paths). */
export function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .filter((p) => p !== '')
    .join('/');
}

/**
 * 向一个 continuable 子代理投递下一条消息并唤醒（harness 0.1.2 起 followup
 * 被 sendMessage 取代——steer 语义：running 目标在最近 step 边界入列 / idle
 * 开新回合 / 不在场的直接子代理冷恢复）。按宿主能力探测分发：0.1.2+ 走
 * sendMessage，旧宿主退回 followup。signal 缺省兜底成永不中止的信号——
 * 0.1.2 两个入口都对 signal 无保护调用 `throwIfAborted()`，undefined 直接
 * TypeError（成员 spawn/唤醒路径的 env.signal 可为缺省）。
 */
export async function deliverToChild(
  subagents: RuntimeContext['subagents'],
  parent: Agent,
  childId: SessionId,
  content: ContentBlock[],
  signal?: AbortSignal,
): Promise<unknown> {
  const sig = signal ?? new AbortController().signal;
  const face = subagents as {
    sendMessage?: (
      sender: Agent,
      targetId: SessionId,
      content: ContentBlock[],
      options: { signal: AbortSignal },
    ) => Promise<unknown>;
    followup?: (
      parent: Agent,
      childId: SessionId,
      content: ContentBlock[],
      options: { source: unknown; signal?: AbortSignal },
    ) => Promise<unknown>;
  };
  if (typeof face.sendMessage === 'function') {
    return face.sendMessage(parent, childId, content, { signal: sig });
  }
  return face.followup?.(parent, childId, content, {
    source: { kind: 'plugin', plugin: 'dsh-eteams' },
    signal: sig,
  });
}

/** Tool-layer error carrying an actionable Chinese hint. */
export class ETeamsError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'ETeamsError';
    this.hint = hint;
  }
}

/** Actor record for the captain of one team. */
export function captainActor(_team?: TeamState): Actor {
  return { kind: 'captain', name: '领队' };
}

/**
 * Minimal structural view of one `listChildren` entry (docs/20.3): only the
 * fields eteams consumes; the runtime may carry more.
 */
export interface SubagentChildEntry {
  kind: 'child' | 'diagnostic';
  id: string;
  activity?: 'running' | 'inactive';
  mode?: 'one-shot' | 'continuable';
  label?: string;
}

/**
 * Actor record for one member. 参数放宽为「带名字的最小形状」：成员模板行
 * （MemberRecord）与执行实例行（TaskMemberRecord）都能直接传入——docs/35
 * §5#12 之后成员身份落在 task_members 实例行上。
 */
export function memberActor(member: { name: string }): Actor {
  return { kind: 'member', name: member.name };
}

/** Plugin actor (state-machine-driven messages). */
export const PLUGIN_ACTOR: Actor = { kind: 'plugin', name: 'dsh-eteams' };

/** Fresh attempt token (url-safe, 24 hex chars). */
export function generateToken(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Shared lock registry (re-export so tools/ and verify import one place). */
export { locks };
export { teamDir };
