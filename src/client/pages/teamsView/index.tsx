/**
 * The 团队 activity panel (docs/13.3, M4.5 IA): left rail with 看板/团队/角色/
 * 任务, members-first flow (D16), team creation by name only.
 * Renders over host theme variables so light/dark follows the GUI.
 *
 * S12 样式迁移批次一（docs/21-client-ui-stack.md 21.6 / D19b/D19c/D19g）：
 * 侧栏导航、看板（横幅/目标/进度）与最近动态（事件流）三个区块的 inline
 * style 迁 Tailwind 类，卡片容器换 shadcn Card、阶段徽标换 shadcn Badge。
 * 落地注记（沿用 S5 card 试点 / S11 模式）：
 * - D19b：本面板注册在宿主 conversation.view 槽位，宿主视图区没有
 *   `.eteams-ui` 祖先——表面根挂 `className="eteams-ui"` 字面量，工具类
 *   （后代选择器）才能生效；作用域根自身不承工具类样式，面板壳布局由
 *   styles.root inline 承载（S12 时 content 列与余下区块尚未迁移——
 *   「不加裸包裹层破坏 h-100% 高度链」的顾虑在 S14 落锚点后解除，见
 *   S14 注记）。
 * - preflight 已关：`border` 只产宽度，显式 `border-solid` 补边框样式；
 *   边框色沿用原 l1 档（S3 桥默认是 l2），任意值直引保持视觉（S11 先例）。
 * - D19c：语义色走 token 类（text-foreground / text-muted-foreground /
 *   text-primary / text-success / text-warning / text-destructive /
 *   text-business）；无 token 桥接的宿主变量（label-secondary、bg-layer-2、
 *   static-amber-100 等）任意值直引；token 色禁 /alpha。运行时动态值只留
 *   进度条宽度（inline style，S14 清点口径，S5 card 先例）。
 * - 状态徽标：Tone→完整字面量类映射表 TONE_CLASS（禁模板字符串拼类名，
 *   21.5.1 content 扫描纪律），阶段徽标以 outline Badge 呈现（S5 card 先例）。
 *
 * S13 样式迁移批次二（docs/21-client-ui-stack.md 21.6 / D19b/D19g）：成员
 * （团队成员栅格 LeaderCard/MemberCard、汇报成员选择与成员汇报时间线）与
 * 任务（TasksTab/TaskStations）两区块的 inline style 迁 Tailwind 类；任务
 * 详情抽屉升级为 shadcn Dialog（本步 vendoring components/ui/dialog.tsx，
 * 并新增自管 portal 容器 components/ui/portal.ts——Radix 默认 portal 到
 * body 会逃出 `.eteams-ui` 作用域，改挂 body 下 `eteams-ui-portal eteams-ui`
 * 容器）。开合状态走 ui model（ui/setDrawerTask）；（2026-09-05 八轮 DA21
 * 页面化后该状态语义 = 详情页选中的任务 id，原 Dialog 抽屉撤除；M3 起
 * 读写两端见 routes.tsx location sync 与 tasks/ 两页）。执行槽
 * 站点 ✔/●/◌ 结构原样保留，仅类名替换。
 *
 * S14 收尾批次（docs/21-client-ui-stack.md 21.6 / D19b/D19c）：面板壳
 * （styles.root/content）与余下区块（团队卡片栅格/新建团队/草稿预览/构建
 * 工作台/角色库/详情/分页）inline style 全部迁 Tailwind 类，卡片容器统一
 * shadcn Card（PANEL_CARD_CLASS 覆盖层）。作用域根（.eteams-ui）自身不承
 * 工具类（`.eteams-ui .utility` 后代选择器机制，S12 注记）——壳布局迁进
 * 一层内壳（SHELL_CLASS），高度链锚点 height:100% 保留在作用域根 inline
 * （宿主视图区无 .eteams-ui 祖先，内壳 h-full 只能解析到这里；S13 注记的
 * 「裸包裹层」顾虑即指此处，锚点落根后高度链与迁移前逐位等价）。styles /
 * fns / TONE_FG / TONE_BG / PILL_FG 随迁移删除（死代码清理）；PHASE_LABELS
 * 合并至 phaseLabels.ts（S15 收尾：teamsButton 直连该模块，本文件 re-export
 * 已撤）。
 * 残余 inline 仅：进度条宽度（运行时动态）×2 与壳高度锚点 ×1。
 *
 * M1 路由骨架（docs/44 44.2.1，2026-09-06）：面板壳内挂一棵 MemoryRouter
 * （ETeamsRouter，路由表见 routes.tsx）——rail 宽窄两套点击改 useNavigate
 * （location 为唯一导航驱动源），五 tab 出口改 Routes（基础路径渲染各 tab，
 * M2/M3/M4 逐域拆页）；location 变化单向 sync 回 store
 * （ui/setNav + M3 起 /tasks 域的 ui/setDrawerTask，均在 routes.tsx 内），
 * ui.activeNav 降为持久层与观察面（刷新/换页
 * 重挂时经 initialEntries 恢复上次页签）。桥信号 handler 改 navigate，
 * openAddTick 等组件内瞬态语义保留。
 *
 * M8 目录重排（docs/44 44.2.4，2026-09-06）：侧栏（宽窄两套 + 筛选框）拆
 * rail.tsx（PanelRail）——宽/窄档位测量锚点是本文件的作用域根
 * 元素，useLayoutEffect/ResizeObserver 测量留驻壳内、railWide 经 props 传入
 * （阈值常量 RAIL_WIDE_MIN_WIDTH 自 rail 导入，单一档位源）。
 *
 * @module dsh-eteams/client/pages/teamsView/index
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
// docs/28 Token 消耗日历（board/usageCalendar.tsx）：tsdown 虚拟 CSS 插件以
// 字符串载入，见 usageCalendarCss.d.ts / tsdown.config.ts usageTooltipsCssInline。
import { Provider, useDispatch, useSelector } from 'react-redux';
import { useLocation, useNavigate } from 'react-router-dom';
import { prefillComposer, type PrefillOutcome } from '../../lib/addPeople';
import {
  consumePendingGotoAdd,
  consumePendingGotoRoster,
  consumePendingSelectTeam,
  GOTO_ADD_EVENT,
  GOTO_ROSTER_EVENT,
  SELECT_TEAM_EVENT,
} from '../../lib/bridge';
import { navIdOfPath } from '../../lib/status';
import { ClientErrorBoundary } from '../../lib/diagnostics';
import { Toaster } from '../../components/ui/toaster';
import { usePoll } from '../../hooks/usePoll';
import { EteamsBackdrop } from '../../features/backdrop/eteamsBackdrop';
import { fetchAgentActivity } from '../../lib/api';
import { useActivityMonitor } from '../../lib/monitor';
import { getApp, type RootState } from '../../store/app';
import { FormErrorNote, PageHeader } from '../shared/components';
import { ROLE_LIST_CSS } from '../shared/styles';
import { PanelRail, RAIL_WIDE_MIN_WIDTH } from './rail';
import { ETeamsRouter, ETeamsViewRoutes } from './routes';

/** ================================== 样式类 ================================== */

