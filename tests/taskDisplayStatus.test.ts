/**
 * 展示态派生层单测（docs/29 B 节）：13 态→展示态映射全表（含 cancelled 特例
 * 与同桶异色口径 29-M3）、retryCount 并入 detail、未知态中性回退、group 汇总
 * 优先级（error > doing > waiting > created）与全部 done → null。
 */
import { describe, expect, it } from 'vitest';
import {
  STATUS_LABELS,
  displayStatusOf,
  groupDisplayOf,
  memberTone,
} from '../src/client/taskDisplayStatus';

describe('displayStatusOf（13 态→展示态全表，B.2）', () => {
  it('六档映射逐格对表（key/label/tone）', () => {
    expect(displayStatusOf('draft')).toEqual({
      key: 'init',
      label: '初始化',
      tone: 'muted',
      detail: '',
    });
    expect(displayStatusOf('ready')).toEqual({
      key: 'created',
      label: '已创建',
      tone: 'info',
      detail: '',
    });
    // waiting 桶四态同 label 同 warn 点（B.2 等待系黄）。
    for (const status of ['assigned', 'blocked', 'paused', 'suspended']) {
      const view = displayStatusOf(status);
      expect(view.key).toBe('waiting');
      expect(view.label).toBe('等待执行');
      expect(view.tone).toBe('warn');
    }
    for (const status of ['in_progress', 'retrying']) {
      const view = displayStatusOf(status);
      expect(view.key).toBe('doing');
      expect(view.label).toBe('进行中');
      expect(view.tone).toBe('info');
    }
    expect(displayStatusOf('completed')).toEqual({
      key: 'done',
      label: '已完成',
      tone: 'ok',
      detail: '',
    });
  });

  it('error 桶同桶异色（29-M3）：awaiting/needs_user 黄、failed 红、cancelled 中性灰', () => {
    // awaiting_decision / needs_user：行内 pill 点色 warning 黄（非红）。
    expect(displayStatusOf('awaiting_decision')).toEqual({
      key: 'error',
      label: '错误',
      tone: 'warn',
      detail: '待决策',
    });
    expect(displayStatusOf('needs_user')).toEqual({
      key: 'error',
      label: '错误',
      tone: 'warn',
      detail: '待用户',
    });
    expect(displayStatusOf('failed')).toEqual({
      key: 'error',
      label: '错误',
      tone: 'err',
      detail: '失败',
    });
    // cancelled：归 error 桶但文案「已取消」、中性灰（不标红）。
    expect(displayStatusOf('cancelled')).toEqual({
      key: 'error',
      label: '已取消',
      tone: 'muted',
      detail: '',
    });
  });

  it('detail 保留 13 态差异（吞并态小字：被阻断/已挂起/已暂停）', () => {
    expect(displayStatusOf('blocked').detail).toBe('被阻断');
    expect(displayStatusOf('paused').detail).toBe('已挂起');
    expect(displayStatusOf('suspended').detail).toBe('已暂停');
    expect(displayStatusOf('assigned').detail).toBe('');
    expect(displayStatusOf('in_progress').detail).toBe('');
  });

  it('retryCount 并入 detail（B.3：重试 n；retrying 无计数回退词表）', () => {
    expect(displayStatusOf('retrying', 2)).toEqual({
      key: 'doing',
      label: '进行中',
      tone: 'info',
      detail: '重试 2',
    });
    expect(displayStatusOf('retrying', 0).detail).toBe('重试中');
    // 非 retrying 态带重试计数同样并入（顶层行既有口径：重试 n）。
    expect(displayStatusOf('in_progress', 3).detail).toBe('重试 3');
    expect(displayStatusOf('in_progress', 0).detail).toBe('');
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

describe('STATUS_LABELS（13 态精确词表，B.3 共存策略）', () => {
  it('13 态齐全且值与既有词表一致（成员状态 pill 复用不破）', () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual(
      [
        'assigned',
        'awaiting_decision',
        'blocked',
        'cancelled',
        'completed',
        'draft',
        'failed',
        'in_progress',
        'needs_user',
        'paused',
        'ready',
        'retrying',
        'suspended',
      ].sort(),
    );
    expect(STATUS_LABELS.ready).toBe('待指派');
    expect(STATUS_LABELS.suspended).toBe('已暂停');
    expect(STATUS_LABELS.cancelled).toBe('已取消');
  });
});

describe('memberTone（成员状态五档）', () => {
  it('working/busy→info、ready/idle/done→ok、paused→warn、failed/error→err、其余 muted', () => {
    expect(memberTone('working')).toBe('info');
    expect(memberTone('busy')).toBe('info');
    expect(memberTone('ready')).toBe('ok');
    expect(memberTone('idle')).toBe('ok');
    expect(memberTone('done')).toBe('ok');
    expect(memberTone('paused')).toBe('warn');
    expect(memberTone('failed')).toBe('err');
    expect(memberTone('error')).toBe('err');
    expect(memberTone('staged')).toBe('muted');
    expect(memberTone('unknown')).toBe('muted');
  });
});

describe('groupDisplayOf（组卡汇总优先级，B.2）', () => {
  it('空小任务集 → null（不渲染 chip）', () => {
    expect(groupDisplayOf([])).toBeNull();
  });

  it('error 优先：✕ n 项异常（err 红 + 首个异常 detail）', () => {
    const summary = groupDisplayOf([
      { status: 'in_progress' },
      { status: 'awaiting_decision', retryCount: 3 },
      { status: 'failed' },
    ]);
    // 首个异常小任务 = awaiting_decision（待决策）——detail 取它的 13 态差异。
    expect(summary).toEqual({ label: '2 项异常', tone: 'err', icon: '✕', detail: '待决策' });
  });

  it('cancelled 同入异常计数（error 桶聚合语义），detail 为「已取消」空 detail', () => {
    const summary = groupDisplayOf([{ status: 'ready' }, { status: 'cancelled' }]);
    expect(summary).toEqual({ label: '1 项异常', tone: 'err', icon: '✕', detail: '' });
  });

  it('无异常含 doing → n 执行中（info）', () => {
    const summary = groupDisplayOf([{ status: 'ready' }, { status: 'in_progress' }]);
    expect(summary).toEqual({ label: '1 执行中', tone: 'info', icon: '', detail: '' });
  });

  it('无异常无 doing 含 waiting → n 等待执行（warn）', () => {
    const summary = groupDisplayOf([
      { status: 'ready' },
      { status: 'draft' },
      { status: 'assigned' },
    ]);
    expect(summary).toEqual({ label: '1 等待执行', tone: 'warn', icon: '', detail: '' });
  });

  it('全部 done → null（进度行已表达，不加 chip）', () => {
    expect(groupDisplayOf([{ status: 'completed' }, { status: 'completed' }])).toBeNull();
  });

  it('其余（created/init 混合）→ 待指派（中性）', () => {
    const summary = groupDisplayOf([{ status: 'ready' }, { status: 'draft' }]);
    expect(summary).toEqual({ label: '待指派', tone: 'muted', icon: '', detail: '' });
  });
});
