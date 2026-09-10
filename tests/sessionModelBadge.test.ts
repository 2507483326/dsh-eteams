/**
 * 子会话模型徽章标签拼装单测（用户迭代 2026-09-07/08「子代理会话中显示实际
 * 的 provider/model → 显示目录模型」；2026-09-09 方案 A 改读客户端会话持久
 * 投影；2026-09-10 修正标准座位 kit 契约后标签/门控语义不变）：badgeRouteOf
 * / sessionBadgeLabel / kitGateOf 是纯函数——无真值路线空串、目录名优先 /
 * id 回退、subagent 面非空即门控。渲染组件本身依赖槽位运行时，这里只锁
 * 标签与门控语义（空串 = 不渲染是徽章的显隐契约）。
 */
import { describe, expect, it } from 'vitest';
import { badgeRouteOf, kitGateOf, sessionBadgeLabel } from '../src/client/pages/sessionModelBadge';
import type { ModelSelectionProjectionView } from '../src/client/lib/sessionState';

describe('badgeRouteOf（投影视图 → 显示路线）', () => {
  it('next 优先：pending 选择压过 lastUsed（模型座位同款口径）', () => {
    const view: ModelSelectionProjectionView = {
      lastUsed: { provider: 'deepseek', model: 'deepseek-chat' },
      next: { provider: 'cmd', model: 'z-ai/glm-5.3-flash' },
    };
    expect(badgeRouteOf(view)).toEqual({ provider: 'cmd', model: 'z-ai/glm-5.3-flash' });
  });

  it('无 next 回退 lastUsed——实际消耗路线', () => {
    expect(
      badgeRouteOf({ lastUsed: { provider: 'deepseek', model: 'deepseek-chat' }, next: null }),
    ).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
  });

  it('无投影 / 空 lastUsed / 段缺失 → null（不渲染）', () => {
    expect(badgeRouteOf(undefined)).toBeNull();
    expect(badgeRouteOf({})).toBeNull();
    expect(badgeRouteOf({ lastUsed: null, next: null })).toBeNull();
    expect(badgeRouteOf({ lastUsed: { provider: '', model: 'm' } })).toBeNull();
    expect(badgeRouteOf({ lastUsed: { provider: 'p', model: '' } })).toBeNull();
  });
});

describe('sessionBadgeLabel（子会话模型徽章标签）', () => {
  const groups = [
    {
      id: 'tr-test',
      name: 'TokenRouter 测试',
      models: [{ id: 'z-ai/glm-5.3-free', name: 'glm1' }],
    },
  ];

  it('目录显示名优先：模型 id 是限定串时显示目录 name', () => {
    expect(sessionBadgeLabel({ provider: 'tr-test', model: 'z-ai/glm-5.3-free' }, groups)).toBe(
      'glm1',
    );
  });

  it('目录未命中（组缺 / 模型缺 / 无目录）回退 provider/model 原值', () => {
    expect(sessionBadgeLabel({ provider: 'deepseek', model: 'deepseek-chat' }, groups)).toBe(
      'deepseek/deepseek-chat',
    );
    expect(sessionBadgeLabel({ provider: 'tr-test', model: 'other-model' }, groups)).toBe(
      'tr-test/other-model',
    );
    expect(sessionBadgeLabel({ provider: 'deepseek', model: 'deepseek-chat' }, undefined)).toBe(
      'deepseek/deepseek-chat',
    );
  });

  it('路线为 null（无真值）返回空串——不渲染', () => {
    expect(sessionBadgeLabel(null, groups)).toBe('');
  });
});

describe('kitGateOf（标准座位 kit 的门控判定）', () => {
  it('subagent 面非空对象 = 已寻址子代理会话（InputBar 同款判定）', () => {
    expect(kitGateOf({ address: { mode: 'subagent', label: 'eteams-rolebuilder' } })).toBe(true);
    expect(kitGateOf({})).toBe(true);
  });

  it('null / undefined = 普通会话或快照未就绪——不门控', () => {
    expect(kitGateOf(null)).toBe(false);
    expect(kitGateOf(undefined)).toBe(false);
  });
});
