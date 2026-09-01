/**
 * dva bootstrap 单测（docs/21-client-ui-stack.md S6）：getApp() 单例、
 * store 拓扑（@@dva 内部键 + activity/ui 模型键）与 activity/set reducer
 * 生效。S7 起轮询快照迁入 store，本文件是后续迁移的行为契约基线。
 */
import { describe, expect, it } from 'vitest';
import type { ActivityState } from '../src/client/monitor';
import { getApp } from '../src/client/store/app';

describe('dvaApp bootstrap（S6）', () => {
  it('getApp() 单例：两次调用返回同一 store', () => {
    const first = getApp();
    const second = getApp();
    expect(second.store).toBe(first.store);
  });

  it('store 拓扑：state 含 @@dva 内部键与 activity/ui 模型键', () => {
    const { store } = getApp();
    const state = store.getState();
    expect(state).toHaveProperty('@@dva');
    expect(state.activity.teams).toEqual([]);
    expect(state.ui.activeNav).toBe('board');
    expect(state.ui.selectedTeamId).toBeNull();
  });

  it('activity/set：dispatch 完整快照后 state 生效', () => {
    const { store } = getApp();
    // 形状对齐 monitor.ts 的 TeamSnapshot/ActivityState（S7 前的契约快照）。
    const snapshot: ActivityState = {
      teams: [
        {
          teamId: 'team-1',
          name: '验证团队',
          goal: '验证 activity/set 生效',
          phase: 'running',
          planReviewState: null,
          captainSessionId: 'session-1',
          version: 7,
          workDir: null,
          progress: { completed: 2, total: 5, cancelled: 0, active: 1 },
          captain: {
            name: '项目牧羊人',
            role: 'captain',
            duty: '拆解',
            style: '直接',
            skills: '规划',
            personaMd: null,
            avatar: { seed: 1, salt: 2 },
          },
          members: [],
          tasks: [],
          pendingDecisions: [],
          latestEvents: [],
        },
      ],
      archivedTeams: [],
      serverTime: 1_700_000_000_000,
      fetchedAt: 1_700_000_000_000,
      error: null,
    };
    store.dispatch({ type: 'activity/set', payload: snapshot });
    expect(store.getState().activity.teams).toHaveLength(1);
    expect(store.getState().activity.teams[0]?.teamId).toBe('team-1');
    expect(store.getState().activity.fetchedAt).toBe(1_700_000_000_000);
  });
});