/* styles/fns 两个 inline 工厂已随 S14 收尾迁移整体删除（docs/21 21.6 死
代码清理）：styles.* → 各批次落位的类名常量（或沿用 S12/S13 既有类常量），
fns.pill → pillClass（S13 已备、本批全面板统一），
fns.progressFill → PROGRESS_FILL_CLASS + 宽度百分比 inline（S5 card 先例：
运行时动态值保留 inline，S14 清点口径）。类名常量纪律同全仓：完整字面量，
模板串组合仅限 const 字面量插值，运行时动态值一律 inline style（S5/S11
既有口径）；侧栏族类常量见 rail.tsx（M8 拆出）。 */

/** 面板壳（原 styles.root 的布局面）：作用域根（.eteams-ui）自身不承工具类
（`.eteams-ui .utility` 后代选择器机制），壳布局迁进这层内壳；height 锚点
仍留作用域根 inline（宿主视图区无 .eteams-ui 祖先，见文件头 S14 注记）。
D22d 排版基线：官网侧栏/prose-sm 尺度 14px/24（原 13px/1.55 钉死档）。 */
const SHELL_CLASS =
  'relative box-border flex h-full gap-4 overflow-hidden px-[18px] py-3.5 text-sm leading-6 text-foreground font-sans';
/** 原 styles.content：内容列（纵滚/横截 + 2px 右距，用户反馈注记原样保留）。
 * 用户迭代 2026-09-07「列表页容器卡片满高」：改纵 flex 列——页头 auto、
 * 路由页根 flex-1（角色/任务页头在壳层、团队页头在页内，两态同链）。 */
