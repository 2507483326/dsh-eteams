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
    id: 't1',
    subject: '实现导出模块',
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

describe('task state machine edges', () => {
  it('follows the happy staged path', () => {
    const task = makeTask({ status: 'draft' });
    applyTransition(task, 'ready', T0 + 1);
    applyTransition(task, 'assigned', T0 + 2);
    applyTransition(task, 'in_progress', T0 + 3);
    applyTransition(task, 'completed', T0 + 4);
    expect(task.status).toBe('completed');
    expect(task.completedAt).toBe(T0 + 4);
  });

  it('records stage_completed as in_progress -> ready', () => {
    const task = makeTask({ status: 'in_progress' });
    applyTransition(task, 'ready', T0 + 1);
    expect(task.status).toBe('ready');
  });

  it('rejects illegal transitions with an actionable hint', () => {
    const task = makeTask({ status: 'completed' });
    expect(() => applyTransition(task, 'in_progress', T0 + 1)).toThrow(TransitionError);
    const ready = makeTask({ status: 'ready' });
    expect(() => applyTransition(ready, 'in_progress', T0 + 1)).toThrow(TransitionError);
  });

  it('bookkeeps blockedFrom on materialized blocked', () => {
    const task = makeTask({ status: 'assigned' });
    applyTransition(task, 'blocked', T0 + 1);
    expect(task.blockedFrom).toBe('assigned');
    applyTransition(task, 'cancelled', T0 + 2);
    expect(task.blockedFrom).toBeUndefined();
  });

  it('restoreBlocked returns to ready only when deps recovered', () => {
    const task = makeTask({ status: 'ready', blockedFrom: 'ready' });
    task.status = 'blocked';
    expect(restoreBlocked(task, false, T0 + 1)).toBe('blocked');
    expect(restoreBlocked(task, true, T0 + 2)).toBe('ready');
  });
});

describe('dependency derivation', () => {
  it('unsatisfied dependencies list non-completed deps', () => {
    const t1 = makeTask({ id: 't1', status: 'in_progress' });
    const t2 = makeTask({ id: 't2', dependencies: ['t1'] });
    expect(unsatisfiedDependencies([t1, t2], t2)).toEqual(['t1']);
    t1.status = 'completed';
    expect(dependenciesSatisfied([t1, t2], t2)).toBe(true);
  });

  it('refreshDependencyStatus materializes blocked and recovers it', () => {
    const t1 = makeTask({ id: 't1', status: 'suspended' });
    const t2 = makeTask({ id: 't2', dependencies: ['t1'], status: 'ready' });
    expect(refreshDependencyStatus([t1, t2], t2, T0 + 1)).toBe(true);
    expect(t2.status).toBe('blocked');
    expect(t2.blockedFrom).toBe('ready');
    t1.status = 'completed';
    expect(refreshDependencyStatus([t1, t2], t2, T0 + 2)).toBe(true);
    expect(t2.status).toBe('ready');
    expect(t2.blockedFrom).toBeUndefined();
  });

  it('leaves captain-controlled waiting states alone', () => {
    const t1 = makeTask({ id: 't1', status: 'suspended' });
    const t2 = makeTask({ id: 't2', dependencies: ['t1'], status: 'paused' });
    expect(refreshDependencyStatus([t1, t2], t2, T0 + 1)).toBe(false);
    expect(t2.status).toBe('paused');
    const t3 = makeTask({ id: 't3', dependencies: ['t1'], status: 'assigned' });
    expect(refreshDependencyStatus([t1, t3], t3, T0 + 1)).toBe(false);
    expect(t3.status).toBe('assigned');
  });

  it('dependentsOf finds direct consumers', () => {
    const t1 = makeTask({ id: 't1' });
    const t2 = makeTask({ id: 't2', dependencies: ['t1'] });
    expect(dependentsOf([t1, t2], 't1')).toEqual([t2]);
  });

  it('wouldCycle detects direct and transitive loops', () => {
    const t1 = makeTask({ id: 't1', dependencies: ['t2'] });
    const t2 = makeTask({ id: 't2' });
    expect(wouldCycle([t1, t2], 't2', ['t1'])).toBe(true);
    expect(wouldCycle([t1, t2], 't2', [])).toBe(false);
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

  it('taskSlug prefixes the task id', () => {
    expect(taskSlug(makeTask({ id: 't3', subject: '实现导出模块' }))).toBe('t3-实现导出模块');
  });
});
