/**
 * ui model（docs/21-client-ui-stack.md S8/S9）：面板全局 UI 状态——第一批
 * 导航与选择（S8：activeNav/selectedTeamId），第二批抽屉与对话框（S9：
 * drawerTaskId/dialogMember）。原 eteamsView（已拆分至 pages/teamsView/）
 * 的对应 useState 已删除：Provider
 * 包在表面根（ETeamsView），面板体经 useSelector 读、useDispatch 发
 * `ui/setNav` / `ui/setSelectedTeam` / `ui/setDrawerTask` / `ui/setDialogMember`；
 * goto 桥（consumePendingGoto* / SELECT_TEAM_EVENT）触发的目标状态同样走
 * 这些 action，桥本身（bridge.ts 的 pending 标记/窗口事件）不动。输入草稿、
 * 悬停、openAddTick 信号等组件内瞬态仍留 useState。
 *
 * @module dsh-eteams/client/store/models/ui
 */
import type { DvaModel } from 'dva-core';

/** 面板全局 UI 状态（21.5.3）：纯 reducers；组件内瞬态仍留 useState。 */
export interface UiState {
  /** 侧栏当前 tab（与 teamsView 壳 index.tsx 的 tabs 五值对齐）。 */
  activeNav: 'board' | 'team' | 'roster' | 'tasks' | 'reports';
  /** 当前选中团队（board 联动与弹层跳转共用；null=未选）。 */
  selectedTeamId: string | null;
  /** 任务详情抽屉当前展开的任务 id（null=全部收起）。 */
  drawerTaskId: string | null;
  /** 成员对话框当前选中的成员名（null=未选，即「— 选择 —」空态）。 */
  dialogMember: string | null;
}

export const uiModel: DvaModel<UiState> = {
  namespace: 'ui',
  state: {
    activeNav: 'board',
    selectedTeamId: null,
    drawerTaskId: null,
    dialogMember: null,
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
    // S9 抽屉/对话框开关（payload 语义与迁移前 setExpandedTask / setDialogMember
    // 对齐）：显式 null 是明确的「收起/未选」信号（任务行 toggle 与「— 选择 —」
    // 都靠 null 关闭），payload 缺省不能像上面那样沿用当前值——那会让 null
    // 关不掉抽屉/对话框，破坏迁移前行为。故 payload 只认 string，非 string
    // （含缺省 undefined）一律归一 null，防御畸形 dispatch 不留悬挂展开态。
    // 互斥保持迁移前现状：两键相互独立、互不清空对方——抽屉在任务 tab、
    // 对话框在汇报 tab 渲染，tab 切换天然互斥（onOpenReports 仍只派发
    // setDialogMember + setNav，不额外动 drawerTaskId）。
    setDrawerTask: (state, { payload }) => ({
      ...state,
      drawerTaskId: typeof payload === 'string' ? payload : null,
    }),
    setDialogMember: (state, { payload }) => ({
      ...state,
      dialogMember: typeof payload === 'string' ? payload : null,
    }),
  },
};
