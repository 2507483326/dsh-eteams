/**
 * deletableOf 单测（docs/44 M3）：任务列表卡「删除」按钮显隐判据（src/client/
 * pages/tasks/taskListCard.tsx）——镜像 host deleteTask 守卫
 * （src/host/runtime/assignment.ts）口径锁定：
 * ① 本身未领取（draft/ready/creating 才可删——creating 仅容器分支放宽，
 * docs/panelTaskCommission：创建中的容器是手动建任务占位，删除 = 逃生门）；
 * ② 主任务级联删除要求全部小任务 draft/ready；
 * ③ 删除集（自身 + 小任务）不得被任何未入集任务依赖。
 * host 仍是最终裁决（webui DELETE 路由，拒绝原因就地显示）——本单测只锁
 * 面板侧判据与 host 守卫同口径（防止两侧漂移出「点了必被拒」或「可删却不
 * 给删」的按钮）。两侧任一改动都应同步对侧并回改本单测（注释互链）。
 */
import { describe, expect, it } from 'vitest';
import type { TaskView } from '../src/client/lib/monitor';
import { deletableOf } from '../src/client/pages/tasks/taskListCard';

/** 最小快照行（deletableOf 只消费 status/parentId/taskId/dependencies，
 * 其余字段按快照缺省补齐）。 */
const taskOf = (overrides: Partial<TaskView> & { taskId: number }): TaskView => ({
  subject: '任务',
  kind: 'task',
  parentId: null,
  folder: null,
  description: null,
  contractMd: null,
  idempotencyNote: null,
  blocked: false,
  blockedFrom: null,
  statusNote: null,
  status: 'draft',
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
  ...overrides,
});

/** 按 taskId 取 fixture 行（测试内部数据，缺失即测试自身写错）。 */
const byId = (tasks: TaskView[], id: number): TaskView => {
  const hit = tasks.find((t) => t.taskId === id);
  if (hit === undefined) throw new Error(`fixture missing task #${id}`);
  return hit;
};

describe('deletableOf（镜像 host deleteTask 守卫口径）', () => {
  it('① 本身未领取才可删：creating/draft/ready ✓（creating 仅容器分支放宽），已入执行/终态 ✗（十一态逐格）', () => {
    const deletableStates = ['creating', 'draft', 'ready'];
    const undeletableStates = [
      'wait',
      'start',
      'paused',
      'wait_decision',
      'wait_user',
      'completed',
      'failed',
      'cancelled',
    ];
    for (const status of [...deletableStates, ...undeletableStates]) {
      const tasks = [taskOf({ taskId: 1, status })];
      expect(deletableOf(byId(tasks, 1), tasks), status).toBe(
        deletableStates.includes(status),
      );
    }
  });

  it('② 主任务级联：全部小任务 draft/ready → 可删', () => {
    const tasks = [
      taskOf({ taskId: 1, kind: 'group', status: 'ready' }),
      taskOf({ taskId: 2, parentId: 1, status: 'draft' }),
      taskOf({ taskId: 3, parentId: 1, status: 'ready' }),
    ];
    expect(deletableOf(byId(tasks, 1), tasks)).toBe(true);
  });

  it('② creating 容器：无小任务可删（逃生门）；小任务分支判据不放宽（docs/panelTaskCommission）', () => {
    // 创建中容器自身（手动建任务占位、尚未拆解）——删除 = 逃生门。
    const empty = [taskOf({ taskId: 1, kind: 'group', status: 'creating' })];
    expect(deletableOf(byId(empty, 1), empty)).toBe(true);
    // 小任务分支不放宽：creating 容器下已有执行中小任务 → 整组不可删。
    const tasks = [
      taskOf({ taskId: 1, kind: 'group', status: 'creating' }),
      taskOf({ taskId: 2, parentId: 1, status: 'draft' }),
      taskOf({ taskId: 3, parentId: 1, status: 'wait' }),
    ];
    expect(deletableOf(byId(tasks, 1), tasks)).toBe(false);
  });

  it('② 主任务级联：任一小任务已入执行 → 整组不可删', () => {
    const tasks = [
      taskOf({ taskId: 1, kind: 'group', status: 'ready' }),
      taskOf({ taskId: 2, parentId: 1, status: 'draft' }),
      taskOf({ taskId: 3, parentId: 1, status: 'wait' }),
    ];
    expect(deletableOf(byId(tasks, 1), tasks)).toBe(false);
  });

  it('③ 删除集被未入集任务依赖 → 不可删（自身被依赖）', () => {
    const tasks = [
      taskOf({ taskId: 1, status: 'draft' }),
      taskOf({ taskId: 2, status: 'ready', dependencies: [1] }),
    ];
    expect(deletableOf(byId(tasks, 1), tasks)).toBe(false);
  });

  it('③ 主任务的小任务被外部依赖 → 整组不可删（删除集含小任务）', () => {
    const tasks = [
      taskOf({ taskId: 1, kind: 'group', status: 'ready' }),
      taskOf({ taskId: 2, parentId: 1, status: 'draft' }),
      taskOf({ taskId: 3, status: 'ready', dependencies: [2] }),
    ];
    expect(deletableOf(byId(tasks, 1), tasks)).toBe(false);
  });

  it('删除集内部互相依赖不影响（依赖方/被依赖方一同入删除集）', () => {
    const tasks = [
      taskOf({ taskId: 1, kind: 'group', status: 'ready' }),
      taskOf({ taskId: 2, parentId: 1, status: 'draft' }),
      taskOf({ taskId: 3, parentId: 1, status: 'draft', dependencies: [2] }),
    ];
    expect(deletableOf(byId(tasks, 1), tasks)).toBe(true);
  });

  it('外部任务依赖的是删除集之外的任务 → 不影响可删判定', () => {
    const tasks = [
      taskOf({ taskId: 1, status: 'draft' }),
      taskOf({ taskId: 2, status: 'ready' }),
      taskOf({ taskId: 3, status: 'wait', dependencies: [2] }),
    ];
    expect(deletableOf(byId(tasks, 1), tasks)).toBe(true);
  });
});