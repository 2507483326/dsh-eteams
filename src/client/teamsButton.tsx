/**
 * The 团队 button in the composer tool row (`conversation.input.right`).
 *
 * The popup is a small tabbed card — 团队 | 成员 — listing the session's
 * teams (live, via the shared activity monitor) and the member-library
 * roster, with one creation shortcut pinned to the footer of each tab:
 *
 * - 「＋ 新增团队」 jumps straight to the 团队 tab page (real host tab when
 *   visible, the full-page 团队页 otherwise) with the creation form open;
 * - 「＋ 新增成员」 prefills the `eTeam --add-people` command into the
 *   composer draft (never auto-send; clipboard fallback) and jumps to the
 *   member-builder view of the 团队 tab page (D18-1).
 *
 * Member and team rows are selectable: the selected member's avatar + name
 * (or the team's chip + name) replace the button label, highlighted while a
 * selection is active, with a hover-revealed × to clear. For a member the
 * host asserts a system-prompt persona band for the session (per-assembly
 * dynamic section keyed by the session agent) so the conversation speaks as
 * that role — no draft text, nothing sent. Selections persist per session
 * in localStorage and re-assert to the host on mount. Clicking the button
 * ALWAYS toggles this popup (opened on the tab matching the selection) —
 * panel navigation stays with the 新增 shortcuts. When the slot's
 * `inputActions` kit is unavailable the new-member prefill degrades to
 * clipboard copy.
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
import { Button, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives';
import { ADD_PEOPLE_TEMPLATE, prefillComposer } from './addPeople';
import { PHASE_LABELS, T } from './eteamsView';
import { ClientErrorBoundary, recordClientDiag } from './diagnostics';
import { enterTeamsPanel } from './teamsPanel';
import {
  clearSessionPersona,
  fetchRoster,
  setSessionPersona,
  type RosterMember,
} from './api';
import { useActivityMonitor } from './monitor';
import { Avatar } from './avatar';

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
  useEffect(() => {
    ensurePopupStyle();
    const restore = (): void => {
      const member = loadSelectedMember(sessionId);
      setSelectedMember(member);
      if (member !== null) {
        forgetSelectedTeam(sessionId);
        setSelectedTeam(null);
        if (sessionId !== undefined) {
          void setSessionPersona(sessionId, member).catch((error: unknown) => {
            recordClientDiag('persona-restore', error instanceof Error ? error.message : String(error));
          });
        }
        return;
      }
      setSelectedTeam(loadSelectedTeam(sessionId));
    };
    restore();
  }, [sessionId]);

  const clearSelection = (): void => {
    setSelectedMember(null);
    forgetSelectedMember(sessionId);
    setSelectedTeam(null);
    forgetSelectedTeam(sessionId);
    if (sessionId === undefined) return;
    void clearSessionPersona(sessionId).catch((error: unknown) => {
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
      void clearSessionPersona(sessionId).catch((error: unknown) => {
        recordClientDiag('persona-clear', error instanceof Error ? error.message : String(error));
      });
      return;
    }
    void setSessionPersona(sessionId, next).catch((error: unknown) => {
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
      <div ref={setAnchorEl} style={{ display: 'inline-flex', alignItems: 'center' }} data-eteams="button">
        <Button
          variant="ghost"
          size="sm"
          className="eteams-teams-btn"
          data-selected={selectedMember !== null || selectedTeam !== null ? 'true' : undefined}
          aria-label="团队"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={onButtonClick}
        >
          {selectedMember !== null ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Avatar
                name={selectedMember.name}
                seed={selectedMember.avatar?.seed}
                salt={selectedMember.avatar?.salt}
                size={18}
              />
              <span style={S.faceName}>{selectedMember.name}</span>
              <span
                className="eteams-teams-clear"
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
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={S.teamChip} aria-hidden={true}>
                {selectedTeam.name.slice(0, 1)}
              </span>
              <span style={S.faceName}>{selectedTeam.name}</span>
              <span
                className="eteams-teams-clear"
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
        {open && anchorEl !== null && typeof document !== 'undefined' ? (
          createPortal(
            <TeamsPopup
              anchor={anchorEl}
              inputActions={props.inputActions}
              selectedMember={selectedMember}
              selectedTeam={selectedTeam}
              onSelectMember={selectMember}
              onSelectTeam={selectTeam}
              initialTab={selectedMember !== null ? 'member' : 'team'}
              onClose={() => setOpen(false)}
            />,
            document.body,
          )
        ) : null}
      </div>
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

// ---------- popup row hover / selected styles ----------

const POPUP_STYLE_ID = 'eteams-popup-style';
/** Inline styles cannot express :hover — rows get their default/hover/
 * selected backgrounds from this one stylesheet instead (token-driven; the
 * default transparent also belongs here because `<button>` carries a UA
 * background that an inline transparent would shadow the hover with).
 * `.eteams-teams-btn` is the composer button itself: highlighted while a
 * member/team is selected, and its right-reserved × clears on hover. */
