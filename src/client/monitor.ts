/**
 * Client-side activity monitor (docs/12.4): a single polling loop over the
 * host `/eteams-api/state` route feeding the dva `activity` model
 * (docs/21-client-ui-stack.md S7 / D19e). Cadence: 1s while any team exists,
 * 5s probe when none (keeps a cardless session able to discover a team
 * created later), paused while the document is hidden (docs/13.7).
 *
 * S7 快照事实源在 store/models/activity：fetch 成功 → `activity/set`（整包
 * 替换），失败 → `activity/setError`（reducer 保留 last good 快照，只更新
 * fetchedAt/error）。本模块不再持有模块级 state/listeners——React 订阅统一
 * 走 useActivityState（优先 useSelector；Providerless 表面回退为直连同一
 * 单例 store 的 useSyncExternalStore 订阅，读的是同一份 dva state）。
 *
 * @module dsh-eteams/client/monitor
 */
import { useContext, useEffect, useSyncExternalStore } from 'react';
import { ReactReduxContext, useSelector } from 'react-redux';
import { getApp, type RootState } from './store/app';

/** Base URL served by the host web surface. */
export const STATE_URL = '/eteams-api/state';

/** Live cadence while teams exist (docs/15.6 DoD: ≤1s reflection). */
const POLL_MS = 1000;
/** Probe cadence while no team has been discovered yet. */
const PROBE_MS = 5000;

/** One chain station as rendered by the panel. */
export interface StationView {
  member: string;
  stageBrief: string;
  stationStatus: 'done' | 'current' | 'pending';
}

/** Member row of the state snapshot. */
export interface MemberView {
  name: string;
  role: string;
  status: string;
  provider: string;
  model: string;
  reasoningEffort: string | null;
  currentTaskId: string | null;
  currentAttemptId: string | null;
  childId: string | null;
  removed: boolean;
  /** Pre-generated avatar pair (docs/14); null for legacy members. */
  avatar: { seed: number; salt: number } | null;
}

/** One attempt summary row (compact; full line via the track route). */
export interface AttemptSummary {
  id: string;
  member: string;
  kind: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  lastEventText: string | null;
  eventCount: number;
}

/** Task row of the state snapshot. */
export interface TaskView {
  taskId: string;
  subject: string;
  status: string;
  assignee: string | null;
  dependencies: string[];
  chain: StationView[];
  chainCursor: number;
  chainLength: number;
  retryCount: number;
  currentAttemptId: string | null;
  outcome: string | null;
  attemptSummary: AttemptSummary[];
  updatedAt: number;
}

/** Event row (compact, server-summarized). */
export interface EventView {
  seq: number;
  at: number;
  actor: string;
  actorKind: string;
  type: string;
  taskId: string | null;
  text: string;
}

/** The team leader (项目牧羊人) as projected by the host — not a roster member. */
export interface CaptainView {
  name: string;
  role: string;
  duty: string;
  style: string;
  skills: string;
  personaMd: string | null;
  avatar: { seed: number; salt: number };
}

/** Full team snapshot served by /state. */
export interface TeamSnapshot {
  teamId: string;
  name: string;
  goal: string;
  phase: string;
  planReviewState: string | null;
  captainSessionId: string;
  version: number;
  workDir: string | null;
  progress: { completed: number; total: number; cancelled: number; active: number };
  captain: CaptainView;
  members: MemberView[];
  tasks: TaskView[];
  pendingDecisions: {
    id: string;
    taskId: string;
    error: string;
    retryCount: number;
    createdAt: number;
  }[];
  latestEvents: EventView[];
}

/** The store snapshot published to React. */
export interface ActivityState {
  teams: TeamSnapshot[];
  archivedTeams: {
    teamId: string;
    name: string;
    goal: string;
    phase: string;
    workDir: string | null;
  }[];
  serverTime: number;
  fetchedAt: number;
  error: string | null;
}

