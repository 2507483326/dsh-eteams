/**
 * 惰性服务读取面单测（用户 2026-09-15 报「团队面板渲染失败：cannot get
 * required service "sessions" in inactive context」根因）：cordis 的注入服务
 * 属性访问是**门禁式**的——服务当前不活跃（提供方 fiber 销毁/重挂窗口、插件
 * 自身 fiber 随之挂起）时 `ctx.<service>` 会抛错而不是回 undefined，渲染路径
 * 上的裸读取会把整个面板打进 ClientErrorBoundary。readClientService 把读取
 * 收口成「反射读 ctx.get 优先 + 属性读兜底」，两条路都降级回 undefined、
 * 绝不抛错。
 *
 * @module dsh-eteams/tests/serviceFace
 */
import { describe, expect, it } from 'vitest';
import { readClientService } from '../src/client/lib/serviceFace';

describe('readClientService（可选 cordis 服务读取，绝不抛）', () => {
  it('null / undefined / 无该服务 → undefined', () => {
    expect(readClientService(null, 'sessions')).toBeUndefined();
    expect(readClientService(undefined, 'sessions')).toBeUndefined();
    expect(readClientService({}, 'sessions')).toBeUndefined();
  });

  it('普通对象 ctx（测试假件）：属性直读', () => {
    const face = { mark: 'runtime' };
    expect(readClientService({ sessions: face }, 'sessions')).toBe(face);
  });

  it('cordis ctx：优先走反射读 ctx.get（带接收者调用，不碰会抛的属性读）', () => {
    const face = { mark: 'runtime' };
    const ctx = {
      called: [] as string[],
      get(this: { called: string[] }, key: string): unknown {
        this.called.push(key);
        return key === 'sessions' ? face : undefined;
      },
      get sessions(): unknown {
        throw new Error('cannot get required service "sessions" in inactive context');
      },
    };
    expect(readClientService(ctx, 'sessions')).toBe(face);
    expect(ctx.called).toEqual(['sessions']);
  });

  it('服务不活跃（属性读抛 inactive context）→ undefined，不抛', () => {
    const ctx = {
      get sessions(): unknown {
        throw new Error('cannot get required service "sessions" in inactive context');
      },
    };
    expect(readClientService(ctx, 'sessions')).toBeUndefined();
  });

  it('ctx.get 抛错 → 属性读兜底', () => {
    const face = { mark: 'runtime' };
    const ctx = {
      get(): unknown {
        throw new Error('boom');
      },
      sessions: face,
    };
    expect(readClientService(ctx, 'sessions')).toBe(face);
  });

  it('反射读回 undefined 时仍兜底属性读', () => {
    const face = { mark: 'runtime' };
    const ctx = { get: (): unknown => undefined, sessions: face };
    expect(readClientService(ctx, 'sessions')).toBe(face);
  });
});
