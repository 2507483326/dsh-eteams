/**
 * The `/eteam` command template (docs/19.4, D18-1) and the shared one-click
 * prefill helper for conversational member building. React-free so tests
 * can import it under plain vitest; the DOM helpers are best-effort and
 * silently degrade outside a browser.
 *
 * @module dsh-eteams/client/addPeople
 */

/** The /eteam slash command name (DSH command names are lowercase). */
export const ADD_PEOPLE_COMMAND = 'eteam';

/**
 * Full prefill template with user-visible placeholders (docs/19.4): starts
 * with the registered slash command so the composer command menu/dispatch
 * picks it up.
 */
export const ADD_PEOPLE_TEMPLATE = `/${ADD_PEOPLE_COMMAND} --add-people 我需要创建一个成员 【成员名称】，它的职责是【职责】。`;

/** Outcome of one prefill attempt (docs/19.7.1). */
export type PrefillOutcome = 'set' | 'copied' | 'aborted';

/**
 * The one-click prefill (D18-1), simulating the native typing gesture:
 *
 * 1. Official write path — `inputActions.setDraft` writes the "claim form"
 *    (`/eteam` glued to the args, no separator yet), so the text is
 *    guaranteed to land even if the simulated events are swallowed.
 * 2. Simulated typing — native value setter (bypasses React's value
 *    tracker) + caret inside the `/eteam` token + a bubbling `input` event:
 *    the composer's own `onChange` re-runs slash detection, which opens the
 *    trigger menu and highlights the token.
 * 3. Space claim — a synthetic `keydown(" ")`: DSH's decision table claims
 *    a leading known command on space (`claim.token = "/eteam "`), the
 *    machine re-adopts the draft as `token + rest`, which lands exactly on
 *    the canonical template — claimed phase, highlighted command, args
 *    intact. Never auto-submits (N1).
 *
 * Fallbacks: no `inputActions` → clipboard; the claim failing (cold command
 * directory, busy machine) → a repair pass rewrites the canonical template
 * so the plain-text path stays sendable.
 */
export function prefillComposer(
  inputActions: { setDraft: (text: string) => void } | undefined,
): PrefillOutcome {
  if (inputActions === undefined || typeof inputActions.setDraft !== 'function') {
    void writeClipboardSafe(ADD_PEOPLE_TEMPLATE);
    return 'copied';
  }
  const current = composerDraft();
  if (current.trim() !== '' && current !== ADD_PEOPLE_TEMPLATE) {
    if (!window.confirm('将覆盖输入框中未发送的草稿？')) return 'aborted';
  }
  const head = 1 + ADD_PEOPLE_COMMAND.length; // `/eteam` 词尾（空格之前）
  const claimForm = `${ADD_PEOPLE_TEMPLATE.slice(0, head)}${ADD_PEOPLE_TEMPLATE.slice(head + 1)}`;
  inputActions.setDraft(claimForm);
  withComposerTextarea((el) => {
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter === undefined) return;
    setter.call(el, claimForm);
    try {
      el.setSelectionRange(head, head); // 光标停在命令词内 → 斜杠检测命中
    } catch {
      // 无焦点选区容错：仅失去检测窗口。
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  });
  window.setTimeout(() => {
    if (!composerDraft().startsWith(`/${ADD_PEOPLE_COMMAND} `)) {
      withComposerTextarea((el) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter === undefined) return;
        setter.call(el, ADD_PEOPLE_TEMPLATE);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
  }, 150);
  return 'set';
}

/** Best-effort composer access: the last visible textarea is the composer. */
function withComposerTextarea(fn: (el: HTMLTextAreaElement) => void): void {
  try {
    const visible = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea')).filter(
      (el) => el.offsetParent !== null,
    );
    const target = visible.at(-1);
    if (target !== null && target !== undefined) fn(target);
  } catch {
    // 无 DOM/沙箱环境静默降级（docs/19.7.1）
  }
}

/** Best-effort read of the composer draft (override-confirm guard). */
function composerDraft(): string {
  let value = '';
  withComposerTextarea((el) => {
    value = el.value;
  });
  return value;
}

/** Clipboard fallback that never throws (面板/按钮两条路径共用). */
function writeClipboardSafe(text: string): void {
  try {
    void navigator.clipboard.writeText(text).catch(() => undefined);
  } catch {
    // 无剪贴板权限时静默降级
  }
}