const POPUP_CSS = `
.eteams-ets-row{background:transparent}
.eteams-ets-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(100,116,139,0.08))}
.eteams-ets-row[data-selected="true"]{background:var(--dsw-alias-interactive-bg-active,rgba(75,123,236,0.12))}
.eteams-teams-btn[data-selected="true"]{background:var(--dsw-alias-interactive-bg-active,rgba(75,123,236,0.12));color:var(--dsw-alias-brand-primary,#4b7bec)}
.eteams-teams-clear{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:16px;height:16px;border:none;border-radius:50%;padding:0;font-size:13px;line-height:1;font-family:inherit;color:var(--dsw-alias-label-tertiary,#808da4);background:transparent;cursor:pointer;opacity:0;transition:opacity .12s}
.eteams-teams-btn:hover .eteams-teams-clear{opacity:1}
.eteams-teams-clear:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(100,116,139,0.08));color:var(--dsw-alias-label-primary,#1c2430)}
`;

/** Inject the row stylesheet once per page (same pattern as heroTeamsButton). */
function ensurePopupStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(POPUP_STYLE_ID) !== null) return;
  const tag = document.createElement('style');
  tag.id = POPUP_STYLE_ID;
  tag.textContent = POPUP_CSS;
  document.head.appendChild(tag);
}

// ---------- the tabbed popup ----------

