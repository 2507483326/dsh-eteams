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
 * @module dsh-eteams/tests/composerPrefill
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADD_PEOPLE_TEMPLATE,
  captureInputActions,
  peekCapturedInputActions,
  prefillComposer,
} from '../src/client/lib/addPeople';

/** 最小可写 textarea 桩（withComposerTextarea 的筛选面足够）。 */
const fakeTextarea = (overrides: { disabled?: boolean; readOnly?: boolean } = {}) =>
  ({
    offsetParent: {},
    disabled: false,
    readOnly: false,
    value: '',
    focus: () => undefined,
    setSelectionRange: () => undefined,
    dispatchEvent: () => true,
    ...overrides,
  }) as unknown as HTMLTextAreaElement;

/** 安装 document/window 最小桩，返回注册的 textarea 列表（可注入）。 */
function stubDom(textareas: HTMLTextAreaElement[]): void {
  vi.stubGlobal('document', { querySelectorAll: () => textareas });
  vi.stubGlobal('window', { confirm: () => true, setTimeout: () => 0 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prefillComposer 分流（无 inputActions：整页团队页场景）', () => {
  it('无可写 textarea（无 DOM）→ 退化剪贴板 copied', () => {
    // node 默认无 document：composerLive() 静默 false。
    expect(prefillComposer(undefined)).toBe('copied');
  });

  it('只有禁用的 textarea（无会话 hero 的工作区触发器）→ copied', () => {
    stubDom([fakeTextarea({ disabled: true })]);
    expect(prefillComposer(undefined)).toBe('copied');
  });

  it('有可写 textarea（弹窗盖着的真 composer）→ set，不再退化剪贴板', () => {
    stubDom([fakeTextarea()]);
    expect(prefillComposer(undefined)).toBe('set');
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
