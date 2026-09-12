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
 * 2. DOM write（kit 皆空的罕见兜底）: legacy hosts get the native textarea
 *    value setter + bubbling `input` event; the current host composer is a
 *    Lexical contenteditable (`[data-composer-input]`, NO textarea since
 *    dsh 0.1.2) and gets a synthetic `paste` event carrying the template —
 *    the host's own PASTE_COMMAND feeds it into the editor model. A 150ms
 *    repair pass rewrites it if the write was swallowed.
 * 3. Clipboard — no live composer field at all.
 *
 * 2026-09-12 用户报告「探索未至之境 页面团队弹窗中的AI角色创建填充没效果」：
 * 诊断 `source=none outcome=copied draft= census=none`——现宿主 composer 换
 * Lexical contenteditable 后旧 textarea 兜底恒空，kit/捕获桥缺席时填充只能
 * 静默退化剪贴板。本条补上 contenteditable 写路（见 composerField）。
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
    focusComposer();
    return 'set';
  }
  // 无 kit 兜底：DOM 写路（旧宿主 textarea 原生 setter / 现宿主 contenteditable
  // 合成 paste）。写不进去（composer 锁定/内核不支持）不谎报 set——退剪贴板，
  // 让调用位显示「已复制」而不是静默无反应。修复窗兜底迟到的 DOM 就绪。
  focusComposer();
  const wrote = writeTemplateViaDom(ADD_PEOPLE_TEMPLATE);
  scheduleDomRepair();
  if (!wrote) {
    void writeClipboardSafe(ADD_PEOPLE_TEMPLATE);
    return 'copied';
  }
  return 'set';
}

/** ================================== composer 写路 ================================== */

/**
 * The live composer field. Current hosts (dsh 0.1.2+) render the composer as a
 * Lexical `contenteditable`（`[data-composer-input]`）with NO textarea——旧版
 * 「最后一个可写 textarea」的 DOM 兜底在新宿主上恒空（2026-09-12 用户报告
 * 「探索未至之境 页面团队弹窗中的AI角色创建填充没效果」，诊断
 * `source=none outcome=copied census=none`）。先按旧宿主 textarea 取，取不到
 * 再认现宿主的 contenteditable。
 */
type ComposerField =
  | { kind: 'textarea'; el: HTMLTextAreaElement }
  | { kind: 'editable'; el: HTMLElement };

function composerField(): ComposerField | null {
  try {
    if (typeof document === 'undefined') return null;
    // 旧宿主：最后一个可见可写的 textarea 即 composer。禁用/只读的 textarea
    //（无会话 hero 的工作区触发器、被 block 的 composer）不作为目标——往里
    // 派事件既不触发 onChange 也不可编辑。
    const visible = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea')).filter(
      (el) => el.offsetParent !== null && !el.disabled && !el.readOnly,
    );
    const textarea = visible.at(-1);
    if (textarea !== undefined) return { kind: 'textarea', el: textarea };
    // 现宿主：Lexical contenteditable（宿主以 [data-composer-input] 标记；
    // 无会话的工作区触发器同标记但 contenteditable=false，不作写目标）。
    if (typeof document.querySelector !== 'function') return null;
    const editable = document.querySelector<HTMLElement>('[data-composer-input]');
    if (
      editable !== null &&
      editable !== undefined &&
      editable.getAttribute('contenteditable') === 'true' &&
      editable.offsetParent !== null
    ) {
      return { kind: 'editable', el: editable };
    }
    return null;
  } catch {
    // 无 DOM/沙箱环境静默降级（docs/19.7.1）
    return null;
  }
}

/** Focus the live composer field (best effort; no DOM is a silent no-op). */
function focusComposer(): void {
  try {
    composerField()?.el.focus();
  } catch {
    // 静默
  }
}

/**
 * 经原生 value setter（绕过 React value tracker）把文本写进 composer DOM，
 * 或对现宿主 contenteditable 走合成 paste。返回是否确实落地。
 */
function writeTemplateViaDom(text: string): boolean {
  const field = composerField();
  if (field === null) return false;
  if (field.kind === 'textarea') {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter === undefined) return false;
    setter.call(field.el, text);
    field.el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  return pasteIntoEditable(field.el, text);
}

