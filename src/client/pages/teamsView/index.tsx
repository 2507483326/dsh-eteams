/**
 * The 团队 activity panel (docs/13.3, M4.5 IA): left rail with 看板/团队/角色/
 * 任务/汇报, members-first flow (D16), team creation by name only.
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
 * 容器）。开合状态不变：expandedTask 仍走 ui model（ui/setDrawerTask），
 * 抽屉仅展开时挂载（track 拉取随挂载触发，同迁移前）、关闭发 null。执行槽
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
 * @module dsh-eteams/client/pages/teamsView/index
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
// lucide 深层图标导入（dialog.tsx 先例：主入口 icons 命名空间再导出会让
// rolldown 拖全量图标进 envelope，深层 .mjs 路径只进用到的图标；类型垫片见
// components/ui/lucide-icon.d.ts）。D22f：emoji 清零的替换位。
import Search from 'lucide-react/dist/esm/icons/search.mjs';
// docs/28 Token 消耗日历（usageCalendar.tsx）：tsdown 虚拟 CSS 插件以字符串
// 载入，见 usageCalendarCss.d.ts / tsdown.config.ts usageTooltipsCssInline。
import { Provider, useDispatch, useSelector } from 'react-redux';
import { prefillComposer, type PrefillOutcome } from '../../lib/addPeople';
import {
  consumePendingGotoAdd,
  consumePendingGotoRoster,
  consumePendingSelectTeam,
  GOTO_ADD_EVENT,
  GOTO_ROSTER_EVENT,
  SELECT_TEAM_EVENT,
} from '../../lib/bridge';
import { cn } from '../../lib/cn';
import { ClientErrorBoundary } from '../../lib/diagnostics';
import { EteamsBackdrop } from '../../features/backdrop/eteamsBackdrop';
import { fetchAgentActivity } from '../../lib/api';
import { useActivityMonitor } from '../../lib/monitor';
import { getApp, type RootState } from '../../store/app';
import {
  BORDER_L1_CLASS,
  FormErrorNote,
  PageHeader,
  ROLE_LIST_CSS,
} from './shared';
import { BoardTab } from './boardTab';
import { TasksTab } from './tasksTab';
import { TeamTab } from './teamTab';
import { MembersTab } from './membersTab';
import { ReportsTab } from './reportsTab';

/* styles/fns 两个 inline 工厂已随 S14 收尾迁移整体删除（docs/21 21.6 死
代码清理）：styles.* → 下方「S14 迁移新增的类名常量」段（或沿用 S12/S13
既有类常量），fns.pill → pillClass（S13 已备、本批全面板统一），
fns.progressFill → PROGRESS_FILL_CLASS + 宽度百分比 inline（S5 card 先例：
运行时动态值保留 inline，S14 清点口径）。 */

/* —— S12 迁移后的类名常量（Tailwind 工具类，完整字面量；模板串组合仅限
const 字面量插值，运行时动态值一律 inline style——S5/S11 既有口径）—— */

/** 原 styles.rail（窄栏态：84px / 3px 纵向间距 / 右分隔线 / 上 2 右 12）。
 * docs/22 S22-2：面板宽 ≥720px 时改用官网风格的宽栏 RAIL_WIDE_CLASS，
 * 窄面板回落本类（84px 窄栏原样保留，窄上下文零回归）。 */
const RAIL_CLASS = `flex w-[84px] shrink-0 flex-col gap-[3px] border-r border-solid pr-3 pt-0.5 ${BORDER_L1_CLASS}`;

/** 官网 docs 侧栏风格的宽栏（docs/22 D20c，tailwindcss.cn 实测标记还原）：
 * 208px（官网 15rem 等比收窄的 S24-2 加宽档）+ 右分隔线；列表自带连续左
 * 细线（官网 `border-l border-slate-100`，token 化走 --border）。 */
