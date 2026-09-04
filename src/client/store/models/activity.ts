/**
 * activity model（docs/21-client-ui-stack.md S7 / D19e）：namespace
 * 'activity'，轮询快照的事实源。monitor.ts 轮询 fetch 成功后 dispatch
 * `activity/set`（整包替换），失败后 dispatch `activity/setError`（只携带
 * 失败面，last good 快照由 reducer 保留）。
 *
 * @module dsh-eteams/client/store/models/activity
 */
import type { DvaModel } from 'dva-core';
import type { ActivityState, PendingRouteEntry, RoutePatch, RouteTriple } from '../../lib/monitor';

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

const routeKey = (teamId: string, target: RoutePatch['target']): string =>
  target.kind === 'captain' ? `${teamId}|captain` : `${teamId}|member|${target.name}`;

const sameRoute = (a: RouteTriple, b: RouteTriple): boolean =>
  a.provider === b.provider &&
  a.model === b.model &&
  (a.reasoningEffort ?? null) === (b.reasoningEffort ?? null);

/** 读快照里目标路线；团队/成员不在（已删等）返回 null。 */
const readRoute = (
  snapshot: ActivityState,
  teamId: string,
  target: RoutePatch['target'],
): RouteTriple | null => {
  const team = snapshot.teams.find((t) => t.teamId === teamId);
  if (team === undefined) return null;
  if (target.kind === 'captain') {
    return {
      provider: team.captain.provider,
      model: team.captain.model,
      reasoningEffort: team.captain.reasoningEffort,
    };
  }
  const member = team.members.find((m) => m.name === target.name);
  if (member === undefined) return null;
  return {
    provider: member.provider,
    model: member.model,
    reasoningEffort: member.reasoningEffort,
  };
};

/** 不可变地写目标路线（沿途浅拷贝）；目标不在返回 null=无从写。 */
const writeRoute = (
  snapshot: ActivityState,
  teamId: string,
  target: RoutePatch['target'],
  route: RouteTriple,
): ActivityState | null => {
  const at = snapshot.teams.findIndex((t) => t.teamId === teamId);
  const team = snapshot.teams[at];
  if (at === -1 || team === undefined) return null;
  if (target.kind === 'captain') {
    const teams = [...snapshot.teams];
    teams[at] = { ...team, captain: { ...team.captain, ...route } };
    return { ...snapshot, teams };
  }
  if (!team.members.some((m) => m.name === target.name)) return null;
  const teams = [...snapshot.teams];
  teams[at] = {
    ...team,
    members: team.members.map((m) => (m.name === target.name ? { ...m, ...route } : m)),
  };
  return { ...snapshot, teams };
};

/**
 * set 到达时的 pending 结算：目标已消失 → 摘除；快照值与 pending 同值（服务
 * 端已确认）→ 摘除；异值（在途旧包）→ 继续覆盖，避免已选项闪回旧值。
 */
const settlePending = (
  incoming: ActivityState,
  pending: Record<string, PendingRouteEntry>,
): ActivityState => {
  // 无 pending → 纯透传（不往每个快照上挂空 pendingRoutes 键）。
  if (Object.keys(pending).length === 0) return incoming;
  const kept: Record<string, PendingRouteEntry> = {};
  let out = incoming;
  for (const [key, entry] of Object.entries(pending)) {
    const current = readRoute(out, entry.teamId, entry.target);
    if (current !== null && !sameRoute(current, entry.route)) {
      kept[key] = entry;
      const written = writeRoute(out, entry.teamId, entry.target, entry.route);
      if (written !== null) out = written;
    }
  }
  return { ...out, pendingRoutes: kept };
};

export const activityModel: DvaModel<ActivityState> = {
  namespace: 'activity',
  state: EMPTY,
  reducers: {
    // 整包替换 + pending 结算（乐观补丁未被服务端确认的继续覆盖，见上）。
    set: (state, { payload }) => settlePending(payload as ActivityState, state.pendingRoutes ?? {}),
    // 乐观路线补丁（用户迭代 2026-09「选择即变」）：本地快照即时改写 +
    // 记入 pending；下一次 set 同值时自动摘除。目标不在（团队刚删等）则忽略。
    patchRoute: (state, action) => {
      const patch = (action.payload ?? {}) as RoutePatch | null;
      if (patch === null || typeof patch.teamId !== 'string') return state;
      const written = writeRoute(state, patch.teamId, patch.target, patch.route);
      if (written === null) return state;
      const key = routeKey(patch.teamId, patch.target);
      return {
        ...written,
        pendingRoutes: {
          ...(state.pendingRoutes ?? {}),
          [key]: { teamId: patch.teamId, target: patch.target, route: patch.route },
        },
      };
    },
    // 乐观补丁回滚（POST 失败）：摘 pending 并把路线恢复为改动前的值，
    // 面板就地回落到旧路线（错误信息由调用方展示）。
    revertRoute: (state, action) => {
      const { patch, previous } = (action.payload ?? {}) as {
        patch?: RoutePatch;
        previous?: RouteTriple;
      };
      if (patch === undefined || previous === undefined) return state;
      const key = routeKey(patch.teamId, patch.target);
      const pending = { ...(state.pendingRoutes ?? {}) };
      delete pending[key];
      const restored = writeRoute(state, patch.teamId, patch.target, previous);
      return { ...(restored ?? state), pendingRoutes: pending };
    },
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
