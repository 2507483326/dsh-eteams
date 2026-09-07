/**
 * 展示态派生层单测（docs/27 §27.9#11 十态收敛 + docs/panelTaskCommission
 * 第 11 态 creating）：11 态→展示态映射全表（含 cancelled 同桶异色特例）、
 * retryCount 并入 detail、未知态中性回退、isStartable/isTerminal 开始钮
 * 状态窗口（M3 收拢三处开始钮判据）与 isGroupStartable（创建中容器不渲染
 * 开始钮——与宿主 startGroupTask 同闸镜像）、group 汇总优先级
 * （error > doing > waiting > done 全完成 null）与全部 done → null；
 * 成员五态词表/tone 与 13 态旧值兜底。
 */
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_STATUS_LABELS,
  MEMBER_STATUS_LABELS,
  STATUS_GROUPS,
  STATUS_LABELS,
  displayStatusOf,
  groupDisplayOf,
  isGroupStartable,
  isStartable,
  isTerminal,
  memberTone,
} from '../src/client/features/tasks/taskDisplayStatus';

describe('displayStatusOf（11 态→展示态全表）', () => {
  it('六档映射逐格对表（key/label/tone；二十四轮 DA37 draft/ready 文案合并待开始；creating 创建中占位 init 桶）', () => {
    expect(displayStatusOf('creating')).toEqual({
      key: 'init',
      label: '创建中',
      tone: 'info',
      detail: '',
    });
    expect(displayStatusOf('draft')).toEqual({
      key: 'init',
      label: '待开始',
      tone: 'info',
      detail: '',
    });
    expect(displayStatusOf('ready')).toEqual({
      key: 'created',
      label: '待开始',
      tone: 'info',
      detail: '',
    });
    // waiting 桶两态：wait 待接取、paused 已挂起（detail 不再补吞并态小字）。
    expect(displayStatusOf('wait')).toEqual({
      key: 'waiting',
      label: '待接取',
      tone: 'warn',
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

  it('error 桶同桶异色：wait_decision/wait_user 黄、failed 红、cancelled 中性灰', () => {
    // wait_decision / wait_user：行内 pill 点色 warning 黄（非红）。
    expect(displayStatusOf('wait_decision')).toEqual({
      key: 'error',
      label: '待决策',
      tone: 'warn',
      detail: '',
    });
    expect(displayStatusOf('wait_user')).toEqual({
      key: 'error',
      label: '待用户',
      tone: 'warn',
      detail: '',
    });
    expect(displayStatusOf('failed')).toEqual({
      key: 'error',
      label: '失败',
      tone: 'err',
      detail: '',
    });
    // cancelled：归 error 桶但文案「已取消」、中性灰（不标红）。
    expect(displayStatusOf('cancelled')).toEqual({
      key: 'error',
      label: '已取消',
      tone: 'muted',
      detail: '',
    });
  });

  it('detail 保留重试计数（十态已精确，无吞并态补字）', () => {
    expect(displayStatusOf('start').detail).toBe('');
    expect(displayStatusOf('wait').detail).toBe('');
    expect(displayStatusOf('ready').detail).toBe('');
  });

  it('retryCount 并入 detail（重试 n）', () => {
    expect(displayStatusOf('start', 2)).toEqual({
      key: 'doing',
      label: '执行中',
      tone: 'info',
      detail: '重试 2',
    });
    expect(displayStatusOf('start', 0).detail).toBe('');
    // 非 doing 态带重试计数同样并入（顶层行既有口径：重试 n）。
    expect(displayStatusOf('ready', 3).detail).toBe('重试 3');
    expect(displayStatusOf('wait', 0).detail).toBe('');
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

describe('STATUS_LABELS（11 态精确词表）', () => {
  it('11 态齐全且值与词表一致（成员状态 pill 不再复用任务词表）', () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual(
      [
        'cancelled',
        'completed',
        'creating',
        'draft',
        'failed',
        'paused',
        'ready',
        'start',
        'wait',
        'wait_decision',
        'wait_user',
      ].sort(),
    );
    expect(STATUS_LABELS.creating).toBe('创建中');
    expect(STATUS_LABELS.draft).toBe('待开始');
    expect(STATUS_LABELS.ready).toBe('待开始');
    expect(STATUS_LABELS.wait).toBe('待接取');
    expect(STATUS_LABELS.cancelled).toBe('已取消');
  });
});

describe('ATTEMPT_STATUS_LABELS / MEMBER_STATUS_LABELS（词表搬家后口径）', () => {
  it('尝试六态词表齐全', () => {
    expect(Object.keys(ATTEMPT_STATUS_LABELS).sort()).toEqual(
      ['failed', 'paused', 'pending_accept', 'revoked', 'running', 'succeeded'].sort(),
    );
  });

  it('成员五态词表齐全（含 removed）', () => {
    expect(Object.keys(MEMBER_STATUS_LABELS).sort()).toEqual(
      ['paused', 'ready', 'removed', 'staged', 'working'].sort(),
    );
    expect(MEMBER_STATUS_LABELS.staged).toBe('未启动');
    expect(MEMBER_STATUS_LABELS.removed).toBe('已移出');
  });
});

describe('memberTone（成员状态五档 + 旧值兜底）', () => {
  it('working→info、ready→ok、paused→warn、staged/removed→muted', () => {
    expect(memberTone('working')).toBe('info');
    expect(memberTone('ready')).toBe('ok');
    expect(memberTone('paused')).toBe('warn');
    expect(memberTone('staged')).toBe('muted');
    expect(memberTone('removed')).toBe('muted');
  });

  it('旧快照值 busy/idle/done/failed/error 保留兜底', () => {
    expect(memberTone('busy')).toBe('info');
    expect(memberTone('idle')).toBe('ok');
    expect(memberTone('done')).toBe('ok');
    expect(memberTone('failed')).toBe('err');
    expect(memberTone('error')).toBe('err');
    expect(memberTone('unknown')).toBe('muted');
  });
});

describe('isStartable / isTerminal（M3 收拢三处开始钮判据的状态窗口）', () => {
  it('isStartable：任务/小任务「开始」钮 ready/draft 渲染（十态逐格；三十六轮 DA49 draft 并入待开始窗口）', () => {
    expect(isStartable('ready')).toBe(true);
    expect(isStartable('draft')).toBe(true);
    expect(isStartable('wait')).toBe(false);
    expect(isStartable('start')).toBe(false);
    expect(isStartable('paused')).toBe(false);
    expect(isStartable('wait_decision')).toBe(false);
    expect(isStartable('wait_user')).toBe(false);
    expect(isStartable('completed')).toBe(false);
    expect(isStartable('failed')).toBe(false);
    expect(isStartable('cancelled')).toBe(false);
  });

  it('isTerminal：主任务「开始」钮终态（completed/cancelled）收钮，其余渲染', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('draft')).toBe(false);
    expect(isTerminal('ready')).toBe(false);
    expect(isTerminal('wait')).toBe(false);
    expect(isTerminal('start')).toBe(false);
    expect(isTerminal('paused')).toBe(false);
    expect(isTerminal('wait_decision')).toBe(false);
    expect(isTerminal('wait_user')).toBe(false);
    expect(isTerminal('failed')).toBe(false);
    // 未知态（旧快照/词表外）非终态——开始钮照渲染（原 !== 串比较同口径）。
    expect(isTerminal('unknown_state')).toBe(false);
  });
});

describe('isGroupStartable（组开始钮判据扩位，docs/panelTaskCommission）', () => {
  it('非终态且非创建中才渲染——creating 容器计划未定不渲染（与宿主 startGroupTask 同闸镜像）', () => {
    expect(isGroupStartable('ready')).toBe(true);
    expect(isGroupStartable('draft')).toBe(true);
    expect(isGroupStartable('wait')).toBe(true);
    expect(isGroupStartable('start')).toBe(true);
    expect(isGroupStartable('paused')).toBe(true);
    expect(isGroupStartable('wait_decision')).toBe(true);
    expect(isGroupStartable('wait_user')).toBe(true);
    expect(isGroupStartable('failed')).toBe(true);
    // 创建中（面板手动建任务占位）与终态一律不渲染。
    expect(isGroupStartable('creating')).toBe(false);
    expect(isGroupStartable('completed')).toBe(false);
    expect(isGroupStartable('cancelled')).toBe(false);
    // 未知态非终态非创建中——照渲染（原 !isTerminal 同口径）。
    expect(isGroupStartable('unknown_state')).toBe(true);
  });
});

describe('groupDisplayOf（组卡汇总优先级）', () => {
  it('空小任务集 → null（不渲染 chip）', () => {
    expect(groupDisplayOf([])).toBeNull();
  });

  it('error 优先：✕ n 项异常（err 红 + 首个异常 detail）', () => {
    const summary = groupDisplayOf([
      { status: 'start' },
      { status: 'wait_decision', retryCount: 3 },
      { status: 'failed' },
    ]);
    // 首个异常小任务 = wait_decision（待决策）——detail 取它的词表文案。
    expect(summary).toEqual({ label: '2 项异常', tone: 'err', icon: '✕', detail: '待决策' });
  });

  it('cancelled 同入异常计数（error 桶聚合语义）', () => {
    const summary = groupDisplayOf([{ status: 'ready' }, { status: 'cancelled' }]);
    expect(summary).toEqual({ label: '1 项异常', tone: 'err', icon: '✕', detail: '已取消' });
  });

  it('无异常含 doing → n 执行中（info）', () => {
    const summary = groupDisplayOf([{ status: 'ready' }, { status: 'start' }]);
    expect(summary).toEqual({ label: '1 执行中', tone: 'info', icon: '', detail: '' });
  });

  it('无异常无 doing 含 waiting → n 待接取（warn）', () => {
    const summary = groupDisplayOf([{ status: 'ready' }, { status: 'draft' }, { status: 'wait' }]);
    expect(summary).toEqual({ label: '1 待接取', tone: 'warn', icon: '', detail: '' });
  });

  it('全部 done → null（进度行已表达，不加 chip）', () => {
    expect(groupDisplayOf([{ status: 'completed' }, { status: 'completed' }])).toBeNull();
  });

  it('其余（created/init 混合）→ 待开始（中性；二十四轮 DA37 文案合并）', () => {
    const summary = groupDisplayOf([{ status: 'ready' }, { status: 'draft' }]);
    expect(summary).toEqual({ label: '待开始', tone: 'muted', icon: '', detail: '' });
  });
});

describe('STATUS_GROUPS（十一态一列键序规范，十一轮 DA24 后列表平铺无渲染方）', () => {
  it('每态独立成组，label/tone 来自展示态表', () => {
    expect(STATUS_GROUPS.map((g) => g.id)).toEqual(Object.keys(STATUS_LABELS));
    for (const group of STATUS_GROUPS) {
      expect(group.statuses).toEqual([group.id]);
      expect(group.label).toBe(STATUS_LABELS[group.id]);
    }
    expect(STATUS_GROUPS.find((g) => g.id === 'ready')?.tone).toBe('info');
    expect(STATUS_GROUPS.find((g) => g.id === 'failed')?.tone).toBe('err');
  });
});
