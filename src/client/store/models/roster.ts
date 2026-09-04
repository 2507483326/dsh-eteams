/**
 * roster model（docs/21-client-ui-stack.md S10 / 21.5.3）：成员库（D16）的
 * 列表 + 加载/错误态，CRUD 副作用迁入 dva effects。eteamsView 的调用点改发
 * `roster/fetchRoster` / `roster/saveRoster` / `roster/deleteRoster`，
 * 不再直接 await api（api.ts 仍是唯一 HTTP 面，本步不动它）。
 *
 * effects 全部走 dva 2 数组式 takeLatest（getSaga.js getWatcher 按 opts.type
 * 选择 watcher）：同名 action 连发时只保留最新一次，切 tab/轮询刷新天然防叠。
 * 失败语义分两档：
 * - fetch：落 state.error 后吞掉——迁移前 refreshRoster 就是
 *   `.catch(() => undefined)` 的静默面，且切 tab 高频触发，不上抛（不给
 *   onError 打无谓诊断），dispatch promise 照常 resolve。
 * - save/delete：落 state.error 后重新抛出——dva 的 sagaWithCatch 转交
 *   onError（store/app.ts 已接 diagnostics）并 reject dispatch promise，
 *   组件的 catch 面（保存/删除失败的显式提示）与迁移前一致。
 *
 * @module dsh-eteams/client/store/models/roster
 */
import type { DvaAction } from 'dva-core';
import {
  deleteRosterMember,
  fetchRoster,
  saveRosterMember,
  type NewMemberInput,
  type RosterMember,
} from '../../lib/api';
import type { EffectCommands, TakeLatestEffect } from './index';

/** 成员库状态（21.5.3）：列表 + 加载/错误态。 */
export interface RosterState {
  list: RosterMember[];
  loading: boolean;
  error: string | null;
}

/** fetch worker：call api.fetchRoster → put 整表替换（空表也是合法快照）。 */
function* fetchRosterWorker(_action: DvaAction<void>, { call, put }: EffectCommands): Generator {
  yield put({ type: 'setLoading', payload: true });
  try {
    const list = (yield call(fetchRoster)) as RosterMember[];
    yield put({ type: 'setList', payload: list });
    yield put({ type: 'setError', payload: null });
  } catch (e) {
    // 静默面（见模块注释）：只落 state.error，不向上抛。
    yield put({ type: 'setError', payload: e instanceof Error ? e.message : String(e) });
  } finally {
    yield put({ type: 'setLoading', payload: false });
  }
}

/**
 * save worker：payload 透传 api.saveRosterMember（dva 运行时不校验 payload
 * 形状，调用方保证；对齐 activity model 的「payload 缺键由调用点兜底」分工）。
 */
function* saveRosterWorker(
  { payload }: DvaAction<NewMemberInput>,
  { call, put }: EffectCommands,
): Generator {
  yield put({ type: 'setLoading', payload: true });
  try {
    yield call(saveRosterMember, payload as NewMemberInput);
    yield put({ type: 'setError', payload: null });
  } catch (e) {
    yield put({ type: 'setError', payload: e instanceof Error ? e.message : String(e) });
    // 保存失败要可见：上抛让 dispatch promise reject，组件 catch 提示。
    throw e;
  } finally {
    yield put({ type: 'setLoading', payload: false });
  }
}

/** delete worker：payload 为成员名；领队/角色构建师由宿主拒绝，失败上抛。 */
function* deleteRosterWorker(
  { payload }: DvaAction<string>,
  { call, put }: EffectCommands,
): Generator {
  yield put({ type: 'setLoading', payload: true });
  try {
    yield call(deleteRosterMember, payload as string);
    yield put({ type: 'setError', payload: null });
  } catch (e) {
    yield put({ type: 'setError', payload: e instanceof Error ? e.message : String(e) });
    // 删除失败要可见：上抛让 dispatch promise reject，组件 catch 提示。
    throw e;
  } finally {
    yield put({ type: 'setLoading', payload: false });
  }
}

/** roster model 类型面：reducers 按 action 精确 payload，effects 数组式 takeLatest。 */
type RosterModel = {
  namespace: 'roster';
  state: RosterState;
  reducers: {
    setList: (state: RosterState, action: DvaAction<RosterMember[]>) => RosterState;
    setLoading: (state: RosterState, action: DvaAction<boolean>) => RosterState;
    setError: (state: RosterState, action: DvaAction<string | null>) => RosterState;
  };
  effects: {
    fetchRoster: TakeLatestEffect<void>;
    saveRoster: TakeLatestEffect<NewMemberInput>;
    deleteRoster: TakeLatestEffect<string>;
  };
};

export const rosterModel: RosterModel = {
  namespace: 'roster',
  state: { list: [], loading: false, error: null },
  reducers: {
    // 整表替换；非数组 payload（畸形 dispatch）保留旧列表，防投毒。
    setList: (state, { payload }) => ({
      ...state,
      list: Array.isArray(payload) ? payload : state.list,
    }),
    setLoading: (state, { payload }) => ({ ...state, loading: payload === true }),
    // 错误槽整体置位：null/缺省即清除。与 activity.setError 的「payload 缺省
    // 沿用当前值」不同——这里没有 last good 部分快照语义，显式 null 就是
    // 清空信号（每次成功 fetch 后清掉上一次失败的痕迹）。
    setError: (state, { payload }) => ({
      ...state,
      error: typeof payload === 'string' ? payload : null,
    }),
  },
  effects: {
    // dva 2 数组式 takeLatest（类型见 TakeLatestEffect；字面量经上下文类型
    // 收窄，不写成共享常量——models/index.ts 与本文件间只允许 type 环，
    // 值回流会有 TDZ 风险）。
    fetchRoster: [fetchRosterWorker, { type: 'takeLatest' }],
    saveRoster: [saveRosterWorker, { type: 'takeLatest' }],
    deleteRoster: [deleteRosterWorker, { type: 'takeLatest' }],
  },
};
