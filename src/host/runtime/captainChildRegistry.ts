/**
 * 领队子代理登记表（独立模块，消掉 notifier ↔ captainAgent 的模块环）：
 * child session id → { teamId, workspace root, taskId, parentSessionId }。
 *
 * 写入点 = spawn 与每次 followup 重登记（持久 child id 跨宿主重启存活，所以
 * 重启后要重新登记）；移除点 = 同一团队重建其子代理（谱系失效）或 spawn 失败
 * ——子代理是持续会话，不是回合作用域。root/taskId 供领队手册插槽按子会话直查
 * 本任务的领队副本行（免注册表扫描）；parentSessionId 是子代理树的**直接父**
 * （派发/唤醒锚点：宿主 followup/sendMessage 只认写进子代理持久 header 的那个
 * 确切父级）。
 *
 * 依赖方向：本模块不 import 任何 runtime 模块（叶子），captainAgent / notifier
 * / assignment / identity 等都从这里取。
 *
 * @module dsh-eteams/runtime/captainChildRegistry
 */

const captainChildren = new Map<
  string,
  { teamId: string; root: string; taskId: string; parentSessionId: string }
>();

/** Register a freshly spawned captain child (identity.ts 领队解析依据). */
export function registerCaptainChild(
  childId: string,
  teamId: string,
  root = '',
  taskId = '',
  parentSessionId = '',
): void {
  if (childId === '' || teamId === '') return;
  captainChildren.set(childId, { teamId, root, taskId, parentSessionId });
}

/** The team a captain child serves (undefined for non-captain sessions). */
export function captainChildTeamOf(childId: string): string | undefined {
  return captainChildren.get(childId)?.teamId;
}

/** The main conversation a captain child was dispatched from（子代理树的直接
 * 父）。captainFor 用它把「快照误记成领队子会话」的任务行换回真正的主会话，
 * 免得成员子代理挂到领队子代理下（用户迭代 2026-09-12）。 */
export function captainChildParentOf(childId: string): string | undefined {
  const parent = captainChildren.get(childId)?.parentSessionId;
  return parent === '' ? undefined : parent;
}

/** The workspace state root a captain child's team lives in (手册插槽用). */
export function captainChildRootOf(childId: string): string | undefined {
  const root = captainChildren.get(childId)?.root;
  return root === '' ? undefined : root;
}

/** The big task a captain child's session anchors (手册插槽按任务读副本行). */
export function captainChildTaskOf(childId: string): string | undefined {
  const taskId = captainChildren.get(childId)?.taskId;
  return taskId === '' ? undefined : taskId;
}

/** Drop the registry entry after the run settles (or on spawn failure). */
export function unregisterCaptainChild(childId: string): void {
  captainChildren.delete(childId);
}
