/**
 * Task state machine (docs/06.2；11 态收敛见 docs/27 §27.9.11 / docs/35 §4；
 * 第 11 态 `creating` = 面板手动创建占位，docs/panelTaskCommission)
 * — pure functions, no I/O, no cordis.
 * Illegal transitions throw `TransitionError`; the tool layer converts them
 * into actionable Chinese error text.
 *
 * @module dsh-eteams/model/taskMachine
 */
import type { ChainStation, TaskMemberRecord, TaskRecord, TaskStatus } from './types.js';

/** Thrown for any illegal status move; carries an actionable hint. */
export class TransitionError extends Error {
  readonly hint: string;
  constructor(from: TaskStatus, to: TaskStatus, hint?: string) {
    super(`illegal task transition ${from} -> ${to}${hint ? `: ${hint}` : ''}`);
    this.name = 'TransitionError';
    this.hint = hint ?? '检查任务当前状态后再操作';
  }
}

/**
 * Allowed outgoing edges per status (docs/27 §27.9.11：11 态收敛；docs/35 §4
 * 映射方案 A)。旧 13 态的合并：assigned/retrying/blocked → wait，
 * in_progress → start，awaiting_decision → wait_decision，
 * needs_user → wait_user，suspended → paused。「阻塞」不再是独立状态——
 * 物化阻塞 = `wait + blockedFrom 非空`，恢复走 restoreBlocked()。
 * `creating`（面板手动创建占位）：只有两条出边——完善收口转 ready、放弃转
 * cancelled；不经转移进入（建任务直接以 creating 落库）。
 */
const EDGES: Record<TaskStatus, readonly TaskStatus[]> = {
  creating: ['ready', 'cancelled'],
  draft: ['ready', 'cancelled'],
  // ready → wait 双义：正常派发（无 blockedFrom）与依赖毒化物化（恢复目标
  // 记进 blockedFrom，见 refreshDependencyStatus）共用同一条边。
  ready: ['wait', 'cancelled'],
  wait: ['start', 'ready', 'wait', 'paused', 'cancelled'],
  start: ['wait', 'completed', 'ready', 'wait_decision', 'paused', 'cancelled'],
  paused: ['start', 'wait', 'ready', 'failed', 'cancelled'],
  wait_decision: ['wait', 'paused', 'wait_user', 'cancelled'],
  wait_user: ['wait', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

/** Whether the raw edge exists (blocked-state restore is separate). */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return EDGES[from].includes(to);
}

/**
 * Apply one status move in place. Bookkeeping:
 * - 任何离开物化阻塞态（wait + blockedFrom 非空）的转移都清掉恢复目标
 *   （正常恢复走 restoreBlocked；这里兜底取消等旁路）；
 * - 物化本体（ready → wait + blockedFrom）由 refreshDependencyStatus 落笔，
 *   普通派发的 ready → wait 不得带上 blockedFrom。
 */
export function applyTransition(task: TaskRecord, to: TaskStatus, now: number): void {
  if (task.status === to) return;
  // 对话任务组（docs/26）：group 任务不经执行链，全部小任务完成时由插件
  // 直接 ready→completed（标准边没有这条，这里单独放行）。docs/27 定案
  // kind 不落库，容器判据换成结构：parent_id 为空 = 大任务（容器）。
  if (task.parentId === null && task.status === 'ready' && to === 'completed') {
    task.completedAt = now;
    task.status = to;
    task.updatedAt = now;
    return;
  }
  if (!canTransition(task.status, to)) throw new TransitionError(task.status, to);
  if (task.status === 'wait' && task.blockedFrom !== undefined) {
    task.blockedFrom = undefined;
  }
  if (to === 'completed') task.completedAt = now;
  task.status = to;
  task.updatedAt = now;
}

/**
 * Restore a materialized blocked task (wait + blockedFrom) to its pre-block
 * status, re-checking that dependencies actually recovered (docs/05.9: the
 * blocked state is materialized but its exit re-derives from live dependency
 * statuses). 入口判据 = blockedFrom 非空（docs/35 §5#11），恢复目标取
 * blockedFrom 本身，解除即清空。
 */
export function restoreBlocked(
  task: TaskRecord,
  dependenciesSatisfied: boolean,
  now: number,
): TaskStatus {
  if (task.blockedFrom === undefined) return task.status;
  const target: TaskStatus = task.blockedFrom;
  if (target === 'ready' && !dependenciesSatisfied) return task.status;
  task.status = target;
  task.blockedFrom = undefined;
  task.updatedAt = now;
  return target;
}

/** Dependency statuses that poison downstream tasks (docs/35 §3#12 定案集). */
const POISON: ReadonlySet<TaskStatus> = new Set([
  'paused',
  'failed',
  'wait_decision',
  'wait_user',
]);

/** Un-satisfied dependency ids of one task against the task list. */
export function unsatisfiedDependencies(tasks: readonly TaskRecord[], task: TaskRecord): number[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return task.dependencies.filter((depId) => byId.get(depId)?.status !== 'completed');
}

/** Poisoning dependency ids (any non-terminal bad status) of one task. */
export function poisoningDependencies(tasks: readonly TaskRecord[], task: TaskRecord): number[] {
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
 * Refresh one task's dependency-derived status in place (docs/05.9 + docs/35
 * §5#11)：ready 任务被依赖毒化时物化为 wait + blockedFrom='ready'；物化态
 * （blockedFrom 非空）在依赖恢复后还原。只有 ready 物化：已派发/执行中的
 * 任务不因依赖毒化回退（依赖 completed 即终态）。
 * @returns whether the status changed.
 */
export function refreshDependencyStatus(
  tasks: readonly TaskRecord[],
  task: TaskRecord,
  now: number,
): boolean {
  if (task.status === 'ready') {
    if (poisoningDependencies(tasks, task).length > 0) {
      applyTransition(task, 'wait', now);
      task.blockedFrom = 'ready';
      return true;
    }
    return false;
  }
  if (task.blockedFrom !== undefined) {
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

/**
 * 链站点是否指向该副本行（v7 按工号找人）：数字工号站点与副本行工号比对；
 * 迁移解析不到班底行的 legacy 名字站点按名兜底（同名多行时无法区分，仅旧
 * 数据兜底用）。
 */
export function stationPointsTo(
  station: ChainStation,
  row: Pick<TaskMemberRecord, 'employeeId' | 'name'>,
): boolean {
  if (typeof station.member === 'number') return station.member === row.employeeId;
  return station.member === row.name;
}

/**
 * 站点键的规范化文本（视图/比较层统一用）：工号站点转十进制串、legacy 名字
 * 站点原样——同一站点在宿主视图与客户端两侧用同一键比较。
 */
export function stationKeyOf(station: ChainStation): string {
  return String(station.member);
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

/** Filesystem slug for a task folder: `3-login-service`（整数任务号，docs/35 §5#7）. */
export function taskSlug(task: TaskRecord): string {
  const slug = sanitizeKey(task.subject).slice(0, 40);
  return `${task.id}-${slug}`;
}

/** Detect a dependency cycle if `dependencies` were added to `taskId`. */
export function wouldCycle(
  tasks: readonly TaskRecord[],
  taskId: number,
  dependencies: readonly number[],
): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<number>([taskId]);
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
export function dependentsOf(tasks: readonly TaskRecord[], taskId: number): TaskRecord[] {
  return tasks.filter((t) => t.dependencies.includes(taskId));
}
