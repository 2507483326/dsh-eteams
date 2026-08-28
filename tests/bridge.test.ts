/**
 * DOM-stub tests for the tab-activation bridge: the bridge must click the
 * host's real `button[role="tab"]` (the sanctioned `actions.setView` path),
 * never our own `[data-eteams]` widgets, and never a label inside an open
 * portaled menu (the composer popup renders after the tab ring in DOM order).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { activateETeamsTab, ETEAMS_TAB_LABEL } from '../src/client/bridge';

interface FakeElement {
  tag: string;
  attrs: Record<string, string>;
  ownText: string;
  className: string;
  parent: FakeElement | null;
  children: FakeElement[];
  clicks: number;
}

function el(
  tag: string,
  opts: Partial<Omit<FakeElement, 'tag' | 'children' | 'parent'>> & {
    children?: FakeElement[];
  } = {},
): FakeElement {
  const node: FakeElement = {
    tag,
    attrs: opts.attrs ?? {},
    ownText: opts.ownText ?? '',
    className: opts.className ?? 'styled',
    parent: null,
    children: opts.children ?? [],
    clicks: 0,
  };
  for (const child of node.children) child.parent = node;
  return node;
}

function textOf(node: FakeElement): string {
  return node.ownText + node.children.map(textOf).join('');
}

function stubDocument(...roots: FakeElement[]): { restore: () => void; leaves: FakeElement[] } {
  const leaves: FakeElement[] = [];
  const walk = (node: FakeElement): void => {
    if (node.children.length === 0) leaves.push(node);
    node.children.forEach(walk);
  };
  roots.forEach(walk);

  const matches = (node: FakeElement, selector: string): boolean => {
    // Supports the attribute selectors the bridge uses (bare and [a="b"]).
    const bare = /^\[([a-zA-Z-]+)\]$/.exec(selector);
    if (bare) return bare[1]! in node.attrs;
    const valued = /^\[([a-zA-Z-]+)="([^"]*)"\]$/.exec(selector);
    if (valued) return node.attrs[valued[1]!] === valued[2];
    return false;
  };
  const closest = (node: FakeElement, selector: string): FakeElement | null => {
    let cur: FakeElement | null = node;
    while (cur !== null) {
      if (matches(cur, selector)) return cur;
      cur = cur.parent;
    }
    return null;
  };
  // Multi-selector closest argument: "[data-eteams],[role=...],...".
  const closestAny = (node: FakeElement, selectorList: string): FakeElement | null => {
    for (const sel of selectorList.split(',')) {
      const hit = closest(node, sel.trim());
      if (hit !== null) return hit;
    }
    return null;
  };
  const augment = (node: FakeElement): unknown => ({
    ...node,
    textContent: textOf(node),
    click() {
      node.clicks += 1;
    },
    closest: (sel: string) => {
      const hit = closestAny(node, sel);
      return hit === null ? null : augment(hit);
    },
  });

  const documentStub = {
    querySelectorAll: (selector: string): unknown[] => {
      if (selector === 'button[role="tab"]') {
        const tabs: FakeElement[] = [];
        roots.forEach(function walk(node: FakeElement): void {
          if (node.tag === 'button' && node.attrs.role === 'tab') tabs.push(node);
          node.children.forEach(walk);
        });
        return tabs.map(augment);
      }
      if (selector === 'div') return leaves.filter((n) => n.tag === 'div').map(augment);
      return [];
    },
  };
  const globalDoc = globalThis as { document?: unknown };
  const previous = globalDoc.document;
  globalDoc.document = documentStub;
  return {
    restore: () => {
      globalDoc.document = previous;
    },
    leaves,
  };
}

afterEach(() => {
  (globalThis as { document?: unknown }).document = undefined;
});

describe('tab-activation bridge (DOM stub)', () => {
  it('clicks the real role=tab button by label', () => {
    const tab = el('button', { attrs: { role: 'tab' }, children: [] });
    // The host tab button renders its label as a bare text node (leaf button).
    tab.ownText = ETEAMS_TAB_LABEL;
    const { restore } = stubDocument(tab);
    try {
      expect(activateETeamsTab()).toBe(true);
      expect(tab.clicks).toBe(1);
    } finally {
      restore();
    }
  });

  it('prefers the role=tab over the portaled menu label that follows it', () => {
    const tab = el('button', { attrs: { role: 'tab' } });
    tab.ownText = ETEAMS_TAB_LABEL;
    const menuLabel = el('div', { ownText: ETEAMS_TAB_LABEL });
    const menu = el('div', { attrs: { role: 'menu' }, children: [menuLabel] });
    const { restore } = stubDocument(tab, menu);
    try {
      expect(activateETeamsTab()).toBe(true);
      expect(tab.clicks).toBe(1);
      expect(menuLabel.clicks).toBe(0);
    } finally {
      restore();
    }
  });

  it('never clicks eteams-owned DOM', () => {
    const ownedLeaf = el('div', { ownText: ETEAMS_TAB_LABEL });
    const owned = el('div', { attrs: { 'data-eteams': 'button' }, children: [ownedLeaf] });
    const { restore } = stubDocument(owned);
    try {
      expect(activateETeamsTab()).toBe(false);
      expect(ownedLeaf.clicks).toBe(0);
    } finally {
      restore();
    }
  });

  it('falls back to a host-rendered leaf div outside eteams DOM', () => {
    const legacyTab = el('div', { ownText: ETEAMS_TAB_LABEL });
    const { restore } = stubDocument(legacyTab);
    try {
      expect(activateETeamsTab()).toBe(true);
      expect(legacyTab.clicks).toBe(1);
    } finally {
      restore();
    }
  });
});
