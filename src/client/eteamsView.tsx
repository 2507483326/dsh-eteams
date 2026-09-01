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
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import {
  Button,
  Input,
  IconCheckOutline16,
  IconPlusOutline16,
  IconSparkle16,
  MarkdownText,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { Provider, useDispatch, useSelector } from 'react-redux';
import { ADD_PEOPLE_TEMPLATE, prefillComposer, type PrefillOutcome } from './addPeople';
import { Avatar } from './avatar';
import {
  activateConversationTab,
  consumePendingGotoAdd,
  consumePendingGotoAddTeam,
  consumePendingGotoRoster,
  consumePendingSelectTeam,
  GOTO_ADD_EVENT,
  GOTO_ADD_TEAM_EVENT,
  GOTO_ROSTER_EVENT,
  SELECT_TEAM_EVENT,
} from './bridge';
import { cn } from './cn';
import { ClientErrorBoundary } from './diagnostics';
import { EteamsBackdrop } from './eteamsBackdrop';
import { Badge } from './components/ui/badge';
import { Card } from './components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog';
import { MdEditor } from './mdEditor';
import {
  addTeamMember,
  createTeamViaPanel,
  fetchAgentActivity,
  removeTeamMember,
  type BuildDraft,
  type InterviewQuestion,
  type RosterMember,
} from './api';
import {
  relativeTime,
  useActivityMonitor,
  type CaptainView,
  type MemberView,
  type TaskView,
  type TeamSnapshot,
} from './monitor';
import { getApp, type RootState } from './store/app';
import { PHASE_LABELS } from './phaseLabels';

/** The leader is a member too — default-joined, undeletable (用户定稿模型). */
const LEADER_NAME = '项目牧羊人';
/** The role-builder persona is a system member as well: undeletable,
 * listed right under the leader (用户反馈：角色构建师不能删除). */
const ROLE_BUILDER_NAME = '角色构建师';
/** Members the panel never offers a delete button for (host enforces too). */
const PROTECTED_MEMBERS: readonly string[] = [LEADER_NAME, ROLE_BUILDER_NAME];

/** Sort rank: leader first, role builder second, everyone else after. */
function memberRank(name: string): number {
  if (name === LEADER_NAME) return 0;
  if (name === ROLE_BUILDER_NAME) return 1;
  return 2;
}

const STATUS_GROUPS: { id: string; label: string; statuses: string[]; tone: Tone }[] = [
  { id: 'active', label: '执行中', statuses: ['in_progress', 'retrying'], tone: 'info' },
  { id: 'assigned', label: '待接取', statuses: ['assigned'], tone: 'info' },
  { id: 'ready', label: '待指派', statuses: ['ready'], tone: 'muted' },
  {
    id: 'decision',
    label: '待决策',
    statuses: ['awaiting_decision', 'needs_user'],
    tone: 'warn',
  },
  { id: 'paused', label: '已挂起', statuses: ['paused', 'suspended'], tone: 'warn' },
  { id: 'blocked', label: '被阻断', statuses: ['blocked'], tone: 'err' },
  { id: 'completed', label: '已完成', statuses: ['completed'], tone: 'ok' },
  { id: 'failed', label: '失败', statuses: ['failed'], tone: 'err' },
  { id: 'cancelled', label: '已取消', statuses: ['cancelled'], tone: 'muted' },
  { id: 'draft', label: '草稿', statuses: ['draft'], tone: 'muted' },
];

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  ready: '待指派',
  assigned: '待接取',
  in_progress: '执行中',
  retrying: '重试中',
  paused: '已挂起',
  awaiting_decision: '待决策',
  needs_user: '待用户',
  suspended: '已暂停',
  blocked: '被阻断',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/**
 * 角色/团队列表注入样式表（ROLE_LIST_CSS）消费的主题 token——S12–S14 迁移
 * 后 inline 样式消费面已清空，S15 裁剪到注入表实际用到的 7 个键（hover/
 * focus-within/attr 选择器仍需样式表承载，见 ROLE_LIST_CSS 注记）。
 * 亮暗跟随 GUI：每个色值都经 --dsw-alias-* 解析。
 */
const T = {
  surface: 'var(--dsw-alias-bg-layer-1, #ffffff)',
  border: 'var(--dsw-alias-border-l1, rgba(100,116,139,0.14))',
  border2: 'var(--dsw-alias-border-l2, rgba(100,116,139,0.26))',
  accent: 'var(--dsw-alias-brand-primary, #0ea5e9)',
  accentSoft: 'var(--dsw-alias-interactive-bg-active, rgba(14,165,233,0.12))',
  err: 'var(--dsw-alias-state-error-primary, #b91c1c)',
  // ⚠️ 主题的 state-*-secondary 是实心 400 色（amber-400/green-400/red-400），
  // 不是 10% 淡色调——实心底 + 实心 fg 会同色相打架（橙字橙底不可读，用户
  // 实测）。静态色阶的 100 档才是淡底，改用之（static 不随主题翻转）。
  errBg: 'var(--dsw-static-red-100, #fee2e2)',
};

/** Semantic tone — every status color flows through these five buckets. */
type Tone = 'info' | 'ok' | 'warn' | 'err' | 'muted';

/**
 * S12：Tone→工具类映射表（完整字面量，content 扫描可检出——禁 `tone-${x}`
 * 拼接，21.5.1 纪律）。语义色走 token 类（D19c；success/warning/business
 * 为附录 A 扩展 token，muted 走中性 token muted-foreground）。
 * S13 的状态徽标（pillClass/dotClass）沿用此表语义，S14 余下区块同。
 */
const TONE_CLASS: Record<Tone, string> = {
  info: 'text-business',
  ok: 'text-success',
  warn: 'text-warning',
  err: 'text-destructive',
  muted: 'text-muted-foreground',
};

/**
 * 团队阶段→Tone（对齐 STATUS_GROUPS 既有语义：running 对齐「执行中」→info、
 * paused 对齐「已挂起」→warn、completed 对齐「已完成」→ok；staged 的计划
 * 待批准对齐「待决策」→warn；halted 对齐失败→err；archived 中性→muted）。
 */
const PHASE_TONES: Record<string, Tone> = {
  staged: 'warn',
  running: 'info',
  paused: 'warn',
  halted: 'err',
  completed: 'ok',
  archived: 'muted',
};

function memberTone(status: string): Tone {
  if (status === 'working' || status === 'busy') return 'info';
  if (status === 'ready' || status === 'idle' || status === 'done') return 'ok';
  if (status === 'paused') return 'warn';
  if (status === 'failed' || status === 'error') return 'err';
  return 'muted';
}

/* styles/fns 两个 inline 工厂已随 S14 收尾迁移整体删除（docs/21 21.6 死
代码清理）：styles.* → 下方「S14 迁移新增的类名常量」段（或沿用 S12/S13
既有类常量），fns.pill → pillClass（S13 已备、本批全面板统一），
fns.progressFill → PROGRESS_FILL_CLASS + 宽度百分比 inline（S5 card 先例：
运行时动态值保留 inline，S14 清点口径）。 */

/* —— S12 迁移后的类名常量（Tailwind 工具类，完整字面量；模板串组合仅限
const 字面量插值，运行时动态值一律 inline style——S5/S11 既有口径）—— */

/** 边框沿用原 l1 档（shadcn --border 桥的是 l2，任意值直引保持视觉；S11 先例）。 */
const BORDER_L1_CLASS = 'border-[color:var(--dsw-alias-border-l1,rgba(100,116,139,0.14))]';
/** 次级文字：label-secondary 无语义 token（附录 A 未桥接），任意值直引。 */
const TEXT2_CLASS = 'text-[color:var(--dsw-alias-label-secondary,#47546c)]';
/** 原 styles.muted（12px / 三级灰 token / overflow-wrap:anywhere），
 * S12–S14 各批次区块共用的类常量。 */
const MUTED_CLASS = 'text-[12px] leading-[1.55] text-muted-foreground [overflow-wrap:anywhere]';
/** 原 styles.line（4px 上下距 / 13px / 行高 1.6 / 次级文字）。 */
const LINE_CLASS = `my-1 text-[13px] leading-[1.6] ${TEXT2_CLASS}`;
/** 原 styles.sectionTitle（11px/600/三级灰 token/字距 0.5px，下距 8px）。 */
const SECTION_TITLE_CLASS =
  'mb-2 text-[11px] font-semibold leading-[1.55] tracking-[0.5px] text-muted-foreground';
/** 原 styles.empty（虚线框空态）；边框色吃 S3 桥默认（--border 即原 l2 档）。 */
const EMPTY_CLASS =
  'rounded-xl border border-dashed px-5 py-9 text-center leading-[1.55] text-muted-foreground';
/** 原 styles.banner：warn 语义色走 token 类，淡底是 static-amber-100
（无 token，任意值直引，D19c）。 */
const BANNER_CLASS =
  'mb-3 rounded-xl border border-solid border-warning bg-[color:var(--dsw-static-amber-100,#fef5e7)] px-3.5 py-2.5 text-[13px] leading-[1.55] text-foreground';
/** 面板卡片（原 styles.card → shadcn Card 的覆盖层）：底色回 layer-1 档
（Card 默认 bg-card 是 layer-2）、l1 边框、原阴影；px-4 py-3.5 = 14px 16px。
eteams-ui 字面量随 Card 根（S5 试点双保险）。 */
const PANEL_CARD_CLASS = `eteams-ui mb-3 min-w-0 border border-solid bg-background px-4 py-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.03)] ${BORDER_L1_CLASS}`;
/** 原 styles.progressTrack（6px 高 / sunken 淡底 / 999 圆角 / 上 10 下 6）。 */
const PROGRESS_TRACK_CLASS =
  'mt-2.5 mb-1.5 h-1.5 overflow-hidden rounded-full bg-[color:var(--dsw-alias-bg-layer-2,#edf0f4)]';
/** 原 fns.progressFill 的静态面：accent→info 渐变（任意值完整字面量）；
宽度百分比是运行时动态值，保留 inline style（S14 清点口径，S5 card 先例）。 */
const PROGRESS_FILL_CLASS =
  'h-full rounded-full bg-[linear-gradient(90deg,var(--dsw-alias-brand-primary,#0ea5e9),var(--dsw-alias-state-business-primary,#1d4ed8))]';
/** 原 styles.eventRow（7px 上下距 / 13px / 次级文字 / 下边线）。 */
const EVENT_ROW_CLASS = `border-b border-solid py-[7px] text-[13px] leading-[1.55] ${BORDER_L1_CLASS} ${TEXT2_CLASS}`;
/** 原 styles.rail（窄栏态：84px / 3px 纵向间距 / 右分隔线 / 上 2 右 12）。
 * docs/22 S22-2：面板宽 ≥720px 时改用官网风格的宽栏 RAIL_WIDE_CLASS，
 * 窄面板回落本类（84px 窄栏原样保留，窄上下文零回归）。 */
const RAIL_CLASS = `flex w-[84px] shrink-0 flex-col gap-[3px] border-r border-solid pr-3 pt-0.5 ${BORDER_L1_CLASS}`;

/** 官网 docs 侧栏风格的宽栏（docs/22 D20c，tailwindcss.cn 实测标记还原）：
 * 172px（官网 15rem 等比收窄）+ 右分隔线；列表自带连续左细线（官网
 * `border-l border-slate-100`，这里走主题跟随的 l1 别名）。 */
const RAIL_WIDE_CLASS = `flex w-[172px] shrink-0 flex-col border-r border-solid pr-4 pt-1 ${BORDER_L1_CLASS}`;
/** 宽栏分组标题（官网 h5：`mb-3 font-semibold text-slate-900` 的 token 版）。 */
const RAIL_TITLE_CLASS = 'mb-3 font-semibold text-foreground';
/** 宽栏导航列表（官网 ul：`space-y-2 border-l` 的 token 版）。 */
const RAIL_LIST_CLASS = `space-y-2 border-l border-solid ${BORDER_L1_CLASS}`;

/** 宽栏导航链接三态（官网 a 的签名交互，docs/22 22.1.3）：自带 1px 左边线
 * 压在列表线上（`-ml-px`），常态透明、hover 亮线 + 文字加深、**激活 = sky
 * 文字 + 同色左线（border-current）+ semibold**；全部完整字面量（21.5.1
 * content 扫描纪律），色走主题跟随别名（D19c）。 */
const RAIL_LINK_BASE_CLASS =
  'block border-0 border-l border-solid bg-transparent py-[3px] pl-4 -ml-px text-left text-[13px] leading-6 [font-family:inherit] transition-colors';
const RAIL_LINK_IDLE_CLASS =
  'border-transparent text-[color:var(--dsw-alias-label-secondary,#334155)] hover:border-[color:var(--dsw-alias-label-tertiary,#94a3b8)] hover:text-foreground';
const RAIL_LINK_ACTIVE_CLASS = 'border-current font-semibold text-primary';

/** 侧栏按钮（窄栏态，原 fns.railBtn）：active/idle 两态都是完整字面量映射（无拼接，
teamsButton tabBtnClass 同款）；active 底=交互激活、字=brand 主色 token。 */
const railBtnClass = (active: boolean): string =>
  cn(
    'block w-full cursor-pointer rounded-[8px] border-none px-2.5 py-[7px] text-left text-xs leading-[1.55] [letter-spacing:0.2px]',
    active
      ? 'bg-[color:var(--dsw-alias-interactive-bg-active,rgba(14,165,233,0.12))] font-semibold text-primary'
      : 'bg-transparent font-medium text-[color:var(--dsw-alias-label-secondary,#47546c)]',
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

/** 原 styles.select（面板下拉）：成员拉人选择与汇报成员选择共用。 */
const SELECT_CLASS =
  'rounded-[8px] border border-solid bg-background px-2.5 py-[5px] text-[12px] font-medium text-foreground';
/** 原 styles.formRow / styles.formLabel（表单行）：汇报页先用，S14 表单复用。 */
const FORM_ROW_CLASS = 'mb-2.5 flex flex-col gap-[5px]';
const FORM_LABEL_CLASS = 'text-[11px] font-semibold tracking-[0.3px] text-muted-foreground';
/** 原 styles.listTitle / styles.listCount（列表页头）：S14 的团队/角色列表头复用。 */
const LIST_TITLE_CLASS = 'm-0 min-w-0 flex-1 text-[14px] font-bold text-foreground';
const LIST_COUNT_CLASS = 'text-[12px] text-muted-foreground';
/** 原 styles.memberGrid（成员卡片栅格，最小 230px 自适应列）。 */
const MEMBER_GRID_CLASS = 'grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3';
/** 原 styles.memberCard（成员卡片：l1 边框 / 12px 圆角 / 8px 纵向间距）。 */
const MEMBER_CARD_CLASS = `flex flex-col gap-2 rounded-xl border border-solid bg-background p-3 ${BORDER_L1_CLASS}`;
/** 原 styles.roleChip（品牌淡底小徽标）：S14 团队卡片「当前」复用。 */
const ROLE_CHIP_CLASS =
  'inline-block rounded-full bg-[color:var(--dsw-alias-interactive-bg-active,rgba(14,165,233,0.12))] px-[9px] py-px text-[11px] font-semibold text-primary';
/** 原 styles.btn（描边小按钮）：移出团队在调用点叠 text-destructive。 */
const BTN_CLASS = `cursor-pointer rounded-[8px] border border-solid bg-background px-3 py-[5px] text-[12px] font-medium ${TEXT2_CLASS}`;
/** 原 styles.drawer（sunken 抽屉面板）：任务抽屉已升级为 Dialog，现仅成员
汇报时间线使用。 */
const DRAWER_CLASS = `mt-2 mb-3.5 rounded-[10px] border border-solid bg-[color:var(--dsw-alias-bg-layer-2,#edf0f4)] px-3.5 py-3 ${BORDER_L1_CLASS}`;
/** 原 styles.dialogItem（汇报时间线条目）。 */
const DIALOG_ITEM_CLASS = `my-1 rounded-[8px] border border-solid bg-background px-2.5 py-[7px] text-[12.5px] ${BORDER_L1_CLASS} ${TEXT2_CLASS}`;
/** 原 styles.taskRow（任务行：l1 下边线 / 8px 圆角 / 指针）。 */
const TASK_ROW_CLASS = `cursor-pointer rounded-[8px] border-b border-solid px-2 py-2.5 ${BORDER_L1_CLASS}`;
/** 原 styles.chip（依赖小芯片）：S14 角色详情的所属团队芯片复用。 */
const CHIP_CLASS = `mr-1 mb-0.5 inline-block rounded-[6px] bg-[color:var(--dsw-alias-bg-layer-2,#edf0f4)] px-[7px] py-px text-[11px] ${TEXT2_CLASS}`;
/** 原 styles.attempt（执行线路尝试条目：l2 左描边；--border 桥即 l2 档）。 */
const ATTEMPT_CLASS = 'my-2.5 border-l-2 border-solid border-border py-0.5 pl-3';
/** 任务详情 Dialog 的调用面覆盖：限宽收高可滚动 + 面板文字基准（portal
容器挂在 body 下，不继承 styles.root 的 13px/前景色，这里显式补齐；
max-w-xl 压过上游 max-w-lg，rounded-xl 与上游 sm:rounded-lg 同为 12px）。 */
const DRAWER_DIALOG_CLASS =
  'max-h-[70vh] max-w-xl overflow-y-auto rounded-xl text-[13px] leading-[1.55] text-foreground';

/** 原 fns.pill 的类名版（S13 引入，S14 起全面板统一）。Pill 文字沿用原
PILL_FG 的 700 级深色档——ok/warn/err 是刻意硬编码的深色（state-*-primary
饱和档压不住淡底），不走 token；底色沿用原 TONE_BG（static-*-100 淡底任意
值直引，info 为同值 rgba 直引）。 */
const PILL_BASE_CLASS =
  'inline-flex w-fit items-center gap-[5px] rounded-full px-[9px] py-px text-[11px] font-medium';
const PILL_TONE_CLASS: Record<Tone, string> = {
  info: 'bg-[color:rgba(29,78,216,0.1)] text-business',
  ok: 'bg-[color:var(--dsw-static-green-100,#e6faed)] text-[#15803d]',
  warn: 'bg-[color:var(--dsw-static-amber-100,#fef5e7)] text-[#b45309]',
  err: 'bg-[color:var(--dsw-static-red-100,#fee2e2)] text-[#b91c1c]',
  muted: 'bg-[color:var(--dsw-alias-bg-layer-2,#edf0f4)] text-muted-foreground',
};
/** 原 fns.dot 的类名版（完整字面量映射）：dot 走饱和 primary token（与
PILL_FG 的深档文字互不影响，S12 既有口径）。 */
const DOT_BASE_CLASS = 'inline-block h-1.5 w-1.5 shrink-0 rounded-full';
const DOT_TONE_CLASS: Record<Tone, string> = {
  info: 'bg-business',
  ok: 'bg-success',
  warn: 'bg-warning',
  err: 'bg-destructive',
  muted: 'bg-muted-foreground',
};
const pillClass = (tone: Tone): string => cn(PILL_BASE_CLASS, PILL_TONE_CLASS[tone]);
const dotClass = (tone: Tone): string => cn(DOT_BASE_CLASS, DOT_TONE_CLASS[tone]);

/* —— S14 迁移新增的类名常量（面板壳/团队卡片栅格/构建工作台/角色库收尾；
完整字面量，同 S12/S13 纪律；置于 S12/S13 段之后——模板串插值在模块初始化
时求值，须晚于所引用的 BORDER_L1_CLASS/TEXT2_CLASS 等常量）—— */

/** 面板壳（原 styles.root 的布局面）：作用域根（.eteams-ui）自身不承工具类
（`.eteams-ui .utility` 后代选择器机制），壳布局迁进这层内壳；height 锚点
仍留作用域根 inline（宿主视图区无 .eteams-ui 祖先，见文件头 S14 注记）。 */
const SHELL_CLASS =
  'relative box-border flex h-full gap-4 overflow-hidden px-[18px] py-3.5 text-[13px] leading-[1.55] text-foreground font-sans';
/** 原 styles.content：内容列（纵滚/横截 + 2px 右距，用户反馈注记原样保留）。 */
const CONTENT_CLASS = 'min-w-0 flex-1 overflow-x-hidden overflow-y-auto pr-0.5';
/** 原 styles.formError：语义色走 destructive token（与 state-error 同源，D19c）。 */
const FORM_ERROR_CLASS = 'mb-2 mt-1 text-[12px] text-destructive';
/** 原 styles.cardGrid（团队/角色卡片栅格，最小 210px 自适应列）。 */
const CARD_GRID_CLASS = 'grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3';
/** 原 styles.phasePill（团队卡片阶段徽标：淡底弱化档）。 */
const PHASE_PILL_CLASS =
  'shrink-0 whitespace-nowrap rounded-full bg-[color:var(--dsw-alias-bg-layer-2,#edf0f4)] px-2 py-px text-[11px] font-medium text-[color:var(--dsw-alias-label-secondary,#47546c)]';
/** 原 styles.teamCard（底色/边框/悬停仍由 .eteams-team-card 样式表接管）。 */
const TEAM_CARD_CLASS = 'min-w-0 cursor-pointer rounded-xl p-3.5';
/** 原 styles.roleCard（同上：底色/边框/悬停由 .eteams-role-row 样式表接管）。 */
const ROLE_CARD_CLASS =
  'relative flex min-w-0 cursor-pointer flex-col items-start gap-2.5 rounded-xl p-3.5 text-left text-foreground';
/** 原 styles.pagePill（分页计数 pill）。 */
const PAGE_PILL_CLASS =
  'whitespace-nowrap rounded-full bg-[color:var(--dsw-alias-bg-layer-2,#edf0f4)] px-2.5 py-0.5 text-[11px] text-[color:var(--dsw-alias-label-secondary,#47546c)]';
/** 原 styles.detailRow / detailLabel（构建中草稿预览行；l1 下边线任意值直引）。 */
const DETAIL_ROW_CLASS = `flex gap-2.5 border-b border-solid py-[7px] text-[12px] leading-[1.55] ${BORDER_L1_CLASS}`;
const DETAIL_LABEL_CLASS = 'w-16 shrink-0 pt-px text-[11px] font-semibold text-muted-foreground';
/** 原 styles.cmdChip（预填命令芯片：等宽字体 + l1 边框 + 次级文字）。 */
const CMD_CHIP_CLASS = `mt-2 break-all rounded-[8px] border border-solid bg-[color:var(--dsw-alias-bg-layer-2,#edf0f4)] px-[11px] py-[9px] text-[12px] leading-[1.7] font-mono ${BORDER_L1_CLASS} ${TEXT2_CLASS}`;
/** 原 styles.buildStep / stepRow / stepNum / prefillBanner（构建工作台）。 */
const BUILD_STEP_CLASS = 'flex items-center gap-2 py-[3px] text-[12.5px]';
const STEP_ROW_CLASS = `mt-2 flex items-start gap-2 text-[12.5px] leading-[1.55] ${TEXT2_CLASS}`;
const STEP_NUM_CLASS =
  'mt-px inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[color:var(--dsw-alias-interactive-bg-active,rgba(14,165,233,0.12))] text-[11px] font-semibold text-primary';
const PREFILL_BANNER_CLASS = `mt-2.5 flex items-start gap-2 rounded-[10px] border border-solid bg-[color:rgba(29,78,216,0.1)] px-3 py-2.5 ${BORDER_L1_CLASS}`;

/** S13：执行链站点行——✔/●/◌ 结构原样保留，仅样式改 Tailwind 类。 */
function TaskStations({ task }: { task: TaskView }): ReactNode {
  if (task.chainLength === 0) return null;
  return (
    <div className="mt-[3px]">
      {task.chain.map((s, i) => (
        <span key={i} className="mr-1.5 text-[12px] text-muted-foreground">
          {s.stationStatus === 'done' ? '✔' : s.stationStatus === 'current' ? '●' : '◌'} {s.member}
          {i < task.chain.length - 1 ? ' →' : ''}
        </span>
      ))}
      <span className={MUTED_CLASS}>
        {' '}
        站点 {Math.min(task.chainCursor + 1, task.chainLength)}/{task.chainLength}
      </span>
    </div>
  );
}

/**
 * S13：任务详情抽屉 → shadcn Dialog。开合状态仍走 ui model：expandedTask
 * === task.taskId 时由 TasksTab 挂载本组件（track 拉取随挂载触发，与迁移前
 * 一致），挂载即 open；Esc/遮罩/关闭钮统一走 onOpenChange → onClose，由
 * 调用点 dispatch ui/setDrawerTask(null) 收起（S9 的显式 null 语义）。
 * 内容结构原样保留（产出 + 尝试时间线），仅样式改 Tailwind 类。
 */
function TaskDrawer({
  team,
  task,
  now,
  onClose,
}: {
  team: TeamSnapshot;
  task: TaskView;
  now: number;
  onClose: () => void;
}): ReactNode {
  const [track, setTrack] = useState<{
    attempts?: {
      id: string;
      member: string;
      kind: string;
      status: string;
      claimedAt?: number;
      endedAt?: number;
      progress?: { at: number; text: string }[];
      error?: string;
      result?: { output: string };
    }[];
  } | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch(
      `/eteams-api/team/${encodeURIComponent(team.teamId)}/task/${encodeURIComponent(task.taskId)}/track`,
      { cache: 'no-store' },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (alive && body !== null) setTrack(body);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [team.teamId, team.version, task.taskId]);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className={DRAWER_DIALOG_CLASS}>
        <DialogHeader className="space-y-1 text-left">
          <DialogTitle className="text-[13px] leading-[1.5]">
            {task.taskId} · {task.subject}
          </DialogTitle>
          <DialogDescription className={MUTED_CLASS}>
            {STATUS_LABELS[task.status] ?? task.status}
            {task.assignee !== null ? ` · ${task.assignee}` : ''}
          </DialogDescription>
        </DialogHeader>
        {task.outcome !== null && <div className={LINE_CLASS}>产出：{task.outcome}</div>}
        {(track?.attempts ?? [])
          .slice()
          .reverse()
          .map((a) => (
            <div key={a.id} className={ATTEMPT_CLASS}>
              <div className={LINE_CLASS}>
                <strong>{a.id}</strong> · {a.kind} · {a.member} ·{' '}
                {STATUS_LABELS[a.status] ?? a.status}
                <span className={MUTED_CLASS}>
                  {' '}
                  {a.claimedAt ? relativeTime(a.claimedAt, now) : ''}
                  {a.endedAt ? `–${relativeTime(a.endedAt, now)}` : ''}
                </span>
              </div>
              {(a.progress ?? []).map((p, i) => (
                <div key={i} className={cn(MUTED_CLASS, 'my-1 leading-[1.6]')}>
                  {relativeTime(p.at, now)} {p.text}
                </div>
              ))}
              {a.error !== undefined && (
                <div className="my-1 text-[13px] leading-[1.6] text-destructive">✘ {a.error}</div>
              )}
              {a.result?.output !== undefined && (
                <div className={MUTED_CLASS}>✔ {a.result.output}</div>
              )}
            </div>
          ))}
        {track === null && <div className={MUTED_CLASS}>执行线路加载中…</div>}
      </DialogContent>
    </Dialog>
  );
}

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
      <div className={cn(SECTION_TITLE_CLASS, 'text-[12px]', TEXT2_CLASS)}>
        汇报记录 · {member.name}
        <span className={MUTED_CLASS}>（只读；直发消息在 M5 开放）</span>
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
    // 「新增团队」信号：落到团队 tab（新建表单就在那里）。
    const hTeam = (): void => {
      consumePendingGotoAddTeam();
      dispatch({ type: 'ui/setNav', payload: 'team' });
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
    window.addEventListener(GOTO_ADD_TEAM_EVENT, hTeam);
    window.addEventListener(GOTO_ROSTER_EVENT, hRoster);
    window.addEventListener(SELECT_TEAM_EVENT, hSelect);
    // 补消费挂载前的跳转信号：跳转方先点宿主 tab 再触发本面板
    // 挂载，窗口事件会错过——pending 标记在这里兜底（docs/19.16）。
    if (consumePendingGotoAdd()) h();
    if (consumePendingGotoAddTeam()) hTeam();
    if (consumePendingGotoRoster()) hRoster();
    hSelect();
    return () => {
      window.removeEventListener(GOTO_ADD_EVENT, h);
      window.removeEventListener(GOTO_ADD_TEAM_EVENT, hTeam);
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
      {/* 卡片化样式（用户反馈）：角色/团队卡片与删除按钮的 hover 态一次注入，
        面板内与整页团队页共用同一渲染根，注入一次即可。 */}
      <style>{ROLE_LIST_CSS}</style>
      <div className={SHELL_CLASS}>
        {railWide ? (
          /* docs/22 S22-2 宽栏：官网 docs 侧栏签名——分组标题 + 连续左细线
            列表 + 链接自带左边线三态（激活 = sky 文字 + 同色左线 + semibold）。 */
          <div className={RAIL_WIDE_CLASS}>
            <h5 className={RAIL_TITLE_CLASS}>团队面板</h5>
            <div className={RAIL_LIST_CLASS}>
              {tabs.map((t) => (
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
          {/* 顶栏（用户反馈）：团队切换改为「团队」页的卡片栅格，这里只保留
            状态加载失败的就地提示；空态兜底在 BoardTab。 */}
          {state.error !== null && (
            <div className={cn(FORM_ERROR_CLASS, 'mb-3')}>状态加载失败：{state.error}</div>
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
 * 看板：目标、进度与最近动态（原「概览」）。S12 迁移面：横幅/两张卡片/
 * 空态/事件行全部 Tailwind 化；卡片容器用 shadcn Card（底色/边框/阴影按原
 * styles.card 覆盖，见 PANEL_CARD_CLASS）；阶段徽标升级为 shadcn Badge +
 * TONE_CLASS 查表（S5 card 先例的 outline 小 pill 档）。
 */
function BoardTab({
  team,
  now,
  fetchedAt,
  error,
}: {
  team: TeamSnapshot | undefined;
  now: number;
  fetchedAt: number;
  error: string | null;
}): ReactNode {
  if (team === undefined) {
    return (
      <div className={EMPTY_CLASS}>
        <p>还没有团队。</p>
        <p className={LINE_CLASS}>
          推荐流程：先到「角色」页新增角色，再到「团队」页创建团队并把角色拉进去。
        </p>
        <p className={LINE_CLASS}>
          也可以在对话中说「用 AgentTeams 做某事」或 <code>/agent-teams</code>
          ，领队会先问询、再拆解计划等你批准。
        </p>
        <p className={MUTED_CLASS}>{error !== null ? `状态加载失败：${error}` : '尚未创建团队'}</p>
      </div>
    );
  }
  return (
    <div>
      {team.pendingDecisions.length > 0 && (
        <div className={BANNER_CLASS}>
          △ {team.pendingDecisions.length} 项待决策：
          {team.pendingDecisions.map((d) => `${d.taskId}（${d.error.slice(0, 40)}）`).join('；')} ——
          到对话里让领队处理，或等待 M5 的代答操作。
        </div>
      )}
      <Card className={PANEL_CARD_CLASS}>
        <div className={SECTION_TITLE_CLASS}>目标</div>
        <div className="text-sm font-semibold leading-[1.5] text-foreground">{team.goal}</div>
        <div className={PROGRESS_TRACK_CLASS}>
          <div
            className={PROGRESS_FILL_CLASS}
            style={{
              width: `${team.progress.total === 0 ? 0 : (team.progress.completed / team.progress.total) * 100}%`,
            }}
          />
        </div>
        <div className={MUTED_CLASS}>
          {team.progress.completed}/{team.progress.total} 完成 · {team.progress.active} 执行中 ·{' '}
          {team.members.length} 成员 ·{' '}
          {/* 阶段徽标（S12）：原为 muted 行内文本，按「状态徽标用 shadcn」
          施工面升级为 outline Badge + TONE_CLASS 查表；tone 对齐 STATUS_GROUPS
          既有语义（PHASE_TONES）。 */}
          <Badge
            variant="outline"
            className={cn(
              'rounded-full border-solid px-2 py-px text-[11px] font-normal',
              TONE_CLASS[PHASE_TONES[team.phase] ?? 'muted'],
            )}
          >
            {PHASE_LABELS[team.phase] ?? team.phase}
          </Badge>
          {team.planReviewState !== null && team.phase === 'staged'
            ? ` · 计划${team.planReviewState === 'awaiting_review' ? '待批准' : team.planReviewState}`
            : ''}
        </div>
        {team.workDir !== null && <div className={MUTED_CLASS}>任务文档：{team.workDir}/</div>}
      </Card>
      <Card className={PANEL_CARD_CLASS}>
        <div className={SECTION_TITLE_CLASS}>最近动态</div>
        {team.latestEvents
          .slice(-8)
          .reverse()
          .map((e) => (
            <div key={e.seq} className={EVENT_ROW_CLASS}>
              <span className={MUTED_CLASS}>
                {relativeTime(e.at, now)} · {e.actor}
              </span>{' '}
              {e.text}
            </div>
          ))}
        {team.latestEvents.length === 0 && <div className={MUTED_CLASS}>暂无事件</div>}
        <div className={MUTED_CLASS}>
          数据更新于 {fetchedAt === 0 ? '—' : relativeTime(fetchedAt, now)}
        </div>
      </Card>
    </div>
  );
}

/** 团队：创建（仅名称）+ 组建团队（成员栅格 + 从角色列表拉人）。 */
function TeamTab({
  sessionId,
  pool,
  team,
  roster,
  onSelectTeam,
  agentActivity,
  onOpenReports,
}: {
  /** Current session id; undefined on the overlay panel (no session yet). */
  sessionId: string | undefined;
  /** All teams in the pool (卡片化：团队列表在这里选择). */
  pool: TeamSnapshot[];
  team: TeamSnapshot | undefined;
  roster: RosterMember[];
  onSelectTeam: (teamId: string) => void;
  /** Member subagent activity dots (docs/20.4 P4): childId → running/inactive. */
  agentActivity: Record<string, string>;
  onOpenReports: (name: string) => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 面板创建团队绑定当前会话（领队即该会话代理）；浮层/无会话时没有可绑定的
  // 会话，创建按钮禁用并给出指引，而不是提交后吃 400 错误。
  const canCreate = typeof sessionId === 'string' && sessionId !== '';

  const create = async (): Promise<void> => {
    if (busy || !canCreate || name.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await createTeamViaPanel(sessionId, name.trim());
      setName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addFromRoster = async (): Promise<void> => {
    if (busy || team === undefined || pick === '') return;
    setBusy(true);
    setError(null);
    try {
      await addTeamMember(team.teamId, { name: pick, fromRoster: true });
      setPick('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {/* 团队卡片栅格（用户反馈：列表改卡片）：名称 + 阶段/进度/成员数，
      点击切换当前团队；当前团队高亮描边。多团队时取代原顶栏下拉。
      S14：容器换 shadcn Card（PANEL_CARD_CLASS + pb-3 覆盖层），栅格/卡片/
      徽标/进度条全迁工具类；进度条宽度是运行时动态值（inline，S5 先例）。 */}
      {pool.length > 0 && (
        <Card className={cn(PANEL_CARD_CLASS, 'pb-3')}>
          <div className="mb-2.5 flex items-center gap-2">
            <h3 className={LIST_TITLE_CLASS}>团队</h3>
            <span className={LIST_COUNT_CLASS}>{pool.length} 个</span>
          </div>
          <div className={CARD_GRID_CLASS}>
            {pool.map((t) => {
              const active = t.teamId === team?.teamId;
              return (
                <div
                  key={t.teamId}
                  className={cn('eteams-team-card', TEAM_CARD_CLASS)}
                  data-active={active ? 'true' : 'false'}
                  onClick={() => onSelectTeam(t.teamId)}
                >
                  <div className="flex items-center gap-2">
                    <span className="eteams-team-name flex-1 text-[13px] font-semibold text-foreground">
                      {t.name}
                    </span>
                    {active && <span className={ROLE_CHIP_CLASS}>当前</span>}
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <span className={PHASE_PILL_CLASS}>{PHASE_LABELS[t.phase] ?? t.phase}</span>
                    <span className={LIST_COUNT_CLASS}>
                      {t.progress.completed}/{t.progress.total} 任务 · {t.members.length} 成员
                    </span>
                  </div>
                  <div className={cn(PROGRESS_TRACK_CLASS, 'mb-0')}>
                    <div
                      className={PROGRESS_FILL_CLASS}
                      style={{
                        width: `${
                          t.progress.total === 0
                            ? 0
                            : (t.progress.completed / t.progress.total) * 100
                        }%`,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Card className={PANEL_CARD_CLASS}>
        <div className="mb-2.5 flex items-center gap-2">
          <h3 className={LIST_TITLE_CLASS}>新建团队</h3>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={name}
            placeholder="团队名称，如：文档迁移小组"
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            size="sm"
            variant="primary"
            icon={<IconPlusOutline16 />}
            disabled={busy || !canCreate || name.trim() === ''}
            onClick={() => void create()}
          >
            创建
          </Button>
        </div>
        <div className={MUTED_CLASS}>
          {canCreate
            ? '只需名称即可创建（草案阶段）；目标可在看板中与领队继续完善。'
            : '当前还没有进行中的对话——开始对话后即可在这里创建团队。'}
        </div>
        {error !== null && <div className={FORM_ERROR_CLASS}>{error}</div>}
      </Card>

      {team === undefined ? (
        <div className={EMPTY_CLASS}>尚未选择团队。创建团队后在这里从「角色」列表拉人组队。</div>
      ) : (
        <>
          {/* 团队成员卡（S13/S14）：容器 shadcn Card（PANEL_CARD_CLASS 覆盖层，
          S12 先例）；拉人选择与成员栅格 Tailwind 化。上方的团队卡片栅格与
          新建团队卡已随 S14 一并迁移（同款覆盖层）。 */}
          <Card className={PANEL_CARD_CLASS}>
            <div className="mb-2.5 flex items-center gap-2">
              <h3 className={LIST_TITLE_CLASS}>团队成员</h3>
              <span className={LIST_COUNT_CLASS}>{team.members.length} 人 · 领队默认在团</span>
            </div>
            {roster.length > 0 && (
              <div className="mb-2.5 flex items-center gap-2">
                <select
                  className={SELECT_CLASS}
                  value={pick}
                  onChange={(e) => setPick(e.target.value)}
                >
                  <option value="">— 从角色列表选择 —</option>
                  {roster
                    .filter(
                      (m) => m.name !== LEADER_NAME && !team.members.some((t) => t.name === m.name),
                    )
                    .map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}（{m.role}）
                      </option>
                    ))}
                </select>
                <Button
                  size="sm"
                  disabled={busy || pick === ''}
                  onClick={() => void addFromRoster()}
                >
                  拉进团队
                </Button>
              </div>
            )}
            <div className={MEMBER_GRID_CLASS}>
              <LeaderCard captain={team.captain} />
              {team.members.map((m) => (
                <MemberCard
                  key={m.name}
                  member={m}
                  activity={m.childId !== null ? agentActivity[m.childId] : undefined}
                  onOpenReports={onOpenReports}
                  onRemove={(memberName) => {
                    void removeTeamMember(team.teamId, memberName).catch(() => undefined);
                  }}
                />
              ))}
              {team.members.length === 0 && (
                <div className={MUTED_CLASS}>
                  还没有角色——先到「角色」页新增，或从上方角色列表拉人。
                </div>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

/** The 领队（项目牧羊人）leader card — expands into its Markdown 手册. S13 Tailwind 化。 */
function LeaderCard({ captain }: { captain: CaptainView }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn(MEMBER_CARD_CLASS, 'col-span-full')}>
      <div className="flex items-center gap-2.5">
        <Avatar name={captain.name} seed={captain.avatar.seed} salt={captain.avatar.salt} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-foreground">{captain.name}</span>
            <span className={ROLE_CHIP_CLASS}>领队</span>
          </div>
          <div className={cn(MUTED_CLASS, 'mt-px')}>
            {captain.role} · 不接任务：负责拆解、指派与调度
          </div>
        </div>
        {captain.personaMd !== null && (
          <button type="button" className={BTN_CLASS} onClick={() => setOpen(!open)}>
            {open ? '收起手册' : '查看手册'}
          </button>
        )}
      </div>
      {open && captain.personaMd !== null && (
        <div className={cn('mt-2.5 border-t border-solid pt-2.5', BORDER_L1_CLASS)}>
          <MarkdownText text={captain.personaMd} />
        </div>
      )}
    </div>
  );
}

/** One team-member card: seeded avatar + status pill + 移出团队（领队不可移出）. S13 Tailwind 化。 */
function MemberCard({
  member: m,
  activity,
  onOpenReports,
  onRemove,
}: {
  member: MemberView;
  /** Subagent activity (docs/20.4 P4): 'running' | 'inactive' | undefined. */
  activity?: string;
  onOpenReports?: (name: string) => void;
  onRemove?: (name: string) => void;
}): ReactNode {
  const tone = memberTone(m.status);
  return (
    <div className={MEMBER_CARD_CLASS}>
      <div className="flex items-center gap-2.5">
        <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
            {activity !== undefined && (
              <span
                title={activity === 'running' ? '子代理运行中' : '子代理已完结'}
                className={
                  activity === 'running'
                    ? 'h-[7px] w-[7px] shrink-0 rounded-full bg-success shadow-[0_0_0_3px_var(--dsw-static-green-100,#e6faed)]'
                    : 'h-[7px] w-[7px] shrink-0 rounded-full bg-muted-foreground'
                }
              />
            )}
            {m.name}
          </div>
          <div className={cn(MUTED_CLASS, 'mt-px')}>
            {m.role} · {m.model}
          </div>
        </div>
      </div>
      <div className={pillClass(tone)}>
        <span className={dotClass(tone)} />
        {STATUS_LABELS[m.status] ?? m.status}
        {m.currentTaskId !== null && <span className="font-normal">· {m.currentTaskId}</span>}
      </div>
      <div className="flex gap-1.5">
        {onOpenReports !== undefined && (
          <button type="button" className={BTN_CLASS} onClick={() => onOpenReports(m.name)}>
            汇报记录
          </button>
        )}
        {onRemove !== undefined && (
          <button
            type="button"
            className={cn(BTN_CLASS, 'text-destructive')}
            onClick={() => onRemove(m.name)}
          >
            移出团队
          </button>
        )}
      </div>
    </div>
  );
}

/** 构建步骤时间线（docs/19.6.2）——与角色构建师的 eteams_build_report 播报约定一致。 */
const BUILD_STEPS = [
  '收到需求',
  '查重角色库',
  '意图访谈',
  '起草统一手册',
  '深化领域章节',
  '完成草稿',
] as const;

/** Editable draft form state (待确认态). */
interface DraftEdit {
  name: string;
  role: string;
  duty: string;
  style: string;
  skills: string;
  executionPrompt: string;
  personaMd: string;
  rulesText: string;
}

const EMPTY_EDIT: DraftEdit = {
  name: '',
  role: '',
  duty: '',
  style: '',
  skills: '',
  executionPrompt: '',
  personaMd: '',
  rulesText: '',
};

function fromBuildDraft(d: BuildDraft): DraftEdit {
  return {
    name: d.name,
    role: d.role,
    duty: d.duty ?? '',
    style: d.style ?? '',
    skills: d.skills ?? '',
    executionPrompt: d.executionPrompt ?? '',
    personaMd: d.personaMd ?? '',
    rulesText: (d.rules ?? []).join('\n'),
  };
}

/** 预填命令芯片：占位符以品牌色高亮，一眼看出要改哪里。 */
function CommandChip({ text }: { text: string }): ReactNode {
  const parts = text.split(/(【成员名称】|【职责】)/g);
  return (
    <div className={CMD_CHIP_CLASS}>
      {parts.map((p, i) =>
        p === '【成员名称】' || p === '【职责】' ? (
          <span key={i} className="font-semibold text-primary">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </div>
  );
}

/** 预填引导三步（空闲态展示）。 */
const PREFILL_STEPS = [
  '在对话输入框补全两个【】占位符——可顺手追加能力、风格等期望',
  '回车发送，角色构建师立刻接手（预填行直接回车同样生效）',
  '回到这里实时看构建；草稿就绪后可修改，点「确认入库」完成',
] as const;

/** 构建中草稿只读预览（docs/19.6.2）：字段渐次呈现，不可编辑。 */
function DraftPreview({ draft }: { draft: BuildDraft }): ReactNode {
  const rows: [string, string][] = [
    ['角色名', draft.name],
    ['角色', draft.role],
    ['职责边界', draft.duty ?? ''],
    ['工作风格', draft.style ?? ''],
    ['能力', draft.skills ?? ''],
    ['工作纪律', (draft.rules ?? []).join('；')],
    ['执行提示', draft.executionPrompt ?? ''],
  ];
  return (
    <Card className={cn(PANEL_CARD_CLASS, 'mt-2 p-2.5')}>
      <div className={SECTION_TITLE_CLASS}>草稿预览（构建中，待确认后可编辑）</div>
      {rows.map(([label, value]) => (
        <div key={label} className={DETAIL_ROW_CLASS}>
          <span className={DETAIL_LABEL_CLASS}>{label}</span>
          <span className={cn(MUTED_CLASS, value.trim() !== '' && TEXT2_CLASS)}>
            {value.trim() !== '' ? value : '…'}
          </span>
        </div>
      ))}
    </Card>
  );
}

/** 角色（用户反馈：成员更名角色，不再需要标签）：角色库全体条目（先有角色，再组建团队）——列表 / 构建工作台 / 详情。 */
/**
 * Synthesize a handbook skeleton from the legacy structured fields so nothing
 * is lost when the user first edits a member that predates personaMd (the
 * digest fields themselves are no longer shown — everything lives in the
 * handbook now, 用户反馈 2026-09).
 */
function handbookSeed(member: RosterMember): string {
  if (typeof member.personaMd === 'string' && member.personaMd.trim() !== '') {
    return member.personaMd;
  }
  const lines = [`# ${member.name}`, '', `- **角色**：${member.role}`];
  const fields: [string, string | undefined][] = [
    ['职责边界', member.duty],
    ['工作风格', member.style],
    ['能力', member.skills],
    ['执行提示', member.executionPrompt],
  ];
  for (const [label, value] of fields) {
    if (typeof value === 'string' && value.trim() !== '')
      lines.push(`- **${label}**：${value.trim()}`);
  }
  if (Array.isArray(member.rules) && member.rules.length > 0) {
    lines.push(
      '',
      '## 工作纪律',
      ...member.rules.filter((r) => r.trim() !== '').map((r) => `- ${r}`),
    );
  }
  lines.push('', '## 交付标准', '- （待补充）');
  return lines.join('\n');
}

/**
 * The role detail handbook (用户反馈：去掉人设摘要，全部提炼到角色手册；
 * 详情默认只读渲染，点「编辑」进编辑态，保存/取消收尾). Full member upsert
 * on save — the host replaces the whole entry, so every current field is
 * re-sent with the new handbook. Always read-only for the leader (host
 * rejects leader upserts, 保留名).
 */
/**
 * 角色/团队 list stylesheet（卡片化 + 视觉升级）：hover/抬升/阴影/过渡与删除
 * 按钮的显隐全部内联样式表达不了（且内联底色会压住 :hover——弹窗行的同一
 * 教训），统一走这里；token 直接从主题插值，fallback 已内建。
 */
const ROLE_LIST_CSS = `
.eteams-role-row{background:${T.surface};border:1px solid ${T.border};box-shadow:0 1px 2px rgba(15,23,42,0.04);transition:background .15s ease,border-color .15s ease,box-shadow .15s ease,transform .15s ease}
.eteams-role-row:hover{border-color:rgba(14,165,233,0.45);box-shadow:0 6px 16px rgba(15,23,42,0.09);transform:translateY(-1px)}
.eteams-team-card{background:${T.surface};border:1px solid ${T.border};box-shadow:0 1px 2px rgba(15,23,42,0.04);transition:background .15s ease,border-color .15s ease,box-shadow .15s ease,transform .15s ease}
.eteams-team-card:hover{border-color:rgba(14,165,233,0.45);box-shadow:0 6px 16px rgba(15,23,42,0.09);transform:translateY(-1px)}
.eteams-team-card[data-active="true"]{border-color:${T.accent};background:${T.accentSoft};box-shadow:0 2px 10px rgba(14,165,233,0.14)}
.eteams-role-del{padding:3px 10px;font-size:11px;border-radius:7px;border:1px solid ${T.border2};background:${T.surface};color:${T.err};cursor:pointer;flex-shrink:0;font-family:inherit;line-height:16px;opacity:0;transition:opacity .15s ease,border-color .15s ease,background .15s ease}
.eteams-role-row:hover .eteams-role-del,.eteams-role-row:focus-within .eteams-role-del{opacity:1}
.eteams-role-del:hover{border-color:${T.err};background:${T.errBg}}
.eteams-role-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eteams-team-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;

function HandbookEditor({
  member,
  readOnly,
  onSaved,
}: {
  member: RosterMember;
  readOnly: boolean;
  onSaved: () => void;
}): ReactNode {
  const dispatch = useDispatch();
  // draft === null → read-only Markdown view; string → editing buffer.
  // Seeded from the CURRENT member on every edit entry, so a roster reload
  // (post-save) is always what a new edit starts from.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const display = handbookSeed(member);

  const save = (): void => {
    if (draft === null) return;
    // S10：保存改发 `roster/saveRoster`（effect 透传 api，失败 reject——
    // dispatch promise 即 dva effect 的完成信号），组件 catch 面保持迁移
    // 前行为（保存失败的显式提示）。
    void (async (): Promise<void> => {
      setSaving(true);
      setError(null);
      setSaved(false);
      try {
        await dispatch({
          type: 'roster/saveRoster',
          payload: {
            name: member.name,
            role: member.role,
            ...(member.duty !== undefined ? { duty: member.duty } : {}),
            ...(member.style !== undefined ? { style: member.style } : {}),
            ...(member.skills !== undefined ? { skills: member.skills } : {}),
            ...(Array.isArray(member.rules) ? { rules: member.rules } : {}),
            ...(member.executionPrompt !== undefined
              ? { executionPrompt: member.executionPrompt }
              : {}),
            ...(member.provider !== undefined ? { provider: member.provider } : {}),
            ...(member.model !== undefined ? { model: member.model } : {}),
            ...(member.reasoningEffort !== undefined
              ? { reasoningEffort: member.reasoningEffort }
              : {}),
            ...(member.avatar !== undefined ? { avatar: member.avatar } : {}),
            personaMd: draft,
          },
        });
        setSaved(true);
        setDraft(null);
        setTimeout(() => setSaved(false), 2500);
        onSaved();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    })();
  };

  return (
    <Card className={PANEL_CARD_CLASS}>
      <div className={cn(SECTION_TITLE_CLASS, 'flex items-center gap-2')}>
        <span className="flex-1">角色手册（Markdown）</span>
        {readOnly ? (
          <span className={MUTED_CLASS}>领队为保留角色，手册不可在此修改</span>
        ) : draft === null ? (
          <Button size="sm" variant="ghost" onClick={() => setDraft(display)}>
            编辑
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
              取消
            </Button>
            <Button size="sm" variant="primary" disabled={saving} onClick={save}>
              保存
            </Button>
          </>
        )}
      </div>
      {draft === null ? (
        <>
          <MarkdownText text={display} />
          {saved && <div className={cn(MUTED_CLASS, 'mt-1')}>✓ 已保存</div>}
        </>
      ) : (
        <>
          <MdEditor value={draft} onChange={setDraft} minHeight={220} />
          {error !== null && <div className={FORM_ERROR_CLASS}>保存失败：{error}</div>}
        </>
      )}
    </Card>
  );
}

function MembersTab({
  members,
  pool,
  team,
  onDeleted,
  onPrefillAddPeople,
  openAddTick,
}: {
  members: RosterMember[];
  pool: TeamSnapshot[];
  team: TeamSnapshot | undefined;
  onDeleted: () => void;
  onPrefillAddPeople: () => 'set' | 'copied' | 'aborted';
  /** 创建卡片跳转信号：>0 时打开新增工作台（docs/19.9.5）。 */
  openAddTick: number;
}): ReactNode {
  const dispatch = useDispatch();
  const [view, setView] = useState<'list' | 'add' | 'detail'>('list');
  const [detailName, setDetailName] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [personaMd, setPersonaMd] = useState('');
  const [copied, setCopied] = useState(false);
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
  const [justFilled, setJustFilled] = useState(false);
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

  // 创建卡片跳转（docs/19.9.5）：信号递增时打开新增工作台。
  const lastAddTickRef = useRef(0);
  useEffect(() => {
    if (openAddTick > 0 && openAddTick !== lastAddTickRef.current) {
      lastAddTickRef.current = openAddTick;
      setView('add');
    }
  }, [openAddTick]);

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

  // 通过对话创建（用户要求）：面板生成命令，用户粘贴到会话里由领队执行
  // eteams_member_save 入库——面板不直连写成员。personaMd（完整角色手册）
  // 以 Markdown 围栏附在命令尾部，由领队原样作为 personaMd 参数传入。
  // 手册原文自带 ``` 代码块时用更长的围栏包裹，避免嵌套断裂。
  const maxBacktickRun = personaMd.match(/`{3,}/g)?.reduce((m, f) => Math.max(m, f.length), 0) ?? 0;
  const mdFence = '`'.repeat(Math.max(3, maxBacktickRun + 1));
  // 全部提炼到角色手册（用户反馈）：结构化字段不再单独收集，人设内容只走
  // personaMd 全文。
  const command = [
    '用 eteams_member_save 创建角色：',
    `- 名字：${name.trim()}`,
    `- 角色：${role.trim()}`,
    ...(personaMd.trim() !== ''
      ? [
          '- 人设手册：把下面围栏内的 Markdown 原文作为 personaMd 参数传入',
          '',
          `${mdFence}eteams-persona-md`,
          personaMd.trim(),
          mdFence,
        ]
      : []),
  ].join('\n');

  const copyCommand = (): void => {
    void writeClipboard(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
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
        <Button size="sm" onClick={() => setView('list')}>
          ← 返回角色列表
        </Button>
        <Button
          size="sm"
          className="ml-1.5"
          onClick={() => activateConversationTab()}
          title="切到会话的对话视图，看命令卡片与进度行"
        >
          💬 对话页看进度
        </Button>
        <Card className={cn(PANEL_CARD_CLASS, 'mt-2')}>
          {build !== null && build.status === 'active' && (
            <div>
              <div className="flex items-center gap-2">
                {interviewWaiting ? (
                  <span className="text-[16px] leading-none">✍️</span>
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
                  <span className={pillClass('warn')}>等你作答</span>
                ) : (
                  <span className={pillClass('info')}>构建中</span>
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
                  <div className="text-[13px] font-semibold">✍️ 意图访谈——请作答</div>
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
                      <div className="mt-1.5 text-[12px] font-semibold text-warning">
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
                        <div className="text-[12.5px] font-semibold">
                          {q.question}
                          {q.multi === true && (
                            <span className="ml-1.5 rounded-full bg-[color:rgba(29,78,216,0.1)] px-[7px] py-px text-[11px] font-medium text-business">
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
                                  'cursor-pointer rounded-[8px] border border-solid px-[9px] py-[5px] text-left text-[12px] leading-[1.5] text-inherit',
                                  active
                                    ? 'border-primary bg-[color:var(--dsw-alias-interactive-bg-active,rgba(14,165,233,0.12))]'
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
                      variant="primary"
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
                      <div className="mt-2 text-[12px] leading-[1.5] text-destructive">
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
                  const tone: Tone = done ? 'ok' : current ? 'info' : 'muted';
                  return (
                    <div key={s} className={BUILD_STEP_CLASS}>
                      <span className={cn(TONE_CLASS[tone], 'font-semibold')}>
                        {done ? '✔' : current ? '●' : '◌'}
                      </span>
                      <span className={done || current ? TEXT2_CLASS : 'text-muted-foreground'}>
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
              {formError !== null && <div className={FORM_ERROR_CLASS}>{formError}</div>}
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
                  variant="primary"
                  icon={<IconPlusOutline16 />}
                  disabled={
                    confirming || draftEdit.name.trim() === '' || draftEdit.role.trim() === ''
                  }
                  onClick={() => void confirmDraft()}
                >
                  确认入库
                </Button>
                <Button size="sm" disabled={confirming} onClick={() => void abandon()}>
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
                <span className={pillClass('ok')}>角色列表已更新</span>
              </div>
              <div className="mt-2 flex items-center gap-2.5">
                <Avatar name={confirmedDraft.name} size={40} />
                <div>
                  <div className="text-[14px] font-semibold text-foreground">
                    {confirmedDraft.name}
                  </div>
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
                    if (onPrefillAddPeople() === 'set') setJustFilled(true);
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
                <span className={pillClass('muted')}>已中断</span>
              </div>
              {build.note !== '' && <div className={MUTED_CLASS}>{build.note}</div>}
              <div className="mt-2 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={confirming}
                  onClick={() => void resume()}
                >
                  继续构建
                </Button>
                <span className={MUTED_CLASS}>上下文已保存——从中断处接着跑，不用从头再来。</span>
              </div>
            </Card>
          )}
          {(build === null || build.status === 'cancelled') && (
            <div>
              <div className="flex items-center gap-2">
                <span className="inline-flex text-primary">
                  <IconSparkle16 />
                </span>
                <div className={cn(LINE_CLASS, 'font-semibold')}>新增角色 · 角色构建师</div>
                <span className={pillClass('info')}>对话式构建</span>
              </div>
              {justFilled ? (
                <div>
                  <div className={PREFILL_BANNER_CLASS}>
                    <span className="text-[12.5px] font-semibold text-business">
                      ✓ 已填充到对话输入框
                    </span>
                  </div>
                  <CommandChip text={ADD_PEOPLE_TEMPLATE} />
                  {PREFILL_STEPS.map((s, i) => (
                    <div key={s} className={STEP_ROW_CLASS}>
                      <span className={STEP_NUM_CLASS}>{i + 1}</span>
                      <span>{s}</span>
                    </div>
                  ))}
                  <div className={cn(MUTED_CLASS, 'mt-2.5 text-[11.5px]')}>
                    提示：已模拟「键入 /eteam +
                    空格」完成命令认领（claimed）——补全两个【】占位符后直接回车即可；编辑正文时命令高亮收起属正常行为。
                  </div>
                </div>
              ) : (
                <div className={cn(MUTED_CLASS, 'mt-1')}>
                  点角色列表上方的「新增角色」：命令会填进对话输入框，在对话里补全信息后回车，这里实时看构建。
                </div>
              )}
              <details>
                <summary className={cn('mt-2.5 cursor-pointer', MUTED_CLASS)}>
                  手动创建（不经过角色构建师）
                </summary>
                <div className="mt-2">
                  <div className="mb-2 flex gap-2">
                    <Input
                      value={name}
                      placeholder="角色名，如：alice"
                      onChange={(e) => setName(e.target.value)}
                    />
                    <Input
                      value={role}
                      placeholder="角色：前端开发者 / 后端架构师 / UI 设计师 / 趣味注入师 / researcher / …"
                      onChange={(e) => setRole(e.target.value)}
                    />
                  </div>
                  <details>
                    <summary className={cn('mt-1.5 cursor-pointer', MUTED_CLASS)}>
                      角色手册（可选，Markdown：使命/职责/规则/领域专章/沟通风格/交付标准）
                    </summary>
                    <div className={cn(FORM_ROW_CLASS, 'mt-2')}>
                      <MdEditor value={personaMd} onChange={setPersonaMd} minHeight={220} />
                    </div>
                  </details>
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<IconPlusOutline16 />}
                      disabled={name.trim() === '' || role.trim() === ''}
                      onClick={copyCommand}
                    >
                      复制对话命令
                    </Button>
                    <span className={MUTED_CLASS}>
                      粘贴到对话发送，主会话智能体执行 eteams_member_save 入库；成功后列表会出现。
                    </span>
                  </div>
                  {copied && (
                    <div className={cn(MUTED_CLASS, 'mt-1.5')}>✓ 已复制——去对话里粘贴发送</div>
                  )}
                </div>
              </details>
            </div>
          )}
        </Card>
      </div>
    );
  }

  if (view === 'detail' && detail !== null) {
    const teamNames = teamsOf(detail.name);
    const isLeader = detail.name === LEADER_NAME;
    return (
      // 版式：详情列不再限宽（用户要求解除固定宽度），面板全宽利用
      <div>
        <button type="button" className={BTN_CLASS} onClick={() => setView('list')}>
          ← 返回角色列表
        </button>
        <Card className={cn(PANEL_CARD_CLASS, 'mt-2 px-[18px] py-4')}>
          <div className="flex items-center gap-3.5">
            {/* 头像描边环（视觉升级）：与卡片描边同色系，柔和不抢戏。 */}
            <div className="rounded-full border-2 border-solid p-0.5 leading-none border-[color:var(--dsw-alias-interactive-bg-active,rgba(14,165,233,0.12))]">
              <Avatar
                name={detail.name}
                seed={detail.avatar?.seed}
                salt={detail.avatar?.salt}
                size={52}
              />
            </div>
            {/* 角色（用户反馈）：不再需要标签——名字即身份，手册即人设。 */}
            <div className="min-w-0 flex-1">
              <div className="text-[17px] font-bold text-foreground">{detail.name}</div>
              <div className={cn(MUTED_CLASS, 'mt-0.5 text-[11px]')}>
                {isLeader ? '系统保留角色 · 手册只读' : '点击下方「编辑」可修改角色手册'}
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
          </div>
        </Card>
        <HandbookEditor member={detail} readOnly={isLeader} onSaved={onDeleted} />
        {team !== undefined && detailMemberView !== null && (
          <MemberDialog team={team} member={detailMemberView} />
        )}
      </div>
    );
  }

  return (
    <div>
      <Card className={PANEL_CARD_CLASS}>
        <div className="mb-2.5 flex items-center gap-2">
          <h3 className={LIST_TITLE_CLASS}>角色</h3>
          <span className={LIST_COUNT_CLASS}>{members.length} 个</span>
          {build !== null &&
          (build.status === 'active' || build.status === 'awaiting_confirmation') ? (
            // 有未入库的构建草稿：新增入口让位给「待加入角色」，防止误开新
            // 构建把旧草稿顶掉（docs/19.16）。
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setView('add');
              }}
            >
              待加入角色
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              icon={<IconPlusOutline16 />}
              onClick={() => {
                // 一键预填（D18-1）：命令进输入框 → 跳到构建工作台；不可用时
                // 退化为复制，提示去对话粘贴。
                const outcome = onPrefillAddPeople();
                if (outcome === 'set') {
                  setJustFilled(true);
                  setView('add');
                } else if (outcome === 'copied') {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }
              }}
            >
              新增角色
            </Button>
          )}
        </div>
        {listError !== null && <div className={FORM_ERROR_CLASS}>{listError}</div>}
        {members.length === 0 ? (
          <div className={EMPTY_CLASS}>
            还没有角色。点「新增角色」，在对话里补全信息，角色构建师会帮你构建人设。
          </div>
        ) : (
          <>
            {/* 搜索 + 分页（用户反馈）：按名字/角色字段过滤，每页 8 条。 */}
            <div className="mb-1.5 flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  value={query}
                  placeholder="搜索角色名…"
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(0); // 新搜索从头翻页
                  }}
                />
              </div>
            </div>
            {/* 角色卡片栅格（用户反馈：列表改卡片）：头像在上、名字与所属团队
            在下，删除按钮悬于右上角；hover/描边由 ROLE_LIST_CSS 接管。 */}
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
                    {isProtected ? null : (
                      <button
                        type="button"
                        className="eteams-role-del absolute right-2 top-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          del(m.name);
                        }}
                      >
                        删除
                      </button>
                    )}
                    <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} size={40} />
                    {/* 角色（用户反馈）：不再需要标签——名字即身份。 */}
                    <div className="min-w-0">
                      <span className="eteams-role-name block max-w-full text-[13px] font-semibold text-foreground">
                        {m.name}
                      </span>
                      {teamNames.length > 0 && (
                        <div className={cn('eteams-role-name', MUTED_CLASS, 'mt-0.5 text-[11px]')}>
                          {teamNames.join('、')}
                        </div>
                      )}
                    </div>
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

/** 任务：按状态分组的任务清单（原「任务」）。S13 Tailwind 化：分组头 pill、
任务行、依赖芯片与空态全迁 Tailwind 类；详情抽屉为 shadcn Dialog（见
TaskDrawer），开合仍走 ui model 的 setExpandedTask。 */
function TasksTab({
  team,
  now,
  expandedTask,
  setExpandedTask,
}: {
  team: TeamSnapshot;
  now: number;
  expandedTask: string | null;
  setExpandedTask: (id: string | null) => void;
}): ReactNode {
  return (
    <div>
      {STATUS_GROUPS.map((group) => {
        const rows = team.tasks.filter((t) => group.statuses.includes(t.status));
        if (rows.length === 0) return null;
        return (
          <div key={group.id} className="mb-3.5">
            <div className={cn(SECTION_TITLE_CLASS, 'mb-1')}>
              <span className={pillClass(group.tone)}>
                <span className={dotClass(group.tone)} />
                {group.label} · {rows.length}
              </span>
            </div>
            {rows.map((t) => (
              <div key={t.taskId}>
                <div
                  className={TASK_ROW_CLASS}
                  onClick={() => setExpandedTask(expandedTask === t.taskId ? null : t.taskId)}
                >
                  <div>
                    <strong>{t.taskId}</strong> {t.subject}
                    <span className={MUTED_CLASS}>
                      {' '}
                      {STATUS_LABELS[t.status] ?? t.status}
                      {t.retryCount > 0 ? ` · ⟳${t.retryCount}` : ''}
                      {t.assignee !== null ? ` · ${t.assignee}` : ''}
                    </span>
                  </div>
                  <TaskStations task={t} />
                  {t.dependencies.length > 0 && (
                    <div className="mt-[3px]">
                      {t.dependencies.map((d) => (
                        <span key={d} className={CHIP_CLASS}>
                          依赖 {d}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {expandedTask === t.taskId && (
                  <TaskDrawer
                    team={team}
                    task={t}
                    now={now}
                    onClose={() => setExpandedTask(null)}
                  />
                )}
              </div>
            ))}
          </div>
        );
      })}
      {team.tasks.length === 0 && (
        <div className={EMPTY_CLASS}>还没有任务。计划批准后任务会出现在这里。</div>
      )}
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
        <select
          className={SELECT_CLASS}
          value={dialogMember ?? ''}
          onChange={(e) => setDialogMember(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">— 选择 —</option>
          {team.members.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}（{m.role}）
            </option>
          ))}
        </select>
      </div>
      {member === null ? (
        <div className={MUTED_CLASS}>选择一个成员查看对话时间线。</div>
      ) : (
        <MemberDialog team={team} member={member} />
      )}
    </div>
  );
}
