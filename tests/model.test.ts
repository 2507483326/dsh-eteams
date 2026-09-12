import { describe, expect, it } from 'vitest';
import {
  applyTransition,
  canTransition,
  dependenciesSatisfied,
  dependentsOf,
  hasUpcomingStation,
  nextChainStation,
  sanitizeKey,
  stationProgress,
  taskSlug,
  TransitionError,
  unsatisfiedDependencies,
  wouldCycle,
} from '../src/host/model/taskMachine';
import type { TaskRecord } from '../src/host/model/types';

const T0 = 1_000;

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 1,
    subject: '实现导出模块',
    parentId: null,
    dependencies: [],
    chain: [],
    chainCursor: -1,
    status: 'ready',
    attempts: [],
    retryCount: 0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

describe('task state machine edges (8 态，用户迭代 2026-09-11)', () => {
  it('creating 收口与放弃：creating -> ready / cancelled 合法，不经转移进入', () => {
    // 面板手动建任务容器：完善收口（finalizeCommissionTask）转 ready、
    // 用户放弃转 cancelled——creating 只在创建时直接落状态，无入边。
    const task = makeTask({ status: 'creating' });
    applyTransition(task, 'ready', T0 + 1);
    expect(task.status).toBe('ready');
    const abandon = makeTask({ status: 'creating' });
    applyTransition(abandon, 'cancelled', T0 + 1);
    expect(abandon.status).toBe('cancelled');
  });

  it('creating 不直跳执行/等人态：start / wait_user 非法（计划未定不可开跑）', () => {
    const task = makeTask({ status: 'creating' });
    expect(() => applyTransition(task, 'start', T0 + 1)).toThrow(TransitionError);
    expect(() => applyTransition(task, 'wait_user', T0 + 1)).toThrow(TransitionError);
  });

  it('follows the happy path（ready 派发后仍 ready，领取才 start）', () => {
    // 用户迭代 2026-09-11：派发不改状态，成员领取 ready→start。
    const task = makeTask({ status: 'ready' });
    expect(canTransition('ready', 'start')).toBe(true);
    applyTransition(task, 'start', T0 + 1);
    applyTransition(task, 'completed', T0 + 2);
    expect(task.status).toBe('completed');
    expect(task.completedAt).toBe(T0 + 2);
  });

  it('records a stage handoff as start -> ready', () => {
    const task = makeTask({ status: 'start' });
    applyTransition(task, 'ready', T0 + 1);
    expect(task.status).toBe('ready');
  });

  it('失败重试与改派归位：start -> ready；超限 start -> wait', () => {
    const retry = makeTask({ status: 'start' });
    applyTransition(retry, 'ready', T0 + 1);
    expect(retry.status).toBe('ready');
    const exhausted = makeTask({ status: 'start' });
    applyTransition(exhausted, 'wait', T0 + 2);
    expect(exhausted.status).toBe('wait');
  });

  it('待领队分诊（wait）：loop 回 ready / 升级 wait_user / 挂起 / 取消合法', () => {
    const loop = makeTask({ status: 'wait' });
    applyTransition(loop, 'ready', T0 + 1);
    expect(loop.status).toBe('ready');
    const escalate = makeTask({ status: 'wait' });
    applyTransition(escalate, 'wait_user', T0 + 1);
    expect(escalate.status).toBe('wait_user');
    const suspend = makeTask({ status: 'wait' });
    applyTransition(suspend, 'paused', T0 + 1);
    expect(suspend.status).toBe('paused');
    const cancel = makeTask({ status: 'wait' });
    applyTransition(cancel, 'cancelled', T0 + 1);
    expect(cancel.status).toBe('cancelled');
  });

  it('wait 不直跳 completed（分诊后必须回 ready/start 再跑）', () => {
    const task = makeTask({ status: 'wait' });
    expect(() => applyTransition(task, 'completed', T0 + 1)).toThrow(TransitionError);
  });

  it('挂起/恢复：ready -> paused -> ready', () => {
    const task = makeTask({ status: 'ready' });
    applyTransition(task, 'paused', T0 + 1);
    expect(task.status).toBe('paused');
    applyTransition(task, 'ready', T0 + 2);
    expect(task.status).toBe('ready');
  });

  it('lets a container jump ready -> completed and back（大任务完成可续）', () => {
    const task = makeTask({ status: 'ready', parentId: null });
    applyTransition(task, 'completed', T0 + 1);
    expect(task.status).toBe('completed');
    expect(task.completedAt).toBe(T0 + 1);
    // 用户迭代 2026-09-11「完成后还可以继续添加小任务继续」：追加小任务即回退。
    applyTransition(task, 'ready', T0 + 2);
    expect(task.status).toBe('ready');
  });

  it('小任务 completed 是终态（completed->ready 结构特例只给大任务）', () => {
    const sub = makeTask({ status: 'completed', parentId: 7 });
    expect(() => applyTransition(sub, 'ready', T0 + 1)).toThrow(TransitionError);
  });

  it('rejects illegal transitions with an actionable hint', () => {
    const task = makeTask({ status: 'completed' });
    expect(() => applyTransition(task, 'start', T0 + 1)).toThrow(TransitionError);
    // ready->completed 不是小任务合法边（只大任务收口特例）。
    const ready = makeTask({ status: 'ready', parentId: 9 });
    expect(() => applyTransition(ready, 'completed', T0 + 1)).toThrow(TransitionError);
  });
});

