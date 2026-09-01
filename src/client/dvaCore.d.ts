/**
 * dva-core 2.0.4 最小类型声明（docs/21-client-ui-stack.md S6 / D19e）。
 *
 * 2.0.4 不随包 .d.ts（registry 核实），@types/dva 只覆盖 dva 全家桶
 * （捆绑 react-router/history，本仓不适用）——按本仓实际消费面手写：
 * - create(opts) / app.model / app.start / app.use / app.unmodel
 * - app._store（官方用法：2.0.4 没有 app.getStore()；start() 也没有
 *   二次调用守卫，单例纪律由 store/app.ts 自行保证）
 *
 * 注意本文件必须是脚本（无顶层 import/export）——`declare module` 才是
 * 环境模块声明（untyped 包只有这条路）；顶层 import 会把它变成模块
 * 扩充（augmentation），对无类型包不生效。redux 类型经模块体内
 * import type 引入：react-redux <Provider> 的 store prop 要求完整
 * Store（含 Symbol.observable），仅 { dispatch, getState, subscribe }
 * 三件套过不了赋值检查。
 */
declare module 'dva-core' {
  import type { Store } from 'redux';

  /** dva action 最小面：type + 约定的 payload 键（reducers/effects 消费）。 */
  export interface DvaAction<P = unknown> {
    type: string;
    payload?: P;
  }

  /**
   * dva model 编写面（docs/21 21.5.3 拓扑）：namespace/state/reducers。
   * 用 type alias 而非 interface——对象字面量类型的别名带隐式索引签名，
   * 具体模型才能直接赋给注册面 DvaModelInput（interface 无此豁免）。
   * effects/subscriptions 待 S10 接入 effects 时按需补。
   */
  export type DvaModel<S = unknown> = {
    namespace: string;
    state?: S;
    reducers?: Record<string, (state: S, action: DvaAction<S>) => S>;
  };

  /**
   * dva model 注册面：运行时只动态读键，namespace 必带。各模型以
   * DvaModel<S> 精确编写，注册时经隐式索引签名放宽到本面。
   */
  export interface DvaModelInput {
    namespace: string;
    [key: string]: unknown;
  }

  /** create 选项最小面（本仓只用 onError；其余键按需补）。 */
  export interface DvaOptions {
    /**
     * dva 运行时错误钩子（effects/订阅内抛错等）：本仓喂 diagnostics。
     * 第二参随触发点不同（effect 处是 { key, effectArgs }），不消费。
     */
    onError?: (error: unknown, extra?: unknown) => void;
  }

  /** dva app 最小面（create 返回值）。 */
  export interface DvaApp {
    /** 注册 model（D19e：只在 start() 前调用，不依赖启动后官方支持）。 */
    model(model: DvaModelInput): void;
    /** 注销 model（最小面备用；本仓暂未消费）。 */
    unmodel(namespace: string): void;
    /** 注册插件（最小面备用；本仓暂未消费）。 */
    use(plugin: Record<string, unknown>): void;
    /** 启动：无二次调用守卫，单例纪律在 store/app.ts。 */
    start(): void;
    /** redux store（官方用法；react-redux Provider 直接消费）。 */
    readonly _store: Store;
  }

  export function create(opts?: DvaOptions): DvaApp;
}
