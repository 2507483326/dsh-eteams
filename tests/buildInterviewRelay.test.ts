/**
 * 19.18/19.21 访谈弹窗跟随用户所在会话 tests：eteams_build_report 发布边沿的
 * presence 分支（活成员 → steer；闲置成员 → 领队冷恢复 followup；presence=
 * 构建子会话自身 → popSelf:true 就地弹；其余 → steer 构建父弹到主对话，父
 * 离线/侧车缺失/steer 失败降级 popSelf:true）、同题复发去重、非构建子代理
 * 调用者不判定，以及 eteams_interview_answer 的真父定位（侧车 parent，成员
 * 调用不错挂）。直接驱动工具 execute，走与 buildWait.test.ts 同款的离线 ctx 桩。
 *
 * @module dsh-eteams/tests/buildInterviewRelay
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { ETeamsResolvedConfig } from '../src/host/config';
import { ETeamsConfig } from '../src/host/config';
import { createCaptainTools } from '../src/host/tools/captainTools';
import { registerMemberSession } from '../src/host/runtime/usage';
import {
  markBuilderChild,
  readBuildSession,
  reportBuildProgress,
  setBuildParentSession,
  writeBuildPresence,
} from '../src/host/runtime/roleBuilder';
import { cleanupTempWorkspace } from './support/tmpWorkspace';

let workspace: string;
let config: ETeamsResolvedConfig;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'eteams-interview-relay-'));
  config = ETeamsConfig({}) as ETeamsResolvedConfig;
});

afterEach(() => {
  cleanupTempWorkspace(workspace);
});

const stateRoot = (): string => join(workspace, '.eteams');

const QUESTIONS = [
  {
    id: 'q1',
    question: '你主要用它做什么？',
    options: [{ label: '写数据管道（推荐）' }, { label: '写前端' }],
  },
];

/** 构建子代理侧的假调用者（id 即守卫凭据；cwd 定位状态根）。 */
function childAgent(): { id: string; session: { header: { cwd: string } } } {
  return { id: 'builder-child-1', session: { header: { cwd: workspace } } };
}

/** 成员/领队侧假代理：steer 可观察；cwd 必须带——envForAgent 靠它定位状态根。 */
function fakeMember(id: string): {
  id: string;
  session: { header: { cwd: string } };
  steer: ReturnType<typeof vi.fn>;
} {
  return { id, session: { header: { cwd: workspace } }, steer: vi.fn() };
}

/**
 * 与 buildWait.test.ts 同款的离线桩：agents 按 Map 解析（可观察 get），
 * subagents 只带 followup（本套件不派发 startContinuable）。
 */
function fakeCtx(liveAgents: { id: string; steer?: unknown }[], subagents?: unknown): Context {
  const registry = new Map(liveAgents.map((a) => [a.id, a]));
  return {
    logger: { info: () => undefined, warn: () => undefined },
    ...(subagents !== undefined ? { subagents } : {}),
    agents: { get: (id: string) => registry.get(id) },
    tools: { register() {} },
    systemPrompt: { section() {} },
    get: (key: string) =>
      key === 'workspaceRegistry'
        ? { list: () => [{ path: workspace, title: 'ws' }] }
        : undefined,
  } as unknown as Context;
}

function callReport(
  args: Record<string, unknown>,
  agent: { id: string } = childAgent(),
  ctx?: Context,
): Promise<Record<string, unknown>> {
  const tools = createCaptainTools(config, ctx ?? fakeCtx([]));
  const tool = tools.find((t) => t.name === 'eteams_build_report');
  if (!tool) throw new Error('eteams_build_report 未注册');
  return tool.execute(args as never, { agent, signal: undefined } as never) as Promise<
    Record<string, unknown>
  >;
}

const publishInterview = (): Record<string, unknown> => ({
  step: '意图访谈',
  interview: { questions: QUESTIONS },
});

