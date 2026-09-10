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
 *
 * 模板副本（docs/38）：host 平面同款契约在 src/host/commands/eteam.ts
 * （ADD_PEOPLE_COMMAND / ADD_PEOPLE_BARE_BODY）。tsconfig host/client 平面
 * rootDir 隔离，不能共享模块——两侧各留一份，改动命令文案时必须两处同步。
 */
export const ADD_PEOPLE_TEMPLATE = `/${ADD_PEOPLE_COMMAND} --add-people 我需要创建一个成员 【成员名称】，它的职责是【职责】。`;

/** Outcome of one prefill attempt (docs/19.7.1). */
export type PrefillOutcome = 'set' | 'copied' | 'aborted';

/** The composer write face prefill needs (session standard kit `inputActions`). */
export interface InputActionsFace {
  setDraft: (text: string) => void;
}

/**
 * inputActions 捕获桥（模块级单例）：会话标准 kit 只发给会话作用域槽位组件
 * （登记方 TeamsButton 所在的 conversation.input.right——hero 与对话内
 * composer 工具行都挂载它），整页团队页弹窗里的 ETeamsView 是独立 React
 * 根、拿不到 kit prop。挂载时登记、卸载时注销（同引用才清，防多表面
 * 错杀）；prefillComposer 按「实参 → 捕获」回退解析——setDraft 是官方写路，
 * 落的是机器状态，比合成 DOM 事件可靠。
 */
let capturedInputActions: InputActionsFace | null = null;

/** Register the session kit's input actions on mount; returns the unregistrar. */
export function captureInputActions(actions: InputActionsFace | undefined): () => void {
  if (actions === undefined || typeof actions.setDraft !== 'function') return () => undefined;
  capturedInputActions = actions;
  return () => {
    if (capturedInputActions === actions) capturedInputActions = null;
  };
}

/** The most recent live capture, if any（无登记返回 undefined）. */
export function peekCapturedInputActions(): InputActionsFace | undefined {
  return capturedInputActions ?? undefined;
}

/**
 * The one-click prefill (D18-1): land the canonical `/eteam --add-people …`
 * template in the conversation composer and focus it. Never auto-submits (N1).
 *
 * Write paths by priority:
 *
 * 1. Slot kit (`inputActions` arg — in-conversation tab, composer live): the
 *    claim dance — `setDraft` writes the glued "claim form", then simulated
 *    typing (native value setter + bubbling `input` event) re-runs the
 *    composer's own slash detection and a synthetic space keydown claims the
 *    leading command (`claim.token = "/eteam "`), which re-adopts the draft
 *    as exactly the canonical template with the command highlighted.
 * 2. Capture bridge (整页团队页弹窗 — overlay's ETeamsView has no kit):
 *    `setDraft` writes the canonical template DIRECTLY. What setDraft writes
 *    is the send text, and the not-started hero's locked composer ignores
 *    synthetic events — the claim dance could never complete there, so the
 *    glued form would go out as-is and the command name would fail to parse
 *    （2026-09-10 用户反馈「填充后没有调用到插件」）. Canonical is sendable
 *    on plain enter.
 * 3. Simulated typing only（两路 kit 皆空的罕见兜底）: native value setter +
 *    `input` event with the canonical template; a 150ms repair pass rewrites
 *    it if the synthetic event was swallowed.
 * 4. Clipboard — no live composer textarea at all.
 */
