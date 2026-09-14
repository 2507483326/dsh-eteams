/**
 * 输入栏团队按钮 · 子代理身份面纯函数单测（用户迭代 2026-09-10「子代理隐藏
 * 团队按钮」）：subagentFaceMode / subagentFaceTitle 是纯函数——主会话恒
 * interactive、子代理无身份（含加载中/失效）恒 hidden、身份在册 identity；
 * tooltip 按 kind 拼「成员/领队/构建师 + 团队后缀」。渲染组件依赖槽位运行
 * 时与宿主往返，这里只锁显隐决策与文案语义。
 */
import { describe, expect, it } from 'vitest';
import { subagentFaceMode, subagentFaceTitle } from '../src/client/lib/subagentFace';
import {
  anchoredMainTaskOf,
  sessionMembersOf,
  TEAM_BADGE_STAGE_LABELS,
  teamBadgeSummary,
} from '../src/client/lib/teamBadgeSummary';
import type { SessionIdentity } from '../src/client/lib/api';
import type { TaskView, TeamSnapshot } from '../src/client/lib/monitor';

describe('subagentFaceMode（子代理会话按钮三分显隐）', () => {
  it('主会话恒 interactive——选择/锁定交互不受身份查询影响', () => {
    expect(subagentFaceMode(false, false, null)).toBe('interactive');
    expect(subagentFaceMode(false, true, null)).toBe('interactive');
    expect(
      subagentFaceMode(false, true, {
        kind: 'member',
        name: 'Alice',
        teamId: '1',
        teamName: 'T',
        avatar: null,
      }),
    ).toBe('interactive');
  });

  it('子代理 + 身份在册 = identity（只读脸面）', () => {
    const identity: SessionIdentity = {
      kind: 'member',
      name: 'Alice',
      teamId: '1',
      teamName: '研发队',
      avatar: { seed: 3, salt: 7 },
    };
    expect(subagentFaceMode(true, true, identity)).toBe('identity');
  });

  it('子代理加载中 / 无身份 / 失效 = hidden——绝不闪出可交互按钮', () => {
    expect(subagentFaceMode(true, false, null)).toBe('hidden');
    expect(subagentFaceMode(true, true, null)).toBe('hidden');
  });
});

describe('subagentFaceTitle（身份面 tooltip）', () => {
  it('成员面带团队后缀', () => {
    expect(
      subagentFaceTitle({
        kind: 'member',
        name: 'Alice',
        teamId: '1',
        teamName: '研发队',
        avatar: null,
      }),
    ).toBe('成员「Alice」的子代理会话（团队「研发队」）');
  });

  it('领队面同口径', () => {
    expect(
      subagentFaceTitle({
        kind: 'captain',
        name: '项目牧羊人',
        teamId: '2',
        teamName: '交付队',
        avatar: null,
      }),
    ).toBe('领队「项目牧羊人」的子代理会话（团队「交付队」）');
  });

  it('构建师无团队、后缀不出现', () => {
    expect(
      subagentFaceTitle({
        kind: 'builder',
        name: '角色构建师',
        teamId: null,
        teamName: null,
        avatar: null,
      }),
    ).toBe('角色构建师的子代理会话');
  });
});

/** 任务行工厂（只填摘要消费的字段，其余给默认值）。 */
function taskOf(over: Partial<TaskView>): TaskView {
  return {
    taskId: 1,
    subject: '任务',
    kind: 'task',
    parentId: null,
    folder: null,
    description: null,
    contractMd: null,
    idempotencyNote: null,
    statusNote: null,
    status: 'ready',
    assignee: null,
    dependencies: [],
    chain: [],
    chainCursor: 0,
    chainLength: 0,
    retryCount: 0,
    currentAttemptId: null,
    outcome: null,
    attemptSummary: [],
    updatedAt: 0,
    ...over,
  };
}

/** 团队快照工厂（摘要只读 tasks；members/captain 供头像与领队名）。 */
function teamOf(tasks: TaskView[], members: string[] = []): TeamSnapshot {
  return {
    teamId: 't1',
    name: '研发队',
    progress: { completed: 0, total: tasks.length, cancelled: 0, active: 0 },
    leaderRemoved: false,
    captain: {
      name: '项目牧羊人',
      employeeId: 'ET-0001',
      role: 'captain',
      duty: '',
      style: '',
      skills: '',
      personaMd: null,
      avatar: { seed: 1, salt: 2 },
    },
    members: members.map((name) => ({
      name,
      employeeId: null,
      role: '',
      model: '',
      reasoningEffort: null,
      currentTaskId: null,
      currentAttemptId: null,
      childId: null,
      avatar: { seed: 3, salt: 4 },
    })),
    tasks,
    pendingDecisions: [],
    pendingAsks: [],
    latestEvents: [],
  };
}

