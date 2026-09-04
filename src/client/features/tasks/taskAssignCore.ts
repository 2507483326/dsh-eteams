/**
 * 小任务拖拽指派——纯逻辑层（docs/29 A.3.1）：drop 只产生「chain 全量替换」
 * （DA3/DA10：与「修改」弹窗的保存同构，复用 updateTeamTask，无新通道）。
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

/** 下一待执行站点 index（E7：chainCursor+1；可编辑窗口内恒为 0）。 */
export function nextPendingIndex(task: ChainTaskLike): number {
  return task.chainCursor + 1;
}

/**
 * drop → 新链（A.3.1 规则表）：
 * - 不可编辑 → null（不注册 drop target，双保险）；
 * - 目标站点成员与拖入成员同名 → null（DA8 去重：不发请求，no-op）；
 * - chain 为空 → 追加 `{member, stageBrief:''}` 单站（update 通道空 brief 合法，
 *   E4/29.5 冲突①）；
 * - 有链 → 以**当前快照的 chain**为底替换下一待执行站成员、stageBrief 原值
 *   保留，其余站点原样——整链重发（A.3.1：不缓存旧 chain，drop 时现算）。
 * 返回 null = no-op（不发请求）。
 */
export function nextChainAfterDrop(task: ChainTaskLike, member: string): TaskSlotInput[] | null {
  if (!isAssignEditable(task)) return null;
  const index = nextPendingIndex(task);
  const target = task.chain[index];
  if (target !== undefined && target.member === member) return null;
  const chain: TaskSlotInput[] = task.chain.map((s) => ({
    member: s.member,
    stageBrief: s.stageBrief,
  }));
  if (target === undefined) {
    chain.push({ member, stageBrief: '' });
  } else {
    chain[index] = { member, stageBrief: target.stageBrief };
  }
  return chain;
}

/** 框内 × 的出现条件（DA4/A.3.1 移除行：仅单站链，清空=整链重发为空链，
 * 回到「领队自由指派」；多站点移除走「修改」弹窗）。 */
export function canClearStation(task: ChainTaskLike): boolean {
  return isAssignEditable(task) && task.chain.length <= 1;
}

/** 清空站点的新链（空链任务回到领队自由指派，docs/06 §6.7 合法）。 */
export function clearedChain(_task: ChainTaskLike): TaskSlotInput[] {
  return [];
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

/** 框是否有可渲染内容（决定单站点 TaskStations 的抑制，A.5.1）。 */
export function boxRendersContent(task: ChainTaskLike): boolean {
  return isAssignEditable(task) || readonlyStationMember(task) !== null;
}

/** 下一待执行站的当前成员（可编辑框内 chip 渲染 / 去重判断）；无站返回 null。 */
export function dropTargetMember(task: ChainTaskLike): string | null {
  return task.chain[nextPendingIndex(task)]?.member ?? null;
}
