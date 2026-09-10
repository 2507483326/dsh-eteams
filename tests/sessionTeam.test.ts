/**
 * Session-team binding (docs/26 + docs/teamSessionLock): the band branches,
 * the 领队子代理 relay split, and the 2026-09-10 lock semantics — a bound
 * session is permanently pinned to one team (binding persists, no one-shot
 * consumption), and a session with an in-flight anchored main task routes
 * new work to 增补小任务 instead of building another main task.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { resolveCaller } from '../src/host/tools/identity';
import { insertTeamRow, writeTeam, withTeamTx } from '../src/host/state/store';
import { joinPath, type RuntimeEnv } from '../src/host/runtime/base';
import {
  anchoredMainTaskOf,
  clearSessionTeam,
  clearSessionTeamForTeam,
  getSessionTeamBinding,
  getSessionTeamId,
  sessionTeamSection,
  setSessionTeam,
} from '../src/host/runtime/sessionTeam';
import {
  captainChildTeamOf,
  registerCaptainChild,
  unregisterCaptainChild,
} from '../src/host/runtime/captainAgent';
import { LEADER_NAME } from '../src/host/state/db';
import { cleanupTempWorkspace } from './support/tmpWorkspace';
import type { TaskMemberRecord, TaskRecord, TeamState } from '../src/host/model/types';

let ws: string;
let root: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'eteams-sessionteam-'));
  // 状态根与 runtime 同口径（base.ts joinPath 的「/」拼法）——resolveCaller
  // 里 stateRootOf 用的就是这把键；getDb 连接缓存按它做键，收尾才能关掉。
  root = joinPath(ws, '.eteams');
});

afterEach(() => {
  cleanupTempWorkspace(ws);
  clearSessionTeam('s-other');
  clearSessionTeam('s-creator');
  clearSessionTeam('s-x');
  clearSessionTeam('s-a');
  clearSessionTeam('s-b');
  unregisterCaptainChild('s-child');
  unregisterCaptainChild('s-stranger');
});

function team(overrides: Partial<TeamState> = {}): TeamState {
  return {
    id: 1,
    name: '演示团队',
    hasLeader: true,
    createdAt: 1,
    updatedAt: 1,
    taskMembers: [],
    members: [],
    tasks: [],
    pendingDecisions: [],
    ...overrides,
  };
}

/** 主任务行（锚定判据输入：parentId 为空 + mainSessionId 盖章 + 状态）。 */
function mainTask(id: number, mainSessionId: string, status: TaskRecord['status']): TaskRecord {
  return {
    id,
    subject: `任务 ${id}`,
    parentId: null,
    dependencies: [],
    chain: [],
    chainCursor: -1,
    status,
    attempts: [],
    retryCount: 0,
    mainSessionId,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** 领队实例行（v6：领队行 session_id 只记领队子代理会话；主会话锚点在任务行）。 */
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

describe('sessionTeamSection branches', () => {
  it('contributes nothing for unbound sessions', () => {
    expect(sessionTeamSection('s-none', () => team())).toBe('');
    expect(sessionTeamSection(undefined, () => team())).toBe('');
  });

  it('declares the fixed-conversation semantics (锁定声明)', () => {
    // 用户迭代 2026-09-10「对话固定为团队对话」：band 显式声明 1 对话 1 团队，
    // 模型不再建议取消选择或换团队。
    setSessionTeam('s-other', { teamId: 'demo', name: '演示团队', boundAt: 1 });
    const band = sessionTeamSection('s-other', () => team());
    expect(band).toContain('【eteams 团队绑定·生效中】');
    expect(band).toContain('本对话已固定为团队对话');
    expect(band).toContain('一个对话只对应一个团队');
    expect(band).not.toContain('你就是该团队的领队');
    expect(band).not.toContain('他队');
  });

  it('runs the two-step workflow when no main task is anchored (先建任务再转交)', () => {
    // 用户迭代 2026-09-07 两步走：主会话第一步自己建主任务（标题由模型把
    // 原话简化），第二步转交持续领队子代理分解分配。锁定语义下该形态保留
    // ——只在无进行中锚定主任务时走。
    setSessionTeam('s-other', { teamId: 'demo', name: '演示团队', boundAt: 1 });
    const band = sessionTeamSection('s-other', () => team());
    expect(band).toContain('第一步·建任务');
    expect(band).toContain('eteams_submit_task');
    expect(band).toContain('把用户原话简化成一句话任务标题');
    expect(band).toContain('第二步·转交');
    expect(band).toContain('eteams_dispatch_captain');
    expect(band).toContain('主任务号');
    expect(band).toContain('以领队的名字命名');
  });

  it('anchors to the in-flight main task: dispatch-only增补 workflow (有领队)', () => {
    // 用户迭代 2026-09-10「已创建任务走增补子任务」：锚定主任务 #3 在案时
    // 新工作直接转交领队（taskId=3），由领队挂 parentTaskId 增补——不再
    // 两步走建任务。
    setSessionTeam('s-other', { teamId: 'demo', name: '演示团队', boundAt: 1 });
    const band = sessionTeamSection('s-other', () =>
      team({ tasks: [mainTask(3, 's-other', 'ready')] }),
    );
    expect(band).toContain('主任务 #3');
    expect(band).toContain('eteams_dispatch_captain（taskId=3，message=用户原话）');
    expect(band).toContain('增补小任务');
    expect(band).toContain('parentTaskId=3');
    expect(band).toContain('不要再 eteams_submit_task');
    // 两步走的建任务第一步不再出现。
    expect(band).not.toContain('第一步·建任务');
  });

  it('anchors to the main task: leaderless self-hosted增补 workflow (无领队)', () => {
    setSessionTeam('s-other', { teamId: 'demo', name: '演示团队', boundAt: 1 });
    const band = sessionTeamSection('s-other', () =>
      team({ hasLeader: false, tasks: [mainTask(5, 's-other', 'wait')] }),
    );
    expect(band).toContain('主任务 #5');
    expect(band).toContain('团队未设领队');
    expect(band).toContain('eteams_create_task（parentTaskId=5）');
    expect(band).toContain('ask_user_question');
    expect(band).toContain('不要再 eteams_submit_task');
    // dispatch 只出现在红线「不要调用」里，不出现指令形态（taskId= 调用式）。
    expect(band).not.toContain('eteams_dispatch_captain（taskId=');
  });

  it('keeps the for-built-entry-tools red line in the anchored band (转交分工)', () => {
    setSessionTeam('s-other', { teamId: 'demo', name: '演示团队', boundAt: 1 });
    const band = sessionTeamSection('s-other', () =>
      team({ tasks: [mainTask(3, 's-other', 'ready')] }),
    );
    expect(band).toContain('不要调用其它 eteams_* 工具');
    expect(band).toContain('不要自己动手执行');
    expect(band).toContain('不要复述全文');
  });

  it('falls back to two-step when all anchored main tasks are terminal (终态回退)', () => {
    // 锚定判据只认非终态主任务：completed 容器不再锚定——band 回到两步走，
    // 允许开新项目（新建主任务）。
    setSessionTeam('s-other', { teamId: 'demo', name: '演示团队', boundAt: 1 });
    const band = sessionTeamSection('s-other', () =>
      team({ tasks: [mainTask(3, 's-other', 'completed')] }),
    );
    expect(band).toContain('第一步·建任务');
    expect(band).toContain('eteams_submit_task');
    expect(band).not.toContain('增补小任务');
  });

  it('branches on hasLeader in the two-step shape（docs/panelTaskCommission）', () => {
    // 无领队团队的完善/推进路径就是主会话直接主持；有领队仍是转交 band。
    setSessionTeam('s-other', { teamId: 'demo', name: '演示团队', boundAt: 1 });
    const kept = sessionTeamSection('s-other', () => team());
    const removed = sessionTeamSection('s-other', () => team({ hasLeader: false }));
    expect(kept).toContain('持续领队子代理');
    expect(kept).toContain('eteams_dispatch_captain');
    expect(removed).toContain('本团队未设领队');
    expect(removed).toContain('由本会话直接主持');
    expect(removed).toContain('eteams_submit_task');
    expect(removed).toContain('不自批开跑');
    expect(removed).not.toContain('eteams_dispatch_captain');
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
    expect(band).toContain('重新选择其他团队');
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

describe('绑定常驻（用户迭代 2026-09-10 锁定语义）', () => {
  it('the binding persists across repeated reads (无一次性消费)', () => {
    setSessionTeam('s-other', { teamId: 'demo', name: '演示团队', boundAt: 1 });
    // 绑定不是回合凭证：连读两次都在（旧的一次性消费函数已删除）。
    expect(getSessionTeamBinding('s-other')).toEqual({
      teamId: 'demo',
      name: '演示团队',
      boundAt: 1,
    });
    expect(getSessionTeamId('s-other')).toBe('demo');
    expect(getSessionTeamBinding('s-other')).toEqual({
      teamId: 'demo',
      name: '演示团队',
      boundAt: 1,
    });
  });

  it('clearSessionTeamForTeam drops only the entries pointing at that team (删队逃生口)', () => {
    setSessionTeam('s-a', { teamId: 't1', name: '甲队', boundAt: 1 });
    setSessionTeam('s-b', { teamId: 't2', name: '乙队', boundAt: 2 });
    clearSessionTeamForTeam('t1');
    expect(getSessionTeamBinding('s-a')).toBeUndefined();
    expect(getSessionTeamBinding('s-b')).toEqual({ teamId: 't2', name: '乙队', boundAt: 2 });
    // 幂等：再清一次不报错、其余条目不动。
    clearSessionTeamForTeam('t1');
    expect(getSessionTeamBinding('s-b')).toEqual({ teamId: 't2', name: '乙队', boundAt: 2 });
  });
});

describe('anchoredMainTaskOf（锚定判据：本会话最新非终态主任务）', () => {
  it('picks the latest non-terminal main task of the session', () => {
    const t = team({
      tasks: [
        mainTask(1, 's-other', 'ready'),
        mainTask(4, 's-other', 'wait'),
      ],
    });
    expect(anchoredMainTaskOf(t, 's-other')?.id).toBe(4);
  });

  it('ignores terminal main tasks, other sessions, and subtasks', () => {
    const t = team({
      tasks: [
        mainTask(1, 's-other', 'completed'),
        mainTask(2, 's-else', 'ready'),
        { ...mainTask(3, 's-other', 'wait'), parentId: 2 },
        mainTask(5, 's-other', 'cancelled'),
      ],
    });
    expect(anchoredMainTaskOf(t, 's-other')).toBeUndefined();
  });

  it('ignores chained standalone tasks (面板单杆的派发锚点补章不误锚)', () => {
    // 面板 start 路由派发时把主会话快照补章到任务行——带链的独立小任务
    // 因此也带 mainSessionId；容器由 createTask 校验保证不带链，据此区分。
    const t = team({
      tasks: [{ ...mainTask(5, 's-other', 'wait'), chain: [{ member: 3, stageBrief: '做' }] }],
    });
    expect(anchoredMainTaskOf(t, 's-other')).toBeUndefined();
  });

  it('treats wait_decision / failed-superseded states as non-terminal anchors', () => {
    // 阻塞/等待决策中的主任务仍在进行——继续锚定增补。
    const t = team({
      tasks: [
        mainTask(2, 's-other', 'wait_decision'),
        mainTask(6, 's-other', 'failed'),
      ],
    });
    expect(anchoredMainTaskOf(t, 's-other')?.id).toBe(2);
  });

  it('returns undefined for blank session ids and empty teams', () => {
    expect(anchoredMainTaskOf(team(), 's-other')).toBeUndefined();
    expect(
      anchoredMainTaskOf(team({ tasks: [mainTask(1, 's-other', 'ready')] }), ''),
    ).toBeUndefined();
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

  /** SQLite 契约建队：team 行 + 领队实例行；领队身份锚点盖章在任务行快照（v6）。 */
  async function seedTeam(name: string, leaderSession?: string): Promise<TeamState> {
    let teamId = 0;
    withTeamTx(root, undefined, (tx) => {
      teamId = insertTeamRow(tx, name, leaderSession !== undefined, tx.now);
    });
    const state: TeamState = {
      id: teamId,
      name,
      hasLeader: leaderSession !== undefined,
      createdAt: 1,
      updatedAt: 1,
      taskMembers: leaderSession !== undefined ? [leaderRow(teamId)] : [],
      members: [],
      tasks:
        leaderSession !== undefined
          ? [
              {
                id: 1,
                subject: '演示任务',
                parentId: null,
                dependencies: [],
                chain: [],
                chainCursor: -1,
                status: 'ready',
                attempts: [],
                retryCount: 0,
                mainSessionId: leaderSession,
                createdAt: 1,
                updatedAt: 1,
              },
            ]
          : [],
      pendingDecisions: [],
    };
    await writeTeam(root, state);
    return state;
  }

  it('resolves a bound non-captain session as the bound team captain', async () => {
    const seeded = await seedTeam('演示团队', 's-creator');
    setSessionTeam('s-other', { teamId: String(seeded.id), name: seeded.name, boundAt: 1 });
    const caller = await resolveCaller(envFor(ws), agentOf('s-other'));
    expect(caller.kind).toBe('captain');
    if (caller.kind === 'captain') expect(caller.team.id).toBe(seeded.id);
  });

  it('resolves a registered captain child as its team captain (领队子代理)', async () => {
    // docs/26 用户迭代 2026-09-03: the dispatch-spawned child acts as the
    // team captain for every eteams_* call it makes.
    const seeded = await seedTeam('演示团队', 's-creator');
    registerCaptainChild('s-child', String(seeded.id));
    const caller = await resolveCaller(envFor(ws), agentOf('s-child'));
    expect(caller.kind).toBe('captain');
    if (caller.kind === 'captain') expect(caller.team.id).toBe(seeded.id);
    expect(captainChildTeamOf('s-child')).toBe(String(seeded.id));
  });

  it('captain-child registration beats neither binding nor falls to members', async () => {
    // A stranger id with a stale registration for a missing team falls
    // through to the normal not-in-team error.
    await seedTeam('演示团队', 's-creator');
    registerCaptainChild('s-stranger', 'ghost-team');
    await expect(resolveCaller(envFor(ws), agentOf('s-stranger'))).rejects.toThrow(
      '当前会话不在任何 eteams 团队中',
    );
  });

  it('binding wins over the session own captaincy', async () => {
    await seedTeam('甲队', 's-x');
    const teamB = await seedTeam('乙队');
    setSessionTeam('s-x', { teamId: String(teamB.id), name: teamB.name, boundAt: 1 });
    const caller = await resolveCaller(envFor(ws), agentOf('s-x'));
    if (caller.kind === 'captain') expect(caller.team.id).toBe(teamB.id);
    else throw new Error('expected captain caller');
  });

  it('creator captaincy still resolves without a binding', async () => {
    const seeded = await seedTeam('演示团队', 's-creator');
    const caller = await resolveCaller(envFor(ws), agentOf('s-creator'));
    expect(caller.kind).toBe('captain');
    if (caller.kind === 'captain') expect(caller.team.id).toBe(seeded.id);
  });

  it('falls through when the bound team no longer exists', async () => {
    const teamA = await seedTeam('甲队', 's-x');
    setSessionTeam('s-x', { teamId: 'ghost', name: '幽灵', boundAt: 1 });
    const caller = await resolveCaller(envFor(ws), agentOf('s-x'));
    if (caller.kind === 'captain') expect(caller.team.id).toBe(teamA.id);
    else throw new Error('expected captain caller');
  });

  it('still rejects a session with no binding, captaincy, or membership', async () => {
    await seedTeam('演示团队', 's-creator');
    await expect(resolveCaller(envFor(ws), agentOf('s-stranger2'))).rejects.toThrow(
      '当前会话不在任何 eteams 团队中',
    );
  });
});