export function prefillComposer(
  inputActions: InputActionsFace | undefined,
): PrefillOutcome {
  // 写路解析：槽位实参优先（对话内页签），回落捕获桥（整页团队页弹窗）。
  const slotActions =
    inputActions !== undefined && typeof inputActions.setDraft === 'function'
      ? inputActions
      : undefined;
  const actions = slotActions ?? peekCapturedInputActions();
  if (actions === undefined && !composerLive()) {
    void writeClipboardSafe(ADD_PEOPLE_TEMPLATE);
    return 'copied';
  }
  const current = composerDraft();
  if (current.trim() !== '' && current !== ADD_PEOPLE_TEMPLATE) {
    if (!window.confirm('将覆盖输入框中未发送的草稿？')) return 'aborted';
  }
  if (slotActions === undefined && actions !== undefined) {
    // 捕获桥写路：官方 setDraft 直接落规范模板（带空格、回车即派发）——
    // 弹窗盖着的 composer 在未开始 hero 上是锁定态，onChange/claim 对合成
    // 事件不响应，claim form 的粘连文本（/eteam--add-people）会原样滞留
    // 并被发出，命令名解析失败。规范模板写进机器即发送文本，不依赖 claim。
    actions.setDraft(ADD_PEOPLE_TEMPLATE);
    withComposerTextarea((el) => el.focus());
    return 'set';
  }
  if (slotActions !== undefined) {
    // 槽位写路（对话内页签，composer 活跃）：claim 舞蹈走原路——粘连态 +
    // 合成空格键让 composer 自己的斜杠检测完成 claim，末态 = 规范模板 +
    // 命令高亮。
    const head = 1 + ADD_PEOPLE_COMMAND.length; // `/eteam` 词尾（空格之前）
    const claimForm = `${ADD_PEOPLE_TEMPLATE.slice(0, head)}${ADD_PEOPLE_TEMPLATE.slice(head + 1)}`;
    slotActions.setDraft(claimForm);
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
    scheduleClaimRepair();
    return 'set';
  }
  // 无 kit 兜底：native setter 直接落规范模板 + 冒泡 input 事件，修复窗兜底。
  withComposerTextarea((el) => el.focus());
  writeTemplateViaDom(ADD_PEOPLE_TEMPLATE);
  scheduleClaimRepair();
  return 'set';
}

/** 经原生 value setter（绕过 React value tracker）把文本写进 composer DOM。 */
function writeTemplateViaDom(text: string): void {
  withComposerTextarea((el) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter === undefined) return;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * 修复窗：合成 input 事件被吞时 150ms 后重写规范模板，保住纯文本发送路径。
 * 无 window 环境（纯 node 单测）无从排程，静默跳过。
 */
function scheduleClaimRepair(): void {
  if (typeof window === 'undefined') return;
  window.setTimeout(() => {
    if (!composerDraft().startsWith(`/${ADD_PEOPLE_COMMAND} `)) {
      writeTemplateViaDom(ADD_PEOPLE_TEMPLATE);
    }
  }, 150);
}

/**
 * Best-effort composer access: the last visible writable textarea is the
 * composer. 禁用/只读的 textarea（无会话 hero 的工作区触发器、被 block 的
 * composer）不作为目标——往里派事件既不触发 onChange 也不可编辑。
 */
function withComposerTextarea(fn: (el: HTMLTextAreaElement) => void): void {
  try {
    const visible = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea')).filter(
      (el) => el.offsetParent !== null && !el.disabled && !el.readOnly,
    );
    const target = visible.at(-1);
    if (target !== null && target !== undefined) fn(target);
  } catch {
    // 无 DOM/沙箱环境静默降级（docs/19.7.1）
  }
}

/** Whether a writable composer textarea exists（无 inputActions 时的分流判据）. */
function composerLive(): boolean {
  let live = false;
  withComposerTextarea(() => {
    live = true;
  });
  return live;
}

/** Best-effort read of the composer draft (override-confirm guard). */
function composerDraft(): string {
  let value = '';
  withComposerTextarea((el) => {
    value = el.value;
  });
  return value;
}

/** 诊断探针：当前 composer 草稿（前 40 字符足够辨认命令是否落地）。 */
export function composerDraftProbe(): string {
  return composerDraft().slice(0, 40);
}

/** Clipboard fallback that never throws (面板/按钮两条路径共用). */
function writeClipboardSafe(text: string): void {
  try {
    void navigator.clipboard.writeText(text).catch(() => undefined);
  } catch {
    // 无剪贴板权限时静默降级
  }
}
