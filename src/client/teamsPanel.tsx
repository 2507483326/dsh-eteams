/**
 * The smart entry into the 团队面板 plus its full-page surface.
 *
 * The host renders the real conversation mode (the 对话/团队 tab ring and the
 * view area) only after the current session has left the pristine blank
 * state — and that phase machine flips exclusively through a real
 * `Session.prompt()` (the sticky promptAttempted flag; slash commands and
 * every other plugin-reachable API leave it untouched, and auto-sending a
 * prompt is off the table). A plugin therefore cannot make the host show its
 * tab ring on the not-started screen. {@link enterTeamsPanel} picks the
 * landing surface instead:
 *
 * 1. the real 团队 tab when it is visible (in-conversation) — the sanctioned
 *    `actions.setView` path;
 * 2. otherwise the full-page 团队页: the whole {@link ETeamsView} on a
 *    plugin-owned fixed layer that fills the app's CONTENT PANE — measured
 *    live from the hero row's ancestor chain, so the page never covers the
 *    host's left rail or top chrome. Own top strip （返回 button, Esc to
 *    leave）; the panel fills the remaining width (block wrapper — the view
 *    root is a fluid flex row, not a fixed-width card). This is what the
 *    hero button（标准模式 neighbor）and the composer popup land on while the
 *    conversation has not started.
 *
 * Pending jump signals (新增团队 / 新增成员 / select-team) are staged BEFORE
 * either surface opens, so the panel consumes them on mount — the same
 * mount-time consumption pattern as openMemberBuilder (docs/19.16).
 *
 * @module dsh-eteams/client/teamsPanel
 */
import { useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  activateETeamsTab,
  stageTeamSignals,
  teamsTabVisible,
} from './bridge';
import { ClientErrorBoundary, recordClientDiag } from './diagnostics';
import { ETeamsView, T } from './eteamsView';
import { HERO_ROW_SELECTOR } from './heroTeamsButton';

/** Landing options for {@link enterTeamsPanel}: which panel view to open. */
export interface TeamsPanelOptions {
  /** Land on the 团队 tab (its page hosts the 新建团队 form). */
  readonly creator?: boolean;
  /** Open the 新增成员 flow (panel 成员 tab with the build workbench). */
  readonly memberBuilder?: boolean;
  /** Land on the 成员 tab (roster page, no add form). */
  readonly roster?: boolean;
  /** Select this team after landing (teamId). */
  readonly teamId?: string;
}

let overlayRoot: { render: (node: ReactNode) => void; unmount: () => void } | null = null;
let overlayContainer: HTMLDivElement | null = null;

/**
 * Enter the 团队面板: stage the requested signals, then activate the real
 * 团队 tab when the host renders it visibly, else open the full-page
 * 团队页.
 */
export function enterTeamsPanel(opts: TeamsPanelOptions = {}): void {
  stageTeamSignals(opts);
  if (teamsTabVisible()) {
    activateETeamsTab();
    return;
  }
  openTeamsOverlay();
}

/**
 * Open the full-page 团队页 (idempotent while open): the full ETeamsView on
 * a plugin-owned fixed layer inset to the app's content pane, mounted
 * through a lazy React root on `<body>` so it works on the not-started
 * screen where the host view ring does not render. The root is kept for the
 * page lifetime; closing just renders null.
 */
export function openTeamsOverlay(): void {
  if (typeof document === 'undefined') return;
  try {
    if (overlayContainer === null) {
      overlayContainer = document.createElement('div');
      overlayContainer.setAttribute('data-eteams', 'overlay-root');
      document.body.appendChild(overlayContainer);
    }
    if (overlayRoot === null) overlayRoot = createRoot(overlayContainer);
    overlayRoot.render(
      <ClientErrorBoundary label="团队页">
        <TeamsOverlay onClose={() => overlayRoot?.render(null)} />
      </ClientErrorBoundary>,
    );
  } catch (error) {
    recordClientDiag('overlay', error instanceof Error ? error.message : String(error));
  }
}

/** A viewport-anchored rectangle in plain numbers (fixed positioning input). */
interface PaneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const windowRect = (): PaneRect => ({
  left: 0,
  top: 0,
  width: window.innerWidth,
  height: window.innerHeight,
});

/**
 * Measure the app's content pane live: walk up from the hero row (the only
 * reliable not-started landmark) to the widest ancestor that is NOT the
 * full-window app shell. That ancestor is the conversation pane — already
 * inset by the host's left rail and top chrome — so the page docks to it
 * without covering either. Falls back to the whole window when no hero row
 * exists or the pane itself spans the window.
 */
function measurePane(): PaneRect {
  const full = windowRect();
  try {
    const row = document.querySelector(HERO_ROW_SELECTOR);
    let el: HTMLElement | null = row instanceof HTMLElement ? row : null;
    let best: PaneRect | null = null;
    while (el !== null) {
      const r = el.getBoundingClientRect();
      const shell =
        r.left <= 1 && r.top <= 1 && r.right >= full.width - 1 && r.bottom >= full.height - 1;
      if (shell) break;
      if (r.width >= 320 && r.height >= 200 && (best === null || r.width > best.width)) {
        best = { left: r.left, top: r.top, width: r.width, height: r.height };
      }
      el = el.parentElement;
    }
    return best ?? full;
  } catch (error) {
    recordClientDiag('overlay-pane', error instanceof Error ? error.message : String(error));
    return full;
  }
}

/**
 * The full-page 团队页: a fixed layer inset to the measured content pane
 * (opaque app background, own top strip) — reads as a page switch, never
 * covers the host's left rail or top chrome, and re-docks on window resize.
 */
function TeamsOverlay({ onClose }: { onClose: () => void }): ReactNode {
  const [pane, setPane] = useState<PaneRect>(measurePane);
  useEffect(() => {
    const onResize = (): void => {
      setPane(measurePane());
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="团队"
      data-eteams="overlay-page"
      style={{
        position: 'fixed',
        left: pane.left,
        top: pane.top,
        width: pane.width,
        height: pane.height,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        background: T.bg,
        color: T.text,
      }}
    >
      <header
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: 48,
          padding: '0 16px',
          borderBottom: `1px solid ${T.border}`,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600 }}>团队</span>
        <span style={{ fontSize: 12, color: T.text3 }}>
          开始对话后，这里也会作为「团队」标签页出现在顶栏
        </span>
        <div style={{ flex: 1 }} />
        <Button variant="outline" size="sm" onClick={onClose}>
          返回
        </Button>
      </header>
      {/* Plain block wrapper: the view root is `height:100%` + flex row and
      has no width of its own — a block parent lets it fill the pane width
      instead of shrink-wrapping to its content (the "定死宽度" artifact).
      overflow hidden keeps tall content scrolling inside the view column —
      never spilling to the document (横向滚动条治理). */}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>
        {/* The panel only reads sessionId/inputActions off its slot props; the
        page has neither (no session on the not-started screen), so a minimal
        share is cast in — the panel degrades to the all-teams pool and
        clipboard prefill, both sanctioned fallbacks. */}
        <ETeamsView {...({ sessionId: undefined } as unknown as ConvViewProps)} />
      </div>
    </div>
  );
}
