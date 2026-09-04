/**
 * 拖拽指派纯逻辑单测（docs/29 A.3.1 规则表锁）：drop = chain 全量替换的纯
 * 计算——空链建站、同站替换保 brief、多站只改下一待执行站、同名 no-op 去重、
 * 只读窗口拒改；清空站点与只读框展示成员。组件交互（HTML5 拖拽）不在 vitest
 * 环境（无 DOM 拖拽事件合成）覆盖，见完成报告说明。
 */
import { describe, expect, it } from 'vitest';
import type { ChainTaskLike } from '../src/client/features/tasks/taskAssignCore';
import {
  boxRendersContent,
  canClearStation,
  clearedChain,
  dropTargetMember,
  isAssignEditable,
  nextChainAfterDrop,
  readonlyStationMember,
} from '../src/client/features/tasks/taskAssignCore';

/** 便捷构造：chain 站点（member, stageBrief）。 */
const st = (member: string, stageBrief = ''): { member: string; stageBrief: string } => ({
  member,
  stageBrief,
});

describe('isAssignEditable（DA6 客户端守卫：draft/ready && chainCursor===-1）', () => {
  const base: ChainTaskLike = { status: 'draft', chain: [], chainCursor: -1 };
  it('draft/ready 未领取可编辑', () => {
    expect(isAssignEditable(base)).toBe(true);
    expect(isAssignEditable({ ...base, status: 'ready' })).toBe(true);
  });
  it('链已开跑（chainCursor≥0）不可编辑——即使 ready', () => {
    expect(isAssignEditable({ ...base, status: 'ready', chainCursor: 0 })).toBe(false);
    expect(isAssignEditable({ ...base, status: 'ready', chainCursor: 2 })).toBe(false);
  });
  it('非 draft/ready（合同冻结）不可编辑', () => {
    for (const status of ['assigned', 'in_progress', 'retrying', 'completed', 'failed']) {
      expect(isAssignEditable({ ...base, status })).toBe(false);
    }
  });
});

describe('nextChainAfterDrop（A.3.1 规则表）', () => {
  it('空链：追加单站，stageBrief 空串（update 通道合法，29.5 冲突①）', () => {
    const task: ChainTaskLike = { status: 'draft', chain: [], chainCursor: -1 };
    expect(nextChainAfterDrop(task, '张三')).toEqual([st('张三', '')]);
  });

  it('单站链：替换 chain[0] 成员、stageBrief 原值保留（DA4）', () => {
    const task: ChainTaskLike = {
      status: 'ready',
      chain: [st('张三', '产出登录页')],
      chainCursor: -1,
    };
    expect(nextChainAfterDrop(task, '李四')).toEqual([st('李四', '产出登录页')]);
  });

  it('多站链：只替换站点 0（下一待执行站），其余站点原样重发（DA5）', () => {
    const task: ChainTaskLike = {
      status: 'ready',
      chain: [st('张三', '设计'), st('李四', '实现'), st('王五', '验收')],
      chainCursor: -1,
    };
    expect(nextChainAfterDrop(task, '赵六')).toEqual([
      st('赵六', '设计'),
      st('李四', '实现'),
      st('王五', '验收'),
    ]);
  });

  it('同名去重（DA8）：目标站点已是该成员 → null（不发请求）', () => {
    const task: ChainTaskLike = {
      status: 'ready',
      chain: [st('张三', '设计'), st('李四', '实现')],
      chainCursor: -1,
    };
    expect(nextChainAfterDrop(task, '张三')).toBeNull();
  });

  it('链内其他站点同名 → 允许（host 不禁，只 dedup 目标站点）', () => {
    const task: ChainTaskLike = {
      status: 'ready',
      chain: [st('张三', '设计'), st('李四', '实现')],
      chainCursor: -1,
    };
    expect(nextChainAfterDrop(task, '李四')).toEqual([st('李四', '设计'), st('李四', '实现')]);
  });

  it('不可编辑窗口 → null（只读，双保险不重发）', () => {
    expect(
      nextChainAfterDrop({ status: 'ready', chain: [st('张三')], chainCursor: 0 }, '李四'),
    ).toBeNull();
    expect(
      nextChainAfterDrop({ status: 'in_progress', chain: [st('张三')], chainCursor: -1 }, '李四'),
    ).toBeNull();
  });
});

describe('canClearStation / clearedChain（框内 ×：仅单站链，清空=空链重发）', () => {
  it('单站可编辑可清空；多站/只读不可', () => {
    expect(canClearStation({ status: 'draft', chain: [st('张三')], chainCursor: -1 })).toBe(true);
    expect(
      canClearStation({
        status: 'ready',
        chain: [st('张三'), st('李四')],
        chainCursor: -1,
      }),
    ).toBe(false);
    expect(canClearStation({ status: 'ready', chain: [st('张三')], chainCursor: 0 })).toBe(false);
  });
  it('清空 = 整链重发为空链（回到领队自由指派）', () => {
    const task: ChainTaskLike = { status: 'draft', chain: [st('张三', '设计')], chainCursor: -1 };
    expect(clearedChain(task)).toEqual([]);
  });
});

describe('readonlyStationMember / boxRendersContent（只读框展示，A.5.1）', () => {
  it('优先当前执行人 assignee', () => {
    const task: ChainTaskLike = {
      status: 'in_progress',
      chain: [st('张三'), st('李四')],
      chainCursor: 1,
      assignee: '李四',
    };
    expect(readonlyStationMember(task)).toBe('李四');
  });
  it('无 assignee 取下一待执行站成员；越界回退末站', () => {
    expect(
      readonlyStationMember({
        status: 'ready',
        chain: [st('张三'), st('李四')],
        chainCursor: 0,
      }),
    ).toBe('李四');
    expect(
      readonlyStationMember({ status: 'completed', chain: [st('张三')], chainCursor: 0 }),
    ).toBe('张三');
  });
  it('空链且未指派 → null（框不渲染）；boxRendersContent 随之 false', () => {
    const task: ChainTaskLike = { status: 'assigned', chain: [], chainCursor: -1 };
    expect(readonlyStationMember(task)).toBeNull();
    expect(boxRendersContent(task)).toBe(false);
  });
  it('可编辑窗口恒渲染（空框虚线占位）；只读有站员/执行人也渲染', () => {
    expect(boxRendersContent({ status: 'draft', chain: [], chainCursor: -1 })).toBe(true);
    expect(boxRendersContent({ status: 'completed', chain: [st('张三')], chainCursor: 0 })).toBe(
      true,
    );
  });
  it('dropTargetMember：下一待执行站成员；空链 null', () => {
    expect(dropTargetMember({ status: 'ready', chain: [st('张三')], chainCursor: -1 })).toBe(
      '张三',
    );
    expect(dropTargetMember({ status: 'draft', chain: [], chainCursor: -1 })).toBeNull();
  });
});