describe('eteams_build_report 访谈发布边沿投递（docs/19.18/19.21）', () => {
  it('no presence + live leader → steer the parent + popSelf:false (19.21 弹到主对话)', async () => {
    await reportBuildProgress(stateRoot(), { request: 'r' });
    await markBuilderChild(stateRoot(), 'builder-child-1');
    await setBuildParentSession(stateRoot(), 'leader-1');
    const leader = fakeMember('leader-1');
    const result = await callReport(publishInterview(), childAgent(), fakeCtx([leader]));
    expect(result).toMatchObject({ ok: true, popSelf: false });
    expect(leader.steer).toHaveBeenCalledTimes(1);
    const message = leader.steer.mock.calls[0][0] as {
      content: { text: string }[];
      source?: { summary?: string };
    };
    expect(message.content[0].text).toContain('你主要用它做什么？');
    expect(message.source?.summary).toContain('意图访谈——请在本对话作答');
  });

  it('no presence + parent side-car missing → popSelf:true (degraded, 不误投)', async () => {
    await reportBuildProgress(stateRoot(), { request: 'r' });
    await markBuilderChild(stateRoot(), 'builder-child-1');
    const leader = fakeMember('leader-1');
    const result = await callReport(publishInterview(), childAgent(), fakeCtx([leader]));
    expect(result).toMatchObject({ ok: true, popSelf: true });
    expect(leader.steer).not.toHaveBeenCalled();
  });

  it('no presence + leader offline → popSelf:true (degraded)', async () => {
    await reportBuildProgress(stateRoot(), { request: 'r' });
    await markBuilderChild(stateRoot(), 'builder-child-1');
    await setBuildParentSession(stateRoot(), 'leader-1');
    const result = await callReport(publishInterview());
    expect(result).toMatchObject({ ok: true, popSelf: true });
  });

  it('presence = the builder child itself → popSelf:true 就地弹, leader untouched', async () => {
    await reportBuildProgress(stateRoot(), { request: 'r' });
    await markBuilderChild(stateRoot(), 'builder-child-1');
    await setBuildParentSession(stateRoot(), 'leader-1');
    await writeBuildPresence(stateRoot(), 'builder-child-1');
    const leader = fakeMember('leader-1');
    const result = await callReport(publishInterview(), childAgent(), fakeCtx([leader]));
    expect(result).toMatchObject({ ok: true, popSelf: true });
    expect(leader.steer).not.toHaveBeenCalled();
  });

  it('presence = the parent session itself → steer the parent exactly once + popSelf:false', async () => {
    await reportBuildProgress(stateRoot(), { request: 'r' });
    await markBuilderChild(stateRoot(), 'builder-child-1');
    await setBuildParentSession(stateRoot(), 'leader-1');
    await writeBuildPresence(stateRoot(), 'leader-1');
    const leader = fakeMember('leader-1');
    const result = await callReport(publishInterview(), childAgent(), fakeCtx([leader]));
    expect(result).toMatchObject({ ok: true, popSelf: false });
    expect(leader.steer).toHaveBeenCalledTimes(1);
  });

  it('parent steer throws → popSelf:true (degraded)', async () => {
    await reportBuildProgress(stateRoot(), { request: 'r' });
    await markBuilderChild(stateRoot(), 'builder-child-1');
    await setBuildParentSession(stateRoot(), 'leader-1');
    await writeBuildPresence(stateRoot(), 'stranger-1');
    const leader = fakeMember('leader-1');
    leader.steer.mockImplementation(() => {
      throw new Error('steer rejected');
    });
    const result = await callReport(publishInterview(), childAgent(), fakeCtx([leader]));
    expect(result).toMatchObject({ ok: true, popSelf: true });
    // popSelf:true 唯一可能来自 catch（父路确实尝试过 steer）。
    expect(leader.steer).toHaveBeenCalledTimes(1);
  });

  it('live registered member session → steer + popSelf:false', async () => {
    await reportBuildProgress(stateRoot(), { request: 'r' });
    await markBuilderChild(stateRoot(), 'builder-child-1');
    await setBuildParentSession(stateRoot(), 'leader-1');
    await registerMemberSession('member-child-1', {
      teamId: 'team-a',
      memberName: 'Alice',
      parentSessionId: 'leader-1',
    });
    await writeBuildPresence(stateRoot(), 'member-child-1');
    const member = fakeMember('member-child-1');
    const result = await callReport(publishInterview(), childAgent(), fakeCtx([member]));
    expect(result).toMatchObject({ ok: true, popSelf: false });
    expect(member.steer).toHaveBeenCalledTimes(1);
    const message = member.steer.mock.calls[0][0] as { content: { text: string }[] };
    expect(message.content[0].text).toContain('你主要用它做什么？');
  });

  it('idle registered member session (no live agent) → cold-resume followup via the leader + popSelf:false', async () => {
    await reportBuildProgress(stateRoot(), { request: 'r' });
    await markBuilderChild(stateRoot(), 'builder-child-1');
    await setBuildParentSession(stateRoot(), 'leader-1');
    await registerMemberSession('member-child-1', {
      teamId: 'team-a',
      memberName: 'Alice',
      parentSessionId: 'leader-1',
    });
    await writeBuildPresence(stateRoot(), 'member-child-1');
    const leader = fakeMember('leader-1');
    const followup = vi.fn(async () => 'm-fake');
    const result = await callReport(
      publishInterview(),
      childAgent(),
      fakeCtx([leader], { followup }),
    );
    expect(result).toMatchObject({ ok: true, popSelf: false });
    expect(followup).toHaveBeenCalledTimes(1);
    // parent 必须是成员的真实直接父（领队主会话），不能是调用者。
    expect(followup.mock.calls[0][0]).toMatchObject({ id: 'leader-1' });
    expect(followup.mock.calls[0][1]).toBe('member-child-1');
  });

  it('idle member + leader offline → falls back to popSelf:true', async () => {
    await reportBuildProgress(stateRoot(), { request: 'r' });
    await markBuilderChild(stateRoot(), 'builder-child-1');
    await setBuildParentSession(stateRoot(), 'leader-1');
    await registerMemberSession('member-child-1', {
      teamId: 'team-a',
      memberName: 'Alice',
      parentSessionId: 'leader-1',
    });
    await writeBuildPresence(stateRoot(), 'member-child-1');
    const followup = vi.fn(async () => 'm-fake');
    const result = await callReport(
      publishInterview(),
      childAgent(),
      fakeCtx([], { followup }),
    );
    expect(result).toMatchObject({ ok: true, popSelf: true });
    expect(followup).not.toHaveBeenCalled();
  });

  it('unregistered presence → relay to the parent instead (P2-6 不向陌生会话投递)', async () => {
    await reportBuildProgress(stateRoot(), { request: 'r' });
    await markBuilderChild(stateRoot(), 'builder-child-1');
    await setBuildParentSession(stateRoot(), 'leader-1');
    await writeBuildPresence(stateRoot(), 'stranger-1');
    const stranger = fakeMember('stranger-1');
    const leader = fakeMember('leader-1');
    const followup = vi.fn(async () => 'm-fake');
    const result = await callReport(
      publishInterview(),
      childAgent(),
      fakeCtx([stranger, leader], { followup }),
    );
    expect(result).toMatchObject({ ok: true, popSelf: false });
    expect(stranger.steer).not.toHaveBeenCalled();
    expect(leader.steer).toHaveBeenCalledTimes(1);
    expect(followup).not.toHaveBeenCalled();
  });

  it('same-questions re-publish → no re-relay, popSelf:false (P2-2 去重)', async () => {
    await reportBuildProgress(stateRoot(), { request: 'r' });
    await markBuilderChild(stateRoot(), 'builder-child-1');
    await setBuildParentSession(stateRoot(), 'leader-1');
    await registerMemberSession('member-child-1', {
      teamId: 'team-a',
      memberName: 'Alice',
      parentSessionId: 'leader-1',
    });
    // 第一发：无 presence 且 ctx 无领队（父离线）→ popSelf:true 降级。
    const first = await callReport(publishInterview());
    expect(first).toMatchObject({ popSelf: true });
    // 第二发同题（重启复发）：即使 presence 此刻指向活成员也不重复中转。
    await writeBuildPresence(stateRoot(), 'member-child-1');
    const member = fakeMember('member-child-1');
    const second = await callReport(publishInterview(), childAgent(), fakeCtx([member]));
    expect(second).toMatchObject({ popSelf: false });
    expect(member.steer).not.toHaveBeenCalled();
  });

  it('same-questions + presence = the builder child itself → dedup wins (popSelf:false, no in-place pop)', async () => {
    await reportBuildProgress(stateRoot(), { request: 'r' });
    await markBuilderChild(stateRoot(), 'builder-child-1');
    await setBuildParentSession(stateRoot(), 'leader-1');
    // 第一发：presence=self → 就地弹。
    await writeBuildPresence(stateRoot(), 'builder-child-1');
    const leader = fakeMember('leader-1');
    const first = await callReport(publishInterview(), childAgent(), fakeCtx([leader]));
    expect(first).toMatchObject({ popSelf: true });
    // 第二发同题（重启复发）：去重优先于就地补弹——不重复 steer，也不就
    // 地补弹（入口=已中转弹窗或面板，避免双弹先提交者胜）。
    const second = await callReport(publishInterview(), childAgent(), fakeCtx([leader]));
    expect(second).toMatchObject({ popSelf: false });
    expect(leader.steer).not.toHaveBeenCalled();
  });

  it('non-builder caller → no popSelf field, no presence judgment (P2-1 收窄)', async () => {
    await reportBuildProgress(stateRoot(), { request: 'r' });
    await markBuilderChild(stateRoot(), 'builder-child-1');
    await registerMemberSession('member-child-1', {
      teamId: 'team-a',
      memberName: 'Alice',
      parentSessionId: 'leader-1',
    });
    await writeBuildPresence(stateRoot(), 'member-child-1');
    const member = fakeMember('member-child-1');
    const result = await callReport(publishInterview(), fakeMember('someone-else'), fakeCtx([member]));
    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty('popSelf');
    expect(member.steer).not.toHaveBeenCalled();
  });
});

