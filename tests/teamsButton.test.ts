/**
 * 输入栏团队按钮 · 子代理身份面纯函数单测（用户迭代 2026-09-10「子代理隐藏
 * 团队按钮」）：subagentFaceMode / subagentFaceTitle 是纯函数——主会话恒
 * interactive、子代理无身份（含加载中/失效）恒 hidden、身份在册 identity；
 * tooltip 按 kind 拼「成员/领队/构建师 + 团队后缀」。渲染组件依赖槽位运行
 * 时与宿主往返，这里只锁显隐决策与文案语义。
 */
import { describe, expect, it } from 'vitest';
import { subagentFaceMode, subagentFaceTitle } from '../src/client/lib/subagentFace';
import type { SessionIdentity } from '../src/client/lib/api';

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
