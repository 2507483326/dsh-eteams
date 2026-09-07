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
 * 走 useActivityState（无条件 useSelector，R2-F2：21.5.3 五表面根 Provider
 * 拓扑已补齐，Providerless 回退分支与 rules-of-hooks 豁免随之删除）。
 *
 * @module dsh-eteams/client/monitor
 */
import { useEffect } from 'react';
import { useSelector } from 'react-redux';
import { getApp, type RootState } from '../store/app';

/** Base URL served by the host web surface. */
const STATE_URL = '/eteams-api/state';

/** Live cadence while teams exist (docs/15.6 DoD: ≤1s reflection). */
const POLL_MS = 1000;
/** Probe cadence while no team has been discovered yet. */
const PROBE_MS = 5000;

/** One chain station as rendered by the panel. v7：`member` 是站点原始引用
 * （工号数字串/旧名字串，拼链 POST 回写用它），`memberLabel` 是显示标识
 * （`T{mainTaskId}-ET{xxxx}（名字）`，旧名字站点原样）；旧运行时快照缺省
 * memberLabel——回落 member（原显示口径）。 */
export interface StationView {
  member: string;
  memberLabel?: string;
  stageBrief: string;
  stationStatus: 'done' | 'current' | 'pending';
}

/** Member row of the state snapshot. */
export interface MemberView {
  name: string;
  /** 工号 (docs/21): host 发格式化显示串（`ET-0001` style）；null for legacy. */
  employeeId: string | null;
  role: string;
  status: string;
  /** 模型路线（docs/35 §3#5）：空串 = 会话默认（用户迭代 2026-09-04）。 */
  model: string;
  reasoningEffort: string | null;
  currentTaskId: number | null;
  currentAttemptId: number | null;
  childId: string | null;
  removed: boolean;
  /** Pre-generated avatar pair (docs/14); null for legacy members. */
  avatar: { seed: number; salt: number } | null;
  /**
   * 成员自己的角色手册副本（用户迭代 2026-09 四）：加入团队时从角色库复制，
   * 之后与角色详情各自独立。null/undefined = 旧成员无手册（详情页按结构
   * 字段合成骨架）；旧运行时快照不带这些字段。
   */
  personaMd?: string | null;
  duty?: string | null;
  style?: string | null;
  skills?: string | null;
  rules?: string[] | null;
  executionPrompt?: string | null;
}

/** One attempt summary row (compact; full line via the track route). */
export interface AttemptSummary {
  id: number;
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
  taskId: number;
  subject: string;
  /**
   * 任务角色（docs/26）：'group' = 对话提交的主任务（任务单容器）；'task' =
   * 普通/小任务。旧运行时快照缺省按 'task' 处理。
   */
  kind: string;
  /** 父主任务 id（docs/26 拆解的小任务）；null = 顶层。 */
  parentId: number | null;
  /** 专属任务文件夹（相对工作区）；null = 团队工作目录尚未分配。 */
  folder: string | null;
  /** 任务说明/合同摘要（docs/26 面板编辑弹窗回填）；null = 无。旧运行时缺省 null。 */
  description: string | null;
  /** 任务合同全文（Markdown；十六轮 DA29：原合同四数组合并为一篇 MD）。
   * null = 无。旧运行时快照缺省 null。 */
  contractMd: string | null;
  /** 幂等说明（重复执行的界定）；null = 无。 */
  idempotencyNote: string | null;
  /** 物化阻塞（docs/36 建议 1）：wait + blockedFrom 非空 = 被前置任务阻塞。 */
  blocked: boolean;
  blockedFrom: number | null;
  /** 领队写回的状态说明；null = 无。 */
  statusNote: string | null;
  /** 主会话 ID 快照（task.main_session_id，v5 落列 v6 改名）：建任务时登记的主会话；null/缺省 = 未登记。 */
  sessionId?: string | null;
  status: string;
  assignee: string | null;
  dependencies: number[];
  chain: StationView[];
  chainCursor: number;
  chainLength: number;
  retryCount: number;
  currentAttemptId: number | null;
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
  taskId: number | null;
  text: string;
}

/** The team leader (项目牧羊人) as projected by the host — not a roster member. */
export interface CaptainView {
  name: string;
  /** 工号 (docs/21): host 发格式化显示串（roster 未读兜底 ET-0001）。 */
  employeeId: string;
  role: string;
  duty: string;
  style: string;
  skills: string;
  personaMd: string | null;
  avatar: { seed: number; salt: number };
  /** 模型路线（用户迭代 2026-09-04 恢复领队模型选择）：空串 = 会话默认。 */
  model?: string;
  reasoningEffort?: string | null;
}

/** Full team snapshot served by /state. */
export interface TeamSnapshot {
  teamId: string;
  name: string;
  progress: { completed: number; total: number; cancelled: number; active: number };
  /** 领队已移出团队（用户迭代 2026-09：领队可删除、可经添加成员弹窗加回）。 */
  leaderRemoved: boolean;
  captain: CaptainView;
  members: MemberView[];
  tasks: TaskView[];
  pendingDecisions: {
    id: number;
    taskId: number;
    error: string;
    retryCount: number;
    createdAt: number;
  }[];
  latestEvents: EventView[];
}

