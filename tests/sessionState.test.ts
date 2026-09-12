/**
 * 会话动词探测面单测（用户迭代 2026-09-11「添加任务改为新建对话」）：
 * createSession / promptSession / sessionCwdOf 都是结构探测——服务缺失、
 * 方法缺失、形态不符、宿主拒绝、抛错一律回 null/false，绝不外抛（本仓对
 * 宿主可选服务的降级契约：旧运行时只降级不崩）。
 *
 * rootSessionIdOf（2026-09-11「切到主会话的子会话不显示本会话」修复）：
 * 沿 subagentAddress / 会话列表行 parentId 上溯到根，同上降级纪律。
 *
 * @module dsh-eteams/tests/sessionState
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSession,
  installSessionState,
  promptSession,
  rootSessionIdOf,
  sessionCwdOf,
} from '../src/client/lib/sessionState';

/** 装一个只带 sessions 面的假 client ctx。 */
const install = (sessions: unknown): void => installSessionState({ sessions });

afterEach(() => {
  installSessionState(null);
});

describe('createSession（宿主建会话，New Session 流程同源）', () => {
  it('SessionRuntime 形态：直回 SessionId 串', async () => {
    install({ create: vi.fn(async () => 's-new') });
    expect(await createSession()).toBe('s-new');
  });

  it('Manager/RpcResult 形态：回 { sessionId }', async () => {
    install({ create: vi.fn(async () => ({ sessionId: 's-rpc' })) });
    expect(await createSession()).toBe('s-rpc');
  });

  it('带 cwd 透传 opts；空串/缺省不传（落宿主默认工作区）', async () => {
    const create = vi.fn(async () => 's1');
    install({ create });
    await createSession({ cwd: 'C:/work' });
    expect(create).toHaveBeenLastCalledWith({ cwd: 'C:/work' });
    await createSession({ cwd: '' });
    expect(create).toHaveBeenLastCalledWith(undefined);
    await createSession();
    expect(create).toHaveBeenLastCalledWith(undefined);
  });

  it('缺服务 / 缺方法 / 抛错 / 空 id / 非串 id → null（降级不抛）', async () => {
    installSessionState(null);
    expect(await createSession()).toBeNull();
    install({});
    expect(await createSession()).toBeNull();
    install({
      create: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    expect(await createSession()).toBeNull();
    install({ create: vi.fn(async () => '') });
    expect(await createSession()).toBeNull();
    install({ create: vi.fn(async () => ({ sessionId: 42 })) });
    expect(await createSession()).toBeNull();
  });
});

describe('promptSession（把任务描述投递进新对话）', () => {
  it('投递成功：prompt 收到描述原文 + queue 模式，回 true', async () => {
    const prompt = vi.fn(async () => ({ ok: true }));
    install({ binding: (id: string) => (id === 's1' ? { session: { prompt } } : undefined) });
    expect(await promptSession('s1', '把 docs 下的旧文档迁移到新目录结构')).toBe(true);
    expect(prompt).toHaveBeenCalledWith(
      [{ type: 'text', text: '把 docs 下的旧文档迁移到新目录结构' }],
      'queue',
    );
  });

  it('宿主拒绝（RpcResult ok:false）/ 无回执（undefined）→ false', async () => {
    install({ binding: () => ({ session: { prompt: async () => ({ ok: false }) } }) });
    expect(await promptSession('s1', 'x')).toBe(false);
    install({ binding: () => ({ session: { prompt: async () => undefined } }) });
    expect(await promptSession('s1', 'x')).toBe(false);
  });

  it('无 RpcResult 包装但回了业务值 → 视作受理', async () => {
    install({ binding: () => ({ session: { prompt: async () => ({ accepted: true }) } }) });
    expect(await promptSession('s1', 'x')).toBe(true);
  });

  it('空 id / 空白文本 / 缺服务 / 缺 binding / 缺 prompt / 抛错 → false', async () => {
    install({ binding: () => ({ session: { prompt: async () => ({ ok: true }) } }) });
    expect(await promptSession('', 'x')).toBe(false);
    expect(await promptSession('s1', '   ')).toBe(false);
    install({});
    expect(await promptSession('s1', 'x')).toBe(false);
    install({ binding: () => undefined });
    expect(await promptSession('s1', 'x')).toBe(false);
    install({ binding: () => ({ session: {} }) });
    expect(await promptSession('s1', 'x')).toBe(false);
    install({
      binding: () => ({
        session: {
          prompt: async () => {
            throw new Error('nope');
          },
        },
      }),
    });
    expect(await promptSession('s1', 'x')).toBe(false);
  });
});

describe('sessionCwdOf（新对话沿用来源会话工作区）', () => {
  it('会话列表行有 cwd → 返回；缺服务 / 无该行 / cwd 缺失或空 → null', () => {
    install({
      list: {
        getSnapshot: () => ({ byId: { s1: { cwd: 'C:/work' }, s2: { cwd: '' }, s3: {} } }),
      },
    });
    expect(sessionCwdOf('s1')).toBe('C:/work');
    expect(sessionCwdOf('s2')).toBeNull();
    expect(sessionCwdOf('s3')).toBeNull();
    expect(sessionCwdOf('ghost')).toBeNull();
    expect(sessionCwdOf('')).toBeNull();
    install({});
    expect(sessionCwdOf('s1')).toBeNull();
  });
});

describe('rootSessionIdOf（面板会话归属：子会话上溯到主对话）', () => {
  it('主会话（无父链）→ 自身；null/undefined/空串 → undefined；缺服务 → 原样返回', () => {
    install({});
    expect(rootSessionIdOf('main')).toBe('main');
    expect(rootSessionIdOf(null)).toBeUndefined();
    expect(rootSessionIdOf(undefined)).toBeUndefined();
    expect(rootSessionIdOf('')).toBeUndefined();
    installSessionState(null);
    expect(rootSessionIdOf('main')).toBe('main');
  });

  it('已寻址子代理会话：subagentAddress 父链（含多级）上溯到根', () => {
    const parents: Record<string, string> = {
      child: 'main',
      'grand-child': 'child',
    };
    install({
      subagentAddress: (id: string) =>
        parents[id] === undefined ? undefined : { parentSessionId: parents[id] },
    });
    expect(rootSessionIdOf('child')).toBe('main');
    expect(rootSessionIdOf('grand-child')).toBe('main');
  });

  it('无 subagentAddress 时退会话列表行 parentId 上溯；subagentAddress 优先', () => {
    install({
      subagentAddress: (id: string) =>
        id === 'child' ? { parentSessionId: 'from-address' } : undefined,
      list: {
        getSnapshot: () => ({
          byId: { child: { parentId: 'from-row' }, other: { parentId: 'main' } },
        }),
      },
    });
    expect(rootSessionIdOf('child')).toBe('from-address');
    expect(rootSessionIdOf('other')).toBe('main');
  });

  it('畸形父值（非串/空串）不上溯；成环截断不死循环', () => {
    install({
      subagentAddress: (id: string) =>
        ({ odd: { parentSessionId: 42 }, blank: { parentSessionId: '' } })[id],
      list: { getSnapshot: () => ({ byId: { a: { parentId: 'b' }, b: { parentId: 'a' } } }) },
    });
    expect(rootSessionIdOf('odd')).toBe('odd');
    expect(rootSessionIdOf('blank')).toBe('blank');
    // a↔b 成环：seen 截断，返回首个重复前的节点（b），不挂死。
    expect(rootSessionIdOf('a')).toBe('b');
  });
});
