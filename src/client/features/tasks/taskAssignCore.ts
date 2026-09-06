/**
 * 小任务拖拽指派——纯逻辑层（docs/29 A.3.1）：drop 只产生「chain 全量替换」
 * （DA3/DA10：与「修改」弹窗的保存同构，复用 updateTeamTask，无新通道）。
 * 2026-09-04 二轮（DA13 多人接力槽位）：空白处 drop=追加站点（stationIndex
 * 缺省）、chip drop=定点替换（stationIndex 显式）、全链同名去重、chip ×=
 * 逐站移除；可编辑窗口内框承整链（boxCoversChain 抑制 TaskStations）。
 * 2026-09-05 六轮（DA19 链编排收进卡槽）：chip 拖动调序（chainAfterReorder）、
 * 「＋」点开多选追加（chainAfterAppendMany）——弹窗不再做链编排。
 * 2026-09-05 七轮（DA20 卡片拖拽调执行顺序）：兄弟依赖链语义——
 * executionOrderOf（拓扑展示序）+ depPatchesForReorder（拖卡→依赖改写补丁）。
 * 2026-09-06 三十五轮（DA48 松手放置判位插入）：成员拖入成员槽=按落点 X
 * 判位插入（insertionIndexOf + chainAfterInsert，空链=追加即放置）；二轮
 * DA13 的「chip drop=定点替换」废止（nextChainAfterDrop 删除——替换与悬空
 * 名修复改走 × 移除 + 再拖入）。
 * 本模块不 import React，可被 vitest 直测（tests/taskAssign.test.ts）。
 *
 * @module dsh-eteams/client/taskAssignCore
 */
import type { TaskSlotInput } from '../../lib/api';

/**
 * 拖拽语义所需的最小任务面（结构类型——TaskView 满足之，测试用 plain 对象
 * 即可构造）。assignee 仅只读框展示消费，可缺省（缺省按未指派）。
 */
export interface ChainTaskLike {
  status: string;
  chain: readonly { member: string; stageBrief: string }[];
  chainCursor: number;
  assignee?: string | null;
}

/**
 * 拖拽编辑窗口（DA6，比 host 的 updateTask 状态闸更严——E6 编辑矩阵：
 * 链未领取时才可整体编辑）：`draft/ready && chainCursor === -1`。
 * chainCursor≥0（链已开跑）或非 draft/ready（合同冻结）一律只读。
 */
export function isAssignEditable(task: ChainTaskLike): boolean {
  return (task.status === 'draft' || task.status === 'ready') && task.chainCursor === -1;
}

/**
 * 三十五轮 DA48：松手放置判位——成员拖入成员槽按落点 X 判插入位：逐个站点
 * chip 中点比距，`x < midpoints[i]`（最近 chip 中点**左半**）= 插其前，右半 =
 * 插其后；全越过 → midpoints.length（末尾追加）；空数组 → 0（空链=追加）。
 */
export function insertionIndexOf(midpoints: readonly number[], x: number): number {
  for (const [i, mid] of midpoints.entries()) {
    if (x < mid) return i;
  }
  return midpoints.length;
}

/**
 * 三十五轮 DA48：成员拖入成员槽 = 松手放置（原「空白处=末尾追加」改「按落
 * 点判位插入」——落点 X 经 {@link insertionIndexOf} 判位，空链=追加）：
 * 在 `index` 处插入 `{member, stageBrief:''}`（update 通道空 brief 合法，
 * E4/29.5 冲突①；**接力链不设上限**，DA15 曾限 2 站已废止）。
 * - 不可编辑 → null（不注册 drop target，双保险）；
 * - 拖入成员与链内**任一站点**同名 → null（DA8 去重同源——接力链同一成员
 *   占两站无意义且防误操作；不发请求，组件给出 200ms 微反馈）；
 * - `index` 夹取到 [0, chain.length]（快照中途变化防越界，不误投）。
 * 返回 null = no-op（不发请求）。
 */
export function chainAfterInsert(
  task: ChainTaskLike,
  member: string,
  index: number,
): TaskSlotInput[] | null {
  if (!isAssignEditable(task) || task.chain.some((s) => s.member === member)) return null;
  const clamped = Math.min(Math.max(index, 0), task.chain.length);
  const chain: TaskSlotInput[] = task.chain.map((s) => ({
    member: s.member,
    stageBrief: s.stageBrief,
  }));
  chain.splice(clamped, 0, { member, stageBrief: '' });
  return chain;
}

