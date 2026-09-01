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
 * that role — no draft text, nothing sent. Selections persist per session
 * in localStorage and re-assert to the host on mount. Clicking the button
 * ALWAYS toggles this popup (opened on the tab matching the selection) —
 * panel navigation stays with the 新增 shortcuts. When the slot's
 * `inputActions` kit is unavailable the prefill degrades to clipboard copy.
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
import { Button, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives';
import { ADD_PEOPLE_TEMPLATE, prefillComposer } from './addPeople';
import { PHASE_LABELS } from './phaseLabels';
import { ClientErrorBoundary, recordClientDiag } from './diagnostics';
import { enterTeamsPanel } from './teamsPanel';
import {
  clearSessionPersona,
  fetchRoster,
  reportPresence,
  setSessionPersona,
  type RosterMember,
} from './api';
import { useActivityMonitor } from './monitor';
import { getApp } from './store/app';
import { Avatar } from './avatar';
import { cn } from './cn';
import { Card } from './components/ui/card';

/**
 * Owner share of the input-region slots (`InputZone`): the conversation
 * snapshot, the live input state, and the session-slot standard kit's
 * draft actions when the runtime injects them. Types stay structural to
 * avoid reaching into non-exported contract names.
 */
interface TeamsButtonProps {
  readonly session?: unknown;
  readonly input?: unknown;
  readonly inputActions?: { setDraft: (text: string) => void };
}

/** The eteams composer tool-row entry: a 「团队」 button with a tabbed popup. */
export function TeamsButton(props: TeamsButtonProps): ReactNode {
  const [open, setOpen] = useState(false);
  // The wrapper element doubles as the popup anchor. Held in state (not read
  // off a ref during render) so the portal can mount in the same commit the
  // popup opens.
  const [anchorEl, setAnchorEl] = useState<HTMLDivElement | null>(null);
  // The wrapper is per session — the structural session face carries the id.
  const sessionId = (props.session as { sessionId?: string } | undefined)?.sessionId;
  // Selections (docs/13.8.2): a selected MEMBER drives the system-prompt
  // persona band (the conversation speaks as that role); a selected TEAM is
  // a navigation bookmark. The two are mutually exclusive — the button shows
  // one thing. Both persist per session in localStorage; the member
  // selection re-asserts to the host on mount (host restart self-heals).
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
              setPersonaError(error instanceof Error ? error.message : String(error));
              recordClientDiag(
                'persona-restore',
                error instanceof Error ? error.message : String(error),
              );
            });
        }
        return;
      }
      setSelectedTeam(loadSelectedTeam(sessionId));
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

  const clearSelection = (): void => {
    setSelectedMember(null);
    forgetSelectedMember(sessionId);
    setSelectedTeam(null);
    forgetSelectedTeam(sessionId);
    if (sessionId === undefined) return;
    clearSessionPersona(sessionId)
      .then(() => setPersonaError(null))
      .catch((error: unknown) => {
        setPersonaError(error instanceof Error ? error.message : String(error));
        recordClientDiag('persona-clear', error instanceof Error ? error.message : String(error));
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
          setPersonaError(error instanceof Error ? error.message : String(error));
          recordClientDiag('persona-clear', error instanceof Error ? error.message : String(error));
        });
      return;
    }
    setSessionPersona(sessionId, next)
      .then(() => setPersonaError(null))
      .catch((error: unknown) => {
        setPersonaError(error instanceof Error ? error.message : String(error));
        recordClientDiag('persona-set', error instanceof Error ? error.message : String(error));
      });
  };

  const selectTeam = (team: { teamId: string; name: string }): void => {
    const next = selectedTeam?.teamId === team.teamId ? null : team;
    setSelectedTeam(next);
    saveSelectedTeam(sessionId, next);
    setSelectedMember(null);
    forgetSelectedMember(sessionId);
    if (next === null && sessionId !== undefined) {
      void clearSessionPersona(sessionId).catch((error: unknown) => {
        recordClientDiag('persona-clear', error instanceof Error ? error.message : String(error));
      });
    }
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
          <Button
            variant="ghost"
            size="sm"
            className="group data-[selected=true]:bg-[color:var(--dsw-alias-interactive-bg-active,rgba(75,123,236,0.12))] data-[selected=true]:text-primary"
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
                <span
                  className={CLEAR_BUTTON_CLASS}
                  role="button"
                  aria-label="取消选择"
                  title="取消选择"
                  onClick={(event) => {
                    event.stopPropagation();
                    clearSelection();
                  }}
                >
                  ×
                </span>
              </span>
            ) : selectedTeam !== null ? (
              <span className={FACE_ROW_CLASS}>
                <span className={TEAM_CHIP_CLASS} aria-hidden={true}>
                  {selectedTeam.name.slice(0, 1)}
                </span>
                <span className={FACE_NAME_CLASS}>{selectedTeam.name}</span>
                <span
                  className={CLEAR_BUTTON_CLASS}
                  role="button"
                  aria-label="取消选择"
                  title="取消选择"
                  onClick={(event) => {
                    event.stopPropagation();
                    clearSelection();
                  }}
                >
                  ×
                </span>
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

// ---------- selection persistence (per session, guarded) ----------

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

// ---------- S11 迁移后的类名常量（Tailwind 工具类，完整字面量） ----------

/* 原 POPUP_CSS 手写样式表的三态规则迁成变体类（inline style 无法表达
:hover，Tailwind 变体可以——样式表随之删除）：
- 行默认透明底：`<button>` 带 UA 背景，必须显式压住（原样式表同款理由）；
- hover 底 = 交互悬停（--muted 桥即 interactive-bg-hover，同一宿主变量）；
- 选中底 = 交互激活（无语义 token，任意值直引；与 hover 同特异性时按产物
  源序 data-[selected] 靠后取胜，等同原样式表的规则先后）；
- preflight 已关：UA 字体/背景的显式覆盖逐项保留（text-[13px]、
  [font-family:inherit]、bg-transparent），视觉与迁移前一致。 */
const ROW_CLASS =
  'flex w-full cursor-pointer items-center gap-2 rounded-[8px] border-none bg-transparent px-[9px] py-[7px] text-left text-[13px] text-foreground [font-family:inherit] hover:bg-muted data-[selected=true]:bg-[color:var(--dsw-alias-interactive-bg-active,rgba(75,123,236,0.12))]';
const ROW_NAME_CLASS = 'min-w-0 truncate font-medium';
const ROW_META_CLASS = 'ml-auto shrink-0 text-[11px] text-muted-foreground';
const EMPTY_CLASS = 'px-2.5 py-3.5 text-center text-xs text-muted-foreground';
const ERR_CLASS = 'px-2.5 pb-2 pt-1 text-[11px] text-destructive';
const HINT_CLASS = 'px-2.5 pb-0.5 pt-1.5 text-[11px] leading-normal text-muted-foreground';

/* 弹层卡体（原 S.card）：bg/background、文字色走语义 token（label-primary/
 layer-1 与原 T.surface/T.text 同一宿主变量）；边框沿用原 l1 档（shadcn
 --border 桥 l2，任意值直引保持视觉）；阴影逐字保留原 T.shadow。 */
const POPUP_BORDER_CLASS = 'border-[color:var(--dsw-alias-border-l1,rgba(100,116,139,0.14))]';
const TAB_HEADER_CLASS = `flex gap-0.5 border-b border-solid bg-card p-1.5 ${POPUP_BORDER_CLASS}`;
const LIST_CLASS = 'flex max-h-[260px] flex-col gap-0.5 overflow-x-hidden overflow-y-auto p-1.5';
const FOOTER_CLASS = `flex border-t border-solid p-1.5 ${POPUP_BORDER_CLASS}`;
const ACTION_CLASS =
  'flex-1 cursor-pointer rounded-[8px] border border-dashed bg-transparent px-2 py-1.5 text-center text-xs font-medium leading-[18px] text-primary [font-family:inherit]';

/* Tab 按钮（原 S.tabBtn）：active/idle 两态都是完整字面量映射（无拼接）。
active 的内嵌 1px 描边用 inset shadow 任意值（原 boxShadow 迁移）。 */
const tabBtnClass = (active: boolean): string =>
  cn(
    'flex-1 cursor-pointer rounded-[8px] border-none px-2 py-[5px] text-center text-xs leading-[18px]',
    active
      ? 'bg-background font-semibold text-primary shadow-[inset_0_0_0_1px_var(--dsw-alias-border-l1,rgba(100,116,139,0.14))]'
      : 'bg-transparent font-medium text-[color:var(--dsw-alias-label-secondary,#47546c)]',
  );

/* 按钮选中面（原 S.faceName/S.teamChip 与 `.eteams-teams-clear` 迁移）：
清除钮 16×16、默认隐藏、hover 按钮时显形（`group-hover` 搭配触发钮上的
`group`），自身 hover 换交互悬停底与主文字色——逐条对应原样式表。过渡时长
不用 duration 任意值（时间长度类同时匹配 transition/animation 两个工具、
属歧义候选不产 CSS），改用任意属性 shorthand，逐字对应原 `transition:opacity .12s`。 */
const FACE_ROW_CLASS = 'inline-flex items-center gap-1.5';
const FACE_NAME_CLASS = 'max-w-[120px] truncate font-medium';
const TEAM_CHIP_CLASS =
  'inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border border-solid bg-background text-[11px] font-semibold text-primary';
const CLEAR_BUTTON_CLASS =
  'inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-transparent p-0 text-[13px] leading-none text-muted-foreground opacity-0 [transition:opacity_120ms] group-hover:opacity-100 hover:bg-muted hover:text-foreground';

/**
 * The popup card, portaled to `<body>` (the composer card would crop an
 * in-place surface). It floats ABOVE the trigger with a small gap — the
 * button sits at the bottom of the window, and a below-placement (or a
 * viewport-clamped flip) would cover the 「团队」 label it belongs to.
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
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Hand-rolled above-placement: right-aligned to the trigger, bottom edge
  // `gap` above its top edge, clamped to the viewport. Re-measured on the
  // panel's own size changes (tab switch, roster load) via ResizeObserver,
  // plus window resize and captured scroll. Until the first measurement the
  // panel stays invisible (no flash at 0,0).
  const [pos, setPos] = useState<CSSProperties | null>(null);
  // Anti-flicker positioning（用户反馈：切换成员时闪一下）： continuous rAF
  // tracking instead of event listeners. Events left gaps — selecting swaps
  // the button face (width change → tool-row reflow) and mutates the panel
  // (hint text), and the old RO/scroll-only approach repositioned a frame
  // late, so the card visibly lagged then snapped. Reading rects per frame
  // with a change-guard keeps the card glued with ZERO re-renders while
  // nothing moves.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    let raf = 0;
    let last = '';
    const compute = (): void => {
      const r = anchor.getBoundingClientRect();
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      const margin = 8;
      const gap = 6;
      const left = Math.min(Math.max(r.right - w, margin), window.innerWidth - margin - w);
      const top = Math.max(margin, r.top - gap - h);
      const key = `${left}|${top}`;
      if (key === last) return; // no-op guard: no setState, no re-render
      last = key;
      setPos({ left, top });
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

  const addTeam = (): void => {
    onClose();
    enterTeamsPanel({ creator: true });
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
          'eteams-ui fixed z-[1000] box-border flex w-[280px] flex-col overflow-hidden border-solid bg-background text-[13px] shadow-[0_1px_2px_rgba(15,23,42,0.05),0_6px_18px_rgba(15,23,42,0.06)]',
          POPUP_BORDER_CLASS,
          // 首次测量前面板不可见（原 inline visibility:hidden 迁移）。
          pos === null ? 'invisible' : null,
        )}
        style={pos ?? undefined}
      >
        <div className={TAB_HEADER_CLASS}>
          <button
            type="button"
            className={tabBtnClass(tab === 'team')}
            onClick={() => setTab('team')}
          >
            团队{teams.length > 0 ? ` · ${teams.length}` : ''}
          </button>
          <button
            type="button"
            className={tabBtnClass(tab === 'member')}
            onClick={() => setTab('member')}
          >
            角色{roster !== null && roster.length > 0 ? ` · ${roster.length}` : ''}
          </button>
        </div>

        <div className={LIST_CLASS}>
          {tab === 'team' ? (
            teams.length === 0 ? (
              <div className={EMPTY_CLASS}>
                {state.error !== null
                  ? `状态加载失败：${state.error}`
                  : '还没有团队——点下方「新增团队」创建。'}
              </div>
            ) : (
              teams.map((t) => {
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
                    title={`${t.name} · ${t.goal}`}
                  >
                    <span className={ROW_NAME_CLASS}>{t.name}</span>
                    {isTeamSelected ? (
                      <span className={ROW_META_CLASS}>已选</span>
                    ) : (
                      <span className={ROW_META_CLASS}>
                        {PHASE_LABELS[t.phase] ?? t.phase} · {t.progress.completed}/
                        {t.progress.total}
                      </span>
                    )}
                  </button>
                );
              })
            )
          ) : roster === null ? (
            <div className={EMPTY_CLASS}>角色库加载中…</div>
          ) : roster.length === 0 ? (
            <div className={EMPTY_CLASS}>角色库为空——点下方「新增角色」创建。</div>
          ) : (
            roster.map((m) => {
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
                  {isSelected && <span className={ROW_META_CLASS}>已选</span>}
                </button>
              );
            })
          )}
          {tab === 'member' && rosterError && (
            <div className={ERR_CLASS}>角色库加载失败（稍后重试）</div>
          )}
          {tab === 'member' && props.personaError !== null && props.personaError !== undefined && (
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
          {tab === 'team' && selectedTeam !== null && (
            <div className={HINT_CLASS}>已选「{selectedTeam.name}」（再次点击该团队可取消）。</div>
          )}
        </div>

        <div className={FOOTER_CLASS}>
          {tab === 'team' ? (
            <button type="button" className={ACTION_CLASS} onClick={addTeam}>
              ＋ 新增团队
            </button>
          ) : (
            <button type="button" className={ACTION_CLASS} onClick={addMember}>
              ＋ 新增角色
            </button>
          )}
        </div>
      </Card>
    </div>
  );
}