const CONTENT_CLASS = 'flex min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto pr-0.5';
/* docs/23 S23-3：原 styles.formError（FORM_ERROR_CLASS）迁移 FormErrorNote
   （shadcn Alert destructive 紧凑档，见上方组件），常量删除。 */

/** ================================== 子组件 ================================== */

/**
 * Panel body — mounted inside the Provider and the panel MemoryRouter
 * (see {@link ETeamsView}).
 * S8/S9（docs/21-client-ui-stack.md）：团队选择迁入 ui model——activeId 经
 * useSelector 读取（ui.selectedTeamId），变更走 useDispatch 发
 * `ui/setSelectedTeam`；drawerTaskId 同为 ui model
 * 持久键（八轮 DA21 后语义 = 任务详情页选中的任务 id），M3 起由 routes.tsx
 * 的 location sync 回写（/tasks/:taskId ↔ 详情选中），壳不再读取。
 * M1 起**面板导航改路由驱动**：location 是唯一导航驱动源
 * （rail 点击与桥跳转都走 navigate，见 routes.tsx），activeTab 由
 * location 派生；ui.activeNav 不再被壳读取，仅作持久层/观察面
 * （location 经 routes.tsx 单向 sync 回写，重挂时恢复上次页签）。
 * 输入草稿、悬停、openAddTick 信号等组件内瞬态仍留 useState。
 */