const RAIL_WIDE_CLASS = `flex w-[208px] shrink-0 flex-col border-r border-solid pr-4 pt-1 ${BORDER_L1_CLASS}`;
/** 宽栏分组标题（官网 h5：`text-sm mb-3 font-semibold text-slate-900` 的
 * token 版——D22d 侧栏全档 14px/24）。 */
const RAIL_TITLE_CLASS = 'mb-3 text-sm font-semibold leading-6 text-foreground';
/** 宽栏导航列表（官网 ul：`space-y-2 border-l` 的 token 版）。 */
const RAIL_LIST_CLASS = `space-y-2 border-l border-solid ${BORDER_L1_CLASS}`;

/** 宽栏导航链接三态（官网 a 的签名交互，docs/22 22.1.3）：自带 1px 左边线
 * 压在列表线上（`-ml-px`），常态透明、hover 亮线 + 文字加深、**激活 = sky
 * 文字 + 同色左线（border-current）+ semibold**；全部完整字面量（21.5.1
 * content 扫描纪律）。
 * D22f 官网字面量方案：hover 线取官网原味 `border-slate-400`（中灰在浅暗
 * 两态底上都可见）；hover 文字官方是加深到 slate-900，但 slate-900 字面量
 * 在暗色面板（slate-900 底）会隐形——文字加深走 token hover:text-foreground
 * （亮=官网同效，暗=slate-200 随主题翻档）。 */
const RAIL_LINK_BASE_CLASS =
  'block border-0 border-l border-solid bg-transparent py-[3px] pl-4 -ml-px text-left text-sm leading-6 [font-family:inherit] transition-colors';
const RAIL_LINK_IDLE_CLASS =
  'border-transparent text-muted-foreground hover:border-slate-400 hover:text-foreground';
const RAIL_LINK_ACTIVE_CLASS = 'border-current font-semibold text-primary';

/** 侧栏按钮（窄栏态，原 fns.railBtn）：active/idle 两态都是完整字面量映射（无拼接，
teamsButton tabBtnClass 同款）；docs/23 D21b：active 底改品牌淡底 token
（business-tint 淡底对）、字=brand 主色 token；S24-2 补非激活钮 hover 态
（官网侧栏 hover 底语义，token --muted）。 */
const railBtnClass = (active: boolean): string =>
  cn(
    'block w-full cursor-pointer rounded-[8px] border-none px-2.5 py-[7px] text-left text-xs leading-[1.55] [letter-spacing:0.2px]',
    active
      ? 'bg-business-tint font-semibold text-primary'
      : 'bg-transparent font-medium text-muted-foreground hover:bg-muted',
  );

/** 宽栏导航链接类名（官网三态查表；同 railBtnClass 的映射表口径）。 */
const railLinkClass = (active: boolean): string =>
  cn(
    RAIL_LINK_BASE_CLASS,
    active ? RAIL_LINK_ACTIVE_CLASS : RAIL_LINK_IDLE_CLASS,
    'cursor-pointer',
  );

/** 宽栏阈值（docs/22 S22-2）：面板作用域根宽 ≥ 此值用官网风格宽栏，
 * 否则回落 84px 窄栏。宿主 conversation.view 视图区与整页团队页宽度差异大，
 * Tailwind v3 无容器查询（v4 才内置），以作用域根实测为准。 */
const RAIL_WIDE_MIN_WIDTH = 720;

/* —— S13 迁移新增的类名常量（成员/任务两区块；完整字面量，同 S12 纪律）—— */

/* docs/23 S23-3：原 styles.select（SELECT_CLASS）迁移 shadcn Select（触发器
   对齐官网输入框签名：rounded-md + ring 边 + shadow-sm），空选项位以哨兵值
   承载（Radix SelectItem 禁空串 value）；原 styles.btn（BTN_CLASS）迁移
   shadcn Button outline/sm。手写常量删除，使用位内联。 */

