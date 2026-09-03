/**
 * activity model reducers 单测（docs/21-client-ui-stack.md S7）：set 整包
 * 替换；setError 保留 last good 快照（只更新 fetchedAt/error，teams 等旧值
 * 原样保留——对齐迁移前 monitor.ts 失败路径的 publish({...state, ...})）。
 * 另含一条 store 级 dispatch 接线验证：monitor.ts 轮询实际走的就是
 * `activity/set` → `activity/setError` 两条 action。
 *
 * 用户迭代 2026-09（模型菜单「选择即变」）：patchRoute 乐观补丁、revertRoute
 * 回滚、set 到达时的 pending 结算（同值确认摘除 / 在途旧包继续覆盖 / 目标
 * 消失摘除）。
 */
import { describe, expect, it } from 'vitest';
import type { DvaAction } from 'dva-core';
import type { ActivityState, RoutePatch, RouteTriple, TeamSnapshot } from '../src/client/monitor';
import { getApp } from '../src/client/store/app';
import { activityModel } from '../src/client/store/models/activity';

/** dva action 构造：payload 运行时形状由调用方保证（dva 动态分发）。 */
const action = (type: string, payload: unknown): DvaAction<ActivityState> =>
  ({
    type,
    payload,
  }) as DvaAction<ActivityState>;

const MEMBER_BASE = {
  name: '成员甲',
  employeeId: 'ET-0002',
  role: '开发',
  status: 'idle',
  currentTaskId: null,
  currentAttemptId: null,
  childId: null,
  removed: false,
  avatar: { seed: 3, salt: 4 },
};

