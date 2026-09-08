/**
 * 访谈弹窗路由 tests（统一问答路由，用户迭代 2026-09-08）：eteams_build_report
 * 发布边沿与 eteams_ask_user 同一套判定（runtime/askUser）——presence 命中
 * 构建子会话 → popSelf:true 就地弹；否则严格转交构建父（主会话）弹出并落
 * 统一问答单（ask_questions），投递失败降级 popSelf:true；同题复发（routed
 * 痕迹 / pending 问答单）不重复中转；非构建子代理调用者不判定。答案回收：
 * eteams_ask_answer 桥接构建会话（answers 落盘 + wakeBuilderChild followup，
 * 真父定位），eteams_interview_answer 同步问答单徽标。直接驱动工具 execute，
 * 走与 buildWait.test.ts 同款的离线 ctx 桩。
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
import { createAskUserTools } from '../src/host/tools/askUserTools';
import {
  markBuilderChild,
  readBuildSession,
  reportBuildProgress,
  setBuildParentSession,
  writeBuildPresence,
} from '../src/host/runtime/roleBuilder';
import { readPendingAsksBySessionSync, readAskSync } from '../src/host/state/asks';
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
 * subagents 带 followup（问答回收唤醒）与可选 startContinuable。
 */
function fakeCtx(
  liveAgents: { id: string; steer?: unknown }[],
  extras: {
    followup?: ReturnType<typeof vi.fn>;
    startContinuable?: ReturnType<typeof vi.fn>;
    resume?: ReturnType<typeof vi.fn>;
  } = {},
): Context {
  const registry = new Map(liveAgents.map((a) => [a.id, a]));
  return {
    logger: { info: () => undefined, warn: () => undefined },
    subagents: {
      followup: extras.followup ?? vi.fn(async () => 'm-fake'),
      ...(extras.startContinuable !== undefined
        ? { startContinuable: extras.startContinuable }
        : {}),
    },
    agents: {
      get: (id: string) => registry.get(id),
      ...(extras.resume !== undefined ? { resume: extras.resume } : {}),
    },
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

async function seedSession(): Promise<void> {
  await reportBuildProgress(stateRoot(), { request: 'r' });
  await markBuilderChild(stateRoot(), 'builder-child-1');
  await setBuildParentSession(stateRoot(), 'leader-1');
}

/** 种一张已转交的 pending 问答单（桥接/回收用例的起点；返回 askId）。 */
async function seedPendingRelay(ctx: Context): Promise<string> {
  await seedSession();
  const result = await callReport(publishInterview(), childAgent(), ctx);
  expect(result).toMatchObject({ popSelf: false });
  const row = readPendingAsksBySessionSync(stateRoot(), 'builder-child-1')[0]!;
  return row.askId;
}

describe('eteams_build_report 访谈发布边沿（统一问答路由）', () => {
  it('no presence + live leader → steer the parent + popSelf:false + 落统一问答单', async () => {
    await seedSession();
    const leader = fakeMember('leader-1');
    const result = await callReport(publishInterview(), childAgent(), fakeCtx([leader]));
    expect(result).toMatchObject({ ok: true, popSelf: false });
    expect(leader.steer).toHaveBeenCalledTimes(1);
    const message = leader.steer.mock.calls[0][0] as {
      content: { text: string }[];
      source?: { summary?: string };
    };
    expect(message.content[0].text).toContain('你主要用它做什么？');
    expect(message.content[0].text).toContain('askId');
    expect(message.source?.summary).toContain('问答转交');
    // 统一问答单已挂起（teamId=0 工作区桶；答案经 eteams_ask_answer 桥接回收）。
    const pending = readPendingAsksBySessionSync(stateRoot(), 'builder-child-1');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.relaySessionId).toBe('leader-1');
  });

  it('no presence + parent side-car missing → popSelf:true (degraded, 不误投)', async () => {
    await reportBuildProgress(stateRoot(), { request: 'r' });
    await markBuilderChild(stateRoot(), 'builder-child-1');
    const leader = fakeMember('leader-1');
    const result = await callReport(publishInterview(), childAgent(), fakeCtx([leader]));
    expect(result).toMatchObject({ ok: true, popSelf: true });
    expect(leader.steer).not.toHaveBeenCalled();
    expect(readPendingAsksBySessionSync(stateRoot(), 'builder-child-1')).toHaveLength(0);
  });

  it('no presence + leader offline → popSelf:true (degraded)', async () => {
    await seedSession();
    const result = await callReport(publishInterview());
    expect(result).toMatchObject({ ok: true, popSelf: true });
  });

  it('presence = the builder child itself → popSelf:true 就地弹, leader untouched', async () => {
    await seedSession();
    await writeBuildPresence(stateRoot(), 'builder-child-1');
    const leader = fakeMember('leader-1');
    const result = await callReport(publishInterview(), childAgent(), fakeCtx([leader]));
    expect(result).toMatchObject({ ok: true, popSelf: true });
    expect(leader.steer).not.toHaveBeenCalled();
    // self 路径不留 pending 问答单，但留 routed 痕迹（同题复发不再重路由）。
    expect(readPendingAsksBySessionSync(stateRoot(), 'builder-child-1')).toHaveLength(0);
    expect(readBuildSession(stateRoot())?.interview?.routed).toBe(true);
  });

  it('presence = the parent session itself → steer the parent exactly once + popSelf:false', async () => {
    await seedSession();
    await writeBuildPresence(stateRoot(), 'leader-1');
    const leader = fakeMember('leader-1');
    const result = await callReport(publishInterview(), childAgent(), fakeCtx([leader]));
    expect(result).toMatchObject({ ok: true, popSelf: false });
    expect(leader.steer).toHaveBeenCalledTimes(1);
  });

  it('parent steer throws → popSelf:true (degraded)', async () => {
    await seedSession();
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

  it('presence 指向成员对话 → 仍严格转交构建父（严格主会话路由，不向成员投递）', async () => {
    await seedSession();
    await writeBuildPresence(stateRoot(), 'member-child-1');
    const member = fakeMember('member-child-1');
    const leader = fakeMember('leader-1');
    const result = await callReport(publishInterview(), childAgent(), fakeCtx([member, leader]));
    expect(result).toMatchObject({ ok: true, popSelf: false });
    expect(member.steer).not.toHaveBeenCalled();
    expect(leader.steer).toHaveBeenCalledTimes(1);
  });

  it('presence 指向闲置成员对话（无活代理）→ 仍转交构建父，不冷恢复成员', async () => {
    await seedSession();
    await writeBuildPresence(stateRoot(), 'member-child-1');
    const leader = fakeMember('leader-1');
    const followup = vi.fn(async () => 'm-fake');
    const result = await callReport(
      publishInterview(),
      childAgent(),
      fakeCtx([leader], { followup }),
    );
    expect(result).toMatchObject({ ok: true, popSelf: false });
    expect(leader.steer).toHaveBeenCalledTimes(1);
    expect(followup).not.toHaveBeenCalled();
  });

  it('unregistered presence → relay to the parent instead (不向陌生会话投递)', async () => {
    await seedSession();
    await writeBuildPresence(stateRoot(), 'stranger-1');
    const stranger = fakeMember('stranger-1');
    const leader = fakeMember('leader-1');
    const result = await callReport(
      publishInterview(),
      childAgent(),
      fakeCtx([stranger, leader]),
    );
    expect(result).toMatchObject({ ok: true, popSelf: false });
    expect(stranger.steer).not.toHaveBeenCalled();
    expect(leader.steer).toHaveBeenCalledTimes(1);
  });

  it('same-questions re-publish（转交路径）→ pending 问答单去重，不重复中转', async () => {
    await seedSession();
    const leader = fakeMember('leader-1');
    // 第一发：转交成功（问答单 pending + routed 痕迹）。
    const first = await callReport(publishInterview(), childAgent(), fakeCtx([leader]));
    expect(first).toMatchObject({ popSelf: false });
    expect(leader.steer).toHaveBeenCalledTimes(1);
    // 第二发同题（重启代理复发）：即使 presence 指向别处也不重复中转。
    await writeBuildPresence(stateRoot(), 'stranger-1');
    const stranger = fakeMember('stranger-1');
    const second = await callReport(publishInterview(), childAgent(), fakeCtx([leader, stranger]));
    expect(second).toMatchObject({ popSelf: false });
    expect(leader.steer).toHaveBeenCalledTimes(1);
    expect(stranger.steer).not.toHaveBeenCalled();
  });

  it('same-questions re-publish（self 路径）→ routed 痕迹去重，不重题双弹', async () => {
    await seedSession();
    await writeBuildPresence(stateRoot(), 'builder-child-1');
    const leader = fakeMember('leader-1');
    // 第一发：presence=self → 就地弹（routed 痕迹）。
    const first = await callReport(publishInterview(), childAgent(), fakeCtx([leader]));
    expect(first).toMatchObject({ popSelf: true });
    // 第二发同题（重启复发）：去重优先——不重复就地弹，也不中转。
    const second = await callReport(publishInterview(), childAgent(), fakeCtx([leader]));
    expect(second).toMatchObject({ popSelf: false });
    expect(leader.steer).not.toHaveBeenCalled();
  });

  it('non-builder caller → no popSelf field, no presence judgment (P2-1 收窄)', async () => {
    await seedSession();
    const member = fakeMember('member-child-1');
    const result = await callReport(publishInterview(), fakeMember('someone-else'), fakeCtx([member]));
    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty('popSelf');
    expect(member.steer).not.toHaveBeenCalled();
  });
});

describe('eteams_ask_answer 构建桥接（统一问答单 → 构建会话）', () => {
  it('主会话提交 → 构建会话访谈落盘 + followup 唤醒构建子代理（真父=侧车领队）', async () => {
    const followup = vi.fn(async () => 'm-fake');
    const startContinuable = vi.fn(async () => {
      throw new Error('unexpected cold-recovery rebuild');
    });
    const leader = fakeMember('leader-1');
    const ctx = fakeCtx([leader], { followup, startContinuable });
    const askId = await seedPendingRelay(ctx);
    const tools = createAskUserTools(config, ctx);
    const answerTool = tools.find((t) => t.name === 'eteams_ask_answer');
    if (!answerTool) throw new Error('eteams_ask_answer 未注册');
    const result = (await answerTool.execute(
      { askId, answers: [{ id: 'q1', selected: '写数据管道（推荐）' }] } as never,
      { agent: leader, signal: undefined } as never,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, status: 'answered' });
    // 构建会话访谈状态同步（面板工作台可见答案）。
    expect(readBuildSession(stateRoot())?.interview?.answers).toEqual([
      { id: 'q1', choice: '写数据管道（推荐）' },
    ]);
    // 问答单回收（徽标清零）+ 构建子代理被唤醒（parent=侧车领队，目标=构建子会话）。
    expect(readAskSync(stateRoot(), askId)?.status).toBe('answered');
    expect(readPendingAsksBySessionSync(stateRoot(), 'builder-child-1')).toHaveLength(0);
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(followup.mock.calls[0][0]).toMatchObject({ id: 'leader-1' });
    expect(followup.mock.calls[0][1]).toBe('builder-child-1');
  });

  it('重复提交 → 拒绝（问答单一次性）', async () => {
    const leader = fakeMember('leader-1');
    const ctx = fakeCtx([leader]);
    const askId = await seedPendingRelay(ctx);
    const tools = createAskUserTools(config, ctx);
    const answerTool = tools.find((t) => t.name === 'eteams_ask_answer')!;
    await answerTool.execute(
      { askId, answers: [{ id: 'q1', selected: 'A' }] } as never,
      { agent: leader, signal: undefined } as never,
    );
    await expect(
      answerTool.execute(
        { askId, answers: [{ id: 'q1', selected: 'B' }] } as never,
        { agent: leader, signal: undefined } as never,
      ),
    ).rejects.toThrow(/已结束/);
  });
});

describe('eteams_interview_answer 真父定位（docs/19.18 答案回流）', () => {
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
    await reportBuildProgress(stateRoot(), {
      interview: { questions: QUESTIONS },
    });
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
    await reportBuildProgress(stateRoot(), {
      interview: { questions: QUESTIONS },
    });
    const followup = vi.fn(async () => 'm-fake');
    await expect(
      callAnswer(fakeMember('member-child-1'), fakeCtx([], { followup })),
    ).rejects.toThrow(/当前不在线.*答案未保存/);
    expect(readBuildSession(stateRoot())?.interview?.answers).toBeUndefined();
    expect(followup).not.toHaveBeenCalled();
  });

  it('经统一路由落单的访谈：旧入口作答也同步问答单（徽标清零）', async () => {
    const leader = fakeMember('leader-1');
    const followup = vi.fn(async () => 'm-fake');
    const startContinuable = vi.fn(async () => {
      throw new Error('unexpected cold-recovery rebuild');
    });
    const ctx = fakeCtx([leader], { followup, startContinuable });
    const askId = await seedPendingRelay(ctx);
    // 面板/对话旧入口（eteams_interview_answer）作答。
    await callAnswer(leader, ctx);
    expect(readBuildSession(stateRoot())?.interview?.answers).toEqual([
      { id: 'q1', choice: '写数据管道（推荐）' },
    ]);
    expect(readAskSync(stateRoot(), askId)?.status).toBe('answered');
    expect(readPendingAsksBySessionSync(stateRoot(), 'builder-child-1')).toHaveLength(0);
  });
});
