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
const ETEAMS_DATA_ATTR = 'data-eteams';

/** Selectors whose subtrees must never be treated as the view tab. */
const EXCLUDED_ANCESTORS = `[${ETEAMS_DATA_ATTR}],[role="menu"],[role="dialog"],[role="listbox"]`;

/** Custom window event: a surface asks the panel to open the member builder. */
export const GOTO_ADD_EVENT = 'eteams:goto-add';

/** Custom window event: select one team in the panel (CustomEvent detail: teamId). */
export const SELECT_TEAM_EVENT = 'eteams:select-team';

/** Custom window event: a surface asks the panel to open the 成员 tab (roster page). */
export const GOTO_ROSTER_EVENT = 'eteams:goto-roster';

/** Custom window event: a surface asks the panel to open the 团队 page (card grid). */
export const GOTO_TEAM_EVENT = 'eteams:goto-team';

/** Custom window event: a surface asks the panel to open the Tasks page (CustomEvent detail: taskId). */
export const GOTO_TASK_EVENT = 'eteams:goto-task';

/** Custom window event: a surface asks the full-page 团队页 overlay to close. */
export const CLOSE_TEAMS_PAGE_EVENT = 'eteams:close-page';

/**
 * Pending jump signal (module level): openMemberBuilder fires BEFORE the
 * host tab switches, so ETeamsView is often not yet mounted and would miss
 * the window event — it consumes this flag on mount instead. One-shot.
 */
let pendingGotoAdd = false;

/** Pending 成员-tab jump signal — same mount-time consumption. */
let pendingGotoRoster = false;

/** Pending 团队-page jump signal — same mount-time consumption. */
let pendingGotoTeam = false;

/** Pending team selection (teamId) — consumed once on panel mount. */
let pendingSelectTeam: string | null = null;

/** Pending tasks-page jump (taskId) — same mount-time consumption. */
let pendingGotoTask: number | null = null;

/** Whether a jump request is waiting; consumes it (one-shot). */
export function consumePendingGotoAdd(): boolean {
  const value = pendingGotoAdd;
  pendingGotoAdd = false;
  return value;
}

/** Whether a 成员-tab jump is waiting; consumes it (one-shot). */
export function consumePendingGotoRoster(): boolean {
  const value = pendingGotoRoster;
  pendingGotoRoster = false;
  return value;
}

/** Whether a 团队-page jump is waiting; consumes it (one-shot). */
export function consumePendingGotoTeam(): boolean {
  const value = pendingGotoTeam;
  pendingGotoTeam = false;
  return value;
}

/** The pending team selection, if any; consumes it (one-shot). */
export function consumePendingSelectTeam(): string | null {
  const value = pendingSelectTeam;
  pendingSelectTeam = null;
  return value;
}

/** The pending task-page target, if any; consumes it (one-shot). */
export function consumePendingGotoTask(): number | null {
  const value = pendingGotoTask;
  pendingGotoTask = null;
  return value;
}

/** Dispatch a window CustomEvent when a DOM/window exists (best effort). */
function dispatchSignal(name: string, detail?: string | number): void {
  if (typeof window !== 'undefined' && typeof window.CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent(name, detail === undefined ? undefined : { detail }));
  }
}

/**
 * Stage the cross-component jump signals WITHOUT clicking any tab: pending
 * flags for the about-to-mount panel, window events for the mounted one.
 * Splitting this from the tab click lets callers decide the landing surface
 * (real 团队 tab when visible, full-page 团队页 otherwise).
 */
export function stageTeamSignals(
  opts: {
    memberBuilder?: boolean;
    roster?: boolean;
    /** Land on the 团队 page（/team，卡片栅格，不开新增弹窗）。 */
    team?: boolean;
    teamId?: string;
    /** Open the Tasks page（/tasks/:taskId）on landing. */
    taskId?: number;
  } = {},
): void {
  if (opts.memberBuilder === true) {
    pendingGotoAdd = true;
    dispatchSignal(GOTO_ADD_EVENT);
  }
  if (opts.roster === true) {
    pendingGotoRoster = true;
    dispatchSignal(GOTO_ROSTER_EVENT);
  }
  if (opts.team === true) {
    pendingGotoTeam = true;
    dispatchSignal(GOTO_TEAM_EVENT);
  }
  if (opts.teamId !== undefined) {
    pendingSelectTeam = opts.teamId;
    dispatchSignal(SELECT_TEAM_EVENT, opts.teamId);
  }
  if (opts.taskId !== undefined) {
    pendingGotoTask = opts.taskId;
    dispatchSignal(GOTO_TASK_EVENT, opts.taskId);
  }
}

