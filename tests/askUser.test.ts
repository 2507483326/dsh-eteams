/**
 * 子代理用户问答（eteams_ask_user，2026-09-10 统一路径）tests：弹窗目标优先
 * 提问方所属的**主对话**（任务锚 mainSessionId / 构建父会话，agents.get 取
 * 活运行时根），主对话不在线或拒收退回提问会话自身再试一次（ctx.userQuestions
 * .ask 阻塞等答案、同回合继续）——弹也先落审计行（面板徽标数据源），答案落
 * 行回传；构建师调用走 fallback 身份（构建会话 builderChildId 判定），答案由
 * 宿主自动写回构建会话；服务缺失 → 不落单直接降级；两连弹都被拒 → 行转
 * cancelled 后降级；非团队非构建调用者原样抛错。直接驱动工具 execute，走
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
import {
  markBuilderChild,
  readBuildSession,
  reportBuildProgress,
  setBuildParentSession,
} from '../src/host/runtime/roleBuilder';
import {
  normalizeAskAnswer,
  readAllPendingAsksSync,
  readAskSync,
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

function seedTeam(): TeamState {
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
        mainSessionId: 'cap-1',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    pendingDecisions: [],
  };
  withTeamTx(root, teamId, (tx) => writeTeamInTx(tx, state));
  return state;
}

// ---------- offline ctx stub ----------

function agentOf(id: string): Agent {
  return { id, session: { header: { cwd: ws } } } as unknown as Agent;
}

/** Ask 服务桩：回包按问题 id 一一映射到固定 label（弹窗服务的最小契约）。 */
function fakeAsk(label: string): ReturnType<typeof vi.fn> {
  return vi.fn(async (request: { questions: { id: string }[] }) => ({
    answers: request.questions.map((q) => ({ id: q.id, selected: label })),
  }));
}

function fakeCtx(
  extras: { userQuestions?: { ask: ReturnType<typeof vi.fn> } } = {},
): Context {
  return {
    logger: { info: () => undefined, warn: () => undefined },
    ...(extras.userQuestions !== undefined ? { userQuestions: extras.userQuestions } : {}),
    agents: { get: () => undefined },
    tools: { register() {} },
    systemPrompt: { section() {} },
    get: (key: string) =>
      key === 'workspaceRegistry'
        ? { list: () => [{ path: ws, title: 'ws' }] }
        : undefined,
  } as unknown as Context;
}

function callAsk(
  args: Record<string, unknown>,
  agent: Agent,
  ctx: Context,
): Promise<Record<string, unknown>> {
  const tool = createAskUserTools(config, ctx).find((t) => t.name === 'eteams_ask_user');
  if (!tool) throw new Error('eteams_ask_user 未注册');
  return tool.execute(args as never, { agent, signal: undefined } as never) as Promise<
    Record<string, unknown>
  >;
}

const askArgs = (): Record<string, unknown> => ({ questions: QUESTIONS });

// ---------- 统一路径：弹窗落在提问子代理自己的对话 ----------

