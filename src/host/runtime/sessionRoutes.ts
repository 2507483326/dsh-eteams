/**
 * 子代理会话「声明路线」登记表（用户迭代 2026-09-07「子代理会话中显示实际的
 * provider/model」的显示口径修正）。
 *
 * 为什么需要：request/header 观测到的 config.model 是解析后的**上游限定 id**
 * （如 tokenrouter 路由下的 `z-ai/glm-5.3-free`），而主会话模型座位显示的是
 * **目录级 id**（`glm-5.3-free`）——子代理徽章若直接显示观测值，用户会看到
 * 与主会话不一致的「双重限定」串。spawn 时声明的 agentOptions（目录级 id）
 * 才是座位口径的路线值，因此 webui `/session-route` 的显示组合为「观测
 * provider（真实适配器名）+ 声明 model（目录级 id）」。
 *
 * 生命周期：进程内存 Map，与 usage routeCache 同口径——登记点在各 spawn 站点
 * （members.spawnMember / captainAgent 派发核，harness 0.1.2 起 continuable
 * setup hook 被宿主移除）；宿主重启后子代理重派/被唤醒即重新登记，从未登记
 * 的会话由观测路线兜底。
 *
 * @module dsh-eteams/runtime/sessionRoutes
 */

/** One session's declared (catalog-level) model route. */
export interface DeclaredSessionRoute {
  provider: string;
  model: string;
}

const declaredRoutes = new Map<string, DeclaredSessionRoute>();

/** 登记一条声明路线（spawn 站点调用）；空段不记。 */
export function recordSessionRoute(sessionId: string, route: DeclaredSessionRoute): void {
  if (sessionId === '' || route.provider === '' || route.model === '') return;
  declaredRoutes.set(sessionId, route);
}

/** 查询声明路线；未登记返回 undefined。 */
export function declaredRouteOf(sessionId: string): DeclaredSessionRoute | undefined {
  return declaredRoutes.get(sessionId);
}

/** Tests-only：清空模块级登记表（vitest 隔离）。 */
export function resetSessionRoutesForTests(): void {
  declaredRoutes.clear();
}

/** Tests-only：直填登记表（webui session-route 用例的隔离装配）。 */
export function seedDeclaredRouteForTests(sessionId: string, route: DeclaredSessionRoute): void {
  declaredRoutes.set(sessionId, route);
}
