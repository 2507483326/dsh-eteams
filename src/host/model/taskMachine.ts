/**
 * Task state machine (docs/06.2) — pure functions, no I/O, no cordis.
 * Illegal transitions throw `TransitionError`; the tool layer converts them
 * into actionable Chinese error text.
 *
 * @module dsh-eteams/model/taskMachine
 */
import type { ChainStation, TaskRecord, TaskStatus } from './types.js';

/** Thrown for any illegal status move; carries an actionable hint. */
export class TransitionError extends Error {
  readonly hint: string;
  constructor(from: TaskStatus, to: TaskStatus, hint?: string) {
    super(`illegal task transition ${from} -> ${to}${hint ? `: ${hint}` : ''}`);
    this.name = 'TransitionError';
    this.hint = hint ?? '检查任务当前状态后再操作';
  }
}

/** Allowed outgoing edges per status (docs/06.2). */
const EDGES: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ['ready', 'cancelled'],
  ready: ['assigned', 'blocked', 'cancelled'],
  assigned: ['in_progress', 'ready', 'assigned', 'blocked', 'paused', 'cancelled'],
  in_progress: [
    'retrying',
    'completed',
    'ready',
    'awaiting_decision',
    'paused',
    'assigned',
    'cancelled',
  ],
  retrying: ['in_progress', 'assigned', 'cancelled'],
  paused: ['in_progress', 'assigned', 'cancelled'],
  awaiting_decision: ['assigned', 'suspended', 'needs_user', 'cancelled'],
  needs_user: ['assigned', 'failed', 'cancelled'],
  suspended: ['ready', 'failed', 'cancelled'],
  blocked: ['cancelled'], // restore-edge handled by restoreBlocked()
  completed: [],
  failed: [],
  cancelled: [],
};

/** Whether the raw edge exists (blocked's restore edge is separate). */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === 'blocked') return to === 'cancelled' || from === to;
  return EDGES[from].includes(to);
}

/**
 * Apply one status move in place. Bookkeeping:
 * - entering `blocked` records `blockedFrom` (restore target);
 * - leaving `blocked` for any reason clears it (restore uses restoreBlocked).
 */
export function applyTransition(task: TaskRecord, to: TaskStatus, now: number): void {
  if (task.status === to) return;
  // 对话任务组（docs/26）：group 任务不经执行链，全部小任务完成时由插件
  // 直接 ready→completed（标准边没有这条，这里单独放行）。
  if (task.kind === 'group' && task.status === 'ready' && to === 'completed') {
    task.completedAt = now;
    task.status = to;
    task.updatedAt = now;
    return;
  }
  if (!canTransition(task.status, to)) throw new TransitionError(task.status, to);
  if (to === 'blocked') {
    task.blockedFrom = task.status;
  } else if (task.status === 'blocked') {
    task.blockedFrom = undefined;
  }
  if (to === 'completed') task.completedAt = now;
  task.status = to;
  task.updatedAt = now;
}

/**
 * Restore a materialized `blocked` task to its pre-block status, re-checking
 * that dependencies actually recovered (docs/05.9: blocked is materialized
 * but its exit re-derives from live dependency statuses).
 */
export function restoreBlocked(
  task: TaskRecord,
  dependenciesSatisfied: boolean,
  now: number,
): TaskStatus {
  if (task.status !== 'blocked') return task.status;
  const target: TaskStatus = task.blockedFrom ?? 'ready';
  if (target === 'ready' && !dependenciesSatisfied) return task.status;
  task.blockedFrom = undefined;
  task.status = target;
  task.updatedAt = now;
  return target;
}

/** Dependency statuses that poison downstream tasks (docs/05.9). */
const POISON: ReadonlySet<TaskStatus> = new Set([
  'suspended',
  'failed',
  'awaiting_decision',
  'needs_user',
]);

/** Un-satisfied dependency ids of one task against the task list. */
export function unsatisfiedDependencies(tasks: readonly TaskRecord[], task: TaskRecord): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return task.dependencies.filter((depId) => byId.get(depId)?.status !== 'completed');
}

/** Poisoning dependency ids (any non-terminal bad status) of one task. */
export function poisoningDependencies(tasks: readonly TaskRecord[], task: TaskRecord): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return task.dependencies.filter((depId) => {
    const status = byId.get(depId)?.status;
    return status !== undefined && POISON.has(status);
  });
}

/** True when every dependency is `completed` (assignment precondition). */
export function dependenciesSatisfied(tasks: readonly TaskRecord[], task: TaskRecord): boolean {
  return unsatisfiedDependencies(tasks, task).length === 0;
}

/**
 * Refresh one task's dependency-derived status in place (docs/05.9: blocked
 * is materialized; recovery refreshes back). Only `ready` tasks materialize
 * into `blocked`: completed dependencies are terminal, so a task that is
 * already assigned/in_progress cannot regress through dependency poisoning.
 * @returns whether the status changed.
 */
export function refreshDependencyStatus(
  tasks: readonly TaskRecord[],
  task: TaskRecord,
  now: number,
): boolean {
  if (task.status === 'ready') {
    if (poisoningDependencies(tasks, task).length > 0) {
      applyTransition(task, 'blocked', now);
      return true;
    }
    return false;
  }
  if (task.status === 'blocked') {
    const before = task.status;
    restoreBlocked(task, dependenciesSatisfied(tasks, task), now);
    return before !== task.status;
  }
  return false;
}

/** The next planned chain station, or undefined at/past the end (docs/06.7). */
export function nextChainStation(task: TaskRecord): ChainStation | undefined {
  return task.chain[task.chainCursor + 1];
}

/** Whether the task has a planned chain with an upcoming station. */
export function hasUpcomingStation(task: TaskRecord): boolean {
  return task.chain.length > 0 && task.chainCursor + 1 < task.chain.length;
}

/** Station progress (1-based completed stations / chain length). */
export function stationProgress(task: TaskRecord): { done: number; total: number } | undefined {
  if (task.chain.length === 0) return undefined;
  return { done: task.chainCursor + 1, total: task.chain.length };
}

/** Team id / member key sanitizer (docs/05.1: sanitizeKey). */
export function sanitizeKey(name: string): string {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return key === '' ? 'team' : key.slice(0, 64);
}

/** Filesystem slug for a task folder: `t3-login-service`. */
export function taskSlug(task: TaskRecord): string {
  const slug = sanitizeKey(task.subject).slice(0, 40);
  return `${task.id}-${slug}`;
}

/** Detect a dependency cycle if `dependencies` were added to `taskId`. */
export function wouldCycle(
  tasks: readonly TaskRecord[],
  taskId: string,
  dependencies: readonly string[],
): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>([taskId]);
  const stack = [...dependencies];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) break;
    if (id === taskId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const deps = byId.get(id)?.dependencies ?? [];
    stack.push(...deps);
  }
  return false;
}

/** Downstream tasks that directly depend on `taskId`. */
export function dependentsOf(tasks: readonly TaskRecord[], taskId: string): TaskRecord[] {
  return tasks.filter((t) => t.dependencies.includes(taskId));
}
