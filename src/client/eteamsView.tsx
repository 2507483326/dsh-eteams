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
import Check from 'lucide-react/dist/esm/icons/check.mjs';
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down.mjs';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right.mjs';
import MessageSquare from 'lucide-react/dist/esm/icons/message-square.mjs';
import Minus from 'lucide-react/dist/esm/icons/minus.mjs';
import PenLine from 'lucide-react/dist/esm/icons/pen-line.mjs';
import Plus from 'lucide-react/dist/esm/icons/plus.mjs';
import Search from 'lucide-react/dist/esm/icons/search.mjs';
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
import { Alert } from './components/ui/alert';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog';
import { Input } from './components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover';
import { Progress } from './components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select';
import { MdEditor } from './mdEditor';
import {
  addTeamMember,
  createTeamViaPanel,
  fetchAgentActivity,
  removeTeamMember,
  setLeaderModel,
  setMemberModel,
  setTeamLeaderRemoved,
  syncMemberToRoster,
  updateMemberPersona,
  type BuildDraft,
  type InterviewQuestion,
  type RosterMember,
} from './api';
import { catalogRow, useModelCatalog, type ModelCatalogState } from './modelCatalog';
import {
  applyRoutePatch,
  relativeTime,
  refreshActivitySoon,
  revertRoutePatch,
  useActivityMonitor,
  type CaptainView,
  type MemberView,
  type RoutePatch,
  type RouteTriple,
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
 * 后 inline 样式消费面已清空；hover/focus-within/attr 选择器与下面的原生
 * details/summary 样式仍需样式表承载（D22f：展开指示的 [open]/::before 规则
 * 无法用工具类表达，同注入这里）。
 * D22a 官网 v3 色板接管：原先经 --dsw-alias-*（DSW 蓝家族）的取值全部改
 * 消费 .eteams-ui 作用域内的语义 token（亮/暗由 eteams.css 统一定值），
 * 浅暗两态都不刺眼；半透明一律 color-mix()（token 色禁 /alpha 的替代路径，
 * button.tsx 先例）。
 */

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

/** 边框统一走语义 token --border（D22a 官网 v3：亮 slate-200 #e2e8f0 /
 * 暗 slate-800 #1e293b，token 值已官网化）——原 l1 别名半透明灰（比官网
 * 细线还淡、暗色发灰）的任意值直引全部收敛到这条。 */
const BORDER_L1_CLASS = 'border-[color:var(--border)]';
/** 次级文字：D22d 官网正文灰阶语义——正文次级 = muted-foreground（官网
 * slate-500 #64748b），原 label-secondary 别名任意值直引收敛到语义 token。 */
const TEXT2_CLASS = 'text-muted-foreground';
/** 原 styles.muted（meta/弱化档：12px/20 官网小字尺度 / overflow-wrap:anywhere），
 * S12–S14 各批次区块共用的类常量。 */
const MUTED_CLASS = 'text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]';
/** 原 styles.line（正文次级行：官网 prose-sm 14px/24）。 */
const LINE_CLASS = `my-1 text-sm leading-6 ${TEXT2_CLASS}`;
/** 原 styles.sectionTitle（卡/区块标题：D22d 官网 h3 档 16px semibold +
 * tracking-tight，去原 11px 的反向加宽 tracking）。 */
const SECTION_TITLE_CLASS = 'mb-2 text-base font-semibold leading-6 tracking-tight text-foreground';
/** 原 styles.empty（虚线框空态）；边框色吃 S3 桥默认（--border 即原 l2 档）。 */
const EMPTY_CLASS =
  'rounded-xl border border-dashed px-5 py-9 text-center text-sm leading-6 text-muted-foreground';
/* docs/23 S23-3：原 styles.banner（BANNER_CLASS）迁移 shadcn Alert warning
   变体（amber 淡底以 className 覆盖保留），使用位内联；原
   PROGRESS_TRACK/FILL_CLASS 迁移 shadcn Progress（transform 技法，轨道
   bg-secondary 即原 layer-2 档），一并删除手写常量。 */
/** 面板卡片（原 styles.card → shadcn Card 的覆盖层）：底色回 layer-1 档
（Card 默认 bg-card 是 layer-2）、--border 边框、官网 shadow-sm 阴影档
（D22f：0.03→0.05）；px-4 py-4 = 卡内呼吸感提到 16px（行密度不变）。
eteams-ui 字面量随 Card 根（S5 试点双保险）。 */
const PANEL_CARD_CLASS = `eteams-ui mb-3 min-w-0 border border-solid bg-background px-4 py-4 shadow-[0_1px_2px_rgba(15,23,42,0.05)] ${BORDER_L1_CLASS}`;
/** 原 styles.eventRow（D22f：去满宽下边线的表格观感，改留白分组——行
 * py-1.5 + 列表容器 space-y-1；正文 14px/24，meta 12px muted 见使用位）。 */
const EVENT_ROW_CLASS = 'py-1.5 text-sm leading-6 text-foreground';
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
/** shadcn Select 空选项哨兵（Radix SelectItem value 禁空串；映射回 ''/null）。 */
const SELECT_NONE = '__none__';
/** 原 styles.formRow / styles.formLabel（表单行）：汇报页先用，S14 表单复用。 */
const FORM_ROW_CLASS = 'mb-2.5 flex flex-col gap-[5px]';
const FORM_LABEL_CLASS = 'text-xs font-semibold text-muted-foreground';
/** 原 styles.listTitle / styles.listCount（列表页头）：S14 的团队/角色列表头复用；
 * D22d 官网 h3 档 16px semibold + tracking-tight（S23-3 已引入 tracking-tight）。 */
const LIST_TITLE_CLASS =
  'm-0 min-w-0 flex-1 text-base font-semibold tracking-tight text-foreground';
const LIST_COUNT_CLASS = 'text-xs text-muted-foreground';
/** 原 styles.memberGrid（成员卡片栅格，最小 230px 自适应列）。 */
const MEMBER_GRID_CLASS = 'grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3';
/** 原 styles.memberCard（成员卡片：--border 边框 / 12px 圆角 / 官网 shadow-sm
 * 阴影档 / p-4 卡内呼吸感，D22f）。 */
const MEMBER_CARD_CLASS = `flex flex-col gap-2 rounded-xl border border-solid bg-background p-4 shadow-[0_1px_2px_rgba(15,23,42,0.05)] ${BORDER_L1_CLASS}`;
/** 原 styles.roleChip（品牌档圆 pill）：S14 团队卡片「当前」复用；D22e 官网
 * pill 口径（rounded-full / 12px / medium）+ 品牌淡底 token + brand-ink 字。 */
const ROLE_CHIP_CLASS =
  'inline-flex w-fit items-center rounded-full bg-business-tint px-2.5 py-0.5 text-xs font-medium text-[color:var(--eteams-brand-ink)]';
/** 原 styles.drawer（sunken 抽屉面板）：任务抽屉已升级为 Dialog，现仅成员
 * 汇报时间线使用。D22f：去双层灰底嵌套——容器改白底 + 左细线时间线签名。 */
const DRAWER_CLASS = `mt-2 mb-3.5 border-l-2 border-solid border-[color:var(--border)] pl-3`;
/** 原 styles.dialogItem（汇报时间线条目）：D22f 去灰底小卡，改普通段落
 * （正文 14px foreground；12px meta 前缀语义留在使用位的 MUTED_CLASS）。 */
const DIALOG_ITEM_CLASS = 'my-1 text-sm leading-6 text-foreground';
/** 原 styles.taskRow（任务行：l1 下边线 / 8px 圆角 / 指针）。 */
const TASK_ROW_CLASS = `cursor-pointer rounded-[8px] border-b border-solid px-2 py-2.5 ${BORDER_L1_CLASS}`;
/** 原 styles.chip（依赖小芯片）：S14 角色详情的所属团队芯片复用；底色收敛
 * 语义 token --muted（与原 layer-2 档同值源）。 */
const CHIP_CLASS = `mr-1 mb-0.5 inline-block rounded-md bg-muted px-2 py-px text-xs text-muted-foreground`;
/** 原 styles.attempt（执行线路尝试条目：--border 左描边）。 */
const ATTEMPT_CLASS = 'my-2.5 border-l-2 border-solid border-border py-0.5 pl-3';
/** 任务详情 Dialog 的调用面覆盖：限宽收高可滚动 + 面板文字基准（portal
 * 容器挂在 body 下，不继承 SHELL 的 14px/前景色，这里显式补齐——D22d 官网
 * prose-sm 档 text-sm leading-6；max-w-xl 压过上游 max-w-lg，rounded-xl 与
 * 上游 sm:rounded-lg 同为 12px）。 */
const DRAWER_DIALOG_CLASS =
  'max-h-[70vh] max-w-xl overflow-y-auto rounded-xl text-sm leading-6 text-foreground';

/** D22e 官网式圆 pill 底座：中性半透明底 + 12px medium 字；状态彩底全撤
 * （五档 tone 只进 6px dot，见 DOT_TONE_CLASS）——底/字统一中性 token
 * （--eteams-pill-bg/--eteams-pill-ink，亮暗由 eteams.css 定值）。 */
const PILL_BASE_CLASS =
  'inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium';
const PILL_NEUTRAL_CLASS = 'bg-[color:var(--eteams-pill-bg)] text-[color:var(--eteams-pill-ink)]';
/** PILL_TONE_CLASS（D22e 降噪后）：tone 不再改变 pill 面——五档统一中性
 * pill，tone 语义全部由内嵌彩色 dot 承载（映射表结构保留：Pill 组件按
 * tone 查底 + 查 dot，两组常量拼接完整字面量）。 */
const PILL_TONE_CLASS: Record<Tone, string> = {
  info: PILL_NEUTRAL_CLASS,
  ok: PILL_NEUTRAL_CLASS,
  warn: PILL_NEUTRAL_CLASS,
  err: PILL_NEUTRAL_CLASS,
  muted: PILL_NEUTRAL_CLASS,
};
/** 原 fns.dot 的类名版（完整字面量映射）：D22e 后 dot 是状态色的唯一载体
 * ——执行中 business/sky、成功 success 绿、警告 warning amber、错误
 * destructive 红、muted 中性灰（token 值已官网化：sky/绿600/amber600/红600）。 */
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

/** 状态徽标（docs/23 S23-3）：shadcn Badge 承底座（边框/过渡/焦点环），
 * 本仓 pill 视觉口径（官网圆 pill / 12px / medium / 内嵌状态点）以
 * className 覆盖层保留——tone 底色表（PILL_TONE_CLASS）经 tailwind-merge
 * 压过 Badge 变体底色。D22e：dot 由组件统一内嵌（中性 pill + 彩点签名），
 * 调用位不再自插 dot span。 */
function Pill({ tone, children }: { tone: Tone; children: ReactNode }): ReactNode {
  return (
    <Badge variant="secondary" className={pillClass(tone)}>
      <span className={dotClass(tone)} />
      {children}
    </Badge>
  );
}

/** 表单/列表错误提示（docs/23 S23-3）：shadcn Alert destructive 的紧凑档
 * （原 styles.formError 的 12px/20 + 上 4 下 8 边距口径）。 */
function FormErrorNote({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <Alert
      variant="destructive"
      className={cn('mt-1 mb-2 rounded-md px-3 py-2 text-xs leading-5', className)}
    >
      {children}
    </Alert>
  );
}

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
/** 原 styles.cardGrid（团队/角色卡片栅格，最小 210px 自适应列）——团队列表
 * 已改长条卡（用户迭代 2026-09，见 TEAM_ROW_CLASS），仍服务角色卡片栅格。 */
const CARD_GRID_CLASS = 'grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3';
/** 长条形团队卡（用户迭代 2026-09）：整行一张（flex 纵列容器里 100% 宽），
 * 左内容 + 右成员略缩图；底色/边框/悬停仍由 .eteams-team-card 样式表接管，
 * p-4 = D22f 卡内呼吸感。 */
const TEAM_ROW_CLASS = 'flex min-w-0 cursor-pointer items-center rounded-xl p-4';
/** 原 styles.phasePill（团队卡片阶段徽标：D22e 中性圆 pill + 彩色 6px dot
 * ——dot 由使用位按 PHASE_TONES 插入，状态彩底全撤）。 */
const PHASE_PILL_CLASS =
  'inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-[color:var(--eteams-pill-bg)] px-2.5 py-0.5 text-xs font-medium text-[color:var(--eteams-pill-ink)]';
/** 原 styles.roleCard（同上：底色/边框/悬停由 .eteams-role-row 样式表接管）；
 * p-4 = D22f 卡内呼吸感。 */
const ROLE_CARD_CLASS =
  'relative flex min-w-0 cursor-pointer flex-col items-start gap-2.5 rounded-xl p-4 text-left text-foreground';
/** 原 styles.pagePill（分页计数 pill：D22e 中性 pill 口径 12px/20）。 */
const PAGE_PILL_CLASS =
  'inline-flex w-fit items-center whitespace-nowrap rounded-full bg-[color:var(--eteams-pill-bg)] px-2.5 py-0.5 text-xs text-[color:var(--eteams-pill-ink)]';
/** 原 styles.detailRow / detailLabel（构建中草稿预览行；--border 下边线；
 * D22d 数据行 14px/24）。 */
const DETAIL_ROW_CLASS = `flex gap-2.5 border-b border-solid py-2 text-sm leading-6 ${BORDER_L1_CLASS}`;
const DETAIL_LABEL_CLASS = 'w-16 shrink-0 pt-px text-xs font-semibold text-muted-foreground';
/** 原 styles.cmdChip（预填命令芯片：等宽字体 + --border 边框 + --muted 底；
 * D22d mono 芯片 13px 档）。 */
const CMD_CHIP_CLASS = `mt-2 break-all rounded-md border border-solid bg-muted px-3 py-2.5 text-[13px] leading-[1.7] font-mono text-muted-foreground ${BORDER_L1_CLASS}`;
/** 原 styles.buildStep / stepRow / stepNum（构建工作台）；原 prefillBanner
 * docs/23 S23-3 迁移 shadcn Alert（default 变体 + 品牌淡底覆盖），常量删除。
 * D22d：步骤行 14px/24、序号圆牌 12px。 */
const BUILD_STEP_CLASS = 'flex items-center gap-2 py-0.5 text-sm leading-6';
const STEP_ROW_CLASS = `mt-2 flex items-start gap-2 text-sm leading-6 ${TEXT2_CLASS}`;
const STEP_NUM_CLASS =
  'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-business-tint text-xs font-semibold text-[color:var(--eteams-brand-ink)]';

/** D22f 执行链/构建步骤字形三态调色（✔●◌ 字符保留=产品语义，只换色）：
 * done=已完成弱化灰、current=进行中品牌蓝（token 官网化为 sky）、
 * pending=未到站中性字（pill 字色 token）。完整字面量查表（21.5.1）。 */
const GLYPH_TONE_CLASS: Record<string, string> = {
  done: 'text-muted-foreground',
  current: 'text-primary',
  pending: 'text-[color:var(--eteams-pill-ink)]',
};

/** 页签标题（S24-2 新增，官网 h2 签名）：五 tab 内容区顶部的页头行——
 * 20px bold tracking-tight + mb-4；右侧动作位（团队页放「＋ 新增团队」
 * 主按钮 → 创建弹窗）。标题字即 tab 名，不发明副标题。 */
function PageHeader({ label, children }: { label: string; children?: ReactNode }): ReactNode {
  return (
    <div className="mb-4 flex items-center gap-3">
      <h2 className="m-0 text-xl font-bold tracking-tight text-foreground">{label}</h2>
      {children !== undefined && <span className="flex-1" />}
      {children}
    </div>
  );
}

/** S13：执行链站点行——✔/●/◌ 结构原样保留，仅样式改 Tailwind 类。D22f：
 * 字形三态调色查表（GLYPH_TONE_CLASS），站点名/meta 走 12px/20 小字档。 */
function TaskStations({ task }: { task: TaskView }): ReactNode {
  if (task.chainLength === 0) return null;
  return (
    <div className="mt-[3px]">
      {task.chain.map((s, i) => (
        <span key={i} className="mr-1.5 text-xs leading-5 text-muted-foreground">
          <span
            className={cn(
              GLYPH_TONE_CLASS[s.stationStatus] ?? GLYPH_TONE_CLASS.pending,
              'font-semibold',
            )}
          >
            {s.stationStatus === 'done' ? '✔' : s.stationStatus === 'current' ? '●' : '◌'}
          </span>{' '}
          {s.member}
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
          <DialogTitle>
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
                <div key={i} className={cn(MUTED_CLASS, 'my-1')}>
                  {relativeTime(p.at, now)} {p.text}
                </div>
              ))}
              {a.error !== undefined && (
                <div className="my-1 text-sm leading-6 text-destructive">✘ {a.error}</div>
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
  // 新增团队弹窗信号（用户迭代 2026-09）：递增计数驱动 TeamTab 打开创建
  // 弹窗（同 openAddTick 模式）——团队页头右上角按钮与 GOTO_ADD_TEAM 跳转
  // 信号（hero/弹层「新增团队」）都走它，表单卡片已撤。
  const [openCreateTick, setOpenCreateTick] = useState(0);
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
    // 「新增团队」信号：落到团队 tab，并打开创建弹窗（表单卡片已撤——
    // hero/弹层的「新增团队」入口同走这个信号，createTick 驱动 TeamTab 的
    // Dialog）。
    const hTeam = (): void => {
      consumePendingGotoAddTeam();
      dispatch({ type: 'ui/setNav', payload: 'team' });
      setOpenCreateTick((t) => t + 1);
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
      {/* 卡片化样式（用户反馈）：角色/团队卡片与删除按钮的 hover 态一次注入，
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
          {/* 页签标题（S24-2，官网 h2 签名）：每 tab 内容区顶部一行页头，
            团队页头右侧带「＋ 新增团队」主按钮（打开创建弹窗——名称即建，
            用户迭代 2026-09：看板页不再放新增入口）。 */}
          {activeTab === 'board' && <PageHeader label="看板" />}
          {activeTab === 'team' && (
            <PageHeader label="团队">
              <Button type="button" size="sm" onClick={() => setOpenCreateTick((t) => t + 1)}>
                <Plus className="h-3.5 w-3.5" />
                新增团队
              </Button>
            </PageHeader>
          )}
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
              createTick={openCreateTick}
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
        /* docs/23 S23-3：原 BANNER_CLASS → shadcn Alert warning 变体（amber
           淡底 + foreground 正文以 className 覆盖保留）。D22f：去三角字符
           前缀、官网呼吸感 px-4 py-3、正文随基线 14px。 */
        <Alert
          variant="warning"
          className="mb-3 rounded-xl bg-[color:var(--dsw-static-amber-100,#fef5e7)] px-4 py-3 text-sm leading-6 text-foreground"
        >
          {team.pendingDecisions.length} 项待决策：
          {team.pendingDecisions.map((d) => `${d.taskId}（${d.error.slice(0, 40)}）`).join('；')} ——
          到对话里让领队处理，或等待 M5 的代答操作。
        </Alert>
      )}
      <Card className={PANEL_CARD_CLASS}>
        <div className={SECTION_TITLE_CLASS}>目标</div>
        <div className="text-sm font-semibold leading-6 text-foreground">{team.goal}</div>
        {/* docs/23 S23-3：进度条迁 shadcn Progress（h-1.5=原 6px 轨高；
            transform 技法指示器，bg-primary 即 D21a DSW 蓝）。 */}
        <Progress
          className="mt-2.5 mb-1.5 h-1.5"
          value={
            team.progress.total === 0 ? 0 : (team.progress.completed / team.progress.total) * 100
          }
        />
        <div className={MUTED_CLASS}>
          {team.progress.completed}/{team.progress.total} 完成 · {team.progress.active} 执行中 ·{' '}
          {/* 成员计数（用户迭代 2026-09 修正）：只数成员，领队不占名额——
          与看板卡、添加成员弹窗同一口径。 */}
          {team.members.length} 成员 ·{' '}
          {/* 阶段徽标（S12）：原为 muted 行内文本，按「状态徽标用 shadcn」
          施工面升级为 outline Badge + TONE_CLASS 查表；tone 对齐 STATUS_GROUPS
          既有语义（PHASE_TONES）。D22d：12px 小字档（11px 档消灭）。 */}
          <Badge
            variant="outline"
            className={cn(
              'rounded-full border-solid px-2 py-px text-xs font-normal',
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
        {/* D22f：事件流去满宽下边线，改留白分组（列表 space-y-1 + 行 py-1.5）。 */}
        <div className="space-y-1">
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
        </div>
        <div className={MUTED_CLASS}>
          数据更新于 {fetchedAt === 0 ? '—' : relativeTime(fetchedAt, now)}
        </div>
      </Card>
    </div>
  );
}

/**
 * 团队：新增团队（弹窗，名称即建）+ 团队列表/详情两级视图（用户迭代
 * 2026-09）。列表态是长条形团队卡（名称 + 阶段徽标 + 进度 + 右侧成员
 * 头像略缩图最多 3 个），点击卡片进入该团队的详情——成员栅格、拉人、
 * 移出等只在详情视图出现。
 */
function TeamTab({
  sessionId,
  pool,
  team,
  roster,
  createTick,
  memberCap,
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
  /** 新增团队弹窗跳转信号（递增计数）：>0 且未消费时打开创建弹窗（openAddTick 同款）。 */
  createTick: number;
  /** 每队成员上限（host /state maxMembers）：添加成员弹窗的购物车配额。 */
  memberCap: number;
  onSelectTeam: (teamId: string) => void;
  /** Member subagent activity dots (docs/20.4 P4): childId → running/inactive. */
  agentActivity: Record<string, string>;
  onOpenReports: (name: string) => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 列表/详情两级视图（用户迭代 2026-09）：null=列表（长条卡片），非 null=
  // 详情（该团队 id）。弹窗建团成功后自动跳进新团队详情。
  const [detailId, setDetailId] = useState<string | null>(null);
  // 创建弹窗开合（组件内瞬态）：由 createTick 信号打开，关闭清信号痕迹。
  const [createOpen, setCreateOpen] = useState(false);
  // 添加成员弹窗（用户迭代 2026-09：Ele.me 点餐式）开合；详情态成员操作
  // （模型选择/移出/领队移除）的错误就地提示，不再静默吞掉。
  const [addOpen, setAddOpen] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  // 成员详情页（用户迭代 2026-09 四）：点成员/领队卡进入——成员详情与角色
  // 详情是两份独立数据（加入时复制），这里查看编辑成员自己的那份。null =
  // 成员栅格；kind='captain' = 领队详情（手册只读）。
  const [memberDetail, setMemberDetail] = useState<
    { kind: 'captain' } | { kind: 'member'; name: string } | null
  >(null);
  const [modelSavingName, setModelSavingName] = useState<string | null>(null);
  const [leaderModelSaving, setLeaderModelSaving] = useState(false);
  // 模型目录（用户迭代 2026-09：模型选择与对话一致；同日二级菜单）：与对话
  // /model 选择同一共享目录（ctx.modelDirectories，只读），loading/failed/
  // reload 与对话选择器打开时刷新、错误条+重试同款；catalog 为 null = 服务
  // 缺失（旧运行时），退回静态选项。成员/领队卡的选项与推理等级词汇表都
  // 来自这里。
  const modelCatalog = useModelCatalog(sessionId);
  const lastCreateTickRef = useRef(0);
  useEffect(() => {
    if (createTick > 0 && createTick !== lastCreateTickRef.current) {
      lastCreateTickRef.current = createTick;
      setCreateOpen(true);
    }
  }, [createTick]);
  // 面板创建团队绑定当前会话（领队即该会话代理）；浮层/无会话时没有可绑定的
  // 会话，创建按钮禁用并给出指引，而不是提交后吃 400 错误。
  const canCreate = typeof sessionId === 'string' && sessionId !== '';

  const create = async (): Promise<void> => {
    if (busy || !canCreate || name.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const created = await createTeamViaPanel(sessionId, name.trim());
      setName('');
      setCreateOpen(false);
      // 创建成功即选中并进入新团队详情（从 /state 快照回读前先按返回 id 落位）。
      if (created.teamId !== '') {
        onSelectTeam(created.teamId);
        setDetailId(created.teamId);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const detailTeam = detailId === null ? null : (pool.find((t) => t.teamId === detailId) ?? null);

  // 详情态成员操作（用户迭代 2026-09）：失败统一落到 detailError 就地展示。
  const memberOpError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  // 行值 → POST body（与对话 /model 选择的 selectionOf 同语义，用户迭代
  // 2026-09：模型选择与对话一致）：行 id 为 `provider/model`；换模型取该
  // 模型目录默认强度（model.reasoning.defaultEffort——对话 /model 弹层的
  // selectionOf 同款）；同一路线重选由菜单自行关闭不上送（对话 choose()
  // 同款）。目录查不到的旧路线原样保留 provider/model 与已存强度。
  // 'inherit' = 清 override（跟随领队/会话默认）。null = 非法行值（防御）。
  const routeBody = (
    value: string,
    stored: { provider: string; model: string; reasoningEffort: string | null },
  ): { provider?: string; model?: string; reasoningEffort?: string } | null => {
    if (value === 'inherit') return {};
    const slash = value.indexOf('/');
    if (slash === -1) {
      // 目录缺失时的静态回退选项（旧版裸模型 id）：沿用旧语义按 DeepSeek 下发。
      return { provider: 'deepseek', model: value };
    }
    if (slash <= 0 || slash === value.length - 1) return null;
    const provider = value.slice(0, slash);
    const model = value.slice(slash + 1);
    const row = catalogRow(modelCatalog.catalog, provider, model);
    const effort =
      stored.provider === provider && stored.model === model
        ? (stored.reasoningEffort ?? row?.model.reasoning?.defaultEffort)
        : row?.model.reasoning?.defaultEffort;
    return {
      provider,
      model,
      ...(effort !== undefined && effort !== '' ? { reasoningEffort: effort } : {}),
    };
  };

  const changeModel = (memberName: string, value: string): void => {
    if (detailTeam === null) return;
    const member = detailTeam.members.find((m) => m.name === memberName);
    if (member === undefined) return;
    const previous: RouteTriple = {
      provider: member.provider,
      model: member.model,
      reasoningEffort: member.reasoningEffort,
    };
    const body = routeBody(value, previous);
    if (body === null) return;
    setDetailError(null);
    setModelSavingName(memberName);
    // 选择即变（对话 choose() 同款本地即时性）：先打乐观补丁——触发器文案/
    // 勾选/推理等级入口不等 POST + 1s 轮询；pending 覆盖层防在途旧快照闪回，
    // POST 成功立即快照确认，失败回滚 + 就地报错。
    const patch: RoutePatch = {
      teamId: detailTeam.teamId,
      target: { kind: 'member', name: memberName },
      route: {
        provider: body.provider ?? 'inherit',
        model: body.model ?? 'inherit',
        reasoningEffort: body.reasoningEffort ?? null,
      },
    };
    applyRoutePatch(patch);
    // inherit = 跟随领队（清 override）；其余按会话模型目录（与对话一致）下发。
    void setMemberModel(detailTeam.teamId, memberName, body)
      .then(() => refreshActivitySoon())
      .catch((e) => {
        revertRoutePatch(patch, previous);
        setDetailError(memberOpError(e));
      })
      .finally(() => setModelSavingName(null));
  };

  // 推理等级（与对话「推理等级」二级菜单同一词汇表）：只对已有具体路线的
  // 成员生效——整条路线重发（host 每次整路由写入）。effort 为 null = 提供方
  // 默认（对话 chooseEffort 的 provider-default 项同款）：重发时省略
  // reasoningEffort，host 即无强度 override。
  const changeMemberEffort = (memberName: string, effort: string | null): void => {
    if (detailTeam === null) return;
    const member = detailTeam.members.find((m) => m.name === memberName);
    if (member === undefined || member.provider === 'inherit' || member.model === 'inherit') {
      return;
    }
    setDetailError(null);
    setModelSavingName(memberName);
    const previous: RouteTriple = {
      provider: member.provider,
      model: member.model,
      reasoningEffort: member.reasoningEffort,
    };
    // 同 changeModel：乐观补丁即时生效，POST 确认/回滚。
    const patch: RoutePatch = {
      teamId: detailTeam.teamId,
      target: { kind: 'member', name: memberName },
      route: { ...previous, reasoningEffort: effort },
    };
    applyRoutePatch(patch);
    void setMemberModel(detailTeam.teamId, memberName, {
      provider: member.provider,
      model: member.model,
      ...(effort !== null && effort !== '' ? { reasoningEffort: effort } : {}),
    })
      .then(() => refreshActivitySoon())
      .catch((e) => {
        revertRoutePatch(patch, previous);
        setDetailError(memberOpError(e));
      })
      .finally(() => setModelSavingName(null));
  };

  const removeMember = (memberName: string): void => {
    if (detailTeam === null) return;
    setDetailError(null);
    void removeTeamMember(detailTeam.teamId, memberName).catch((e) =>
      setDetailError(memberOpError(e)),
    );
  };

  const removeLeader = (): void => {
    if (detailTeam === null) return;
    setDetailError(null);
    void setTeamLeaderRemoved(detailTeam.teamId, true).catch((e) =>
      setDetailError(memberOpError(e)),
    );
  };

  // 领队模型选择（用户迭代 2026-09：领队也选模型；2026-09 模型选择与对话
  // 一致）：领队卡右侧下拉——这是「团队默认模型」，成员选「跟随领队」时
  // 启动即按它下发；领队自身（面板会话）模型不受影响。行值语义同 changeModel。
  const changeLeaderModel = (value: string): void => {
    if (detailTeam === null) return;
    const previous: RouteTriple = {
      provider: detailTeam.captain.provider,
      model: detailTeam.captain.model,
      reasoningEffort: detailTeam.captain.reasoningEffort,
    };
    const body = routeBody(value, previous);
    if (body === null) return;
    setDetailError(null);
    setLeaderModelSaving(true);
    // 同 changeModel：乐观补丁即时生效，POST 确认/回滚（目标 = 领队）。
    const patch: RoutePatch = {
      teamId: detailTeam.teamId,
      target: { kind: 'captain' },
      route: {
        provider: body.provider ?? 'inherit',
        model: body.model ?? 'inherit',
        reasoningEffort: body.reasoningEffort ?? null,
      },
    };
    applyRoutePatch(patch);
    void setLeaderModel(detailTeam.teamId, body)
      .then(() => refreshActivitySoon())
      .catch((e) => {
        revertRoutePatch(patch, previous);
        setDetailError(memberOpError(e));
      })
      .finally(() => setLeaderModelSaving(false));
  };

  // 领队推理等级（与对话「推理等级」二级菜单同一词汇表）：只对领队已选具体
  // 路线时生效；跟随会话默认（inherit）时强度随会话，不可单独改。null =
  // 提供方默认（重发时省略 reasoningEffort）。
  const changeLeaderEffort = (effort: string | null): void => {
    if (detailTeam === null) return;
    const captain = detailTeam.captain;
    if (captain.provider === 'inherit' || captain.model === 'inherit') return;
    setDetailError(null);
    setLeaderModelSaving(true);
    const previous: RouteTriple = {
      provider: captain.provider,
      model: captain.model,
      reasoningEffort: captain.reasoningEffort,
    };
    // 同 changeModel：乐观补丁即时生效，POST 确认/回滚（目标 = 领队）。
    const patch: RoutePatch = {
      teamId: detailTeam.teamId,
      target: { kind: 'captain' },
      route: { ...previous, reasoningEffort: effort },
    };
    applyRoutePatch(patch);
    void setLeaderModel(detailTeam.teamId, {
      provider: captain.provider,
      model: captain.model,
      ...(effort !== null && effort !== '' ? { reasoningEffort: effort } : {}),
    })
      .then(() => refreshActivitySoon())
      .catch((e) => {
        revertRoutePatch(patch, previous);
        setDetailError(memberOpError(e));
      })
      .finally(() => setLeaderModelSaving(false));
  };

  return (
    <div>
      {/* 新增团队弹窗（用户迭代 2026-09）：shadcn Dialog + Input，输入名称按
      「新增团队」创建——创建由面板会话绑定限制（canCreate）同表单一致。 */}
      <Dialog
        open={createOpen}
        onOpenChange={(next) => {
          if (!next) {
            setCreateOpen(false);
            setError(null);
            setName('');
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle>新增团队</DialogTitle>
            <DialogDescription className={MUTED_CLASS}>
              {canCreate
                ? '只需名称即可创建（草案阶段）；目标可在看板中与领队继续完善。'
                : '当前还没有进行中的对话——开始对话后才能创建团队。'}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={name}
            autoFocus
            placeholder="团队名称，如：文档迁移小组"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
            }}
          />
          {error !== null && <FormErrorNote>{error}</FormErrorNote>}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setCreateOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy || !canCreate || name.trim() === ''}
              onClick={() => void create()}
            >
              新增团队
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 列表态：长条形团队卡（用户迭代 2026-09）——一行一团队，名称 + 阶段
      徽标 + 进度/计数在左，右侧成员头像略缩图最多 3 个（超出 +N）；点击卡片
      进入该团队详情。当前团队高亮描边沿用 .eteams-team-card[data-active]。 */}
      {detailTeam === null && pool.length > 0 && (
        <Card className={cn(PANEL_CARD_CLASS, 'pb-3')}>
          <div className="mb-2.5 flex items-center gap-2">
            <h3 className={LIST_TITLE_CLASS}>团队</h3>
            <span className={LIST_COUNT_CLASS}>{pool.length} 个</span>
          </div>
          <div className="flex flex-col gap-3">
            {pool.map((t) => {
              const active = t.teamId === team?.teamId;
              return (
                <div
                  key={t.teamId}
                  className={cn('eteams-team-card', TEAM_ROW_CLASS)}
                  data-active={active ? 'true' : 'false'}
                  onClick={() => {
                    // 进详情同时选中该团队：看板/任务/汇报的联动对象跟着走
                    // （原卡片点击的选中语义保留）。
                    onSelectTeam(t.teamId);
                    setDetailId(t.teamId);
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="eteams-team-name flex-1 text-sm font-semibold text-foreground">
                        {t.name}
                      </span>
                      {active && <span className={ROLE_CHIP_CLASS}>当前</span>}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <span className={PHASE_PILL_CLASS}>
                        {/* D22e：状态彩底全撤——阶段语义由彩色 6px dot 承载。 */}
                        <span className={dotClass(PHASE_TONES[t.phase] ?? 'muted')} />
                        {PHASE_LABELS[t.phase] ?? t.phase}
                      </span>
                      <span className={LIST_COUNT_CLASS}>
                        {t.progress.completed}/{t.progress.total} 任务 · {t.members.length} 成员
                      </span>
                    </div>
                    <Progress
                      className="mt-2.5 h-1.5"
                      value={
                        t.progress.total === 0 ? 0 : (t.progress.completed / t.progress.total) * 100
                      }
                    />
                  </div>
                  {/* 右侧成员略缩图（用户迭代 2026-09）：领队 + 成员头像最多
                  3 个，超出计数 +N；负间距叠放 + 底色描边环（官网常见略缩图
                  签名），title 兜底全名。 */}
                  <div className="flex shrink-0 items-center -space-x-2 pl-3">
                    {(t.leaderRemoved ? t.members : [t.captain, ...t.members])
                      .slice(0, 3)
                      .map((m) => (
                        <span
                          key={m.name}
                          className="inline-flex shrink-0 rounded-full ring-2 ring-[color:var(--background)]"
                          title={m.name}
                        >
                          <Avatar
                            name={m.name}
                            seed={m.avatar?.seed}
                            salt={m.avatar?.salt}
                            size={28}
                          />
                        </span>
                      ))}
                    {(t.leaderRemoved ? 0 : 1) + t.members.length > 3 && (
                      <span
                        className={cn(
                          'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
                          'bg-muted text-muted-foreground ring-2 ring-[color:var(--background)]',
                        )}
                        title={`其余 ${(t.leaderRemoved ? 0 : 1) + t.members.length - 3} 人`}
                      >
                        +{(t.leaderRemoved ? 0 : 1) + t.members.length - 3}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {detailTeam === null && pool.length === 0 && (
        <div className={EMPTY_CLASS}>还没有团队。点右上角「新增团队」创建第一个团队。</div>
      )}

      {/* 成员详情页（用户迭代 2026-09 四）：点成员/领队卡进来，盖在成员栅格
      之上——查看/编辑成员自己的手册副本、同步回角色库。 */}
      {detailTeam !== null && memberDetail !== null && (
        <MemberDetailView
          team={detailTeam}
          target={memberDetail}
          onBack={() => setMemberDetail(null)}
          onOpenReports={onOpenReports}
        />
      )}

      {/* 详情态（用户迭代 2026-09）：点长条卡片才进来——团队成员、拉人组队
      都在这里。返回按钮回列表。 */}
      {detailTeam !== null && memberDetail === null && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setDetailId(null);
                setDetailError(null);
                setMemberDetail(null);
              }}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              返回团队列表
            </Button>
            <span className="text-lg font-semibold tracking-tight text-foreground">
              {detailTeam.name}
            </span>
            <span className={PHASE_PILL_CLASS}>
              <span className={dotClass(PHASE_TONES[detailTeam.phase] ?? 'muted')} />
              {PHASE_LABELS[detailTeam.phase] ?? detailTeam.phase}
            </span>
          </div>

          {/* 团队成员卡（S13/S14）：容器 shadcn Card（PANEL_CARD_CLASS 覆盖层，
          S12 先例）；拉人下拉已移除（用户迭代 2026-09），改为右上「添加成员」
          按钮点开点餐式弹窗。 */}
          <Card className={cn(PANEL_CARD_CLASS, 'mt-2')}>
            <div className="mb-2.5 flex items-center gap-2">
              <h3 className={LIST_TITLE_CLASS}>团队成员</h3>
              <span className={LIST_COUNT_CLASS}>
                {detailTeam.members.length}/{memberCap} 人 ·{' '}
                {detailTeam.leaderRemoved ? '领队已移除' : '领队默认在团（不占名额）'}
              </span>
              <span className="flex-1" />
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setDetailError(null);
                  setAddOpen(true);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                添加成员
              </Button>
            </div>
            {detailError !== null && (
              <FormErrorNote className="mb-2.5">{detailError}</FormErrorNote>
            )}
            <div className={MEMBER_GRID_CLASS}>
              {!detailTeam.leaderRemoved && (
                <LeaderCard
                  captain={detailTeam.captain}
                  catalog={modelCatalog}
                  onRemove={removeLeader}
                  onModelChange={changeLeaderModel}
                  onEffortChange={changeLeaderEffort}
                  modelSaving={leaderModelSaving}
                  onOpenDetail={() => setMemberDetail({ kind: 'captain' })}
                />
              )}
              {detailTeam.members.map((m) => (
                <MemberCard
                  key={m.name}
                  member={m}
                  catalog={modelCatalog}
                  activity={m.childId !== null ? agentActivity[m.childId] : undefined}
                  onOpenReports={onOpenReports}
                  onRemove={removeMember}
                  onModelChange={changeModel}
                  onEffortChange={changeMemberEffort}
                  modelSaving={modelSavingName === m.name}
                  onOpenDetail={() => setMemberDetail({ kind: 'member', name: m.name })}
                />
              ))}
              {detailTeam.members.length === 0 && (
                <div className={MUTED_CLASS}>
                  还没有成员——点右上角「添加成员」，像点餐一样把角色加进团队。
                </div>
              )}
            </div>
          </Card>

          {/* 添加成员弹窗（用户迭代 2026-09）：Ele.me 点餐式角色加团。 */}
          <AddMembersDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            team={detailTeam}
            roster={roster}
            memberCap={memberCap}
          />
        </>
      )}
    </div>
  );
}

/** 领队静态选项（目录不可用时的回退，用户迭代 2026-09）：inherit=会话默认。
 * 领队即面板会话，自身模型不由插件切换——此路线是团队默认，成员「跟随领队」
 * spawn 时解析到它。目录就绪时由 RouteOptionItems 以会话模型目录替代。 */
const LEADER_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'inherit', label: '会话默认' },
  { value: 'deepseek-chat', label: 'DeepSeek Chat' },
  { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
];

/** 模型二级菜单的行样式（完整字面量，对话 ModelSelect 同构的 token 化版本：
 * root 行 = label + 当前值 + 右箭头；列表项 = 名称 + 描述 + 选中勾）。 */
const PICKER_CELL_CLASS =
  'flex h-9 w-full items-center gap-2 rounded-lg bg-transparent px-2.5 text-left text-[13px] text-foreground outline-none hover:bg-accent disabled:cursor-default disabled:text-muted-foreground';
const PICKER_OPTION_CLASS =
  'flex min-h-[34px] w-full items-center gap-2 rounded-lg bg-transparent px-2 py-1 text-left text-foreground outline-none hover:bg-accent disabled:cursor-default disabled:text-muted-foreground';

/** 模型二级菜单（用户迭代 2026-09：与对话 ModelSelect 同款交互）——root
 * 面板两行（「模型」「推理等级」：label + 当前值 + 右箭头），各自钻入列表。
 * 模型列表首行 inherit（跟随领队/会话默认——面板路线语义，对话没有此项），
 * 其后按提供方分组列出会话模型目录（与对话 /model 弹层同一份 groups：
 * 行 id=`provider/model`、名称=目录显示名、sticky 组头、title 带描述），
 * 加载失败的提供方以警示条列出（对话同款，不可选）；推理等级列表 = 该模型
 * reasoning.efforts（适配器命名），模型无目录默认值时前置「Default」= 提供
 * 方默认（提交 null，整路由省略 reasoningEffort）。对话组件不可直接复用
 * （未从包导出、模块加载器包裹、且其 select 会切换会话自身模型），这里按
 * 同一结构以面板 token 重建；目录缺失（旧运行时）时模型列表退回静态选项。
 * 交互对齐：每次打开刷新目录（对话 show() → reload()）、Esc 子面板返回
 * root / root 关闭、方向键在项间漫游、重选当前值仅关闭不上送（choose()
 * 同款）。 */
function ModelRoutePicker({
  catalogState,
  stored,
  inheritLabel,
  fallback,
  disabled,
  onModelPick,
  onEffortPick,
  title,
}: {
  /** 会话模型目录状态（数据 + loading/failed/reload，对话选择器同款）。 */
  catalogState: ModelCatalogState;
  /** 当前存储路线（inherit 哨兵 = 跟随领队/会话默认）。 */
  stored: { provider: string; model: string; reasoningEffort: string | null };
  /** inherit 行/触发器文案（成员=跟随领队，领队=会话默认）。 */
  inheritLabel: string;
  /** 静态回退选项（目录不可用时渲染，含 inherit 行）。 */
  fallback: { value: string; label: string }[];
  /** 路由保存中（触发器与选项短暂禁用防连点）。 */
  disabled?: boolean;
  /** 模型选择提交：'inherit' | `provider/model` | 回退裸模型 id。 */
  onModelPick: (value: string) => void;
  /** 推理等级提交：null = 提供方默认（整路由省略 reasoningEffort）。 */
  onEffortPick: (effort: string | null) => void;
  /** 触发器 tooltip。 */
  title: string;
}): ReactNode {
  const catalog = catalogState.catalog;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root');
  const override = stored.provider !== 'inherit' && stored.model !== 'inherit';
  const row = override ? catalogRow(catalog, stored.provider, stored.model) : null;
  const reasoning = row?.model.reasoning;
  // 触发器模型名：inherit → 跟随文案；目录行在 → 目录显示名；历史路线 →
  // 存量模型 id（目录查不到的历史路线合成行兜底，选中态可见）。
  const modelLabel = !override ? inheritLabel : row !== null ? row.model.name : stored.model;
  // 触发器/推理等级面板的当前等级（对话 effectiveEffort 口径）：已存强度
  // 优先（哪怕已不在词汇表——对话 find 失败时原样显示），否则目录默认；
  // null = 提供方默认（对话 effort.providerDefault，显示「Default」）。
  const effectiveEffort: string | null =
    override && stored.reasoningEffort !== null
      ? stored.reasoningEffort
      : (reasoning?.defaultEffort ?? null);
  const effortName = (effort: string | null): string =>
    effort === null ? 'Default' : (reasoning?.efforts.find((e) => e.id === effort)?.name ?? effort);
  const effortLabel = reasoning === undefined ? undefined : effortName(effectiveEffort);
  // 推理等级面板条目（对话 effortChoices 同构）：无目录默认值时前置
  // 「Default」（effort 提交 null = 省略）。
  const effortChoices: {
    key: string;
    effort: string | null;
    label: string;
    description?: string;
  }[] =
    reasoning === undefined
      ? []
      : [
          ...(reasoning.defaultEffort === undefined
            ? [{ key: 'provider-default', effort: null, label: 'Default' }]
            : []),
          ...reasoning.efforts.map((e) => ({
            key: `effort:${e.id}`,
            effort: e.id as string | null,
            label: e.name,
            ...(e.description !== undefined ? { description: e.description } : {}),
          })),
        ];
  // 行值口径（选中态匹配用，同旧 routeValue）：目录在 → `provider/model`；
  // 目录缺失 → 裸模型 id；inherit → 'inherit'。
  const currentValue = !override
    ? 'inherit'
    : catalog === null
      ? stored.model
      : `${stored.provider}/${stored.model}`;

  const close = (): void => setOpen(false);
  // 每次打开重置到 root 并刷新目录（对话 ModelSelect.show() 同款）。
  const openMenu = (): void => {
    setPane('root');
    catalogState.reload();
    setOpen(true);
  };
  const pickModel = (value: string): void => {
    // 重选当前路线仅关闭不上送（对话 choose() 同款，不重复提交）。
    if (value !== currentValue) onModelPick(value);
    close();
  };
  const pickEffort = (effort: string | null): void => {
    if (effort !== effectiveEffort) onEffortPick(effort);
    close();
  };
  // 对话同款焦点巡航：ArrowDown/Up 在浮层内可聚焦项间移动。
  const moveFocus = (offset: number): void => {
    const root = rootRef.current;
    if (root === null) return;
    const items = Array.from(root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    if (items.length === 0) return;
    const active = document.activeElement;
    const at = active instanceof HTMLButtonElement ? items.indexOf(active) : -1;
    items[(Math.max(at, 0) + offset + items.length) % items.length]?.focus();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) openMenu();
        else close();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 w-[132px] shrink-0 items-center gap-1 rounded-md border border-solid bg-transparent px-2 text-xs font-medium outline-none transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          title={title}
          disabled={disabled === true}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span className="min-w-0 flex-1 truncate text-left">{modelLabel}</span>
          {effortLabel !== undefined && (
            <span className="flex-none text-[11px] text-muted-foreground">{effortLabel}</span>
          )}
          <ChevronDown
            className={cn(
              'h-3 w-3 flex-none text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={rootRef}
        align="end"
        sideOffset={6}
        role="menu"
        aria-label="模型与推理等级"
        className="w-64 rounded-xl border-solid p-1 shadow-lg"
        // 焦点留在触发器（对话同款），ArrowDown/Up 才能漫游进浮层。
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Esc：子面板返回 root（对话同款），root 才真正关闭浮层。
        onEscapeKeyDown={(event) => {
          if (pane !== 'root') {
            event.preventDefault();
            setPane('root');
          }
        }}
        onKeyDown={(event) => {
          // Esc：root 面板手动关闭（对话 onRootKeyDown 同款——不依赖浮层库的
          // dismiss 链路，合成/真实事件行为一致）；子面板由 onEscapeKeyDown
          // 拦下并返回 root。
          if (event.key === 'Escape' && pane === 'root') {
            event.preventDefault();
            close();
            return;
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            moveFocus(event.key === 'ArrowDown' ? 1 : -1);
          }
        }}
      >
        {pane === 'root' && (
          <>
            <button type="button" className={PICKER_CELL_CLASS} onClick={() => setPane('model')}>
              <span className="flex-none">模型</span>
              <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
                {modelLabel}
              </span>
              <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
            </button>
            {reasoning !== undefined && (
              <button type="button" className={PICKER_CELL_CLASS} onClick={() => setPane('effort')}>
                <span className="flex-none">推理等级</span>
                <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
                  {effortLabel ?? 'Default'}
                </span>
                <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
              </button>
            )}
          </>
        )}
        {pane === 'model' && (
          <>
            {/* inherit 行：面板路线语义（跟随领队/会话默认），对话没有此项。 */}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!override}
              className={PICKER_OPTION_CLASS}
              disabled={disabled === true}
              onClick={() => pickModel('inherit')}
            >
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                {inheritLabel}
              </span>
              <span className="grid h-4 w-4 flex-none place-items-center">
                {!override && <Check className="h-3.5 w-3.5" />}
              </span>
            </button>
            {catalogState.loading && (
              <div className="px-2 py-2 text-xs text-muted-foreground">正在刷新模型列表…</div>
            )}
            {catalogState.failed && (
              <div className="mx-1 mb-1 flex items-center justify-between gap-2 rounded-lg bg-muted px-2 py-1.5 text-xs text-destructive">
                <span className="min-w-0">目录加载失败</span>
                <button
                  type="button"
                  className="flex-none font-semibold hover:underline"
                  onClick={() => catalogState.reload()}
                >
                  重试
                </button>
              </div>
            )}
            {catalog !== null ? (
              <>
                {catalog.groups.map((g) => (
                  <section key={g.id} role="group" aria-label={g.name} className="mt-1 first:mt-0">
                    <div className="sticky top-0 z-[1] bg-popover px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">
                      {g.name}
                    </div>
                    {g.models.map((m) => {
                      const selected =
                        override && stored.provider === g.id && stored.model === m.id;
                      return (
                        <button
                          key={`${g.id}/${m.id}`}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          className={PICKER_OPTION_CLASS}
                          disabled={disabled === true}
                          title={
                            m.description !== undefined ? `${g.name} · ${m.description}` : g.name
                          }
                          onClick={() => pickModel(`${g.id}/${m.id}`)}
                        >
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-[13px] font-medium">{m.name}</span>
                            {m.description !== undefined && (
                              <span className="truncate text-[11px] text-muted-foreground">
                                {m.description}
                              </span>
                            )}
                          </span>
                          <span className="grid h-4 w-4 flex-none place-items-center">
                            {selected && <Check className="h-3.5 w-3.5" />}
                          </span>
                        </button>
                      );
                    })}
                  </section>
                ))}
                {catalog.failures.map((f) => (
                  <div
                    key={`failure/${f.id}`}
                    className="mx-1 mb-1 flex items-start justify-between gap-2 rounded-lg bg-muted px-2 py-1.5 text-xs text-warning"
                    title={f.message}
                  >
                    <span className="min-w-0">
                      {f.name} 加载失败：{f.message}
                    </span>
                    <button
                      type="button"
                      className="flex-none font-semibold hover:underline"
                      onClick={() => catalogState.reload()}
                    >
                      重试
                    </button>
                  </div>
                ))}
                {/* 目录查不到的历史路线合成一行，保证选中态可见。 */}
                {override && row === null && (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked
                    className={PICKER_OPTION_CLASS}
                    disabled
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {stored.model}
                    </span>
                    <span className="grid h-4 w-4 flex-none place-items-center">
                      <Check className="h-3.5 w-3.5" />
                    </span>
                  </button>
                )}
              </>
            ) : !catalogState.failed ? (
              fallback
                .filter((o) => o.value !== 'inherit')
                .map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={currentValue === o.value}
                    className={PICKER_OPTION_CLASS}
                    disabled={disabled === true}
                    onClick={() => pickModel(o.value)}
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {o.label}
                    </span>
                    <span className="grid h-4 w-4 flex-none place-items-center">
                      {currentValue === o.value && <Check className="h-3.5 w-3.5" />}
                    </span>
                  </button>
                ))
            ) : null}
          </>
        )}
        {pane === 'effort' && (
          <>
            {effortChoices.length === 0 ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">
                当前模型未提供推理等级。
              </div>
            ) : (
              effortChoices.map((level) => {
                const selected = effectiveEffort === level.effort;
                return (
                  <button
                    key={level.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={PICKER_OPTION_CLASS}
                    disabled={disabled === true}
                    onClick={() => pickEffort(level.effort)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px] font-medium">{level.label}</span>
                      {level.description !== undefined && (
                        <span className="truncate text-[11px] text-muted-foreground">
                          {level.description}
                        </span>
                      )}
                    </span>
                    <span className="grid h-4 w-4 flex-none place-items-center">
                      {selected && <Check className="h-3.5 w-3.5" />}
                    </span>
                  </button>
                );
              })
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The 领队（项目牧羊人）leader card. S13 Tailwind 化。
 * 用户迭代 2026-09：领队可被移出团队（可经添加成员弹窗加回），onRemove 挂移除钮；
 * 领队也算团队一员——工号 + 右侧同款模型二级菜单（= 团队默认路线）。
 * 用户迭代 2026-09 四：查看手册按钮去掉，点卡片进领队详情（手册只读）。 */
function LeaderCard({
  captain,
  catalog,
  onRemove,
  onModelChange,
  onEffortChange,
  modelSaving,
  onOpenDetail,
}: {
  captain: CaptainView;
  /** 会话模型目录状态（数据 + loading/failed/reload，对话选择器同款）。 */
  catalog: ModelCatalogState;
  onRemove?: () => void;
  /** 领队模型选择（右侧二级菜单）：'inherit' = 会话默认。 */
  onModelChange?: (model: string) => void;
  /** 领队推理等级（菜单内「推理等级」子面板；null = 提供方默认）。 */
  onEffortChange?: (effort: string | null) => void;
  /** 领队模型路由保存中（菜单短暂禁用防连点）。 */
  modelSaving?: boolean;
  /** 点卡片进领队详情（手册只读）。 */
  onOpenDetail?: () => void;
}): ReactNode {
  return (
    <div className={cn(MEMBER_CARD_CLASS, 'col-span-full')}>
      <div className="flex items-center gap-2.5">
        <div
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2.5 rounded-lg',
            onOpenDetail !== undefined && 'cursor-pointer transition-colors hover:bg-muted/60',
          )}
          onClick={onOpenDetail}
          title={onOpenDetail !== undefined ? '进入领队详情' : undefined}
        >
          <Avatar name={captain.name} seed={captain.avatar.seed} salt={captain.avatar.salt} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">{captain.name}</span>
              <span className={ROLE_CHIP_CLASS}>领队</span>
            </div>
            <div className={cn(MUTED_CLASS, 'mt-px')}>
              {captain.employeeId !== '' ? `${captain.employeeId} · ` : ''}
              {captain.role} · 不接任务：负责拆解、指派与调度
            </div>
          </div>
        </div>
        {onModelChange !== undefined && (
          <ModelRoutePicker
            catalogState={catalog}
            stored={{
              provider: captain.provider,
              model: captain.model,
              reasoningEffort: captain.reasoningEffort,
            }}
            inheritLabel="会话默认"
            fallback={LEADER_MODEL_OPTIONS}
            disabled={modelSaving}
            onModelPick={onModelChange}
            onEffortPick={(effort) => onEffortChange !== undefined && onEffortChange(effort)}
            title="选择领队模型（= 团队默认；成员「跟随领队」启动时按此下发；目录与对话模型选择一致）"
          />
        )}
        {onRemove !== undefined && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={onRemove}
          >
            移出团队
          </Button>
        )}
      </div>
    </div>
  );
}

/** 成员模型选项（用户迭代 2026-09）：inherit=跟随领队（默认路线）；切换只改
 * member.modelRoute——staged 成员启动即生效，运行中的成员下次启动生效。 */
/** 成员静态选项（目录不可用时的回退）：inherit=跟随领队（默认路线）；切换
 * 只改 member.modelRoute——staged 成员启动即生效，运行中的成员下次启动生效。 */
const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'inherit', label: '跟随领队' },
  { value: 'deepseek-chat', label: 'DeepSeek Chat' },
  { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
];

/** One team-member card: seeded avatar + status pill + 工号 + 右侧模型选择 +
 * 推理强度 + 移出团队（用户迭代 2026-09：工号/模型/删除；模型目录与对话
 * 一致——二级菜单内多档 effort 模型带「推理等级」子面板——用户迭代 2026-09 二）。
 * 用户迭代 2026-09 四：点卡片（头像/名字区）进成员详情页。 */
function MemberCard({
  member: m,
  catalog,
  activity,
  onOpenReports,
  onRemove,
  onModelChange,
  onEffortChange,
  modelSaving,
  onOpenDetail,
}: {
  member: MemberView;
  /** 会话模型目录状态（数据 + loading/failed/reload，对话选择器同款）。 */
  catalog: ModelCatalogState;
  /** Subagent activity (docs/20.4 P4): 'running' | 'inactive' | undefined. */
  activity?: string;
  onOpenReports?: (name: string) => void;
  onRemove?: (name: string) => void;
  /** 模型选择（右侧二级菜单）：行 id=`provider/model`，'inherit' = 跟随领队路线。 */
  onModelChange?: (memberName: string, model: string) => void;
  /** 推理等级改写（菜单内「推理等级」子面板；null = 提供方默认）。 */
  onEffortChange?: (memberName: string, effort: string | null) => void;
  /** 该成员的模型路由保存中（菜单短暂禁用防连点）。 */
  modelSaving?: boolean;
  /** 点卡片（头像/名字区）进成员详情页。 */
  onOpenDetail?: (name: string) => void;
}): ReactNode {
  const tone = memberTone(m.status);
  const openDetail = (): void => {
    if (onOpenDetail !== undefined) onOpenDetail(m.name);
  };
  return (
    <div className={MEMBER_CARD_CLASS}>
      <div className="flex items-center gap-2.5">
        <div
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2.5 rounded-lg',
            onOpenDetail !== undefined && 'cursor-pointer transition-colors hover:bg-muted/60',
          )}
          onClick={openDetail}
          title={onOpenDetail !== undefined ? '进入成员详情' : undefined}
        >
          <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              {activity !== undefined && (
                <span
                  title={activity === 'running' ? '子代理运行中' : '子代理已完结'}
                  className={
                    activity === 'running'
                      ? // 状态点光晕（D22f）：green-100 死字面量改 color-mix
                        // success 淡环（token 半透明替代路径，button.tsx 先例，
                        // 亮暗自适应）。
                        'h-[7px] w-[7px] shrink-0 rounded-full bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--success)_15%,transparent)]'
                      : 'h-[7px] w-[7px] shrink-0 rounded-full bg-muted-foreground'
                  }
                />
              )}
              {m.name}
            </div>
            <div className={cn(MUTED_CLASS, 'mt-px')}>
              {m.employeeId !== null ? `${m.employeeId} · ` : ''}
              {m.role}
            </div>
          </div>
        </div>
        {onModelChange !== undefined && (
          <ModelRoutePicker
            catalogState={catalog}
            stored={{
              provider: m.provider,
              model: m.model,
              reasoningEffort: m.reasoningEffort,
            }}
            inheritLabel="跟随领队"
            fallback={MODEL_OPTIONS}
            disabled={modelSaving}
            onModelPick={(v) => onModelChange !== undefined && onModelChange(m.name, v)}
            onEffortPick={(effort) =>
              onEffortChange !== undefined && onEffortChange(m.name, effort)
            }
            title="选择成员运行的模型（目录与对话模型选择一致；运行中的成员下次启动时生效）"
          />
        )}
      </div>
      <Pill tone={tone}>
        {STATUS_LABELS[m.status] ?? m.status}
        {m.currentTaskId !== null && <span className="font-normal">· {m.currentTaskId}</span>}
      </Pill>
      <div className="flex gap-1.5">
        {onOpenReports !== undefined && (
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenReports(m.name)}>
            汇报记录
          </Button>
        )}
        {onRemove !== undefined && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => onRemove(m.name)}
          >
            移出团队
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * 成员详情页（用户迭代 2026-09 四）：点成员/领队卡进入。成员详情与角色详情
 * 是两份独立数据——加入团队时从角色库复制一份，之后各自演化；这里查看/
 * 编辑成员自己的手册（「保存」只写成员记录），「同步到角色」把当前手册写回
 * 角色库同名角色（副本成员无同名角色时按成员记录新建）。领队也走这一页：
 * 手册由系统合成，只读、无保存/同步。
 */
function MemberDetailView({
  team,
  target,
  onBack,
  onOpenReports,
}: {
  team: TeamSnapshot;
  target: { kind: 'captain' } | { kind: 'member'; name: string };
  onBack: () => void;
  onOpenReports?: (name: string) => void;
}): ReactNode {
  // 编辑缓冲：null = 只读渲染；string = 编辑中。进入编辑时从当前手册播种。
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState(false);
  const [syncedNote, setSyncedNote] = useState(false);

  const memberRow =
    target.kind === 'member' ? team.members.find((m) => m.name === target.name) : undefined;

  if (target.kind === 'member' && memberRow === undefined) {
    return (
      <Card className={cn(PANEL_CARD_CLASS, 'mt-2')}>
        <div className={MUTED_CLASS}>成员不在团队里——可能刚被移出。</div>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" />
          返回团队成员
        </Button>
      </Card>
    );
  }

  // 详情页展示口径：优先成员自己的手册副本；旧成员没有副本时按结构字段
  // 合成骨架（首次保存/同步即落成正式手册）。
  const view: {
    name: string;
    employeeId: string | null;
    role: string;
    status: string | null;
    avatar: { seed: number; salt: number } | null;
    source: HandbookSource;
  } =
    target.kind === 'captain'
      ? {
          name: team.captain.name,
          employeeId: team.captain.employeeId,
          role: team.captain.role,
          status: null,
          avatar: team.captain.avatar,
          source: {
            name: team.captain.name,
            role: team.captain.role,
            personaMd: team.captain.personaMd,
            duty: team.captain.duty,
            style: team.captain.style,
            skills: team.captain.skills,
          },
        }
      : {
          name: memberRow?.name ?? target.name,
          employeeId: memberRow?.employeeId ?? null,
          role: memberRow?.role ?? '',
          status: memberRow?.status ?? null,
          avatar: memberRow?.avatar ?? null,
          source: {
            name: memberRow?.name ?? target.name,
            role: memberRow?.role ?? '',
            personaMd: memberRow?.personaMd ?? null,
            duty: memberRow?.duty ?? null,
            style: memberRow?.style ?? null,
            skills: memberRow?.skills ?? null,
            rules: memberRow?.rules ?? null,
            executionPrompt: memberRow?.executionPrompt ?? null,
          },
        };
  const display = handbookSeed(view.source);

  const save = async (): Promise<void> => {
    if (draft === null || saving || target.kind !== 'member') return;
    const text = draft.trim();
    if (text === '') {
      setError('手册内容为空');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateMemberPersona(team.teamId, target.name, text);
      setDraft(null);
      setSavedNote(true);
      setTimeout(() => setSavedNote(false), 2500);
      refreshActivitySoon();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const syncToRole = async (): Promise<void> => {
    if (syncing || target.kind !== 'member') return;
    const text = (draft ?? display).trim();
    if (text === '') {
      setError('成员手册为空，先编辑保存');
      return;
    }
    setSyncing(true);
    setError(null);
    try {
      await syncMemberToRoster(team.teamId, target.name, text);
      if (draft !== null) setDraft(null); // 编辑中的草稿已一并落库
      setSyncedNote(true);
      setTimeout(() => setSyncedNote(false), 2500);
      refreshActivitySoon();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" />
          返回团队成员
        </Button>
        <span className="text-lg font-semibold tracking-tight text-foreground">{view.name}</span>
        {target.kind === 'captain' && <span className={ROLE_CHIP_CLASS}>领队</span>}
        {view.status !== null && (
          <Pill tone={memberTone(view.status)}>{STATUS_LABELS[view.status] ?? view.status}</Pill>
        )}
      </div>

      <Card className={cn(PANEL_CARD_CLASS, 'mt-2')}>
        <div className="flex items-center gap-3.5">
          {/* 头像描边环：角色详情页同款（品牌淡底档）。 */}
          <div className="rounded-full border-2 border-solid p-0.5 leading-none border-business-tint">
            <Avatar name={view.name} seed={view.avatar?.seed} salt={view.avatar?.salt} size={52} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-lg font-semibold tracking-tight text-foreground">{view.name}</div>
            <div className={cn(MUTED_CLASS, 'mt-0.5')}>
              {view.employeeId !== null ? `${view.employeeId} · ` : ''}
              {view.role}
              {target.kind === 'captain' ? ' · 不接任务：负责拆解、指派与调度' : ''}
            </div>
            {target.kind === 'member' && (
              <div className={cn(MUTED_CLASS, 'mt-0.5')}>
                详情独立于角色库：加入团队时复制了一份，可编辑后同步回去
              </div>
            )}
          </div>
          {target.kind === 'member' && onOpenReports !== undefined && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenReports(view.name)}
            >
              汇报记录
            </Button>
          )}
        </div>
      </Card>

      <Card className={cn(PANEL_CARD_CLASS, 'mt-2')}>
        <div className={cn(SECTION_TITLE_CLASS, 'flex items-center gap-2')}>
          <span className="flex-1">
            {target.kind === 'captain' ? '领队手册（Markdown）' : '成员手册（Markdown）'}
          </span>
          {target.kind === 'captain' ? (
            <span className={MUTED_CLASS}>领队手册由系统合成，只读</span>
          ) : draft === null ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setError(null);
                  setDraft(display);
                }}
              >
                编辑
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={syncing}
                title="把当前手册写回角色库同名角色（无同名角色时按成员新建）；编辑中的草稿会一并保存"
                onClick={() => void syncToRole()}
              >
                同步到角色
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
                取消
              </Button>
              <Button size="sm" disabled={saving} onClick={() => void save()}>
                保存
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={saving || syncing}
                title="把当前手册写回角色库同名角色（无同名角色时按成员新建）"
                onClick={() => void syncToRole()}
              >
                同步到角色
              </Button>
            </>
          )}
        </div>
        {draft === null ? (
          <>
            <MarkdownText text={display} />
            {savedNote && <div className={cn(MUTED_CLASS, 'mt-1')}>✓ 已保存到成员详情</div>}
            {syncedNote && (
              <div className={cn(MUTED_CLASS, 'mt-1')}>✓ 已同步到角色「{view.name}」</div>
            )}
          </>
        ) : (
          <MdEditor value={draft} onChange={setDraft} minHeight={260} />
        )}
        {error !== null && <FormErrorNote className="mt-2">{error}</FormErrorNote>}
      </Card>
    </div>
  );
}

/** 添加成员弹窗购物车项：角色名 + 已点份数。 */
interface CartItem {
  /** Roster role name（领队不进购物车——单独走恢复开关）。 */
  name: string;
  qty: number;
}

/** 加减步进器按钮样式（添加成员行尾 [−] n [+]）。 */
const STEP_BTN_CLASS =
  'inline-flex h-6 w-6 items-center justify-center rounded-md border border-solid bg-transparent text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40';

/**
 * 加减步进器（用户迭代 2026-09 三添加成员行尾）：− 减一份、＋ 加一份，
 * 中间数字 = 该角色已点份数。＋ 禁用时 title 说明名额口径，按钮不吞点击。
 */
function StepButtons({
  qty,
  onAdd,
  onRemove,
  addDisabled,
  removeDisabled,
  addTitle,
  removeTitle,
}: {
  qty: number;
  onAdd: () => void;
  onRemove: () => void;
  addDisabled: boolean;
  removeDisabled: boolean;
  addTitle: string;
  removeTitle: string;
}): ReactNode {
  return (
    <div className="flex flex-none items-center gap-1.5">
      <button
        type="button"
        aria-label={removeTitle}
        title={removeTitle}
        disabled={removeDisabled}
        className={STEP_BTN_CLASS}
        onClick={onRemove}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="w-5 text-center text-sm font-semibold tabular-nums text-foreground">
        {qty}
      </span>
      <button
        type="button"
        aria-label={addTitle}
        title={addTitle}
        disabled={addDisabled}
        className={STEP_BTN_CLASS}
        onClick={onAdd}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * 添加成员弹窗（用户迭代 2026-09 三）：一行一个角色 + 加减步进器——每行
 * 行尾 [−] n [+]，＋ 加一份、－ 减一份（同一角色可加多份，第二份起自动
 * -2/-3 后缀并照抄角色库默认值）；弹窗底部给出已选人数与成员名额口径
 * （上限 = memberCap，领队不占名额——用户迭代 2026-09 修正：「一个团队
 * 10 个人」指可加 10 名成员）。工号不在此展示也不逐份填写：角色还没加入
 * 成员时没有工号，加入团队时由 host 自动分配（同名角色沿用同一工号）。
 * 领队被移出时菜单首位出现「领队」行，＋ 即加回（不占成员名额）。下单 =
 * 逐个 POST，遇到错误停在原地，已加成功的成员保留在团队里。
 */
function AddMembersDialog({
  open,
  onOpenChange,
  team,
  roster,
  memberCap,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team: TeamSnapshot;
  roster: RosterMember[];
  memberCap: number;
}): ReactNode {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [leaderPicked, setLeaderPicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  // 成员名额（用户迭代 2026-09 修正：领队不占名额）：上限只对成员生效，
  // 「领队」行的 ＋ 加回领队不受它约束。footer 的「成员 N/上限 · 还可加 K」
  // 与看板/团队页的成员计数同口径。
  const occupied = team.members.length;
  const total = cart.reduce((n, c) => n + c.qty, 0);
  const leaderTaken = leaderPicked ? 1 : 0;
  const left = Math.max(0, memberCap - occupied - total);
  const menu = roster.filter((m) => m.name !== LEADER_NAME && m.name !== ROLE_BUILDER_NAME);

  const qtyOf = (roleName: string): number => cart.find((c) => c.name === roleName)?.qty ?? 0;

  /** 第 copy 份的成员名：队里已有 E 个同名时叫 base（E+copy=1）或 base-N。 */
  const copyName = (roleName: string, copy: number): string => {
    const occ = team.members.filter((m) => m.name === roleName).length + copy;
    return occ === 1 ? roleName : `${roleName}-${occ}`;
  };

  const addItem = (roleName: string): void => {
    setError(null);
    setHint(null);
    if (left <= 0) {
      setHint('成员名额已满');
      return;
    }
    // 去重必须在 updater 内判定：同拍连点（快速双击）时外层 qtyOf 是旧值。
    setCart((prev) =>
      prev.some((c) => c.name === roleName)
        ? prev.map((c) => (c.name === roleName ? { ...c, qty: c.qty + 1 } : c))
        : [...prev, { name: roleName, qty: 1 }],
    );
  };

  const removeOne = (roleName: string): void => {
    setCart((prev) =>
      prev
        .map((c) => (c.name === roleName ? { ...c, qty: c.qty - 1 } : c))
        .filter((c) => c.qty > 0),
    );
  };

  const close = (next: boolean): void => {
    onOpenChange(next);
    if (!next) {
      setCart([]);
      setLeaderPicked(false);
      setError(null);
      setHint(null);
    }
  };

  const confirmAdd = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (leaderPicked) await setTeamLeaderRemoved(team.teamId, false);
      for (const item of cart) {
        for (let copy = 1; copy <= item.qty; copy++) {
          const memberName = copyName(item.name, copy);
          await addTeamMember(team.teamId, {
            name: memberName,
            ...(memberName !== item.name ? { sourceName: item.name } : {}),
          });
        }
      }
      close(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // 已加成功的保留；清空购物车避免重名二次报错。
      setCart([]);
      setLeaderPicked(false);
    } finally {
      setBusy(false);
    }
  };

  const rowClass = (active: boolean): string =>
    cn(
      'flex items-center gap-2.5 rounded-xl border border-solid bg-background px-2.5 py-1.5',
      active ? 'border-primary' : BORDER_L1_CLASS,
    );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader className="space-y-1 text-left">
          <DialogTitle>添加成员</DialogTitle>
          <DialogDescription className={MUTED_CLASS}>
            一行一个角色：＋ 加一份、－ 减一份，同一角色可加多份（自动加 -2、-3
            后缀），工号在加入团队时自动分配（这里不展示——角色没加入成员前没有工号）。
          </DialogDescription>
        </DialogHeader>

        {/* 菜单：一行一个角色，行尾加减步进器（名额满时全体 ＋ 禁用）。 */}
        <div className="flex max-h-[300px] flex-col gap-1.5 overflow-y-auto pr-0.5">
          {team.leaderRemoved && (
            <div className={rowClass(leaderPicked)}>
              <Avatar
                name={team.captain.name}
                seed={team.captain.avatar.seed}
                salt={team.captain.avatar.salt}
                size={28}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-foreground">
                  {team.captain.name}
                </div>
                <div className={cn(MUTED_CLASS, 'truncate text-xs')}>
                  领队 · ＋ 加回（不占成员名额）
                </div>
              </div>
              <StepButtons
                qty={leaderPicked ? 1 : 0}
                onAdd={() => {
                  setLeaderPicked(true);
                  setError(null);
                }}
                onRemove={() => {
                  setLeaderPicked(false);
                  setError(null);
                }}
                addDisabled={leaderPicked}
                removeDisabled={!leaderPicked}
                addTitle="加回领队"
                removeTitle="取消加回"
              />
            </div>
          )}
          {menu.map((m) => {
            const qty = qtyOf(m.name);
            return (
              <div key={m.name} className={rowClass(qty > 0)}>
                <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-foreground">{m.name}</div>
                  <div className={cn(MUTED_CLASS, 'truncate text-xs')}>{m.role}</div>
                </div>
                <StepButtons
                  qty={qty}
                  onAdd={() => addItem(m.name)}
                  onRemove={() => removeOne(m.name)}
                  addDisabled={left <= 0}
                  removeDisabled={qty === 0}
                  addTitle={left <= 0 ? '名额已满：成员上限 ' + memberCap + ' 人' : '加一份'}
                  removeTitle="减一份"
                />
              </div>
            );
          })}
          {menu.length === 0 && !team.leaderRemoved && (
            <div className={cn(MUTED_CLASS, 'py-4 text-center text-xs')}>
              角色库还没有可选角色——先到「角色」页新增。
            </div>
          )}
        </div>

        {hint !== null && <div className={cn(MUTED_CLASS, 'text-xs')}>{hint}</div>}
        {error !== null && <FormErrorNote>{error}</FormErrorNote>}

        <div className="flex items-center justify-between gap-2">
          <span className={LIST_COUNT_CLASS}>
            已选 {total + leaderTaken} 人 · 成员 {occupied + total}/{memberCap} · 还可加{' '}
            {Math.max(0, memberCap - occupied - total)} 人
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => close(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy || (total === 0 && !leaderPicked)}
              onClick={() => void confirmAdd()}
            >
              添加成员
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
          {/* D22d：正文主 = foreground（有值）/ meta = muted（空占位）。 */}
          <span className={cn(MUTED_CLASS, value.trim() !== '' && 'text-foreground')}>
            {value.trim() !== '' ? value : '…'}
          </span>
        </div>
      ))}
    </Card>
  );
}

/** 角色（用户反馈：成员更名角色，不再需要标签）：角色库全体条目（先有角色，再组建团队）——列表 / 构建工作台 / 详情。 */
/**
 * 手册骨架的结构来源（用户迭代 2026-09 四）：角色库条目与成员视图共用的
 * 最小字段面——成员视图缺手册（旧成员）时按结构字段合成骨架。
 */
interface HandbookSource {
  name: string;
  role: string;
  personaMd?: string | null;
  duty?: string | null;
  style?: string | null;
  skills?: string | null;
  rules?: string[] | null;
  executionPrompt?: string | null;
}

/**
 * Synthesize a handbook skeleton from the legacy structured fields so nothing
 * is lost when the user first edits a member that predates personaMd (the
 * digest fields themselves are no longer shown — everything lives in the
 * handbook now, 用户反馈 2026-09).
 */
function handbookSeed(member: HandbookSource): string {
  if (typeof member.personaMd === 'string' && member.personaMd.trim() !== '') {
    return member.personaMd;
  }
  const lines = [`# ${member.name}`, '', `- **角色**：${member.role}`];
  const fields: [string, string | null | undefined][] = [
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
.eteams-role-row{background:var(--background);border:1px solid var(--border);box-shadow:0 1px 2px rgba(15,23,42,0.05);transition:background .15s ease,border-color .15s ease,box-shadow .15s ease}
.eteams-role-row:hover{border-color:color-mix(in srgb,var(--foreground) 18%,transparent);background:var(--muted)}
.eteams-team-card{background:var(--background);border:1px solid var(--border);box-shadow:0 1px 2px rgba(15,23,42,0.05);transition:background .15s ease,border-color .15s ease,box-shadow .15s ease}
.eteams-team-card:hover{border-color:color-mix(in srgb,var(--foreground) 18%,transparent);background:var(--muted)}
.eteams-team-card[data-active="true"]{border-color:color-mix(in srgb,var(--primary) 50%,transparent);background:var(--business-tint);box-shadow:0 0 0 1px color-mix(in srgb,var(--primary) 20%,transparent)}
.eteams-role-del{padding:3px 10px;font-size:12px;border-radius:6px;border:1px solid var(--border);background:var(--background);color:var(--destructive);cursor:pointer;flex-shrink:0;font-family:inherit;line-height:18px;opacity:0;transition:opacity .15s ease,border-color .15s ease,background .15s ease}
.eteams-role-row:hover .eteams-role-del,.eteams-role-row:focus-within .eteams-role-del{opacity:1}
.eteams-role-del:hover{border-color:var(--destructive);background:color-mix(in srgb,var(--destructive) 6%,transparent)}
.eteams-role-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eteams-team-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 原生 details/summary（构建工作台 ×2，功能性不动）官网化：去 marker +
   「▸」展开指示随 open 旋转；必须带 .eteams-ui 前缀——style 标签按文档流
   注入但 CSS 本身是全局的，无前缀会漏进宿主页面。 */
.eteams-ui details>summary{cursor:pointer;user-select:none;list-style:none}
.eteams-ui details>summary::-webkit-details-marker{display:none}
.eteams-ui details>summary::before{content:'▸';display:inline-block;margin-right:6px;color:var(--muted-foreground);transition:transform .15s ease}
.eteams-ui details[open]>summary::before{transform:rotate(90deg)}
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
            <Button size="sm" disabled={saving} onClick={save}>
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
          {error !== null && <FormErrorNote>保存失败：{error}</FormErrorNote>}
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
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => setView('list')}>
            <ArrowLeft className="h-3.5 w-3.5" />
            返回角色列表
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => activateConversationTab()}
            title="切到会话的对话视图，看命令卡片与进度行"
          >
            <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
            对话页看进度
          </Button>
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
          {(build === null || build.status === 'cancelled') && (
            <div>
              <div className="flex items-center gap-2">
                <span className="inline-flex text-primary">
                  <IconSparkle16 />
                </span>
                <div className={cn(LINE_CLASS, 'font-semibold')}>新增角色 · 角色构建师</div>
                <Pill tone="info">对话式构建</Pill>
              </div>
              {justFilled ? (
                <div>
                  {/* docs/23 S23-3：原 PREFILL_BANNER_CLASS → shadcn Alert
                      （default 变体 + 品牌淡底覆盖）；D22e 品牌档字色改
                      brand-ink token、D22f 官网呼吸感 px-4 py-3 + 14px。 */}
                  <Alert className="mt-2.5 flex items-start gap-2 rounded-[10px] bg-business-tint px-4 py-3">
                    <span className="text-sm font-semibold text-[color:var(--eteams-brand-ink)]">
                      ✓ 已填充到对话输入框
                    </span>
                  </Alert>
                  <CommandChip text={ADD_PEOPLE_TEMPLATE} />
                  {PREFILL_STEPS.map((s, i) => (
                    <div key={s} className={STEP_ROW_CLASS}>
                      <span className={STEP_NUM_CLASS}>{i + 1}</span>
                      <span>{s}</span>
                    </div>
                  ))}
                  <div className={cn(MUTED_CLASS, 'mt-2.5')}>
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
                <summary className="mt-2.5 -mx-2 cursor-pointer select-none rounded-md px-2 py-1.5 text-sm font-semibold text-foreground hover:bg-muted">
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
                    <summary className="-mx-2 mt-1.5 cursor-pointer select-none rounded-md px-2 py-1.5 text-sm font-semibold text-foreground hover:bg-muted">
                      角色手册（可选，Markdown：使命/职责/规则/领域专章/沟通风格/交付标准）
                    </summary>
                    <div className={cn(FORM_ROW_CLASS, 'mt-2')}>
                      <MdEditor value={personaMd} onChange={setPersonaMd} minHeight={220} />
                    </div>
                  </details>
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      size="sm"
                      disabled={name.trim() === '' || role.trim() === ''}
                      onClick={copyCommand}
                    >
                      <IconPlusOutline16 />
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
        <Button type="button" variant="outline" size="sm" onClick={() => setView('list')}>
          <ArrowLeft className="h-3.5 w-3.5" />
          返回角色列表
        </Button>
        <Card className={cn(PANEL_CARD_CLASS, 'mt-2')}>
          <div className="flex items-center gap-3.5">
            {/* 头像描边环（视觉升级）：品牌淡底档（D21b token），柔和不抢戏。 */}
            <div className="rounded-full border-2 border-solid p-0.5 leading-none border-business-tint">
              <Avatar
                name={detail.name}
                seed={detail.avatar?.seed}
                salt={detail.avatar?.salt}
                size={52}
              />
            </div>
            {/* 角色（用户反馈）：不再需要标签——名字即身份，手册即人设。 */}
            <div className="min-w-0 flex-1">
              <div className="text-lg font-semibold tracking-tight text-foreground">
                {detail.name}
              </div>
              <div className={cn(MUTED_CLASS, 'mt-0.5')}>
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
              onClick={() => {
                setView('add');
              }}
            >
              待加入角色
            </Button>
          ) : (
            <Button
              size="sm"
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
              <IconPlusOutline16 />
              新增角色
            </Button>
          )}
        </div>
        {listError !== null && <FormErrorNote>{listError}</FormErrorNote>}
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
                      <span className="eteams-role-name block max-w-full text-sm font-semibold text-foreground">
                        {m.name}
                      </span>
                      {teamNames.length > 0 && (
                        <div className={cn('eteams-role-name', MUTED_CLASS, 'mt-0.5')}>
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
            {/* D22e 任务页组头降噪：彩 pill → 中性文字 + 计数 + 彩色 6px dot。 */}
            <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold leading-6 text-foreground">
              <span className={dotClass(group.tone)} />
              {group.label}
              <span className="text-xs font-normal text-muted-foreground">· {rows.length}</span>
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
                      {t.retryCount > 0 ? ` · 重试 ${t.retryCount}` : ''}
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
