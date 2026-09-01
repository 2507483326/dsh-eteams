/**
 * activity model 骨架（docs/21-client-ui-stack.md S6）：namespace
 * 'activity'，state 沿用 monitor.ts 的 EMPTY 快照形状（import type——
 * S7 才把 monitor 轮询迁进 store，届时 fetch 成功后 dispatch
 * activity/set，本文件成为快照事实源）。
 *
 * @module dsh-eteams/client/store/models/activity
 */
import type { DvaModel } from 'dva-core';
import type { ActivityState } from '../../monitor';

/** 空快照：形状对齐 monitor.ts 的 EMPTY（S7 迁移后以本 model 为准）。 */
const EMPTY: ActivityState = {
  teams: [],
  archivedTeams: [],
  serverTime: 0,
  fetchedAt: 0,
  error: null,
};

export const activityModel: DvaModel<ActivityState> = {
  namespace: 'activity',
  state: EMPTY,
  reducers: {
    // 占位（S6）：整包替换——快照由调用方保证完整（S7 轮询 fetch 成功后 dispatch）。
    set: (_state, { payload }) => payload as ActivityState,
  },
};
