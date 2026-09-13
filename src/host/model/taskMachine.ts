/**
 * Task state machine（用户迭代 2026-09-11：11 态精简为 7 态后又恢复独立
 * `wait`（待领队分诊）= 8 态：creating/ready/start/wait/paused/wait_user/
 * completed/cancelled）— pure functions,
 * no I/O, no cordis. Illegal transitions throw `TransitionError`; the tool layer
 * converts them into actionable Chinese error text.
 *
 * 「阻塞」不再是状态：原 `ready → wait + blockedFrom` 的依赖物化随 `wait` 撤销
 * 整体退役（依赖未满足的任务保持 ready，派发口用 {@link dependenciesSatisfied}
 * 校验）；大任务（parentId 为空）的 completed↔ready 走 applyTransition 的结构
 * 特例边。
 *
 * @module dsh-eteams/model/taskMachine
 */
import type {
  AttemptRecord,
  ChainStation,
  TaskMemberRecord,
  TaskRecord,
  TaskStatus,
} from './types.js';

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
 * Allowed outgoing edges per status（用户迭代 2026-09-11 精简为 7 态）。
 *
 * 原 11 态边的收敛：`draft`/`wait` 边并入 `ready`；`wait_decision`/`failed`
 * 边并入 `wait_user`。「阻塞」不再是状态（原 `wait + blockedFrom` 物化随
 * wait 撤销退役）——被上游依赖卡住的任务保持 `ready`，是否可派发由
 * {@link dependenciesSatisfied} 在派发口校验。
 *
 * `creating`（面板手动创建占位）：完善收口转 ready、放弃转 cancelled；不经
 * 转移进入（建任务直接以 creating 落库）。
 * `completed` 小任务是终态；大任务（parentId 为空）的 `completed → ready`
 * 是**特例边**（追加小任务即回退，见 applyTransition），故记在 ready 侧。
 */
const EDGES: Record<TaskStatus, readonly TaskStatus[]> = {
  creating: ['ready', 'cancelled'],
  ready: ['start', 'paused', 'wait_user', 'cancelled'],
  // 严格顺序执行：start 可回 ready（失败重试/改派/中间站交接）、落 wait
  // （自动重试超限，待领队分诊——用户迭代 2026-09-11）。
  start: ['ready', 'completed', 'wait', 'paused', 'wait_user', 'cancelled'],
  // 待领队分诊：小 bug 重新指派 loop → ready；流程问题升级 → wait_user；
  // 挂起 → paused；取消 → cancelled。
  wait: ['ready', 'start', 'paused', 'wait_user', 'cancelled'],
  paused: ['ready', 'start', 'wait_user', 'cancelled'],
  wait_user: ['ready', 'start', 'paused', 'cancelled'],
  completed: [],
  cancelled: [],
};

/** Whether the raw edge exists (blocked-state restore is separate). */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return EDGES[from].includes(to);
}

/**
 * Apply one status move in place（用户迭代 2026-09-11：blockedFrom 物化退役，
 * 不再有退出物化阻塞态的清理动作）。
 */
export function applyTransition(task: TaskRecord, to: TaskStatus, now: number): void {
  if (task.status === to) return;
  // 对话任务组（docs/26）：大任务（容器）不经执行链，两条结构特例边：
  // ready→completed（全部小任务完成时由插件收口）与 completed→ready
  // （用户迭代 2026-09-11「完成后还可以继续添加小任务继续」——追加小任务即
  // 回退，completed 只是「当前小任务都完成」的标识）。docs/27 定案 kind 不
  // 落库，容器判据换成结构：parent_id 为空 = 大任务。
  if (task.parentId === null) {
    const containerEdge =
      (task.status === 'ready' && to === 'completed') ||
      (task.status === 'completed' && to === 'ready');
    if (containerEdge) {
      if (to === 'completed') task.completedAt = now;
      task.status = to;
      task.updatedAt = now;
      return;
    }
  }
  if (!canTransition(task.status, to)) throw new TransitionError(task.status, to);
  if (to === 'completed') task.completedAt = now;
  task.status = to;
  task.updatedAt = now;
}

/** Un-satisfied dependency ids of one task against the task list. */
export function unsatisfiedDependencies(tasks: readonly TaskRecord[], task: TaskRecord): number[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return task.dependencies.filter((depId) => byId.get(depId)?.status !== 'completed');
}

/** True when every dependency is `completed`（派发前置条件；依赖未满足的任务
 * 保持 ready 不物化，由派发口显式校验——用户迭代 2026-09-11「阻塞就 ready
 * 等待就行」）。 */
export function dependenciesSatisfied(tasks: readonly TaskRecord[], task: TaskRecord): boolean {
  return unsatisfiedDependencies(tasks, task).length === 0;
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

/**
 * 成员在某任务执行链上的站点下标（弱顺序链，用户 2026-09-13）：按
 * {@link stationPointsTo} 找**第一个**匹配站点；未在链上返回 undefined。
 * 指派成员前用它判断「是否已在链上」——已在链上就复用其站点，不重复追加。
 */
export function chainIndexOfStation(
  chain: readonly ChainStation[],
  row: Pick<TaskMemberRecord, 'employeeId' | 'name'>,
): number | undefined {
  const i = chain.findIndex((s) => stationPointsTo(s, row));
  return i === -1 ? undefined : i;
}

/**
 * 链上各站点是否已有成功尝试（弱顺序链进度，用户 2026-09-13）：「站点 i 已
 * 成功」= 存在 stationIndex === i 且 status === 'succeeded' 的尝试。越界
 * stationIndex（<0 或 >= chainLength）忽略——追加/删站后旧尝试的下标可能失效。
 */
export function chainDoneStations(
  chainLength: number,
  attempts: readonly Pick<AttemptRecord, 'stationIndex' | 'status'>[],
): boolean[] {
  const done = new Array<boolean>(chainLength).fill(false);
  for (const a of attempts) {
    if (a.status === 'succeeded' && a.stationIndex >= 0 && a.stationIndex < chainLength) {
      done[a.stationIndex] = true;
    }
  }
  return done;
}

/**
 * 弱顺序链的推进位（frontier，用户 2026-09-13）：最靠前、尚无成功尝试的站点
 * 下标；全部站点都有成功尝试（或无链）→ `chainLength` = 可收口。执行顺序为弱
 * 约束——成员可任意顺序跑，某站完成后任务**继续从 frontier 往后跑剩余站点**
 * （而不是只认链游标 +1）。
 */
export function chainFrontier(
  chainLength: number,
  attempts: readonly Pick<AttemptRecord, 'stationIndex' | 'status'>[],
): number {
  const i = chainDoneStations(chainLength, attempts).indexOf(false);
  return i === -1 ? chainLength : i;
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
