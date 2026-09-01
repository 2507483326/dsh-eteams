/**
 * ui model 骨架（docs/21-client-ui-stack.md S6）：面板全局 UI 状态——
 * 仅落初始形状；S8（a：导航与选择）才把 eteamsView 的 activeNav/
 * selectedTeamId useState 迁入，抽屉/对话框/goto 桥接随 S9 迁移。
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
};
