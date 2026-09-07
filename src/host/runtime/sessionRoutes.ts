/**
 * 子代理会话「声明路线」登记表（用户迭代 2026-09-07「子代理会话中显示实际的
 * provider/model」的显示口径修正）。
 *
 * 为什么需要：request/header 观测到的 config.model 是解析后的**上游限定 id**
 * （如 tokenrouter 路由下的 `z-ai/glm-5.3-free`），而主会话模型座位显示的是
 * **目录级 id**（`glm-5.3-free`）——子代理徽章若直接显示观测值，用户会看到
 * 与主会话不一致的「双重限定」串。spawn 时声明的 agentOptions（经
 * `subagent/descriptor` 事件持久化，`agentModel` = 目录级 id）才是座位口径
 * 的路线值，因此 webui `/session-route` 的显示组合为「观测 provider（真实
 * 适配器名，覆盖路线误填传输名的疑点）+ 声明 model（目录级 id）」。
 *
 * 生命周期：进程内存 Map，与 usage routeCache 同口径——登记点在成员运行时
 * 的 continuable setup hook（每次 Activation 重跑，含冷恢复），宿主重启后
 * 子代理一被唤醒/重建即重新登记；从未登记的会话由观测路线兜底。
 *
 * @module dsh-eteams/runtime/sessionRoutes
 */
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent';

/** One session's declared (catalog-level) model route. */
export interface DeclaredSessionRoute {
  provider: string;
  model: string;
}

const declaredRoutes = new Map<string, DeclaredSessionRoute>();

/** 登记一条声明路线（成员运行时 setup hook 调用）；空段不记。 */
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

/**
 * 从一个 continuable 子代理折出声明路线并登记（installMemberRuntime 的
 * descriptor 折叠点调用，位于成员身份过滤**之前**——成员/领队/构建师子代理
 * 一律登记）。fold 对不合规 payload 会 throw：吞掉，登记绝不影响子代理。
 */
export function recordDeclaredRouteFromChild(child: unknown): void {
  if (child === null || typeof child !== 'object') return;
  const withSession = child as {
    id?: unknown;
    session?: { header?: { seedLength?: number }; events?: unknown[] };
  };
  const sessionId = String(withSession.id ?? '');
  if (sessionId === '') return;
  const seedLength = withSession.session?.header?.seedLength ?? 0;
  const suffix = withSession.session?.events?.slice(seedLength) ?? [];
  let descriptor: ReturnType<typeof foldSubagentDescriptor>;
  try {
    descriptor = foldSubagentDescriptor(suffix as Parameters<typeof foldSubagentDescriptor>[0]);
  } catch {
    return;
  }
  if (descriptor?.mode !== 'continuable') return;
  const model = descriptor.agentModel;
  if (typeof model !== 'string' || model === '') return;
  recordSessionRoute(sessionId, { provider: descriptor.agentProvider ?? '', model });
}
