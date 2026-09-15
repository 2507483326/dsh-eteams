/**
 * DOM-stub tests for the 团队 tab red dot (用户 2026-09-15「有新的待决策内容时，
 * 对话上面的团队TAB，需要出现红点提示」): the injector must append exactly one
 * empty (text-free — the tab bridge matches the label by textContent) dot span
 * per host tab button, stay idempotent across host re-renders, and only fall
 * back to an inline `position:relative` when the host button is not already a
 * positioning context (the host `.tab` rule already is).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ensureTeamTabDot, setTeamTabDotVisible } from '../src/client/features/activity/teamTabDot';

interface FakeNode {
  tag: string;
  attrs: Record<string, string>;
  className: string;
  textContent: string;
  hidden: boolean;
  style: Record<string, string>;
}

function fakeNode(tag: string): FakeNode & {
  querySelector: (selector: string) => (FakeNode & object) | null;
  appendChild: (child: FakeNode) => FakeNode;
  setAttribute: (key: string, value: string) => void;
  children: FakeNode[];
} {
  const node: FakeNode = {
    tag,
    attrs: {},
    className: '',
    textContent: '',
    hidden: false,
    style: {},
  };
  const children: FakeNode[] = [];
  const match = (child: FakeNode, selector: string): boolean =>
    selector === '[data-eteams="tab-dot"]' && child.attrs['data-eteams'] === 'tab-dot';
  return Object.assign(node, {
    children,
    setAttribute: (key: string, value: string): void => {
      node.attrs[key] = value;
    },
    querySelector: (selector: string): FakeNode | null =>
      children.find((child) => match(child, selector)) ?? null,
    appendChild: (child: FakeNode): FakeNode => {
      children.push(child);
      return child;
    },
  });
}

function fakeDocument(): { created: FakeNode[]; restore: () => void } {
  const created: FakeNode[] = [];
  const globalDoc = globalThis as { document?: unknown };
  const previous = globalDoc.document;
  globalDoc.document = {
    createElement: (tag: string): FakeNode => {
      const node = fakeNode(tag);
      created.push(node);
      return node;
    },
  };
  return {
    created,
    restore: () => {
      globalDoc.document = previous;
    },
  };
}

afterEach(() => {
  (globalThis as { document?: unknown }).document = undefined;
  (globalThis as { getComputedStyle?: unknown }).getComputedStyle = undefined;
});

describe('团队 tab 红点注入器 (DOM stub)', () => {
  it('注入一枚无文本、默认隐藏的红点 span', () => {
    const doc = fakeDocument();
    const button = fakeNode('button');
    try {
      const dot = ensureTeamTabDot(button as unknown as HTMLElement);
      expect(button.children).toHaveLength(1);
      expect(dot.attrs['data-eteams']).toBe('tab-dot');
      expect(dot.attrs['aria-hidden']).toBe('true');
      expect(dot.className).toBe('eteams-tab-dot');
      expect(dot.hidden).toBe(true);
      // 空文本：宿主标签匹配按 textContent 精确比对（bridge.findETeamsTabButton），
      // 红点不得改变按钮文本。
      expect(button.textContent).toBe('');
      expect(doc.created).toHaveLength(1);
    } finally {
      doc.restore();
    }
  });

  it('幂等：宿主重渲染后不重复注入', () => {
    const doc = fakeDocument();
    const button = fakeNode('button');
    try {
      const first = ensureTeamTabDot(button as unknown as HTMLElement);
      const second = ensureTeamTabDot(button as unknown as HTMLElement);
      expect(second).toBe(first);
      expect(button.children).toHaveLength(1);
      expect(doc.created).toHaveLength(1);
    } finally {
      doc.restore();
    }
  });

  it('宿主按钮非定位上下文时才补 inline relative 兜底', () => {
    const doc = fakeDocument();
    const button = fakeNode('button');
    const globalStyle = globalThis as { getComputedStyle?: unknown };
    try {
      // 宿主 `.tab` 自带 relative：不动宿主样式。
      globalStyle.getComputedStyle = () => ({ position: 'relative' });
      ensureTeamTabDot(button as unknown as HTMLElement);
      expect(button.style['position']).toBeUndefined();
      // 换版后若变 static：补一条 inline style，红点仍有定位基准。
      const staticButton = fakeNode('button');
      globalStyle.getComputedStyle = () => ({ position: 'static' });
      ensureTeamTabDot(staticButton as unknown as HTMLElement);
      expect(staticButton.style['position']).toBe('relative');
    } finally {
      doc.restore();
    }
  });

  it('显隐只切 hidden，null 目标安全空转', () => {
    const doc = fakeDocument();
    const button = fakeNode('button');
    try {
      const dot = ensureTeamTabDot(button as unknown as HTMLElement);
      setTeamTabDotVisible(dot, true);
      expect(dot.hidden).toBe(false);
      setTeamTabDotVisible(dot, false);
      expect(dot.hidden).toBe(true);
      expect(() => setTeamTabDotVisible(null, true)).not.toThrow();
    } finally {
      doc.restore();
    }
  });
});
