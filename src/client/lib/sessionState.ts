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

/** Client sessions 服务（Session Controller）的结构化读取面。 */
interface SessionsFace {
  binding?: (
    sessionId: string,
  ) =>
    | {
        session?: {
          projections?: {
            faceOf?: (key: string) => SnapshotStoreFace<unknown> | undefined;
          };
        };
      }
    | undefined;
  subagentAddress?: (sessionId: string) => unknown;
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
