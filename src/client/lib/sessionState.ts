/**
 * 会话状态读取面（子会话模型徽章的数据源，用户迭代 2026-09-09「请调研一下
 * 文档，这个功能不是插槽进子agent的对话框中就行？」→ 方案 A 拍板）。
 *
 * 徽章改读客户端会话绑定上的**持久投影**：`modelSelection`（宿主从会话日志
 * 折叠的 durable 模型选择——`lastUsed` = 最近一次请求实际消耗的 provider/
 * model，`next` = 下一次请求将用的选择；重启/冷恢复免疫，因为投影是从
 * 持久日志重建的）与 `sessions.subagentAddress`（宿主会话控制器对「已寻址
 * 子代理会话」的判定——composer 模型座位正按它门控，徽章恰在此补位）。
 * 不再轮询插件自己的 /session-route 端点（声明路线登记本机制随徽章改源
 * 一并退役）。
 *
 * 契约依据（实测宿主内嵌包，2026-09-09）：dsh-client-ui-model-selection
 * lib/client.js 的 `binding.session.projections.faceOf("modelSelection")`
 * 与 `sessions.subagentAddress(sessionId)`（官方模型座位的同源读取路径）；
 * `ModelSelectionProjection {lastUsed, next}` 类型出自
 * dsh-api-session-controller。全部结构化探测（eteamsCard 同款纪律）——
 * 旧运行时/未知结构一律返回 null/false，徽章静默不渲染，绝不抛错。
 *
 * 主路径（2026-09-10 起）：框架随 session 作用域槽位组件下发的标准座位
 * kit（SessionStandardProps：sessionId / useSession / useProjection）——
 * 官方 model-selection 插件正是把 `faceOf("modelSelection")` 包成
 * useProjection 下发，kit 读取与本模块的 ctx.sessions 探测**同源**。本
 * 模块退居兜底：kit hook 缺席的轴（旧装配/未知运行时）用这里的探测接住。
 *
 * 2026-09-11 扩面（面板「添加任务」改走新建对话）：同一探测面再加三件会话
 * 动词——`createSession`（宿主建会话，New Session 流程同源）、
 * `promptSession`（把任务描述作为新对话的首条消息投递）、`sessionCwdOf`
 * （沿用来源对话的工作区）。三者都是结构化探测：能力缺失/调用失败一律
 * 回 null/false，调用方自行降级，绝不抛错。
 *
 * 2026-09-11 会话树根（面板「切到主会话的子会话不显示本会话」修复）：
 * `rootSessionIdOf` 沿 `subagentAddress` / 会话列表行的 `parentId` 上溯到
 * 最顶层会话——任务行 `main_session_id` 登记的是**主对话**快照，面板在
 * 子会话（成员/领队/构建师子代理）里打开时直接拿子会话 id 比对永远等不
 * 上（「本会话」徽标消失、卡不可点），故会话归属一律按主对话口径判定。
 * 同为结构化探测：服务缺失/无父链/畸形结构原样返回入参（退化为旧行为）。
 *
 * @module dsh-eteams/client/sessionState
 */

/** Snapshot-store face（dsh-client-store 家族：裸 getSnapshot + subscribe）。 */
export interface SnapshotStoreFace<T> {
  getSnapshot?: () => T;
  subscribe?: (listener: () => void) => () => void;
}

/** ModelSelection 的选择值（provider/model 为目录级路线 id）。 */
export interface ModelSelectionValue {
  provider?: string;
  model?: string;
}

/** `modelSelection` 投影的客户端视图（dsh-api-session-controller 同名类型
 * 的结构化投影）：`next` 已由宿主折叠为「下一次请求将用的选择」。 */
export interface ModelSelectionProjectionView {
  lastUsed?: ModelSelectionValue | null;
  next?: ModelSelectionValue | null;
}

/** 会话行为动词的结构化投影（SessionFace：本模块只探我们用到的两件）。 */
interface SessionFaceView {
  /** Host-computed projection values by key（模型选择徽章用）。 */
  projections?: {
    faceOf?: (key: string) => SnapshotStoreFace<unknown> | undefined;
  };
  /** 往该会话投递一条用户消息（SessionFace.prompt 的正式动词）。 */
  prompt?: (
    content: { type: 'text'; text: string }[],
    mode: 'queue' | 'steer',
  ) => Promise<unknown>;
}

