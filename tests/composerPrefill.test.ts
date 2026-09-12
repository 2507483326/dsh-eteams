/**
 * prefillComposer 分流单测（2026-09-10 用户报告「整页团队页弹窗里点填充，
 * 对话输入框没内容」→ 后续「填充后没有调用到插件」「又坏了」三轮迭代）：
 * 最终形态——所有 kit 写路（槽位实参 / 捕获桥）统一用官方 setDraft 直写
 * 规范模板（带空格、回车即派发）。早期的「粘连 claim form + 合成空格键」
 * 舞蹈彻底废除：claim 走斜杠决策表，合成事件下终态不可控（粘连文本被
 * 原样发出、或 claim 管线消费 token 后草稿被清空）。
 * node 环境无真 DOM，用最小 document/window 桩钉决策树；键入兜底路径
 * （原生 setter + input 事件）依赖浏览器全局，桩下静默降级不影响结果位。
 *
 * 现宿主 contenteditable 写路（2026-09-12 用户报告「探索未至之境 页面团队
 * 弹窗中的AI角色创建填充没效果」，诊断 `source=none outcome=copied
 * census=none`）：dsh 0.1.2 起 composer 由 textarea 换 Lexical
 * contenteditable（`[data-composer-input]`），旧 textarea 兜底恒空——本条
 * 同步锁两代 DOM 写路（textarea 原生 setter / contenteditable 合成 paste）。
 *
 * @module dsh-eteams/tests/composerPrefill
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADD_PEOPLE_TEMPLATE,
  captureInputActions,
  peekCapturedInputActions,
  prefillComposer,
} from '../src/client/lib/addPeople';

/** 共享 textarea 原型：原生 value 访问器（addPeople 经 descriptor 取 setter）。 */
const textareaProto = {
  _v: '',
  get value(): string {
    return this._v;
  },
  set value(next: string) {
    this._v = next;
  },
};

/** 最小可写 textarea 桩（composerField 的筛选面足够）。 */
const fakeTextarea = (overrides: { disabled?: boolean; readOnly?: boolean } = {}) => {
  const el = Object.create(textareaProto) as Record<string, unknown>;
  el.offsetParent = {};
  el.disabled = false;
  el.readOnly = false;
  el.focus = () => undefined;
  el.dispatchEvent = () => true;
  Object.assign(el, overrides);
  return el as unknown as HTMLTextAreaElement;
};

/** 最小 DataTransfer 桩（setData/getData）。 */
class FakeDataTransfer {
  private readonly data = new Map<string, string>();
  setData(type: string, value: string): void {
    this.data.set(type, value);
  }
  getData(type: string): string {
    return this.data.get(type) ?? '';
  }
}

/** 最小 ClipboardEvent 桩（只带 clipboardData）。 */
class FakeClipboardEvent {
  readonly clipboardData: FakeDataTransfer;
  constructor(_type: string, init: { clipboardData: FakeDataTransfer }) {
    this.clipboardData = init.clipboardData;
  }
}

/**
 * 现宿主 composer contenteditable 桩：`data-composer-input` 标记 + 可编辑；
 * dispatchEvent 模拟宿主 PASTE_COMMAND（读 clipboardData 写入 textContent）——
 * pasteLands=false 表示合成事件被吞（composer 锁定）。
 */
const fakeEditable = (opts: { editable?: boolean; pasteLands?: boolean } = {}) => {
  const el = {
    textContent: '',
    offsetParent: {},
    getAttribute: (name: string) => (name === 'contenteditable' ? (opts.editable === false ? 'false' : 'true') : null),
    focus: () => undefined,
    dispatchEvent: (event: Event) => {
      if (opts.pasteLands === false) return true;
      const pasted = (event as unknown as { clipboardData?: FakeDataTransfer }).clipboardData?.getData(
        'text/plain',
      );
      if (pasted !== undefined && pasted !== '') el.textContent = pasted;
      return true;
    },
  };
  return el as unknown as HTMLElement;
};

