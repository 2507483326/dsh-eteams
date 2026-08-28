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

/** Selectors whose subtrees must never be treated as the view tab. */
const EXCLUDED_ANCESTORS = `[${ETEAMS_DATA_ATTR}],[role="menu"],[role="dialog"],[role="listbox"]`;

/**
 * Activate the 团队 view by clicking its host-rendered tab button.
 *
 * The session header renders the view ring as
 * `<div role="tablist"><button role="tab" onClick={() => actions.setView(id)}>` —
 * the real activation path. Candidates whose trimmed text equals the tab
 * label are considered in two tiers:
 * 1. `button[role="tab"]` elements (exact label match) — the sanctioned tab;
 * 2. leaf `<div>`s (legacy fallback for header variants that wrap the label).
 *
 * Anything inside our own `[data-eteams]` DOM or an open menu/dialog/listbox
 * (the composer popup portals to `<body>` after the tab ring and would
 * otherwise win the "last match") is ignored.
 *
 * @returns whether a tab element was found and clicked.
 */
export function activateETeamsTab(): boolean {
  if (typeof document === 'undefined') return false;
  const label = ETEAMS_TAB_LABEL;
  const excluded = (el: Element): boolean => el.closest(EXCLUDED_ANCESTORS) !== null;
  const textOf = (el: Element): string => (el.textContent ?? '').trim();

  const tab = [...document.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(
    (el) => !excluded(el) && textOf(el) === label,
  );
  if (tab) {
    tab.click();
    return true;
  }

  let target: HTMLElement | undefined;
  for (const el of document.querySelectorAll<HTMLElement>('div')) {
    if (el.children.length !== 0) continue;
    if (textOf(el) !== label) continue;
    if (excluded(el)) continue;
    if ((el.className ?? '') === '') continue;
    target = el;
  }
  if (target === undefined) return false;
  target.click();
  return true;
}
