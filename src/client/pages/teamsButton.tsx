/**
 * The 团队 button in the composer tool row (`conversation.input.right`).
 *
 * The popup is a small tabbed card — 团队 | 角色 — listing the session's
 * teams (live, via the shared activity monitor) and the role library
 * (roster), with one creation shortcut pinned to the footer of each tab:
 *
 * - 「＋ 新增团队」 jumps straight to the 团队 tab page (real host tab when
 *   visible, the full-page 团队页 otherwise) with the creation form open;
 * - 「＋ 新增角色」 prefills the `eTeam --add-people` command into the
 *   composer draft (never auto-send; clipboard fallback) and jumps to the
 *   role-builder view of the 团队 tab page (D18-1).
 *
 * Role rows are selectable: the selected role's avatar + name
 * (or the team's chip + name) replace the button label, highlighted while a
 * selection is active, with a hover-revealed × to clear. For a role the
 * host asserts a system-prompt persona band for the session (per-assembly
 * dynamic section keyed by the session agent) so the conversation speaks as
 * that role — no draft text, nothing sent. For a team the host asserts the
 * 团队绑定 band (docs/26: conversation task workflow, led by the captain or
 * by the main window when the leader is removed). Selections persist per
 * session in localStorage and re-assert to the host on mount. 一次性选择
 * （用户迭代 2026-09-07「发送后清空选择」）：团队面在提交瞬间（输入状态机
 * submitting 转变沿）就地清空——按钮回「团队」、localStorage 清除；宿主侧
 * 绑定不在此处删除（那条消息的 band 与派发身份还要靠它），由宿主
 * user/message 事件一次性消费（host runtime/sessionTeam）。角色面不随发送
 * 清空。 Clicking the
 * button ALWAYS toggles this popup (opened on the tab matching the
 * selection) — panel navigation stays with the 新增 shortcuts. When the
 * slot's `inputActions` kit is unavailable the prefill degrades to clipboard
 * copy.
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
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives';
// lucide 深层图标导入（dialog.tsx 先例：深层 .mjs 只进用到的图标）。
import Check from 'lucide-react/dist/esm/icons/check.mjs';
import Plus from 'lucide-react/dist/esm/icons/plus.mjs';
import Search from 'lucide-react/dist/esm/icons/search.mjs';
import { ADD_PEOPLE_TEMPLATE, captureInputActions, prefillComposer } from '../lib/addPeople';
import { ClientErrorBoundary, recordClientDiag } from '../lib/diagnostics';
import { enterTeamsPanel } from './teamsPanel';
import {
  clearSessionPersona,
  clearSessionTeam,
  fetchRoster,
  reportPresence,
  setSessionPersona,
  setSessionTeam,
  type RosterMember,
} from '../lib/api';
import { useActivityMonitor } from '../lib/monitor';
import { getApp } from '../store/app';
import { Avatar } from '../features/avatar/avatar';
import { cn } from '../lib/cn';
import { errorMessageOf } from '../lib/errors';
import { matchesQuery } from '../lib/text';
import { BORDER_L1_CLASS, TEAM_CHIP_CLASS } from './shared/styles';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';

/** ================================== 类型 ================================== */

/** 会话快照里本按钮只关心的员（ConversationSnapshot.running 的结构化投影
 * ——回合在途即 true；快照未就绪 → undefined）。 */
interface SessionSnapshotFace {
  readonly running?: unknown;
}

/** useSession 的在途 selector（模块级常量——引用稳定，行为纯函数）。 */
const SESSION_RUNNING_SELECTOR = (snapshot: SessionSnapshotFace | undefined): boolean =>
  snapshot?.running === true;

/**
 * 标准座位入参（SessionStandardProps 契约的结构化投影）：框架随每个
 * session 作用域槽位组件下发 `sessionId`（会话 id 直传 prop）、
 * `useSession`（会话快照选择器）与 `useProjection`（keyed 投影读取），
 * owner 不传任何东西——故全部可选。首版误读 `props.session` /
 * `props.input`（框架从不传这两个 prop），绑定 POST、挂载恢复、心跳与
 * 发送清空全部静默失效，2026-09-10 改正（实测 conversation 包：input.right
 * 槽位 owner 传空包，InputBar 自身的输入状态 hook 不透传——发送清空改走
 * 快照 `running` 位，见主组件注记）。类型保持结构化，不触及宿主未导出的
 * 契约名。`inputActions` 是 conversation 输入域专属的既有 prop（草稿写入
 * 动作，prefillComposer 用）。
 */
