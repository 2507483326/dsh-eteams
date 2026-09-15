/**
 * Session model catalog (用户迭代 2026-09：模型选择与 harness 对话一致).
 *
 * Reads the SAME per-session ModelDirectory the conversation's /model popup
 * and composer model seat render from (`dsh-client-ui-model-selection`):
 * `ctx.modelDirectories.directoryFor(sessionId).load()` → provider groups +
 * failures, straight from the host catalog. The panel only READS the catalog
 * — route writes go through the eteams host API (member/leader model routes),
 * never `directory.select` (that would switch the captain session's own
 * model, which the plugin must not do).
 *
 * Optional service: an older client runtime without the resolver (or a
 * session scope that resolves no directory) yields null and callers fall
 * back to the static legacy option lists.
 *
 * @module dsh-eteams/client/modelCatalog
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { readClientService } from './serviceFace';

/** One adapter-owned reasoning effort (wire shape mirrors dsh-host-apiproxy sessions). */
export interface CatalogEffort {
  /** Opaque value submitted back to the owning adapter. */
  id: string;
  /** Adapter-supplied display name. */
  name: string;
  /** Optional adapter-supplied description (the conversation's effort pane shows it). */
  description?: string;
}

/** Selectable reasoning metadata for one exact model route. */
export interface CatalogReasoning {
  /** Efforts in adapter-preferred display order. */
  efforts: CatalogEffort[];
  /** Adapter-configured default; absence preserves the provider default. */
  defaultEffort?: string;
}

/** One model displayed inside its provider group. */
export interface CatalogModel {
  /** Provider-owned model id. */
  id: string;
  /** Provider-supplied display name. */
  name: string;
  /** Optional provider-supplied description. */
  description?: string;
  /** Exact-route reasoning metadata when the adapter exposes it. */
  reasoning?: CatalogReasoning;
}

/** One provider and the models it advertised successfully. */
export interface CatalogGroup {
  /** Provider route id used for requests. */
  id: string;
  /** Provider display name. */
  name: string;
  /** Models in provider-preferred order. */
  models: CatalogModel[];
}

/** A provider whose asynchronous catalog lookup failed. */
export interface CatalogFailure {
  /** Provider route id. */
  id: string;
  /** Provider display name. */
  name: string;
  /** Lookup failure diagnostic. */
  message: string;
}

/** The panel-facing slice of the shared session model directory. */
export interface ModelCatalog {
  /** Successfully loaded provider groups (host-preferred order). */
  groups: CatalogGroup[];
  /** Provider-local failures; usable groups stay usable. */
  failures: CatalogFailure[];
}

/**
 * 目录状态包（`useModelCatalog` 返回值，用户迭代 2026-09 二级菜单）：数据 +
 * 加载/失败态 + `reload`（对话选择器每次打开刷新目录同款）。
 */
export interface ModelCatalogState {
  /**
   * 目录数据；null = 服务缺失（旧运行时，走静态回退）或加载失败且没有旧值。
   * 刷新失败时保留上一次成功目录（stale-while-revalidate：菜单打开刷新中
   * 旧分组照常可点，错误条 + 重试叠加显示），不闪回空态。
   */
  catalog: ModelCatalog | null;
  /** 目录刷新中（对话 status: 'loading' 同款，列表上方显示刷新条）。 */
  loading: boolean;
  /** 服务在但目录加载失败（对话错误条 + 重试同款；服务缺失时恒 false）。 */
  failed: boolean;
  /** 重新拉取目录（菜单打开时与错误条「重试」都会触发）。 */
  reload: () => void;
}

/** 目录加载限时（毫秒，用户迭代 2026-09-08）：宿主逐提供方拉取目录，个别
 * 提供方挂起时底层 RPC 可能长期不结算——超时按加载失败处理（错误条 + 重试
 * + 静态回退），不让「正在刷新模型列表」无限常挂。仅放弃等待，不取消底层
 * RPC（迟到的成功仍写进共享目录 store，下次打开/重试即命中）。 */
const CATALOG_LOAD_TIMEOUT_MS = 15000;

/** The client root context (structurally probed — the service is optional). */
let catalogCtx: unknown = null;

/**
 * Stash the client root context. The `modelDirectories` service is mounted
 * by the ui-model-selection client plugin (same inject list as this plugin),
 * potentially after our apply() — so the property is read lazily at load
 * time, not here.
 * @param ctx - client root context (cordis).
 */
export function installModelCatalog(ctx: unknown): void {
  catalogCtx = ctx;
}

/** Structural face of the resolver service we rely on (read-only use). */
interface DirectoryFace {
  load(): Promise<unknown>;
}
interface ResolverFace {
  directoryFor(sessionId: string): DirectoryFace;
}

function resolverOf(): ResolverFace | null {
  // 经 readClientService 读取（服务不活跃时裸属性访问会抛 inactive context，
  // 见 serviceFace 模块头）；服务缺席/暂不可用一律回 null → 静态回退。
  const face = readClientService(catalogCtx, 'modelDirectories');
  if (typeof face !== 'object' || face === null) return null;
  const resolver = face as ResolverFace;
  if (typeof resolver.directoryFor !== 'function') return null;
  return resolver;
}

