/**
 * 模型聚合（docs/21-client-ui-stack.md S6 / D19e）：全部模型集中在此，
 * store/app.ts 在 start() 前全量注册；新增 model 在此追加——start() 后
 * 不得再 app.model()（本仓不依赖启动后注册的官方支持）。
 *
 * S10 追加 roster/build 两个 model（21.5.3 拓扑补齐）；effects 基建类型
 * （EffectCommands/EffectWorker/TakeLatestEffect）也落在本层——dvaCore.d.ts
 * 的最小面（S6 落地）只覆盖 state/reducers，effects 面按 D19e「S10 接入
 * effects 时按需补」的约定在聚合层补齐。各 model 只 `import type` 本层
 * （类型环安全、编译期擦除），不做值回流——index 的导入先于自身求值，
 * 值级循环会让 model 文件在 TDZ 里读不到本层常量。
 *
 * @module dsh-eteams/client/store/models
 */
import type { DvaAction, DvaModelInput } from 'dva-core';
// S10（regenerator 全局就位）：dva-core 2.0.4 的 CJS 构建面（dist/index.js，
// 无 exports 表时的 main 命中面——vitest 与 tsdown/rolldown 都解析到它）用
// Babel regenerator 编译生成器，产物引用裸全局 regeneratorRuntime；其 ESM
// 构建面虽是 '@babel/runtime/regenerator' 模块导入，但 bundle/测试都走不到
// 那个入口。S10 首次接入 effects：start() → getSaga() 即触达该路径（S6–S9
// models 无 effects，从不执行，问题一直潜伏）。本层副作用引入
// @babel/runtime/regenerator——它 module.exports 即 runtime 对象，且自带
// 全局挂载（sloppy 裸赋值 / strict 经 globalThis 兜底，见其 index.js）；
// app.ts import 本层先于 createDvaApp/start()，envelope 与 vitest 两环境
// 在任何 effect 执行前一并就位。体积增量（regenerator runtime 内联进
// envelope）已计入本步 sizeKB 记录。
// @ts-expect-error @babel/runtime 不随 .d.ts，这里只取运行时默认导出
import regeneratorRuntime from '@babel/runtime/regenerator';
import { activityModel } from './activity';
import { buildModel } from './build';
import { rosterModel } from './roster';
import { uiModel } from './ui';

// 显式兜底：幂等挂全局（host 页面若已有同名全局则不覆盖——regenerator
// 协议稳定，等价 runtime 本可互换，这里仍保守不动既有值）。
const globalScope = globalThis as { regeneratorRuntime?: unknown };
if (globalScope.regeneratorRuntime === undefined) {
  globalScope.regeneratorRuntime = regeneratorRuntime;
}

/**
 * effect 内可用的命令面：dva-core 的 getSaga.createEffects 传给每个 worker
 * 的第二参（docs/21 21.3 经典面取本仓消费子集 call/put；takeLatest/throttle
 * 等走数组式声明，见 {@link TakeLatestEffect}）。redux-saga 0.16 无类型面，
 * call 的结果按 unknown 返回、消费点显式断言（dva effect 的既有惯例）。
 */
export interface EffectCommands {
  call: {
    <T>(fn: () => T | Promise<T>): unknown;
    <T, A>(fn: (a: A) => T | Promise<T>, a: A): unknown;
  };
  /** dva 包装的 put：本 model 的 reducer/effect 键自动加 namespace 前缀。 */
  put: (action: { type: string; payload?: unknown }) => unknown;
}

/**
 * saga worker 签名：dva 以 (action, effectCommands) 调用（getSaga.js 的
 * sagaWithCatch），生成器面与 redux-saga 0.16 对齐（只消费 yield 命令）。
 */
export type EffectWorker<P = unknown> = (action: DvaAction<P>, cmd: EffectCommands) => Generator;

/**
 * dva 2 数组式 effect：[worker, { type: 'takeLatest' }]——getSaga.js 的
 * getWatcher 按 opts.type 挂 watcher（takeLatest 连发只保留最新一次）。
 */
export type TakeLatestEffect<P = unknown> = readonly [EffectWorker<P>, { type: 'takeLatest' }];

/**
 * 启动前全量注册的模型表。各模型以 DvaModel<S> 精确编写；注册面放宽为
 * DvaModelInput（type alias 隐式索引签名，dva 运行时本就只动态读键）。
 */
export const models: readonly DvaModelInput[] = [activityModel, uiModel, rosterModel, buildModel];
