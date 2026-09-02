/**
 * activity model（docs/21-client-ui-stack.md S7 / D19e）：namespace
 * 'activity'，轮询快照的事实源。monitor.ts 轮询 fetch 成功后 dispatch
 * `activity/set`（整包替换），失败后 dispatch `activity/setError`（只携带
 * 失败面，last good 快照由 reducer 保留）。
 *
 * @module dsh-eteams/client/store/models/activity
 */
import type { DvaModel } from 'dva-core';
import type { ActivityState } from '../../monitor';

/** 空快照：形状对齐迁移前 monitor.ts 的 EMPTY，store 初始态即此形状。 */
const EMPTY: ActivityState = {
  teams: [],
  archivedTeams: [],
  serverTime: 0,
  fetchedAt: 0,
  error: null,
  // 每队成员上限（用户迭代 2026-09）：缺省 10，/state 首包即覆盖。
  maxMembers: 10,
};

export const activityModel: DvaModel<ActivityState> = {
  namespace: 'activity',
  state: EMPTY,
  reducers: {
    // 整包替换——完整快照由 monitor.ts 轮询 fetch 成功路径 dispatch 保证。
    set: (_state, { payload }) => payload as ActivityState,
    // last good 快照语义（对齐迁移前 publish({ ...state, fetchedAt, error })）：
    // 只更新 fetchedAt/error，teams/archivedTeams/serverTime 等旧值原样保留。
    // payload 缺键/缺省时沿用当前值（dva action 运行时不校验 payload 形状）。
    setError: (state, action) => {
      const payload = (action.payload ?? {}) as Partial<ActivityState>;
      return {
        ...state,
        fetchedAt: payload.fetchedAt ?? state.fetchedAt,
        error: payload.error ?? state.error,
      };
    },
  },
};
