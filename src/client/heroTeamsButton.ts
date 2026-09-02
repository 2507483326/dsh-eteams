/**
 * The 团队 button beside the agent-preset chip (标准模式) on the
 * conversation-not-started screen.
 *
 * The hero chip row (`ConversationRoot`'s heroWorkspaceRow) offers NO
 * additive slot for plugins: `conversation.hero.workspace` and
 * `conversation.hero.agentPreset` are both `single` seats already occupied
 * by host packages, so a slot registration would throw (same priority) or
 * shadow (replace) the host chip. The sanctioned surface therefore does not
 * exist and this module installs a DOM-injected, chip-styled button instead:
 *
 * - a MutationObserver watches the document; whenever a hero row appears
 *   (it only renders while the session is blank) and does not yet carry our
 *   marker, one button is appended AFTER the preset chip — i.e. directly
 *   beside 标准模式;
 * - the row unmounts with the hero→active phase flip (React removes the
 *   whole row including our node); the observer re-injects on the next hero
 *   render, so new-chat screens always get the button;
 * - click → the installed click handler: {@link enterTeamsPanel} (real 团队
 *   tab when the host renders it visibly, the full-screen 团队页 on the
 *   not-started screen — the host cannot render its tab ring before the
 *   session's first prompt, see teamsPanel.ts). The handler is INJECTED by
 *   the composition root so this DOM module stays free of the React import
 *   graph.
 *
 * @module dsh-eteams/client/heroTeamsButton
 */
import { recordClientDiag } from './diagnostics';

/**
 * The hero chip row. CSS-module classes are content-hashed
 * (`wSkVaW_heroWorkspaceRow`), but the composed name keeps the original key
 * as a suffix, so a substring attribute selector survives rehashing.
 * Exported: the 团队页 pane measurement walks up from this landmark.
 */
export const HERO_ROW_SELECTOR = 'div[class*="heroWorkspaceRow"]';

/** Marker attribute value for the injected button (idempotent injection). */
const BUTTON_FLAG = 'hero-button';

/** id of the one-shot <style> element carrying the chip styles. */
const STYLE_ID = 'eteams-hero-button-style';

/** Chip styling mirrors the host preset chip (`.cubgiG_seat`), token-driven
 * (docs/25 D23-6 缩档：用户反馈「团队按钮太大」——h 24px / 12px 字 / 8px
 * 横距；focus 环随 --ring 官网 sky，兜底字色官网 slate-900 档). */
const HERO_BUTTON_CSS = `
.eteams-hero-btn{max-width:min(100%,200px);min-height:24px;color:var(--foreground,#0f172a);white-space:nowrap;cursor:pointer;background:transparent;border:none;border-radius:14px;align-items:center;gap:4px;padding:0 8px;font-size:12px;font-weight:500;line-height:18px;display:inline-flex;font-family:inherit;overflow:hidden}
.eteams-hero-btn:hover{background:var(--muted,rgba(100,116,139,0.08))}
.eteams-hero-btn:focus-visible{outline:2px solid var(--ring,#0ea5e9);outline-offset:1px}
`;

let installed = false;

/**
 * Install the hero-button injector once per page. `onClick` is what a click
 * on the injected button does (the composition root wires it to the panel
 * entry). No-op outside a browser and on repeated calls; every failure is
 * recorded, never fatal.
 */
export function installHeroTeamsButton(onClick: () => void): void {
  if (installed || typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return;
  }
  installed = true;
  try {
    ensureStyle();
    const observer = new MutationObserver(() => {
      scanForHeroRow(onClick);
    });
    const root = document.body ?? document.documentElement;
    if (root !== null && root !== undefined) {
      observer.observe(root, { childList: true, subtree: true });
    }
    scanForHeroRow(onClick);
  } catch (error) {
    recordClientDiag('hero-button', error instanceof Error ? error.message : String(error));
  }
}

/** Inject the stylesheet once (same pattern as the host plugin CSS tags). */
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return;
  const tag = document.createElement('style');
  tag.id = STYLE_ID;
  tag.textContent = HERO_BUTTON_CSS;
  document.head.appendChild(tag);
}

/** Scan for hero rows and inject into each one missing the button. */
function scanForHeroRow(onClick: () => void): void {
  try {
    const rows = document.querySelectorAll<HTMLElement>(HERO_ROW_SELECTOR);
    for (const row of rows) ensureHeroButton(row, onClick);
  } catch (error) {
    recordClientDiag('hero-button-scan', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Append the 团队 button to one hero row (after the preset chip). Idempotent:
 * returns false when the row already carries the marker. Exported for tests.
 *
 * @returns whether a button was injected.
 */
export function ensureHeroButton(row: HTMLElement, onClick: () => void): boolean {
  try {
    if (row.querySelector(`[data-eteams="${BUTTON_FLAG}"]`) !== null) return false;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'eteams-hero-btn';
    button.setAttribute('data-eteams', BUTTON_FLAG);
    button.setAttribute('aria-label', '团队');
    button.textContent = '团队';
    button.addEventListener('click', () => {
      try {
        onClick();
      } catch (error) {
        recordClientDiag('hero-button-click', error instanceof Error ? error.message : String(error));
      }
    });
    row.appendChild(button);
    return true;
  } catch (error) {
    recordClientDiag('hero-button-inject', error instanceof Error ? error.message : String(error));
    return false;
  }
}
