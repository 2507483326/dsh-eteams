/**
 * 模型聚合（docs/21-client-ui-stack.md S6 / D19e）：全部模型集中在此，
 * store/app.ts 在 start() 前全量注册；新增 model 在此追加——start() 后
 * 不得再 app.model()（本仓不依赖启动后注册的官方支持）。
 *
 * @module dsh-eteams/client/store/models
 */
import type { DvaModelInput } from 'dva-core';
import { activityModel } from './activity';
import { uiModel } from './ui';

/**
 * 启动前全量注册的模型表。各模型以 DvaModel<S> 精确编写；注册面放宽为
 * DvaModelInput（type alias 隐式索引签名，dva 运行时本就只动态读键）。
 */
export const models: readonly DvaModelInput[] = [activityModel, uiModel];