describe('eteams_ask_user 统一路径（弹窗落在提问子对话）', () => {
  it('成员提问 → ctx.userQuestions.ask 阻塞拿答案，答案同步返回 + 问答单 answered', async () => {
    seedTeam();
    const ask = fakeAsk('跑测试脚本（推荐）');
    const result = await callAsk(askArgs(), agentOf('member-1'), fakeCtx({ userQuestions: { ask } }));
    expect(result).toMatchObject({
      ok: true,
      mode: 'self',
      answers: [{ id: 'q1', selected: '跑测试脚本（推荐）' }],
    });
    expect(ask).toHaveBeenCalledTimes(1);
    // 主对话不在线（agents.get 查不到锚会话）→ runtime 退回提问会话自身。
    expect((ask.mock.calls[0]![0] as { agent?: unknown }).agent).toMatchObject({ id: 'member-1' });
    // 就地弹也落审计行（面板徽标数据源）：pending → answered。
    const selfAskId = String(result.askId);
    const row = readAskSync(root, selfAskId);
    expect(row?.status).toBe('answered');
    expect(row?.askingKind).toBe('member');
    // relaySessionId 语义收窄为「弹窗所在会话」——恒等于提问会话自身。
    expect(row?.relaySessionId).toBe('member-1');
  });

  it('领队（主会话身份）提问 → 就地弹，行 askingKind=captain', async () => {
    seedTeam();
    const ask = fakeAsk('A');
    const result = await callAsk(askArgs(), agentOf('cap-1'), fakeCtx({ userQuestions: { ask } }));
    expect(result).toMatchObject({ ok: true, mode: 'self' });
    expect(readAskSync(root, String(result.askId))?.askingKind).toBe('captain');
  });

  it('弹窗服务缺失 → 降级且**不落单**（不留孤儿 pending 行）', async () => {
    seedTeam();
    const result = await callAsk(askArgs(), agentOf('member-1'), fakeCtx());
    expect(result).toMatchObject({ ok: true, mode: 'degraded' });
    expect(String(result.degradeHint)).toContain('弹窗服务不可用');
    expect(readAllPendingAsksSync(root)).toHaveLength(0);
    expect(readAskSync(root, String(result.askId ?? ''))).toBeUndefined();
  });

  it('弹窗被拒（DELEGATED_CALLER 等）→ 行转 cancelled 后降级，不阻塞', async () => {
    seedTeam();
    const ask = vi.fn(async () => {
      throw new Error('human interaction is unavailable while the calling agent is owned');
    });
    const result = await callAsk(
      askArgs(),
      agentOf('member-1'),
      fakeCtx({ userQuestions: { ask } }),
    );
    expect(result).toMatchObject({ ok: true, mode: 'degraded' });
    expect(String(result.degradeHint)).toContain('不要重试弹窗');
    // 取消的问答单不再是 pending（面板徽标不悬挂）。
    expect(readAllPendingAsksSync(root)).toHaveLength(0);
    expect(readAskSync(root, String(result.askId))?.status).toBe('cancelled');
  });

  it('非团队非构建调用者 → 原样抛错（身份门禁不放宽）', async () => {
    seedTeam();
    await expect(
      callAsk(askArgs(), agentOf('stranger-1'), fakeCtx({ userQuestions: { ask: fakeAsk('A') } })),
    ).rejects.toThrow(/不在任何 eteams 团队中/);
  });

  it('多选别名容错：multi_select / multi 归一为 multiSelect（2026-09-11 实况）', async () => {
    // 模型常把规范字段写成 multi_select，或沿用构建访谈的旧名 multi——两者
    // 都必须归一为 multiSelect，否则多选语义丢失（严格 schema 曾整包拒收调用）。
    seedTeam();
    const ask = fakeAsk('A');
    await callAsk(
      {
        questions: [
          { id: 'q1', question: '甲？', options: [{ label: 'A' }], multi_select: true },
          { id: 'q2', question: '乙？', options: [{ label: 'B' }], multi: true },
        ],
      },
      agentOf('member-1'),
      fakeCtx({ userQuestions: { ask } }),
    );
    const sent = (ask.mock.calls[0]![0] as { questions: Record<string, unknown>[] }).questions;
    expect(sent[0]).toMatchObject({ id: 'q1', multiSelect: true });
    expect(sent[1]).toMatchObject({ id: 'q2', multiSelect: true });
  });

  it('问题项 schema 放宽：additionalProperties=true（别名不再被宿主拒收）', () => {
    const tool = createAskUserTools(config, fakeCtx()).find((t) => t.name === 'eteams_ask_user');
    const params = tool?.parameters as {
      properties?: { questions?: { items?: { additionalProperties?: boolean } } };
    };
    expect(params?.properties?.questions?.items?.additionalProperties).toBe(true);
  });
});

// ---------- 弹窗目标=主对话（原生弹窗直接弹在用户正在的窗口） ----------

describe('eteams_ask_user 弹窗目标主对话', () => {
  /** 桩 ctx 的 agents.get 改为按 id 命中（主对话在线的模拟）。 */
  function withLiveAgent(ctx: Context, liveId: string): Context {
    (ctx as unknown as { agents: { get: (id: string) => unknown } }).agents.get = (id) =>
      id === liveId ? agentOf(id) : undefined;
    return ctx;
  }

  it('成员提问且主对话在线 → 弹窗带主对话 agent（任务锚 mainSessionId）', async () => {
    seedTeam();
    const ask = fakeAsk('A');
    const result = await callAsk(
      askArgs(),
      agentOf('member-1'),
      withLiveAgent(fakeCtx({ userQuestions: { ask } }), 'cap-1'),
    );
    expect(result).toMatchObject({ ok: true, mode: 'self' });
    expect(ask).toHaveBeenCalledTimes(1);
    // 成员甲的锚定主任务 1 记着 mainSessionId='cap-1'——弹窗目标切到主对话。
    expect((ask.mock.calls[0]![0] as { agent?: unknown }).agent).toMatchObject({ id: 'cap-1' });
    // 行审计：提问者仍是成员甲（askingSessionId 不随弹窗目标漂移）。
    const row = readAskSync(root, String(result.askId));
    expect(row?.askingSessionId).toBe('member-1');
    expect(row?.status).toBe('answered');
  });

  it('主对话在线但弹窗被拒 → 退回提问会话自身再试一次（两连弹）', async () => {
    seedTeam();
    const ask = vi
      .fn()
      .mockRejectedValueOnce(new Error('human interaction is not valid for this caller'))
      .mockImplementation(async (request: { questions: { id: string }[] }) => ({
        answers: request.questions.map((q) => ({ id: q.id, selected: 'A' })),
      }));
    const result = await callAsk(
      askArgs(),
      agentOf('member-1'),
      withLiveAgent(fakeCtx({ userQuestions: { ask } }), 'cap-1'),
    );
    expect(result).toMatchObject({ ok: true, mode: 'self' });
    expect(ask).toHaveBeenCalledTimes(2);
    // 第一弹主对话、第二弹提问会话自身——主对话拒收不致命。
    expect((ask.mock.calls[0]![0] as { agent?: unknown }).agent).toMatchObject({ id: 'cap-1' });
    expect((ask.mock.calls[1]![0] as { agent?: unknown }).agent).toMatchObject({ id: 'member-1' });
    expect(readAskSync(root, String(result.askId))?.status).toBe('answered');
  });
});

