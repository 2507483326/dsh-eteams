/**
 * roster model effects 单测（docs/21-client-ui-stack.md S10）：vi.mock
 * api.ts（路径按测试文件相对位置），验证 fetchRoster effect 成功装载 list、
 * 失败置 error（静默面，promise 照常 resolve）；save/delete 的 payload 透传
 * 与失败上抛（dispatch promise reject + onError 接 diagnostics 的通道语义）
 * 一并对契约。每个用例用独立 dva app（只注册 rosterModel），状态互不串扰。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create, type DvaApp, type DvaOptions } from 'dva-core';
import type { RosterMember } from '../src/client/api';
import { deleteRosterMember, fetchRoster, saveRosterMember } from '../src/client/api';
// 副作用引入模型聚合层：roster/build 全量注册面 + regenerator 全局就位
// （dva-core 的 CJS 构建面 effects 路径依赖裸全局 regeneratorRuntime，
// 生产路径经 store/app.ts → models/index.ts 安装；直连 model 的本测试
// 显式走同一路径）。
import '../src/client/store/models/index';
import { rosterModel, type RosterState } from '../src/client/store/models/roster';

// 聚合层同时加载 build model，api mock 需覆盖 roster+build 两侧的导入面
// （vi.mock 工厂替换整个模块，缺一个绑定即报错）。
vi.mock('../src/client/api', () => ({
  fetchRoster: vi.fn(),
  saveRosterMember: vi.fn(),
  deleteRosterMember: vi.fn(),
  fetchBuildState: vi.fn(),
  confirmBuild: vi.fn(),
  cancelBuild: vi.fn(),
  restartBuild: vi.fn(),
  resumeBuild: vi.fn(),
  submitInterview: vi.fn(),
}));

const MEMBER: RosterMember = { name: 'alice', role: 'engineer', updatedAt: 1 };

/** dva effect dispatch 返回完成 promise（createPromiseMiddleware 契约）；TS 面按 action 归一，这里显式还原。 */
function dispatchEffect(app: DvaApp, action: { type: string; payload?: unknown }): Promise<void> {
  return app._store.dispatch(action) as unknown as Promise<void>;
}

/** 独立 app：只注册 rosterModel，create 的 onError 钩子可被用例捕获断言。 */
function makeApp(onError?: DvaOptions['onError']): DvaApp {
  const app = create({ onError });
  app.model(rosterModel);
  app.start();
  return app;
}

function rosterOf(app: DvaApp): RosterState {
  return app._store.getState().roster as RosterState;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('roster effects（S10）', () => {
  it('fetchRoster：成功装载 list，清掉 error，loading 收尾为 false', async () => {
    vi.mocked(fetchRoster).mockResolvedValue([MEMBER]);
    const app = makeApp();

    await dispatchEffect(app, { type: 'roster/fetchRoster' });

    const roster = rosterOf(app);
    expect(roster.list).toEqual([MEMBER]);
    expect(roster.loading).toBe(false);
    expect(roster.error).toBeNull();
  });

  it('fetchRoster：失败置 error、list 保留旧值；静默面不 reject dispatch promise', async () => {
    const onError = vi.fn();
    const app = makeApp(onError);
    // 先成功装载一份旧列表，再验证失败路径的 last good 语义。
    vi.mocked(fetchRoster).mockResolvedValueOnce([MEMBER]);
    await dispatchEffect(app, { type: 'roster/fetchRoster' });
    vi.mocked(fetchRoster).mockRejectedValue(new Error('boom'));

    await dispatchEffect(app, { type: 'roster/fetchRoster' });

    const roster = rosterOf(app);
    expect(roster.error).toBe('boom');
    expect(roster.loading).toBe(false);
    expect(roster.list).toEqual([MEMBER]);
    // 静默面：不上抛 → onError 不触发，dispatch promise 照常 resolve（能 await 到这里即证）。
    expect(onError).not.toHaveBeenCalled();
  });

  it('saveRoster：payload 透传 api.saveRosterMember，成功清掉 error', async () => {
    vi.mocked(saveRosterMember).mockResolvedValue(undefined);
    const app = makeApp();
    const payload = { name: 'bob', role: 'writer', personaMd: '# bob' };

    await dispatchEffect(app, { type: 'roster/saveRoster', payload });

    expect(saveRosterMember).toHaveBeenCalledWith(payload);
    expect(rosterOf(app).error).toBeNull();
  });

  it('deleteRoster：失败置 error 并上抛——onError 接 diagnostics，dispatch promise reject', async () => {
    vi.mocked(deleteRosterMember).mockRejectedValue(new Error('denied'));
    const onError = vi.fn();
    const app = makeApp(onError);

    await expect(
      dispatchEffect(app, { type: 'roster/deleteRoster', payload: 'bob' }),
    ).rejects.toThrow('denied');

    expect(deleteRosterMember).toHaveBeenCalledWith('bob');
    expect(rosterOf(app).error).toBe('denied');
    expect(rosterOf(app).loading).toBe(false);
    // 上抛路径：sagaWithCatch → onError（store/app.ts 已接 diagnostics）。
    expect(onError).toHaveBeenCalled();
  });
});
