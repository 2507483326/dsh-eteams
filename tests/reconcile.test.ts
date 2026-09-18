/**
 * 死会话对账（用户 2026-09-18「应用重启后还一直是 执行中，执行中的好像没有
 * 获取状态」）：宿主重启后库里的在办 attempt 没人吊销——中断观察者靠进程内
 * 会话注册表反查、重启即空，崩溃也不会再有 turn/end 事件补记。本组锁定对账
 * 判据：只扫在办 attempt，其执行会话不在宿主活 agent 集合里即吊销并挂起；
 * 会话还活着 / 宽限期内 / 非在办一律不动。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { resolveConfig, type ETeamsResolvedConfig } from '../src/host/config';
import { LEADER_NAME } from '../src/host/runtime/roster';
import { joinPath } from '../src/host/runtime/base';
import { reconcileDeadSessions, resetReconcilerForTests } from '../src/host/runtime/reconcile';
import { readEventsSync } from '../src/host/state/events';
import { insertTeamRow, readTeamSync, withTeamTx, writeTeamInTx } from '../src/host/state/store';
import type { AttemptRecord, TaskMemberRecord, TeamState } from '../src/host/model/types';
import { cleanupTempWorkspace } from './support/tmpWorkspace';

let ws: string;
let root: string;
let config: ETeamsResolvedConfig;

/** 在办尝试所用的成员子会话 id（测试用固定值，模拟重启前派发出去的会话）。 */
const MEMBER_SESSION = 'sess-member-1';
const SUB_TASK_ID = 2;
const GROUP_TASK_ID = 1;

/**
 * 播种：容器（start）+ 小任务（start，带一个 running attempt）+
 * 成员副本行（绑会话）。attempt 的既有形状照 attempts 表（v7 task_member_id）。
 */
function seedTeam(opts: { memberSessionId?: string; attemptStatus?: AttemptRecord['status'] } = {}): number {
  let teamId = 0;
  withTeamTx(root, undefined, (tx) => {
    teamId = insertTeamRow(tx, '演示团队', true, tx.now);
  });
  const attempt: AttemptRecord = {
    id: 1,
    taskId: SUB_TASK_ID,
    kind: 'initial',
    member: 'Alice',
    taskMemberId: 5,
    status: opts.attemptStatus ?? 'running',
    token: 'tok',
    stationIndex: -1,
    createdAt: 1,
    claimedAt: 1,
    progress: [],
  };
  const leaderRow: TaskMemberRecord = {
    id: 4,
    teamId,
    mainTaskId: GROUP_TASK_ID,
    nowTaskId: null,
    name: LEADER_NAME,
    employeeId: null,
    sessionId: '',
    roleId: null,
    status: 'ready',
    isLeader: true,
    createdAt: 1,
  };
  const memberRow: TaskMemberRecord = {
    id: 5,
    teamId,
    mainTaskId: GROUP_TASK_ID,
    nowTaskId: SUB_TASK_ID,
    name: 'Alice',
    employeeId: 2,
    sessionId: opts.memberSessionId ?? MEMBER_SESSION,
    roleId: null,
    status: 'ready',
    createdAt: 1,
  };
  const team: TeamState = {
    id: teamId,
    name: '演示团队',
    hasLeader: true,
    createdAt: 1,
    updatedAt: 1,
    members: [
      {
        memberId: 2,
        roleId: null,
        name: 'Alice',
        employeeId: 2,
        role: 'engineer',
        persona: {
          frameworkVersion: 1,
          role: 'engineer',
          duty: '',
          style: '',
          skills: '',
          rules: [],
          executionPrompt: '',
        },
        modelRoute: { model: '' },
        avatar: { seed: 1, salt: 1 },
        createdAt: 1,
      },
    ],
    taskMembers: [leaderRow, memberRow],
    tasks: [
      {
        id: GROUP_TASK_ID,
        subject: '容器',
        parentId: null,
        dependencies: [],
        chain: [],
        chainCursor: -1,
        status: 'start',
        attempts: [],
        retryCount: 0,
        mainSessionId: 'cap-1',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: SUB_TASK_ID,
        subject: '小任务',
        parentId: GROUP_TASK_ID,
        dependencies: [],
        chain: [],
        chainCursor: -1,
        status: 'start',
        attempts: [attempt],
        retryCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    pendingDecisions: [],
  };
  withTeamTx(root, teamId, (tx) => writeTeamInTx(tx, team));
  return teamId;
}

/** 最小宿主 ctx：活 agent 列表（存活判据）+ 工作区注册表（状态根枚举）。 */
function fakeCtx(liveIds: readonly string[]): Context {
  return {
    logger: { info: () => undefined, warn: () => undefined },
    get: (key: string) =>
      key === 'workspaceRegistry' || key === 'workspace'
        ? { list: () => [{ path: ws, title: 'ws' }] }
        : undefined,
    agents: { list: () => liveIds.map((id) => ({ id })) },
  } as unknown as Context;
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'eteams-reconcile-'));
  root = joinPath(ws, '.eteams');
  config = resolveConfig({ stateDir: '.eteams' });
});

