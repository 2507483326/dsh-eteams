/**
 * 共享模型目录 store 结构探测单测（用户迭代 2026-09-11「直接拉它的数据」）：
 * 选择器与徽章都改读 resolver 级 `catalog.store` 的裸快照——`sharedCatalogStore`
 * 的结构探测因此是共用契约（store 在场返回同一实例、subscribe 可反注册；
 * 未知形状返回 null 让调用方回落旧运行时会话级路径）。hook 本体依赖 React
 * 运行时，这里只锁探测语义与快照放宽（failures 可缺席）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  installModelCatalog,
  sharedCatalogStore,
  type SharedCatalogSnapshot,
} from '../src/client/lib/modelCatalog';

afterEach(() => installModelCatalog(null));

describe('sharedCatalogStore（resolver 级目录 store 结构探测）', () => {
  it('store 在场：返回同一实例，getSnapshot 直读、subscribe 可订阅可反注册', () => {
    const snapshot: SharedCatalogSnapshot = {
      value: { groups: [], failures: [] },
      status: 'ready',
      error: null,
    };
    const listeners = new Set<() => void>();
    const store = {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    installModelCatalog({ modelDirectories: { catalog: { store } } });
    const face = sharedCatalogStore();
    expect(face).toBe(store);
    expect(face?.getSnapshot()).toBe(snapshot);
    let hits = 0;
    const stop = face?.subscribe(() => {
      hits += 1;
    });
    for (const listener of listeners) listener();
    expect(hits).toBe(1);
    stop?.();
    for (const listener of listeners) listener();
    expect(hits).toBe(1);
  });

  it('服务 / store 缺席或结构未知 → null（回落旧运行时会话级路径）', () => {
    installModelCatalog(null);
    expect(sharedCatalogStore()).toBeNull();
    installModelCatalog({});
    expect(sharedCatalogStore()).toBeNull();
    installModelCatalog({ modelDirectories: {} });
    expect(sharedCatalogStore()).toBeNull();
    installModelCatalog({ modelDirectories: { catalog: {} } });
    expect(sharedCatalogStore()).toBeNull();
    installModelCatalog({ modelDirectories: { catalog: { store: {} } } });
    expect(sharedCatalogStore()).toBeNull();
  });

  it('快照放宽 failures 缺席：groups 数组即可渲染目录', () => {
    const snapshot: SharedCatalogSnapshot = {
      value: { groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }] },
      status: 'ready',
    };
    installModelCatalog({
      modelDirectories: {
        catalog: { store: { getSnapshot: () => snapshot, subscribe: () => () => undefined } },
      },
    });
    expect(sharedCatalogStore()?.getSnapshot()?.value?.groups).toHaveLength(1);
  });
});
