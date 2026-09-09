/**
 * ui model（docs/21-client-ui-stack.md S8/S9）：面板全局 UI 状态——第一批
 * 导航与选择（S8：activeNav/selectedTeamId），第二批抽屉（S9：
 * drawerTaskId；同批的 dialogMember 已随汇报页撤除，用户迭代 2026-09-08）。
 * 原 eteamsView（已拆分至 pages/teamsView/）
 * 的对应 useState 已删除：Provider
 * 包在表面根（ETeamsView），面板体经 useSelector 读、useDispatch 发
 * `ui/setNav` / `ui/setSelectedTeam` / `ui/setDrawerTask`；
 * goto 桥（consumePendingGoto* / SELECT_TEAM_EVENT）触发的目标状态同样走
 * 这些 action，桥本身（bridge.ts 的 pending 标记/窗口事件）不动。输入草稿、
 * 悬停、openAddTick 信号等组件内瞬态仍留 useState。
 *
 * M1 路由骨架（docs/44 44.2.1，2026-09-06）：面板导航改路由驱动——
 * MemoryRouter（每表面一棵，routes.tsx）的 location 是唯一导航驱动源，
 * location 变化经 routes.tsx 单向 sync 回写 activeNav，本 model 降为
 * **持久层与观察面**：壳不再读 activeNav 渲染（activeTab 由 location 派生），
 * 重挂时由 initialEntries 恢复上次页签；store 不反向驱动 location（防回环）。
 *
 * @module dsh-eteams/client/store/models/ui
 */
import type { DvaModel } from 'dva-core';

/** 面板全局 UI 状态（21.5.3）：纯 reducers；组件内瞬态仍留 useState。 */
export interface UiState {
  /** 侧栏当前 tab（四值与 lib/status.ts NAV_ITEMS 的 id 对齐）。M1 起为
   * 路由的持久层/观察面：由 routes.tsx 的 location sync 回写，壳渲染不读它
   * （activeTab 由 location 派生），重挂时经 initialEntries 恢复。 */
  activeNav: 'board' | 'team' | 'roster' | 'tasks';
  /** 当前选中团队（board 联动与弹层跳转共用；null=未选）。 */
  selectedTeamId: string | null;
  /** 任务详情抽屉当前展开的任务 id（docs/27：库内整数号；null=全部收起）。
   * M3 起由 routes.tsx 的 location sync 回写（/tasks/:taskId 写 id、/tasks
   * 写 null、其余路径不触碰），重挂经 initialEntries 恢复详情。 */
  drawerTaskId: number | null;
}

export const uiModel: DvaModel<UiState> = {
  namespace: 'ui',
  state: {
    activeNav: 'board',
    selectedTeamId: null,
    drawerTaskId: null,
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
    // S9 抽屉开关（payload 语义与迁移前 setExpandedTask 对齐）：显式 null 是
    // 明确的「收起」信号（八轮 DA21 后 drawerTaskId 语义 = 任务详情页选中
    // 的任务 id，「返回列表」靠 null 关闭），payload 缺省不能像上面那样
    // 沿用当前值——那会让 null 关不掉抽屉，破坏迁移前行为。故 payload 只认
    // number（任务号已随 docs/27 编号数字化，docs/35 §5#11），非 number
    // （含缺省 undefined）一律归一 null，防御畸形 dispatch 不留悬挂展开态。
    setDrawerTask: (state, { payload }) => ({
      ...state,
      drawerTaskId: typeof payload === 'number' ? payload : null,
    }),
  },
};
