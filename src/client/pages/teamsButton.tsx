/**
 * The 团队 button in the composer tool row (`conversation.input.right`).
 *
 * The popup is a small tabbed card — 团队 | 角色 — listing the session's
 * teams (live, via the shared activity monitor) and the role library
 * (roster), with one creation shortcut pinned to the footer of each tab:
 *
 * - 「＋ 新增团队」 jumps straight to the 团队 page (the team card grid on the
 *   real host tab when visible, on the full-page 团队页 otherwise) — 创建不自开
 *   弹窗，走页头「＋ 新增团队」按钮（用户反馈 2026-09）；
 * - 「＋ 新增角色」 jumps to the 角色 list page (roster) and does NOT touch
 *   the composer draft — prefilling is the roster add page's own explicit
 *   「填充」 action (用户 2026-09-15「不应该填充才对」；同日「改成跳到角色列表
 *   页面」——不再直落新增工作台).
 *
 * Role rows are selectable: the selected role's avatar + name
 * (or the team's chip + name) replace the button label, highlighted while a
 * selection is active, with a hover-revealed × to clear. For a role the
 * host asserts a system-prompt persona band for the session (per-assembly
 * dynamic section keyed by the session agent) so the conversation speaks as
 * that role — no draft text, nothing sent. For a team the host asserts the
 * 团队绑定 band (docs/26: conversation task workflow, led by the captain or
 * by the main window when the leader is removed). Selections persist per
 * session in localStorage. 团队对话锁定（用户迭代 2026-09-10「对话固定为
 * 团队对话，1 个主对话只能有 1 个团队」）：团队面改为**常驻锁定**——替代
 * 2026-09-07 的一次性选择（发送后清空）语义：选中团队后按钮恒显该团队
 * 徽章（发送不清空），且不能再点击打开 团队/角色 弹层（只读徽章）；宿主
 * 绑定常驻，换队 POST 被 409 拒。用户迭代 2026-09-13「开始对话后才不能
 * 修改」：锁定判据从「选中即锁」放宽为「**对话已开始**才锁」——会话快照
 * blank 位为 true（首条消息发出前）时徽章仍可点击换队，宿主换队守卫同判据
 * 放行。唯一逃生口 = 绑定的团队被删除：轮询快
 * 照里队伍消失（fetchedAt 已落地）即自动解锁——徽章置灰可点、弹层顶部
 * 提示重选；挂载对账以宿主 GET /session-team 为真相源（本地镜像兜底重
 * 申）。角色面不随发送清空。 Clicking the button ALWAYS toggles this popup
 * (opened on the tab matching the selection) — panel navigation stays with
 * the 新增 shortcuts — except the locked badge, which never opens it.
 *
 * S11 样式迁移（docs/21-client-ui-stack.md 21.6 / D19b/D19c/D19g）：弹层与
 * 按钮面的 inline style 与手写注入样式表（POPUP_CSS）全部迁到 Tailwind 类 +
 * shadcn 基础件（Card 承载弹层卡）。落地注记（沿用 S5 card 试点模式）：
 * - D19b 作用域机制：`important: '.eteams-ui'` 把工具类编译成后代选择器
 *   （`.eteams-ui .utility`）——作用域根元素自身不承样式。表面根（composer
 *   锚点 div）挂 `.eteams-ui`；其 display/align 是宿主工具行里的承重布局
 *   （宿主 .trailing 容器无法在此证实为 flex），保留 inline style，S14 清点
 *   时再定。
 * - 弹层 portal 到 body，不在表面根子树里 → 弹层自带 `.eteams-ui` 包裹根，
 *   Card 作为其后代承载全部样式；Card 根 className 同样带 `eteams-ui` 字面量
 *   （content 扫描与 D19b「表面根挂类」双保险，S5 先例）。
 * - 原 POPUP_CSS 的 :hover / [data-selected] 规则改为 `hover:*` /
 *   `data-[selected=true]:*` 变体（完整字面量，content 扫描可检出）；交互动
 *   激活底色无语义 token，走任意值直引（D19c：token 色禁 /alpha 修饰）。
 * - 边框沿用原 border-l1 档（shadcn --border 桥的是 l2），任意值直引保持
 *   视觉；preflight 已关，`border-solid` 显式补边框样式（S3 桥只补默认色）。
 * - 行为与桥接（点击开合、外点/Esc 关闭、rAF 跟随定位、persona 同步、心跳、
 *   data-eteams 标记）逐字保留；heroTeamsButton.ts 的 `.eteams-hero-btn`
 *   注入样式不在本文件、未触碰。
 *
 * M6 结构性改造（docs/44 44.3，行为零变更）：44.3 横幅分区（类型 → 样式类
 * → 常量与映射表 → 工具函数 → 子组件 → 主组件，主组件 TeamsButton 置末）。
 * 弹层 tab/视图查表化：页脚新增钮两 tab 逐字同文收编 TAB_ACTION_META（label
 * 入表、回调按键选取）；团队 tab 空态两态收编 TEAM_EMPTY_META（M5
 * EMPTY_FOOTNOTE_META 同模式，错误串运行时值消费位拼接）；tab 触发器两处
 * 逐字同文类名收编 POPUP_TAB_TRIGGER_CLASS；触发钮 hover 清除钮两处逐字
 * 同文收编 ClearButton 子组件。EMPTY_CLASS 与 shared 的同名常量
 * 异值（M8 平铺收口易混）——改局部命名 POPUP_EMPTY_CLASS，类值逐字不变。
 *
 * 子代理身份面（用户迭代 2026-09-10「子代理隐藏团队按钮」）：已寻址子代理
 * 会话不再提供 团队/角色 选择——门控读标准座位 kit 的会话快照 `subagent`
 * 面（InputBar/子会话模型徽章同款判定，kit 缺席落 ctx.sessions 探测兜底，
 * sessionModelBadge 同款逐轴择源）。门控内两分支：eteams 自己的子代理
 * （成员/领队/构建师，宿主 GET /session-identity 按磁盘真相解析）渲染
 * **只读身份面**——头像 + 名字，无清除钮、点击无弹层（子代理身份不可选、
 * 不可换、不可绑）；无关子代理与身份失效（离职截断）会话**整个按钮隐藏**
 * （加载期同样不渲染——子代理会话上绝不闪出可交互按钮）。主会话完全不受
 * 影响：选择/锁定/弹层交互照旧；persona/团队恢复对账在子代理会话一律跳过
 * （那是主会话语义）。
 *
 * 团队徽章 hover（用户迭代 2026-09-12「团队徽章 hover 显示当前正在执行的任务
 * 和人员」）：锁定徽章挂 shadcn Tooltip（原 vendor 预留件首次启用，Content 改
 * bg-popover 弹层卡签名），面板列执行中任务逐行「头像 + 执行人 + 任务主题」；
 * 无执行中任务时显示阶段文案（创建中 / 正在调度成员 / 等待中…，**领队不列入**）。
 * 摘要口径在 lib/teamBadgeSummary 纯函数（单测锁定），本文件只做渲染接线。
 *
 * @module dsh-eteams/client/teamsButton
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Provider } from 'react-redux';
// lucide 深层图标导入（dialog.tsx 先例：深层 .mjs 只进用到的图标）。
import Check from 'lucide-react/dist/esm/icons/check.mjs';
import Plus from 'lucide-react/dist/esm/icons/plus.mjs';
import Search from 'lucide-react/dist/esm/icons/search.mjs';
import { captureInputActions } from '../lib/addPeople';
import { activateConversationTab } from '../lib/bridge';
import { ClientErrorBoundary, recordClientDiag } from '../lib/diagnostics';
import { enterTeamsPanel } from './teamsPanel';
import {
  clearSessionPersona,
  clearSessionTeam,
  fetchRoster,
  fetchSessionIdentity,
  fetchSessionTeam,
  reportPresence,
  setSessionPersona,
  setSessionTeam,
  type RosterMember,
  type SessionIdentity,
} from '../lib/api';
import { useActivityMonitor, type TeamSnapshot } from '../lib/monitor';
import { anchoredMainTaskOf, sessionMembersOf, teamBadgeSummary } from '../lib/teamBadgeSummary';
import { getApp } from '../store/app';
import { Avatar } from '../features/avatar/avatar';
import { cn } from '../lib/cn';
import { errorMessageOf } from '../lib/errors';
import {
  canOpenSession,
  isAddressedSubagentSession,
  openSession,
  rootSessionIdOf,
} from '../lib/sessionState';
import { subagentFaceMode, subagentFaceTitle } from '../lib/subagentFace';
import { matchesQuery } from '../lib/text';
import { TaskIdBadge, TaskStatusPill } from './shared/components';
import { BORDER_L1_CLASS, LIST_COUNT_CLASS, MUTED_CLASS, TEAM_CHIP_CLASS } from './shared/styles';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';

/** ================================== 类型 ================================== */

