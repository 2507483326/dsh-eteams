/**
 * 「添加任务 → 新建对话」编排单测（用户迭代 2026-09-11）：openTaskConversation
 * 的链路顺序有语义（建会话 → 绑团队 → 投递首条消息 → 切过去；绑团队必须早于
 * 投递，否则首轮系统提示词组装时团队 band 还不在，等于团队没带过去），失败
 * 分层也要锁住（setup 失败 = ok:false 留在弹窗；已开对话的降级 = ok:true +
 * warning，不把用户困在旧对话）。
 *
 * 假件：HTTP 面（setSessionTeam）用 vi.mock 顶掉；会话面（create/binding/open/
 * list）经 installSessionState 注入结构桩——与生产同一探测路径。
 *
 * @module dsh-eteams/tests/taskConversation
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/client/lib/api', () => ({ setSessionTeam: vi.fn() }));

import { setSessionTeam } from '../src/client/lib/api';
import { installSessionState } from '../src/client/lib/sessionState';
import { openTaskConversation } from '../src/client/lib/taskConversation';

afterEach(() => {
  installSessionState(null);
  vi.mocked(setSessionTeam).mockReset();
});

/** 一次链路的调用次序记录（顺序断言用）。 */
interface Probe {
  readonly order: string[];
  readonly create: ReturnType<typeof vi.fn>;
  readonly prompt: ReturnType<typeof vi.fn>;
  readonly open: ReturnType<typeof vi.fn>;
}

/** 装一个可用的假会话面：s-old 有工作区，create 出 s-new。 */
function installHappyPath(overrides: { promptResult?: unknown; openThrows?: boolean } = {}): Probe {
  const order: string[] = [];
  const create = vi.fn(async () => {
    order.push('create');
    return 's-new';
  });
  const prompt = vi.fn(async () => {
    order.push('prompt');
    return 'promptResult' in overrides ? overrides.promptResult : { ok: true };
  });
  const open = vi.fn(() => {
    order.push('open');
    if (overrides.openThrows === true) throw new Error('nope');
  });
  installSessionState({
    sessions: {
      list: { getSnapshot: () => ({ byId: { 's-old': { cwd: 'C:/work' } } }) },
      create,
      binding: (id: string) => (id === 's-new' ? { session: { prompt } } : undefined),
      open,
    },
  });
  vi.mocked(setSessionTeam).mockImplementation(async () => {
    order.push('bind');
  });
  return { order, create, prompt, open };
}

describe('openTaskConversation（正常链）', () => {
  it('沿用来源会话 cwd 建会话 → 绑团队 → 投递描述 → 切过去', async () => {
    const probe = installHappyPath();
    const outcome = await openTaskConversation({
      description: '把 docs 下的旧文档迁移到新目录结构',
      teamId: 'team-1',
      fromSessionId: 's-old',
    });
    expect(outcome).toEqual({ ok: true, sessionId: 's-new' });
    expect(probe.create).toHaveBeenCalledWith({ cwd: 'C:/work' });
    expect(setSessionTeam).toHaveBeenCalledWith('s-new', 'team-1');
    expect(probe.prompt).toHaveBeenCalledWith(
      [{ type: 'text', text: '把 docs 下的旧文档迁移到新目录结构' }],
      'queue',
    );
    expect(probe.open).toHaveBeenCalledWith('s-new');
    // 顺序有语义：绑团队必须早于投递（否则首轮 band 未生效）。
    expect(probe.order).toEqual(['create', 'bind', 'prompt', 'open']);
  });

  it('无来源会话（整页团队页表面）：不传 cwd，落宿主默认工作区', async () => {
    const probe = installHappyPath();
    const outcome = await openTaskConversation({ description: '整理仓库', teamId: 'team-1' });
    expect(outcome).toEqual({ ok: true, sessionId: 's-new' });
    expect(probe.create).toHaveBeenCalledWith(undefined);
  });
});

describe('openTaskConversation（失败分层）', () => {
  it('建会话能力缺失 → ok:false，不绑团队 / 不投递 / 不切换', async () => {
    installSessionState({ sessions: { list: { getSnapshot: () => ({ byId: {} }) } } });
    const outcome = await openTaskConversation({ description: 'x', teamId: 'team-1' });
    expect(outcome.ok).toBe(false);
    expect(setSessionTeam).not.toHaveBeenCalled();
  });

  it('建会话抛错 → ok:false（同降级口径）', async () => {
    installSessionState({
      sessions: {
        create: async () => {
          throw new Error('boom');
        },
      },
    });
    const outcome = await openTaskConversation({ description: 'x', teamId: 'team-1' });
    expect(outcome.ok).toBe(false);
    expect(String((outcome as { error: string }).error)).toContain('无法新建对话');
  });

  it('绑团队失败 → ok:false 且不投递不切换（避免团队没带过去还静默成功）', async () => {
    const probe = installHappyPath();
    vi.mocked(setSessionTeam).mockRejectedValue(new Error('409 已绑定其他团队'));
    const outcome = await openTaskConversation({ description: 'x', teamId: 'team-1' });
    expect(outcome.ok).toBe(false);
    expect(String((outcome as { error: string }).error)).toContain('409 已绑定其他团队');
    expect(probe.prompt).not.toHaveBeenCalled();
    expect(probe.open).not.toHaveBeenCalled();
  });

  it('描述未投递 → 仍切换过去，ok:true + warning（消息可重发）', async () => {
    const probe = installHappyPath({ promptResult: { ok: false } });
    const outcome = await openTaskConversation({ description: 'x', teamId: 'team-1' });
    expect(outcome.ok).toBe(true);
    expect(probe.open).toHaveBeenCalledWith('s-new');
    expect((outcome as { warning?: string }).warning).toContain('未投递');
  });

  it('切换失败（open 抛错）→ ok:false，提示到会话列表里打开', async () => {
    installHappyPath({ openThrows: true });
    const outcome = await openTaskConversation({ description: 'x', teamId: 'team-1' });
    expect(outcome.ok).toBe(false);
    expect(String((outcome as { error: string }).error)).toContain('无法切换过去');
  });
});