/**
 * Ask the full-page 团队页 overlay（teamsPanel 的 dialog 层）to close — the
 * counterpart of {@link stageTeamSignals} for the reverse direction. The
 * overlay subscribes to {@link CLOSE_TEAMS_PAGE_EVENT}; when it is not open
 * nobody is listening and the dispatch is a no-op（对话内 tab 场景零副作用）.
 * 页内「新增角色→填充」成功后即发（用户迭代 2026-09-09）：命令已落对话
 * 输入框，整页弹窗继续盖着输入框反而挡路——关页让用户直接看到输入框。
 */
export function requestCloseTeamsPage(): void {
  dispatchSignal(CLOSE_TEAMS_PAGE_EVENT);
}

/**
 * Activate the 团队 tab AND open the member-builder workbench
 * （成员 → 新增）：fires the cross-component signal first, then clicks the
 * host tab. The card in the conversation uses this for its click-through.
 * Both paths covered: the window event for the already-mounted panel, the
 * pending flag for the about-to-mount panel (tab click → remount).
 *
 * @returns whether the tab element was found and clicked.
 */
export function openMemberBuilder(): boolean {
  pendingGotoAdd = true;
  if (typeof window !== 'undefined' && typeof window.CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent(GOTO_ADD_EVENT));
  }
  return activateETeamsTab();
}

/**
 * Activate the 团队 tab AND open the Tasks page for one task（/tasks/:taskId）—
 * the {@link openMemberBuilder} pattern for the 任务 surface. The
 * "task created" conversation card uses this for its click-through (用户迭代
 * 2026-09-12「任务创建好后，主会话应该有一个卡片让用户跳转到任务页面」）。
 * Both paths covered: the window event for the already-mounted panel, the
 * pending flag for the about-to-mount panel (tab click → remount).
 *
 * @returns whether the tab element was found and clicked.
 */
export function openTask(taskId: number): boolean {
  pendingGotoTask = taskId;
  dispatchSignal(GOTO_TASK_EVENT, taskId);
  return activateETeamsTab();
}

/**
 * Activate the conversation (对话) view — the counterpart of
 * {@link activateETeamsTab} for going back to the chat while a build runs.
 * Strategy: click the host tab whose label is 对话; if the labels differ,
 * click the first tab that is not the eteams panel; final fallback is the
 * first visible tab (the chat is the ring's default view).
 *
 * @returns whether a tab element was found and clicked.
 */
export function activateConversationTab(): boolean {
  const tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button[role="tab"]'),
  ).filter((el) => el.offsetParent !== null && !el.closest(`[${ETEAMS_DATA_ATTR}]`));
  const byLabel = tabs.find((el) => el.textContent?.trim() === '对话');
  const notOurs = tabs.find((el) => el.textContent?.trim() !== '团队');
  const target = byLabel ?? notOurs ?? tabs[0];
  if (target === undefined) return false;
  target.click();
  return true;
}

/**
 * Find the host-rendered 团队 tab button — the sanctioned activation target
 * (`<div role="tablist"><button role="tab" onClick={() => actions.setView(id)}>`).
 * Only the first tier of {@link activateETeamsTab} (exact-label tab buttons),
 * with the same exclusions ([data-eteams] DOM, open menu/dialog/listbox).
 *
 * Exported for the 待决策红点 injector (features/activity/teamTabDot): the badge
 * must land on exactly the element this module treats as the 团队 tab, so both
 * sides share one lookup instead of forking the selector.
 */
export function findETeamsTabButton(): HTMLButtonElement | undefined {
  if (typeof document === 'undefined') return undefined;
  const excluded = (el: Element): boolean => el.closest(EXCLUDED_ANCESTORS) !== null;
  const textOf = (el: Element): string => (el.textContent ?? '').trim();
  return [...document.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(
    (el) => !excluded(el) && textOf(el) === ETEAMS_TAB_LABEL,
  );
}

/**
 * Whether the 团队 tab is not only present but VISIBLE right now. The host
 * hides the whole session header chrome while the session is blank (the
 * not-started hero screen): the tab buttons still exist in the DOM but the
 * view ring renders nothing, so clicking them would silently no-op. Callers
 * use this to pick the landing surface (tab click vs overlay panel).
 */
export function teamsTabVisible(): boolean {
  const tab = findETeamsTabButton();
  return tab !== undefined && tab.offsetParent !== null;
}

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

  const tab = findETeamsTabButton();
  if (tab !== undefined) {
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
