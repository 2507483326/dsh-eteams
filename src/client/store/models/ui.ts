/**
 * ui model（docs/21-client-ui-stack.md S8，a：导航与选择）：面板全局 UI
 * 状态第一批——侧栏导航 activeNav 与当前选中团队 selectedTeamId。eteamsView
 * 的对应 useState 已删除：Provider 包在表面根（ETeamsView），面板体经
 * useSelector 读、useDispatch 发 `ui/setNav` / `ui/setSelectedTeam`；goto 桥
 * （consumePendingGoto* / SELECT_TEAM_EVENT）触发的目标状态同样走这两个
 * action，桥本身（bridge.ts 的 pending 标记/窗口事件）不动。抽屉/对话框等
 * 开关状态随 S9 迁入；组件内瞬态（输入草稿、悬停等）仍留 useState。
 *
 * @module dsh-eteams/client/store/models/ui
 */
import type { DvaModel } from 'dva-core';

/** 面板全局 UI 状态（21.5.3）：纯 reducers；组件内瞬态仍留 useState。 */
export interface UiState {
  /** 侧栏当前 tab（与 eteamsView 的 tabs 五值对齐）。 */
  activeNav: 'board' | 'team' | 'roster' | 'tasks' | 'reports';
  /** 当前选中团队（board 联动与弹层跳转共用；null=未选）。 */
  selectedTeamId: string | null;
}

export const uiModel: DvaModel<UiState> = {
  namespace: 'ui',
  state: {
    activeNav: 'board',
    selectedTeamId: null,
  },
  reducers: {
    // payload 语义与迁移前 setTab 对齐：五值 tab id 原样落 state；畸形值由
    // 组件侧 activeTab 派生兜底（tabs.some → 'board'），不会渲染出未定义
    // 视图。payload 缺省沿用当前值（dva 运行时不校验 payload，对齐 activity
    // setError 的防御式写法）。
    setNav: (state, { payload }) => ({
      ...state,
      activeNav: (payload ?? state.activeNav) as UiState['activeNav'],
    }),
    // payload 语义与迁移前 setActiveId 对齐：非空字符串守卫留在调用点
    // （goto 桥 handler 的 typeof/!=='' 检查原样保留）；null 仅为未选初始态。
    setSelectedTeam: (state, { payload }) => ({
      ...state,
      selectedTeamId: (payload ?? state.selectedTeamId) as UiState['selectedTeamId'],
    }),
  },
};