const TEAM: TeamSnapshot = {
  teamId: 'team-1',
  name: '验证团队',
  goal: '验证 activity reducers',
  phase: 'running',
  planReviewState: null,
  captainSessionId: 'session-1',
  version: 7,
  workDir: null,
  leaderRemoved: false,
  progress: { completed: 2, total: 5, cancelled: 0, active: 1 },
  captain: {
    name: '项目牧羊人',
    employeeId: 'ET-0001',
    role: 'captain',
    duty: '拆解',
    style: '直接',
    skills: '规划',
    personaMd: null,
    avatar: { seed: 1, salt: 2 },
    provider: 'inherit',
    model: 'inherit',
    reasoningEffort: null,
  },
  members: [{ ...MEMBER_BASE, provider: 'inherit', model: 'inherit', reasoningEffort: null }],
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

/** 成员路线三元组变体的快照（模拟服务端在途旧包 / 确认新包）。 */
const snapshotWithMemberRoute = (route: RouteTriple): ActivityState => ({
  ...GOOD,
  fetchedAt: GOOD.fetchedAt + 1,
  teams: [{ ...TEAM, members: [{ ...TEAM.members[0]!, ...route }] }],
});

const MEMBER_OLD: RouteTriple = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  reasoningEffort: null,
};
const MEMBER_NEW: RouteTriple = {
  provider: 'deepseek',
  model: 'deepseek-reasoner',
  reasoningEffort: 'high',
};
const PATCH_MEMBER: RoutePatch = {
  teamId: 'team-1',
  target: { kind: 'member', name: '成员甲' },
  route: MEMBER_NEW,
};
const PATCH_CAPTAIN: RoutePatch = {
  teamId: 'team-1',
  target: { kind: 'captain' },
  route: { provider: 'openai', model: 'gpt-test', reasoningEffort: null },
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

describe('activity reducers（乐观路线补丁，用户迭代 2026-09）', () => {
  it('set：无 pending 时纯透传（不挂空 pendingRoutes 键）', () => {
    const next = snapshotWithMemberRoute(MEMBER_OLD);
    expect(activityModel.reducers?.set?.(GOOD, action('activity/set', next))).toBe(next);
  });

  it('patchRoute（成员）：快照即时改写 + pending 记录', () => {
    const state = snapshotWithMemberRoute(MEMBER_OLD);
    const result = activityModel.reducers?.patchRoute?.(
      state,
      action('activity/patchRoute', PATCH_MEMBER),
    );
    const member = result?.teams[0]?.members[0];
    expect(member?.provider).toBe(MEMBER_NEW.provider);
    expect(member?.model).toBe(MEMBER_NEW.model);
    expect(member?.reasoningEffort).toBe(MEMBER_NEW.reasoningEffort);
    expect(result?.pendingRoutes?.['team-1|member|成员甲']).toEqual({
      teamId: 'team-1',
      target: { kind: 'member', name: '成员甲' },
      route: MEMBER_NEW,
    });
    // 不可变写：沿途浅拷贝，其余子树原引用保留。
    expect(result?.archivedTeams).toBe(state.archivedTeams);
    expect(result?.teams[0]?.captain).toBe(state.teams[0]?.captain);
  });

  it('patchRoute（领队）：captain 路线即时改写 + pending 记录', () => {
    const state = snapshotWithMemberRoute(MEMBER_OLD);
    const result = activityModel.reducers?.patchRoute?.(
      state,
      action('activity/patchRoute', PATCH_CAPTAIN),
    );
    expect(result?.teams[0]?.captain.provider).toBe('openai');
    expect(result?.teams[0]?.captain.model).toBe('gpt-test');
    expect(result?.pendingRoutes?.['team-1|captain']).toEqual({
      teamId: 'team-1',
      target: { kind: 'captain' },
      route: PATCH_CAPTAIN.route,
    });
  });

  it('patchRoute：团队/成员不在（已删等）→ 原样返回', () => {
    const state = snapshotWithMemberRoute(MEMBER_OLD);
    const ghostTeam = action('activity/patchRoute', {
      ...PATCH_MEMBER,
      teamId: 'team-x',
    });
    expect(activityModel.reducers?.patchRoute?.(state, ghostTeam)).toBe(state);
    const ghostMember = action('activity/patchRoute', {
      ...PATCH_MEMBER,
      target: { kind: 'member', name: '不存在' },
    });
    expect(activityModel.reducers?.patchRoute?.(state, ghostMember)).toBe(state);
    const malformed = action('activity/patchRoute', null);
    expect(activityModel.reducers?.patchRoute?.(state, malformed)).toBe(state);
  });

  it('set：在途旧包（路线仍是旧值）→ pending 继续覆盖，不闪回', () => {
    const state = snapshotWithMemberRoute(MEMBER_OLD);
    const patched = activityModel.reducers?.patchRoute?.(
      state,
      action('activity/patchRoute', PATCH_MEMBER),
    );
    // 服务端旧包在途：POST 前发出的轮询快照，路线还是旧值。
    const stale = snapshotWithMemberRoute(MEMBER_OLD);
    const settled = activityModel.reducers?.set?.(patched!, action('activity/set', stale));
    expect(settled?.teams[0]?.members[0]?.model).toBe(MEMBER_NEW.model);
    expect(settled?.pendingRoutes?.['team-1|member|成员甲']).toEqual({
      teamId: 'team-1',
      target: { kind: 'member', name: '成员甲' },
      route: MEMBER_NEW,
    });
  });

  it('set：服务端确认同值 → pending 摘除', () => {
    const state = snapshotWithMemberRoute(MEMBER_OLD);
    const patched = activityModel.reducers?.patchRoute?.(
      state,
      action('activity/patchRoute', PATCH_MEMBER),
    );
    const confirmed = snapshotWithMemberRoute(MEMBER_NEW);
    const settled = activityModel.reducers?.set?.(patched!, action('activity/set', confirmed));
    expect(settled?.teams[0]?.members[0]?.model).toBe(MEMBER_NEW.model);
    expect(settled?.pendingRoutes).toEqual({});
  });

  it('set：目标已消失（成员已删等）→ pending 摘除', () => {
    const state = snapshotWithMemberRoute(MEMBER_OLD);
    const patched = activityModel.reducers?.patchRoute?.(
      state,
      action('activity/patchRoute', PATCH_MEMBER),
    );
    const gone: ActivityState = {
      ...GOOD,
      fetchedAt: GOOD.fetchedAt + 2,
      teams: [{ ...TEAM, members: [] }],
    };
    const settled = activityModel.reducers?.set?.(patched!, action('activity/set', gone));
    expect(settled?.teams[0]?.members).toEqual([]);
    expect(settled?.pendingRoutes).toEqual({});
  });

  it('revertRoute：pending 摘除 + 路线恢复为改动前的值', () => {
    const state = snapshotWithMemberRoute(MEMBER_OLD);
    const patched = activityModel.reducers?.patchRoute?.(
      state,
      action('activity/patchRoute', PATCH_MEMBER),
    );
    const reverted = activityModel.reducers?.revertRoute?.(
      patched!,
      action('activity/revertRoute', { patch: PATCH_MEMBER, previous: MEMBER_OLD }),
    );
    expect(reverted?.teams[0]?.members[0]?.model).toBe(MEMBER_OLD.model);
    expect(reverted?.pendingRoutes).toEqual({});
    // 恢复同样不可变：其余子树原引用保留。
    expect(reverted?.archivedTeams).toBe(state.archivedTeams);
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

  it('dispatch patchRoute → set（旧包）→ set（新包）：单例 store 全程不闪回', () => {
    const { store } = getApp();
    store.dispatch(action('activity/set', snapshotWithMemberRoute(MEMBER_OLD)));
    store.dispatch(action('activity/patchRoute', PATCH_MEMBER));
    // 在途旧包先到：路线保持新值。
    store.dispatch(action('activity/set', snapshotWithMemberRoute(MEMBER_OLD)));
    expect(store.getState().activity.teams[0]?.members[0]?.model).toBe(MEMBER_NEW.model);
    // 服务端确认包到达：pending 摘除。
    store.dispatch(action('activity/set', snapshotWithMemberRoute(MEMBER_NEW)));
    expect(store.getState().activity.teams[0]?.members[0]?.model).toBe(MEMBER_NEW.model);
    expect(store.getState().activity.pendingRoutes).toEqual({});
    // 回滚路径：路线恢复 + pending 清空。
    store.dispatch(action('activity/patchRoute', PATCH_CAPTAIN));
    store.dispatch(
      action('activity/revertRoute', {
        patch: PATCH_CAPTAIN,
        previous: { provider: 'inherit', model: 'inherit', reasoningEffort: null },
      }),
    );
    expect(store.getState().activity.teams[0]?.captain.model).toBe('inherit');
    expect(store.getState().activity.pendingRoutes).toEqual({});
  });
});
