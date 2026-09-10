/**
 * prefillComposer 分流单测（2026-09-10 用户报告「整页团队页弹窗里点填充，
 * 对话输入框没内容」）：根因是整页团队页（teamsPanel.TeamsOverlay）里的
 * ETeamsView 不吃会话标准 kit、拿不到 inputActions，旧逻辑据此直接退化
 * 剪贴板。修复三处：① 分流判据——模拟键入路径并不依赖 setDraft（机器写入
 * 由 composer 自己的 onChange 完成），无实参时看「DOM 里有没有可写的
 * textarea」；② 捕获桥——TeamsButton 随 composer 工具行挂载时登记一份
 * inputActions（模块级单例），整页弹窗里的 prefill 按「实参 → 捕获」回退
 * 解析；③ 捕获写路直接落规范模板（带空格）——弹窗 composer 是未开始 hero
 * 的锁定态，claim 舞蹈的合成事件进不去，粘连 claim form 会被原样发出、
 * 命令名解析失败（第二轮用户反馈「填充后没有调用到插件」）。
 * node 环境无真 DOM，用最小 document/window 桩钉决策树；键入舞蹈本身
 * （原生 setter + input 事件）依赖浏览器全局，桩下静默降级不影响结果位。
 *
 * @module dsh-eteams/tests/composerPrefill
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADD_PEOPLE_COMMAND,
  ADD_PEOPLE_TEMPLATE,
  captureInputActions,
  peekCapturedInputActions,
  prefillComposer,
  type PrefillOutcome,
} from '../src/client/lib/addPeople';

/** claim form：/eteam 与参数粘连（空格由 space-claim 键事件补回）——仅
 * 槽位写路（对话内页签）使用；捕获桥写路直接落规范模板。 */
const CLAIM_FORM = ADD_PEOPLE_TEMPLATE.slice(0, 1 + ADD_PEOPLE_COMMAND.length) +
  ADD_PEOPLE_TEMPLATE.slice(2 + ADD_PEOPLE_COMMAND.length);

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

describe('prefillComposer 分流（有 inputActions：对话内页签场景）', () => {
  it('setDraft 收到 claim form，结果 set', () => {
    const setDraft = vi.fn();
    const outcome: PrefillOutcome = prefillComposer({ setDraft });
    expect(outcome).toBe('set');
    expect(setDraft).toHaveBeenCalledTimes(1);
    expect(setDraft).toHaveBeenCalledWith(CLAIM_FORM);
  });
});

describe('inputActions 捕获桥（整页弹窗的官方写路：直接落规范模板）', () => {
  let unregister: (() => void) | null = null;
  afterEach(() => {
    // 捕获是模块级单例：每用例自清，防同文件内串捕获（vitest 按文件隔离，
    // 文件内共享模块实例）。
    unregister?.();
    unregister = null;
  });

  it('capture 后 prefill(undefined)：captured 的 setDraft 收到规范模板（带空格）', () => {
    const setDraft = vi.fn();
    unregister = captureInputActions({ setDraft });
    // 无 DOM 桩：composerDraft() 静默空串跳过覆盖确认，键入舞蹈静默降级。
    expect(prefillComposer(undefined)).toBe('set');
    expect(setDraft).toHaveBeenCalledTimes(1);
    // 2026-09-10 用户反馈「填充后没有调用到插件」：弹窗 composer 锁定态下
    // claim 不可能完成，粘连 claim form 会被原样发出——捕获桥必须直接写
    // 规范模板，回车即派发。
    expect(setDraft).toHaveBeenCalledWith(ADD_PEOPLE_TEMPLATE);
  });

  it('capture + 只有禁用 textarea（无会话 hero）→ 仍走 setDraft 官方写路', () => {
    const setDraft = vi.fn();
    unregister = captureInputActions({ setDraft });
    stubDom([fakeTextarea({ disabled: true })]);
    expect(prefillComposer(undefined)).toBe('set');
    expect(setDraft).toHaveBeenCalledWith(ADD_PEOPLE_TEMPLATE);
  });

  it('注销后回落 DOM 分流（不再动 captured 的 setDraft）', () => {
    const setDraft = vi.fn();
    captureInputActions({ setDraft })();
    expect(peekCapturedInputActions()).toBeUndefined();
    stubDom([fakeTextarea()]);
    expect(prefillComposer(undefined)).toBe('set');
    expect(setDraft).not.toHaveBeenCalled();
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
});
