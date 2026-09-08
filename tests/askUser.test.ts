/**
 * 子代理用户问答路由（eteams_ask_user / eteams_ask_answer）tests：路由判定
 * （presence 命中提问会话 → 就地弹；主会话自己提问 → 就地弹；否则严格转交
 * 主会话）、转交投递（在线 steer / 离线 agents.resume 冷恢复 followup）——
 * **转交即返回不停驻**，eteams_ask_answer 回收后由宿主 followup 唤醒提问子
 * 代理、降级路径（无锚点/弹窗服务缺失/弹窗被拒）、问答单一次性（重复提交
 * 拒绝）。直接驱动工具 execute，走与 buildInterviewRelay.test.ts 同款的
 * 离线 ctx 桩。
 *
 * @module dsh-eteams/tests/askUser
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ETeamsResolvedConfig } from '../src/host/config';
import { resolveConfig } from '../src/host/config';
import { createAskUserTools } from '../src/host/tools/askUserTools';
import { decideAskRoute } from '../src/host/runtime/askUser';
import { writeBuildPresence } from '../src/host/runtime/roleBuilder';
import {
  insertAskSync,
  normalizeAskAnswer,
  readAskSync,
  readPendingAsksSync,
} from '../src/host/state/asks';
import { insertTeamRow, withTeamTx, writeTeamInTx } from '../src/host/state/store';
import { joinPath } from '../src/host/runtime/base';
import { LEADER_NAME } from '../src/host/runtime/roster';
import type { TaskMemberRecord, TeamState } from '../src/host/model/types';
import { cleanupTempWorkspace } from './support/tmpWorkspace';

let ws: string;
let root: string;
let config: ETeamsResolvedConfig;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'eteams-ask-user-'));
  // 状态根与 runtime 同口径（base.ts joinPath 的「/」拼法）——getDb 连接缓存
  // 按它做键，afterEach 收尾才能关掉连接再删目录。
  root = joinPath(ws, '.eteams');
  config = resolveConfig({ stateDir: '.eteams' });
});

afterEach(() => {
  cleanupTempWorkspace(ws);
});

const QUESTIONS = [
  {
    id: 'q1',
    question: '验收偏好哪种形式？',
    options: [{ label: '跑测试脚本（推荐）' }, { label: '人工走查' }],
  },
];

// ---------- seeding（captainDispatch.test.ts 同款 SQLite 契约播种） ----------

function seedTeam(opts: { withMainSession?: boolean } = {}): TeamState {
  const name = '演示团队';
  let teamId = 0;
  withTeamTx(root, undefined, (tx) => {
    teamId = insertTeamRow(tx, name, true, tx.now);
  });
  const leaderRow: TaskMemberRecord = {
    id: 0,
    teamId,
    mainTaskId: 1,
    nowTaskId: null,
    name: LEADER_NAME,
    employeeId: null,
    sessionId: '',
    status: 'ready',
    isLeader: true,
    createdAt: 1,
  };
  const memberRow: TaskMemberRecord = {
    id: 0,
    teamId,
    mainTaskId: 1,
    nowTaskId: null,
    name: '甲',
    employeeId: 1,
    sessionId: 'member-1',
    status: 'working',
    createdAt: 1,
  };
  const state: TeamState = {
    id: teamId,
    name,
    hasLeader: true,
    createdAt: 1,
    updatedAt: 1,
    taskMembers: [leaderRow, memberRow],
    members: [
      {
        memberId: 1,
        roleId: null,
        name: '甲',
        employeeId: 1,
        role: '前端',
        persona: {
          frameworkVersion: 1,
          role: '前端',
          duty: '',
          style: '',
          skills: '',
          rules: [],
          executionPrompt: '',
        },
        modelRoute: { model: '' },
        avatar: { seed: 1, salt: 1 },
        createdAt: 1,
      },
    ],
    tasks: [
      {
        id: 1,
        subject: '演示任务',
        parentId: null,
        dependencies: [],
        chain: [],
        chainCursor: -1,
        status: 'ready',
        attempts: [],
        retryCount: 0,
        // 主会话快照（opts.withMainSession === false 时模拟异常缺快照的库）。
        ...(opts.withMainSession === false ? {} : { mainSessionId: 'cap-1' }),
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    pendingDecisions: [],
  };
  withTeamTx(root, teamId, (tx) => writeTeamInTx(tx, state));
  return state;
}

// ---------- offline ctx stub（buildInterviewRelay.test.ts 同款） ----------

function memberAgent(): Agent {
  return { id: 'member-1', session: { header: { cwd: ws } } } as unknown as Agent;
}

function mainAgent(): Agent {
  return { id: 'cap-1', session: { header: { cwd: ws } } } as unknown as Agent;
}

interface FakeAgent {
  id: string;
  session: { header: { cwd: string } };
  steer: ReturnType<typeof vi.fn>;
  followup: ReturnType<typeof vi.fn>;
}

function fakeLive(id: string): FakeAgent {
  return {
    id,
    session: { header: { cwd: ws } },
    steer: vi.fn(),
    followup: vi.fn(),
  };
}

function fakeCtx(
  liveAgents: FakeAgent[],
  extras: {
    resume?: ReturnType<typeof vi.fn>;
    userQuestions?: { ask: ReturnType<typeof vi.fn> };
    followup?: ReturnType<typeof vi.fn>;
    startContinuable?: ReturnType<typeof vi.fn>;
  } = {},
): Context {
  const registry = new Map(liveAgents.map((a) => [a.id, a]));
  return {
    logger: { info: () => undefined, warn: () => undefined },
    // 问答回收唤醒走 subagents.followup（wakeAskingChild / wakeBuilderChild）。
    subagents: {
      followup: extras.followup ?? vi.fn(async () => 'm-fake'),
      ...(extras.startContinuable !== undefined
        ? { startContinuable: extras.startContinuable }
        : {}),
    },
    ...(extras.userQuestions !== undefined ? { userQuestions: extras.userQuestions } : {}),
    agents: {
      get: (id: string) => registry.get(id),
      ...(extras.resume !== undefined ? { resume: extras.resume } : {}),
    },
    tools: { register() {} },
    systemPrompt: { section() {} },
    get: (key: string) =>
      key === 'workspaceRegistry'
        ? { list: () => [{ path: ws, title: 'ws' }] }
        : undefined,
  } as unknown as Context;
}

function callTool(
  name: 'eteams_ask_user' | 'eteams_ask_answer',
  args: Record<string, unknown>,
  agent: Agent,
  ctx: Context,
): Promise<Record<string, unknown>> {
  const tool = createAskUserTools(config, ctx).find((t) => t.name === name);
  if (!tool) throw new Error(`${name} 未注册`);
  return tool.execute(args as never, { agent, signal: undefined } as never) as Promise<
    Record<string, unknown>
  >;
}

const askArgs = (): Record<string, unknown> => ({ questions: QUESTIONS });

// ---------- 路由判定（纯函数） ----------

describe('decideAskRoute 路由判定', () => {
  it('presence 命中提问会话 → 就地弹', () => {
    expect(
      decideAskRoute({ askingSessionId: 'm-1', mainSessionId: 'cap-1', presenceSessionId: 'm-1' }),
    ).toEqual({ mode: 'self' });
  });

  it('主会话自己提问 → 就地弹（无 presence 也可）', () => {
    expect(decideAskRoute({ askingSessionId: 'cap-1', mainSessionId: 'cap-1' })).toEqual({
      mode: 'self',
    });
  });

  it('presence 指向别处 / 缺失 → 严格转交主会话', () => {
    expect(
      decideAskRoute({ askingSessionId: 'm-1', mainSessionId: 'cap-1', presenceSessionId: 'x-1' }),
    ).toEqual({ mode: 'relay', targetSessionId: 'cap-1' });
    expect(decideAskRoute({ askingSessionId: 'm-1', mainSessionId: 'cap-1' })).toEqual({
      mode: 'relay',
      targetSessionId: 'cap-1',
    });
  });

  it('无快照退心跳兜底；两皆无 → 降级', () => {
    expect(decideAskRoute({ askingSessionId: 'm-1', mainSessionId: '', presenceSessionId: 'p-1' })).toEqual(
      { mode: 'relay', targetSessionId: 'p-1' },
    );
    expect(decideAskRoute({ askingSessionId: 'm-1', mainSessionId: '' })).toEqual({
      mode: 'degrade',
    });
  });
});

// ---------- eteams_ask_user ----------

describe('eteams_ask_user 转交主会话', () => {
  it('主会话在线 → steer 转交 + 问答单 pending 后立即返回（不停驻）；eteams_ask_answer 回收并 followup 唤醒提问子代理', async () => {
    seedTeam();
    const cap = fakeLive('cap-1');
    const ctx = fakeCtx([cap]);
    const result = await callTool('eteams_ask_user', askArgs(), memberAgent(), ctx);
    // 转交即返回（不阻塞等答案）：问答单 pending、主会话已收到转交全文。
    expect(result).toMatchObject({ ok: true, mode: 'relayed', relayedTo: 'cap-1' });
    expect(String(result.nextStep)).toContain('结束本回合');
    const rows = readPendingAsksSync(root, 1);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(cap.steer).toHaveBeenCalledTimes(1);
    const message = cap.steer.mock.calls[0]![0] as {
      content: { text: string }[];
      source?: { summary?: string };
    };
    expect(message.content[0].text).toContain('验收偏好哪种形式？');
    expect(message.content[0].text).toContain(row.askId);
    expect(message.source?.summary).toContain('问答转交');
    // 主会话（展示弹窗的对话）提交答案 → 问答单回收 + 提问成员被 followup 唤醒。
    await callTool(
      'eteams_ask_answer',
      { askId: row.askId, answers: [{ id: 'q1', selected: '跑测试脚本（推荐）' }] },
      mainAgent(),
      ctx,
    );
    expect(readAskSync(root, row.askId)?.status).toBe('answered');
    const followup = (ctx as unknown as { subagents: { followup: ReturnType<typeof vi.fn> } })
      .subagents.followup;
    expect(followup).toHaveBeenCalledTimes(1);
    // parent 必须是主会话锚（成员子会话的真实父），目标是提问成员会话。
    expect(followup.mock.calls[0]![0]).toMatchObject({ id: 'cap-1' });
    expect(followup.mock.calls[0]![1]).toBe('member-1');
    const wakeText = (followup.mock.calls[0]![2] as { text: string }[])[0]!.text;
    expect(wakeText).toContain('问答已作答');
    expect(wakeText).toContain('验收偏好哪种形式？');
  });

  it('主会话离线 → agents.resume 冷恢复投递；答案回收后唤醒同样冷恢复', async () => {
    seedTeam();
    const resumedAgent = fakeLive('cap-1');
    const resume = vi.fn(async () => ({ agent: resumedAgent, dispose: async () => undefined }));
    const ctx = fakeCtx([], { resume });
    const result = await callTool('eteams_ask_user', askArgs(), memberAgent(), ctx);
    expect(result).toMatchObject({ ok: true, mode: 'relayed', relayedTo: 'cap-1' });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]![0]).toMatchObject({ resumeSessionId: 'cap-1' });
    expect(resumedAgent.followup).toHaveBeenCalledTimes(1);
    const row = readPendingAsksSync(root, 1)[0]!;
    await callTool(
      'eteams_ask_answer',
      { askId: row.askId, answers: [{ id: 'q1', selected: '人工走查' }] },
      mainAgent(),
      ctx,
    );
    expect(readAskSync(root, row.askId)?.status).toBe('answered');
    // 唤醒：主会话仍不在册 → 再次冷恢复 → followup 进提问成员会话。
    expect(resume.mock.calls.length).toBeGreaterThanOrEqual(2);
    const followup = (ctx as unknown as { subagents: { followup: ReturnType<typeof vi.fn> } })
      .subagents.followup;
    expect(followup).toHaveBeenCalledTimes(1);
    expect(followup.mock.calls[0]![1]).toBe('member-1');
  });

  it('主会话离线且运行时不支持冷恢复 → 降级 + 问答单取消', async () => {
    seedTeam();
    const result = await callTool('eteams_ask_user', askArgs(), memberAgent(), fakeCtx([]));
    expect(result).toMatchObject({ ok: true, mode: 'degraded' });
    expect(String(result.degradeHint)).toContain('不要重试弹窗');
    expect(readPendingAsksSync(root, 1)).toHaveLength(0);
  });

  it('团队无主会话快照且无心跳 → 降级（不落单、不投递）', async () => {
    seedTeam({ withMainSession: false });
    const cap = fakeLive('cap-1');
    const result = await callTool('eteams_ask_user', askArgs(), memberAgent(), fakeCtx([cap]));
    expect(result).toMatchObject({ ok: true, mode: 'degraded' });
    expect(cap.steer).not.toHaveBeenCalled();
    expect(readPendingAsksSync(root, 1)).toHaveLength(0);
  });
});

describe('eteams_ask_user 就地弹（用户正在看提问会话）', () => {
  it('presence 命中提问成员 → ctx.userQuestions.ask 直调，答案同步返回 + 问答单 answered', async () => {
    seedTeam();
    await writeBuildPresence(root, 'member-1');
    const ask = vi.fn(async (request: { questions: { id: string }[] }) => ({
      answers: request.questions.map((q) => ({ id: q.id, selected: '跑测试脚本（推荐）' })),
    }));
    const result = await callTool(
      'eteams_ask_user',
      askArgs(),
      memberAgent(),
      fakeCtx([], { userQuestions: { ask } }),
    );
    expect(result).toMatchObject({
      ok: true,
      mode: 'self',
      answers: [{ id: 'q1', selected: '跑测试脚本（推荐）' }],
    });
    expect(ask).toHaveBeenCalledTimes(1);
    // 弹窗服务鉴权需要精确的活运行时根——agent 原样透传。
    expect((ask.mock.calls[0]![0] as { agent?: unknown }).agent).toMatchObject({ id: 'member-1' });
    // 就地弹也落审计行：askId 随结果返回，行状态 = answered。
    const selfAskId = String(result.askId);
    expect(readAskSync(root, selfAskId)?.status).toBe('answered');
  });

  it('presence 命中但弹窗服务缺失 → 降级', async () => {
    seedTeam();
    await writeBuildPresence(root, 'member-1');
    const result = await callTool('eteams_ask_user', askArgs(), memberAgent(), fakeCtx([]));
    expect(result).toMatchObject({ ok: true, mode: 'degraded' });
    expect(String(result.degradeHint)).toContain('弹窗服务不可用');
  });

  it('弹窗被拒（DELEGATED_CALLER 等）→ 降级 + 问答单取消，不阻塞', async () => {
    seedTeam();
    await writeBuildPresence(root, 'member-1');
    const ask = vi.fn(async () => {
      throw new Error('human interaction is unavailable while the calling agent is owned');
    });
    const result = await callTool(
      'eteams_ask_user',
      askArgs(),
      memberAgent(),
      fakeCtx([], { userQuestions: { ask } }),
    );
    expect(result).toMatchObject({ ok: true, mode: 'degraded' });
    expect(String(result.degradeHint)).toContain('不要重试弹窗');
    // 取消的问答单不再是 pending（面板徽标不悬挂）。
    expect(readPendingAsksSync(root, 1)).toHaveLength(0);
  });

  it('主会话自己提问（无 presence）→ 就地弹', async () => {
    seedTeam();
    const ask = vi.fn(async (request: { questions: { id: string }[] }) => ({
      answers: request.questions.map((q) => ({ id: q.id, selected: 'A' })),
    }));
    const result = await callTool(
      'eteams_ask_user',
      askArgs(),
      mainAgent(),
      fakeCtx([], { userQuestions: { ask } }),
    );
    expect(result).toMatchObject({ ok: true, mode: 'self' });
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

// ---------- eteams_ask_answer ----------

describe('eteams_ask_answer 回收', () => {
  it('未知 askId / 重复提交 → 明确报错', async () => {
    seedTeam();
    await expect(
      callTool('eteams_ask_answer', { askId: 'nope', answers: [{ id: 'q1', selected: 'A' }] }, mainAgent(), fakeCtx([])),
    ).rejects.toThrow(/不存在/);
    const askId = 'ask-1';
    insertAskForTest(askId);
    await callTool('eteams_ask_answer', { askId, answers: [{ id: 'q1', selected: 'A' }] }, mainAgent(), fakeCtx([]));
    await expect(
      callTool('eteams_ask_answer', { askId, answers: [{ id: 'q1', selected: 'B' }] }, mainAgent(), fakeCtx([])),
    ).rejects.toThrow(/已结束/);
  });

  it('selected 串数组 → 归一为「、」连接串（normalizeAskAnswer 单元口径）', () => {
    expect(
      normalizeAskAnswer({ id: 'q1', selected: ['甲', '乙'] }),
    ).toEqual({ id: 'q1', selected: '甲、乙' });
    // 缺 id 的答案条目丢弃；custom 保留。
    expect(normalizeAskAnswer({ selected: 'A' })).toBeUndefined();
    expect(normalizeAskAnswer({ id: 'q1', selected: '', custom: '我自己写的' })).toEqual({
      id: 'q1',
      selected: '',
      custom: '我自己写的',
    });
  });
});

/** 直接种一张 pending 问答单（回收用例的起点）。 */
function insertAskForTest(askId: string): void {
  const now = Date.now();
  insertAskSync(root, {
    askId,
    teamId: 1,
    askingSessionId: 'member-1',
    askingName: '甲',
    askingKind: 'member',
    questions: QUESTIONS,
    status: 'pending',
    relaySessionId: 'cap-1',
    createdAt: now,
    updatedAt: now,
  });
}
