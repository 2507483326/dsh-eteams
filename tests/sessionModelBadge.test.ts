/**
 * 子会话模型徽章标签拼装单测（用户迭代 2026-09-07/08「子代理会话中显示实际
 * 的 provider/model → 去掉前缀、显示目录模型」）：sessionModelLabel 是纯
 * 函数——subagent 门控、无观测 route 空串、目录名优先 / id 回退。渲染组件
 * 本身依赖槽位运行时，这里只锁标签语义（空串 = 不渲染是徽章的显隐契约）。
 */
import { describe, expect, it } from 'vitest';
import { sessionModelLabel } from '../src/client/pages/sessionModelBadge';
import type { SessionRouteView } from '../src/client/lib/api';

describe('sessionModelLabel（子会话模型徽章标签）', () => {
  it('目录显示名优先：模型 id 是限定串时显示目录 name', () => {
    const view: SessionRouteView = {
      subagent: true,
      kind: 'captain',
      route: { provider: 'tr-test', model: 'z-ai/glm-5.3-free' },
      modelLabel: 'glm1',
    };
    expect(sessionModelLabel(view)).toBe('glm1');
  });

  it('目录未命中回退 provider/model 原值', () => {
    expect(
      sessionModelLabel({
        subagent: true,
        kind: 'member',
        memberName: '张三',
        route: { provider: 'deepseek', model: 'deepseek-chat' },
        modelLabel: null,
      }),
    ).toBe('deepseek/deepseek-chat');
    expect(
      sessionModelLabel({
        subagent: true,
        route: { provider: 'deepseek', model: 'deepseek-chat' },
      }),
    ).toBe('deepseek/deepseek-chat');
  });

  it('无观测路线（未发过请求/宿主刚重启）返回空串——不渲染', () => {
    expect(sessionModelLabel({ subagent: true, kind: 'member', route: null })).toBe('');
    expect(sessionModelLabel({ subagent: true, kind: 'member' })).toBe('');
  });

  it('非 eteams 子代理会话（主会话）返回空串——徽章不渲染', () => {
    expect(
      sessionModelLabel({
        subagent: false,
        route: { provider: 'deepseek', model: 'deepseek-chat' },
      }),
    ).toBe('');
    // 旧宿主快照缺 subagent 字段同样按不渲染兜底。
    expect(sessionModelLabel({})).toBe('');
  });
});