// ---------- 构建师 fallback：答案由宿主自动写回构建会话 ----------

describe('eteams_ask_user 构建师分支（答案自动落构建会话）', () => {
  /** 构建会话种子：受理 → 记 childId → 发布访谈（active + 待答）。 */
  async function seedBuildSession(): Promise<void> {
    await reportBuildProgress(root, { request: 'r' });
    await markBuilderChild(root, 'builder-1');
    await reportBuildProgress(root, {
      step: '意图访谈',
      interview: {
        questions: [
          {
            id: 'q1',
            question: '你主要用它做什么？',
            options: [{ label: '写数据管道（推荐）' }, { label: '写前端' }],
          },
        ],
      },
    });
  }

  it('构建师提问 → resolveCaller 抛错走 fallback，答案宿主自动写回构建会话 + 行 answered + 不唤醒', async () => {
    await seedBuildSession();
    const ask = fakeAsk('写数据管道（推荐）');
    const result = await callAsk(
      askArgs(),
      agentOf('builder-1'),
      fakeCtx({ userQuestions: { ask } }),
    );
    expect(result).toMatchObject({ ok: true, mode: 'self' });
    const row = readAskSync(root, String(result.askId));
    expect(row?.status).toBe('answered');
    expect(row?.askingKind).toBe('conversation');
    // 构建会话访谈状态同步（面板工作台可见答案）——宿主自动落盘，无须
    // 构建子代理再 build_report(answers)。
    expect(readBuildSession(root)?.interview?.answers).toEqual([
      { id: 'q1', choice: '写数据管道（推荐）' },
    ]);
  });

  it('构建会话已有答案 → 写回幂等覆写（最新答案胜出），问答照常返回', async () => {
    await seedBuildSession();
    // 先用面板旁路面把答案落上（answerBuildInterview 已收口）。
    await reportBuildProgress(root, { answers: [{ id: 'q1', choice: '写前端' }] });
    const ask = fakeAsk('写数据管道（推荐）');
    const result = await callAsk(
      askArgs(),
      agentOf('builder-1'),
      fakeCtx({ userQuestions: { ask } }),
    );
    // 问答本身成功；宿主写回是覆写语义——面板补交的旧答案被弹窗答案刷新。
    expect(result).toMatchObject({ ok: true, mode: 'self' });
    expect(readBuildSession(root)?.interview?.answers).toEqual([
      { id: 'q1', choice: '写数据管道（推荐）' },
    ]);
  });

  it('构建父会话在线 → 弹窗目标切到父会话（不退回构建子对话）', async () => {
    await seedBuildSession();
    await setBuildParentSession(root, 'cap-9');
    const ask = fakeAsk('写数据管道（推荐）');
    const ctx = fakeCtx({ userQuestions: { ask } });
    (ctx as unknown as { agents: { get: (id: string) => unknown } }).agents.get = (id) =>
      id === 'cap-9' ? agentOf(id) : undefined;
    const result = await callAsk(askArgs(), agentOf('builder-1'), ctx);
    expect(result).toMatchObject({ ok: true, mode: 'self' });
    expect(ask).toHaveBeenCalledTimes(1);
    // 弹窗直接弹在发起构建的 /eteam 主对话（受理时落盘的父会话 id）。
    expect((ask.mock.calls[0]![0] as { agent?: unknown }).agent).toMatchObject({ id: 'cap-9' });
    // 宿主自动写回构建会话照旧。
    expect(readBuildSession(root)?.interview?.answers).toEqual([
      { id: 'q1', choice: '写数据管道（推荐）' },
    ]);
  });
});

// ---------- 纯函数 ----------

describe('normalizeAskAnswer 单元口径', () => {
  it('selected 串数组 → 归一为「、」连接串；缺 id 丢弃；custom 保留', () => {
    expect(normalizeAskAnswer({ id: 'q1', selected: ['甲', '乙'] })).toEqual({
      id: 'q1',
      selected: '甲、乙',
    });
    expect(normalizeAskAnswer({ selected: 'A' })).toBeUndefined();
    expect(normalizeAskAnswer({ id: 'q1', selected: '', custom: '我自己写的' })).toEqual({
      id: 'q1',
      selected: '',
      custom: '我自己写的',
    });
  });
});