/** 安装 document/window/构造器桩（textareas 与 contenteditable 可分别注入）。 */
function stubDom(
  textareas: HTMLTextAreaElement[] = [],
  options: { editable?: HTMLElement | null; execCommand?: (cmd: string, ui: boolean, value: string) => boolean } = {},
): void {
  vi.stubGlobal('HTMLTextAreaElement', { prototype: textareaProto });
  vi.stubGlobal('DataTransfer', FakeDataTransfer);
  vi.stubGlobal('ClipboardEvent', FakeClipboardEvent);
  vi.stubGlobal('document', {
    querySelectorAll: () => textareas,
    querySelector: () => options.editable ?? null,
    execCommand: options.execCommand,
  });
  vi.stubGlobal('window', { confirm: () => true, setTimeout: () => 0 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prefillComposer 分流（无 inputActions：整页团队页场景）', () => {
  it('无可写 textarea（无 DOM）→ 退化剪贴板 copied', () => {
    // node 默认无 document：composerField() 静默 null。
    expect(prefillComposer(undefined)).toBe('copied');
  });

  it('只有禁用的 textarea（无会话 hero 的工作区触发器）→ copied', () => {
    stubDom([fakeTextarea({ disabled: true })]);
    expect(prefillComposer(undefined)).toBe('copied');
  });

  it('有可写 textarea（旧宿主弹窗盖着的真 composer）→ set，写进原生 value', () => {
    const field = fakeTextarea();
    stubDom([field]);
    expect(prefillComposer(undefined)).toBe('set');
    expect(field.value).toBe(ADD_PEOPLE_TEMPLATE);
  });
});

describe('prefillComposer DOM 写路 · 现宿主 contenteditable（dsh 0.1.2+）', () => {
  it('合成 paste 被宿主接住 → set，模板落进 composer', () => {
    const field = fakeEditable();
    stubDom([], { editable: field });
    expect(prefillComposer(undefined)).toBe('set');
    expect(field.textContent).toBe(ADD_PEOPLE_TEMPLATE);
  });

  it('paste 被吞（composer 锁定）时 execCommand 兜底 → set', () => {
    const field = fakeEditable({ pasteLands: false });
    stubDom([], {
      editable: field,
      execCommand: (_cmd, _ui, value) => {
        field.textContent = value;
        return true;
      },
    });
    expect(prefillComposer(undefined)).toBe('set');
    expect(field.textContent).toBe(ADD_PEOPLE_TEMPLATE);
  });

  it('无会话工作区触发器（contenteditable=false）→ copied，不谎报 set', () => {
    stubDom([], { editable: fakeEditable({ editable: false }) });
    expect(prefillComposer(undefined)).toBe('copied');
  });
});

describe('prefillComposer kit 写路（槽位实参与捕获桥同归：直写规范模板）', () => {
  it('槽位实参：setDraft 收到规范模板（带空格），结果 set', () => {
    const setDraft = vi.fn();
    expect(prefillComposer({ setDraft })).toBe('set');
    expect(setDraft).toHaveBeenCalledTimes(1);
    expect(setDraft).toHaveBeenCalledWith(ADD_PEOPLE_TEMPLATE);
  });

  it('捕获桥（弹窗场景）：同样直写规范模板，不走粘连 claim form', () => {
    const setDraft = vi.fn();
    const unregister = captureInputActions({ setDraft });
    try {
      // 无 DOM 桩：composerDraft() 静默空串跳过覆盖确认，键入兜底静默降级。
      expect(prefillComposer(undefined)).toBe('set');
      expect(setDraft).toHaveBeenCalledTimes(1);
      expect(setDraft).toHaveBeenCalledWith(ADD_PEOPLE_TEMPLATE);
    } finally {
      unregister();
    }
    expect(peekCapturedInputActions()).toBeUndefined();
  });

  it('capture + 只有禁用 textarea（无会话 hero）→ 仍走 setDraft 官方写路', () => {
    const setDraft = vi.fn();
    const unregister = captureInputActions({ setDraft });
    try {
      stubDom([fakeTextarea({ disabled: true })]);
      expect(prefillComposer(undefined)).toBe('set');
      expect(setDraft).toHaveBeenCalledWith(ADD_PEOPLE_TEMPLATE);
    } finally {
      unregister();
    }
  });

  it('capture(undefined)（kit 缺失的挂载）返回 no-op 且不清既有捕获', () => {
    const setDraft = vi.fn();
    const keep = captureInputActions({ setDraft });
    try {
      captureInputActions(undefined)();
      // no-op 注销不得错杀 keep 的登记（同引用才清的守卫在此兜底）。
      expect(peekCapturedInputActions()).toEqual({ setDraft });
    } finally {
      keep();
    }
    expect(peekCapturedInputActions()).toBeUndefined();
  });

  it('注销后回落 DOM 兜底（不再动 captured 的 setDraft）', () => {
    const setDraft = vi.fn();
    captureInputActions({ setDraft })();
    expect(peekCapturedInputActions()).toBeUndefined();
    stubDom([fakeTextarea()]);
    expect(prefillComposer(undefined)).toBe('set');
    expect(setDraft).not.toHaveBeenCalled();
  });
});
