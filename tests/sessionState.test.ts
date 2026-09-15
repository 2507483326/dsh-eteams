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
  canOpenSession,
  createSession,
  installSessionState,
  openSession,
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

/**
 * 类实例 fake——对齐宿主真实形状：`ctx.sessions` 直回 SessionRuntime 实例
 * （普通类、非 cordis Service，服务值无 tracker、cordis 不做 receiver 绑定），
 * 其 `open`/`create` 与 Session 的 `prompt` 都是依赖 `this` 的类方法。先前的
 * 单测用 vi.fn/对象字面量（脱离 `this` 也能跑），因此漏掉了「脱离接收者调用」
 * 这一线上根因（2026-09-14 用真实 cordis 实测：`ctx.svc` 直回实例，
 * `const m = face.m; m()` 抛 TypeError）。这些用例在修复前必失败。
 */
class FakeSessionFace {
  calls: unknown[][] = [];
  result: unknown = { ok: true };
  async prompt(content: unknown, mode: string): Promise<unknown> {
    this.calls.push([content, mode]);
    return this.result;
  }
}

class FakeSessionsFace {
  current = '';
  lastCreate: { cwd?: string } | undefined;
  session = new FakeSessionFace();

  open(id: string): void {
    this.current = id;
  }

  async create(opts?: { cwd?: string }): Promise<string> {
    this.lastCreate = opts;
    return 's-new';
  }

  binding(id: string): { session: FakeSessionFace } | undefined {
    return id === 's1' ? { session: this.session } : undefined;
  }
}

describe('宿主会话方法必须以接收者调用（脱离 this 会静默失败）', () => {
  it('openSession 真把目标会话选为当前（带 this 调宿主 sessions.open）', () => {
    const sessions = new FakeSessionsFace();
    install(sessions);
    expect(openSession('s-2')).toBe(true);
    expect(sessions.current).toBe('s-2');
  });

  it('openSession 空 id / 缺服务 → false，且不抛', () => {
    install(new FakeSessionsFace());
    expect(openSession('')).toBe(false);
    installSessionState(null);
    expect(openSession('s-1')).toBe(false);
  });

  it('createSession 带 this 调用，透传 cwd 并取回会话 id', async () => {
    const sessions = new FakeSessionsFace();
    install(sessions);
    expect(await createSession({ cwd: 'C:/w' })).toBe('s-new');
    expect(sessions.lastCreate).toEqual({ cwd: 'C:/w' });
  });

  it('promptSession 带 this 把描述投递给目标会话', async () => {
    const sessions = new FakeSessionsFace();
    install(sessions);
    expect(await promptSession('s1', '把 docs 迁移')).toBe(true);
    expect(sessions.session.calls).toEqual([
      [[{ type: 'text', text: '把 docs 迁移' }], 'queue'],
    ]);
  });
});

/**
 * 服务不活跃降级回归（用户 2026-09-15「团队面板渲染失败：cannot get required
 * service "sessions" in inactive context」）：真实 cordis 下服务提供方一旦不
 * 活跃，`ctx.sessions` 的属性读取会**抛错**（不是回 undefined），而 `teamsView`
 * 顶部渲染就调 rootSessionIdOf —— 裸读取把抛错带进首帧、被 ClientErrorBoundary
 * 捕获成整面板降级。此处用「属性读抛错」的假 ctx 钉住降级契约。
 */
describe('sessions 服务不活跃（cordis inactive context）→ 一律降级不抛', () => {
  it('属性读取抛 inactive context 时不外抛，各探测面按缺服务兜底', async () => {
    installSessionState({
      get sessions(): unknown {
        throw new Error('cannot get required service "sessions" in inactive context');
      },
    });
    expect(rootSessionIdOf('main')).toBe('main');
    expect(canOpenSession('s')).toBe(false);
    expect(openSession('s')).toBe(false);
    expect(sessionCwdOf('s')).toBeNull();
    expect(await createSession()).toBeNull();
    expect(await promptSession('s', 'x')).toBe(false);
  });

  it('cordis 反射读（ctx.get）在场且服务不活跃：反射读回 undefined，同样降级', () => {
    installSessionState({
      get: () => undefined,
      get sessions(): unknown {
        throw new Error('cannot get required service "sessions" in inactive context');
      },
    });
    expect(rootSessionIdOf('child')).toBe('child');
    expect(canOpenSession('s')).toBe(false);
  });
});