/**
 * 标准座位入参（SessionStandardProps 契约的结构化投影）：框架随每个
 * session 作用域槽位组件下发 `sessionId`（会话 id 直传 prop）与 `useSession`
 * （会话快照选择器——子代理门控判定用，InputBar/子会话模型徽章同款读取），
 * owner 不传任何东西——故全部可选。`inputActions` 是 conversation 输入域
 * 专属的既有 prop——本按钮只用它登记捕获桥（整页团队页「填充」的写路兜底），
 * 弹层自己不再写草稿。曾有 `useSession`
 * 在途选择器（2026-09-07 一次性选择的发送清空沿检测）——锁定语义下选择
 * 常驻已随该语义移除；本员随子代理身份面（用户迭代 2026-09-10）以标准
 * 座位身份回归，与当年用途无关。
 */
interface TeamsButtonProps {
  readonly sessionId?: string;
  readonly inputActions?: { setDraft: (text: string) => void };
  readonly useSession?: <S>(
    selector: (
      snapshot: { subagent?: SubagentFace | null; blank?: boolean } | undefined,
    ) => S,
  ) => S;
}

/**
 * 会话快照里子代理门控只关心的员（ConversationSnapshot.subagent 的结构化
 * 投影——null/undefined = 普通会话传输，非空对象 = 已寻址子代理会话；
 * InputBar/子会话模型徽章同款判定）。
 */
type SubagentFace = { readonly address?: unknown };

/** ================================== 样式类 ================================== */

/* 原 POPUP_CSS 手写样式表的三态规则迁成变体类（inline style 无法表达
:hover，Tailwind 变体可以——样式表随之删除）：
- 行默认透明底：`<button>` 带 UA 背景，必须显式压住（原样式表同款理由）；
- hover 底 = 交互悬停（--muted 桥即 interactive-bg-hover，同一宿主变量）；
- 选中底 = 品牌淡底 + 品牌字（S24-2 D22e 品牌档：bg-business-tint +
  brand-ink token；与 hover 同特异性时按产物源序 data-[selected] 靠后
  取胜，等同原样式表的规则先后）；
- preflight 已关：UA 字体/背景的显式覆盖逐项保留（[font-family:inherit]、
  bg-transparent），视觉与迁移前一致；字号档对齐 S24-2（13px→14px 正文、
  11px→12px meta）。 */
const ROW_CLASS =
  'flex w-full cursor-pointer items-center gap-2 rounded-[8px] border-none bg-transparent px-[9px] py-[7px] text-left text-sm text-foreground [font-family:inherit] hover:bg-muted data-[selected=true]:bg-business-tint data-[selected=true]:text-[color:var(--eteams-brand-ink)]';
const ROW_NAME_CLASS = 'min-w-0 truncate font-medium';
const ROW_META_CLASS = 'ml-auto shrink-0 text-xs text-muted-foreground';
/* 选中勾（用户迭代 2026-09-07：已选文案换成有颜色的勾）——品牌主色，ml-auto
   与原 meta 同位。 */
const ROW_CHECK_CLASS = 'ml-auto h-4 w-4 shrink-0 text-primary';
/* 弹层搜索框（用户迭代 2026-09-07：tab 下加搜索框，按当前 tab 过滤列表）——
   官网 Quick search 签名（S24-2，rail 同款）缩窄为弹层档：h-8、13px。 */
const POPUP_SEARCH_CLASS =
  'h-8 rounded-md border-0 pr-3 pl-7 text-[13px] leading-6 text-foreground outline-none [font-family:inherit] ring-1 ring-[color:var(--eteams-pill-bg)] focus-visible:ring-2 focus-visible:ring-sky-500/60';
/* M6 局部重命名（EMPTY_CLASS → POPUP_EMPTY_CLASS）：shared 有同名
   EMPTY_CLASS 而两处类值不同（M8 平铺收口易混）——本文件类值逐字不变。 */
const POPUP_EMPTY_CLASS = 'px-2.5 py-3.5 text-center text-xs text-muted-foreground';
const ERR_CLASS = 'px-2.5 pb-2 pt-1 text-xs text-destructive';
const HINT_CLASS = 'px-2.5 pb-0.5 pt-1.5 text-xs leading-normal text-muted-foreground';

/* 弹层卡体（原 S.card）：bg/background、文字色走语义 token；边框 S24-2 收敛
   语义 token --border（官网 slate-200/slate-800）；阴影逐字保留原 T.shadow。
   （M7-11 同值异名归一：POPUP_BORDER_CLASS 改引 shared 的
   BORDER_L1_CLASS——本件为 pages 根层，下引 teamsView 同层共享件允许。） */
const POPUP_BORDER_CLASS = BORDER_L1_CLASS;
/* 底部锚定（D26-1）的高度链：卡片 inline maxHeight（视口护栏）→ Tabs
   flex-1 min-h-0 → 列表 min-h-0——空间不足时列表收缩内部滚动，卡片顶边
   不出视口。max-h-[260px] 保留（正常场景列表自身封顶）。 */
const LIST_CLASS =
  'flex min-h-0 max-h-[260px] flex-col gap-0.5 overflow-x-hidden overflow-y-auto p-1.5 pt-2';
/* D25：tab 头自身不再画分割线（早前 border-b 与 footer border-t 形成重复），
   列表与 tab 头之间由 tab 下划线自然收边，仅 footer 保留一条 border-t。 */
const FOOTER_CLASS = `flex border-t border-solid p-1.5 ${POPUP_BORDER_CLASS}`;
/* docs/23 S23-4：原 TAB_HEADER_CLASS/tabBtnClass（手写 tab 头）迁移 shadcn
   Tabs 分段控件、原 ACTION_CLASS（虚线新增钮）迁移 shadcn Button outline
   dashed 档——常量删除，使用位内联。（M6 分区：两处逐字同文的
   TabsTrigger 类名再收编 POPUP_TAB_TRIGGER_CLASS，字面量原样。） */
const POPUP_TAB_TRIGGER_CLASS =
  '-mb-px flex-1 rounded-none border-0 border-b-2 border-solid border-transparent bg-transparent px-0 pb-2 pt-2.5 text-sm leading-6 font-medium shadow-none ring-offset-0 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-primary data-[state=active]:shadow-none hover:text-foreground';