/** chip × 的出现条件（可编辑窗口内任意站可移除；整链重排走「修改」弹窗）。 */
export function canRemoveStation(task: ChainTaskLike): boolean {
  return isAssignEditable(task);
}

/** 移除站点后的新链（末站移除即空链，回「领队自由指派」，docs/06 §6.7 合法）。 */
export function chainAfterRemove(task: ChainTaskLike, index: number): TaskSlotInput[] {
  return task.chain
    .filter((_, i) => i !== index)
    .map((s) => ({ member: s.member, stageBrief: s.stageBrief }));
}

/**
 * 卡槽内 chip 拖动调序（2026-09-05 六轮拍板 DA19）：把 `fromIndex` 站搬到
 * `toIndex` 站的位置（数组搬移——被拖站占目标位、其余顺移，stageBrief 随站
 * 走）。from===to（自拖自放）或越界（快照中途变化）→ null（no-op，不重发）。
 */
export function chainAfterReorder(
  task: ChainTaskLike,
  fromIndex: number,
  toIndex: number,
): TaskSlotInput[] | null {
  if (!isAssignEditable(task) || fromIndex === toIndex) return null;
  if (fromIndex < 0 || toIndex < 0) return null;
  if (fromIndex >= task.chain.length || toIndex >= task.chain.length) return null;
  const moved = task.chain[fromIndex];
  if (moved === undefined) return null;
  const chain: TaskSlotInput[] = task.chain
    .filter((_, i) => i !== fromIndex)
    .map((s) => ({ member: s.member, stageBrief: s.stageBrief }));
  chain.splice(toIndex, 0, { member: moved.member, stageBrief: moved.stageBrief });
  return chain;
}

/**
 * 「＋」点开的成员多选追加（六轮 DA19）：按勾选顺序逐个末尾追加
 * `{member, stageBrief:''}`（update 通道空 brief 合法，E4/29.5 冲突①）；
 * 已在链中的名字过滤跳过（DA8 全链去重同源），一个都不新增 → null
 * （no-op，不发请求）。
 */
export function chainAfterAppendMany(
  task: ChainTaskLike,
  members: readonly string[],
): TaskSlotInput[] | null {
  if (!isAssignEditable(task)) return null;
  const existing = new Set(task.chain.map((s) => s.member));
  const fresh = members.filter((m) => !existing.has(m));
  if (fresh.length === 0) return null;
  return [
    ...task.chain.map((s) => ({ member: s.member, stageBrief: s.stageBrief })),
    ...fresh.map((m) => ({ member: m, stageBrief: '' })),
  ];
}

/**
 * 罗列条工号徽章文案（2026-09-05 五轮拍板 DA18）：host 发 `ET-0001` 格式串
 * （docs/21），徽章只显数字——剥 `ET-` 前缀；其余格式原样保留（不猜格式）；
 * null/空串（legacy 成员）→ null 不渲染徽章。
 */
export function employeeBadgeOf(employeeId: string | null | undefined): string | null {
  if (employeeId === null || employeeId === undefined || employeeId === '') return null;
  return employeeId.replace(/^ET-/, '');
}

/**
 * 只读框的展示成员（A.5.1 不可放置/只读行）：优先当前执行人 assignee；
 * 无 assignee 时取下一待执行站成员，越界（链已跑完）回退末站。
 * 均无（空链且未指派）→ null，框不渲染。
 */
export function readonlyStationMember(task: ChainTaskLike): string | null {
  if (task.assignee !== null && task.assignee !== undefined) return task.assignee;
  const index = Math.min(task.chainCursor + 1, task.chain.length - 1);
  if (index < 0) return null;
  return task.chain[index]?.member ?? null;
}

/**
 * 可编辑窗口内框承整链（DA5/DA13）→ 消费位抑制 TaskStations 重复渲染
 * （原 TasksTab 消费，M3 起 = tasks/taskSubtaskItem 的 suppressStations）；
 * 空链时 TaskStations 本就渲染 null，无需抑制。
 */
export function boxCoversChain(task: ChainTaskLike): boolean {
  return isAssignEditable(task) && task.chain.length > 0;
}

/**
 * 小任务卡片拖拽调执行顺序（2026-09-05 七轮拍板 DA20）所需的最小任务面：
 * TaskView 满足之，测试用 plain 对象即可构造。执行顺序 = **兄弟依赖链**
 * （host 靠 dependencies 物化阻塞 wait/blockedFrom 强制先后，docs/36），
 * 故「卡片也能拖拽调执行顺序」落地为依赖改写补丁，不是新增排序通道。
 */
