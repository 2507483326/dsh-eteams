/**
 * Session-team binding (docs/26): the band branches and the 领队子代理
 * relay split — a bound session no longer self-hosts the captain workflow
 * (user iteration 2026-09-03「主窗口发问题不合适——由领队子代理完成主持」);
 * it relays via eteams_dispatch_captain and shows the child's report.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { resolveCaller } from '../src/host/tools/identity';
import { writeTeam } from '../src/host/state/store';
import type { RuntimeEnv } from '../src/host/runtime/base';
import {
  clearSessionTeam,
  getSessionTeamId,
  sessionTeamSection,
  setSessionTeam,
} from '../src/host/runtime/sessionTeam';
import {
  captainChildTeamOf,
  registerCaptainChild,
  unregisterCaptainChild,
} from '../src/host/runtime/captainAgent';
import type { TeamState } from '../src/host/model/types';

let ws: string;
let root: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'eteams-sessionteam-'));
  root = join(ws, '.eteams');
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  clearSessionTeam('s-other');
  clearSessionTeam('s-creator');
  clearSessionTeam('s-x');
  unregisterCaptainChild('s-child');
  unregisterCaptainChild('s-stranger');
});

function team(overrides: Partial<TeamState> = {}): TeamState {
  return {
    schemaVersion: 2,
    id: 'demo',
    name: '演示团队',
    goal: '目标',
    captainSessionId: 's-creator',
    phase: 'staged',
    createdAt: 1,
    updatedAt: 1,
    version: 0,
    taskSeq: 0,
    attemptSeq: 0,
    mailSeq: 0,
    maxRetries: 3,
    members: [],
    tasks: [],
    pendingDecisions: [],
    ...overrides,
  };
}

describe('sessionTeamSection branches', () => {
  it('contributes nothing for unbound sessions', () => {
    expect(sessionTeamSection('s-none', () => team())).toBe('');
    expect(sessionTeamSection(undefined, () => team())).toBe('');
  });

  it('assigns relay duties to the bound session (领队子代理主持)', () => {
    // Regression: the band no longer tells the main session to self-host
    // (问询/拆解/指派 moved to the one-shot captain child).
    setSessionTeam('s-other', { teamId: 'demo', name: '演示团队', boundAt: 1 });
    const band = sessionTeamSection('s-other', () => team());
    expect(band).toContain('【eteams 团队绑定·生效中】');
    expect(band).toContain('领队子代理');
    expect(band).toContain('eteams_dispatch_captain');
    expect(band).not.toContain('eteams_submit_task');
    expect(band).not.toContain('你就是该团队的领队');
    expect(band).not.toContain('他队');
  });

  it('forbids the main session calling eteams_* directly (转交分工)', () => {
    setSessionTeam('s-other', { teamId: 'demo', name: '演示团队', boundAt: 1 });
    const band = sessionTeamSection('s-other', () => team());
    expect(band).toContain('不要直接调用其它 eteams_* 工具');
    expect(band).toContain('不自己动手执行');
    expect(band).toContain('不要复述全文');
  });

  it('treats binding itself as task intent (绑定即意图，无需点名)', () => {
    // User iteration 2026-09-03「选择团队然后使用团队开始任务，主对话直接
    // 开始完成任务」: the old band gated dispatch on the user explicitly
    // saying 用团队做X, so a plain task message made the session execute the
    // task itself. The band must state binding = intent with no phrase gate.
    setSessionTeam('s-other', { teamId: 'demo', name: '演示团队', boundAt: 1 });
    const band = sessionTeamSection('s-other', () => team());
    expect(band).toContain('绑定即用户意图');
    expect(band).toContain('与消息里是否点名团队无关');
    expect(band).not.toContain('「用团队做X」');
  });

  it('is the same relay band whether or not the leader was removed', () => {
    // leaderRemoved once switched the main session into self-hosting; the
    // relay split makes the roster entry irrelevant to the band.
    setSessionTeam('s-other', { teamId: 'demo', name: '演示团队', boundAt: 1 });
    const kept = sessionTeamSection('s-other', () => team());
    const removed = sessionTeamSection('s-other', () => team({ leaderRemoved: true }));
    expect(removed).toBe(kept);
    expect(removed).not.toContain('由你（本会话）充当领队');
  });

  it('stays silent for a registered captain child (它自己就是领队)', () => {
    registerCaptainChild('s-child', 'demo');
    expect(sessionTeamSection('s-child', () => team())).toBe('');
    // Silence holds even with no binding recorded for the child id.
    expect(sessionTeamSection('s-child', () => undefined)).toBe('');
  });

  it('falls back to 失效 when the bound team is gone', () => {
    setSessionTeam('s-other', { teamId: 'demo', name: '演示团队', boundAt: 1 });
    const band = sessionTeamSection('s-other', () => undefined);
    expect(band).toContain('【eteams 团队绑定·失效】');
    expect(band).not.toContain('生效中');
  });
});

describe('getSessionTeamId', () => {
  it('round-trips set/clear', () => {
    expect(getSessionTeamId('s-x')).toBeUndefined();
    setSessionTeam('s-x', { teamId: 't9', name: 'n', boundAt: 1 });
    expect(getSessionTeamId('s-x')).toBe('t9');
    clearSessionTeam('s-x');
    expect(getSessionTeamId('s-x')).toBeUndefined();
  });

  it('ignores blank session ids', () => {
    setSessionTeam('', { teamId: 't9', name: 'n', boundAt: 1 });
    expect(getSessionTeamId('')).toBeUndefined();
  });
});

describe('resolveCaller 绑定优先 (binding-first identity)', () => {
  function envFor(workspace: string): RuntimeEnv {
    return {
      workspace,
      config: { stateDir: '.eteams' },
      ctx: {},
    } as unknown as RuntimeEnv;
  }

  function agentOf(id: string): Agent {
    return { id } as unknown as Agent;
  }

  it('resolves a bound non-captain session as the bound team captain', async () => {
    await writeTeam(root, team());
    setSessionTeam('s-other', { teamId: 'demo', name: '演示团队', boundAt: 1 });
    const caller = await resolveCaller(envFor(ws), agentOf('s-other'));
    expect(caller.kind).toBe('captain');
    if (caller.kind === 'captain') expect(caller.team.id).toBe('demo');
  });

  it('resolves a registered captain child as its team captain (领队子代理)', async () => {
    // docs/26 用户迭代 2026-09-03: the dispatch-spawned child acts as the
    // team captain for every eteams_* call it makes.
    await writeTeam(root, team({ captainSessionId: 's-creator' }));
    registerCaptainChild('s-child', 'demo');
    const caller = await resolveCaller(envFor(ws), agentOf('s-child'));
    expect(caller.kind).toBe('captain');
    if (caller.kind === 'captain') expect(caller.team.id).toBe('demo');
    expect(captainChildTeamOf('s-child')).toBe('demo');
  });

  it('captain-child registration beats neither binding nor falls to members', async () => {
    // A stranger id with a stale registration for a missing team falls
    // through to the normal not-in-team error.
    await writeTeam(root, team());
    registerCaptainChild('s-stranger', 'ghost-team');
    await expect(resolveCaller(envFor(ws), agentOf('s-stranger'))).rejects.toThrow(
      '当前会话不在任何 eteams 团队中',
    );
  });

  it('binding wins over the session own captaincy', async () => {
    await writeTeam(root, team({ id: 'team-a', captainSessionId: 's-x' }));
    await writeTeam(root, team({ id: 'team-b', name: '乙队' }));
    setSessionTeam('s-x', { teamId: 'team-b', name: '乙队', boundAt: 1 });
    const caller = await resolveCaller(envFor(ws), agentOf('s-x'));
    if (caller.kind === 'captain') expect(caller.team.id).toBe('team-b');
    else throw new Error('expected captain caller');
  });

  it('creator captaincy still resolves without a binding', async () => {
    await writeTeam(root, team());
    const caller = await resolveCaller(envFor(ws), agentOf('s-creator'));
    expect(caller.kind).toBe('captain');
    if (caller.kind === 'captain') expect(caller.team.id).toBe('demo');
  });

  it('falls through when the bound team no longer exists', async () => {
    await writeTeam(root, team({ id: 'team-a', captainSessionId: 's-x' }));
    setSessionTeam('s-x', { teamId: 'ghost', name: '幽灵', boundAt: 1 });
    const caller = await resolveCaller(envFor(ws), agentOf('s-x'));
    if (caller.kind === 'captain') expect(caller.team.id).toBe('team-a');
    else throw new Error('expected captain caller');
  });

  it('still rejects a session with no binding, captaincy, or membership', async () => {
    await writeTeam(root, team());
    await expect(resolveCaller(envFor(ws), agentOf('s-stranger2'))).rejects.toThrow(
      '当前会话不在任何 eteams 团队中',
    );
  });
});