/* 按钮选中面（原 S.faceName/S.teamChip 与 `.eteams-teams-clear` 迁移）：
清除钮 16×16、默认隐藏、hover 按钮时显形（`group-hover` 搭配触发钮上的
`group`），自身 hover 换交互悬停底与主文字色——逐条对应原样式表。过渡时长
不用 duration 任意值（时间长度类同时匹配 transition/animation 两个工具、
属歧义候选不产 CSS），改用任意属性 shorthand，逐字对应原 `transition:opacity .12s`。
团队首字 chip 面收编 shared/styles 的 TEAM_CHIP_CLASS（M7-11 同值异名归一
——团队列表卡标题复用同一常量，两处视觉由构造一致）。 */
const FACE_ROW_CLASS = 'inline-flex items-center gap-1.5';
const FACE_NAME_CLASS = 'max-w-[120px] truncate font-medium';
const CLEAR_BUTTON_CLASS =
  'inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-transparent p-0 text-sm leading-none text-muted-foreground opacity-0 [transition:opacity_120ms] group-hover:opacity-100 hover:bg-muted hover:text-foreground';

/* 子代理身份面（用户迭代 2026-09-10）：沿用触发钮选中面的胶囊观感（同档
   高/字号/内距，品牌淡底 + 品牌字），去掉 group/hover 与清除钮——子代理
   会话上没有可选可清的东西，脸面是纯只读标识。用户 2026-09-14「弹出卡片的
   徽章要有手型光标」：它是 hover 卡（TeamTaskHoverCard）的触发目标，取
   cursor-pointer（preflight 关，Button/span 默认是箭头）。 */
const IDENTITY_FACE_CLASS =
  'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-none bg-business-tint px-2.5 text-[13px] leading-[18px] font-medium text-primary';

/* 团队徽章 hover 面板（用户迭代 2026-09-12）：锁定徽章悬浮显示任务信息。
   覆盖 TooltipContent 默认深色小气泡（bg-primary/text-primary-foreground/text-xs/
   px-3 py-1.5）为弹层卡签名（bg-popover + --border 细线 + shadow-md，与
   PopoverContent 同档）——cn 的 tailwind-merge 按组去重，后写覆盖。用户
   2026-09-14「卡片做高一点」：宽度上限放宽（260 → 320px），卡体由内容撑高。 */
const BADGE_HOVER_CLASS =
  'w-max max-w-[320px] rounded-lg border border-solid border-[color:var(--border)] bg-popover px-2.5 py-2 text-popover-foreground shadow-md';

/* 会话成员 chip（用户 2026-09-14「加一个会话成员，点击进入已经有会话的成员
   会话中」）：hover 卡内可点击切换会话的小胶囊。当前所在会话走高亮底（品牌
   淡底 + 品牌字，与触发钮选中面同档）。 */
const SESSION_CHIP_CLASS = `inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-solid px-2 py-0.5 text-xs text-foreground hover:bg-muted ${BORDER_L1_CLASS}`;
const SESSION_CHIP_ACTIVE_CLASS = 'bg-business-tint text-[color:var(--eteams-brand-ink)]';

/** ================================== 常量与映射表 ================================== */

/** 团队 tab 空态两态查表（M6，M5 boardTab EMPTY_FOOTNOTE_META 同模式）：
 * 尚未建团队整句 / 状态加载失败前缀。错误支的原始错误串是运行时值，表存
 * 字面量件、消费位拼接（条件式只选组装形态）；两支文案与收编前逐串一致。 */
const TEAM_EMPTY_META: Record<'error' | 'noTeam', string> = {
  error: '状态加载失败：',
  noTeam: '还没有团队',
};

/** 弹层页脚新增钮两 tab 查表（M6）：outline dashed 档两处逐字同文（variant/
 * size/类名/Plus 图标，见 S23-4 注记），仅 label 随 tab 切换——label 收表，
 * 回调由消费位按键选取（addTeam/addMember）。 */
const TAB_ACTION_META: Record<'team' | 'member', { label: string }> = {
  team: { label: '新增团队' },
  member: { label: '新增角色' },
};

/** ================================== 工具函数 ================================== */

/* 显隐决策与 tooltip 文案在 lib/subagentFace（纯函数独立成模块，node 单测
 * 锁语义——teamsButton 本体带着 UI 依赖链，测试拉不动），此处直接取用。 */

/* Selection persistence (per session, guarded). */

const memberKey = (sessionId: string | undefined): string =>
  `eteams:selected-member:${sessionId ?? 'global'}`;
const teamKey = (sessionId: string | undefined): string =>
  `eteams:selected-team:${sessionId ?? 'global'}`;

