/**
 * 领队子代理 infrastructure (docs/26 用户迭代 2026-09-03): label round-trip,
 * the in-memory child registry, and the loud-deny deny list contract —
 * every denied name must be a registered tool (spawn applies the list via
 * tools.restrict, which fails loudly on unknown names).
 */
import { describe, expect, it } from 'vitest';
import {
  buildCaptainLabel,
  CAPTAIN_CHILD_DENIED_TOOLS,
  CAPTAIN_LABEL_PREFIX,
  captainChildTeamOf,
  parseCaptainLabel,
  registerCaptainChild,
  unregisterCaptainChild,
} from '../src/host/runtime/captainAgent';
import { createCaptainTools } from '../src/host/tools/captainTools';
import { createCaptainDispatchTool } from '../src/host/tools/captainDispatch';

describe('captain child label', () => {
  it('round-trips build/parse', () => {
    const label = buildCaptainLabel('demo');
    expect(label).toBe('eteams-captain:demo');
    expect(parseCaptainLabel(label)).toEqual({ teamId: 'demo' });
  });

  it('rejects non-captain labels and empty ids', () => {
    expect(parseCaptainLabel('eteams-team:demo/member')).toBeUndefined();
    expect(parseCaptainLabel('eteams-captain:')).toBeUndefined();
    expect(parseCaptainLabel(undefined)).toBeUndefined();
    expect(buildCaptainLabel('')).toBe(`${CAPTAIN_LABEL_PREFIX}`);
  });
});

describe('captain child registry', () => {
  it('round-trips register/query/unregister', () => {
    registerCaptainChild('c-1', 'team-a');
    expect(captainChildTeamOf('c-1')).toBe('team-a');
    unregisterCaptainChild('c-1');
    expect(captainChildTeamOf('c-1')).toBeUndefined();
    // Unregister is idempotent.
    unregisterCaptainChild('c-1');
  });

  it('ignores blank ids', () => {
    registerCaptainChild('', 'team-a');
    registerCaptainChild('c-2', '');
    expect(captainChildTeamOf('')).toBeUndefined();
    expect(captainChildTeamOf('c-2')).toBeUndefined();
  });
});

describe('CAPTAIN_CHILD_DENIED_TOOLS loud-deny contract', () => {
  // The spawn window applies `tools.restrict({ deny })`, which fails loudly
  // on names that are not registered global tools — a bad entry aborts every
  // captain dispatch (members.ts MEMBER_DENIED_TOOLS carries the same note).
  const registered = new Set([
    ...createCaptainTools({} as never, {} as never).map((tool) => (tool as { name: string }).name),
    'eteams_dispatch_captain',
  ]);

  it('denies only registered tool names (spawn-abort footgun)', () => {
    // 归档功能随 docs/35 §3#7 下线，`eteams_archive_team` 已无注册点；
    // deny 名单里每一条都必须是注册工具名（MEMBER_DENIED_TOOLS 同口径）。
    for (const name of CAPTAIN_CHILD_DENIED_TOOLS) {
      expect(registered.has(name), `deny entry not registered: ${name}`).toBe(true);
    }
  });

  it('never denies the dropped archive tool (spawn-abort footgun)', () => {
    expect(CAPTAIN_CHILD_DENIED_TOOLS).not.toContain('eteams_archive_team');
  });

  it('never denies the unregistered approve tool (spawn-abort footgun)', () => {
    expect(CAPTAIN_CHILD_DENIED_TOOLS).not.toContain('eteams_approve_plan');
  });

  it('includes the recursion guard (子代理不得再转交)', () => {
    expect(CAPTAIN_CHILD_DENIED_TOOLS).toContain('eteams_dispatch_captain');
  });
});

describe('dispatch tool registration shape', () => {
  it('exposes the eteams_dispatch_captain face', () => {
    const tool = createCaptainDispatchTool({} as never, {} as never) as unknown as {
      name: string;
    };
    expect(tool.name).toBe('eteams_dispatch_captain');
  });
});
