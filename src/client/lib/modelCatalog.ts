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
import { useCallback, useEffect, useState } from 'react';

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
  const face = (catalogCtx as { modelDirectories?: unknown } | null)?.modelDirectories;
  if (typeof face !== 'object' || face === null) return null;
  const resolver = face as ResolverFace;
  if (typeof resolver.directoryFor !== 'function') return null;
  return resolver;
}

/**
 * Load the session's shared model catalog (the same data the conversation
 * picker renders). Null when the resolver service is absent or the payload
 * shape is unexpected（旧运行时/未知结构 → 静态回退）; the RPC failure path
 * THROWS so the hook can flag `failed`（对话同款错误条 + 重试，用户迭代
 * 2026-09 二级菜单）。
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

/**
 * Load the catalog once per mount (advisory directory, stable within a
 * session; the detail view re-mounts on every entry which is fresh enough).
 * Undefined session (overlay/hero surfaces) → null → legacy options.
 *
 * 用户迭代 2026-09（模型二级菜单）：返回对象带 loading / failed / reload
 * ——对话选择器每次打开都刷新目录（ModelSelect.show() → reload()），加载
 * 失败显示错误条 + 重试，这里同款语义。`failed` 只在「服务在但加载失败」
 * 时为 true；服务缺失是旧运行时的永久态，走静态回退选项、不显示重试。
 */
export function useModelCatalog(sessionId: string | undefined): ModelCatalogState {
  const [state, setState] = useState<{
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
    if (typeof sessionId !== 'string' || sessionId === '') return;
    let alive = true;
    void loadModelCatalog(sessionId)
      .then((catalog) => {
        if (alive) setState({ catalog, loading: false, failed: false });
      })
      .catch(() => {
        // 刷新失败保留旧目录（对话同款：失败条叠加在旧列表上，不闪回空态）。
        if (alive) setState((s) => ({ catalog: s.catalog, loading: false, failed: true }));
      });
    return () => {
      alive = false;
    };
  }, [sessionId, tick]);
  // 打开时刷新（对话 ModelSelect.show() → reload() 同款）：loading 置位在
  // 事件回调里（react-hooks/set-state-in-effect 禁止 effect 同步 setState），
  // tick 触发上方 effect 重新拉取。
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    setTick((t) => t + 1);
  }, []);
  return {
    catalog: state.catalog,
    loading: state.loading,
    failed: state.failed,
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
