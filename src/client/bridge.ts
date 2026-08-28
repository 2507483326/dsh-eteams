/**
 * Client-side shared bits: the view id, labels, and the tab-activation bridge.
 *
 * @module dsh-eteams/client/bridge
 */

/** The id of the eteams entry in the `conversation.view` tab ring. */
export const ETEAMS_VIEW_ID = 'eteams';

/** Tab label for the eteams view (zh-CN first; locale thunk lands with M5 i18n). */
export const ETEAMS_TAB_LABEL = '团队';

/**
 * Mark root elements of eteams-owned DOM so the bridge (and future panel
 * code) can exclude its own widgets when hunting for host-rendered chrome.
 */
export const ETEAMS_DATA_ATTR = 'data-eteams';

/**
 * Activate the 团队 view by clicking its host-rendered tab.
 *
 * M0 bridge: the host does not (yet) expose a sanctioned view-activation API
 * to plugins — the tab ring is owned by ui-conversation's chat store, whose
 * write surface (`actions.setView`) is private to the declaring entry. Until
 * an official seam ships, we locate the host-rendered tab button by its exact
 * label text and synthesize a click. The bridge:
 * - only considers leaf elements whose trimmed text equals the tab label,
 * - ignores anything inside `[data-eteams]` (our own button/popup uses the
 *   same wording),
 * - prefers the last match (the tab ring renders after the header row),
 * - degrades silently (returns `false`) when the tab bar is absent (e.g. the
 *   session header collapsed), leaving the UI untouched.
 *
 * @returns whether a tab element was found and clicked.
 */
export function activateETeamsTab(): boolean {
  if (typeof document === 'undefined') return false;
  const label = ETEAMS_TAB_LABEL;
  const elements = document.querySelectorAll<HTMLElement>('div');
  let target: HTMLElement | undefined;
  for (const el of elements) {
    if (el.children.length !== 0) continue;
    if ((el.textContent ?? '').trim() !== label) continue;
    if (el.closest(`[${ETEAMS_DATA_ATTR}]`) !== null) continue;
    if ((el.className ?? '') === '') continue;
    target = el;
  }
  if (target === undefined) return false;
  target.click();
  return true;
}