/** 共享目录 store 的裸快照（dsh-client-store 家族：value/status/error）。 */
export interface SharedCatalogSnapshot {
  /** 宿主世代目录值（`default/routableProviders/groups/failures`）；刷新失败时保留上一份。 */
  value?: { groups?: CatalogGroup[]; failures?: CatalogFailure[] } | null;
  /** 生命周期：idle/loading/ready/error（选择器据此显示刷新条与错误条）。 */
  status?: string;
  /** 目录加载失败诊断（status='error' 时）。 */
  error?: string | null;
}

/**
 * 共享模型目录 store（resolver 级、全体会话共用一份——官方 resolver 构造
 * 即后台 load()，并在 adapters/settings 变化时自动刷新）。子会话模型徽章
 * 的目录名反查用它：**不经** `directoryFor(...).load()`——后者对已寻址
 * 子代理会话断言可用即抛（assertAvailable），且带 composer 阻塞块副作用，
 * 只读反查不该走那条路。内部属性 `catalog.store` 结构化探测（2026-09-09
 * 实测宿主内嵌包 resolver 形状）；未知结构 → null，徽章回退显示 id 原值。
 */
export function sharedCatalogStore(): {
  getSnapshot: () => SharedCatalogSnapshot | undefined;
  subscribe: (listener: () => void) => () => void;
} | null {
  const face = readClientService(catalogCtx, 'modelDirectories');
  if (typeof face !== 'object' || face === null) return null;
  const store = (face as { catalog?: { store?: unknown } }).catalog?.store;
  if (typeof store !== 'object' || store === null) return null;
  const candidate = store as {
    getSnapshot?: () => SharedCatalogSnapshot | undefined;
    subscribe?: (listener: () => void) => () => void;
  };
  if (typeof candidate.getSnapshot !== 'function' || typeof candidate.subscribe !== 'function') {
    return null;
  }
  return candidate as {
    getSnapshot: () => SharedCatalogSnapshot | undefined;
    subscribe: (listener: () => void) => () => void;
  };
}

/**
 * 共享目录的请求器（resolver 级 `catalog.load()`，结构化探测并**保持 this**
 * ——load 读 this.store，脱钩调用会丢接收者）。选择器打开时用它触发一次
 * 缓存感知的刷新：目录已 ready 即在飞/命中，未 ready 才真发宿主 RPC，
 * 与官方 ModelSelect.show() → load() 同语义（用户迭代 2026-09-11「直接拉它
 * 的数据」）。服务/结构缺席 → null（旧运行时回落会话级路径）。
 */
function sharedCatalogLoad(): (() => Promise<unknown>) | null {
  const face = readClientService(catalogCtx, 'modelDirectories');
  if (typeof face !== 'object' || face === null) return null;
  const catalog = (face as { catalog?: unknown }).catalog;
  if (typeof catalog !== 'object' || catalog === null) return null;
  const load = (catalog as { load?: unknown }).load;
  if (typeof load !== 'function') return null;
  return () => (load as () => Promise<unknown>).call(catalog);
}

/**
 * Load the session's shared model catalog (the same data the conversation
 * picker renders). Null when the resolver service is absent or the payload
 * shape is unexpected（旧运行时/未知结构 → 静态回退）; the RPC failure path
 * THROWS so the hook can flag `failed`（对话同款错误条 + 重试，用户迭代
 * 2026-09 二级菜单）。
 *
 * 2026-09-11 起只作旧运行时兜底：共享目录 store 在场的运行时，选择器改
 * 订阅 store 直接读（共享目录已是宿主世代级缓存），不再每次经本函数 await。
 * @param sessionId - the owning conversation session.
 */
export async function loadModelCatalog(sessionId: string): Promise<ModelCatalog | null> {
  const resolver = resolverOf();
  if (resolver === null) return null;
  // 限时等待（见 CATALOG_LOAD_TIMEOUT_MS 注记）：Promise.race 只放弃等待，
  // 底层 RPC 与共享目录 store 不受影响。
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const models = (await Promise.race([
      resolver.directoryFor(sessionId).load(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`model catalog load timed out after ${CATALOG_LOAD_TIMEOUT_MS}ms`)),
          CATALOG_LOAD_TIMEOUT_MS,
        );
      }),
    ])) as {
      groups?: unknown;
      failures?: unknown;
    };
    if (!Array.isArray(models?.groups)) return null;
    return {
      groups: models.groups as CatalogGroup[],
      failures: Array.isArray(models.failures) ? (models.failures as CatalogFailure[]) : [],
    };
  } finally {
    clearTimeout(timer);
  }
}

/** uSES 缺源时的恒定订阅/快照（store 缺席 → 永不通知、快照 undefined）。 */
const NOOP_SUBSCRIBE = (): (() => void) => () => undefined;
const NOOP_SNAPSHOT = (): undefined => undefined;

