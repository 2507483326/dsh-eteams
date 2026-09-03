/**
 * Registry-wide team location (docs/26 跨工作区): the band/panel locate teams
 * across every registered workspace, so the tool layer must agree — a session
 * whose project folder differs from the team's workspace gets its tool env
 * re-pointed to the team's workspace (user iteration 2026-09-03: band showed
 * 「生效中」 while tools reported 「当前会话不在任何 eteams 团队中」).
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { envForAgent } from '../src/host/tools/identity';
import { locateAgentTeam } from '../src/host/runtime/workspaces';
import type { RuntimeEnv } from '../src/host/runtime/base';
import { clearSessionTeam, setSessionTeam } from '../src/host/runtime/sessionTeam';
import {
  captainChildTeamOf,
  registerCaptainChild,
  unregisterCaptainChild,
} from '../src/host/runtime/captainAgent';
import type { ETeamsResolvedConfig } from '../src/host/config';
import type { TeamState } from '../src/host/model/types';

let base: string;
let wsA: string;
let wsB: string;
const config = { stateDir: '.eteams' } as unknown as ETeamsResolvedConfig;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'eteams-ws-'));
  wsA = join(base, 'ws-a');
  wsB = join(base, 'ws-b');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  clearSessionTeam('s-driver');
  unregisterCaptainChild('s-child');
});

function putTeam(ws: string, team: TeamState): void {
  mkdirSync(join(ws, '.eteams', team.id), { recursive: true });
  writeFileSync(join(ws, '.eteams', team.id, 'team.json'), JSON.stringify(team));
}

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

/** Host ctx stub exposing the registry under both service key candidates. */
function ctxWithRegistry(paths: string[]): unknown {
  const registry = { list: () => paths.map((path) => ({ path, title: path })) };
  return {
    get: (key: string) =>
      key === 'workspaceRegistry' || key === 'workspace' ? registry : undefined,
  };
}

const NO_CTX = {};

describe('locateAgentTeam (registry-wide, binding → captain → member)', () => {
  it('finds a bound team living in ANOTHER workspace (跨工作区绑定)', () => {
    putTeam(wsB, team());
    const ctx = ctxWithRegistry([wsA, wsB]);
    const located = locateAgentTeam(config, ctx, 's-other', wsA, 'demo');
    expect(located?.workspacePath).toBe(wsB);
    expect(located?.team.id).toBe('demo');
  });

  it('binding wins over own captaincy in another workspace', () => {
    putTeam(wsA, team({ id: 'own', captainSessionId: 's-x' }));
    putTeam(wsB, team({ id: 'bound', name: '绑定队' }));
    setSessionTeam('s-x', { teamId: 'bound', name: '绑定队', boundAt: 1 });
    try {
      const located = locateAgentTeam(config, ctxWithRegistry([wsA, wsB]), 's-x', wsA, 'bound');
      expect(located?.workspacePath).toBe(wsB);
      expect(located?.team.id).toBe('bound');
    } finally {
      clearSessionTeam('s-x');
    }
  });

  it('finds a panel-created team by captainSessionId across workspaces', () => {
    putTeam(wsB, team({ captainSessionId: 's-panel' }));
    const located = locateAgentTeam(config, ctxWithRegistry([wsA, wsB]), 's-panel', wsA);
    expect(located?.workspacePath).toBe(wsB);
  });

  it('finds a member by durable child session id across workspaces', () => {
    putTeam(
      wsB,
      team({ members: [{ id: 'm-1', name: '甲', status: 'active' } as TeamState['members'][0]] }),
    );
    const located = locateAgentTeam(config, ctxWithRegistry([wsA, wsB]), 'm-1', wsA);
    expect(located?.workspacePath).toBe(wsB);
  });

  it('excludes removed members', () => {
    putTeam(
      wsB,
      team({ members: [{ id: 'm-1', name: '甲', status: 'removed' } as TeamState['members'][0]] }),
    );
    expect(locateAgentTeam(config, ctxWithRegistry([wsA, wsB]), 'm-1', wsA)).toBeUndefined();
  });

  it('degrades to own-workspace-only without the registry service', () => {
    putTeam(wsA, team({ captainSessionId: 's-own' }));
    // 绑定指向不存在的团队 → 按优先级落到本工作区领队身份（与 resolveCaller 一致）。
    const withGhost = locateAgentTeam(config, NO_CTX, 's-own', wsA, 'ghost');
    expect(withGhost?.workspacePath).toBe(wsA);
    expect(withGhost?.team.id).toBe('demo');
    const located = locateAgentTeam(config, NO_CTX, 's-own', wsA);
    expect(located?.workspacePath).toBe(wsA);
  });

  it('ignores blank agent ids', () => {
    expect(locateAgentTeam(config, ctxWithRegistry([wsA]), '', wsA, 'demo')).toBeUndefined();
  });
});

describe('envForAgent re-point (tool env follows the team workspace)', () => {
  function agentOf(id: string, cwd: string): Agent {
    return { id, session: { header: { cwd } } } as unknown as Agent;
  }

  it('re-points a cross-workspace bound session to the team workspace', () => {
    putTeam(wsB, team());
    setSessionTeam('s-other', { teamId: 'demo', name: '演示团队', boundAt: 1 });
    const env = envForAgent(
      config,
      ctxWithRegistry([wsA, wsB]) as never,
      agentOf('s-other', wsA),
    ) as RuntimeEnv;
    expect(env.workspace).toBe(wsB);
  });

  it('re-points a captain child the same way (领队子代理跨工作区)', () => {
    // docs/26 用户迭代 2026-09-03: the dispatch child acts as team captain —
    // its eteams_* env must follow the team's workspace too.
    putTeam(wsB, team({ captainSessionId: 's-creator' }));
    registerCaptainChild('s-child', 'demo');
    expect(captainChildTeamOf('s-child')).toBe('demo');
    const env = envForAgent(
      config,
      ctxWithRegistry([wsA, wsB]) as never,
      agentOf('s-child', wsA),
    ) as RuntimeEnv;
    expect(env.workspace).toBe(wsB);
  });

  it('keeps the session cwd when nothing matches', () => {
    const env = envForAgent(
      config,
      ctxWithRegistry([wsA, wsB]) as never,
      agentOf('s-stranger', wsA),
    ) as RuntimeEnv;
    expect(env.workspace).toBe(wsA);
  });
});
