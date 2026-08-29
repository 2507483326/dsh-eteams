/**
 * DOM-stub tests for the hero 团队 button injector: it must append exactly
 * one chip-styled button per hero row, mark it with the eteams data
 * attribute (so the tab bridge and re-scans never mistake it for host
 * chrome), and stay idempotent when React re-renders the row.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ensureHeroButton } from '../src/client/heroTeamsButton';

interface FakeNode {
  attrs: Record<string, string>;
  tag: string;
  className: string;
  textContent: string;
  children: FakeNode[];
  listeners: Map<string, () => void>;
}

function fakeDocument(): {
  created: FakeNode[];
  restore: () => void;
} {
  const created: FakeNode[] = [];
  const makeNode = (tag: string): FakeNode => {
    const node: FakeNode = {
      tag,
      attrs: {},
      className: '',
      textContent: '',
      children: [],
      listeners: new Map(),
    };
    const withDom = node as FakeNode & {
      setAttribute: (k: string, v: string) => void;
      addEventListener: (type: string, fn: () => void) => void;
    };
    withDom.setAttribute = (key: string, value: string): void => {
      node.attrs[key] = value;
    };
    withDom.addEventListener = (type: string, fn: () => void): void => {
      node.listeners.set(type, fn);
    };
    return node;
  };
  const globalDoc = globalThis as { document?: unknown };
  const previous = globalDoc.document;
  globalDoc.document = {
    createElement: (tag: string): FakeNode => {
      const node = makeNode(tag);
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

function fakeRow(): FakeNode & {
  querySelector: (selector: string) => FakeNode | null;
  appendChild: (child: FakeNode) => FakeNode;
} {
  const row: FakeNode = {
    tag: 'div',
    attrs: {},
    className: 'wSkVaW_heroWorkspaceRow',
    textContent: '',
    children: [],
    listeners: new Map(),
  };
  const match = (node: FakeNode, selector: string): boolean =>
    selector === `[data-eteams="hero-button"]` && node.attrs['data-eteams'] === 'hero-button';
  return {
    ...row,
    querySelector: (selector: string): FakeNode | null =>
      row.children.find((c) => match(c, selector)) ?? null,
    appendChild: (child: FakeNode): FakeNode => {
      row.children.push(child);
      return child;
    },
  };
}

afterEach(() => {
  (globalThis as { document?: unknown }).document = undefined;
});

describe('hero 团队 button injector (DOM stub)', () => {
  it('injects one marked, chip-styled button into the row', () => {
    const doc = fakeDocument();
    const row = fakeRow();
    const onClick = (): void => undefined;
    try {
      expect(ensureHeroButton(row as unknown as HTMLElement, onClick)).toBe(true);
      expect(row.children).toHaveLength(1);
      const button = row.children[0]!;
      expect(button.attrs['data-eteams']).toBe('hero-button');
      expect(button.attrs['aria-label']).toBe('团队');
      expect(button.className).toBe('eteams-hero-btn');
      expect(button.textContent).toBe('团队');
      expect(button.listeners.has('click')).toBe(true);
      expect(doc.created).toHaveLength(1);
    } finally {
      doc.restore();
    }
  });

  it('is idempotent: no second button while the marker is present', () => {
    const doc = fakeDocument();
    const row = fakeRow();
    try {
      expect(ensureHeroButton(row as unknown as HTMLElement, () => undefined)).toBe(true);
      // React re-render / observer refire — the marker short-circuits.
      expect(ensureHeroButton(row as unknown as HTMLElement, () => undefined)).toBe(false);
      expect(row.children).toHaveLength(1);
      expect(doc.created).toHaveLength(1);
    } finally {
      doc.restore();
    }
  });

  it('routes clicks through the injected handler', () => {
    const doc = fakeDocument();
    const row = fakeRow();
    let clicks = 0;
    try {
      expect(ensureHeroButton(row as unknown as HTMLElement, () => { clicks += 1; })).toBe(true);
      const button = row.children[0]!;
      button.listeners.get('click')!();
      button.listeners.get('click')!();
      expect(clicks).toBe(2);
    } finally {
      doc.restore();
    }
  });
});
