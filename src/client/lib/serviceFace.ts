/**
 * 惰性服务读取面：从客户端插件暂存的 cordis ctx 上取可选服务，绝不抛。
 *
 * 客户端插件（`client/index.tsx`）在 apply() 时暂存根 ctx，把服务属性留到
 * 使用点惰性读取（服务可能晚于 apply 挂载——见 sessionState / modelCatalog）。
 * 此前各模块直接 `ctx.<service>` 取值，但 cordis 的注入服务访问是**门禁式**
 * 的：一旦该服务当前不活跃（提供方 fiber 正处于销毁/重挂窗口、插件自身
 * fiber 也随之挂起），属性读取会抛
 * `cannot get required service "<name>" in inactive context`，而不是回
 * undefined——这与本仓「可选服务结构化探测一律降级、绝不抛错」的纪律冲突，
 * 且抛错点常在渲染路径上（如面板首帧的 rootSessionIdOf），会被
 * ClientErrorBoundary 捕获成整个面板降级。
 *
 * 用户 2026-09-15 报「团队面板渲染失败：cannot get required service "sessions"
 * in inactive context」即此：`sessionState.sessionsFaceOf` 的裸属性读取把抛
 * 错带进了 `teamsView` 顶部渲染。修法=读取收口到这里：先走 cordis 反射读
 * `ctx.get(name)`（服务不活跃时回 undefined、不抛），再兜底带 try/catch 的
 * 属性读取（旧运行时 / 无反射读的假 ctx）。两条路都失败/absent 一律回
 * undefined，调用方按缺服务兜底。
 *
 * @module dsh-eteams/client/serviceFace
 */

/**
 * 取暂存 ctx 上的一件可选 cordis 服务。缺失 / 暂不活跃 / 形态异常一律回
 * undefined，绝不抛错。
 *
 * `ctx.get` 属 cordis 反射读、依赖接收者，必须带 `this` 调用（同宿主
 * webui 的 `get.call(ctx, key)` 先例）。
 *
 * @param ctx - apply() 时暂存的客户端 ctx（可能是 cordis 代理，也可能是测试
 * 用的普通对象；null/undefined 亦安全）。
 * @param name - 服务名（如 `'sessions'`）。
 */
export function readClientService(ctx: unknown, name: string): unknown {
  if (ctx === null || ctx === undefined) return undefined;
  const get = (ctx as { get?: (key: string) => unknown }).get;
  if (typeof get === 'function') {
    try {
      const value = get.call(ctx, name);
      if (value !== undefined) return value;
    } catch {
      // ctx.get 形态异常：落属性读取兜底。
    }
  }
  try {
    return Reflect.get(ctx as object, name);
  } catch {
    // 服务不活跃（cordis 门禁式属性访问抛错）：按缺服务降级。
    return undefined;
  }
}
