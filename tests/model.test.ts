import { describe, expect, it } from 'vitest';
import {
  applyTransition,
  dependenciesSatisfied,
  dependentsOf,
  hasUpcomingStation,
  nextChainStation,
  refreshDependencyStatus,
  restoreBlocked,
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

describe('task state machine edges (11 态, docs/35 §4 映射方案 A + docs/panelTaskCommission)', () => {
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

  it('creating 不直跳执行/等待语义态：start / wait 非法（计划未定不可开跑）', () => {
    const task = makeTask({ status: 'creating' });
    expect(() => applyTransition(task, 'start', T0 + 1)).toThrow(TransitionError);
    expect(() => applyTransition(task, 'wait', T0 + 1)).toThrow(TransitionError);
  });

  it('follows the happy staged path', () => {
    const task = makeTask({ status: 'draft' });
    applyTransition(task, 'ready', T0 + 1);
    applyTransition(task, 'wait', T0 + 2);
    applyTransition(task, 'start', T0 + 3);
    applyTransition(task, 'completed', T0 + 4);
    expect(task.status).toBe('completed');
    expect(task.completedAt).toBe(T0 + 4);
  });

  it('records a stage handoff as start -> ready', () => {
    const task = makeTask({ status: 'start' });
    applyTransition(task, 'ready', T0 + 1);
    expect(task.status).toBe('ready');
  });

  it('lets a childless container jump ready -> completed (对话任务组收口)', () => {
    const task = makeTask({ status: 'ready', parentId: null });
    applyTransition(task, 'completed', T0 + 1);
    expect(task.status).toBe('completed');
    expect(task.completedAt).toBe(T0 + 1);
  });

  it('rejects illegal transitions with an actionable hint', () => {
    const task = makeTask({ status: 'completed' });
    expect(() => applyTransition(task, 'start', T0 + 1)).toThrow(TransitionError);
    const ready = makeTask({ status: 'ready' });
    expect(() => applyTransition(ready, 'start', T0 + 1)).toThrow(TransitionError);
  });

  it('bookkeeps blockedFrom on materialized blocked and clears it on exit', () => {
    const task = makeTask({ status: 'wait', blockedFrom: 'ready' });
    applyTransition(task, 'cancelled', T0 + 2);
    expect(task.status).toBe('cancelled');
    expect(task.blockedFrom).toBeUndefined();
  });

  it('restoreBlocked returns to ready only when deps recovered', () => {
    const task = makeTask({ status: 'wait', blockedFrom: 'ready' });
    expect(restoreBlocked(task, false, T0 + 1)).toBe('wait');
    expect(task.blockedFrom).toBe('ready');
    expect(restoreBlocked(task, true, T0 + 2)).toBe('ready');
    expect(task.blockedFrom).toBeUndefined();
  });
});

describe('dependency derivation', () => {
  it('unsatisfied dependencies list non-completed deps', () => {
    const t1 = makeTask({ id: 1, status: 'start' });
    const t2 = makeTask({ id: 2, dependencies: [1] });
    expect(unsatisfiedDependencies([t1, t2], t2)).toEqual([1]);
    t1.status = 'completed';
    expect(dependenciesSatisfied([t1, t2], t2)).toBe(true);
  });

  it('refreshDependencyStatus materializes blocked and recovers it', () => {
    const t1 = makeTask({ id: 1, status: 'paused' });
    const t2 = makeTask({ id: 2, dependencies: [1], status: 'ready' });
    expect(refreshDependencyStatus([t1, t2], t2, T0 + 1)).toBe(true);
    expect(t2.status).toBe('wait');
    expect(t2.blockedFrom).toBe('ready');
    t1.status = 'completed';
    expect(refreshDependencyStatus([t1, t2], t2, T0 + 2)).toBe(true);
    expect(t2.status).toBe('ready');
    expect(t2.blockedFrom).toBeUndefined();
  });

  it('leaves dispatched/running tasks alone (只有 ready 物化)', () => {
    const t1 = makeTask({ id: 1, status: 'paused' });
    const t2 = makeTask({ id: 2, dependencies: [1], status: 'paused' });
    expect(refreshDependencyStatus([t1, t2], t2, T0 + 1)).toBe(false);
    expect(t2.status).toBe('paused');
    const t3 = makeTask({ id: 3, dependencies: [1], status: 'wait' });
    expect(refreshDependencyStatus([t1, t3], t3, T0 + 1)).toBe(false);
    expect(t3.status).toBe('wait');
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