const S = {
  card: {
    boxSizing: 'border-box',
    width: 280,
    background: T.surface,
    border: `1px solid ${T.border}`,
    borderRadius: 12,
    boxShadow: T.shadow,
    color: T.text,
    fontSize: 13,
    fontFamily: 'inherit',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  } satisfies CSSProperties,
  tabHeader: {
    display: 'flex',
    gap: 2,
    padding: 6,
    borderBottom: `1px solid ${T.border}`,
    background: T.sunken,
  } satisfies CSSProperties,
  tabBtn: (active: boolean): CSSProperties => ({
    flex: 1,
    padding: '5px 8px',
    fontSize: 12,
    fontWeight: active ? 600 : 500,
    lineHeight: '18px',
    textAlign: 'center',
    cursor: 'pointer',
    border: 'none',
    borderRadius: 8,
    background: active ? T.surface : 'transparent',
    color: active ? T.accent : T.text2,
    boxShadow: active ? `inset 0 0 0 1px ${T.border}` : 'none',
  }),
  list: {
    maxHeight: 260,
    overflowY: 'auto',
    overflowX: 'hidden',
    padding: 6,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  } satisfies CSSProperties,
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '7px 9px',
    border: 'none',
    borderRadius: 8,
    /* background intentionally unset — the stylesheet owns hover/selected
    (`.eteams-ets-row:hover` / `[data-selected="true"]`); inline would win. */
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
    color: T.text,
  } satisfies CSSProperties,
  rowName: {
    fontWeight: 500,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } satisfies CSSProperties,
  rowMeta: {
    marginLeft: 'auto',
    flexShrink: 0,
    fontSize: 11,
    color: T.text3,
  } satisfies CSSProperties,
  empty: {
    padding: '14px 10px',
    fontSize: 12,
    color: T.text3,
    textAlign: 'center',
  } satisfies CSSProperties,
  err: {
    padding: '4px 10px 8px',
    fontSize: 11,
    color: T.err,
  } satisfies CSSProperties,
  faceName: {
    maxWidth: 120,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 500,
  } satisfies CSSProperties,
  teamChip: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: 18,
    height: 18,
    borderRadius: 5,
    fontSize: 11,
    fontWeight: 600,
    /* surface-on-accent: the chip stays visible on the highlighted button */
    background: T.surface,
    border: `1px solid ${T.border2}`,
    color: T.accent,
  } satisfies CSSProperties,
  hint: {
    padding: '6px 10px 2px',
    fontSize: 11,
    lineHeight: 1.5,
    color: T.text3,
  } satisfies CSSProperties,
  footer: {
    borderTop: `1px solid ${T.border}`,
    padding: 6,
    display: 'flex',
  } satisfies CSSProperties,
  action: {
    flex: 1,
    padding: '6px 8px',
    fontSize: 12,
    fontWeight: 500,
    lineHeight: '18px',
    cursor: 'pointer',
    border: `1px dashed ${T.border2}`,
    borderRadius: 8,
    background: 'transparent',
    color: T.accent,
    textAlign: 'center',
    font: 'inherit',
  } satisfies CSSProperties,
};

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

  // 成员库列表：打开时拉一次（面板内已有更完整的增删流程，这里只做快照）。
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
    <div
      ref={panelRef}
      role="dialog"
      aria-label="团队与成员"
      data-eteams="popup"
      style={{
        ...S.card,
        position: 'fixed',
        zIndex: 1000,
        ...(pos ?? { visibility: 'hidden' }),
      }}
    >
      <div style={S.tabHeader}>
        <button type="button" style={S.tabBtn(tab === 'team')} onClick={() => setTab('team')}>
          团队{teams.length > 0 ? ` · ${teams.length}` : ''}
        </button>
        <button type="button" style={S.tabBtn(tab === 'member')} onClick={() => setTab('member')}>
          成员{roster !== null && roster.length > 0 ? ` · ${roster.length}` : ''}
        </button>
      </div>

      <div style={S.list}>
        {tab === 'team' ? (
          teams.length === 0 ? (
            <div style={S.empty}>
              {state.error !== null ? `状态加载失败：${state.error}` : '还没有团队——点下方「新增团队」创建。'}
            </div>
          ) : (
            teams.map((t) => {
              const isTeamSelected = selectedTeam?.teamId === t.teamId;
              return (
                <button
                  key={t.teamId}
                  type="button"
                  className="eteams-ets-row"
                  data-selected={isTeamSelected ? 'true' : undefined}
                  style={S.row}
                  onClick={() => onSelectTeam({ teamId: t.teamId, name: t.name })}
                  // Static title（防闪烁）：切换选中时 title 不变，原生 tooltip
                  // 不会在指针下重弹。
                  title={`${t.name} · ${t.goal}`}
                >
                  <span style={S.rowName}>{t.name}</span>
                  {isTeamSelected ? (
                    <span style={S.rowMeta}>已选</span>
                  ) : (
                    <span style={S.rowMeta}>
                      {PHASE_LABELS[t.phase] ?? t.phase} · {t.progress.completed}/{t.progress.total}
                    </span>
                  )}
                </button>
              );
            })
          )
        ) : roster === null ? (
          <div style={S.empty}>成员库加载中…</div>
        ) : roster.length === 0 ? (
          <div style={S.empty}>成员库为空——点下方「新增成员」创建。</div>
        ) : (
          roster.map((m) => {
            const isSelected = selectedMember?.name === m.name;
            return (
              <button
                key={m.name}
                type="button"
                className="eteams-ets-row"
                data-selected={isSelected ? 'true' : undefined}
                style={S.row}
                onClick={() => onSelectMember(m)}
                // Static title（防闪烁）：同上——title 随选中变化会让原生
                // tooltip 在指针下重弹一次。
                title={`${m.name} · ${m.role}（点击选中/取消，对话将以该角色输出）`}
              >
                <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} size={22} />
                <span style={S.rowName}>{m.name}</span>
                {isSelected && <span style={S.rowMeta}>已选</span>}
              </button>
            );
          })
        )}
        {tab === 'member' && rosterError && <div style={S.err}>成员库加载失败（稍后重试）</div>}
        {tab === 'member' && selectedMember !== null && (
          <div style={S.hint}>对话将以「{selectedMember.name}」的角色输出（再次点击该成员可取消）。</div>
        )}
        {tab === 'team' && selectedTeam !== null && (
          <div style={S.hint}>已选「{selectedTeam.name}」（再次点击该团队可取消）。</div>
        )}
      </div>

      <div style={S.footer}>
        {tab === 'team' ? (
          <button type="button" style={S.action} onClick={addTeam}>
            ＋ 新增团队
          </button>
        ) : (
          <button type="button" style={S.action} onClick={addMember}>
            ＋ 新增成员
          </button>
        )}
      </div>
    </div>
  );
}
