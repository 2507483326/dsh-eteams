/**
 * The smart entry into the 团队面板 plus its full-screen overlay surface.
 *
 * The host only renders the conversation view ring (对话/团队 tabs) once a
 * session has visible content — while the conversation has not started the
 * whole view area is null and the header chrome is hidden, so clicking the
 * (still present but invisible) tab would silently do nothing.
 * {@link enterTeamsPanel} therefore picks the landing surface:
 *
 * 1. the real 团队 tab when it is visible (in-conversation) — the sanctioned
 *    `actions.setView` path;
 * 2. otherwise the overlay panel: the full {@link ETeamsView} in a headless
 *    Modal, mounted through a plugin-owned React root on `<body>`. This is
 *    what the hero button (标准模式 neighbor) and the composer popup land on
 *    for a not-yet-started conversation.
 *
 * Pending jump signals (新增团队 / 新增成员 / select-team) are staged BEFORE
 * either surface opens, so the panel consumes them on mount — the same
 * mount-time consumption pattern as openMemberBuilder (docs/19.16).
 *
 * @module dsh-eteams/client/teamsPanel
 */
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  activateETeamsTab,
  stageTeamSignals,
  teamsTabVisible,
} from './bridge';
import { ClientErrorBoundary, recordClientDiag } from './diagnostics';
import { ETeamsView, T } from './eteamsView';

/** Landing options for {@link enterTeamsPanel}: which panel view to open. */
export interface TeamsPanelOptions {
  /** Open the 新增团队 flow (panel 团队 tab with the creation form). */
  readonly creator?: boolean;
  /** Open the 新增成员 flow (panel 成员 tab with the build workbench). */
  readonly memberBuilder?: boolean;
  /** Select this team after landing (teamId). */
  readonly teamId?: string;
}

let overlayRoot: { render: (node: ReactNode) => void; unmount: () => void } | null = null;
let overlayContainer: HTMLDivElement | null = null;

/**
 * Enter the 团队面板: stage the requested signals, then activate the real
 * 团队 tab when the host renders it visibly, else open the overlay panel.
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
 * Open the 团队面板 overlay (idempotent while open): the full ETeamsView in
 * a headless Modal, mounted on a plugin-owned root so it works on the
 * not-started screen where the host view ring does not render. The root is
 * created lazily and kept for the page lifetime; closing just renders null.
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
      <ClientErrorBoundary label="团队面板浮层">
        <TeamsOverlay onClose={() => overlayRoot?.render(null)} />
      </ClientErrorBoundary>,
    );
  } catch (error) {
    recordClientDiag('overlay', error instanceof Error ? error.message : String(error));
  }
}

/** The overlay body: headless Modal hosting the whole panel at a usable size. */
function TeamsOverlay({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <Modal open onClose={onClose} title="团队" closeLabel="关闭" headless>
      <div
        style={{
          width: 'min(980px, 92vw)',
          height: 'min(680px, 80vh)',
          display: 'flex',
          background: T.bg,
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        {/* The panel only reads sessionId/inputActions off its slot props; the
        overlay has neither (no session on the not-started screen), so a
        minimal share is cast in — the panel degrades to the all-teams pool
        and clipboard prefill, both sanctioned fallbacks. */}
        <ETeamsView {...({ sessionId: undefined } as unknown as ConvViewProps)} />
      </div>
    </Modal>
  );
}