describe('eteams_interview_answer 真父定位（docs/19.18 答案回流）', () => {
  async function seedSession(): Promise<void> {
    await reportBuildProgress(stateRoot(), {
      request: 'r',
      interview: { questions: QUESTIONS },
    });
    await markBuilderChild(stateRoot(), 'builder-child-1');
    await setBuildParentSession(stateRoot(), 'leader-1');
  }

  function callAnswer(
    agent: { id: string },
    ctx: Context,
  ): Promise<Record<string, unknown>> {
    const tools = createCaptainTools(config, ctx);
    const tool = tools.find((t) => t.name === 'eteams_interview_answer');
    if (!tool) throw new Error('eteams_interview_answer 未注册');
    return tool.execute(
      { answers: [{ id: 'q1', choice: '写数据管道（推荐）' }] } as never,
      { agent, signal: undefined } as never,
    ) as Promise<Record<string, unknown>>;
  }

  it('member caller → followup parent is the side-car leader, answers land', async () => {
    await seedSession();
    const leader = fakeMember('leader-1');
    const followup = vi.fn(async () => 'm-fake');
    // wakeBuilderChild 要求 startContinuable + followup 双能力在册（subagentsReady）；
    // 本用例 followup 必成功——重建路径一旦被触发（错挂前兆）立即响铃。
    const startContinuable = vi.fn(async () => {
      throw new Error('unexpected cold-recovery rebuild');
    });
    const result = await callAnswer(fakeMember('member-child-1'), fakeCtx([leader], { followup, startContinuable }));
    expect(result).toMatchObject({ ok: true, status: 'active' });
    expect(readBuildSession(stateRoot())?.interview?.answers).toEqual([
      { id: 'q1', choice: '写数据管道（推荐）' },
    ]);
    // 唤醒 parent = 侧车记录的构建父（领队主会话），不是调用成员。
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(followup.mock.calls[0][0]).toMatchObject({ id: 'leader-1' });
  });

  it('parent offline → honest error, answers NOT saved (绝不重建错挂)', async () => {
    await seedSession();
    const followup = vi.fn(async () => 'm-fake');
    await expect(
      callAnswer(fakeMember('member-child-1'), fakeCtx([], { followup })),
    ).rejects.toThrow(/当前不在线.*答案未保存/);
    expect(readBuildSession(stateRoot())?.interview?.answers).toBeUndefined();
    expect(followup).not.toHaveBeenCalled();
  });
});