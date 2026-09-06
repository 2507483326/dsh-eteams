/**
 * 路由表（docs/44 44.2.1，M1 新增）：面板壳内一棵 MemoryRouter——本插件是
 * DSH 宿主插件，不拥有浏览器 URL，且同屏可能有两个面板表面（整页覆盖层
 * teamsPanel + 槽位面板）各自渲染 ETeamsView，内存历史随表面挂载生、卸载
 * 灭，表面间零冲突。M1 挂五条基础路径（/board /team /roster /tasks
 * /reports）；M2 起逐域拆页：角色域 /roster 列表 + /roster/add 新增 +
 * /roster/:name 详情（见 roster/），M3 任务域 /tasks 列表 + /tasks/:taskId
 * 详情（见 tasks/），M4 团队域 /team 列表 + /team/:teamId 团队详情 +
 * /team/:teamId/member/:name 成员详情（见 team/）。
 *
 * ui model 保留为持久层与观察面：initialEntries 挂载时由 ui.activeNav 推导
 * （宿主换页/刷新重挂后回到上次页签——刷新恢复；M3 起任务页签 +
 * drawerTaskId 非空回落 /tasks/:taskId 恢复详情）；location 变化单向 sync
 * 回 store（ui/setNav + M3 起 /tasks 域的 ui/setDrawerTask），store 不反向
 * 驱动 location（防回环）。drawerTaskId 语义 = 任务详情页选中的任务 id
 * （八轮 DA21），/tasks 域外路径不触碰（ui model 独立键互不清空语义不变）。
 * 桥 pending 信号由壳的挂载 effect 派发 navigate（与迁移前同一 effect
 * 时序，见 index.tsx 桥 handler 段）。
 *
 * @module dsh-eteams/client/pages/teamsView/routes
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useDispatch } from 'react-redux';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { PrefillOutcome } from '../../lib/addPeople';
import type { RosterMember } from '../../lib/api';
import { navIdOfPath, navPathOfId } from '../../lib/status';
import type { MemberView, TeamSnapshot } from '../../lib/monitor';
import { getApp } from '../../store/app';
import { BoardTab } from '../board/boardPage';
import { ReportsTab } from '../reports/reportsPage';
import { MemberDetailPage } from '../team/memberDetailPage';
import { TeamDetailPage } from '../team/teamDetailPage';
import { TeamPage } from '../team/teamPage';
import { RosterAddPage } from '../roster/rosterAddPage';
import { RosterDetailPage } from '../roster/rosterDetailPage';
import { RosterPage } from '../roster/rosterPage';
import { TaskDetailPage } from '../tasks/taskDetailPage';
import { TasksPage } from '../tasks/tasksPage';

/** ================================== 类型 ================================== */

/**
 * 路由出口的页签数据（壳状态经 props 传入）：五个 tab 组件本体一行不动，
 * 数据流与迁移前逐位一致（壳 useSelector/useActivityMonitor → props）。
 */