interface TeamsButtonProps {
  readonly sessionId?: string;
  readonly useSession?: <S>(selector: (snapshot: SessionSnapshotFace | undefined) => S) => S;
  readonly inputActions?: { setDraft: (text: string) => void };
}

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

/** ================================== 常量与映射表 ================================== */

/** 团队 tab 空态两态查表（M6，M5 boardTab EMPTY_FOOTNOTE_META 同模式）：
 * 尚未建团队整句 / 状态加载失败前缀。错误支的原始错误串是运行时值，表存
 * 字面量件、消费位拼接（条件式只选组装形态）；两支文案与收编前逐串一致。 */
const TEAM_EMPTY_META: Record<'error' | 'noTeam', string> = {
  error: '状态加载失败：',
  noTeam: '还没有团队——点下方「新增团队」创建。',
};

/** 弹层页脚新增钮两 tab 查表（M6）：outline dashed 档两处逐字同文（variant/
 * size/类名/Plus 图标，见 S23-4 注记），仅 label 随 tab 切换——label 收表，
 * 回调由消费位按键选取（addTeam/addMember）。 */
const TAB_ACTION_META: Record<'team' | 'member', { label: string }> = {
  team: { label: '新增团队' },
  member: { label: '新增角色' },
};

/** ================================== 工具函数 ================================== */

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
 * The popup card, portaled to `<body>` (the composer card would crop an
 * in-place surface). It floats ABOVE the trigger with a small gap — the
 * button sits at the bottom of the window, and a below-placement (or a
 * viewport-clamped flip) would cover the 「团队」 label it belongs to.
 * Bottom-anchored（`bottom` + `maxHeight`，不用 `top`）：卡片高度与定位解耦，
 * 团队/角色 tab 切换、列表加载只向上长高，位置永不回跳（无闪烁）。
 */
