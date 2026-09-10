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
 * 1. Session kit (`inputActions` — slot arg or capture bridge): `setDraft`
 *    writes the canonical template DIRECTLY into the input machine. What
 *    setDraft writes IS the send text, so plain enter dispatches `/eteam` —
 *    no claim state involved. The earlier "claim dance"（粘连 claim form +
 *    合成空格键）is retired for ALL paths: the claim rides the slash
 *    decision table whose end state proved uncontrollable from synthetic
 *    events (glued text sent as plain message 2026-09-10, and a cleared
 *    draft when the claim pipeline consumed the token), while the canonical
 *    draft is exactly the end state the repaired flow always converged to.
 * 2. Simulated typing（kit 皆空的罕见兜底）: native value setter + bubbling
 *    `input` event with the canonical template; a 150ms repair pass rewrites
 *    it if the synthetic event was swallowed.
 * 3. Clipboard — no live composer textarea at all.
 */
export function prefillComposer(
  inputActions: InputActionsFace | undefined,
): PrefillOutcome {
  // 写路解析：槽位实参优先（TeamsButton 弹窗 / 对话内页签），回落捕获桥
  // （整页团队页弹窗里的 ETeamsView）。
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
  if (actions !== undefined) {
    // 官方写路：规范模板直接进机器。setDraft 是机器唯一草稿写路的公开面，
    // 写进的就是发送文本——带空格的完整命令回车即被宿主命令路由识别，
    // 不经过斜杠 claim 决策表（历史粘连态方案的全部故障都源自那条链）。
    actions.setDraft(ADD_PEOPLE_TEMPLATE);
    withComposerTextarea((el) => el.focus());
    return 'set';
  }
  // 无 kit 兜底：native setter 直接落规范模板 + 冒泡 input 事件，修复窗兜底。
  withComposerTextarea((el) => el.focus());
  writeTemplateViaDom(ADD_PEOPLE_TEMPLATE);
  scheduleDomRepair();
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
 * 修复窗：无 kit 兜底写路里合成 input 事件被吞时 150ms 后重写规范模板。
 * 无 window 环境（纯 node 单测）无从排程，静默跳过。
 */
function scheduleDomRepair(): void {
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

/**
 * 诊断探针：composer 机器草稿投影的前 40 字符（足够辨认命令是否落地）。
 * InputBar 的 textarea 带 `data-phase` 属性（唯一标记，禁用/只读的工作区
 * 触发器同样携带且受控渲染机器草稿）——按标记直读，不受「最后可写
 * textarea」选择偏差影响；无标记（老版本宿主/无 DOM）回落可写读。
 */
export function composerDraftProbe(): string {
  try {
    const el = document.querySelector<HTMLTextAreaElement>('textarea[data-phase]');
    if (el !== null) return el.value.slice(0, 40);
  } catch {
    // 无 DOM 环境静默降级
  }
  return composerDraft().slice(0, 40);
}

/**
 * 诊断普查：页面全部 textarea 的状态旗标（D=disabled，R=readOnly，V=有值）
 * 与 data-phase 档位——填充不落地时一次看清机器投影挂在哪个元素上。
 */
export function composerCensus(): string {
  try {
    const all = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea'));
    if (all.length === 0) return 'none';
    return all
      .map((el) => {
        const flags = `${el.disabled ? 'D' : '-'}${el.readOnly ? 'R' : '-'}${el.value !== '' ? 'V' : '-'}`;
        const phase = (el.getAttribute('data-phase') ?? '-').slice(0, 8);
        return `${flags}(${phase})`;
      })
      .join(',');
  } catch {
    return '?';
  }
}

/** Clipboard fallback that never throws (面板/按钮两条路径共用). */
function writeClipboardSafe(text: string): void {
  try {
    void navigator.clipboard.writeText(text).catch(() => undefined);
  } catch {
    // 无剪贴板权限时静默降级
  }
}
