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
 * @module dsh-eteams/client/eteamsView
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import {
  IconCheckOutline16,
  IconPlusOutline16,
  IconSparkle16,
  MarkdownText,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives';
// lucide 深层图标导入（dialog.tsx 先例：主入口 icons 命名空间再导出会让
// rolldown 拖全量图标进 envelope，深层 .mjs 路径只进用到的图标；类型垫片见
// components/ui/lucide-icon.d.ts）。D22f：emoji 清零的替换位。
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left.mjs';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right.mjs';
import Dices from 'lucide-react/dist/esm/icons/dices.mjs';
import MessageSquare from 'lucide-react/dist/esm/icons/message-square.mjs';
import PenLine from 'lucide-react/dist/esm/icons/pen-line.mjs';
import Search from 'lucide-react/dist/esm/icons/search.mjs';
// docs/28 Token 消耗日历（usageCalendar.tsx）：tsdown 虚拟 CSS 插件以字符串
// 载入，见 usageCalendarCss.d.ts / tsdown.config.ts usageTooltipsCssInline。
import { Provider, useDispatch, useSelector } from 'react-redux';
import { ADD_PEOPLE_TEMPLATE, prefillComposer, type PrefillOutcome } from './lib/addPeople';
import { Avatar } from './features/avatar/avatar';
import {
  activateConversationTab,
  consumePendingGotoAdd,
  consumePendingGotoRoster,
  consumePendingSelectTeam,
  GOTO_ADD_EVENT,
  GOTO_ROSTER_EVENT,
  SELECT_TEAM_EVENT,
} from './lib/bridge';
import { cn } from './lib/cn';
import { ClientErrorBoundary } from './lib/diagnostics';
import { EteamsBackdrop } from './features/backdrop/eteamsBackdrop';
import { Alert } from './components/ui/alert';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import { Input } from './components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select';
import { MdEditor } from './features/mdEditor/mdEditor';
import {
  fetchAgentActivity,
  type InterviewQuestion,
  type RosterMember,
} from './lib/api';
import {
  useActivityMonitor,
  type MemberView,
  type TeamSnapshot,
} from './lib/monitor';
import { getApp, type RootState } from './store/app';
import {
  BORDER_L1_CLASS,
  CARD_GRID_CLASS,
  CHIP_CLASS,
  EMPTY_CLASS,
  FormErrorNote,
  FORM_LABEL_CLASS,
  FORM_ROW_CLASS,
  GLYPH_TONE_CLASS,
  LEADER_NAME,
  LINE_CLASS,
  LIST_COUNT_CLASS,
  LIST_TITLE_CLASS,
  MUTED_CLASS,
  PageHeader,
  PANEL_CARD_CLASS,
  Pill,
  PROTECTED_MEMBERS,
  ROLE_LIST_CSS,
  SECTION_TITLE_CLASS,
  SELECT_NONE,
  TEXT2_CLASS,
  memberRank,
} from './pages/teamsView/shared';
import { BoardTab } from './pages/teamsView/boardTab';
import { TasksTab } from './pages/teamsView/tasksTab';
import { TeamTab } from './pages/teamsView/teamTab';
import {
  BUILD_STEPS,
  CommandChip,
  DraftPreview,
  EMPTY_EDIT,
  PREFILL_STEPS,
  fromBuildDraft,
  handbookSeed,
  type DraftEdit,
} from './pages/teamsView/buildDraft';

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
/** 原 styles.drawer（sunken 抽屉面板）：任务抽屉已升级为 Dialog，现仅成员
 * 汇报时间线使用。D22f：去双层灰底嵌套——容器改白底 + 左细线时间线签名。 */
const DRAWER_CLASS = `mt-2 mb-3.5 border-l-2 border-solid border-[color:var(--border)] pl-3`;
/** 原 styles.dialogItem（汇报时间线条目）：D22f 去灰底小卡，改普通段落
 * （正文 14px foreground；12px meta 前缀语义留在使用位的 MUTED_CLASS）。 */
const DIALOG_ITEM_CLASS = 'my-1 text-sm leading-6 text-foreground';

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
/** 原 styles.roleCard（同上：底色/边框/悬停由 .eteams-role-row 样式表接管）；
 * p-4 = D22f 卡内呼吸感。用户迭代 2026-09-03：改一行式横排——头像在前、
 * 名称（与所属团队）随后、删除钮常驻行尾（不再 hover 显形）。 */
const ROLE_CARD_CLASS =
  'flex min-w-0 cursor-pointer items-center gap-2.5 rounded-xl p-4 text-left text-foreground';
/** 新增角色方式选择卡（choose 态，用户迭代 2026-09-03）：整行可点（图标 +
 * 标题 + 描述 + 右箭头）；底色/边框/悬停同角色卡片走 .eteams-role-row。 */
const ADD_MODE_CARD_CLASS =
  'flex w-full cursor-pointer items-center gap-3 rounded-xl p-4 text-left text-foreground';
/** 方式选择卡图标底（品牌淡底圆牌，STEP_NUM_CLASS 同口径放大到 32px）。 */
const ADD_MODE_ICON_CLASS =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-business-tint text-primary';
/** 原 styles.pagePill（分页计数 pill：D22e 中性 pill 口径 12px/20）。 */
const PAGE_PILL_CLASS =
  'inline-flex w-fit items-center whitespace-nowrap rounded-full bg-[color:var(--eteams-pill-bg)] px-2.5 py-0.5 text-xs text-[color:var(--eteams-pill-ink)]';
/** 原 styles.buildStep / stepRow / stepNum（构建工作台）；原 prefillBanner
 * docs/23 S23-3 迁移 shadcn Alert（default 变体 + 品牌淡底覆盖），常量删除。
 * D22d：步骤行 14px/24、序号圆牌 12px。 */
const BUILD_STEP_CLASS = 'flex items-center gap-2 py-0.5 text-sm leading-6';
const STEP_ROW_CLASS = `mt-2 flex items-start gap-2 text-sm leading-6 ${TEXT2_CLASS}`;
const STEP_NUM_CLASS =
  'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-business-tint text-xs font-semibold text-[color:var(--eteams-brand-ink)]';

function MemberDialog({ team, member }: { team: TeamSnapshot; member: MemberView }): ReactNode {
  const [items, setItems] = useState<{ at: number; kind: string; text: string; from?: string }[]>(
    [],
  );
  useEffect(() => {
    let alive = true;
    void fetch(
      `/eteams-api/team/${encodeURIComponent(team.teamId)}/member/${encodeURIComponent(member.name)}/dialog`,
      { cache: 'no-store' },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (alive && body !== null) setItems(body.items ?? []);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [team.teamId, team.version, member.name]);
  const kindLabel: Record<string, string> = {
    assignment: '指派',
    report: '汇报',
    question: '提问',
    notice: '通知',
    user_message: '用户',
    progress: '进度',
  };
  return (
    <div className={DRAWER_CLASS}>
      <div className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-foreground">
        汇报记录 · {member.name}
        <span className="text-xs font-normal text-muted-foreground">
          （只读；直发消息在 M5 开放）
        </span>
      </div>
      {items.length === 0 && <div className={MUTED_CLASS}>暂无消息记录</div>}
      {items.map((it, i) => (
        <div key={i} className={DIALOG_ITEM_CLASS}>
          <span className={MUTED_CLASS}>
            [{kindLabel[it.kind] ?? it.kind}] {it.from ?? ''} ·{' '}
          </span>
          {it.text.length > 160 ? `${it.text.slice(0, 160)}…` : it.text}
        </div>
      ))}
    </div>
  );
}

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



/**
 * 团队：新增团队（弹窗，名称即建）+ 团队列表/详情两级视图（用户迭代
 * 2026-09）。列表态是长条形团队卡（名称 + 阶段徽标 + 进度 + 右侧成员
 * 头像略缩图最多 3 个），点击卡片进入该团队的详情——成员栅格、拉人、
 * 移出等只在详情视图出现。
 */
/**
 * The role detail handbook (用户反馈：去掉人设摘要，全部提炼到角色手册).
 * 用户迭代 2026-09-03：编辑钮挪到详情页头，名称/头像/手册一处编辑——保存
 * 走 POST /roster 整条 upsert（host 替换整个条目，现有字段全量重发）；
 * 领队经宿主 allowLeader 放行同样可编辑（名称仍为系统保留）。改名 =
 * 保存新名 + 删除旧条目（保留角色名称锁死，不改名）。
 */

function MembersTab({
  members,
  pool,
  team,
  onDeleted,
  onPrefillAddPeople,
  openAddTick,
  onAddTickConsumed,
}: {
  members: RosterMember[];
  pool: TeamSnapshot[];
  team: TeamSnapshot | undefined;
  onDeleted: () => void;
  onPrefillAddPeople: () => 'set' | 'copied' | 'aborted';
  /** 创建卡片跳转信号：>0 时打开新增工作台（docs/19.9.5）。 */
  openAddTick: number;
  /** 消费回执：信号打开新增工作台后清零（防滞留信号重进角色页时复跳）。 */
  onAddTickConsumed: () => void;
}): ReactNode {
  const dispatch = useDispatch();
  const [view, setView] = useState<'list' | 'add' | 'detail'>('list');
  const [detailName, setDetailName] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [personaMd, setPersonaMd] = useState('');
  // 新增方式（用户迭代 2026-09-03）：进入新增页先选「手动创建 / AI 创建」，
  // 不再默认把命令填进对话输入框——点「AI 创建」此刻才预填，手动创建直接
  // 进角色手册编辑页。
  const [addMode, setAddMode] = useState<'choose' | 'ai' | 'manual'>('choose');
  // AI 创建的预填结果（'set' 填入输入框 / 'copied' 退化剪贴板 / 'aborted'
  // 用户取消覆盖），驱动 AI 创建页的状态行。
  const [aiPrefill, setAiPrefill] = useState<PrefillOutcome | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // 角色列表搜索 + 分页（用户反馈）：按名字/角色字段过滤，每页 8 条。
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const MEMBER_PAGE_SIZE = 8;
  const filtered = members.filter((m) => {
    const q = query.trim().toLowerCase();
    if (q === '') return true;
    return m.name.toLowerCase().includes(q) || m.role.toLowerCase().includes(q);
  });
  const sortedMembers = [...filtered].sort((a, b) => memberRank(a.name) - memberRank(b.name));
  const totalPages = Math.max(1, Math.ceil(sortedMembers.length / MEMBER_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = sortedMembers.slice(
    safePage * MEMBER_PAGE_SIZE,
    (safePage + 1) * MEMBER_PAGE_SIZE,
  );

  // 构建会话（docs/19.6.2, D18-5）：S10 迁入 build model——session 经
  // useSelector 读取，轮询照旧由 refreshBuild 发 `build/fetchBuild`；
  // 以 startedAt 为会话键去重自动跳转（用户手动离开后不反复强拉，状态
  // 再迁移才再次跳转）的侧效应搬进下方 useEffect。
  const build = useSelector((s: RootState) => s.build.session);
  const [draftEdit, setDraftEdit] = useState<DraftEdit>(EMPTY_EDIT);
  const [confirming, setConfirming] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const seenSessionRef = useRef(0);
  const seenReviewRef = useRef(0);
  const draftInitRef = useRef(0);

  const refreshBuild = useCallback((): void => {
    // S10：直接 await api 的调用点改 dispatch；失败由 effect 落 state.error
    // ——迁移前这里 .catch(() => undefined) 同为静默面。
    void dispatch({ type: 'build/fetchBuild' });
  }, [dispatch]);
  // 会话侧效应（原 refreshBuild .then 内联逻辑，数据源改 store）：以
  // startedAt 为会话键去重自动跳转（用户手动离开后不反复强拉，状态再
  // 迁移才再次跳转）；待确认草稿到达/刷新时重置编辑表单（对话里继续
  // 调整 → 表单跟着刷新）。
  useEffect(() => {
    if (build === null) return;
    if (build.startedAt !== seenSessionRef.current) {
      seenSessionRef.current = build.startedAt;
      // 新会话不再强制跳创建页（docs/19.16）：发送时刻由对话卡片负责
      // openMemberBuilder——这里强跳会把用户每次回面板都拽进 add 视图，
      // 导致「构建时进不去对话/看板」。
    }
    if (build.status === 'awaiting_confirmation' && seenReviewRef.current !== build.startedAt) {
      seenReviewRef.current = build.startedAt;
      // AI 创建流（用户迭代 2026-09-03）：草稿确认态属于 AI 创建路径，自动
      // 跳转时顺带把新增页切到 ai 模式，避免回落到方式选择页。
      setAddMode('ai');
      setView('add');
    }
    if (
      build.status === 'awaiting_confirmation' &&
      build.draft !== null &&
      build.updatedAt !== draftInitRef.current
    ) {
      draftInitRef.current = build.updatedAt;
      setDraftEdit(fromBuildDraft(build.draft));
    }
  }, [build]);
  useEffect(() => {
    refreshBuild();
    const h = setInterval(refreshBuild, 1500);
    return () => clearInterval(h);
  }, [refreshBuild]);

  // 创建卡片跳转（docs/19.9.5）：父级消费制——滞留信号曾让重进角色页时
  // 自动跳进新增工作台；tick 归零后复位 lastTickRef。
  const lastAddTickRef = useRef(0);
  useEffect(() => {
    if (openAddTick === 0) {
      lastAddTickRef.current = 0;
      return;
    }
    if (openAddTick !== lastAddTickRef.current) {
      lastAddTickRef.current = openAddTick;
      setAddMode('ai');
      setView('add');
      onAddTickConsumed();
    }
  }, [openAddTick, onAddTickConsumed]);

  // 删除角色（用户反馈）：先弹确认框；失败信息显式上报。领队与角色构建师
  // 为保留角色，面板不给删除按钮（宿主同样拒删）。
  const del = (memberName: string): void => {
    if (!window.confirm(`确定删除角色「${memberName}」？删除后不可恢复。`)) return;
    setListError(null);
    // S10：删除改发 `roster/deleteRoster`；失败 reject → 显式上报（行为不变）。
    void (async (): Promise<void> => {
      try {
        await dispatch({ type: 'roster/deleteRoster', payload: memberName });
        onDeleted();
      } catch (e) {
        setListError(e instanceof Error ? e.message : String(e));
      }
    })();
  };

  // —— 角色详情编辑（用户迭代 2026-09-03）——
  // 编辑钮挪到详情页头：名称输入 + 随机头像 + 保存/取消一行收口，手册编辑
  // 器跟在页头卡下。领队/角色构建师同样可编辑（宿主对面板显式保存放行，
  // 见 roster.ts allowLeader）；仅名称锁死——领队名绑定团队领队卡、改用
  // 「新增角色」另建。改名 = 保存新名 + 删除旧条目（两步，非事务）。
  const [detailEditing, setDetailEditing] = useState(false);
  const [detailDraftName, setDetailDraftName] = useState('');
  const [detailDraftAvatar, setDetailDraftAvatar] = useState<{ seed: number; salt: number } | null>(
    null,
  );
  const [detailDraftMd, setDetailDraftMd] = useState('');
  const [detailSaving, setDetailSaving] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const startDetailEdit = (): void => {
    if (detail === null) return;
    setDetailDraftName(detail.name);
    setDetailDraftAvatar(detail.avatar ?? null);
    setDetailDraftMd(handbookSeed(detail));
    setDetailError(null);
    setDetailEditing(true);
  };
  const cancelDetailEdit = (): void => {
    setDetailEditing(false);
    setDetailError(null);
  };
  const rollDetailAvatar = (): void => {
    // 与宿主默认头像同口径：seed 0..996（hashName % 997）、salt 0..999。
    setDetailDraftAvatar({
      seed: Math.floor(Math.random() * 997),
      salt: Math.floor(Math.random() * 1000),
    });
  };
  const saveDetail = (): void => {
    if (detail === null || detailSaving) return;
    const newName = detailDraftName.trim();
    if (newName === '') {
      setDetailError('角色名不能为空');
      return;
    }
    const nameLocked = PROTECTED_MEMBERS.includes(detail.name);
    const nameChanged = newName !== detail.name;
    if (nameChanged && members.some((m) => m.name === newName)) {
      setDetailError(`角色「${newName}」已存在，换个名字`);
      return;
    }
    setDetailSaving(true);
    setDetailError(null);
    void (async (): Promise<void> => {
      try {
        // 整条 upsert（host 替换整个条目）：现有字段全量重发，仅名称/头像/
        // 手册取草稿值。
        await dispatch({
          type: 'roster/saveRoster',
          payload: {
            name: newName,
            role: detail.role,
            ...(detail.duty !== undefined ? { duty: detail.duty } : {}),
            ...(detail.style !== undefined ? { style: detail.style } : {}),
            ...(detail.skills !== undefined ? { skills: detail.skills } : {}),
            ...(Array.isArray(detail.rules) ? { rules: detail.rules } : {}),
            ...(detail.executionPrompt !== undefined
              ? { executionPrompt: detail.executionPrompt }
              : {}),
            ...(detail.provider !== undefined ? { provider: detail.provider } : {}),
            ...(detail.model !== undefined ? { model: detail.model } : {}),
            ...(detail.reasoningEffort !== undefined
              ? { reasoningEffort: detail.reasoningEffort }
              : {}),
            ...(detailDraftAvatar !== null ? { avatar: detailDraftAvatar } : {}),
            personaMd: detailDraftMd,
          },
        });
        if (nameChanged && !nameLocked) {
          // 改名 = 新条目已落库后移除旧条目；保留角色锁名不会走到这里。
          await dispatch({ type: 'roster/deleteRoster', payload: detail.name });
        }
        setDetailName(newName); // 详情跟随新名（改名后停在详情页）
        setDetailEditing(false);
        onDeleted();
      } catch (e) {
        setDetailError(e instanceof Error ? e.message : String(e));
      } finally {
        setDetailSaving(false);
      }
    })();
  };

  // 确认入库（D18-6 主路径）：修改后的草稿经 POST /rolebuilder/confirm 由
  // 宿主落库 roster 并翻转会话状态；确认前零落库。
  const confirmDraft = async (): Promise<void> => {
    setConfirming(true);
    setFormError(null);
    try {
      // S10：确认入库改发 `build/confirmBuild`（effect 透传 api，失败 reject
      // → 表单错误提示，行为不变）。
      await dispatch({
        type: 'build/confirmBuild',
        payload: {
          name: draftEdit.name.trim(),
          role: draftEdit.role.trim(),
          duty: draftEdit.duty,
          style: draftEdit.style,
          skills: draftEdit.skills,
          rules: draftEdit.rulesText
            .split('\n')
            .map((r) => r.trim())
            .filter((r) => r !== ''),
          executionPrompt: draftEdit.executionPrompt,
          personaMd: draftEdit.personaMd,
          ...(build !== null && build.draft?.avatar !== undefined
            ? { avatar: build.draft.avatar }
            : {}),
        },
      });
      onDeleted();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setConfirming(false);
      refreshBuild();
    }
  };

  const abandon = async (): Promise<void> => {
    setConfirming(true);
    // S10：放弃改发 `build/cancelBuild`（effect 失败上抛；组件侧迁移前就
    // 吞错——.catch(() => undefined)——行为不变）。
    try {
      await dispatch({ type: 'build/cancelBuild' });
    } catch {
      // 与迁移前一致：放弃失败不打断面板，轮询会带回会话真实状态。
    }
    setConfirming(false);
    refreshBuild();
  };

  // 继续构建（docs/19.16）：会话文件保存完整上下文（步骤/草稿/需求），
  // 宿主恢复会话并唤醒后台构建代理，从中断处接着跑。
  const resume = async (): Promise<void> => {
    setConfirming(true);
    // S10：继续构建改发 `build/resumeBuild`（同上：effect 失败上抛，
    // 组件侧吞错行为不变）。
    try {
      await dispatch({ type: 'build/resumeBuild' });
    } catch {
      // 与迁移前一致：恢复失败不打断面板。
    }
    setConfirming(false);
    refreshBuild();
  };

  // 意图访谈作答（docs/19.16）：后台构建代理把问题写进会话，工作台渲染为
  // 选项问卷；提交后宿主把答案经 followup 发回代理继续构建。
  const [interviewPick, setInterviewPick] = useState<Record<string, string[]>>({});
  // 提交失败要可见（父会话不在线 / 网络问题），不再静默吞掉——否则用户
  // 提交后看不到任何反馈，构建看起来像假卡死。
  const [interviewError, setInterviewError] = useState<string | null>(null);
  const togglePick = (id: string, label: string, multi: boolean): void => {
    setInterviewPick((prev) => {
      const cur = prev[id] ?? [];
      if (cur.includes(label)) {
        return { ...prev, [id]: cur.filter((x) => x !== label) };
      }
      return { ...prev, [id]: multi ? [...cur, label] : [label] };
    });
  };
  const submitInterviewAnswers = async (questions: InterviewQuestion[]): Promise<void> => {
    const answers = questions
      .map((q) => ({ id: q.id, choice: (interviewPick[q.id] ?? []).join('、') }))
      .filter((a) => a.choice !== '');
    if (answers.length === 0) return;
    setConfirming(true);
    setInterviewError(null);
    // S10：作答改发 `build/submitInterview`；失败 reject → 显式提示
    // （提交失败不再静默的迁移前要求保持不变）。
    try {
      await dispatch({ type: 'build/submitInterview', payload: answers });
    } catch (e) {
      setInterviewError(e instanceof Error ? e.message : String(e));
    }
    setConfirming(false);
    refreshBuild();
  };
  // 手动重启构建代理（用户迭代）：不答题也能派新代理重新核查/重新出题。
  const restartBuildAgent = async (): Promise<void> => {
    setConfirming(true);
    setInterviewError(null);
    // S10：重启改发 `build/restartBuild`；失败 reject → 显式提示（行为不变）。
    try {
      await dispatch({ type: 'build/restartBuild' });
    } catch (e) {
      setInterviewError(e instanceof Error ? e.message : String(e));
    }
    setConfirming(false);
    refreshBuild();
  };

  // AI 创建入口（方式选择卡 / 重试填充 / 再建一个共用）：此刻才把命令预填
  // 进对话输入框（onPrefillAddPeople → addPeople.prefillComposer），面板不
  // 自动发送；结果落 aiPrefill 驱动 AI 创建页的状态行。
  const fillAi = (): void => {
    setAiPrefill(onPrefillAddPeople());
    setAddMode('ai');
  };

  // 手动创建（用户迭代 2026-09-03）：面板直连名册保存（`roster/saveRoster`
  // → POST /roster，与详情页 HandbookEditor 同一写路径），不再借对话命令
  // 中转。personaMd 留空则只建名字+角色条目，手册随后可在详情页补写。
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const saveManual = async (): Promise<void> => {
    const trimmed = name.trim();
    // 同名即覆盖（宿主 upsert 语义）——手动直存前先挡一手，避免误盖已有角色。
    if (members.some((m) => m.name === trimmed)) {
      setManualError(`已存在同名角色「${trimmed}」——换一个名字，或到角色详情里编辑它。`);
      return;
    }
    setManualSaving(true);
    setManualError(null);
    try {
      await dispatch({
        type: 'roster/saveRoster',
        payload: {
          name: trimmed,
          role: role.trim(),
          ...(personaMd.trim() !== '' ? { personaMd } : {}),
        },
      });
      setName('');
      setRole('');
      setPersonaMd('');
      setAddMode('choose');
      onDeleted(); // 保存成功 → 父级重拉名册，翻回列表即见新角色
      setView('list');
    } catch (e) {
      setManualError(e instanceof Error ? e.message : String(e));
    } finally {
      setManualSaving(false);
    }
  };

  // 该角色已加入的团队（按当前可见团队池计算）。
  const teamsOf = (memberName: string): string[] =>
    pool.filter((t) => t.members.some((mm) => mm.name === memberName)).map((t) => t.name);

  const detail = members.find((m) => m.name === detailName) ?? null;
  const detailMemberView =
    detail === null ? null : (team?.members.find((m) => m.name === detail.name) ?? null);

  if (view === 'add') {
    // 闭包内无法从外层条件继承窄化，这里先固化已入库草稿。
    const confirmedDraft = build !== null && build.status === 'confirmed' ? build.draft : null;
    // 访谈未答 = 阶段代理按设计已结束回合，此刻在等用户——显示「等你作答」
    // 而不是转圈的「工作中」，否则看起来像卡死（显示状态要诚实）。
    const interviewWaiting =
      build !== null &&
      build.status === 'active' &&
      build.interview !== undefined &&
      build.interview.answers === undefined;
    return (
      <div className="min-w-0 overflow-x-hidden">
        <style>{'@keyframes eteams-spin{to{transform:rotate(360deg)}}'}</style>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => setView('list')}>
            <ArrowLeft className="h-3.5 w-3.5" />
            返回角色列表
          </Button>
          {/* 对话页看进度只在 AI 创建路径有意义（手动创建不经对话）。 */}
          {(addMode === 'ai' ||
            (build !== null &&
              (build.status === 'active' || build.status === 'awaiting_confirmation'))) && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => activateConversationTab()}
              title="切到会话的对话视图，看命令卡片与进度行"
            >
              <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
              对话页看进度
            </Button>
          )}
        </div>
        <Card className={cn(PANEL_CARD_CLASS, 'mt-2')}>
          {build !== null && build.status === 'active' && (
            <div>
              <div className="flex items-center gap-2">
                {interviewWaiting ? (
                  <PenLine className="h-4 w-4 shrink-0 text-primary" />
                ) : build.draft?.avatar !== undefined ? (
                  <Avatar
                    name={build.draft.name}
                    seed={build.draft.avatar.seed}
                    salt={build.draft.avatar.salt}
                    size={30}
                  />
                ) : (
                  <span className="inline-flex text-primary [animation:eteams-spin_1s_linear_infinite]">
                    <IconSparkle16 />
                  </span>
                )}
                <div className={cn(LINE_CLASS, 'my-0 font-semibold')}>
                  {interviewWaiting ? (
                    <>
                      意图访谈待作答
                      {build.draft?.name !== undefined && build.draft.name !== ''
                        ? ` · ${build.draft.name}`
                        : ''}
                      ——答案提交后自动续跑
                    </>
                  ) : build.draft?.name !== undefined && build.draft.name !== '' ? (
                    `角色构建师工作中 · ${build.draft.name}…`
                  ) : (
                    '角色构建师工作中…'
                  )}
                </div>
                {interviewWaiting ? (
                  <Pill tone="warn">等你作答</Pill>
                ) : (
                  <Pill tone="info">构建中</Pill>
                )}
                <span className="flex-1" />
                {interviewWaiting && (
                  <Button
                    size="sm"
                    disabled={confirming}
                    onClick={() => void restartBuildAgent()}
                    title="不答题，直接派一个新代理重新核查进度并按需重新出题"
                  >
                    重启代理
                  </Button>
                )}
                {/* 构建中也能放弃（docs/19.16）：作废会话并中断后台构建代理。 */}
                <Button size="sm" disabled={confirming} onClick={() => void abandon()}>
                  放弃
                </Button>
              </div>
              {build.interview !== undefined && build.interview.answers === undefined && (
                // 意图访谈问卷（docs/19.16）：后台代理的问题在这里作答，
                // 提交后宿主把答案发回代理继续构建。
                <div className="mb-1 mt-2.5 rounded-[10px] border border-solid border-primary px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                    <PenLine className="h-4 w-4 text-primary" />
                    意图访谈——请作答
                  </div>
                  <div className={MUTED_CLASS}>
                    阶段代理是一次性的，前任已收工；提交答案会立即派出新代理继续，或点「重启代理」重新出题。
                  </div>
                  {(() => {
                    const qs = build.interview.questions;
                    const answered = qs.filter(
                      (q) => (interviewPick[q.id] ?? []).length > 0,
                    ).length;
                    if (answered >= qs.length) return null;
                    return (
                      <div className="mt-1.5 text-xs font-semibold text-warning">
                        每题至少选一项才能提交——已答 {answered}/{qs.length}
                        {answered === qs.length - 1
                          ? '，还差 1 题'
                          : `，还差 ${qs.length - answered} 题`}
                      </div>
                    );
                  })()}
                  {build.interview.questions.map((q) => {
                    const picked = interviewPick[q.id] ?? [];
                    const done = picked.length > 0;
                    return (
                      <div key={q.id} className="mt-2.5">
                        {q.header !== undefined && q.header !== '' && (
                          <div className={MUTED_CLASS}>{q.header}</div>
                        )}
                        <div className="text-sm font-semibold leading-6 text-foreground">
                          {q.question}
                          {q.multi === true && (
                            <span className="ml-1.5 inline-flex w-fit items-center rounded-full bg-business-tint px-2 py-0.5 align-middle text-xs font-medium text-[color:var(--eteams-brand-ink)]">
                              可多选
                            </span>
                          )}
                          {!done && <span className="text-primary"> ·</span>}
                        </div>
                        <div className="mt-[5px] flex flex-col gap-1">
                          {q.options.map((o) => {
                            const active = picked.includes(o.label);
                            return (
                              <button
                                key={o.label}
                                type="button"
                                onClick={() => togglePick(q.id, o.label, q.multi === true)}
                                className={cn(
                                  'cursor-pointer rounded-md border border-solid px-2.5 py-1.5 text-left text-sm leading-6 text-inherit',
                                  active
                                    ? 'border-primary bg-business-tint'
                                    : `bg-transparent ${BORDER_L1_CLASS}`,
                                )}
                              >
                                <div className={active ? 'font-semibold' : 'font-normal'}>
                                  {o.label}
                                </div>
                                {o.description !== undefined && o.description !== '' && (
                                  <div className={MUTED_CLASS}>{o.description}</div>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  <div className="mt-2.5 flex items-center gap-2">
                    <Button
                      size="sm"
                      disabled={
                        confirming ||
                        build.interview.questions.some(
                          (q) => (interviewPick[q.id] ?? []).length === 0,
                        )
                      }
                      title={
                        build.interview.questions.some(
                          (q) => (interviewPick[q.id] ?? []).length === 0,
                        )
                          ? '每题至少选一项后才能提交'
                          : undefined
                      }
                      onClick={() => void submitInterviewAnswers(build.interview?.questions ?? [])}
                    >
                      提交回答
                    </Button>
                    {/* R1-F6：state-err-primary 是宿主包中不存在的死变量（迁移前
                    遗留写法，恒走字面兜底、暗色无法随主题翻档）——错误色统一走
                    destructive token（与 FORM_ERROR_CLASS 等错误面同源）。 */}
                    {interviewError !== null && (
                      <div className="mt-2 text-xs leading-5 text-destructive">
                        ⚠️ {interviewError}
                      </div>
                    )}
                    <span className={MUTED_CLASS}>提交后构建代理自动继续。</span>
                  </div>
                </div>
              )}
              <div className="mb-1 mt-2.5">
                {BUILD_STEPS.map((s) => {
                  const done = build.stepsDone.includes(s);
                  const current = !done && build.step === s;
                  const glyphState = done ? 'done' : current ? 'current' : 'pending';
                  return (
                    <div key={s} className={BUILD_STEP_CLASS}>
                      <span className={cn(GLYPH_TONE_CLASS[glyphState], 'font-semibold')}>
                        {done ? '✔' : current ? '●' : '◌'}
                      </span>
                      <span
                        className={done || current ? 'text-foreground' : 'text-muted-foreground'}
                      >
                        {s}
                      </span>
                      {current && <span className={MUTED_CLASS}>进行中…</span>}
                    </div>
                  );
                })}
              </div>
              {build.note !== '' && <div className={MUTED_CLASS}>{build.note}</div>}
              {build.request !== '' && (
                <div className={cn(MUTED_CLASS, 'mt-1')}>需求：{build.request}</div>
              )}
              {build.draft !== null && <DraftPreview draft={build.draft} />}
            </div>
          )}
          {build !== null && build.status === 'awaiting_confirmation' && build.draft !== null && (
            <div>
              <div className={cn('flex items-center gap-2', LINE_CLASS, 'font-semibold')}>
                {build.draft.avatar !== undefined && (
                  <Avatar
                    name={draftEdit.name.trim() !== '' ? draftEdit.name.trim() : build.draft.name}
                    seed={build.draft.avatar.seed}
                    salt={build.draft.avatar.salt}
                    size={30}
                  />
                )}
                草稿已就绪——可直接修改，确认后入库
              </div>
              {formError !== null && <FormErrorNote>{formError}</FormErrorNote>}
              <div className={cn(FORM_ROW_CLASS, 'mt-2')}>
                <span className={FORM_LABEL_CLASS}>角色名</span>
                <Input
                  value={draftEdit.name}
                  onChange={(e) => setDraftEdit({ ...draftEdit, name: e.target.value })}
                />
              </div>
              <div className={FORM_ROW_CLASS}>
                <span className={FORM_LABEL_CLASS}>角色</span>
                <Input
                  value={draftEdit.role}
                  onChange={(e) => setDraftEdit({ ...draftEdit, role: e.target.value })}
                />
              </div>
              <div className={FORM_ROW_CLASS}>
                <span className={FORM_LABEL_CLASS}>
                  人设手册（统一 Markdown：frontmatter + 身份/使命/规则/领域专章/沟通风格）
                </span>
                <MdEditor
                  value={draftEdit.personaMd}
                  onChange={(next) => setDraftEdit({ ...draftEdit, personaMd: next })}
                />
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={
                    confirming || draftEdit.name.trim() === '' || draftEdit.role.trim() === ''
                  }
                  onClick={() => void confirmDraft()}
                >
                  <IconPlusOutline16 />
                  确认入库
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={confirming}
                  onClick={() => void abandon()}
                >
                  放弃
                </Button>
                <span className={MUTED_CLASS}>也可以在对话里继续调整，这里会跟着刷新。</span>
              </div>
            </div>
          )}
          {confirmedDraft !== null && (
            <div>
              <div className="flex items-center gap-2">
                <span className="inline-flex text-success">
                  <IconCheckOutline16 />
                </span>
                <div className={cn(LINE_CLASS, 'my-0 font-semibold')}>已入库</div>
                <Pill tone="ok">角色列表已更新</Pill>
              </div>
              <div className="mt-2 flex items-center gap-2.5">
                <Avatar name={confirmedDraft.name} size={40} />
                <div>
                  <div className="text-sm font-semibold text-foreground">{confirmedDraft.name}</div>
                  <div className={MUTED_CLASS}>
                    {confirmedDraft.role} · 已加入角色列表，到「团队」页拉进团队即可使用。
                  </div>
                </div>
              </div>
              <div className="mt-2.5 flex gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    setDetailName(confirmedDraft.name);
                    setView('detail');
                  }}
                >
                  查看角色详情
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setAiPrefill(onPrefillAddPeople());
                    setAddMode('ai');
                  }}
                >
                  再建一个
                </Button>
              </div>
            </div>
          )}
          {build !== null && build.status === 'cancelled' && (
            // 已放弃的构建：上下文（步骤/草稿/需求）都保存在会话里，
            // 「继续构建」唤醒后台代理从中断处接着跑（docs/19.16）。
            <Card className={PANEL_CARD_CLASS}>
              <div className="flex items-center gap-2">
                <div className={cn(LINE_CLASS, 'my-0 font-semibold')}>已放弃本次构建</div>
                <Pill tone="muted">已中断</Pill>
              </div>
              {build.note !== '' && <div className={MUTED_CLASS}>{build.note}</div>}
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" disabled={confirming} onClick={() => void resume()}>
                  继续构建
                </Button>
                <span className={MUTED_CLASS}>上下文已保存——从中断处接着跑，不用从头再来。</span>
              </div>
            </Card>
          )}
          {(build === null || build.status === 'cancelled') &&
            (addMode === 'manual' ? (
              // 手动创建（用户迭代 2026-09-03）：直接进入角色手册编辑页，
              // 保存即入库（`roster/saveRoster` 直连），不经对话命令中转。
              <div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex text-primary">
                    <PenLine className="h-4 w-4" />
                  </span>
                  <div className={cn(LINE_CLASS, 'font-semibold')}>手动创建</div>
                  <Pill tone="muted">直接填写手册</Pill>
                  <span className="min-w-0 flex-1" />
                  <Button size="sm" variant="ghost" onClick={() => setAddMode('choose')}>
                    返回
                  </Button>
                </div>
                <div className={cn(FORM_ROW_CLASS, 'mt-2.5')}>
                  <span className={FORM_LABEL_CLASS}>角色名</span>
                  <Input
                    value={name}
                    placeholder="角色名，如：alice"
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className={FORM_ROW_CLASS}>
                  <span className={FORM_LABEL_CLASS}>角色</span>
                  <Input
                    value={role}
                    placeholder="角色：前端开发者 / 后端架构师 / UI 设计师 / 趣味注入师 / researcher / …"
                    onChange={(e) => setRole(e.target.value)}
                  />
                </div>
                <div className={FORM_ROW_CLASS}>
                  <span className={FORM_LABEL_CLASS}>
                    角色手册（Markdown：frontmatter + 身份/使命/规则/领域专章/沟通风格/交付标准）
                  </span>
                  <MdEditor value={personaMd} onChange={setPersonaMd} minHeight={220} />
                </div>
                {manualError !== null && <FormErrorNote>保存失败：{manualError}</FormErrorNote>}
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    size="sm"
                    disabled={manualSaving || name.trim() === '' || role.trim() === ''}
                    onClick={() => void saveManual()}
                  >
                    <IconPlusOutline16 />
                    保存入库
                  </Button>
                  <span className={MUTED_CLASS}>
                    保存后角色进入角色列表，到「团队」页拉进团队即可使用。
                  </span>
                </div>
              </div>
            ) : addMode === 'ai' ? (
              // AI 创建（用户迭代 2026-09-03）：点「AI 创建」此刻才把命令填
              // 进对话输入框，回车发送后回到本页实时看构建。
              <div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex text-primary">
                    <IconSparkle16 />
                  </span>
                  <div className={cn(LINE_CLASS, 'font-semibold')}>AI 创建 · 角色构建师</div>
                  <Pill tone="info">对话式构建</Pill>
                  <span className="min-w-0 flex-1" />
                  <Button size="sm" variant="ghost" onClick={() => setAddMode('choose')}>
                    返回
                  </Button>
                </div>
                {aiPrefill === 'set' && (
                  <Alert className="mt-2.5 flex items-start gap-2 rounded-[10px] bg-business-tint px-4 py-3">
                    <span className="text-sm font-semibold text-[color:var(--eteams-brand-ink)]">
                      ✓ 已填充到对话输入框
                    </span>
                  </Alert>
                )}
                {aiPrefill === 'copied' && (
                  <Alert className="mt-2.5 flex items-start gap-2 rounded-[10px] bg-business-tint px-4 py-3">
                    <span className="text-sm font-semibold text-[color:var(--eteams-brand-ink)]">
                      ✓ 命令已复制——去对话输入框粘贴发送
                    </span>
                  </Alert>
                )}
                <CommandChip text={ADD_PEOPLE_TEMPLATE} />
                {PREFILL_STEPS.map((s, i) => (
                  <div key={s} className={STEP_ROW_CLASS}>
                    <span className={STEP_NUM_CLASS}>{i + 1}</span>
                    <span>{s}</span>
                  </div>
                ))}
                {aiPrefill === 'set' ? (
                  <div className={cn(MUTED_CLASS, 'mt-2.5')}>
                    提示：已模拟「键入 /eteam +
                    空格」完成命令认领（claimed）——补全两个【】占位符后直接回车即可；编辑正文时命令高亮收起属正常行为。
                  </div>
                ) : (
                  <div className="mt-2.5 flex items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={fillAi}>
                      重试填充
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void writeClipboard(ADD_PEOPLE_TEMPLATE)}
                    >
                      复制命令
                    </Button>
                    <span className={cn(MUTED_CLASS, 'mt-0')}>
                      {aiPrefill === 'aborted'
                        ? '你保留了输入框里未发送的草稿——重试填充会再次询问是否覆盖。'
                        : '也可复制命令去对话粘贴发送。'}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              // 方式选择（默认态，用户迭代 2026-09-03）：不再默认预填——两条
              // 创建路径各自显式进入。
              <div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex text-primary">
                    <IconPlusOutline16 />
                  </span>
                  <div className={cn(LINE_CLASS, 'font-semibold')}>新增角色</div>
                  <Pill tone="muted">选择创建方式</Pill>
                </div>
                <div className="mt-3 flex flex-col gap-2.5">
                  <button
                    type="button"
                    className={cn('eteams-role-row', ADD_MODE_CARD_CLASS)}
                    onClick={fillAi}
                  >
                    <span className={ADD_MODE_ICON_CLASS}>
                      <IconSparkle16 />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-foreground">AI 创建</span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                        把命令填进对话输入框，角色构建师在对话里帮你补全人设；草稿就绪后回来确认入库。
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                  <button
                    type="button"
                    className={cn('eteams-role-row', ADD_MODE_CARD_CLASS)}
                    onClick={() => {
                      setAiPrefill(null);
                      setAddMode('manual');
                    }}
                  >
                    <span className={ADD_MODE_ICON_CLASS}>
                      <PenLine className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-foreground">手动创建</span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                        直接进入角色手册（Markdown）编辑页，填好名字与手册，保存即入库。
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                </div>
              </div>
            ))}
        </Card>
      </div>
    );
  }

  if (view === 'detail' && detail !== null) {
    const teamNames = teamsOf(detail.name);
    const isLeader = detail.name === LEADER_NAME;
    const nameLocked = PROTECTED_MEMBERS.includes(detail.name);
    // 头像：编辑态取草稿（随机头像实时预览），只读态取条目现值。
    const avatarPair =
      detailEditing && detailDraftAvatar !== null ? detailDraftAvatar : detail.avatar;
    return (
      // 版式：详情列不再限宽（用户要求解除固定宽度），面板全宽利用
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setView('list');
            cancelDetailEdit(); // 编辑中返回列表即丢弃草稿
          }}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          返回角色列表
        </Button>
        <Card className={cn(PANEL_CARD_CLASS, 'mt-2')}>
          <div className="flex items-center gap-3.5">
            {/* 头像描边环（视觉升级）：品牌淡底档（D21b token），柔和不抢戏。
            编辑态头像下挂「随机头像」钮（用户迭代 2026-09-03）。 */}
            <div className="flex flex-none flex-col items-center gap-1.5">
              <div className="rounded-full border-2 border-solid p-0.5 leading-none border-business-tint">
                <Avatar
                  name={detail.name}
                  seed={avatarPair?.seed}
                  salt={avatarPair?.salt}
                  size={52}
                />
              </div>
              {detailEditing && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
                  onClick={rollDetailAvatar}
                  title="随机换一个头像"
                >
                  <Dices className="h-3.5 w-3.5" />
                  随机头像
                </Button>
              )}
            </div>
            {/* 角色（用户反馈）：不再需要标签——名字即身份，手册即人设。 */}
            <div className="min-w-0 flex-1">
              {detailEditing && !nameLocked ? (
                <Input
                  value={detailDraftName}
                  onChange={(e) => setDetailDraftName(e.target.value)}
                  aria-label="角色名称"
                  className="h-9 max-w-[320px] text-lg font-semibold"
                />
              ) : (
                <div className="text-lg font-semibold tracking-tight text-foreground">
                  {detail.name}
                </div>
              )}
              <div className={cn(MUTED_CLASS, 'mt-0.5')}>
                {isLeader
                  ? '领队 · 手册与头像可编辑，名称为系统保留'
                  : nameLocked
                    ? '系统保留角色 · 名称不可改，其余可编辑'
                    : detailEditing
                      ? '编辑中：名称、头像与手册，保存后生效'
                      : '点击右上「编辑」可修改名称、头像与手册'}
              </div>
              {teamNames.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {teamNames.map((n) => (
                    <span key={n} className={CHIP_CLASS}>
                      {n}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {/* 编辑/保存/取消（用户迭代 2026-09-03）：编辑钮从手册卡上移到
            详情页头——与名称/头像同一行收口。 */}
            {detailEditing ? (
              <div className="flex flex-none items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={detailSaving}
                  onClick={cancelDetailEdit}
                >
                  取消
                </Button>
                <Button size="sm" disabled={detailSaving} onClick={saveDetail}>
                  保存
                </Button>
              </div>
            ) : (
              <Button type="button" size="sm" variant="outline" onClick={startDetailEdit}>
                <PenLine className="h-3.5 w-3.5" />
                编辑
              </Button>
            )}
          </div>
          {detailError !== null && (
            <div className="mt-2">
              <FormErrorNote>{detailError}</FormErrorNote>
            </div>
          )}
        </Card>
        <Card className={PANEL_CARD_CLASS}>
          <div className={cn(SECTION_TITLE_CLASS, 'flex items-center gap-2')}>
            <span>角色手册（Markdown）</span>
          </div>
          {detailEditing ? (
            <MdEditor value={detailDraftMd} onChange={setDetailDraftMd} minHeight={220} />
          ) : (
            <MarkdownText text={handbookSeed(detail)} />
          )}
        </Card>
        {team !== undefined && detailMemberView !== null && (
          <MemberDialog team={team} member={detailMemberView} />
        )}
      </div>
    );
  }

  return (
    <div>
      <Card className={PANEL_CARD_CLASS}>
        {/* 页头（用户迭代 2026-09-03）：搜索框与「角色」标题平齐（同一行），
          右侧留新增入口；空列表不渲染搜索框。 */}
        <div className="mb-2.5 flex items-center gap-2">
          <h3 className={cn(LIST_TITLE_CLASS, 'flex-none')}>角色</h3>
          <span className={LIST_COUNT_CLASS}>{members.length} 个</span>
          <span className="min-w-0 flex-1" />
          {members.length > 0 && (
            <Input
              value={query}
              placeholder="搜索角色名…"
              className="w-[200px]"
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0); // 新搜索从头翻页
              }}
            />
          )}
          {build !== null &&
          (build.status === 'active' || build.status === 'awaiting_confirmation') ? (
            // 有未入库的构建草稿：新增入口让位给「待加入角色」，防止误开新
            // 构建把旧草稿顶掉（docs/19.16）。
            <Button
              size="sm"
              onClick={() => {
                setAddMode('ai');
                setView('add');
              }}
            >
              待加入角色
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                // 用户迭代 2026-09-03：新增不再默认预填对话——先进新增页选
                // 「手动创建 / AI 创建」，点「AI 创建」才把命令填进输入框。
                setAddMode('choose');
                setView('add');
              }}
            >
              <IconPlusOutline16 />
              新增角色
            </Button>
          )}
        </div>
        {listError !== null && <FormErrorNote>{listError}</FormErrorNote>}
        {members.length === 0 ? (
          <div className={EMPTY_CLASS}>
            还没有角色。点「新增角色」创建第一个角色——AI
            创建在对话里构建人设，手动创建直接填写角色手册。
          </div>
        ) : (
          <>
            {/* 角色卡片栅格（用户迭代 2026-09-03）：一行式横排——头像在前、
            名称与所属团队随后、删除钮常驻行尾（不再 hover 显形）；
            hover/描边由 ROLE_LIST_CSS 接管。 */}
            <div className={CARD_GRID_CLASS}>
              {pageRows.map((m) => {
                const teamNames = teamsOf(m.name);
                const isProtected = PROTECTED_MEMBERS.includes(m.name);
                return (
                  <div
                    key={m.name}
                    className={cn('eteams-role-row', ROLE_CARD_CLASS)}
                    onClick={() => {
                      setDetailName(m.name);
                      setView('detail');
                    }}
                  >
                    <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} size={40} />
                    {/* 角色（用户反馈）：不再需要标签——名字即身份。 */}
                    <div className="min-w-0 flex-1">
                      <span className="eteams-role-name block max-w-full text-sm font-semibold text-foreground">
                        {m.name}
                      </span>
                      {teamNames.length > 0 && (
                        <div className={cn('eteams-role-name', MUTED_CLASS, 'mt-0.5')}>
                          {teamNames.join('、')}
                        </div>
                      )}
                    </div>
                    {isProtected ? null : (
                      <button
                        type="button"
                        className="eteams-role-del"
                        onClick={(e) => {
                          e.stopPropagation();
                          del(m.name);
                        }}
                      >
                        删除
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {totalPages > 1 && (
              <div className="mt-2.5 flex items-center justify-center gap-3">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={safePage === 0}
                  onClick={() => setPage(safePage - 1)}
                >
                  上一页
                </Button>
                <span className={PAGE_PILL_CLASS}>
                  第 {safePage + 1} / {totalPages} 页 · 共 {filtered.length} 个
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={safePage >= totalPages - 1}
                  onClick={() => setPage(safePage + 1)}
                >
                  下一页
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

/** 汇报：成员选择 + 汇报时间线（原「对话」，D15 只读）。S13 Tailwind 化。 */
function ReportsTab({
  team,
  dialogMember,
  setDialogMember,
  member,
}: {
  team: TeamSnapshot;
  dialogMember: string | null;
  setDialogMember: (name: string | null) => void;
  member: MemberView | null;
}): ReactNode {
  return (
    <div>
      <div className={FORM_ROW_CLASS}>
        <span className={FORM_LABEL_CLASS}>选择成员</span>
        {/* docs/23 S23-3：原生 select 迁 shadcn Select（哨兵值映射回 null）。 */}
        <Select
          value={dialogMember ?? SELECT_NONE}
          onValueChange={(v) => setDialogMember(v === SELECT_NONE ? null : v)}
        >
          <SelectTrigger className="h-[30px] w-full max-w-[280px] px-2.5 text-[12px] font-medium">
            <SelectValue placeholder="— 选择 —" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SELECT_NONE} className="text-[12px]">
              — 选择 —
            </SelectItem>
            {team.members.map((m) => (
              <SelectItem key={m.name} value={m.name} className="text-[12px]">
                {m.name}（{m.role}）
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {member === null ? (
        <div className={MUTED_CLASS}>选择一个成员查看对话时间线。</div>
      ) : (
        <MemberDialog team={team} member={member} />
      )}
    </div>
  );
}
