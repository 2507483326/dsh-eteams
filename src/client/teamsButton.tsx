/**
 * The 团队 button in the composer tool row (`conversation.input.right`).
 *
 * The popup is a small tabbed card — 团队 | 成员 — listing the session's
 * teams (live, via the shared activity monitor) and the member-library
 * roster, with one creation shortcut pinned to the footer of each tab:
 *
 * - 「＋ 新增团队」 jumps straight to the 团队 tab page (real host tab when
 *   visible, the full overlay panel otherwise) with the creation form open;
 * - 「＋ 新增成员」 prefills the `eTeam --add-people` command into the
 *   composer draft (never auto-send; clipboard fallback) and jumps to the
 *   member-builder view of the 团队 tab page (D18-1).
 *
 * Team rows jump to the panel with that team selected. When the slot's
 * `inputActions` kit is unavailable the member prefill degrades to
 * clipboard copy.
 *
 * @module dsh-eteams/client/teamsButton
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Button,
  useAnchoredPosition,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { ADD_PEOPLE_TEMPLATE, prefillComposer } from './addPeople';
import { PHASE_LABELS, T } from './eteamsView';
import { ClientErrorBoundary } from './diagnostics';
import { enterTeamsPanel } from './teamsPanel';
import { fetchRoster, type RosterMember } from './api';
import { useActivityMonitor } from './monitor';

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

  return (
    <ClientErrorBoundary label="团队按钮">
      <div ref={setAnchorEl} style={{ display: 'inline-flex', alignItems: 'center' }} data-eteams="button">
        <Button
          variant="ghost"
          size="sm"
          aria-label="团队"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          团队
        </Button>
        {open && anchorEl !== null && typeof document !== 'undefined' ? (
          createPortal(
            <TeamsPopup
              anchor={anchorEl}
              inputActions={props.inputActions}
              onClose={() => setOpen(false)}
            />,
            document.body,
          )
        ) : null}
      </div>
    </ClientErrorBoundary>
  );
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
    background: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
    color: T.text,
  } satisfies CSSProperties,
  rowName: {
    fontWeight: 500,
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
 * in-place surface) and fixed-positioned under the trigger.
 */
function TeamsPopup(props: {
  anchor: HTMLElement;
  inputActions?: { setDraft: (text: string) => void };
  onClose: () => void;
}): ReactNode {
  const { anchor, onClose } = props;
  const [tab, setTab] = useState<'team' | 'member'>('team');
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Stable RefObject view of the anchor element (useAnchoredPosition keys its
  // effect on the ref identity — a fresh object per render would loop it).
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);
  const position = useAnchoredPosition({
    open: true,
    anchorRef,
    panelRef,
    gap: 6,
    margin: 8,
  });
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

  const openTeam = (teamId: string): void => {
    onClose();
    enterTeamsPanel({ teamId });
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
        ...(position ?? { left: anchor.getBoundingClientRect().left, top: anchor.getBoundingClientRect().bottom + 6 }),
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
            teams.map((t) => (
              <button
                key={t.teamId}
                type="button"
                style={S.row}
                onClick={() => openTeam(t.teamId)}
                title={`${t.goal}（点击进入团队面板）`}
              >
                <span style={S.rowName}>{t.name}</span>
                <span style={S.rowMeta}>
                  {PHASE_LABELS[t.phase] ?? t.phase} · {t.progress.completed}/{t.progress.total}
                </span>
              </button>
            ))
          )
        ) : roster === null ? (
          <div style={S.empty}>成员库加载中…</div>
        ) : roster.length === 0 ? (
          <div style={S.empty}>成员库为空——点下方「新增成员」创建。</div>
        ) : (
          roster.map((m) => (
            <div key={m.name} style={{ ...S.row, cursor: 'default' }}>
              <span style={S.rowName}>{m.name}</span>
              <span style={S.rowMeta}>{m.role}</span>
            </div>
          ))
        )}
        {tab === 'member' && rosterError && <div style={S.err}>成员库加载失败（稍后重试）</div>}
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
