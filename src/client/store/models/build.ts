/**
 * build model（docs/21-client-ui-stack.md S10 / 21.5.3）：角色构建会话
 * （docs/19.6.2, D18）状态与副作用迁入 dva effects。工作台的轮询与五个动作
 * （fetch/confirm/cancel/restart/interview）改发 `build/…` action，不再直接
 * await api（api.ts 不动）。
 *
 * 轮询纪律（迁移前现状保持）：1.5s interval 留在视图层（原 eteamsView，
 * 已拆分至 pages/teamsView/，现住 roster/buildWorkbench.tsx 的
 * useBuildSession——roster 域三个路由页共用；角色构建师的 monitor 逻辑不动），
 * 本 model 只承接单次 fetch。失败语义分两档：
 * - fetch：落 state.error 后吞掉——迁移前 refreshBuild 就是
 *   `.catch(() => undefined)` 的静默面，且 1.5s 高频轮询，不上抛（不给
 *   onError 打无谓诊断），dispatch promise 照常 resolve。
 * - confirm/cancel/restart/submitInterview：落 state.error 后重新抛出——
 *   sagaWithCatch 转交 onError（store/app.ts 已接 diagnostics）并 reject
 *   dispatch promise；组件 catch 面与迁移前一致（确认失败提示、提交失败
 *   提示；放弃/继续构建的组件侧本来就吞错，行为不变）。
 *
 * effects 全部走 dva 2 数组式 takeLatest（getSaga.js getWatcher）：连发只留
 * 最新——1.5s 轮询期间上一次未完成的 fetch 会被自动取消，天然防叠。
 *
 * @module dsh-eteams/client/store/models/build
 */
import type { DvaAction } from 'dva-core';
import { errorMessageOf } from '../../lib/errors';
import {
  cancelBuild,
  confirmBuild,
  fetchBuildState,
  restartBuild,
  resumeBuild,
  submitInterview,
  type BuildDraft,
  type BuildSession,
} from '../../lib/api';
import type { EffectCommands, TakeLatestEffect } from './index';

/** 一组意图访谈答案（docs/19.16；api.submitInterview 的载荷面）。 */
export interface InterviewAnswer {
  id: string;
  choice: string;
}

/**
 * 构建会话状态（21.5.3）。session 为整包快照（null=无会话）；draft 是
 * session.draft 的便捷镜像，随 setSession 同步；error 承接动作失败的
 * 展示面（「失败 put setError」——合同状态行的 loading/session/draft 之外
 * 补充的槽位，与 roster model 同构）。
 */
export interface BuildState {
  session: BuildSession | null;
  draft: BuildDraft | null;
  loading: boolean;
  error: string | null;
}

/** fetch worker：call api.fetchBuildState → put 整包快照（null=无会话）。 */
function* fetchBuildWorker(_action: DvaAction<void>, { call, put }: EffectCommands): Generator {
  yield put({ type: 'setLoading', payload: true });
  try {
    const session = (yield call(fetchBuildState)) as BuildSession | null;
    yield put({ type: 'setSession', payload: session });
    yield put({ type: 'setError', payload: null });
  } catch (e) {
    // 静默面（见模块注释）：只落 state.error，不向上抛。
    yield put({ type: 'setError', payload: errorMessageOf(e) });
  } finally {
    yield put({ type: 'setLoading', payload: false });
  }
}

/**
 * confirm worker：确认草稿落库（宿主原子写 roster 并翻会话状态）。
 * payload 透传（dva 运行时不校验 payload 形状，调用方保证）。
 */
function* confirmBuildWorker(
  { payload }: DvaAction<BuildDraft>,
  { call, put }: EffectCommands,
): Generator {
  yield put({ type: 'setLoading', payload: true });
  try {
    yield call(confirmBuild, payload as BuildDraft);
    yield put({ type: 'setError', payload: null });
  } catch (e) {
    yield put({ type: 'setError', payload: errorMessageOf(e) });
    // 确认失败要可见：上抛让 dispatch promise reject，组件 catch 提示。
    throw e;
  } finally {
    yield put({ type: 'setLoading', payload: false });
  }
}

/** cancel worker：放弃会话并中断后台构建代理。 */
function* cancelBuildWorker(_action: DvaAction<void>, { call, put }: EffectCommands): Generator {
  yield put({ type: 'setLoading', payload: true });
  try {
    yield call(cancelBuild);
    yield put({ type: 'setError', payload: null });
  } catch (e) {
    yield put({ type: 'setError', payload: errorMessageOf(e) });
    // 上抛（组件侧迁移前就吞错，net 行为不变；失败仍有 onError/diagnostics 记录）。
    throw e;
  } finally {
    yield put({ type: 'setLoading', payload: false });
  }
}