/* —— S14 迁移新增的类名常量（面板壳/团队卡片栅格/构建工作台/角色库收尾；
完整字面量，同 S12/S13 纪律；置于 S12/S13 段之后——模板串插值在模块初始化
时求值，须晚于所引用的 BORDER_L1_CLASS/TEXT2_CLASS 等常量）—— */

/** 面板壳（原 styles.root 的布局面）：作用域根（.eteams-ui）自身不承工具类
（`.eteams-ui .utility` 后代选择器机制），壳布局迁进这层内壳；height 锚点
仍留作用域根 inline（宿主视图区无 .eteams-ui 祖先，见文件头 S14 注记）。
D22d 排版基线：官网侧栏/prose-sm 尺度 14px/24（原 13px/1.55 钉死档）。 */
const SHELL_CLASS =
  'relative box-border flex h-full gap-4 overflow-hidden px-[18px] py-3.5 text-sm leading-6 text-foreground font-sans';
/** 原 styles.content：内容列（纵滚/横截 + 2px 右距，用户反馈注记原样保留）。 */
const CONTENT_CLASS = 'min-w-0 flex-1 overflow-x-hidden overflow-y-auto pr-0.5';
/* docs/23 S23-3：原 styles.formError（FORM_ERROR_CLASS）迁移 FormErrorNote
   （shadcn Alert destructive 紧凑档，见上方组件），常量删除。 */

/**
 * The eteams conversation view entry — the M4.5 activity panel. 表面根：
 * Provider 包整个面板（S6/D19e），面板体在 Provider 之内消费 dva store；
 * ClientErrorBoundary 保持面板级降级路径不变。
 */
export function ETeamsView(props: ConvViewProps): ReactNode {
  return (
    <Provider store={getApp().store}>
      <ClientErrorBoundary label="团队面板">
        <ETeamsViewBody {...props} />
      </ClientErrorBoundary>
    </Provider>
  );
}

/**
 * Panel body — mounted inside the Provider (see {@link ETeamsView}).
 * S8/S9（docs/21-client-ui-stack.md）：面板导航、团队选择与抽屉/对话框开关
 * 迁入 ui model——tab/activeId/expandedTask/dialogMember 经 useSelector 读取
 * （ui.activeNav / ui.selectedTeamId / ui.drawerTaskId / ui.dialogMember），
 * 变更走 useDispatch 发 `ui/setNav` / `ui/setSelectedTeam` / `ui/setDrawerTask`
 * / `ui/setDialogMember`（goto 桥 handler 的目标状态同样）。输入草稿、悬停、
 * openAddTick 信号等组件内瞬态仍留 useState。
 */
