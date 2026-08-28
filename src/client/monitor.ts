/**
 * Client-side activity monitor (docs/12.4): a single polling loop over the
 * host `/plugins/dsh-eteams/state` route feeding a `useSyncExternalStore`
 * snapshot store. Cadence: 1s while any team exists, 5s probe when none
 * (keeps a cardless session able to discover a team created later), paused
 * while the document is hidden (docs/13.7).
 *
 * @module dsh-eteams/client/monitor
 */
import { useEffect, useSyncExternalStore } from 'react';

/** Base URL served by the host web surface. */
export const STATE_URL = '/plugins/dsh-eteams/state';

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

const EMPTY: ActivityState = {
  teams: [],
  archivedTeams: [],
  serverTime: 0,
  fetchedAt: 0,
  error: null,
};

let state: ActivityState = EMPTY;
const listeners = new Set<() => void>();

function publish(next: ActivityState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React subscription over the polled activity state. */
export function useActivityState(): ActivityState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => EMPTY,
  );
}

async function fetchState(): Promise<void> {
  try {
    const res = await fetch(STATE_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      teams?: TeamSnapshot[];
      archivedTeams?: ActivityState['archivedTeams'];
      serverTime?: number;
    };
    publish({
      teams: body.teams ?? [],
      archivedTeams: body.archivedTeams ?? [],
      serverTime: body.serverTime ?? Date.now(),
      fetchedAt: Date.now(),
      error: null,
    });
  } catch (error) {
    // Keep the last good snapshot; surface the failure for the panel footer.
    publish({ ...state, fetchedAt: Date.now(), error: String(error) });
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
        return state.teams.length > 0 ? POLL_MS : PROBE_MS;
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