/** resume worker：恢复已放弃的构建（宿主 followup 唤醒同一持续构建子代理接着跑）。 */
function* resumeBuildWorker(_action: DvaAction<void>, { call, put }: EffectCommands): Generator {
  yield put({ type: 'setLoading', payload: true });
  try {
    yield call(resumeBuild);
    yield put({ type: 'setError', payload: null });
  } catch (e) {
    yield put({ type: 'setError', payload: errorMessageOf(e) });
    // 上抛（组件侧迁移前就吞错，net 行为不变）。
    throw e;
  } finally {
    yield put({ type: 'setLoading', payload: false });
  }
}

/**
 * restart worker：手动重启构建代理——不答题也能派新代理重新核查/重新出题
 * （用户迭代）。失败要可见（父会话不在线/网络问题），上抛。
 */
function* restartBuildWorker(_action: DvaAction<void>, { call, put }: EffectCommands): Generator {
  yield put({ type: 'setLoading', payload: true });
  try {
    yield call(restartBuild);
    yield put({ type: 'setError', payload: null });
  } catch (e) {
    yield put({ type: 'setError', payload: errorMessageOf(e) });
    throw e;
  } finally {
    yield put({ type: 'setLoading', payload: false });
  }
}

/** submitInterview worker：提交意图访谈作答（宿主经 followup 发回代理续跑）。 */
function* submitInterviewWorker(
  { payload }: DvaAction<InterviewAnswer[]>,
  { call, put }: EffectCommands,
): Generator {
  yield put({ type: 'setLoading', payload: true });
  try {
    yield call(submitInterview, payload as InterviewAnswer[]);
    yield put({ type: 'setError', payload: null });
  } catch (e) {
    yield put({ type: 'setError', payload: errorMessageOf(e) });
    // 提交失败不再静默（迁移前注释即如此要求）：上抛，组件 catch 提示。
    throw e;
  } finally {
    yield put({ type: 'setLoading', payload: false });
  }
}

/** build model 类型面：reducers 按 action 精确 payload，effects 数组式 takeLatest。 */
type BuildModel = {
  namespace: 'build';
  state: BuildState;
  reducers: {
    setSession: (state: BuildState, action: DvaAction<BuildSession | null>) => BuildState;
    setLoading: (state: BuildState, action: DvaAction<boolean>) => BuildState;
    setError: (state: BuildState, action: DvaAction<string | null>) => BuildState;
  };
  effects: {
    fetchBuild: TakeLatestEffect<void>;
    confirmBuild: TakeLatestEffect<BuildDraft>;
    cancelBuild: TakeLatestEffect<void>;
    restartBuild: TakeLatestEffect<void>;
    resumeBuild: TakeLatestEffect<void>;
    submitInterview: TakeLatestEffect<InterviewAnswer[]>;
  };
};

export const buildModel: BuildModel = {
  namespace: 'build',
  state: { session: null, draft: null, loading: false, error: null },
  reducers: {
    // 整包快照替换；draft 为 session.draft 镜像（无会话/无草稿 → null）。
    setSession: (state, { payload }) => {
      const session = payload ?? null;
      return { ...state, session, draft: session?.draft ?? null };
    },
    setLoading: (state, { payload }) => ({ ...state, loading: payload === true }),
    // 错误槽整体置位：null/缺省即清除（每次成功调用后清掉上一次失败痕迹）。
    setError: (state, { payload }) => ({
      ...state,
      error: typeof payload === 'string' ? payload : null,
    }),
  },
  effects: {
    // dva 2 数组式 takeLatest（字面量经上下文类型收窄，不写成共享常量——
    // models/index.ts 与本文件间只允许 type 环，值回流会有 TDZ 风险）。
    fetchBuild: [fetchBuildWorker, { type: 'takeLatest' }],
    confirmBuild: [confirmBuildWorker, { type: 'takeLatest' }],
    cancelBuild: [cancelBuildWorker, { type: 'takeLatest' }],
    restartBuild: [restartBuildWorker, { type: 'takeLatest' }],
    resumeBuild: [resumeBuildWorker, { type: 'takeLatest' }],
    submitInterview: [submitInterviewWorker, { type: 'takeLatest' }],
  },
};
