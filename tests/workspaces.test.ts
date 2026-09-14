/**
 * Registry-wide team location (docs/26 跨工作区): the band/panel locate teams
 * across every registered workspace, so the tool layer must agree — a session
 * whose project folder differs from the team's workspace gets its tool env
 * re-pointed to the team's workspace (user iteration 2026-09-03: band showed
 * 「生效中」 while tools reported 「当前会话不在任何 eteams 团队中」).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { envForAgent } from '../src/host/tools/identity';
import { locateAgentTeam } from '../src/host/runtime/workspaces';
import { joinPath, stateRootFor, type RuntimeEnv } from '../src/host/runtime/base';
import { insertTeamRow, withTeamTx, writeTeamInTx } from '../src/host/state/store';
import { LEADER_NAME } from '../src/host/state/db';
import { clearSessionTeam, setSessionTeam } from '../src/host/runtime/sessionTeam';
import {
  captainChildTeamOf,
  registerCaptainChild,
  unregisterCaptainChild,
} from '../src/host/runtime/captainChildRegistry';
import { cleanupTempWorkspace } from './support/tmpWorkspace';
import type { ETeamsResolvedConfig } from '../src/host/config';
import type { TaskMemberRecord, TaskRecord, TeamState } from '../src/host/model/types';

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
  // 团队现在落 SQLite（<ws>/.eteams），先关两个工作区的连接再删目录。
  cleanupTempWorkspace(wsA);
  cleanupTempWorkspace(wsB);
  rmSync(base, { recursive: true, force: true });
  clearSessionTeam('s-driver');
  clearSessionTeam('s-other');
  clearSessionTeam('s-x');
  unregisterCaptainChild('s-child');
});

function leaderRow(teamId: number): TaskMemberRecord {
  return {
    id: 0,
    teamId,
    mainTaskId: null,
    nowTaskId: null,
    name: LEADER_NAME,
    employeeId: null,
    sessionId: '',
    roleId: null,
    createdAt: 1,
  };
}

function memberRow(teamId: number, sessionId: string): TaskMemberRecord {
  return {
    id: 0,
    teamId,
    mainTaskId: null,
    nowTaskId: null,
    name: '甲',
    employeeId: null,
    sessionId,
    roleId: null,
    createdAt: 1,
  };
}

/** SQLite 契约播种（替代旧 team.json 落盘）：team 行 + 可选领队/成员实例行。
 * 领队身份锚点（v6）落在任务行 main_session_id 快照——leaderSession 同值盖章。 */
function seedTeam(
  ws: string,
  opts: {
    name?: string;
    leaderSession?: string;
    memberSession?: string;
  } = {},
): TeamState {
  const root = joinPath(ws, '.eteams');
  const name = opts.name ?? '演示团队';
  let teamId = 0;
  withTeamTx(root, undefined, (tx) => {
    teamId = insertTeamRow(tx, name, opts.leaderSession !== undefined, tx.now);
  });
  const taskMembers: TaskMemberRecord[] = [];
  const tasks: TaskRecord[] = [];
  if (opts.leaderSession !== undefined) {
    taskMembers.push(leaderRow(teamId));
    tasks.push({
      id: 1,
      subject: '演示任务',
      parentId: null,
      dependencies: [],
      chain: [],
      chainCursor: -1,
      status: 'ready',
      attempts: [],
      retryCount: 0,
      mainSessionId: opts.leaderSession,
      createdAt: 1,
      updatedAt: 1,
    });
  }
  if (opts.memberSession !== undefined) {
    taskMembers.push(memberRow(teamId, opts.memberSession));
  }
  const state: TeamState = {
    id: teamId,
    name,
    hasLeader: opts.leaderSession !== undefined,
    createdAt: 1,
    updatedAt: 1,
    taskMembers,
    members: [],
    tasks,
    pendingDecisions: [],
  };
  withTeamTx(root, teamId, (tx) => writeTeamInTx(tx, state));
  return state;
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
    const seeded = seedTeam(wsB);
    const ctx = ctxWithRegistry([wsA, wsB]);
    const located = locateAgentTeam(config, ctx, 's-other', wsA, String(seeded.id));
    expect(located?.workspacePath).toBe(wsB);
    expect(located?.team.id).toBe(seeded.id);
  });

  it('binding wins over own captaincy in another workspace', () => {
    seedTeam(wsA, { leaderSession: 's-x' });
    // team_id 是各工作区库内自增（两库各自从 1 发号），补一条填充行把绑定队
    // 顶到 2，保证绑定键（数字串）在 wsA 里不存在——跨工作区定位才会走到 wsB。
    seedTeam(wsB, { name: '填充队' });
    const bound = seedTeam(wsB, { name: '绑定队' });
    setSessionTeam('s-x', { teamId: String(bound.id), name: bound.name, boundAt: 1 });
    try {
      const located = locateAgentTeam(
        config,
        ctxWithRegistry([wsA, wsB]),
        's-x',
        wsA,
        String(bound.id),
      );
      expect(located?.workspacePath).toBe(wsB);
      expect(located?.team.id).toBe(bound.id);
    } finally {
      clearSessionTeam('s-x');
    }
  });

  it('finds a panel-created team by captainSessionId across workspaces', () => {
    seedTeam(wsB, { leaderSession: 's-panel' });
    const located = locateAgentTeam(config, ctxWithRegistry([wsA, wsB]), 's-panel', wsA);
    expect(located?.workspacePath).toBe(wsB);
  });

  it('finds a member by durable child session id across workspaces', () => {
    seedTeam(wsB, { memberSession: 'm-1' });
    const located = locateAgentTeam(config, ctxWithRegistry([wsA, wsB]), 'm-1', wsA);
    expect(located?.workspacePath).toBe(wsB);
  });

  it('degrades to own-workspace-only without the registry service', () => {
    const own = seedTeam(wsA, { leaderSession: 's-own' });
    // 绑定指向不存在的团队 → 按优先级落到本工作区领队身份（与 resolveCaller 一致）。
    const withGhost = locateAgentTeam(config, NO_CTX, 's-own', wsA, 'ghost');
    expect(withGhost?.workspacePath).toBe(wsA);
    expect(withGhost?.team.id).toBe(own.id);
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
    const seeded = seedTeam(wsB);
    setSessionTeam('s-other', { teamId: String(seeded.id), name: seeded.name, boundAt: 1 });
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
    const seeded = seedTeam(wsB, { leaderSession: 's-creator' });
    registerCaptainChild('s-child', String(seeded.id));
    expect(captainChildTeamOf('s-child')).toBe(String(seeded.id));
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

describe('stateRootFor (全局单库口径)', () => {
  it('绝对 stateDir：所有工作区共用同一个全局根', () => {
    const globalConfig = { stateDir: 'C:/Users/epat/.eteams' } as ETeamsResolvedConfig;
    expect(stateRootFor(globalConfig, 'C:/eTeam')).toBe('C:/Users/epat/.eteams');
    expect(stateRootFor(globalConfig, 'C:/Users/epat/test')).toBe(
      stateRootFor(globalConfig, 'C:/eTeam'),
    );
    // 尾随斜杠归一掉，不产生空段。
    expect(stateRootFor(globalConfig, 'X')).toBe('C:/Users/epat/.eteams');
  });

  it('相对 stateDir：保持 per-workspace 旧口径', () => {
    const relConfig = { stateDir: '.eteams' } as ETeamsResolvedConfig;
    expect(stateRootFor(relConfig, wsA)).toBe(joinPath(wsA, '.eteams'));
    expect(stateRootFor(relConfig, wsB)).toBe(joinPath(wsB, '.eteams'));
  });
});