/** 共享快照 → 面板目录值（value 缺席或 groups 非数组 → null = 尚无目录）。 */
function catalogOf(snapshot: SharedCatalogSnapshot | undefined): ModelCatalog | null {
  const value = snapshot?.value ?? null;
  if (value === null || !Array.isArray(value.groups)) return null;
  return {
    groups: value.groups,
    failures: Array.isArray(value.failures) ? value.failures : [],
  };
}

/**
 * Read the shared model catalog the conversation's /model popup renders.
 *
 * 用户迭代 2026-09-11「直接拉它的数据」：共享目录已是**宿主世代级缓存**
 * （官方 resolver 构造即后台预热一次、in-flight 去重、ready 即命中；官方
 * ModelSelect 与 /model 弹层同样只读它）——这里改为**订阅**该 store 直接读
 * 快照，打开选择器首帧即出列表，不再每次 `directoryFor(...).load()` await
 * 往返（旧路径的 15s 超时/冷恢复假设属 rc.8 会话级契约，已过时）。
 *
 * loading / failed / reload 语义与官方 ModelSelect 对齐：loading 只表示目录
 * 尚未就绪（已有目录时后台刷新不挂提示条，stale-while-revalidate）；failed
 * 只在「store 在但加载失败」时为 true；reload 触发一次缓存感知的
 * `catalog.load()`（ready 即 no-op）。目录 store 缺席的旧运行时回落原生会话级
 * 路径（loadModelCatalog + 15s 限时），行为不变。
 *
 * Undefined session (overlay/hero surfaces) → 无会话级兜底 → 静态回退选项。
 */
export function useModelCatalog(sessionId: string | undefined): ModelCatalogState {
  // 共享目录 store（全体会话共用一份，构造即预热）；缺席 = 旧运行时。
  const store = sharedCatalogStore();
  const shared = useSyncExternalStore(
    store?.subscribe ?? NOOP_SUBSCRIBE,
    store?.getSnapshot ?? NOOP_SNAPSHOT,
  );
  // 旧运行时兜底态（store 在场时此路不跑；hook 顺序恒定）。
  const [legacy, setLegacy] = useState<{
    catalog: ModelCatalog | null;
    loading: boolean;
    failed: boolean;
  }>(() => ({
    catalog: null,
    // 首载即 loading（菜单首开显示刷新条）；会话未挂时无从加载，恒 false。
    loading: typeof sessionId === 'string' && sessionId !== '',
    failed: false,
  }));
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (store !== null) return;
    if (typeof sessionId !== 'string' || sessionId === '') return;
    let alive = true;
    void loadModelCatalog(sessionId)
      .then((catalog) => {
        if (alive) setLegacy({ catalog, loading: false, failed: false });
      })
      .catch(() => {
        // 刷新失败保留旧目录（对话同款：失败条叠加在旧列表上，不闪回空态）。
        if (alive) setLegacy((s) => ({ catalog: s.catalog, loading: false, failed: true }));
      });
    return () => {
      alive = false;
    };
  }, [store, sessionId, tick]);
  // 打开时刷新（对话 ModelSelect.show() → reload() 同款）：共享 store 在场时
  // 走缓存感知的 catalog.load()（ready 即命中，不重复往返）；旧运行时置
  // loading 并 tick 重拉（setState 在事件回调里——react-hooks/set-state-in-effect
  // 禁止 effect 同步 setState）。
  const reload = useCallback(() => {
    if (store !== null) {
      const load = sharedCatalogLoad();
      if (load !== null) {
        void load().catch(() => {
          // 失败态由 store 的 status/error 承载，订阅会推到界面（错误条 + 重试）。
        });
        return;
      }
    }
    setLegacy((s) => ({ ...s, loading: true }));
    setTick((t) => t + 1);
  }, [store]);
  if (store !== null) {
    return {
      catalog: catalogOf(shared),
      loading: shared?.status === 'loading',
      failed: shared?.status === 'error',
      reload,
    };
  }
  return {
    catalog: legacy.catalog,
    loading: legacy.loading,
    failed: legacy.failed,
    reload,
  };
}

/**
 * Look up the catalog row (group + model) for an exact provider/model route —
 * the effort menu's vocabulary and the default-effort fallback both come from
 * this row, exactly as the conversation's effort level reads it.
 */
export function catalogRow(
  catalog: ModelCatalog | null,
  provider: string,
  model: string,
): { group: CatalogGroup; model: CatalogModel } | null {
  if (catalog === null) return null;
  for (const group of catalog.groups) {
    for (const row of group.models) {
      if (group.id === provider && row.id === model) return { group, model: row };
    }
  }
  return null;
}

/**
 * 反查目录行（docs/35 §3#5：快照路线只剩 {model, reasoningEffort}，provider
 * 由 model 经目录反推——同 id 模型跨提供方极少见，取目录首命中）。目录缺失
 * 或查不到（旧路线/静态回退）返回 null，调用方按裸模型 id 口径渲染。
 */
export function catalogRowByModel(
  catalog: ModelCatalog | null,
  model: string,
): { group: CatalogGroup; model: CatalogModel } | null {
  if (catalog === null || model === '') return null;
  for (const group of catalog.groups) {
    for (const row of group.models) {
      if (row.id === model) return { group, model: row };
    }
  }
  return null;
}
