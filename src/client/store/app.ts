/**
 * dva 单例 app（docs/21-client-ui-stack.md S6 / D19e）：惰性创建——
 * create（onError 接 diagnostics）→ 注册全部 model → start() 恰好一次 →
 * 暴露 app._store（官方用法：2.0.4 无 getStore()）。dva-core 的 start()
 * 没有二次调用守卫，单例纪律由本模块保证：createDvaApp 只经 getApp()
 * 的 null 检查触达一次。
 *
 * @module dsh-eteams/client/store/app
 */
import { create, type DvaApp } from 'dva-core';
import type { Store } from 'redux';
import { recordClientDiag } from '../lib/diagnostics';
import type { ActivityState } from '../lib/monitor';
import { models } from './models';
import type { BuildState } from './models/build';
import type { RosterState } from './models/roster';
import type { UiState } from './models/ui';

/**
 * 面板全局 state 拓扑（D19e）：四个 model + dva 内部键。S15 收口——
 * roster/build 类型补齐（S10 曾在 eteamsView 以 PanelRootState 局部扩展，
 * 类型并拢后该别名已删除）。
 */
export interface RootState {
  activity: ActivityState;
  ui: UiState;
  roster: RosterState;
  build: BuildState;
  '@@dva': unknown;
}

let app: DvaApp | null = null;

function createDvaApp(): DvaApp {
  const dvaApp = create({
    onError: (error) => {
      recordClientDiag('dva:onError', error instanceof Error ? error.message : String(error));
    },
  });
  // D19e：models 必须在 start() 前全量注册（start 后 app.model() 虽官方
  // 支持，但不依赖它）。
  for (const model of models) {
    dvaApp.model(model);
  }
  dvaApp.start();
  return dvaApp;
}

/**
 * 表面根部取单例 store：ETeamsView/TeamsButton/ETeamsCard… 各自包
 * <Provider store={getApp().store}>，单例 store 多 Provider 同 store 无害。
 */
export function getApp(): { store: Store<RootState> } {
  if (app === null) {
    app = createDvaApp();
  }
  return { store: app._store };
}
