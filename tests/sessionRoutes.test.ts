/**
 * 子代理会话声明路线登记单测（用户迭代 2026-09-07「子代理会话中显示实际的
 * provider/model」）：spawn 站点（members.spawnMember / captainAgent 派发核）
 * 把声明的 agentOptions 记进登记表，webui /session-route 以声明值为显示口径
 * （观测路线的 model 是上游限定 id）。harness 0.1.2 起 continuable setup
 * hook 被宿主移除，登记点前移到 spawn——本套件覆盖登记表的空段语义。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  declaredRouteOf,
  recordSessionRoute,
  resetSessionRoutesForTests,
} from '../src/host/runtime/sessionRoutes';

describe('sessionRoutes（子代理声明路线登记）', () => {
  beforeEach(() => {
    resetSessionRoutesForTests();
  });

  it('登记后按 sessionId 查回 provider/model', () => {
    recordSessionRoute('child-1', { provider: 'tokenrouter', model: 'glm-5.3-free' });
    expect(declaredRouteOf('child-1')).toEqual({ provider: 'tokenrouter', model: 'glm-5.3-free' });
  });

  it('空 sessionId / 空 provider / 空 model 一律不登记（观测路线兜底）', () => {
    recordSessionRoute('', { provider: 'tokenrouter', model: 'glm-5.3-free' });
    recordSessionRoute('child-x', { provider: '', model: 'glm-5.3-free' });
    recordSessionRoute('child-y', { provider: 'tokenrouter', model: '' });
    expect(declaredRouteOf('')).toBeUndefined();
    expect(declaredRouteOf('child-x')).toBeUndefined();
    expect(declaredRouteOf('child-y')).toBeUndefined();
  });

  it('重复登记覆盖旧值（重派/唤醒再登记 = 最新声明）', () => {
    recordSessionRoute('child-1', { provider: 'tokenrouter', model: 'glm-5.3-free' });
    recordSessionRoute('child-1', { provider: 'openrouter', model: 'glm-5.3-free' });
    expect(declaredRouteOf('child-1')).toEqual({ provider: 'openrouter', model: 'glm-5.3-free' });
  });
});