export interface ETeamsRoutesProps {
  /** 看板：当前团队快照（undefined=尚无团队，BoardTab 空态兜底）。 */
  team: TeamSnapshot | undefined;
  /** 看板/任务共用：服务器时间（快照 serverTime/fetchedAt 派生）。 */
  now: number;
  /** 看板：快照拉取时刻（相对时间基准）。 */
  fetchedAt: number;
  /** 看板：快照加载失败原文（BoardTab 空态文案与壳错误条共用）。 */
  error: string | null;
  /** 团队：当前宿主会话 id（整页覆盖层 undefined）。 */
  sessionId: string | undefined;
  /** 团队：全部团队池（卡片栅格在这里选择）。 */
  pool: TeamSnapshot[];
  /** 团队/角色：成员库（拉人购物车与新增工作台共用）。 */
  roster: RosterMember[];
  /** 团队：每队成员上限（添加成员弹窗购物车配额）。 */
  memberCap: number;
  /** 团队：选中团队（详情进出与领队卡详情同流）。 */
  onSelectTeam: (teamId: string) => void;
  /** 团队：成员子代理活动点（childId → running/inactive）。 */
  agentActivity: Record<string, string>;
  /** 团队：领队卡「汇报」跳汇报页（壳 navigate('/reports') + 选成员）。 */
  onOpenReports: (name: string) => void;
  /** 角色：删除回拉（roster/fetchRoster）。 */
  onDeleted: () => void;
  /** 角色：一键预填 composer（'set'/'copied'/'aborted'）。 */
  onPrefillAddPeople: () => PrefillOutcome;
  /** 角色：创建卡片跳转信号（>0 打开新增工作台，docs/19.9.5）。 */
  openAddTick: number;
  /** 角色：信号消费回执（壳清零 openAddTick）。 */
  onAddTickConsumed: () => void;
  /** 汇报：成员选择（ui.dialogMember）。 */
  dialogMember: string | null;
  /** 汇报：成员选择回写。 */
  setDialogMember: (name: string | null) => void;
  /** 汇报：解析后的成员视图（消失的成员不崩渲染）。 */
  dialogMemberView: MemberView | null;
}

/** ================================== 子组件 ================================== */

/**
 * 面板路由根（每表面一棵，44.2.1）：内存历史挂载时由 ui model 持久值推导
 * 初始路径——刷新/宿主换页重挂后回到上次页签（持久层语义）。
 */
export function ETeamsRouter({ children }: { children: ReactNode }): ReactNode {
  // initialEntries 只在挂载时求值一次（useState 惰性初始化）：读单例 store
  // 的 ui model 持久值（activeNav → path，畸形值 navPathOfId 兜底 /board）。
  // M3：任务页签 + drawerTaskId 非空回落 /tasks/:taskId 恢复详情——重挂恢复
  // 口径与拆页前一致（壳曾把 ui.drawerTaskId 经 props 传给任务页作初始选中；
  // 任务已删时详情页 not-found 自动回 /tasks，无死路径）。
  const [initialEntries] = useState((): string[] => {
    const ui = getApp().store.getState().ui;
    if (ui.activeNav === 'tasks' && ui.drawerTaskId !== null) {
      return [`/tasks/${ui.drawerTaskId}`];
    }
    return [navPathOfId(ui.activeNav)];
  });
  return <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>;
}

/** ================================== 主组件 ================================== */

/**
 * 路由出口：location → store 单向 sync + 基础路径与拆页路由的页签元素表。
 * 挂在壳内容列原五段条件渲染的位置——路由切换的挂载/卸载语义与迁移前
 * 条件渲染逐位一致（离开即卸载，瞬态不复存在）。
 */