/** Client sessions 服务（Session Controller）的结构化读取面。 */
interface SessionsFace {
  binding?: (sessionId: string) => { session?: SessionFaceView } | undefined;
  subagentAddress?: (sessionId: string) => unknown;
  /** 会话列表快照（useSessions 标准数据源）：跳转前判定目标会话在不在列表。 */
  list?: {
    getSnapshot?: () => { byId?: Record<string, unknown> } | undefined;
  };
  /** 把某会话选为当前（列表外 id 会 fail loud——调用前先 canOpenSession）。 */
  open?: (sessionId: string) => void;
  /**
   * 宿主建会话（New Session 流程同源——Workspaces.connectWorkspace 走它）。
   * 注意这**不在** ISessions 契约面上（在 SessionsPort 跨域面上），故按本仓
   * 结构探测纪律读取：服务缺失/方法缺失/抛错一律 null，调用方自行降级。
   * 返回形态兼容 SessionRuntime（直接回 SessionId 串）与 Manager（回
   * RpcResult<{sessionId}>）两态。
   */
  create?: (opts?: { workspaceId?: string; cwd?: string }) => Promise<unknown>;
}

/** The client root context (structurally probed — the service is optional). */
let clientCtx: unknown = null;

/**
 * Stash the client root ctx（apply() 调用）。`sessions` 服务由宿主客户端
 * 核心挂载（可能晚于本插件 apply）——属性全部在使用点惰性读取，这里只存
 * 引用。
 */
export function installSessionState(ctx: unknown): void {
  clientCtx = ctx;
}

/**
 * 取宿主 sessions 服务面。**所有方法必须带接收者调用**（`face.open(id)`，不能
 * `const open = face.open; open(id)`）：宿主 `ctx.sessions` 直回 SessionRuntime
 * 实例（普通类、非 cordis Service——服务值无 tracker，cordis 不做 receiver
 * 绑定，实测 `const m = face.m; m()` 即抛 TypeError），而 `open`/`create` 等
 * 方法体依赖 `this`（`this.manager.select(...)`）。脱离接收者的调用会在本
 * 模块的 try/catch 里被吞成「服务不可用」，表现为「跳转会话」恒弹「目标会话
 * 不在当前会话列表中」（用户 2026-09-14 复现）。
 */
function sessionsFaceOf(): SessionsFace | null {
  const face = (clientCtx as { sessions?: unknown } | null)?.sessions;
  if (typeof face !== 'object' || face === null) return null;
  return face as SessionsFace;
}

/**
 * One session's `modelSelection` projection store（官方模型座位同源数据）。
 * 缺服务/缺绑定/未知结构 → null（调用方按无值兜底，徽章不渲染）。
 */
export function modelSelectionStoreOf(
  sessionId: string,
): SnapshotStoreFace<ModelSelectionProjectionView> | null {
  if (sessionId === '') return null;
  const binding = sessionsFaceOf()?.binding?.(sessionId);
  const store = binding?.session?.projections?.faceOf?.('modelSelection');
  if (typeof store !== 'object' || store === null) return null;
  const candidate = store as SnapshotStoreFace<ModelSelectionProjectionView>;
  if (typeof candidate.getSnapshot !== 'function' || typeof candidate.subscribe !== 'function') {
    return null;
  }
  return candidate;
}

/**
 * 该会话是否为「已寻址子代理会话」——宿主会话控制器的判定，模型座位正按
 * 它门控（"model selection is unavailable for addressed subagent sessions"），
 * 徽章的门控与座位互补：座位被门控的会话才显示徽章。缺服务 → false。
 */
export function isAddressedSubagentSession(sessionId: string): boolean {
  if (sessionId === '') return false;
  const face = sessionsFaceOf();
  if (typeof face?.subagentAddress !== 'function') return false;
  return face.subagentAddress(sessionId) !== undefined;
}

/** 一个会话的父会话 id（子代理寻址优先，退会话列表行的 parentId）。 */
function parentSessionIdOf(sessionId: string): string | null {
  const face = sessionsFaceOf();
  const address = face?.subagentAddress?.(sessionId) as { parentSessionId?: unknown } | undefined;
  const fromAddress = address?.parentSessionId;
  if (typeof fromAddress === 'string' && fromAddress !== '') return fromAddress;
  const byId = face?.list?.getSnapshot?.()?.byId;
  const row = byId === undefined ? undefined : byId[sessionId];
  const fromRow = (row as { parentId?: unknown } | undefined)?.parentId;
  return typeof fromRow === 'string' && fromRow !== '' ? fromRow : null;
}

/**
 * 会话树根 id（2026-09-11「切到主会话的子会话不显示本会话」修复）：沿
 * `subagentAddress` / 会话列表行 `parentId` 逐级上溯到最顶层会话——已寻址
 * 子代理会话（成员/领队/构建师）回主对话 id，主会话回自身。
 *
 * 面板的会话归属判定消费它：任务行 `main_session_id` 登记的是主对话快照，
 * 面板在子会话里打开时直接拿子会话 id 比对永远等不上。结构化探测纪律同本
 * 模块其余读取面——服务缺失/无父链/畸形结构一律原样返回入参（退化为旧
 * 行为），成环时截断防死循环，绝不抛错。
 */