/**
 * contenteditable composer 写入（现宿主 Lexical 编辑器）：先全选现有草稿
 *（替换语义与旧 textarea 的原生 setter 对齐，防「重新填充」叠加出两份），
 * 再合成 paste 事件带 text/plain——宿主为 composer 注册的 PASTE_COMMAND 读
 * clipboardData 后走官方 keyboard.paste 进编辑器模型（直接改 textContent /
 * 裸 execCommand 会被 Lexical 的 DOM 对账丢弃）。合成事件被吞（composer
 * 锁定/内核不支持）时退回 execCommand；仍不落地由调用位退剪贴板。
 *
 * @returns whether the template actually landed in the composer DOM.
 */
function pasteIntoEditable(el: HTMLElement, text: string): boolean {
  try {
    const selection = window.getSelection();
    if (selection !== null && typeof document.createRange === 'function') {
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  } catch {
    // 选择不可设：paste 按光标位置插入
  }
  try {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
    );
  } catch {
    // ClipboardEvent/DataTransfer 不可用（老内核）→ execCommand 兜底
  }
  // Lexical 的离散 update 同步对账 DOM，此处直读即知落没落地。
  if ((el.textContent ?? '').includes(text)) return true;
  try {
    document.execCommand('insertText', false, text);
  } catch {
    // 无 execCommand（沙箱）静默降级
  }
  return (el.textContent ?? '').includes(text);
}

/**
 * 修复窗：无 kit 兜底写路里合成事件被吞时 150ms 后重写规范模板。
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

/** Whether a writable composer field exists（无 inputActions 时的分流判据）. */
function composerLive(): boolean {
  return composerField() !== null;
}

/** Best-effort read of the composer draft (override-confirm guard). */
function composerDraft(): string {
  const field = composerField();
  if (field === null) return '';
  return field.kind === 'textarea' ? field.el.value : (field.el.textContent ?? '');
}

/**
 * 诊断探针：composer 机器草稿投影的前 40 字符（足够辨认命令是否落地）。
 * 旧宿主 InputBar 的 textarea 带 `data-phase`；现宿主换 Lexical
 * contenteditable，标记是 `data-composer-input`——两代标记都直读，不受
 * 「最后可写字段」选择偏差影响；无标记（老版本宿主/无 DOM）回落可写读。
 */
export function composerDraftProbe(): string {
  try {
    const el = document.querySelector<HTMLTextAreaElement>('textarea[data-phase]');
    if (el !== null) return el.value.slice(0, 40);
    const editable = document.querySelector<HTMLElement>('[data-composer-input]');
    if (editable !== null && editable !== undefined) return (editable.textContent ?? '').slice(0, 40);
  } catch {
    // 无 DOM 环境静默降级
  }
  return composerDraft().slice(0, 40);
}

/**
 * 诊断普查：页面全部 textarea 的状态旗标（D=disabled，R=readOnly，V=有值）
 * 与 data-phase 档位，外加现宿主 composer contenteditable 的
 * contenteditable 值 + 是否有值——填充不落地时一次看清机器投影挂在哪个
 * 元素上（census=none 曾是「现宿主无 textarea」的误读来源）。
 */
export function composerCensus(): string {
  try {
    const all = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea'));
    const editable =
      typeof document.querySelector === 'function'
        ? document.querySelector<HTMLElement>('[data-composer-input]')
        : null;
    const editableFlag =
      editable === null || editable === undefined
        ? 'none'
        : `${editable.getAttribute('contenteditable') ?? '-'}${(editable.textContent ?? '') !== '' ? 'V' : '-'}`;
    if (all.length === 0) return `editable:${editableFlag}`;
    return `${all
      .map((el) => {
        const flags = `${el.disabled ? 'D' : '-'}${el.readOnly ? 'R' : '-'}${el.value !== '' ? 'V' : '-'}`;
        const phase = (el.getAttribute('data-phase') ?? '-').slice(0, 8);
        return `${flags}(${phase})`;
      })
      .join(',')};editable:${editableFlag}`;
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