function ETeamsViewBody(props: ConvViewProps): ReactNode {
  const state = useActivityMonitor();
  const dispatch = useDispatch();
  // 变量名沿用迁移前语义：tab=侧栏导航，activeId=当前选中团队。
  const tab = useSelector((s: RootState) => s.ui.activeNav);
  const activeId = useSelector((s: RootState) => s.ui.selectedTeamId);
  // S9：抽屉/对话框开关迁入 ui model——expandedTask=任务详情抽屉展开的
  // 任务 id，dialogMember=成员对话框选中的成员名。
  const expandedTask = useSelector((s: RootState) => s.ui.drawerTaskId);
  const dialogMember = useSelector((s: RootState) => s.ui.dialogMember);
  // S10：成员库列表迁入 roster model——useSelector 读、refreshRoster 发
  // `roster/fetchRoster`（takeLatest 防叠）。
  const roster = useSelector((s: RootState) => s.roster.list);
  // 成员子代理活动点（docs/20.4 P4）：childId → running/inactive。旧运行时
  // 无 listChildren 时返回空表——面板不渲染点，不误导。
  const [agentActivity, setAgentActivity] = useState<Record<string, string>>({});
  // 创建卡片/弹层跳转信号（docs/19.9.5）：递增计数驱动 MembersTab 打开新增页。
  const [openAddTick, setOpenAddTick] = useState(0);
  // 宽栏侧栏筛选框（S24-2 官网 Quick search 签名）：对五个页签名做大小写
  // 不敏感子串过滤，空串全显；纯前端视觉态，不触碰导航数据。
  const [railQuery, setRailQuery] = useState('');
  // docs/22 S22-2：面板作用域根宽 ≥ RAIL_WIDE_MIN_WIDTH 用官网风格宽栏，
  // 否则回落 84px 窄栏。Tailwind v3 无容器查询，以作用域根实测为准；
  // useLayoutEffect 首帧前同步测量避免闪栏，ResizeObserver 跟随布局变化，
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
      dispatch({ type: 'ui/setNav', payload: 'roster' });
      setOpenAddTick((t) => t + 1);
    };
    // 「成员 tab」信号（按钮成员选中直达，docs/13.8.2）：落成员页，不带新增表单。
    const hRoster = (): void => {
      consumePendingGotoRoster();
      dispatch({ type: 'ui/setNav', payload: 'roster' });
    };
    // 选中某个团队（弹层团队行点击）：board 视图随选择联动。
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
    if (consumePendingGotoAdd()) h();
    if (consumePendingGotoRoster()) hRoster();
    hSelect();
    return () => {
      window.removeEventListener(GOTO_ADD_EVENT, h);
      window.removeEventListener(GOTO_ROSTER_EVENT, hRoster);
      window.removeEventListener(SELECT_TEAM_EVENT, hSelect);
    };
  }, [dispatch]);

  const myTeams = state.teams.filter((t) => t.captainSessionId === props.sessionId);
  const pool = myTeams.length > 0 ? myTeams : state.teams;
  // Derived (no effect): stale/null selection falls back to the first team.
  const team = pool.find((t) => t.teamId === activeId) ?? pool[0];
  const now = state.serverTime || state.fetchedAt;
  const tabs: { id: 'board' | 'team' | 'roster' | 'tasks' | 'reports'; label: string }[] = [
    { id: 'board', label: '看板' },
    { id: 'team', label: '团队' },
    { id: 'roster', label: '角色' },
    { id: 'tasks', label: '任务' },
    { id: 'reports', label: '汇报' },
  ];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : 'board';
  // 侧栏筛选（S24-2）：大小写不敏感子串匹配页签名；空串全显。
  const railFilter = railQuery.trim().toLowerCase();
  const visibleTabs =
    railFilter === '' ? tabs : tabs.filter((t) => t.label.toLowerCase().includes(railFilter));
  // Dialog target resolved defensively: a vanished member must not crash render.
  const dialogMemberView =
    dialogMember === null || team === undefined
      ? null
      : (team.members.find((m) => m.name === dialogMember) ?? null);

  const refreshRoster = useCallback((): void => {
    // S10：直接 await api 的调用点改 dispatch。失败由 effect 落
    // state.error——迁移前这里 .catch(() => undefined) 同为静默面。
    void dispatch({ type: 'roster/fetchRoster' });
  }, [dispatch]);
  useEffect(() => {
    if (activeTab === 'roster' || activeTab === 'team') refreshRoster();
  }, [activeTab, refreshRoster]);

  // 活动点轮询：跟随当前选中的团队，3s 节流（docs/20.4 P4）。
  useEffect(() => {
    if (team === undefined) return;
    let alive = true;
    const pull = (): void => {
      void fetchAgentActivity(team.teamId)
        .then((a) => {
          if (alive) setAgentActivity(a);
        })
        .catch(() => undefined);
    };
    pull();
    const h = setInterval(pull, 3000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [team]);

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
      {/* 卡片化样式（用户反馈）：角色/团队卡片与删除按钮的悬停态一次注入，
        面板内与整页团队页共用同一渲染根，注入一次即可。 */}
      <style>{ROLE_LIST_CSS}</style>
      <div className={SHELL_CLASS}>
        {railWide ? (
          /* docs/22 S22-2 宽栏：官网 docs 侧栏签名——搜索框 + 分组标题 + 连续
            左细线列表 + 链接自带左边线三态（激活 = sky 文字 + 同色左线 +
            semibold）。 */
          <div className={RAIL_WIDE_CLASS}>
            {/* 官网 Quick search 签名（S24-2）：ring 代替边框、shadow-sm；
              环色走 --eteams-pill-bg——官网的 ring-slate-900/10 字面量在暗色
              底上是黑环，pill 底 token 亮=浅灰/暗=深灰两侧都成立。 */}
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={railQuery}
                placeholder="筛选"
                onChange={(e) => setRailQuery(e.target.value)}
                className="h-9 w-full rounded-md border-0 bg-transparent pl-8 pr-3 text-sm leading-6 text-foreground shadow-sm outline-none [font-family:inherit] ring-1 ring-[color:var(--eteams-pill-bg)] placeholder:text-muted-foreground focus:ring-2 focus:ring-sky-500/60"
              />
            </div>
            <h5 className={RAIL_TITLE_CLASS}>团队面板</h5>
            <div className={RAIL_LIST_CLASS}>
              {visibleTabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={railLinkClass(activeTab === t.id)}
                  onClick={() => dispatch({ type: 'ui/setNav', payload: t.id })}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className={RAIL_CLASS}>
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className={railBtnClass(activeTab === t.id)}
                onClick={() => dispatch({ type: 'ui/setNav', payload: t.id })}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        <div className={CONTENT_CLASS}>
          {/* 页签标题（S24-2，官网 h2 签名）：每 tab 内容区顶部一行页头。
            团队页的页头（含「＋ 新增团队」按钮）由 TeamTab 自渲染——创建
            弹窗开合是它的组件内瞬态（用户反馈 2026-09：跳转信号自开弹窗
            撤销，创建只从这里进）。 */}
          {activeTab === 'board' && <PageHeader label="看板" />}
          {activeTab === 'roster' && <PageHeader label="角色" />}
          {activeTab === 'tasks' && <PageHeader label="任务" />}
          {activeTab === 'reports' && <PageHeader label="汇报" />}
          {/* 顶栏（用户反馈）：团队切换改为「团队」页的卡片栅格，这里只保留
            状态加载失败的就地提示；空态兜底在 BoardTab。 */}
          {state.error !== null && (
            <FormErrorNote className="mb-3">状态加载失败：{state.error}</FormErrorNote>
          )}

          {activeTab === 'board' && (
            <BoardTab team={team} now={now} fetchedAt={state.fetchedAt} error={state.error} />
          )}
          {activeTab === 'team' && (
            <TeamTab
              sessionId={props.sessionId}
              pool={pool}
              team={team}
              roster={roster}
              memberCap={state.maxMembers}
              onSelectTeam={(id) => dispatch({ type: 'ui/setSelectedTeam', payload: id })}
              agentActivity={agentActivity}
              onOpenReports={(name) => {
                dispatch({ type: 'ui/setDialogMember', payload: name });
                dispatch({ type: 'ui/setNav', payload: 'reports' });
              }}
            />
          )}
          {activeTab === 'roster' && (
            <MembersTab
              members={roster}
              pool={pool}
              team={team}
              onDeleted={refreshRoster}
              onPrefillAddPeople={prefillAddPeople}
              openAddTick={openAddTick}
              onAddTickConsumed={() => setOpenAddTick(0)}
            />
          )}
          {activeTab === 'tasks' && team !== undefined && (
            <TasksTab
              team={team}
              now={now}
              expandedTask={expandedTask}
              setExpandedTask={(id) => dispatch({ type: 'ui/setDrawerTask', payload: id })}
            />
          )}
          {activeTab === 'reports' && team !== undefined && (
            <ReportsTab
              team={team}
              dialogMember={dialogMember}
              setDialogMember={(name) => dispatch({ type: 'ui/setDialogMember', payload: name })}
              member={dialogMemberView}
            />
          )}
        </div>
      </div>
    </div>
  );
}