export function rootSessionIdOf(sessionId: string | null | undefined): string | undefined {
  if (sessionId === null || sessionId === undefined || sessionId === '') return undefined;
  let current = sessionId;
  const seen = new Set<string>([current]);
  for (;;) {
    const parent = parentSessionIdOf(current);
    if (parent === null || parent === current || seen.has(parent)) break;
    seen.add(parent);
    current = parent;
  }
  return current;
}

/**
 * 会话列表里有没有这个会话（跳转按钮的显隐判据）：`open()` 对列表外 id
 * fail loud，必须先经这里判定。缺服务/未知结构 → false（按钮不渲染）。
 */
export function canOpenSession(sessionId: string): boolean {
  if (sessionId === '') return false;
  const list = sessionsFaceOf()?.list;
  const getSnapshot = typeof list?.getSnapshot === 'function' ? list.getSnapshot : undefined;
  const byId = getSnapshot?.()?.byId;
  if (typeof byId !== 'object' || byId === null) return false;
  return Object.hasOwn(byId, sessionId);
}

/**
 * 跳转到会话（SessionRuntime.open——把目标会话选为当前，宿主布局即切换）。
 * 仅对列表内的会话生效；失败（缺服务/不在列表/fail loud）返回 false，调用
 * 方自行提示。任务页「跳转到会话」按钮的落点。
 */
export function openSession(sessionId: string): boolean {
  if (sessionId === '') return false;
  const face = sessionsFaceOf();
  if (face === null || typeof face.open !== 'function') return false;
  try {
    // 带接收者调用（见 sessionsFaceOf 注）：脱离 receiver 会丢 this 抛错，
    // 被这里吞成「不在列表」。
    face.open(sessionId);
    return true;
  } catch {
    return false;
  }
}

/**
 * 当前会话的工作目录（会话列表行快照的 cwd）：新建对话时沿用同一工作区，
 * 避免新对话落到宿主默认目录而与来源对话不在一个工作区。缺服务/无该行/
 * cwd 缺失一律 null，调用方按「宿主默认」兜底。
 */
export function sessionCwdOf(sessionId: string): string | null {
  if (sessionId === '') return null;
  const byId = sessionsFaceOf()?.list?.getSnapshot?.()?.byId;
  const row = byId === undefined ? undefined : byId[sessionId];
  const cwd = (row as { cwd?: unknown } | undefined)?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : null;
}

/**
 * 宿主建一个新会话，返回新会话 id。新 id 在 resolve 时已在列表里（宿主契约：
 * 建完即可 `open`/`binding`——草稿交接据此同步寻址）。能力缺失/建失败 → null，
 * 调用方按错误处理（本仓探测纪律：旧运行时绝不抛错）。
 */
export async function createSession(opts?: { cwd?: string }): Promise<string | null> {
  const face = sessionsFaceOf();
  if (face === null || typeof face.create !== 'function') return null;
  try {
    const cwd = opts?.cwd;
    // 带接收者调用（见 sessionsFaceOf 注）：`this.manager.create(...)` 依赖 this。
    const result = await face.create(cwd !== undefined && cwd !== '' ? { cwd } : undefined);
    if (typeof result === 'string' && result !== '') return result;
    const id = (result as { sessionId?: unknown } | null | undefined)?.sessionId;
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}

/**
 * 往指定会话投递一条用户消息（新对话把任务描述带过去）。缺服务/缺 binding/
 * 缺 prompt 动词/宿主拒绝 → false；调用方据此给出可诊断提示，但不回滚会话
 * （会话已建立，消息可重发）。
 */
export async function promptSession(sessionId: string, text: string): Promise<boolean> {
  if (sessionId === '' || text.trim() === '') return false;
  // binding 带接收者调用；session.prompt 同理（见 sessionsFaceOf 注：脱离
  // receiver 会丢 this 抛错，被吞成投递失败）。
  const session = sessionsFaceOf()?.binding?.(sessionId)?.session;
  if (session === undefined || typeof session.prompt !== 'function') return false;
  try {
    const result = await session.prompt([{ type: 'text', text }], 'queue');
    if (result === null || result === undefined) return false;
    if (typeof result === 'object' && 'ok' in result) {
      return (result as { ok?: unknown }).ok === true;
    }
    // SessionRuntime 的会话动词直回业务值（无 RpcResult 包装）视作受理。
    return true;
  } catch {
    return false;
  }
}