function TeamsPopup(props: {
  anchor: HTMLElement;
  inputActions?: { setDraft: (text: string) => void };
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
  // Hand-rolled above-placement: right-aligned to the trigger, BOTTOM edge
  // `gap` above its top edge, clamped to the viewport. Until the first
  // measurement the panel stays invisible (no flash at 0,0).
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
      const left = Math.min(Math.max(r.right - w, margin), window.innerWidth - margin - w);
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
    // 落团队 tab/整页团队页；创建走页头「＋ 新增团队」按钮，不再自开弹窗
    // （用户反馈 2026-09：一进团队页就弹新增弹窗很突兀）。
    enterTeamsPanel();
  };

  const addMember = (): void => {
    onClose();
    // D18-1：命令进输入框（覆盖前确认），退化为复制；均不自动发送。
    const outcome = prefillComposer(props.inputActions);
    if (outcome === 'copied') {
      void writeClipboard(ADD_PEOPLE_TEMPLATE).catch(() => undefined);
    }
    enterTeamsPanel({ memberBuilder: true });
  };

  const teams = state.teams;
  const visibleTeams = teams.filter((t) => matchesQuery(t.name, query));
  // roster 为 null（加载中）时取空数组——可空类型无法从 roster 的判断收窄，
  // 恒定数组让下方 JSX 链的"无匹配"分支直接用 length 判断。
  const visibleRoster = (roster ?? []).filter((m) => matchesQuery(m.name, query));

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

          <div className={LIST_CLASS}>
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
  // 一次性团队选择（用户迭代 2026-09-07「发送后清空选择」）：消息发出并被
  // 受理（快照 running false→true 沿——实测 conversation 包：input.right
  // 槽位 owner 传空包，InputBar 自身的输入状态 hook 不透传，session 标准
  // kit 的快照 running 位是本域内唯一的「回合在途」权威信号）即清团队面
  // ——按钮回「团队」+ localStorage 清除，不调 clearSessionTeam（那条消息
  // 的宿主 band/派发身份还要靠绑定，宿主 user/message 事件一次性消费，
  // host runtime/sessionTeam）。转变沿检测走渲染期调整（React 官方对
  // 「prop 变化派生状态」的替代——effect 同步 setState 被
  // react-hooks/set-state-in-effect 禁止）：lastRunning 记上一帧在途位，
  // 仅在 false→true 转变沿清空——挂载即在途（首帧同值）与回合中段重选
  // （位未变）都不误清。removeItem 幂等，重复执行无副作用。角色面不受
  // 发送影响（用户只要求团队选择）。hook prop 先取局部变量再调用（成员名
  // 不以 use 开头，hook 判定不受影响；是否在场随 mounting 固定，顺序稳定），
  // 缺席时恒 false（转变沿无从发生，清空静默退化）。
  const sessionHook = typeof props.useSession === 'function' ? props.useSession : undefined;
  const turnRunning = sessionHook?.(SESSION_RUNNING_SELECTOR) ?? false;
  const [lastRunning, setLastRunning] = useState<boolean>(turnRunning);
  if (turnRunning !== lastRunning) {
    setLastRunning(turnRunning);
    if (turnRunning && selectedTeam !== null) {
      setSelectedTeam(null);
      forgetSelectedTeam(sessionId);
    }
  }
  // Host sync failure surface (角色接管): the POST is fire-and-forget for
  // latency, but its outcome lands here — a stale host (app not restarted
  // since the feature shipped) must be VISIBLE, not silently swallowed.
  const [personaError, setPersonaError] = useState<string | null>(null);
  // inputActions 捕获桥（addPeople）：本组件随 composer 工具行挂载（hero 与
  // 对话内都在）且拿得到会话标准 kit 的官方写路——整页团队页弹窗里的
  // ETeamsView 是独立 React 根、没有 kit prop，其「填充」回落用这里登记的
  // 一份。actions 身份按会话稳定（kit 契约），effect 只在换会话时重登记。
  useEffect(() => captureInputActions(props.inputActions), [props.inputActions]);
  useEffect(() => {
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
      const team = loadSelectedTeam(sessionId);
      setSelectedTeam(team);
      // docs/26：团队绑定挂载重申（宿主重启自愈，同 persona 模式）——绑定
      // 生效后该会话的提示词携带「团队绑定」band（对话任务工作流）。
      if (team !== null && sessionId !== undefined) {
        setSessionTeam(sessionId, team.teamId)
          .then(() => setPersonaError(null))
          .catch((error: unknown) => {
            setPersonaError(errorMessageOf(error));
            recordClientDiag('team-restore', errorMessageOf(error));
          });
      }
    };
    restore();
  }, [sessionId]);

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

  // Button click ALWAYS toggles the popup（用户反馈：无论什么状态都点开小
  // 弹窗选择）—— the popup opens on the tab matching the selection; the
  // hover × clears it. Panel navigation stays with the 新增 actions.
  const onButtonClick = (): void => {
    setOpen((v) => !v);
  };

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
          {/* 选中高亮（原 POPUP_CSS `.eteams-teams-btn[data-selected]` 迁移）：
        `group` 供 hover 显隐的清除钮用；交互激活底色无语义 token → 任意值
        直引（D19c），文字用 brand 主色 token。 */}
          {/* D25-6：触发钮镜像宿主 preset chip 观感（胶囊/无边框/13px，同
              heroTeamsButton 的 chip 口径）——R4 用户反馈「太大 + 边框突兀」
              根因即 UA button 边框未压（ghost 变体已补 border-none）+ h-8
              偏大。选中态沿用品牌淡底。`group` 供 hover 显隐的清除钮用。 */}
          <Button
            variant="ghost"
            size="sm"
            className="group h-7 rounded-full border-none px-2.5 text-[13px] leading-[18px] font-medium normal-case tracking-normal data-[selected=true]:bg-business-tint data-[selected=true]:text-primary"
            data-selected={selectedMember !== null || selectedTeam !== null ? 'true' : undefined}
            aria-label="团队"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={onButtonClick}
          >
            {selectedMember !== null ? (
              <span className={FACE_ROW_CLASS}>
                <Avatar
                  name={selectedMember.name}
                  seed={selectedMember.avatar?.seed}
                  salt={selectedMember.avatar?.salt}
                  size={18}
                />
                <span className={FACE_NAME_CLASS}>{selectedMember.name}</span>
                <ClearButton onClear={clearSelection} />
              </span>
            ) : selectedTeam !== null ? (
              <span className={FACE_ROW_CLASS}>
                <span className={TEAM_CHIP_CLASS} aria-hidden={true}>
                  {selectedTeam.name.slice(0, 1)}
                </span>
                <span className={FACE_NAME_CLASS}>{selectedTeam.name}</span>
                <ClearButton onClear={clearSelection} />
              </span>
            ) : (
              '团队'
            )}
          </Button>
          {open && anchorEl !== null && typeof document !== 'undefined'
            ? createPortal(
                <TeamsPopup
                  anchor={anchorEl}
                  inputActions={props.inputActions}
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
        </div>
      </Provider>
    </ClientErrorBoundary>
  );
}
