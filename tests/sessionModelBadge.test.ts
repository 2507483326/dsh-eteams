/**
 * 子会话模型徽章标签拼装单测（用户迭代 2026-09-07「子代理会话中显示实际的
 * provider/model」）：sessionModelLabel 是纯函数——subagent 门控、无观测
 * route 空串、三类身份的前缀拼装。渲染组件本身依赖槽位运行时，这里只锁
 * 标签语义（空串 = 不渲染是徽章的显隐契约）。
 */
import { describe, expect, it } from 'vitest';
import { sessionModelLabel } from '../src/client/pages/sessionModelBadge';
import type { SessionRouteView } from '../src/client/lib/api';

describe('sessionModelLabel（子会话模型徽章标签）', () => {
  it('成员子代理：成员名 · provider/model', () => {
    const view: SessionRouteView = {
      subagent: true,
      kind: 'member',
      memberName: '张三',
      route: { provider: 'deepseek', model: 'deepseek-chat' },
    };
    expect(sessionModelLabel(view)).toBe('张三 · deepseek/deepseek-chat');
  });

  it('领队/构建师子代理：固定身份前缀（captain 无 memberName 可用）', () => {
    expect(
      sessionModelLabel({
        subagent: true,
        kind: 'captain',
        memberName: null,
        route: { provider: 'deepseek', model: 'deepseek-reasoner' },
      }),
    ).toBe('领队 · deepseek/deepseek-reasoner');
    expect(
      sessionModelLabel({
        subagent: true,
        kind: 'builder',
        route: { provider: 'openai', model: 'gpt-5' },
      }),
    ).toBe('构建师 · openai/gpt-5');
  });

  it('无观测路线（未发过请求/宿主刚重启）返回空串——不渲染', () => {
    expect(sessionModelLabel({ subagent: true, kind: 'member', route: null })).toBe('');
    expect(sessionModelLabel({ subagent: true, kind: 'member' })).toBe('');
  });

  it('非 eteams 子代理会话（主会话）返回空串——徽章不渲染', () => {
    expect(
      sessionModelLabel({ subagent: false, route: { provider: 'deepseek', model: 'deepseek-chat' } }),
    ).toBe('');
    // 旧宿主快照缺 subagent 字段同样按不渲染兜底。
    expect(sessionModelLabel({})).toBe('');
  });

  it('member 身份缺 memberName（legacy 行）时只显示路线', () => {
    expect(
      sessionModelLabel({
        subagent: true,
        kind: 'member',
        memberName: null,
        route: { provider: 'deepseek', model: 'deepseek-chat' },
      }),
    ).toBe('deepseek/deepseek-chat');
  });
});
