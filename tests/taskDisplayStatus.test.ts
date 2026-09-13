/**
 * 展示态派生层单测（用户迭代 2026-09-11：精简为 7 态后又恢复独立 wait=
 * 待领队分诊 = 8 态：draft/ready/wait 并入 ready，wait_decision/failed 并入
 * wait_user）：8 态→展示态映射全表（含 cancelled 同桶异色特例）、retryCount
 * 并入 detail、未知态中性回退、isStartable/isTerminal 开始钮状态窗口（M3 收拢
 * 三处开始钮判据）与 isGroupStartable（创建中容器不渲染开始钮——与宿主
 * startGroupTask 同闸镜像；completed 需先追加小任务回 ready）、isDetailReadOnly
 * （创建中详情只读观望档——用户 2026-09-13）、group 汇总优先级（error > doing >
 * waiting > done 全完成 null）与全部 done → null。
 */
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_STATUS_LABELS,
  STATUS_GROUPS,
  STATUS_LABELS,
  displayStatusOf,
  groupDisplayOf,
  isDetailReadOnly,
  isGroupStartable,
  isStartable,
  isTerminal,
} from '../src/client/features/tasks/taskDisplayStatus';

describe('displayStatusOf（8 态→展示态全表）', () => {
  it('逐格对表（key/label/tone；creating 创建中占位 init 桶）', () => {
    expect(displayStatusOf('creating')).toEqual({
      key: 'init',
      label: '创建中',
      tone: 'info',
      detail: '',
    });
    expect(displayStatusOf('ready')).toEqual({
      key: 'created',
      label: '待开始',
      tone: 'info',
      detail: '',
    });
    expect(displayStatusOf('paused')).toEqual({
      key: 'waiting',
      label: '已挂起',
      tone: 'warn',
      detail: '',
    });
    expect(displayStatusOf('start')).toEqual({
      key: 'doing',
      label: '执行中',
      tone: 'info',
      detail: '',
    });
    expect(displayStatusOf('completed')).toEqual({
      key: 'done',
      label: '已完成',
      tone: 'ok',
      detail: '',
    });
  });

  it('error 桶同桶异色：wait / wait_user 黄、cancelled 中性灰（不标红）', () => {
    expect(displayStatusOf('wait')).toEqual({
      key: 'error',
      label: '待领队',
      tone: 'warn',
      detail: '',
    });
    expect(displayStatusOf('wait_user')).toEqual({
      key: 'error',
      label: '待用户',
      tone: 'warn',
      detail: '',
    });
    expect(displayStatusOf('cancelled')).toEqual({
      key: 'error',
      label: '已取消',
      tone: 'muted',
      detail: '',
    });
  });

  it('retryCount 并入 detail（重试 n）', () => {
    expect(displayStatusOf('start', 2)).toEqual({
      key: 'doing',
      label: '执行中',
      tone: 'info',
      detail: '重试 2',
    });
    expect(displayStatusOf('start', 0).detail).toBe('');
    expect(displayStatusOf('ready', 3).detail).toBe('重试 3');
    expect(displayStatusOf('wait_user', 1).detail).toBe('重试 1');
  });

  it('未知状态中性回退（旧快照/词表外不臆造档位）', () => {
    expect(displayStatusOf('unknown_state')).toEqual({
      key: 'init',
      label: 'unknown_state',
      tone: 'muted',
      detail: '',
    });
  });
});

describe('STATUS_LABELS（8 态精确词表）', () => {
  it('8 态齐全且值与词表一致（用户迭代 2026-09-11）', () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual(
      ['cancelled', 'completed', 'creating', 'paused', 'ready', 'start', 'wait', 'wait_user'].sort(),
    );
    expect(STATUS_LABELS.creating).toBe('创建中');
    expect(STATUS_LABELS.ready).toBe('待开始');
    expect(STATUS_LABELS.wait).toBe('待领队');
    expect(STATUS_LABELS.wait_user).toBe('待用户');
    expect(STATUS_LABELS.cancelled).toBe('已取消');
  });
});

describe('ATTEMPT_STATUS_LABELS（词表搬家后口径）', () => {
  it('尝试六态词表齐全', () => {
    expect(Object.keys(ATTEMPT_STATUS_LABELS).sort()).toEqual(
      ['failed', 'paused', 'pending_accept', 'revoked', 'running', 'succeeded'].sort(),
    );
  });
});

describe('isStartable / isTerminal（M3 收拢三处开始钮判据的状态窗口）', () => {
  it('isStartable：ready（待开始）与 paused（中断挂起，点开始即续跑）渲染「开始」钮', () => {
    expect(isStartable('ready')).toBe(true);
    expect(isStartable('paused')).toBe(true);
    expect(isStartable('creating')).toBe(false);
    expect(isStartable('start')).toBe(false);
    expect(isStartable('wait')).toBe(false);
    expect(isStartable('wait_user')).toBe(false);
    expect(isStartable('completed')).toBe(false);
    expect(isStartable('cancelled')).toBe(false);
  });

  it('isTerminal：completed/cancelled 终态，其余渲染（含 wait 待领队）', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('creating')).toBe(false);
    expect(isTerminal('ready')).toBe(false);
    expect(isTerminal('start')).toBe(false);
    expect(isTerminal('wait')).toBe(false);
    expect(isTerminal('paused')).toBe(false);
    expect(isTerminal('wait_user')).toBe(false);
    // 未知态（旧快照/词表外）非终态——开始钮照渲染（原 !== 串比较同口径）。
    expect(isTerminal('unknown_state')).toBe(false);
  });
});