/**
 * React subscription over the polled activity state（S7：快照已迁 dva，
 * 签名与返回类型不变——card/eteamsView/teamsButton 消费方零改动）。
 *
 * 优先 useSelector（D19e「组件优先 useSelector」），前提是祖先树里有
 * react-redux Provider。当前三消费方都不满足：ETeamsView 的 Provider 包在
 * 自己 JSX 内部（其自身 hook 调用位于 Provider 之外），ETeamsCard /
 * TeamsButton 根部尚未包 Provider（21.5.3 由各自表面步骤落地）——故回退为
 * 直连单例 store 的 useSyncExternalStore 订阅。两条路径读同一份 dva state
 * （同一 store、同一 activity 切片），重渲染粒度一致（切片引用变化才重
 * 渲染）。Provider 是否在祖先树由表面根决定、组件实例一生不变，hook 调用
 * 序恒定；待 Provider 补齐后回退分支与本 disable 可一并删除。
 */
export function useActivityState(): ActivityState {
  if (useContext(ReactReduxContext) !== null) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Provider 是否在祖先树对每个组件实例恒定（见上），调用序稳定；待 21.5.3 Provider 补齐后本 disable 随回退分支一并删除
    return useSelector((s: RootState) => s.activity);
  }
  const store = getApp().store;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- 同上：本分支只在 Providerless 表面（card/teamsButton/ETeamsView 自身）渲染时触达，实例一生恒定
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().activity,
    () => store.getState().activity,
  );
}

async function fetchState(): Promise<void> {
  const { store } = getApp();
  try {
    const res = await fetch(STATE_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      teams?: TeamSnapshot[];
      archivedTeams?: ActivityState['archivedTeams'];
      serverTime?: number;
    };
    store.dispatch({
      type: 'activity/set',
      payload: {
        teams: body.teams ?? [],
        archivedTeams: body.archivedTeams ?? [],
        serverTime: body.serverTime ?? Date.now(),
        fetchedAt: Date.now(),
        error: null,
      },
    });
  } catch (error) {
    // Keep the last good snapshot; surface the failure for the panel footer.
    // S7：只 dispatch 失败面（fetchedAt/error）——teams 等旧值由 setError
    // reducer 原样保留（对齐迁移前 publish({ ...state, fetchedAt, error })）。
    store.dispatch({
      type: 'activity/setError',
      payload: { fetchedAt: Date.now(), error: String(error) },
    });
  }
}

let controller: { stop: () => void; tick: () => Promise<void> } | null = null;
let controllerUsers = 0;

/**
 * Reference-counted monitor lifetime: the panel (and the conversation card)
 * mount/unmount freely; the loop runs while at least one consumer exists.
 */
export function useActivityMonitor(): ActivityState {
  const snapshot = useActivityState();
  useEffect(() => {
    controllerUsers += 1;
    if (controller === null) {
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = async (): Promise<void> => {
        if (cancelled) return;
        await fetchState();
        if (cancelled) return;
        schedule();
      };
      const delay = (): number => {
        if (typeof document !== 'undefined' && document.hidden) return PROBE_MS * 4;
        // S7：模块级 state 已删——从 dva store 读活跃团队数，节拍语义不变。
        return getApp().store.getState().activity.teams.length > 0 ? POLL_MS : PROBE_MS;
      };
      const schedule = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          void tick();
        }, delay());
      };
      const onVisible = (): void => {
        if (!document.hidden) void tick(); // immediate refresh on reveal (docs/13.7)
      };
      controller = {
        stop: () => {
          cancelled = true;
          if (timer !== undefined) clearTimeout(timer);
          if (typeof document !== 'undefined')
            document.removeEventListener('visibilitychange', onVisible);
        },
        tick,
      };
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
      void tick();
    }
    return () => {
      controllerUsers -= 1;
      if (controllerUsers <= 0 && controller !== null) {
        controller.stop();
        controller = null;
        controllerUsers = 0;
      }
    };
  }, []);
  return snapshot;
}

/** Relative time formatting shared by panel views (docs/13.6). */
export function relativeTime(at: number, now: number): string {
  if (!at) return '';
  const diff = now - at;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