function ETeamsViewBody(props: ConvViewProps): ReactNode {
  const state = useActivityMonitor();
  const dispatch = useDispatch();
  // M1 路由骨架：location = 唯一导航驱动源，activeTab 由路径查表派生
  // （navIdOfPath 未知值兜底 board——原 activeTab 畸形兜底同口径）。
  const location = useLocation();
  const navigate = useNavigate();
  // 变量名沿用迁移前语义：activeId=当前选中团队。
  const activeId = useSelector((s: RootState) => s.ui.selectedTeamId);
  // S10：成员库列表迁入 roster model——useSelector 读、refreshRoster 发
  // `roster/fetchRoster`（takeLatest 防叠）。
  const roster = useSelector((s: RootState) => s.roster.list);
  // 成员子代理活动点（docs/20.4 P4）：childId → running/inactive。旧运行时
  // 无 listChildren 时返回空表——面板不渲染点，不误导。
  const [agentActivity, setAgentActivity] = useState<Record<string, string>>({});
  // 创建卡片/弹层跳转信号（docs/19.9.5）：递增计数驱动角色列表页
  // （roster/rosterPage，M2 拆页）打开新增页。
  const [openAddTick, setOpenAddTick] = useState(0);
  // docs/22 S22-2：面板作用域根宽 ≥ RAIL_WIDE_MIN_WIDTH（rail
  // 导出的宽栏阈值）用官网风格宽栏，否则回落 84px 窄栏。测量锚点是本作用域
  // 根元素（rail 组件自身体宽随布局浮动，不能作锚）——useLayoutEffect
  // 首帧前同步测量避免闪栏，ResizeObserver 跟随布局变化，
  // 仅在阈值两侧翻转时 setState（不重渲染 spam）。观察器缺失（老内核）恒宽栏。
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [railWide, setRailWide] = useState(true);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const measure = (width: number): void => {
      const next = width >= RAIL_WIDE_MIN_WIDTH;
      setRailWide((prev) => (prev === next ? prev : next));
    };
    const ro = new ResizeObserver((entries) => {
      measure(entries[0]?.contentRect.width ?? el.clientWidth);
    });
    ro.observe(el);
    measure(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const h = (): void => {
      // 已挂载路径由窗口事件处理；顺带消费 pending 标记，防止标记滞留到
      // 下一次挂载时把用户误拽回创建页（docs/19.16）。
      consumePendingGotoAdd();
      // M1：跳转改 navigate（location 为唯一导航驱动源）；ui/setNav 由
      // routes.tsx 的 location sync 回写（持久层更新不再在此直发）。
      navigate('/roster');
      setOpenAddTick((t) => t + 1);
    };
    // 「成员 tab」信号（按钮成员选中直达，docs/13.8.2）：落成员页，不带新增表单。
    const hRoster = (): void => {
      consumePendingGotoRoster();
      navigate('/roster');
    };
    // 选中某个团队（弹层团队行点击）：board 视图随选择联动。M1 无团队详情
    // 路由（/team/:teamId 随 M4）——选择仍是纯 store 语义，不导航。
    const hSelect = (event?: Event): void => {
      const id =
        event === undefined ? consumePendingSelectTeam() : (event as CustomEvent<string>).detail;
      if (typeof id === 'string' && id !== '')
        dispatch({ type: 'ui/setSelectedTeam', payload: id });
    };
    window.addEventListener(GOTO_ADD_EVENT, h);
    window.addEventListener(GOTO_ROSTER_EVENT, hRoster);
    window.addEventListener(SELECT_TEAM_EVENT, hSelect);
    // 补消费挂载前的跳转信号：跳转方先点宿主 tab 再触发本面板
    // 挂载，窗口事件会错过——pending 标记在这里兜底（docs/19.16）。
    // 跳转以 navigate 落地（时序与迁移前 setNav 同为挂载 effect，首帧
    // 短暂呈现持久页签后跳转，零观感差异）。
    if (consumePendingGotoAdd()) h();
    if (consumePendingGotoRoster()) hRoster();
    hSelect();
    return () => {
      window.removeEventListener(GOTO_ADD_EVENT, h);
      window.removeEventListener(GOTO_ROSTER_EVENT, hRoster);
      window.removeEventListener(SELECT_TEAM_EVENT, hSelect);
    };
  }, [dispatch, navigate]);

  // docs/35 §5：goal 砍掉后快照不再有 captainSessionId——面板不再按会话
  // 过滤，直接展示全部团队（跨会话聚合口径与看板一致）。
  const pool = state.teams;
  // Derived (no effect): stale/null selection falls back to the first team.
  const team = pool.find((t) => t.teamId === activeId) ?? pool[0];
  const now = state.serverTime || state.fetchedAt;
  // M1：activeTab 由 location 查表派生（navIdOfPath 未知值兜底 board——原
  // 畸形 activeNav 兜底同口径）；rail 高亮的 activeTab 由 PanelRail 自查
  // （同源同值，见 rail.tsx）。
  const activeTab = navIdOfPath(location.pathname);

  const refreshRoster = useCallback((): void => {
    // S10：直接 await api 的调用点改 dispatch。失败由 effect 落
    // state.error——迁移前这里 .catch(() => undefined) 同为静默面。
    void dispatch({ type: 'roster/fetchRoster' });
  }, [dispatch]);
  useEffect(() => {
    if (activeTab === 'roster' || activeTab === 'team') refreshRoster();
  }, [activeTab, refreshRoster]);

  // 活动点轮询：跟随当前选中的团队，3s 节流（docs/20.4 P4）。M7-8 收口
  // usePoll：挂载/换队即拉一次 + interval 重拉 + 卸载/换队清理（pull 身份
  // 随 team 变化重启轮询，同原 effect deps）；异步回包经 isCurrent 判定本轮
  // 询代仍存活（与原 alive 旗号同语义）才回写，防陈旧团队快照。无选中团队
  // 时 pull 空转（原 effect 早退——不拉不轮询，观察面一致）。
  const pullAgentActivity = useCallback(
    (isCurrent: () => boolean): void => {
      if (team === undefined) return;
      void fetchAgentActivity(team.teamId)
        .then((a) => {
          if (isCurrent()) setAgentActivity(a);
        })
        .catch(() => undefined);
    },
    [team],
  );
  usePoll(pullAgentActivity, 3000);

  // 一键预填（docs/19.7.1, D18-1）：共享 helper（addPeople.ts）把命令写入
  // 对话输入框并聚焦；inputActions 不可用时退化为剪贴板复制。不自动发送。
  const prefillAddPeople = useCallback((): PrefillOutcome => {
    const actions = (props as { inputActions?: { setDraft: (text: string) => void } }).inputActions;
    return prefillComposer(actions);
  }, [props]);

  // 表面根（D19b/S12/S14）：宿主 conversation.view 槽位渲染本面板，视图区
  // 没有 .eteams-ui 祖先——作用域类字面量必须挂在本元素上。作用域根自身不承
  // 工具类（后代选择器机制），壳布局迁进内壳 SHELL_CLASS；唯一保留的 inline
  // 是高度链锚点 height:100%（内壳 h-full 只能解析到作用域根，见文件头 S14
  // 注记），其余壳样式全部工具类化。
  return (
    <div
      className="eteams-ui"
      style={{ height: '100%', position: 'relative' }}
      data-eteams="view"
      ref={rootRef}
    >
      {/* 背景板（docs/22 S22-4）：absolute inset-0 打底，纯装饰零交互；壳
        relative 盖上（两个定位元素按 DOM 序 painting），内容永远可读。 */}
      <EteamsBackdrop />
      {/* shadcn Toaster（docs/43 十九轮）：操作结果轻提示（成员保存/同步、
        剪贴板反馈——原就地瞬时文案迁 toast()）。Radix Toast Viewport 就地
        渲染无 portal，必须在 .eteams-ui 子树内；store 是模块级单例，
        useToast().toast() 任意处发、这里统一渲染（其它表面自挂自渲染）。 */}
      <Toaster />
      {/* 卡片化样式（用户反馈）：角色/团队卡片与删除按钮的悬停态一次注入，
        面板内与整页团队页共用同一渲染根，注入一次即可。 */}
      <style>{ROLE_LIST_CSS}</style>
      <div className={SHELL_CLASS}>
        {/* 侧栏（M8 自本文件拆出 rail.tsx）：宽/窄两套渲染与筛选框
          在组件内，宽/窄档位由这里的实测结果经 props 传入。 */}
        <PanelRail railWide={railWide} />

        <div className={CONTENT_CLASS}>
          {/* 页签标题（S24-2，官网 h2 签名）：每 tab 内容区顶部一行页头。
            团队域页头由 team/ 页自渲染（列表页与成员详情页保留「＋ 新增团队」
            ——团队详情页页头按钮撤，用户迭代 2026-09-07）。返回钮（用户迭代
            2026-09-08：页面返回统一收口 PageHeader onBack 槽，components/
            backButton 图标钮）：角色/任务域拆分子路由（/roster/add、
            /roster/:name、/tasks/:taskId）时在页头行最右渲染返回钮，落回本
            域列表路由——列表页本身（/roster、/tasks）不渲染。 */}
          {activeTab === 'board' && <PageHeader label="看板" />}
          {activeTab === 'roster' && (
            <PageHeader
              label="角色"
              onBack={location.pathname !== '/roster' ? () => navigate('/roster') : undefined}
            />
          )}
          {activeTab === 'tasks' && (
            <PageHeader
              label="任务"
              onBack={location.pathname !== '/tasks' ? () => navigate('/tasks') : undefined}
            />
          )}
          {/* 顶栏（用户反馈）：团队切换改为「团队」页的卡片栅格，这里只保留
            状态加载失败的就地提示；空态兜底在 BoardTab。 */}
          {state.error !== null && (
            <FormErrorNote className="mb-3">状态加载失败：{state.error}</FormErrorNote>
          )}

          {/* M1 路由出口（routes.tsx）：基础路径渲染各 tab，M2/M3 起角色/
            任务域为拆页路由——路由切换的挂载/卸载语义与迁移前条件渲染
            逐位一致（离开即卸载，瞬态不复存在）；tasks 的 team
            undefined 守卫原样保留。 */}
          <ETeamsViewRoutes
            team={team}
            now={now}
            fetchedAt={state.fetchedAt}
            error={state.error}
            sessionId={props.sessionId}
            pool={pool}
            roster={roster}
            memberCap={state.maxMembers}
            onSelectTeam={(id) => dispatch({ type: 'ui/setSelectedTeam', payload: id })}
            agentActivity={agentActivity}
            onDeleted={refreshRoster}
            onPrefillAddPeople={prefillAddPeople}
            openAddTick={openAddTick}
            onAddTickConsumed={() => setOpenAddTick(0)}
          />
        </div>
      </div>
    </div>
  );
}

/** ================================== 主组件 ================================== */

/**
 * The eteams conversation view entry — the M4.5 activity panel. 表面根：
 * Provider 包整个面板（S6/D19e），面板体在 Provider 之内消费 dva store；
 * ClientErrorBoundary 保持面板级降级路径不变。M1：面板体包一棵
 * MemoryRouter（routes.tsx）——整页团队页与槽位面板各自渲染 ETeamsView，
 * 各自一棵内存历史天然隔离。
 */
export function ETeamsView(props: ConvViewProps): ReactNode {
  return (
    <Provider store={getApp().store}>
      <ClientErrorBoundary label="团队面板">
        <ETeamsRouter>
          <ETeamsViewBody {...props} />
        </ETeamsRouter>
      </ClientErrorBoundary>
    </Provider>
  );
}