describe('isGroupStartable（组开始钮判据扩位，docs/panelTaskCommission）', () => {
  it('非终态、非创建中、非已完成才渲染（大任务 completed 需先追加小任务回 ready）', () => {
    expect(isGroupStartable('ready')).toBe(true);
    expect(isGroupStartable('start')).toBe(true);
    expect(isGroupStartable('wait')).toBe(true);
    expect(isGroupStartable('paused')).toBe(true);
    expect(isGroupStartable('wait_user')).toBe(true);
    expect(isGroupStartable('creating')).toBe(false);
    expect(isGroupStartable('completed')).toBe(false);
    expect(isGroupStartable('cancelled')).toBe(false);
    // 未知态非终态非创建中非已完成——照渲染（原 !isTerminal 同口径）。
    expect(isGroupStartable('unknown_state')).toBe(true);
  });
});

describe('isDetailReadOnly（创建中详情只读档，用户 2026-09-13）', () => {
  it('创建中的容器 / 父仍为创建中的小任务 → 只读', () => {
    // 容器详情（parentStatus=null）在 creating → 只读观望。
    expect(isDetailReadOnly('creating', null)).toBe(true);
    // 小任务（ready）在创建中的父任务下 → 同只读（拆解期不给就地编排）。
    expect(isDetailReadOnly('ready', 'creating')).toBe(true);
  });

  it('非创建中（含 ready/start/completed）→ 可编辑', () => {
    expect(isDetailReadOnly('ready', null)).toBe(false);
    expect(isDetailReadOnly('start', null)).toBe(false);
    expect(isDetailReadOnly('paused', null)).toBe(false);
    expect(isDetailReadOnly('completed', null)).toBe(false);
    // 小任务在非创建中父任务下照常可编辑（原口径不变）。
    expect(isDetailReadOnly('ready', 'ready')).toBe(false);
    expect(isDetailReadOnly('ready', 'start')).toBe(false);
  });
});

describe('groupDisplayOf（组卡汇总优先级）', () => {
  it('空小任务集 → null（不渲染 chip）', () => {
    expect(groupDisplayOf([])).toBeNull();
  });

  it('error 优先：✕ n 项异常（err 红 + 首个异常 detail）', () => {
    const summary = groupDisplayOf([
      { status: 'start' },
      { status: 'wait_user', retryCount: 3 },
      { status: 'cancelled' },
    ]);
    // 首个异常小任务 = wait_user（待用户）——detail 取它的词表文案。
    expect(summary).toEqual({ label: '2 项异常', tone: 'err', icon: '✕', detail: '待用户' });
  });

  it('wait（待领队）计入异常桶：detail 取「待领队」', () => {
    const summary = groupDisplayOf([{ status: 'start' }, { status: 'wait' }]);
    expect(summary).toEqual({ label: '1 项异常', tone: 'err', icon: '✕', detail: '待领队' });
  });

  it('无异常含 doing → n 执行中（info）', () => {
    const summary = groupDisplayOf([{ status: 'ready' }, { status: 'start' }]);
    expect(summary).toEqual({ label: '1 执行中', tone: 'info', icon: '', detail: '' });
  });

  it('无异常无 doing 含 waiting（paused）→ n 已挂起（warn）', () => {
    const summary = groupDisplayOf([{ status: 'ready' }, { status: 'paused' }]);
    expect(summary).toEqual({ label: '1 已挂起', tone: 'warn', icon: '', detail: '' });
  });

  it('全部 done → null（进度行已表达，不加 chip）', () => {
    expect(groupDisplayOf([{ status: 'completed' }, { status: 'completed' }])).toBeNull();
  });

  it('其余（全 ready）→ null（用户迭代 2026-09-08：状态 pill 已表达待开始，chip 不重复画）', () => {
    expect(groupDisplayOf([{ status: 'ready' }, { status: 'ready' }])).toBeNull();
  });
});

describe('STATUS_GROUPS（8 态一列键序规范，十一轮 DA24 后列表平铺无渲染方）', () => {
  it('每态独立成组，label/tone 来自展示态表', () => {
    expect(STATUS_GROUPS.map((g) => g.id)).toEqual(Object.keys(STATUS_LABELS));
    for (const group of STATUS_GROUPS) {
      expect(group.statuses).toEqual([group.id]);
      expect(group.label).toBe(STATUS_LABELS[group.id]);
    }
    expect(STATUS_GROUPS.find((g) => g.id === 'ready')?.tone).toBe('info');
    expect(STATUS_GROUPS.find((g) => g.id === 'wait_user')?.tone).toBe('warn');
  });
});