export function ETeamsViewRoutes(props: ETeamsRoutesProps): ReactNode {
  const location = useLocation();
  const dispatch = useDispatch();
  // location → store 单向 sync（44.2.1）：ui model 保留为持久层与观察面，
  // store 不反向驱动 location（防回环）。同值不 dispatch（避免无谓渲染）。
  // ui/setNav：五域页签归组（navIdOfPath 前缀匹配覆盖拆页子路由）。
  // ui/setDrawerTask（M3）：/tasks/:taskId 写入选中任务 id、/tasks（列表）
  // 写回 null（与拆页前返回条 setSelectedTaskId(null) 同一 dispatch）；
  // 其余路径不触碰——任务 tab 间切换本就不清 drawerTaskId（ui model 独立
  // 键互不清空语义不变）。
  useEffect(() => {
    const state = getApp().store.getState().ui;
    const nav = navIdOfPath(location.pathname);
    if (state.activeNav !== nav) {
      dispatch({ type: 'ui/setNav', payload: nav });
    }
    const taskPath = /^\/tasks\/(\d+)$/.exec(location.pathname);
    const taskSegment = taskPath?.[1];
    if (taskSegment !== undefined) {
      const id = Number(taskSegment);
      if (state.drawerTaskId !== id) {
        dispatch({ type: 'ui/setDrawerTask', payload: id });
      }
    } else if (location.pathname === '/tasks' && state.drawerTaskId !== null) {
      dispatch({ type: 'ui/setDrawerTask', payload: null });
    }
  }, [location.pathname, dispatch]);
  return (
    <Routes>
      <Route
        path="/board"
        element={
          <BoardTab
            team={props.team}
            now={props.now}
            fetchedAt={props.fetchedAt}
            error={props.error}
          />
        }
      />
      <Route
        path="/team"
        element={
          <TeamPage
            sessionId={props.sessionId}
            pool={props.pool}
            team={props.team}
            onSelectTeam={props.onSelectTeam}
          />
        }
      />
      {/* 团队域（M4 拆页）：/team 列表 + /team/:teamId 团队详情（:teamId 路由
          参数即原 detailId 态选中团队 id）+ /team/:teamId/member/:name 成员
          详情（:name 命中成员行 = 成员详情、命中领队名 = 领队详情——原
          memberDetail kind 语义并入路由）。react-router v6 路由排序静态段
          优先，/team 不会被 /team/:teamId 吞掉。 */}
      <Route
        path="/team/:teamId"
        element={
          <TeamDetailPage
            sessionId={props.sessionId}
            pool={props.pool}
            roster={props.roster}
            memberCap={props.memberCap}
            onSelectTeam={props.onSelectTeam}
            agentActivity={props.agentActivity}
          />
        }
      />
      <Route
        path="/team/:teamId/member/:name"
        element={
          <MemberDetailPage
            sessionId={props.sessionId}
            pool={props.pool}
            onSelectTeam={props.onSelectTeam}
            onOpenReports={props.onOpenReports}
          />
        }
      />
      {/* 角色域（M2 拆页）：/roster 列表 + /roster/add 新增工作台 +
          /roster/:name 详情（:name 路由参数即角色名）。react-router v6 路由
          排序静态段优先，/roster/add 不会被 /roster/:name 吞掉。 */}
      <Route
        path="/roster"
        element={
          <RosterPage
            members={props.roster}
            onDeleted={props.onDeleted}
            openAddTick={props.openAddTick}
            onAddTickConsumed={props.onAddTickConsumed}
          />
        }
      />
      <Route
        path="/roster/add"
        element={
          <RosterAddPage
            members={props.roster}
            onDeleted={props.onDeleted}
            onPrefillAddPeople={props.onPrefillAddPeople}
          />
        }
      />
      <Route
        path="/roster/:name"
        element={
          <RosterDetailPage members={props.roster} team={props.team} onDeleted={props.onDeleted} />
        }
      />
      {/* 任务域（M3 拆页）：/tasks 列表 + /tasks/:taskId 详情（:taskId 路由
          参数即选中任务 id）。react-router v6 路由排序静态段优先，/tasks 不
          会被 /tasks/:taskId 吞掉；team undefined 守卫原样保留。 */}
      <Route
        path="/tasks"
        element={props.team !== undefined ? <TasksPage team={props.team} /> : null}
      />
      <Route
        path="/tasks/:taskId"
        element={
          props.team !== undefined ? (
            <TaskDetailPage team={props.team} now={props.now} />
          ) : null
        }
      />
      <Route
        path="/reports"
        element={
          props.team !== undefined ? (
            <ReportsTab
              team={props.team}
              dialogMember={props.dialogMember}
              setDialogMember={props.setDialogMember}
              member={props.dialogMemberView}
            />
          ) : null
        }
      />
      {/* 未知路径兜底：落看板（原 activeTab 畸形兜底 'board' 同口径；正常
          流只在五条基础路径间导航，本条是防御位）。 */}
      <Route
        path="*"
        element={
          <BoardTab
            team={props.team}
            now={props.now}
            fetchedAt={props.fetchedAt}
            error={props.error}
          />
        }
      />
    </Routes>
  );
}