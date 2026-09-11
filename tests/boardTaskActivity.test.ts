/**
 * subtaskWindowOf 单测（docs/47 DB8）：看板「任务动态」分区主任务卡的小任务
 * 窗口截取（src/client/pages/board/taskActivity.tsx）——需求原话「最多显示
 * 4 个小任务」的口径锁定：
 * ① 窗口 = MAX_SUBTASK_ROWS（4）行；
 * ② 溢出计数 = 超出部分（渲染「还有 n 个小任务」行的数据源）；
 * ③ 执行序由调用方排入（组件内 executionOrderOf，与详情页同款），本函数
 *    不重排——乱序入参原序透传；
 * ④ 空集 → 空窗零溢出。
 */
import { describe, expect, it } from 'vitest';
import type { TaskView } from '../src/client/lib/monitor';
import { MAX_SUBTASK_ROWS, subtaskWindowOf } from '../src/client/pages/board/taskActivity';

/** 最小快照行（subtaskWindowOf 只消费数组位置——taskId 供断言识别，其余
 * 字段按快照缺省补齐，fixture 形状对齐 taskListCard.test.ts）。 */
const taskOf = (taskId: number): TaskView => ({
  taskId,
  subject: `小任务 ${taskId}`,
  kind: 'task',
  parentId: 1,
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
});

describe('subtaskWindowOf（看板小任务窗口，docs/47 DB8）', () => {
  it('窗口上限常量 = 4（需求「最多显示4个小任务」）', () => {
    expect(MAX_SUBTASK_ROWS).toBe(4);
  });

  it('超出 4 行：前 4 行入窗，溢出计数 = 其余', () => {
    const subs = [1, 2, 3, 4, 5, 6].map(taskOf);
    const { shown, hidden } = subtaskWindowOf(subs);
    expect(shown.map((s) => s.taskId)).toEqual([1, 2, 3, 4]);
    expect(hidden).toBe(2);
  });

  it('恰好 4 行：全入窗、零溢出', () => {
    const subs = [1, 2, 3, 4].map(taskOf);
    const { shown, hidden } = subtaskWindowOf(subs);
    expect(shown).toHaveLength(4);
    expect(hidden).toBe(0);
  });

  it('不足 4 行：全入窗、零溢出', () => {
    const subs = [7, 8].map(taskOf);
    const { shown, hidden } = subtaskWindowOf(subs);
    expect(shown.map((s) => s.taskId)).toEqual([7, 8]);
    expect(hidden).toBe(0);
  });

  it('空集：空窗零溢出', () => {
    const { shown, hidden } = subtaskWindowOf([]);
    expect(shown).toEqual([]);
    expect(hidden).toBe(0);
  });

  it('执行序透传不重排：乱序入参按入参序截取（排序在组件内 executionOrderOf）', () => {
    const subs = [9, 3, 7, 1, 8, 2].map(taskOf);
    const { shown, hidden } = subtaskWindowOf(subs);
    expect(shown.map((s) => s.taskId)).toEqual([9, 3, 7, 1]);
    expect(hidden).toBe(2);
  });
});