export interface OrderableTaskLike {
  taskId: number;
  parentId: number | null;
  status: string;
  dependencies: readonly number[];
}

/** 执行顺序补丁（updateTeamTask 的 dependencies 整体替换载荷）。 */
export interface TaskDependencyPatch {
  taskId: number;
  dependencies: number[];
}

/** 执行顺序重排的可编辑窗口与 host updateTask 的依赖闸同口径：draft/ready。 */
function isOrderEditable(task: OrderableTaskLike): boolean {
  return task.status === 'draft' || task.status === 'ready';
}

/**
 * 兄弟小任务的展示执行顺序：对兄弟集（同 parentId，含 null 顶层）内的依赖做
 * 分层拓扑排序（Kahn，逐轮按输入序=创建序平局），兄弟集外的依赖（外部依赖）
 * 不参与兄弟排序；环/悬空引用（防御，host 侧 wouldCycle 本应杜绝）把剩余
 * 按输入序直接追加，绝不丢任务。
 */
export function executionOrderOf<T extends OrderableTaskLike>(tasks: readonly T[]): T[] {
  const siblingIds = new Set(tasks.map((t) => t.taskId));
  const ordered: T[] = [];
  const emitted = new Set<number>();
  let remaining = [...tasks];
  while (remaining.length > 0) {
    const ready = remaining.filter((t) =>
      t.dependencies.every((d) => !siblingIds.has(d) || emitted.has(d)),
    );
    if (ready.length === 0) {
      ordered.push(...remaining);
      break;
    }
    for (const task of ready) {
      ordered.push(task);
      emitted.add(task.taskId);
    }
    remaining = remaining.filter((t) => !emitted.has(t.taskId));
  }
  return ordered;
}

/**
 * 拖卡 fromTaskId 到 toTaskId 位置后的依赖改写补丁（七轮 DA20）：
 * - 同 parentId 的兄弟才可互拖；from===to、任一卡不在列表、任一卡不可编辑
 *   （已领取/冻结，host 依赖闸同口径）→ null（no-op）；
 * - 现执行序（executionOrderOf）内做数组搬移（同六轮 chip 口径：被拖卡占
 *   目标位、其余顺移）；
 * - 按新执行序把兄弟依赖重写为**线性链**（第 k 位依赖第 k-1 位），各卡保留
 *   兄弟集外的外部依赖；
 * - 只返回 deps 实际变化且仍可编辑（draft/ready）的补丁——已领取/冻结的兄弟
 *   不改写（host 会拒），其链位滑动属已知口径（docs/29 A.7）；
 * - 全部无变化 → null（不发请求）。
 */
export function depPatchesForReorder(
  tasks: readonly OrderableTaskLike[],
  fromTaskId: number,
  toTaskId: number,
): TaskDependencyPatch[] | null {
  if (fromTaskId === toTaskId) return null;
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const from = byId.get(fromTaskId);
  const to = byId.get(toTaskId);
  if (!from || !to) return null;
  if (from.parentId !== to.parentId) return null;
  if (!isOrderEditable(from) || !isOrderEditable(to)) return null;
  const siblings = tasks.filter((t) => t.parentId === from.parentId);
  const order = executionOrderOf(siblings);
  const fromPos = order.findIndex((t) => t.taskId === fromTaskId);
  const toPos = order.findIndex((t) => t.taskId === toTaskId);
  if (fromPos < 0 || toPos < 0) return null;
  const moved = order[fromPos]!;
  const next = order.filter((_, i) => i !== fromPos);
  next.splice(toPos, 0, moved);
  const siblingIds = new Set(siblings.map((t) => t.taskId));
  const patches: TaskDependencyPatch[] = [];
  next.forEach((task, position) => {
    if (!isOrderEditable(task)) return;
    const external = task.dependencies.filter((d) => !siblingIds.has(d));
    const prev = position > 0 ? next[position - 1]!.taskId : undefined;
    const deps =
      prev === undefined || external.includes(prev) ? [...external] : [...external, prev];
    const changed =
      deps.length !== task.dependencies.length || deps.some((d) => !task.dependencies.includes(d));
    if (!changed) return;
    patches.push({ taskId: task.taskId, dependencies: deps });
  });
  return patches.length > 0 ? patches : null;
}