describe('teamBadgeSummary（团队徽章 hover 摘要）', () => {
  it('执行中任务逐行给出执行人与主题，顺序同快照', () => {
    const summary = teamBadgeSummary(
      teamOf([
        taskOf({ taskId: 7, subject: '写文档', status: 'start', assignee: '张三' }),
        taskOf({ taskId: 9, subject: '跑测试', status: 'start', assignee: '李四' }),
      ]),
      '项目牧羊人',
    );
    expect(summary.executing).toEqual([
      { taskId: 7, subject: '写文档', member: '张三' },
      { taskId: 9, subject: '跑测试', member: '李四' },
    ]);
    expect(summary.statusLine).toBe('');
  });

  it('领队不列入——即使它是执行中任务的 assignee', () => {
    const summary = teamBadgeSummary(
      teamOf([
        taskOf({ taskId: 1, subject: '拆解', status: 'start', assignee: '项目牧羊人' }),
        taskOf({ taskId: 2, subject: '写码', status: 'start', assignee: '张三' }),
      ]),
      '项目牧羊人',
    );
    expect(summary.executing).toEqual([{ taskId: 2, subject: '写码', member: '张三' }]);
  });

  it('容器（无 assignee 的 start）不被列为执行人', () => {
    const summary = teamBadgeSummary(
      teamOf([
        taskOf({ taskId: 1, subject: '主任务', kind: 'group', status: 'start', assignee: null }),
        taskOf({ taskId: 2, subject: '子任务', status: 'start', assignee: '张三' }),
      ]),
    );
    expect(summary.executing).toEqual([{ taskId: 2, subject: '子任务', member: '张三' }]);
  });

  it('无执行中任务时按阶段优先级给文案', () => {
    expect(
      teamBadgeSummary(teamOf([taskOf({ status: 'creating' })]), '项目牧羊人').statusLine,
    ).toBe(TEAM_BADGE_STAGE_LABELS.creating);
    expect(
      teamBadgeSummary(teamOf([taskOf({ status: 'ready', assignee: '张三' })])).statusLine,
    ).toBe(TEAM_BADGE_STAGE_LABELS.dispatching);
    expect(teamBadgeSummary(teamOf([taskOf({ status: 'ready' })])).statusLine).toBe(
      TEAM_BADGE_STAGE_LABELS.waiting,
    );
    expect(teamBadgeSummary(teamOf([taskOf({ status: 'paused' })])).statusLine).toBe(
      TEAM_BADGE_STAGE_LABELS.paused,
    );
  });

  it('创建中优先于正在调度/等待中（容器拆解期）', () => {
    const summary = teamBadgeSummary(
      teamOf([
        taskOf({ taskId: 1, status: 'creating' }),
        taskOf({ taskId: 2, status: 'ready', assignee: '张三' }),
      ]),
    );
    expect(summary.statusLine).toBe(TEAM_BADGE_STAGE_LABELS.creating);
  });

  it('无任务/未落地/全部终态的兜底文案', () => {
    expect(teamBadgeSummary(teamOf([])).statusLine).toBe(TEAM_BADGE_STAGE_LABELS.waiting);
    expect(teamBadgeSummary(undefined).statusLine).toBe(TEAM_BADGE_STAGE_LABELS.waiting);
    expect(teamBadgeSummary(teamOf([taskOf({ status: 'completed' })])).statusLine).toBe(
      TEAM_BADGE_STAGE_LABELS.completed,
    );
  });
});

describe('anchoredMainTaskOf（本会话锚定的主任务，镜像宿主口径）', () => {
  it('命中本会话的无父无链主任务（带 mainSessionId 快照）', () => {
    const team = teamOf([
      taskOf({ taskId: 5, subject: '主任务', kind: 'group', sessionId: 's1' }),
      taskOf({ taskId: 6, parentId: 5, sessionId: 's1' }),
    ]);
    expect(anchoredMainTaskOf(team, 's1')?.taskId).toBe(5);
  });

  it('多命中取 taskId 最大者；他会话的任务不带出', () => {
    const team = teamOf([
      taskOf({ taskId: 3, subject: '旧主任务', kind: 'group', sessionId: 's1' }),
      taskOf({ taskId: 8, subject: '新主任务', kind: 'group', sessionId: 's1' }),
      taskOf({ taskId: 9, subject: '别会话', kind: 'group', sessionId: 's2' }),
    ]);
    expect(anchoredMainTaskOf(team, 's1')?.taskId).toBe(8);
  });

  it('带执行链的单杆任务不算锚（面板派发时补章了 mainSessionId 的情形）', () => {
    const team = teamOf([
      taskOf({
        taskId: 4,
        kind: 'group',
        sessionId: 's1',
        chain: [{ member: '1', stageBrief: '', stationStatus: 'pending' }],
        chainLength: 1,
      }),
    ]);
    expect(anchoredMainTaskOf(team, 's1')).toBeUndefined();
  });

  it('cancelled 容器释放锚点；空会话/无队伍返回 undefined', () => {
    const team = teamOf([
      taskOf({ taskId: 2, kind: 'group', sessionId: 's1', status: 'cancelled' }),
    ]);
    expect(anchoredMainTaskOf(team, 's1')).toBeUndefined();
    expect(anchoredMainTaskOf(team, '')).toBeUndefined();
    expect(anchoredMainTaskOf(undefined, 's1')).toBeUndefined();
  });
});

describe('sessionMembersOf（本任务的会话成员）', () => {
  it('只列本任务里子会话已起的成员（未建会话的不列），顺序随快照', () => {
    const task = taskOf({
      taskId: 5,
      kind: 'group',
      sessionId: 's1',
      memberSessions: [
        { name: '张三', employeeId: 7, sessionId: 'c1', avatar: { seed: 3, salt: 4 } },
        { name: '李四', employeeId: 8, sessionId: '', avatar: null },
        { name: '王五', employeeId: 9, sessionId: 'c2', avatar: null },
      ],
    });
    expect(sessionMembersOf(task)).toEqual([
      { name: '张三', avatar: { seed: 3, salt: 4 }, sessionId: 'c1' },
      { name: '王五', avatar: null, sessionId: 'c2' },
    ]);
  });

  it('旧快照 / 未给任务 → 空表', () => {
    expect(sessionMembersOf(undefined)).toEqual([]);
    expect(sessionMembersOf(taskOf({}))).toEqual([]);
  });
});
