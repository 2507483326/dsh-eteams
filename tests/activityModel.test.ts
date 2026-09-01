/**
 * activity model reducers 单测（docs/21-client-ui-stack.md S7）：set 整包
 * 替换；setError 保留 last good 快照（只更新 fetchedAt/error，teams 等旧值
 * 原样保留——对齐迁移前 monitor.ts 失败路径的 publish({...state, ...})）。
 * 另含一条 store 级 dispatch 接线验证：monitor.ts 轮询实际走的就是
 * `activity/set` → `activity/setError` 两条 action。
 */
import { describe, expect, it } from 'vitest';
import type { DvaAction } from 'dva-core';
import type { ActivityState, TeamSnapshot } from '../src/client/monitor';
import { getApp } from '../src/client/store/app';
import { activityModel } from '../src/client/store/models/activity';

/** dva action 构造：payload 运行时形状由调用方保证（dva 动态分发）。 */
const action = (type: string, payload: unknown): DvaAction<ActivityState> =>
  ({
    type,
    payload,
  }) as DvaAction<ActivityState>;

const TEAM: TeamSnapshot = {
  teamId: 'team-1',
  name: '验证团队',
  goal: '验证 activity reducers',
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
};

/** 一次成功轮询后的 last good 快照。 */
const GOOD: ActivityState = {
  teams: [TEAM],
  archivedTeams: [
    { teamId: 'team-0', name: '旧团队', goal: '已归档', phase: 'archived', workDir: null },
  ],
  serverTime: 1_700_000_000_000,
  fetchedAt: 1_700_000_000_000,
  error: null,
};

describe('activity reducers（S7）', () => {
  it('set：整包替换快照', () => {
    const next: ActivityState = {
      teams: [],
      archivedTeams: [],
      serverTime: 5,
      fetchedAt: 6,
      error: null,
    };
    const result = activityModel.reducers?.set?.(GOOD, action('activity/set', next));
    expect(result).toEqual(next);
    expect(result?.teams).toEqual([]); // 不保留旧快照的 teams
  });

  it('setError：保留 last good 快照，只更新 fetchedAt/error', () => {
    const result = activityModel.reducers?.setError?.(
      GOOD,
      action('activity/setError', { fetchedAt: 1_700_000_000_500, error: 'HTTP 500' }),
    );
    expect(result?.fetchedAt).toBe(1_700_000_000_500);
    expect(result?.error).toBe('HTTP 500');
    // last good 快照语义：旧值原引用保留，不被清空。
    expect(result?.teams).toBe(GOOD.teams);
    expect(result?.teams).toHaveLength(1);
    expect(result?.archivedTeams).toBe(GOOD.archivedTeams);
    expect(result?.serverTime).toBe(GOOD.serverTime);
  });

  it('setError：payload 缺省时沿用当前值（防御面，dva 不校验 payload）', () => {
    const result = activityModel.reducers?.setError?.(GOOD, action('activity/setError', undefined));
    expect(result?.fetchedAt).toBe(GOOD.fetchedAt);
    expect(result?.error).toBe(GOOD.error);
    expect(result?.teams).toBe(GOOD.teams);
  });
});

describe('activity model store 接线（S7）', () => {
  it('dispatch set → setError：单例 store 按 reducer 语义流转', () => {
    const { store } = getApp();
    store.dispatch(action('activity/set', GOOD));
    store.dispatch(
      action('activity/setError', { fetchedAt: 1_700_000_000_900, error: 'HTTP 502' }),
    );
    const activity = store.getState().activity;
    expect(activity.teams).toHaveLength(1);
    expect(activity.teams[0]?.teamId).toBe('team-1');
    expect(activity.fetchedAt).toBe(1_700_000_000_900);
    expect(activity.error).toBe('HTTP 502');
    expect(activity.archivedTeams).toEqual(GOOD.archivedTeams);
    expect(activity.serverTime).toBe(1_700_000_000_000);
  });
});