afterEach(() => {
  resetReconcilerForTests();
  cleanupTempWorkspace(ws);
});

describe('死会话对账（宿主重启后的在办 attempt）', () => {
  it('活集合为空（重启）→ 吊销 attempt、小任务挂起、容器同步挂起、留痕 session.dead', async () => {
    const teamId = seedTeam();
    const paused = await reconcileDeadSessions(fakeCtx([]), config, { graceMs: 0 });
    expect(paused).toBe(1);

    const team = readTeamSync(root, teamId)!;
    const sub = team.tasks.find((t) => t.id === SUB_TASK_ID)!;
    expect(sub.status).toBe('paused');
    expect(sub.attempts[0]!.status).toBe('revoked');
    // 容器由「有在办小任务」派生：小任务挂起后主任务同步挂起（用户迭代 2026-09-11）。
    expect(team.tasks.find((t) => t.id === GROUP_TASK_ID)!.status).toBe('paused');

    const suspended = readEventsSync(root, teamId).find((e) => e.type === 'task.suspended');
    expect(suspended).toBeDefined();
    expect((suspended!.payload as Record<string, unknown>).via).toBe('session.dead');
  });

  it('会话仍在活集合里 → 不判死、状态不动', async () => {
    const teamId = seedTeam();
    const paused = await reconcileDeadSessions(fakeCtx([MEMBER_SESSION]), config, { graceMs: 0 });
    expect(paused).toBe(0);
    const team = readTeamSync(root, teamId)!;
    expect(team.tasks.find((t) => t.id === SUB_TASK_ID)!.status).toBe('start');
    expect(team.tasks.find((t) => t.id === SUB_TASK_ID)!.attempts[0]!.status).toBe('running');
  });

  it('宽限期内（在办时长 < graceMs）→ 即使不在活集合里也不动', async () => {
    const teamId = seedTeam();
    // since = 1（远古），用「现在就是 since」模拟刚派出：now - since = 0 < grace。
    const paused = await reconcileDeadSessions(fakeCtx([]), config, { graceMs: 1_000, now: 1 });
    expect(paused).toBe(0);
    expect(readTeamSync(root, teamId)!.tasks.find((t) => t.id === SUB_TASK_ID)!.status).toBe('start');
  });

  it('成员会话从未建立（sessionId 为空）→ 过宽限期同样挂起', async () => {
    const teamId = seedTeam({ memberSessionId: '' });
    const paused = await reconcileDeadSessions(fakeCtx([]), config, { graceMs: 0 });
    expect(paused).toBe(1);
    expect(readTeamSync(root, teamId)!.tasks.find((t) => t.id === SUB_TASK_ID)!.status).toBe('paused');
  });

  it('非在办 attempt（已 succeeded）→ 不在扫描范围，不动', async () => {
    const teamId = seedTeam({ attemptStatus: 'succeeded' });
    const paused = await reconcileDeadSessions(fakeCtx([]), config, { graceMs: 0 });
    expect(paused).toBe(0);
    expect(readTeamSync(root, teamId)!.tasks.find((t) => t.id === SUB_TASK_ID)!.status).toBe('start');
  });

  it('活 agent 服务缺失（旧运行时）→ 当空集合处理，不抛异常', async () => {
    const teamId = seedTeam();
    const ctx = {
      logger: { info: () => undefined, warn: () => undefined },
      get: (key: string) =>
        key === 'workspaceRegistry' ? { list: () => [{ path: ws, title: 'ws' }] } : undefined,
    } as unknown as Context;
    const paused = await reconcileDeadSessions(ctx, config, { graceMs: 0 });
    expect(paused).toBe(1);
    expect(readTeamSync(root, teamId)!.tasks.find((t) => t.id === SUB_TASK_ID)!.status).toBe('paused');
  });
});