describe('dependency derivation（用户迭代 2026-09-11：不再物化，保持 ready）', () => {
  it('unsatisfied dependencies list non-completed deps', () => {
    const t1 = makeTask({ id: 1, status: 'start' });
    const t2 = makeTask({ id: 2, dependencies: [1] });
    expect(unsatisfiedDependencies([t1, t2], t2)).toEqual([1]);
    t1.status = 'completed';
    expect(dependenciesSatisfied([t1, t2], t2)).toBe(true);
  });

  it('依赖未完成的任务保持 ready（无物化状态、无事件）', () => {
    const t1 = makeTask({ id: 1, status: 'paused' });
    const t2 = makeTask({ id: 2, dependencies: [1], status: 'ready' });
    expect(dependenciesSatisfied([t1, t2], t2)).toBe(false);
    // 状态不被依赖派生改写——派发口据 dependenciesSatisfied 拒绝派发。
    expect(t2.status).toBe('ready');
    t1.status = 'completed';
    expect(dependenciesSatisfied([t1, t2], t2)).toBe(true);
    expect(t2.status).toBe('ready');
  });

  it('dependentsOf finds direct consumers', () => {
    const t1 = makeTask({ id: 1 });
    const t2 = makeTask({ id: 2, dependencies: [1] });
    expect(dependentsOf([t1, t2], 1)).toEqual([t2]);
  });

  it('wouldCycle detects direct and transitive loops', () => {
    const t1 = makeTask({ id: 1, dependencies: [2] });
    const t2 = makeTask({ id: 2 });
    expect(wouldCycle([t1, t2], 2, [1])).toBe(true);
    expect(wouldCycle([t1, t2], 2, [])).toBe(false);
  });
});

describe('execution chain helpers (D11)', () => {
  it('nextChainStation follows the cursor', () => {
    const task = makeTask({
      chain: [
        { member: 'Alice', stageBrief: '调研' },
        { member: 'Bob', stageBrief: '实现' },
      ],
      chainCursor: 0,
    });
    expect(nextChainStation(task)?.member).toBe('Bob');
    expect(hasUpcomingStation(task)).toBe(true);
    task.chainCursor = 1;
    expect(nextChainStation(task)).toBeUndefined();
    expect(hasUpcomingStation(task)).toBe(false);
  });

  it('stationProgress is undefined for chainless tasks', () => {
    expect(stationProgress(makeTask())).toBeUndefined();
    expect(
      stationProgress(makeTask({ chain: [{ member: 'A', stageBrief: 'x' }], chainCursor: -1 })),
    ).toEqual({
      done: 0,
      total: 1,
    });
  });
});

describe('key helpers', () => {
  it('sanitizeKey keeps cjk and collapses separators', () => {
    expect(sanitizeKey('登录 服务!!')).toBe('登录-服务');
    expect(sanitizeKey('  --  ')).toBe('team');
    expect(sanitizeKey('Alpha Beta Gamma')).toBe('alpha-beta-gamma');
  });

  it('taskSlug prefixes the integer task id (docs/35 §5#7)', () => {
    expect(taskSlug(makeTask({ id: 3, subject: '实现导出模块' }))).toBe('3-实现导出模块');
  });
});