function loadSelectedMember(sessionId: string | undefined): RosterMember | null {
  try {
    const raw = localStorage.getItem(memberKey(sessionId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as RosterMember;
    return typeof parsed?.name === 'string' && parsed.name !== '' ? parsed : null;
  } catch {
    return null;
  }
}

function saveSelectedMember(sessionId: string | undefined, member: RosterMember | null): void {
  try {
    if (member === null) localStorage.removeItem(memberKey(sessionId));
    else localStorage.setItem(memberKey(sessionId), JSON.stringify(member));
  } catch {
    // 无 localStorage 时静默（会话内仍生效）
  }
}

function forgetSelectedMember(sessionId: string | undefined): void {
  try {
    localStorage.removeItem(memberKey(sessionId));
  } catch {
    // 静默
  }
}

function loadSelectedTeam(sessionId: string | undefined): { teamId: string; name: string } | null {
  try {
    const raw = localStorage.getItem(teamKey(sessionId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { teamId?: unknown; name?: unknown };
    return typeof parsed?.teamId === 'string' &&
      parsed.teamId !== '' &&
      typeof parsed?.name === 'string'
      ? { teamId: parsed.teamId, name: parsed.name }
      : null;
  } catch {
    return null;
  }
}

function saveSelectedTeam(
  sessionId: string | undefined,
  team: { teamId: string; name: string } | null,
): void {
  try {
    if (team === null) localStorage.removeItem(teamKey(sessionId));
    else localStorage.setItem(teamKey(sessionId), JSON.stringify(team));
  } catch {
    // 静默
  }
}

function forgetSelectedTeam(sessionId: string | undefined): void {
  try {
    localStorage.removeItem(teamKey(sessionId));
  } catch {
    // 静默
  }
}

/** ================================== 子组件 ================================== */

/** 触发钮选中面的 hover 清除钮（M6 收编：角色面/团队面两处逐字同文——
 * 16×16 默认隐形 hover 显形，stopPropagation 防止触发钮开合，样式见
 * CLEAR_BUTTON_CLASS 注记）；两处回调同为 clearSelection，经 props 注入。 */
function ClearButton({ onClear }: { onClear: () => void }): ReactNode {
  return (
    <span
      className={CLEAR_BUTTON_CLASS}
      role="button"
      aria-label="取消选择"
      title="取消选择"
      onClick={(event) => {
        event.stopPropagation();
        onClear();
      }}
    >
      ×
    </span>
  );
}

/**
 * 子代理身份面（用户迭代 2026-09-10）：eteams 自己的子代理会话（成员/领队/
 * 构建师）在输入栏渲染的只读脸面——头像 + 名字，无清除钮、点击无弹层
 * （子代理身份不可选、不可换，团队/角色 绑定对子代理会话不成立）。数据来自
 * 宿主 GET /session-identity 的磁盘真相（任务副本行 / 领队副本行 / 构建会话
 * 文件），身份由插件指派而不是用户选择——脸面因此纯展示。
 *
 * 用户 2026-09-14「子对话中的团队弹窗也要出现同样的卡片」：身份脸面（hover
 * 目标）挂与主对话锁定徽章同款的 TeamTaskHoverCard——按身份 teamId 定位队伍、
 * 按本会话（上溯主对话）解析锚定主任务；无队伍（构建师 / 快照未落地）时退回
 * 原生 title 兜底。
 */
function SubagentIdentityFace({
  identity,
  sessionId,
}: {
  identity: SessionIdentity;
  sessionId: string | undefined;
}): ReactNode {
  const state = useActivityMonitor();
  const team =
    identity.teamId !== null ? state.teams.find((t) => t.teamId === identity.teamId) : undefined;
  const face = (
    <span
      className={IDENTITY_FACE_CLASS}
      title={team === undefined ? subagentFaceTitle(identity) : undefined}
    >
      <Avatar
        name={identity.name}
        seed={identity.avatar?.seed}
        salt={identity.avatar?.salt}
        size={18}
      />
      <span className={FACE_NAME_CLASS}>{identity.name}</span>
    </span>
  );
  if (team === undefined) return face;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{face}</TooltipTrigger>
      <TooltipContent side="top" className={BADGE_HOVER_CLASS}>
        <TeamTaskHoverCard team={team} sessionId={sessionId} />
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * 团队徽章 hover 面板（用户迭代 2026-09-12「团队徽章 hover 显示当前正在执行的
 * 任务和人员」）：执行中任务逐行「头像 + 执行人 + 任务主题」；无执行中任务时
 * 显示当前阶段文案（创建中 / 正在调度成员 / 等待中…）。摘要口径见
 * lib/teamBadgeSummary（纯函数、单测锁定；领队不列入）。
 */
function TeamBadgeHover({
  team,
  captainName,
}: {
  team: TeamSnapshot;
  captainName: string;
}): ReactNode {
  const summary = teamBadgeSummary(team, captainName);
  if (summary.executing.length === 0) {
    return <span className="text-xs text-muted-foreground">{summary.statusLine}</span>;
  }
  // 执行人头像取成员行（assignee 是成员名；查不到则 Avatar 走首字兜底）。
  const avatarByName = new Map(team.members.map((m) => [m.name, m.avatar]));
  return (
    <div className="flex flex-col gap-1.5">
      {summary.executing.map((row) => {
        const avatar = avatarByName.get(row.member);
        return (
          <div key={row.taskId} className="flex items-center gap-2">
            <Avatar name={row.member} seed={avatar?.seed} salt={avatar?.salt} size={18} />
            <span className="shrink-0 text-xs font-medium text-foreground">{row.member}</span>
            <span className="max-w-[150px] truncate text-xs text-muted-foreground">
              · {row.subject}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 会话成员 chip（用户 2026-09-14「加一个会话成员，点击进入已经有会话的成员
 * 会话中，并将主会话也加进去」）：头像 + 名字，点击让宿主把该会话选为当前
 * （openSession），并把视图标签切回「对话」——用户 2026-09-14「点击之后 tab
 * 切换到对话去」：只切会话不切标签时，用户可能仍停在「团队」标签上、看不到
 * 刚进的对话。仅在会话列表里（canOpenSession）时由调用方渲染——composer 表面
 * 没挂 Toaster，点了没反应等于静默 no-op，故按任务页「跳转会话」钮同为门控
 * 渲染；当前所在会话高亮（品牌淡底）。
 */
function SessionMemberChip({
  name,
  avatar,
  sessionId,
  active,
}: {
  name: string;
  /** 主会话无成员头像，传 null 只显文字。 */
  avatar: { seed: number; salt: number } | null;
  sessionId: string;
  active: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      title={`切换到「${name}」会话`}
      className={cn(SESSION_CHIP_CLASS, active ? SESSION_CHIP_ACTIVE_CLASS : null)}
      onClick={() => {
        if (!openSession(sessionId)) return;
        // 会话切换会重挂宿主的视图标签环——延后一帧再点「对话」标签，避免点到
        // 正在卸载的旧节点（一次性延后，非轮询/重试）。
        window.requestAnimationFrame(() => {
          activateConversationTab();
        });
      }}
    >
      {avatar !== null && <Avatar name={name} seed={avatar.seed} salt={avatar.salt} size={18} />}
      <span className="max-w-[120px] truncate">{name}</span>
    </button>
  );
}

/**
 * 团队徽章 hover 主体（用户 2026-09-14「已创建团队任务的 hover 弹层里放本
 * 会话锚定的主任务卡片」）：卡片参考任务列表小卡——编号徽章 + 主题（头行）、
 * 「共 N 个任务，已完成 X，未完成 Y」（进度行）、底栏状态 pill；另加「会话
 * 成员」一栏（主会话 + 有子会话的成员，点击切换）与右下角「去任务」钮
 * （enterTeamsPanel 落任务详情页）。锚定任务取不到（刚绑定 / 尚无任务）时
 * 退回原摘要（TeamBadgeHover：执行中任务 / 阶段文案），旧观感不丢。
 *
 * sessionId 传本会话 id；已在子代理会话时先经 rootSessionIdOf 上溯到主对话
 * 再比对任务锚（任务行 main_session_id 登记的是主对话快照）。
 */
function TeamTaskHoverCard({
  team,
  sessionId,
}: {
  team: TeamSnapshot;
  sessionId: string | undefined;
}): ReactNode {
  // 任务锚按会话树根解析（任务行 main_session_id 登记的是主对话快照）；会话
  // 成员高亮按**当前真实会话**比对——子对话里上溯出的主会话不该被点亮。
  const current = rootSessionIdOf(sessionId) ?? sessionId ?? null;
  const activeSessionId = sessionId ?? null;
  const task = anchoredMainTaskOf(team, current ?? undefined);
  if (task === undefined) {
    return <TeamBadgeHover team={team} captainName={team.captain.name} />;
  }
  const subs = team.tasks.filter((t) => t.parentId === task.taskId);
  const done = subs.filter((t) => t.status === 'completed').length;
  const mainSession = task.sessionId ?? null;
  const chips: ReactNode[] = [];
  if (mainSession !== null && canOpenSession(mainSession)) {
    chips.push(
      <SessionMemberChip
        key="main"
        name="主会话"
        avatar={null}
        sessionId={mainSession}
        active={activeSessionId === mainSession}
      />,
    );
  }
  for (const member of sessionMembersOf(task)) {
    if (!canOpenSession(member.sessionId)) continue;
    chips.push(
      <SessionMemberChip
        key={member.sessionId}
        name={member.name}
        avatar={member.avatar}
        sessionId={member.sessionId}
        active={activeSessionId === member.sessionId}
      />,
    );
  }
  return (
    <div className="flex w-[300px] flex-col gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <TaskIdBadge taskId={task.taskId} />
        <div className="truncate text-sm font-semibold text-foreground" title={task.subject}>
          {task.subject}
        </div>
      </div>
      <div className={LIST_COUNT_CLASS}>
        共 {subs.length} 个任务，已完成 <span className="text-success">{done}</span>，未完成{' '}
        <span className="text-warning">{subs.length - done}</span>
      </div>
      {chips.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className={MUTED_CLASS}>会话成员</div>
          <div className="flex flex-wrap gap-1.5">{chips}</div>
        </div>
      )}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-solid pt-2">
        <TaskStatusPill status={task.status} retryCount={task.retryCount} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="cursor-pointer"
          onClick={() => {
            enterTeamsPanel({ taskId: task.taskId });
          }}
        >
          去任务
        </Button>
      </div>
    </div>
  );
}

/**
 * 触发钮面（团队对话锁定，用户迭代 2026-09-10）：渲染在 Provider 子树内
 * （useActivityMonitor 需 store context），按选中面三分支——
 * - 角色面：头像 + 名字 + hover 清除钮（行为不变）；
 * - 团队锁定面（快照里队伍健在）：chip + 队名，**只读**——无清除钮、点击
 *   不弹层（1 个主对话只能有 1 个团队，不能切换 团队/角色）；
 * - 团队失联面（快照已落地但队伍不在列表 = 已删除）：同一张脸置灰，恢复
 *   可点（解锁逃生口）——弹层自算同判据（state 现成）在团队 tab 顶部提示
 *   重选。
 * 失联判定门槛 `fetchedAt !== 0`：轮询首帧未落地前不判（快照空列表≠无团队），
 * 避免挂载瞬间解锁闪烁。
 * 用户迭代 2026-09-12：锁定且队伍在快照里时挂 Tooltip 显示执行中任务+人员
 * （TeamBadgeHover）；原生 title 让位给富面板（失联/未落地分支仍用 title 兜底）。
 * 用户 2026-09-14「已创建团队任务的 hover 弹层放本会话锚定的主任务卡片 + 会话
 * 成员 + 去任务」：富面板改由 TeamTaskHoverCard 承担（无锚定任务时内部退回
 * TeamBadgeHover）。
 */
function TeamsTriggerButton(props: {
  selectedMember: RosterMember | null;
  selectedTeam: { teamId: string; name: string } | null;
  /** 对话是否已开始（快照 blank 取反）——未开始时锁定不成立（用户迭代
   * 2026-09-13「开始对话后才不能修改」：选中团队后到首条消息前仍可点击换队）。 */
  conversationStarted: boolean;
  /** 本会话 id（hover 卡据它解析本会话锚定的主任务）。 */
  sessionId: string | undefined;
  open: boolean;
  onButtonClick: () => void;
  onClear: () => void;
}): ReactNode {
  const state = useActivityMonitor();
  const teamGone =
    props.selectedTeam !== null &&
    state.fetchedAt !== 0 &&
    !state.teams.some((t) => t.teamId === props.selectedTeam!.teamId);
  const locked = props.selectedTeam !== null && props.conversationStarted && !teamGone;
  const team =
    props.selectedTeam !== null
      ? state.teams.find((t) => t.teamId === props.selectedTeam!.teamId)
      : undefined;
  const onTriggerClick = (): void => {
    // 锁定徽章不可点击（不能打开 团队/角色 切换弹层）。
    if (locked) return;
    props.onButtonClick();
  };
  const button = (
    <Button
      variant="ghost"
      size="sm"
      className="group h-7 cursor-pointer rounded-full border-none px-2.5 text-[13px] leading-[18px] font-medium normal-case tracking-normal data-[selected=true]:bg-business-tint data-[selected=true]:text-primary"
      data-selected={
        props.selectedMember !== null || props.selectedTeam !== null ? 'true' : undefined
      }
      title={
        props.selectedMember !== null
          ? undefined
          : props.selectedTeam !== null
            ? teamGone
              ? '绑定的团队已删除——点击重新选择'
              : !props.conversationStarted
                ? `已选择团队「${props.selectedTeam.name}」——对话开始前可点击更换`
                : team === undefined
                  ? `本对话已固定为团队「${props.selectedTeam.name}」对话`
                  : undefined
            : undefined
      }
      aria-label="团队"
      aria-haspopup="dialog"
      aria-expanded={props.open}
      onClick={onTriggerClick}
    >
      {props.selectedMember !== null ? (
        <span className={FACE_ROW_CLASS}>
          <Avatar
            name={props.selectedMember.name}
            seed={props.selectedMember.avatar?.seed}
            salt={props.selectedMember.avatar?.salt}
            size={18}
          />
          <span className={FACE_NAME_CLASS}>{props.selectedMember.name}</span>
          <ClearButton onClear={props.onClear} />
        </span>
      ) : props.selectedTeam !== null ? (
        <span className={FACE_ROW_CLASS}>
          <span className={TEAM_CHIP_CLASS} aria-hidden={true}>
            {props.selectedTeam.name.slice(0, 1)}
          </span>
          <span className={cn(FACE_NAME_CLASS, teamGone ? 'text-muted-foreground' : null)}>
            {props.selectedTeam.name}
          </span>
        </span>
      ) : (
        '团队'
      )}
    </Button>
  );
  // 锁定且队伍在快照里才挂 hover 面板——摘要直接来自这份快照。
  if (locked && team !== undefined) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="top" className={BADGE_HOVER_CLASS}>
          <TeamTaskHoverCard team={team} sessionId={props.sessionId} />
        </TooltipContent>
      </Tooltip>
    );
  }
  return button;
}

/**
 * The popup card, portaled to `<body>` (the composer card would crop an
 * in-place surface). It floats ABOVE the trigger with a small gap — the
 * button sits at the bottom of the window, and a below-placement (or a
 * viewport-clamped flip) would cover the 「团队」 label it belongs to.
 * 水平**居中对齐触发钮本身**（用户 2026-09-15「对话里面的团队弹窗居中弹出」，
 * 同日修正「居中……应该根据徽章」）：卡片中心对「团队」按钮（选中态即徽章）的
 * 横向中心——不是整块对话区的中心，也不是右对齐其右缘（旧口径）。
 * Bottom-anchored（`bottom` + `maxHeight`，不用 `top`）：卡片高度与定位解耦，
 * 团队/角色 tab 切换、列表加载只向上长高，位置永不回跳（无闪烁）。
 */
function TeamsPopup(props: {
  anchor: HTMLElement;
  selectedMember: RosterMember | null;
  selectedTeam: { teamId: string; name: string } | null;
  personaError?: string | null;
  onSelectMember: (member: RosterMember) => void;
  onSelectTeam: (team: { teamId: string; name: string }) => void;
  initialTab: 'team' | 'member';
  onClose: () => void;
}): ReactNode {
  const { anchor, selectedMember, selectedTeam, onSelectMember, onSelectTeam, onClose } = props;
  const [tab, setTab] = useState<'team' | 'member'>(props.initialTab);
  // 搜索框（按当前 tab 过滤团队/角色名，大小写不敏感子串）；切 tab 清空——
  // 两个 tab 列表不同，残留关键词只会造成"莫名空列表"。
  const [query, setQuery] = useState('');
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Hand-rolled above-placement: horizontally CENTERED on the trigger badge
  // (the 「团队」 button itself), BOTTOM edge `gap` above that button's top
  // edge, clamped to the viewport. Until the first measurement the panel stays
  // invisible (no flash at 0,0).
  const [pos, setPos] = useState<CSSProperties | null>(null);
  // Anti-flicker positioning（用户反馈：切换 tab/成员时闪一下）：continuous
  // rAF tracking instead of event listeners. Events left gaps — selecting
  // swaps the button face (width change → tool-row reflow), and the old
  // RO/scroll-only approach repositioned a frame late, so the card visibly
  // lagged then snapped. Reading rects per frame with a change-guard keeps
  // the card glued with ZERO re-renders while nothing moves.
  // Bottom-anchored（用户反馈：团队/角色 tab 切换闪一下）：the card is placed
  // with `bottom`, not `top` — its height is decoupled from the position, so
  // a tab switch / roster load only ever grows the card UPWARD and the
  // change-guard short-circuits (no reposition round-trip at all). The old
  // top-anchored scheme needed a full frame for this loop to catch the new
  // offsetHeight, leaving one visible frame where the card dipped over the
  // composer before snapping back.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    let raf = 0;
    let last = '';
    const compute = (): void => {
      const r = anchor.getBoundingClientRect();
      const w = panel.offsetWidth;
      const margin = 8;
      const gap = 6;
      // 水平居中（用户 2026-09-15「对话里面的团队弹窗居中弹出」→「居中……应该
      // 根据徽章」）：卡片中心对齐「团队」触发钮（选中态即徽章）自身的水平中心
      // ——不再右对齐其右缘（旧口径），也不按 composer 容器中心（宿主工具行与
      // 输入域同属整块对话区，取容器中心会跑到整个对话框的中间去）。视口护栏
      // 两条不变，窄窗口下夹在两端。
      const centered = r.left + r.width / 2 - w / 2;
      const left = Math.min(Math.max(centered, margin), window.innerWidth - margin - w);
      const bottom = Math.max(margin, window.innerHeight - r.top + gap);
      // 顶部护栏 = 旧 `top = max(margin, …)` 的等价表达：可用空间不足时收
      // 面板（maxHeight），列表内部滚动——而不是把顶边推出视口。
      const maxHeight = Math.max(160, r.top - gap - margin);
      const key = `${left}|${bottom}|${maxHeight}`;
      if (key === last) return; // no-op guard: no setState, no re-render
      last = key;
      setPos({ left, bottom, maxHeight });
    };
    const loop = (): void => {
      compute();
      raf = requestAnimationFrame(loop);
    };
    compute();
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [anchor]);
  const state = useActivityMonitor();
  // 团队失联（用户迭代 2026-09-10 解锁逃生口）：弹层自算——父层在 Provider
  // 外（无法用 useActivityMonitor），本组件在 Provider 子树内现成有 state。
  // 判定门槛 `fetchedAt !== 0`：轮询首帧未落地前不判（快照空列表≠无团队）。
  const teamDead =
    selectedTeam !== null &&
    state.fetchedAt !== 0 &&
    !state.teams.some((t) => t.teamId === selectedTeam.teamId);
  const [roster, setRoster] = useState<RosterMember[] | null>(null);
  const [rosterError, setRosterError] = useState(false);

  // 角色库列表：打开时拉一次（面板内已有更完整的增删流程，这里只做快照）。
  useEffect(() => {
    let alive = true;
    void fetchRoster()
      .then((members) => {
        if (alive) setRoster(members);
      })
      .catch(() => {
        if (alive) {
          setRoster([]);
          setRosterError(true);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  // 关闭语义：外点 + Escape。面板门户到 body（在触发器根之外），所以这里
  // 手写判断而不能用 useDismissOnOutsidePointer（它只认单一根元素）。
  useEffect(() => {
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (panelRef.current !== null && panelRef.current.contains(target)) return;
      if (anchor.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  /* —— 事件处理 —— */

  const addTeam = (): void => {
    onClose();
    // 落团队页（/team 卡片栅格）：带 team 信号——无信号时面板按 ui.activeNav
    // 恢复上次页签，落不到团队卡片（用户 2026-09-15「点新增团队没有跳到对应
    // 的团队卡片」）。创建仍走页头「＋ 新增团队」按钮，不自开弹窗（用户反馈
    // 2026-09：一进团队页就弹新增弹窗很突兀）。
    enterTeamsPanel({ team: true });
  };

  const addMember = (): void => {
    onClose();
    // 跳角色列表页，不碰输入框草稿（用户 2026-09-15「新增角色不应该自动
    // 填充」）：填充是新增页「AI 创建」里显式点「填充」才做的事。落列表而
    // 非新增工作台（同日「改成跳到角色列表页面」）：新增入口交给列表页头
    // 的「＋ 新增角色」按钮（与「＋ 新增团队」落卡片栅格同款收口）。
    enterTeamsPanel({ roster: true });
  };

  const teams = state.teams;
  const visibleTeams = teams.filter((t) => matchesQuery(t.name, query));
  // roster 为 null（加载中）时取空数组——可空类型无法从 roster 的判断收窄，
  // 恒定数组让下方 JSX 链的"无匹配"分支直接用 length 判断。
  const visibleRoster = (roster ?? []).filter((m) => matchesQuery(m.name, query));
  // 搜索框可见性（用户迭代 2026-09-15「没有团队时不显示上面的搜索」，
  // rosterPage「空列表不渲染搜索框」同款）：当前 tab 无可筛条目即整个撤掉。
  const showSearch = tab === 'team' ? teams.length > 0 : roster !== null && roster.length > 0;

  return (
    /* Portal 作用域根（D19b/S11）：弹层挂在 body 下，不在表面根子树里，
    自带 `.eteams-ui` 包裹，工具类（后代选择器）才作用得到。 */
    <div className="eteams-ui">
      <Card
        ref={panelRef}
        role="dialog"
        aria-label="团队与角色"
        data-eteams="popup"
        className={cn(
          'eteams-ui fixed z-[1000] box-border flex w-[280px] flex-col overflow-hidden border-solid bg-background text-sm shadow-[0_1px_2px_rgba(15,23,42,0.05),0_6px_18px_rgba(15,23,42,0.06)]',
          POPUP_BORDER_CLASS,
          // 首次测量前面板不可见（原 inline visibility:hidden 迁移）。
          pos === null ? 'invisible' : null,
        )}
        style={pos ?? undefined}
      >
        {/* docs/25 D23-7（D25 修订）：tab 头 = 官网 docs 下划线签名——两等半
            （flex-1 居中）、单条分割线（列表自带 border-b，tab 头不再重复）、
            降高（pt-2/pb-2）。激活 = sky 文字 + 同色下划线 + semibold。 */}
        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v === 'member' ? 'member' : 'team');
            setQuery('');
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="h-auto w-full flex-none justify-start gap-0 rounded-none border-0 bg-transparent p-0">
            <TabsTrigger value="team" className={POPUP_TAB_TRIGGER_CLASS}>
              团队{teams.length > 0 ? ` · ${teams.length}` : ''}
            </TabsTrigger>
            <TabsTrigger value="member" className={POPUP_TAB_TRIGGER_CLASS}>
              角色{roster !== null && roster.length > 0 ? ` · ${roster.length}` : ''}
            </TabsTrigger>
          </TabsList>

          {/* 搜索框（rail 官网 Quick search 签名缩窄档）：放大镜绝对定位，
              Input 去 border 改 ring。内层 relative 只包 Input 本体——外层
              pt-2/pb-0.5 不对称，top-1/2 若以外层为基准会整体偏上。 */}
          {showSearch && (
            <div className="flex-none px-1.5 pb-0.5 pt-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="text"
                  value={query}
                  placeholder="搜索"
                  onChange={(e) => setQuery(e.target.value)}
                  className={POPUP_SEARCH_CLASS}
                />
              </div>
            </div>
          )}

          <div className={LIST_CLASS}>
            {tab === 'team' && teamDead && (
              <div className={HINT_CLASS}>绑定的团队已删除——请重新选择团队。</div>
            )}
            {tab === 'team' ? (
              teams.length === 0 ? (
                <div className={POPUP_EMPTY_CLASS}>
                  {state.error !== null
                    ? `${TEAM_EMPTY_META.error}${state.error}`
                    : TEAM_EMPTY_META.noTeam}
                </div>
              ) : visibleTeams.length === 0 ? (
                <div className={POPUP_EMPTY_CLASS}>无匹配结果</div>
              ) : (
                visibleTeams.map((t) => {
                  const isTeamSelected = selectedTeam?.teamId === t.teamId;
                  return (
                    <button
                      key={t.teamId}
                      type="button"
                      className={ROW_CLASS}
                      data-selected={isTeamSelected ? 'true' : undefined}
                      onClick={() => onSelectTeam({ teamId: t.teamId, name: t.name })}
                      // Static title（防闪烁）：切换选中时 title 不变，原生 tooltip
                      // 不会在指针下重弹。
                      title={t.name}
                    >
                      {/* 首字徽章（用户迭代 2026-09-07）：团队 tab 行与角色行
                      的头像同位——同款 TEAM_CHIP_CLASS（与团队列表卡标题、
                      触发钮选中面收编同一常量，视觉由构造一致）。 */}
                      <span className={TEAM_CHIP_CLASS} aria-hidden={true}>
                        {t.name.slice(0, 1)}
                      </span>
                      <span className={ROW_NAME_CLASS}>{t.name}</span>
                      {isTeamSelected ? (
                        <Check className={ROW_CHECK_CLASS} aria-hidden={true} />
                      ) : (
                        <span className={ROW_META_CLASS}>
                          {t.progress.completed}/{t.progress.total} 完成
                        </span>
                      )}
                    </button>
                  );
                })
              )
            ) : roster === null ? (
              <div className={POPUP_EMPTY_CLASS}>角色库加载中…</div>
            ) : roster.length === 0 ? (
              <div className={POPUP_EMPTY_CLASS}>角色库为空——点下方「新增角色」创建。</div>
            ) : visibleRoster.length === 0 ? (
              <div className={POPUP_EMPTY_CLASS}>无匹配结果</div>
            ) : (
              visibleRoster.map((m) => {
                const isSelected = selectedMember?.name === m.name;
                return (
                  <button
                    key={m.name}
                    type="button"
                    className={ROW_CLASS}
                    data-selected={isSelected ? 'true' : undefined}
                    onClick={() => onSelectMember(m)}
                    // Static title（防闪烁）：title 随选中变化会让原生 tooltip
                    // 在指针下重弹一次；角色不再展示标签，名字即身份。
                    title={`${m.name}（点击选中/取消，对话将以该角色输出）`}
                  >
                    <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} size={22} />
                    <span className={ROW_NAME_CLASS}>{m.name}</span>
                    {isSelected && <Check className={ROW_CHECK_CLASS} aria-hidden={true} />}
                  </button>
                );
              })
            )}
            {tab === 'member' && rosterError && (
              <div className={ERR_CLASS}>角色库加载失败（稍后重试）</div>
            )}
            {tab === 'member' &&
              props.personaError !== null &&
              props.personaError !== undefined && (
                <div className={ERR_CLASS}>
                  角色接管失败：{props.personaError}——重启 DeepSeek 后重试。
                </div>
              )}
            {tab === 'member' &&
              selectedMember !== null &&
              (props.personaError === null || props.personaError === undefined) && (
                <div className={HINT_CLASS}>
                  对话将以「{selectedMember.name}」的角色输出（再次点击该角色可取消）。
                </div>
              )}
          </div>

          <div className={cn(FOOTER_CLASS, 'flex-none')}>
            <Button
              variant="outline"
              size="sm"
              className="w-full rounded-[8px] border-dashed text-xs font-medium text-primary"
              onClick={tab === 'team' ? addTeam : addMember}
            >
              <Plus className="h-3.5 w-3.5" />
              {TAB_ACTION_META[tab].label}
            </Button>
          </div>
        </Tabs>
      </Card>
    </div>
  );
}

/** ================================== 主组件 ================================== */

/** The eteams composer tool-row entry: a 「团队」 button with a tabbed popup. */
export function TeamsButton(props: TeamsButtonProps): ReactNode {
  const [open, setOpen] = useState(false);
  // The wrapper element doubles as the popup anchor. Held in state (not read
  // off a ref during render) so the portal can mount in the same commit the
  // popup opens.
  const [anchorEl, setAnchorEl] = useState<HTMLDivElement | null>(null);
  // The wrapper is per session — the standard seat carries the framework-
  // resolved id (渲染器注入的直传 prop，不是 owner prop)。
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined;
  // 子代理门控（用户迭代 2026-09-10）：已寻址子代理会话不提供 团队/角色
  // 选择。逐轴择源（sessionModelBadge 同款）：kit hook 在场按会话快照
  // `subagent` 面判定（InputBar 同款）；缺席落 ctx.sessions subagentAddress
  // 探测兜底（非响应式——kit 缺席是旧装配退化，翻转窗口可忽略）。
  const sessionHook = typeof props.useSession === 'function' ? props.useSession : undefined;
  const kitSubagent = sessionHook?.((snapshot) => snapshot?.subagent ?? null);
  // 对话是否已开始（用户迭代 2026-09-13「开始对话后才不能修改」）：读会话
  // 快照的 blank 位（宿主 blank 同口径——首条 ACCEPTED 消息前为 true）。kit
  // hook 缺席（旧装配）无从判定，按已开始兜底（锁定，退回原语义），绝不放宽
  // 成可换队。
  const kitBlank = sessionHook?.((snapshot) => snapshot?.blank === true);
  const conversationStarted = sessionHook === undefined ? true : kitBlank !== true;
  const isSubagent =
    sessionHook === undefined
      ? sessionId !== undefined && sessionId !== '' && isAddressedSubagentSession(sessionId)
      : kitSubagent !== null && kitSubagent !== undefined;
  // Selections (docs/13.8.2, docs/26): a selected MEMBER drives the
  // system-prompt persona band (the conversation speaks as that role); a
  // selected TEAM drives the 团队绑定 band (conversation task workflow +
  // leadership branch — docs/26). The two are mutually exclusive — the button
  // shows one thing. Both persist per session in localStorage and re-assert
  // to the host on mount (host restart self-heals).
  const [selectedMember, setSelectedMember] = useState<RosterMember | null>(() =>
    loadSelectedMember(sessionId),
  );
  const [selectedTeam, setSelectedTeam] = useState<{ teamId: string; name: string } | null>(() =>
    loadSelectedTeam(sessionId),
  );
  // Host sync failure surface (角色接管): the POST is fire-and-forget for
  // latency, but its outcome lands here — a stale host (app not restarted
  // since the feature shipped) must be VISIBLE, not silently swallowed.
  const [personaError, setPersonaError] = useState<string | null>(null);
  // 子代理身份面数据（用户迭代 2026-09-10）：宿主 GET /session-identity 的
  // 磁盘真相（成员/领队副本行、构建会话文件）。identityReady 门槛把加载期
  // 归入 hidden——子代理会话上绝不闪出可交互按钮；请求失败同归 hidden（只
  // 进诊断通道），绝不退回交互面。
  const [identity, setIdentity] = useState<SessionIdentity | null>(null);
  const [identityReady, setIdentityReady] = useState(false);
  useEffect(() => {
    if (!isSubagent || sessionId === undefined || sessionId === '') return;
    let alive = true;
    fetchSessionIdentity(sessionId)
      .then((found) => {
        if (!alive) return;
        setIdentity(found);
        setIdentityReady(true);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setIdentity(null);
        setIdentityReady(true);
        recordClientDiag('session-identity', errorMessageOf(error));
      });
    return () => {
      alive = false;
    };
  }, [isSubagent, sessionId]);
  // inputActions 捕获桥（addPeople）：本组件随 composer 工具行挂载（hero 与
  // 对话内都在）且拿得到会话标准 kit 的官方写路——整页团队页弹窗里的
  // ETeamsView 是独立 React 根、没有 kit prop，其「填充」回落用这里登记的
  // 一份。actions 身份按会话稳定（kit 契约），effect 只在换会话时重登记。
  useEffect(() => captureInputActions(props.inputActions), [props.inputActions]);
  useEffect(() => {
    // 子代理会话不参与选择/绑定（用户迭代 2026-09-10）：persona/团队恢复
    // 对账是主会话语义，已寻址子代理一律跳过——其按钮位是只读身份面。
    if (isSubagent) return;
    let alive = true;
    const restore = (): void => {
      const member = loadSelectedMember(sessionId);
      setSelectedMember(member);
      if (member !== null) {
        forgetSelectedTeam(sessionId);
        setSelectedTeam(null);
        if (sessionId !== undefined) {
          setSessionPersona(sessionId, member)
            .then(() => setPersonaError(null))
            .catch((error: unknown) => {
              setPersonaError(errorMessageOf(error));
              recordClientDiag('persona-restore', errorMessageOf(error));
            });
          // docs/26：双绑定互斥——恢复角色时清掉宿主侧可能残留的团队绑定。
          void clearSessionTeam(sessionId).catch(() => undefined);
        }
        return;
      }
      // 团队面挂载对账（锁定语义）：宿主 GET /session-team 为真相源——
      // 有绑定直接采信（刷 face + 本地镜像，不 POST，宿主侧重命名也对齐）；
      // 宿主无绑定则按本地镜像照旧 POST 重申（重启/失联自愈）。失败只进
      // 诊断通道：锁定态徽章应常驻显示，团队面没有 personaError 那样的
      // 错误位（那是角色面的），宿主不可达时误报反而误导。
      const team = loadSelectedTeam(sessionId);
      if (sessionId === undefined) {
        setSelectedTeam(team);
        return;
      }
      void fetchSessionTeam(sessionId)
        .then((bound) => {
          if (!alive) return;
          if (bound !== null) {
            setSelectedTeam(bound);
            saveSelectedTeam(sessionId, bound);
            return;
          }
          setSelectedTeam(team);
          if (team !== null) {
            setSessionTeam(sessionId, team.teamId).catch((error: unknown) => {
              recordClientDiag('team-restore', errorMessageOf(error));
            });
          }
        })
        .catch((error: unknown) => {
          if (!alive) return;
          setSelectedTeam(team);
          recordClientDiag('team-restore', errorMessageOf(error));
        });
    };
    restore();
    return () => {
      alive = false;
    };
  }, [sessionId, isSubagent]);

  // 活跃会话心跳（用户迭代）：本按钮挂在当前打开对话的输入栏，sessionId
  // 即「用户正在看的对话」。5 秒一跳（页面隐藏时暂停），宿主兜底弹窗据此
  // steer 到用户眼前。fire-and-forget，失败静默——心跳只是优化信号。
  useEffect(() => {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    let alive = true;
    const beat = (): void => {
      if (!alive || document.hidden) return;
      void reportPresence(sessionId).catch(() => undefined);
    };
    beat();
    const timer = window.setInterval(beat, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [sessionId]);

  /* —— 事件处理 —— */

  const clearSelection = (): void => {
    setSelectedMember(null);
    forgetSelectedMember(sessionId);
    setSelectedTeam(null);
    forgetSelectedTeam(sessionId);
    if (sessionId === undefined) return;
    clearSessionPersona(sessionId)
      .then(() => setPersonaError(null))
      .catch((error: unknown) => {
        setPersonaError(errorMessageOf(error));
        recordClientDiag('persona-clear', errorMessageOf(error));
      });
    // docs/26：团队绑定一并清除（宿主侧可能任一绑定在生效）。
    void clearSessionTeam(sessionId).catch((error: unknown) => {
      recordClientDiag('team-clear', errorMessageOf(error));
    });
  };

  const selectMember = (member: RosterMember): void => {
    const next = selectedMember?.name === member.name ? null : member;
    setSelectedMember(next);
    saveSelectedMember(sessionId, next);
    setSelectedTeam(null);
    forgetSelectedTeam(sessionId);
    if (sessionId === undefined) return;
    if (next === null) {
      clearSessionPersona(sessionId)
        .then(() => setPersonaError(null))
        .catch((error: unknown) => {
          setPersonaError(errorMessageOf(error));
          recordClientDiag('persona-clear', errorMessageOf(error));
        });
      return;
    }
    setSessionPersona(sessionId, next)
      .then(() => setPersonaError(null))
      .catch((error: unknown) => {
        setPersonaError(errorMessageOf(error));
        recordClientDiag('persona-set', errorMessageOf(error));
      });
  };

  const selectTeam = (team: { teamId: string; name: string }): void => {
    const next = selectedTeam?.teamId === team.teamId ? null : team;
    setSelectedTeam(next);
    saveSelectedTeam(sessionId, next);
    setSelectedMember(null);
    forgetSelectedMember(sessionId);
    if (sessionId === undefined) return;
    // docs/26：团队绑定驱动「团队绑定」band（对话任务工作流）；与角色接管
    // 互斥——此前选团队只清本地成员选择、不清宿主 persona band，补齐。
    if (selectedMember !== null) {
      void clearSessionPersona(sessionId).catch((error: unknown) => {
        recordClientDiag('persona-clear', errorMessageOf(error));
      });
    }
    if (next !== null) {
      setSessionTeam(sessionId, next.teamId)
        .then(() => setPersonaError(null))
        .catch((error: unknown) => {
          setPersonaError(errorMessageOf(error));
          recordClientDiag('team-set', errorMessageOf(error));
        });
      return;
    }
    void clearSessionTeam(sessionId).catch((error: unknown) => {
      recordClientDiag('team-clear', errorMessageOf(error));
    });
  };

  // Button click toggles the popup (opened on the tab matching the selection;
  // the hover × clears it; panel navigation stays with the 新增 actions) —
  // except the locked team badge, which never reaches this callback
  // （TeamsTriggerButton 拦截：锁定态点击不弹层）.
  const onButtonClick = (): void => {
    setOpen((v) => !v);
  };

  // 渲染门控（subagentFaceMode 逐分支）：子代理 + eteams 身份 → 只读身份面；
  // 子代理无身份/加载中 → 整个隐藏（连弹层与 anchor 交互一起不渲染，根 div
  // 保留只为 DOM 结构与 data-eteams 标记稳定）；主会话 → 既有交互不变。
  const mode = subagentFaceMode(isSubagent, identityReady, identity);

  return (
    <ClientErrorBoundary label="团队按钮">
      {/* R2-F2（docs/21 21.5.3）：表面根包 Provider——单例 store，多 Provider
      同 store 无害。TeamsPopup 经 createPortal 挂到 body，但仍是本组件
      React 树的子节点，context 穿透 portal，弹层内 useActivityMonitor 的
      useSelector 正常消费。表面根（D19b/S11）：.eteams-ui 作用域根，工具类
      经后代选择器作用于子树；根自身不承工具类样式，display/align 承重布局
      保留 inline。 */}
      <Provider store={getApp().store}>
        <div
          ref={setAnchorEl}
          className="eteams-ui"
          style={{ display: 'inline-flex', alignItems: 'center' }}
          data-eteams="button"
        >
          {mode === 'identity' && identity !== null ? (
            // 子代理身份面（只读）：身份由插件指派，无清除、不可选（hover 弹
            // 本会话锚定任务卡片，点击换会话）。
            <SubagentIdentityFace identity={identity} sessionId={sessionId} />
          ) : mode === 'interactive' ? (
            <>
              {/* 选中面与锁定态在 TeamsTriggerButton 内（Provider 子树）：
                  锁定徽章不可点、失联徽章置灰可点（解锁逃生口），见该组件注记。 */}
              <TeamsTriggerButton
                selectedMember={selectedMember}
                selectedTeam={selectedTeam}
                conversationStarted={conversationStarted}
                sessionId={sessionId}
                open={open}
                onButtonClick={onButtonClick}
                onClear={clearSelection}
              />
              {open && anchorEl !== null && typeof document !== 'undefined'
                ? createPortal(
                    <TeamsPopup
                      anchor={anchorEl}
                      selectedMember={selectedMember}
                      selectedTeam={selectedTeam}
                      personaError={personaError}
                      onSelectMember={selectMember}
                      onSelectTeam={selectTeam}
                      initialTab={selectedMember !== null ? 'member' : 'team'}
                      onClose={() => setOpen(false)}
                    />,
                    document.body,
                  )
                : null}
            </>
          ) : null}
        </div>
      </Provider>
    </ClientErrorBoundary>
  );
}