/** The store snapshot published to React. */
export interface ActivityState {
  teams: TeamSnapshot[];
  serverTime: number;
  /** 每队成员上限（host maxMembers 配置，用户迭代 2026-09：每队最多 10 人）。 */
  maxMembers: number;
  fetchedAt: number;
  error: string | null;
  /**
   * 乐观路线补丁的 pending 覆盖层（用户迭代 2026-09 模型菜单「选择即变」）。
   * 只由 activity model 维护：patchRoute 写入、set 同值确认后摘除、失败回滚。
   * 轮询消费方不读它——快照叠加在 reducer 里完成。
   */
  pendingRoutes?: Record<string, PendingRouteEntry>;
}

/** 成员模型路线二元组（docs/35 §3#5：provider 随审批重构砍掉，路线=model
 * + effort；model 空串 = 跟随领队会话模型）。 */
export interface RouteTriple {
  model: string;
  reasoningEffort: string | null;
}

/** 乐观路线补丁：定位一队（领队或成员）的一条路线并整体替换（对话
 * choose() 的本地即时性）。v7：成员目标按工号定位（同名成员各归各）。 */
export interface RoutePatch {
  teamId: string;
  target: { kind: 'member'; employeeId: number } | { kind: 'captain' };
  route: RouteTriple;
}

/**
 * 成员工号显示串（'ET-0002'）→ 定位用数字（v7 R3：成员作用域路由与乐观
 * 补丁按号定位，同名成员各归各）。null = 无号（旧快照/异常行，不可定位）。
 */
export function employeeIdNumberOf(employeeId: string | null): number | null {
  if (employeeId === null || !employeeId.startsWith('ET-')) return null;
  const n = Number.parseInt(employeeId.slice(3), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** pending 覆盖层的一条记录（带定位信息，set 到达时可重新解析目标）。 */
export interface PendingRouteEntry {
  teamId: string;
  target: RoutePatch['target'];
  route: RouteTriple;
}

/**
 * React subscription over the polled activity state（S7：快照已迁 dva，
 * 签名与返回类型不变——card/teamsView（原 eteamsView，已拆分至
 * pages/teamsView/）/teamsButton 消费方零改动）。
 *
 * 无条件 useSelector（D19e「组件优先 useSelector」）。前提——祖先树里有
 * react-redux Provider——由 21.5.3 表面拓扑保证：五个表面根（ETeamsView /
 * TeamsButton / ETeamsCard / EteamBuildCard / teamsPanel）各自根部包
 * `<Provider store={getApp().store}>`（单例 store，多 Provider 同 store 无害；
 * portal 渲染的 TeamsPopup 仍是 TeamsButton 的 React 树子节点，上下文穿透）。
 * R1-F2：此前的 useContext 条件分支、Providerless 回退（useSyncExternalStore
 * 直连单例 store）与两处 react-hooks/rules-of-hooks 豁免随拓扑落地一并删除。
 */
export function useActivityState(): ActivityState {
  return useSelector((s: RootState) => s.activity);
}

async function fetchState(): Promise<void> {
  const { store } = getApp();
  try {
    const res = await fetch(STATE_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // docs/27：host 快照 teamId 是库内整数 id；客户端口径 teamId 一律 string
    // （路由段天然字符串，host selectTeamRow 兼容整数串与团队名）——此处归一。
    const body = (await res.json()) as {
      teams?: (Omit<TeamSnapshot, 'teamId'> & { teamId: number })[];
      maxMembers?: number;
      serverTime?: number;
    };
    const teams = (body.teams ?? []).map((t) => ({ ...t, teamId: String(t.teamId) }));
    store.dispatch({
      type: 'activity/set',
      payload: {
        teams,
        maxMembers:
          typeof body.maxMembers === 'number' && body.maxMembers > 0 ? body.maxMembers : 10,
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

let controller: {
  stop: () => void;
  tick: () => Promise<void>;
  refresh: () => Promise<void>;
} | null = null;
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
      // 单飞闸：tick/refresh 共用——在途 fetch 未完成时丢弃后续触发（防
      // visibilitychange 立即刷新与常规 tick 并行派出第二条永久轮询链）。
      let inFlight = false;
      const runOnce = async (): Promise<void> => {
        if (inFlight || cancelled) return;
        inFlight = true;
        try {
          await fetchState();
        } finally {
          inFlight = false;
        }
      };
      const tick = async (): Promise<void> => {
        if (cancelled) return;
        await runOnce();
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
        // 乐观补丁 POST 成功后的快速确认（不进入轮询节拍链）。
        refresh: runOnce,
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

/**
 * 乐观路线补丁（用户迭代 2026-09「选择即变」）：把成员模型路线即时写进
 * 本地快照 + 记 pending 覆盖层——选择不等 POST + 轮询（对话 choose() 的本地
 * 即时性同款；路线只对成员存在，领队默认模型已随 docs/27 取消）。POST 失败
 * 由调用方 revertRoutePatch 回滚。
 */
export function applyRoutePatch(patch: RoutePatch): void {
  getApp().store.dispatch({ type: 'activity/patchRoute', payload: patch });
}

/** 乐观补丁回滚（POST 失败）：摘 pending，路线恢复为改动前的值。 */
export function revertRoutePatch(patch: RoutePatch, previous: RouteTriple): void {
  getApp().store.dispatch({ type: 'activity/revertRoute', payload: { patch, previous } });
}

/** 立即拉一次快照（乐观补丁 POST 成功后调用，服务端真相尽快落地确认）。 */
export function refreshActivitySoon(): void {
  void controller?.refresh();
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
