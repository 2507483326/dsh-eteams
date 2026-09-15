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
  parseCaptainLabel,
} from '../src/host/runtime/captainAgent';
import {
  captainChildTeamOf,
  registerCaptainChild,
  unregisterCaptainChild,
} from '../src/host/runtime/captainChildRegistry';
import { createCaptainTools } from '../src/host/tools/captainTools';
import { createCaptainDispatchTool } from '../src/host/tools/captainDispatch';
import { createMemberTools } from '../src/host/tools/memberTools';
import { MEMBER_TOOL_NAMES } from '../src/host/runtime/members';
import { builderToolFilter } from '../src/host/runtime/builderPhases';

describe('captain child label', () => {
  it('round-trips build/parse（以领队的名字命名）', () => {
    const label = buildCaptainLabel('团队领队');
    expect(label).toBe('eteams-captain:团队领队');
    expect(parseCaptainLabel(label)).toEqual({ leaderName: '团队领队' });
  });

  it('rejects non-captain labels and empty names', () => {
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
  // harness 0.1.2 起成员工具也随根作用域注册（registerContinuableSetup 被宿
  // 主移除），注册面 = 领队工具 + 成员工具 + 派发工具。
  const registered = new Set([
    ...createCaptainTools({} as never, {} as never).map((tool) => (tool as { name: string }).name),
    ...createMemberTools({} as never, {} as never).map((tool) => (tool as { name: string }).name),
    'eteams_dispatch_captain',
  ]);

  it('denies only registered tool names (spawn-abort footgun)', () => {
    // 归档功能随 docs/35 §3#7 下线，`eteams_archive_team` 已无注册点；
    // deny 名单里每一条都必须是注册工具名（MEMBER_DENIED_TOOLS 同口径）。
    for (const name of CAPTAIN_CHILD_DENIED_TOOLS) {
      expect(registered.has(name), `deny entry not registered: ${name}`).toBe(true);
    }
  });

  it('denies every member tool（0.1.2 根作用域注册后的可见性纪律）', () => {
    for (const name of MEMBER_TOOL_NAMES) {
      expect(CAPTAIN_CHILD_DENIED_TOOLS, `member tool not denied: ${name}`).toContain(name);
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

describe('builder tool filter (构建子代理可见性)', () => {
  const BUILDER_FOUR = [
    'eteams_build_report',
    'eteams_build_wait',
    'eteams_member_list',
    'eteams_member_save',
  ];

  it('never denies the builder four (2026-09-08 用户实测回归：禁了自己就没法构建)', () => {
    const deny = builderToolFilter().deny;
    for (const name of BUILDER_FOUR) {
      expect(deny, `builder tool denied: ${name}`).not.toContain(name);
    }
  });

  it('denies the member five (构建面之外的工具不可见)', () => {
    const deny = builderToolFilter().deny;
    for (const name of MEMBER_TOOL_NAMES) {
      expect(deny, `member tool not denied: ${name}`).toContain(name);
    }
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
