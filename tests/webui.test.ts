/**
 * M4 web-surface tests (docs/35 §5/§6): the TeamSnapshot builder over the
 * SQLite state root, the panel write routes, the docs/26 conversation task
 * loop, the GET /board cross-team aggregation and the usageCalendar route —
 * all driven offline through the runtime ops with a fake subagent runtime.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { ETeamsConfig, type ETeamsResolvedConfig } from '../src/host/config';
import { createCaptainTools } from '../src/host/tools/captainTools';
import { createMemberTools } from '../src/host/tools/memberTools';
import { installWebSurface, summarizeEvent, teamSnapshot } from '../src/host/runtime/webui';
import { minutesFileName } from '../src/host/runtime/docs';
import {
  cancelBuildSession,
  markBuilderChild,
  readBuildSession,
  reportBuildProgress,
  setBuildParentSession,
} from '../src/host/runtime/roleBuilder';
import { joinPath } from '../src/host/runtime/base';
import { readCaptainTurn } from '../src/host/runtime/captainAgent';
import { unregisterCaptainChild } from '../src/host/runtime/captainChildRegistry';
import { clearSessionTeam, setSessionTeam } from '../src/host/runtime/sessionTeam';
import { getDb } from '../src/host/state/db';
import { recordUsage, type UsageRecord } from '../src/host/state/usageStore';
import { readTeamSync } from '../src/host/state/store';
import { cleanupTempWorkspace } from './support/tmpWorkspace';
import type { TeamState } from '../src/host/model/types';

let workspace: string;
let config: ETeamsResolvedConfig;

/** This test suite's SQLite state root（库文件 <workspace>/.eteams/db/）.
 * 与 runtime 同口径：joinPath 用「/」拼（base.ts），getDb 的连接缓存按这个
 * 字符串做键——测试收尾 closeDb 必须用同一把键，否则连接关不掉。 */
function stateRoot(): string {
  return joinPath(workspace, '.eteams');
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'eteams-webui-'));
  config = ETeamsConfig({}) as ETeamsResolvedConfig;
});

afterEach(() => {
  // 先关 SQLite 连接再删目录：getDb 按状态根缓存连接，不关就占住
  // db/-wal/-shm 三个文件，Windows 上 rmSync 直接 EPERM（共享辅助见
  // tests/support/tmpWorkspace.ts）。
  cleanupTempWorkspace(workspace);
});

/** 读回一支团队（SQLite 真相源），缺省报错让断言失败在正确的行上。 */
function readTeam(teamId: number | string): TeamState {
  const team = readTeamSync(stateRoot(), teamId);
  if (team === undefined) throw new Error(`团队 ${teamId} 不存在`);
  return team;
}

/** Parse a JSON body with a local type assertion. */
function json<T>(body: string): T {
  return JSON.parse(body) as T;
}

/** A fake res object capturing status + body. */
function makeRes(): {
  code: number;
  body: string;
  writeHead(code: number): void;
  end(d?: string): void;
} {
  return {
    code: 0,
    body: '',
    writeHead(code: number) {
      this.code = code;
    },
    end(data?: string) {
      this.body = data ?? '';
    },
  };
}

type Handler = (req: unknown, res: unknown) => Promise<void>;

/** Fire one request through the registered prefix handler. */
async function fire(
  handler: Handler,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
): Promise<{ code: number; body: string }> {
  const r = makeRes();
  const payload = body === undefined ? '' : JSON.stringify(body);
  await handler(
    {
      method,
      url,
      on(event: string, cb: (chunk?: Buffer) => void) {
        if (event === 'data' && payload !== '') cb(Buffer.from(payload, 'utf8'));
        if (event === 'end') cb();
      },
    },
    r,
  );
  return { code: r.code, body: r.body };
}

/** Minimal host ctx: no subagents worth driving (members stay staged). */
function fakeCtx(): Context {
  return {
    logger: { info: () => undefined, warn: (m: string) => console.warn(`[warn] ${m}`) },
    subagents: {
      async startContinuable() {
        return { childId: 'c1', messageId: 'm' };
      },
      async followup() {
        return 'm';
      },
      interrupt() {},
    },
    agents: { get: () => undefined },
    tools: { register() {} },
    systemPrompt: { section() {} },
  } as unknown as Context;
}

interface SurfaceHarness {
  handler: Handler;
  get: (url: string) => Promise<{ code: number; body: string }>;
  post: (path: string, body?: unknown) => Promise<{ code: number; body: string }>;
  /** live 会话注册表（ctx.agents.get 的底层 Map）——二十五轮 DA38 无领队
   * 锚点用例要「原主会话下线」（delete 键）驱动心跳退化路径。 */
  captains: Map<string, FakeAgent>;
  /** ctx.agents 引用（三十七轮 DA50 冷恢复用例往上面挂 fake resume）。 */
  agents?: { get: (id: string) => unknown };
  /** 工具调用（默认主会话 cap-conv）；传 agent 可换会话——「一个团队多个
   * 主任务」只能来自多个对话，用例借此模拟第二个对话（各自锚定自己的主任务）。 */
  call?: (
    name: string,
    args: Record<string, unknown>,
    agent?: FakeAgent,
  ) => Promise<Record<string, unknown>>;
  /** 原始工具调用（不补收口）——观察「创建中」窗口的用例用它。 */
  callRaw?: (
    name: string,
    args: Record<string, unknown>,
    agent?: FakeAgent,
  ) => Promise<Record<string, unknown>>;
  mem?: (
    agent: { id: string },
    name: string,
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  memberAgent?: (childId: string) => FakeAgent;
  /** 造一个假会话（不同于主会话）——配合 setSessionTeam 绑定到同一团队。 */
  agentFor?: (id: string) => FakeAgent;
}

/** 假 agent（工具执行只读 id + cwd）：主会话/第二个对话/成员子会话同形。 */
type FakeAgent = { id: string; session: { header: { cwd: string } } };

/** Shared route-registration plumbing (webServer + workspaceRegistry fakes).
 * workspaces 可覆写注册表列表（默认单工作区）——测试全局单库根去重用。 */
function surfaceCtx(
  captains: Map<string, { id: string; session: { header: { cwd: string } } }>,
  registered: Handler[],
  workspaces?: { path: string; title: string }[],
): Context {
  const list = workspaces ?? [{ path: workspace, title: 'ws' }];
  return {
    logger: { info: () => undefined, warn: () => undefined },
    agents: { get: (id: string) => captains.get(id) },
    effect: (fn: () => unknown) => {
      fn();
      return () => undefined;
    },
    get: (key: string) =>
      key === 'webServer'
        ? {
            register: (route: { handler: Handler }) => {
              registered.push(route.handler);
            },
          }
        : key === 'workspaceRegistry'
          ? { list: () => list }
          : undefined,
  } as unknown as Context;
}

/**
 * Panel-only harness: web surface + roster/team/task write routes. No live
 * captain in `agents` — dispatch (assign) is out of scope here, everything
 * else (建队/加人/建任务/挂起/删除) runs offline.
 */
async function installFake(): Promise<SurfaceHarness> {
  const registered: Handler[] = [];
  const captains = new Map<string, { id: string; session: { header: { cwd: string } } }>();
  const ctx = surfaceCtx(captains, registered);
  installWebSurface(ctx, config);
  const handler = registered[0]!;
  return {
    handler,
    get: async (url) => fire(handler, 'GET', url),
    post: async (path, body) => fire(handler, 'POST', path, body ?? {}),
  };
}

/**
 * Combined harness: captain/member tool face and the panel web surface share
 * one host ctx (fake continuable runtime hands out sequential childIds), so
 * a test can drive the full loop — 对话提交 → 拆解 → 指派 → 接取 → 交付 →
 * 主任务自动收口 — plus GET /board aggregation, end to end.
 */
async function installFull(
  overrides: Partial<ETeamsResolvedConfig> = {},
  opts: { failDispatch?: boolean } = {},
): Promise<SurfaceHarness> {
  const cfg = { ...config, ...overrides };
  const registered: Handler[] = [];
  const captains = new Map<string, { id: string; session: { header: { cwd: string } } }>();
  let childCounter = 0;
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined },
    subagents: {
      async startContinuable() {
        if (opts.failDispatch === true) throw new Error('子代理服务不可用');
        const childId = `sess-child-${++childCounter}`;
        return { childId, messageId: 'm-fake' };
      },
      async followup() {
        if (opts.failDispatch === true) throw new Error('子代理服务不可用');
        return 'm-fake';
      },
      interrupt() {},
    },
    agents: { get: (id: string) => captains.get(id) },
    tools: { register() {} },
    systemPrompt: { section() {} },
    ...surfaceCtx(captains, registered),
  } as unknown as Context;
  const captainAgent = { id: 'cap-conv', session: { header: { cwd: workspace } } };
  const secondCaptain = { id: 'cap-second', session: { header: { cwd: workspace } } };
  captains.set(captainAgent.id, captainAgent);
  captains.set(secondCaptain.id, secondCaptain);
  const captainTools = createCaptainTools(cfg, ctx);
  const memberTools = createMemberTools(cfg, ctx);
  const memberAgent = (childId: string) => ({
    id: childId,
    session: { header: { cwd: workspace } },
  });
  const callRaw = async (
    name: string,
    args: Record<string, unknown>,
    agent: FakeAgent = captainAgent,
  ): Promise<Record<string, unknown>> => {
    const tool = captainTools.find((t) => t.name === name);
    if (!tool) throw new Error(`missing captain tool ${name}`);
    return (await tool.execute(
      args as never,
      {
        agent,
        signal: undefined,
      } as never,
    )) as Record<string, unknown>;
  };
  // 用户迭代 2026-09-12：对话建的主任务先落「创建中」（面板显示创建中/动画/
  // 禁点），拆解完成后才由 eteams_submit_task(taskId) 收口转「待开始」。多数
  // 用例要的是可直接开跑的 ready 主任务——call 对不带 taskId 的提交自动补一次
  // 收口；需要观察「创建中」窗口的用例用 callRaw（见 docs/26 循环用例）。
  const call = async (
    name: string,
    args: Record<string, unknown>,
    agent: FakeAgent = captainAgent,
  ): Promise<Record<string, unknown>> => {
    const result = await callRaw(name, args, agent);
    if (name === 'eteams_submit_task' && args.taskId === undefined) {
      // 收口拆解质量闸（docs/taskOrchestrationRefinement）要求主任务下至少一个
      // 带非空「## 验收标准」的小任务：本助手只借收口拿 ready 容器，故先建一个
      // 占位小任务过闸、收口后删掉——让自建小任务的用例保持原语义。
      const placeholder = await callRaw(
        'eteams_create_task',
        {
          subject: '收口占位小任务',
          parentTaskId: result.taskId,
          contractMd: '## 验收标准\n1. 占位',
        },
        agent,
      );
      await callRaw(
        'eteams_submit_task',
        {
          taskId: result.taskId,
          subject: args.subject,
          ...(args.description !== undefined ? { description: args.description } : {}),
          // 收口问询自检闸（2026-09-12）：多数用例只借收口拿 ready 容器，
          // 显式声明跳过问询；问询闸本身由 lifecycle 的收口用例覆盖。
          skipQuestionnaire: true,
        },
        agent,
      );
      await callRaw('eteams_delete_task', { taskId: placeholder.taskId }, agent);
    }
    return result;
  };
  const mem = async (
    agent: { id: string },
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const tool = memberTools.find((t) => t.name === name);
    if (!tool) throw new Error(`missing member tool ${name}`);
    return (await tool.execute(args as never, { agent, signal: undefined } as never)) as Record<
      string,
      unknown
    >;
  };
  installWebSurface(ctx, cfg);
  const handler = registered[0]!;
  const agentFor = (id: string): FakeAgent => ({ id, session: { header: { cwd: workspace } } });
  return {
    handler,
    get: async (url) => fire(handler, 'GET', url),
    post: async (path, body) => fire(handler, 'POST', path, body ?? {}),
    captains,
    agents: (ctx as unknown as { agents: { get: (id: string) => unknown } }).agents,
    call,
    callRaw,
    mem,
    memberAgent,
    agentFor,
  };
}

/** Instance row → live child session id (member identity anchor). */
function childIdOf(teamId: number, name: string): string {
  const team = readTeam(teamId);
  const row = team.taskMembers
    .filter((r) => r.name === name && r.sessionId !== '')
    .at(-1);
  if (row === undefined) throw new Error(`成员 ${name} 还没有起会话`);
  return row.sessionId;
}

describe('TeamSnapshot builder (docs/35 §5 面板快照)', () => {
  it('projects members, tasks, chain stations, progress and events with integer ids', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '面板测试', sessionId: 'cap-conv' });
    expect(created.code).toBe(200);
    const { teamId } = json<{ teamId: number }>(created.body);
    expect(typeof teamId).toBe('number');
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Alice', role: 'researcher' });
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Bob', role: 'engineer' });

    const made = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '建站任务',
      chain: [
        { member: 'Alice', stageBrief: '调研' },
        { member: 'Bob', stageBrief: '实现' },
      ],
    });
    const madeBody = json<{ taskId: number; status: string }>(made.body);
    const t1 = madeBody.taskId;
    expect(madeBody.status).toBe('ready');
    const made2 = await h.post(`/eteams-api/team/${teamId}/task`, { subject: '普通任务' });
    const t2 = json<{ taskId: number }>(made2.body).taskId;

    // v6 锚点派生自任务行快照（面板建卡未盖章）∪ 心跳：客户端开着团队窗口
    // 会持续 POST /presence，这里补一次心跳让派发锚回线（DA38 同款）。
    await h.post('/eteams-api/presence', { sessionId: 'cap-conv' });

    const assigned = await h.call!('eteams_assign_task', { taskId: t1, member: 'Alice' });
    expect(assigned.ok).toBe(true);

    const snap = teamSnapshot(readTeam(teamId), workspace, config);
    expect(snap.teamId).toBe(teamId);
    expect(snap.leaderRemoved).toBe(false);
    // phase/goal/approve 一代目字段彻底退场（docs/27 §27.9#4）。
    expect(snap).not.toHaveProperty('phase');
    expect(snap).not.toHaveProperty('goal');
    expect(snap).not.toHaveProperty('planReviewState');
    expect(snap).not.toHaveProperty('workDir');
    expect(snap).not.toHaveProperty('captainSessionId');
    expect(snap).not.toHaveProperty('leaderModelRoute');
    // 进度只统计真实小任务（任务单容器不计入）。用户迭代 2026-09-11：派发不
    // 改状态（任务留 ready 待领取），「进行中」不计它——active 0。
    expect(snap.progress).toEqual({ completed: 0, total: 2, cancelled: 0, active: 0 });
    const captain = snap.captain as {
      name: string;
      employeeId: string;
      role: string;
      personaMd: string | null;
      avatar: { seed: number; salt: number };
    };
    expect(captain.name).toBe('团队领队');
    expect(captain.employeeId).toMatch(/^ET-\d{4}$/);
    expect(captain.personaMd).toContain('团队合作守则');
    expect(typeof captain.avatar.seed).toBe('number');

    const members = snap.members as Array<{
      name: string;
      employeeId: string | null;
      role: string;
      currentTaskId: number | null;
      childId: string | null;
      model: string | null;
    }>;
    expect(members.map((m) => m.name)).toEqual(['Alice', 'Bob']);
    expect(members[0]!.currentTaskId).toBe(t1);
    expect(members[0]!.childId).toMatch(/^sess-child-/);
    expect(members[0]!.employeeId).toMatch(/^ET-\d{4}$/);

    const tasks = snap.tasks as Array<{
      taskId: number;
      status: string;
      assignee: string | null;
      chain: { stationStatus: string; member: string }[];
      chainCursor: number;
      chainLength: number;
      attemptSummary: unknown[];
      kind: string;
      parentId: number | null;
      folder: string;
      outcome: string | null;
      /** 本任务里已有子会话的成员（用户 2026-09-14「会话成员」）。 */
      memberSessions: { name: string; employeeId: number | null; sessionId: string }[];
    }>;
    const v1 = tasks.find((t) => t.taskId === t1)!;
    // 用户迭代 2026-09-11：派发不改状态，派发后仍是 ready（领取才 start）。
    expect(v1.status).toBe('ready');
    expect(v1.assignee).toBe('Alice');
    expect(v1.kind).toBe('task');
    expect(v1.parentId).toBeNull();
    expect(v1.chain.map((s) => s.stationStatus)).toEqual(['current', 'pending']);
    expect(v1.attemptSummary).toHaveLength(1);
    const v2 = tasks.find((t) => t.taskId === t2)!;
    expect(v2.status).toBe('ready');
    expect(v2.chain).toEqual([]);
    expect(v2.assignee).toBeNull();

    // 用户 2026-09-14「会话成员按任务口径取」：只下发本任务里子会话已起的成员
    // ——Alice 已派发（子会话已起），t2 无人派发 → 空表（从 A 任务不会串到
    // B 任务的会话；未起会话的成员不列）。
    expect(v1.memberSessions.map((m) => m.name)).toEqual(['Alice']);
    expect(v1.memberSessions[0]!.sessionId).toBe(childIdOf(teamId, 'Alice'));
    expect(v2.memberSessions).toEqual([]);

    const events = snap.latestEvents as Array<{
      type: string;
      text: string;
      taskSubject: string | null;
      tone: string;
    }>;
    expect(events.some((e) => e.type === 'team.created')).toBe(true);
    expect(events.some((e) => e.type === 'member.added' && e.text.includes('Alice'))).toBe(true);
    const assignedEvent = events.find((e) => e.type === 'task.assigned');
    expect(assignedEvent?.text).toContain('Alice');
    // v14：事件带任务标签主题与语义色调（看板动态「和任务绑定」）。
    expect(assignedEvent?.taskSubject).toBeTruthy();
    expect(assignedEvent?.tone).toBe('info');

    // GET /team/<id>（面板作用域读）与 GET /state 投影同一份快照。
    const scoped = await h.get(`/eteams-api/team/${teamId}`);
    expect(scoped.code).toBe(200);
    expect(json<{ progress: { total: number } }>(scoped.body).progress.total).toBe(2);
    const state = await h.get('/eteams-api/state');
    const body = json<{ teams: { teamId: number; leaderRemoved: boolean }[]; maxMembers: number }>(
      state.body,
    );
    expect(body.maxMembers).toBe(10);
    expect(body.teams.find((t) => t.teamId === teamId)!.leaderRemoved).toBe(false);
  });

  it('乱序派发时「正在执行」标注真实在跑的站点，不按 chainCursor+1（用户 2026-09-14）', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '乱序队', sessionId: 'cap-conv' });
    const { teamId } = json<{ teamId: number }>(created.body);
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Alice', role: 'researcher' });
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Bob', role: 'engineer' });
    const made = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '跳站任务',
      chain: [
        { member: 'Alice', stageBrief: '调研' },
        { member: 'Bob', stageBrief: '实现' },
      ],
    });
    const t1 = json<{ taskId: number }>(made.body).taskId;
    await h.post('/eteams-api/presence', { sessionId: 'cap-conv' });

    // 跳过站 0（Alice）直接派发站 1（Bob）：弱顺序链允许，游标仍为 -1——旧实现
    // 会把站 0 错标为「正在执行」，用户据此报「显示 需求明确大师在运行，实际跑的
    // 是前端开发」。
    const assigned = await h.call!('eteams_assign_task', { taskId: t1, member: 'Bob' });
    expect(assigned.ok).toBe(true);

    const snap = teamSnapshot(readTeam(teamId), workspace, config);
    const v1 = snap.tasks.find((t) => t.taskId === t1)!;
    expect(v1.chainCursor).toBe(-1);
    expect(v1.chain.map((s) => s.stationStatus)).toEqual(['pending', 'current']);
    expect(v1.assignee).toBe('Bob');
  });

  it('summarizes lifecycle events into one-line zh strings', () => {
    const actor = { kind: 'system' as const };
    expect(
      summarizeEvent({ seq: 1, at: 0, actor, type: 'team.created', payload: { name: '甲队' } }),
    ).toBe('创建团队「甲队」');
    expect(
      summarizeEvent({
        seq: 2,
        at: 0,
        actor,
        type: 'task.assigned',
        taskId: 3,
        payload: { member: 'Alice' },
      }),
    ).toContain('Alice');
    expect(
      summarizeEvent({
        seq: 3,
        at: 0,
        actor,
        type: 'chain.deviated',
        taskId: 3,
        payload: { note: 'Bob 不可用' },
      }),
    ).toContain('偏离');
    expect(summarizeEvent({ seq: 4, at: 0, actor, type: 'custom.future' })).toBe('custom.future');
  });
});

describe('panel write routes (M5 first slice)', () => {
  it('upserts roster entries and serves GET /roster', async () => {
    const h = await installFake();
    await h.post('/eteams-api/roster', { name: 'Alice', role: 'researcher', duty: '调研与检索' });
    const again = await h.post('/eteams-api/roster', {
      name: 'Alice',
      role: 'writer',
      style: '简洁',
    });
    expect(again.code).toBe(200);
    const r = await h.get('/eteams-api/roster');
    expect(r.code).toBe(200);
    const parsed = json<{ members: { name: string; role: string }[] }>(r.body);
    // 预置（领队 + 角色构建师 + 主对话注入角色 system）随首启播种在库，Alice 是第四个。
    expect(parsed.members).toHaveLength(4);
    expect(parsed.members.find((m) => m.name === 'Alice')!.role).toBe('writer');
  });

  it('seeds preset members once and preserves user edits', async () => {
    const h = await installFake();
    const first = await h.get('/eteams-api/roster');
    const seeded = json<{
      members: { name: string; role: string; avatar?: unknown }[];
    }>(first.body);
    expect(seeded.members.map((m) => m.name)).toEqual(
      expect.arrayContaining(['角色构建师', '团队领队', 'system']),
    );
    expect(seeded.members).toHaveLength(3);
    for (const p of seeded.members) expect(p.avatar).toBeDefined();

    const second = await h.get('/eteams-api/roster');
    expect(json<{ members: unknown[] }>(second.body).members).toHaveLength(3);

    await h.post('/eteams-api/roster', {
      name: '角色构建师',
      role: '角色构建师',
      duty: '自定义职责',
    });
    const third = await h.get('/eteams-api/roster');
    const roster = json<{ members: { name: string; duty?: string }[] }>(third.body);
    expect(roster.members).toHaveLength(3);
    expect(roster.members.find((m) => m.name === '角色构建师')!.duty).toBe('自定义职责');
  });

  it('deletes roster members but protects the leader and the role builder', async () => {
    const h = await installFake();
    await h.get('/eteams-api/roster');
    await h.post('/eteams-api/roster', { name: 'Temp', role: 'engineer' });

    const removed = await h.post('/eteams-api/roster/Temp/remove', {});
    expect(removed.code).toBe(200);

    // 领队路由特判 400；角色构建师走 removeRosterMember 的系统保留校验 404。
    const leaderAttempt = await h.post('/eteams-api/roster/团队领队/remove', {});
    expect(leaderAttempt.code).toBe(400);
    const builderAttempt = await h.post('/eteams-api/roster/角色构建师/remove', {});
    expect(builderAttempt.code).toBe(404);

    const r = await h.get('/eteams-api/roster');
    const parsed = json<{ members: { name: string }[] }>(r.body);
    expect(parsed.members.find((m) => m.name === 'Temp')).toBeUndefined();
    expect(parsed.members.find((m) => m.name === '团队领队')).toBeDefined();
    expect(parsed.members.find((m) => m.name === '角色构建师')).toBeDefined();
  });

  it('removes a team member via the panel route', async () => {
    const h = await installFake();
    await h.get('/eteams-api/roster');
    await h.post('/eteams-api/roster', { name: 'Dave', role: 'engineer' });
    const created = await h.post('/eteams-api/team', {
      name: '移出团队测试',
      sessionId: 'sess-panel',
    });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const added = await h.post(`/eteams-api/team/${teamId}/member`, {
      name: 'Dave',
      fromRoster: true,
    });
    expect(added.code).toBe(200);
    // v7：领队也入班底（建队即发 ET-0001）——加一人后班底 = 领队 + Dave。
    expect(readTeam(teamId).members.map((m) => m.name)).toEqual(['团队领队', 'Dave']);

    const removed = await h.post(`/eteams-api/team/${teamId}/member/Dave/remove`, {});
    expect(removed.code).toBe(200);
    const fresh = readTeam(teamId);
    // v7 删除 = 班底行硬删（号作废不回收）；本测试未建任务 ⇒ 无副本行遗留。
    expect(fresh.members.find((m) => m.name === 'Dave')).toBeUndefined();
    expect(fresh.taskMembers.filter((r) => r.name === 'Dave')).toHaveLength(0);
    const snap = teamSnapshot(fresh, workspace, config);
    expect((snap.members as { name: string }[]).find((m) => m.name === 'Dave')).toBeUndefined();
  });

  it('creates a live team via POST /team and adopts a roster member', async () => {
    const h = await installFake();
    await h.post('/eteams-api/roster', {
      name: 'Bob',
      role: 'engineer',
      skills: '实现与测试',
      executionPrompt: '你是 Bob。',
    });
    // 建队即生效（docs/35 §5#1）：返回数字 teamId，没有 staged 阶段。
    const created = await h.post('/eteams-api/team', { name: '面板建队', sessionId: 'sess-panel' });
    expect(created.code).toBe(200);
    const body = json<{ ok: boolean; teamId: number; name: string }>(created.body);
    expect(body.ok).toBe(true);
    expect(typeof body.teamId).toBe('number');
    expect(body.name).toBe('面板建队');

    const added = await h.post(`/eteams-api/team/${body.teamId}/member`, {
      name: 'Bob',
      fromRoster: true,
    });
    expect(added.code).toBe(200);
    const addedBody = json<{ teamId: number; member: { name: string; employeeId: number | null } }>(
      added.body,
    );
    expect(addedBody.teamId).toBe(body.teamId);
    expect(addedBody.member.name).toBe('Bob');
    expect(typeof addedBody.member.employeeId).toBe('number');
    const fresh = readTeam(body.teamId);
    // v7：领队也占班底一行（members[0] = 领队）——按名找 Bob 的班底行。
    expect(fresh.members.find((m) => m.name === 'Bob')!.persona.skills).toBe('实现与测试');
    expect(fresh.members.find((m) => m.name === 'Bob')!.persona.executionPrompt).toBe('你是 Bob。');
    // v7 决策 5：副本行建任务即有——无任务时不产团队级实例行。
    expect(fresh.taskMembers.filter((r) => r.name === 'Bob')).toHaveLength(0);
    const snap = teamSnapshot(fresh, workspace, config);
    // 快照成员列表跳过领队卡 → [0] 就是 Bob（用户迭代 2026-09-10：成员没有
    // 状态——只验名字在场）。
    expect((snap.members as { name: string }[])[0]!.name).toBe('Bob');
  });

  it('pre-generates a roster avatar and the adopted member keeps a stable seed', async () => {
    const h = await installFake();
    const saved = await h.post('/eteams-api/roster', { name: 'Cara', role: '前端开发者' });
    expect(saved.code).toBe(200);
    const stored = json<{ member: { avatar?: { seed: number; salt: number } } }>(saved.body).member;
    expect(typeof stored.avatar?.seed).toBe('number');
    expect(typeof stored.avatar?.salt).toBe('number');

    const created = await h.post('/eteams-api/team', { name: '头像团队', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Cara', fromRoster: true });
    const fresh = readTeam(teamId);
    // 头像种子按名字稳定（hashName）；salt 独立随机——名册条目落库后头像
    // 读不回来（roster.ts avatarToJson 双重 JSON.stringify，遗留问题），
    // 收编时按名重新生成，种子不变。
    expect(fresh.members.find((m) => m.name === 'Cara')!.avatar?.seed).toBe(stored.avatar!.seed);

    const snap = teamSnapshot(fresh, workspace, config);
    const member = (snap.members as { name: string; avatar: { seed: number } }[]).find(
      (m) => m.name === 'Cara',
    )!;
    expect(member.avatar.seed).toBe(stored.avatar!.seed);
    expect((snap.captain as { name: string }).name).toBe('团队领队');
  });

  it('carries the preset personaMd through adoption and spawn rendering', async () => {
    const h = await installFake();
    await h.get('/eteams-api/roster');
    const created = await h.post('/eteams-api/team', { name: '手册团队', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: '角色构建师', fromRoster: true });
    const builder = readTeam(teamId).members.find((m) => m.name === '角色构建师')!;
    const md = builder.persona.personaMd;
    expect(md).toBeDefined();
    // 逐字原文（agency-agents-zh），不是蒸馏摘要。
    expect(md).toContain('核心使命');
    expect(md).toContain('关键规则');
    const { renderPersonaBlock } = await import('../src/host/prompts/personas/framework');
    const block = renderPersonaBlock(builder.persona, '角色构建师');
    expect(block).toContain('# 角色手册');
    expect(block).toContain('核心使命');
  });

  it('rejects adding a roster name that does not exist', async () => {
    const h = await installFake();
    const created = await h.post('/eteams-api/team', { name: '拒绝测试', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const added = await h.post(`/eteams-api/team/${teamId}/member`, {
      name: 'Ghost',
      fromRoster: true,
    });
    expect(added.code).toBe(404);
  });

  // ---------- employee id 工号 (docs/21) ----------

  it('strips 工号 from roster upserts（v7 工牌挪到班底）', async () => {
    const h = await installFake();
    const first = await h.post('/eteams-api/roster', { name: 'Alice', role: 'researcher' });
    const second = await h.post('/eteams-api/roster', { name: 'Bob', role: 'engineer' });
    // v7：角色卡不再带号（roles.employee_id 弃用不读写）——roster 读写端
    // 剥离工号，发号统一收口到入队（team_members 班底行自增主键）。
    for (const r of [first, second]) {
      expect(json<{ member: { employeeId?: number } }>(r.body).member.employeeId).toBeUndefined();
    }
    // 更新（同人改角色）走通即可。
    const updated = await h.post('/eteams-api/roster', { name: 'Alice', role: 'writer' });
    expect(updated.code).toBe(200);
    const seeded = await h.get('/eteams-api/roster');
    const parsed = json<{ members: { name: string; employeeId?: number }[] }>(seeded.body);
    for (const m of parsed.members) expect(m.employeeId).toBeUndefined();
  });

  it('issues a team-scoped 工号 when pulling a roster member into a team（v7 发号在班底）', async () => {
    const h = await installFake();
    const saved = await h.post('/eteams-api/roster', { name: 'Bob', role: 'engineer' });
    expect(saved.code).toBe(200);
    const created = await h.post('/eteams-api/team', { name: '发号团队', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const added = await h.post(`/eteams-api/team/${teamId}/member`, {
      name: 'Bob',
      fromRoster: true,
    });
    expect(added.code).toBe(200);
    // 表自增（v7）：领队建队即入班底领号 1（ET-0001），首名成员 = 2——号不再来自名册。
    expect(readTeam(teamId).members.find((m) => m.name === 'Bob')!.employeeId).toBe(2);
  });

  it('issues a fresh non-colliding 工号 for direct adds without a roster entry（v7）', async () => {
    const h = await installFake();
    const created = await h.post('/eteams-api/team', { name: '直加团队', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const added = await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Ghost' });
    expect(added.code).toBe(200);
    // 表自增现发：领队班底行（号 1）之后 Ghost = 2。
    expect(readTeam(teamId).members.find((m) => m.name === 'Ghost')!.employeeId).toBe(2);
    // 加成员即入库（v3 口径延续）：直加成员落角色库，但角色行不带号（v7）。
    await h.post('/eteams-api/roster', { name: 'Later', role: 'tester' });
    const seeded = await h.get('/eteams-api/roster');
    const parsed = json<{ members: { name: string; employeeId?: number }[] }>(seeded.body);
    expect(parsed.members.find((m) => m.name === 'Later')).toBeDefined();
    for (const m of parsed.members) expect(m.employeeId).toBeUndefined();
  });

  it('seeds the 主对话注入角色 system and lets the panel edit its raw MD（v12）', async () => {
    const h = await installFake();
    // 播种（GET /roster 即 ensurePresetMembers）：is_root 行默认 MD 空 + 提示简介。
    const seeded = await h.get('/eteams-api/roster');
    expect(seeded.code).toBe(200);
    const system = json<{
      members: { name: string; isRoot?: boolean; personaMd?: string; profile?: string }[];
    }>(seeded.body).members.find((m) => m.name === 'system');
    expect(system?.isRoot).toBe(true);
    expect(system?.personaMd).toBe('');
    expect(system?.profile).toContain('主对话注入');
    // 面板显式保存（POST /roster → allowRoot）：原文落库，不烘结构脚手架。
    const saved = await h.post('/eteams-api/roster', {
      name: 'system',
      role: 'system',
      personaMd: '# 注入规则\n- 总用中文回复 {{任何占位}}',
    });
    expect(saved.code, saved.body).toBe(200);
    const reread = await h.get('/eteams-api/roster');
    const after = json<{ members: { personaMd?: string }[] }>(reread.body).members.find(
      (m) => m.name === 'system',
    );
    expect(after?.personaMd).toBe('# 注入规则\n- 总用中文回复 {{任何占位}}');
    // 保留行不可删除（与角色构建师同走 removeRosterMember 系统保留路径）。
    const removed = await h.post('/eteams-api/roster/system/remove', {});
    expect(removed.code, removed.body).toBe(404);
    expect(removed.body).toContain('不可删除');
  });

  it('rejects adding the 主对话注入角色 system to a team（v12）', async () => {
    const h = await installFake();
    const created = await h.post('/eteams-api/team', { name: '注入团队', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const added = await h.post(`/eteams-api/team/${teamId}/member`, { name: 'system' });
    expect(added.code, added.body).toBe(400);
    expect(added.body).toContain('不能加入团队');
    expect(readTeam(teamId).members.find((m) => m.name === 'system')).toBeUndefined();
  });

  it('projects 工号 through the team snapshot (members and captain)', async () => {
    const h = await installFake();
    await h.post('/eteams-api/roster', { name: '前端开发者', role: '前端开发者' });
    const created = await h.post('/eteams-api/team', { name: '快照团队', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const added = await h.post(`/eteams-api/team/${teamId}/member`, {
      name: '前端开发者',
      fromRoster: true,
    });
    expect(added.code).toBe(200);
    const snap = teamSnapshot(readTeam(teamId), workspace, config);
    const member = (snap.members as { name: string; employeeId: string | null }[]).find(
      (m) => m.name === '前端开发者',
    )!;
    expect(member.employeeId).toMatch(/^ET-\d{4}$/);
    const captain = snap.captain as { name: string; employeeId: string };
    expect(captain.name).toBe('团队领队');
    expect(captain.employeeId).toMatch(/^ET-\d{4}$/);
  });

  it('ignores a legacy explicit 工号 in member adds and copies a roster role via sourceName (same role twice)', async () => {
    const h = await installFake();
    await h.post('/eteams-api/roster', { name: '文档织娘', role: '文档工程师' });
    const created = await h.post('/eteams-api/team', { name: '同角多人', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;

    // 第一份：旧客户端可能仍带 employeeId 字段——表自增口径不支持指定号，
    // 宿主忽略该字段、按班底主键现发（领队 1 之后 = 2），不落 9001。
    const first = await h.post(`/eteams-api/team/${teamId}/member`, {
      name: '文档织娘',
      fromRoster: true,
      employeeId: '9001',
    });
    expect(first.code).toBe(200);
    const m1 = readTeam(teamId).members.find((m) => m.name === '文档织娘')!;
    expect(m1.employeeId).toBe(2);
    const snap = teamSnapshot(readTeam(teamId), workspace, config);
    expect(
      (snap.members as { name: string; employeeId: string }[]).find((m) => m.name === '文档织娘')!
        .employeeId,
    ).toBe('ET-0002');

    // 第二份：sourceName 指向名册条目，角色默认随拷；工号由宿主续发。
    const second = await h.post(`/eteams-api/team/${teamId}/member`, {
      name: '文档织娘-2',
      sourceName: '文档织娘',
      fromRoster: true,
    });
    expect(second.code).toBe(200);
    const m2 = readTeam(teamId).members.find((m) => m.name === '文档织娘-2')!;
    expect(m2.role).toBe('文档工程师');
    expect(m2.employeeId).not.toBe(2);
  });

  it('sets and resets a member model route via POST /team/:id/member/:ref/model', async () => {
    const h = await installFake();
    await h.post('/eteams-api/roster', { name: 'Nova', role: 'engineer' });
    const created = await h.post('/eteams-api/team', { name: '模型团队', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const added = await h.post(`/eteams-api/team/${teamId}/member`, {
      name: 'Nova',
      fromRoster: true,
    });
    expect(added.code).toBe(200);
    // v7 R4：成员作用域路由按工号定位（<ref> = 数字工号；名字串 legacy 回退）。
    const novaId = json<{ member: { employeeId: number } }>(added.body).member.employeeId;
    expect(typeof novaId).toBe('number');

    const set = await h.post(`/eteams-api/team/${teamId}/member/${novaId}/model`, {
      provider: 'tr-test',
      model: 'z-ai/glm-5.3-free',
      reasoningEffort: 'high',
    });
    expect(set.code).toBe(200);
    const overridden = readTeam(teamId).members.find((m) => m.name === 'Nova')!.modelRoute;
    // v9 provider 回归：provider/model/effort 整组入档（同 id 模型跨提供方消歧）。
    expect(overridden).toMatchObject({
      provider: 'tr-test',
      model: 'z-ai/glm-5.3-free',
      reasoningEffort: 'high',
    });
    const providerSnap = teamSnapshot(readTeam(teamId), workspace, config);
    const providerMember = (
      providerSnap.members as {
        name: string;
        model: string;
        provider: string | null;
        reasoningEffort: string | null;
      }[]
    ).find((m) => m.name === 'Nova')!;
    expect(providerMember.model).toBe('z-ai/glm-5.3-free');
    expect(providerMember.provider).toBe('tr-test');

    // 空 body = 跟随领队 — 路线清回空（派发时解析）。
    const reset = await h.post(`/eteams-api/team/${teamId}/member/${novaId}/model`, {});
    expect(reset.code).toBe(200);
    const inherited = readTeam(teamId).members.find((m) => m.name === 'Nova')!.modelRoute;
    expect(inherited.model).toBe('');
    expect(inherited.provider).toBeUndefined();
    expect(inherited.reasoningEffort).toBeUndefined();
    const snap = teamSnapshot(readTeam(teamId), workspace, config);
    const member = (
      snap.members as {
        name: string;
        model: string;
        provider: string | null;
        reasoningEffort: string | null;
      }[]
    ).find((m) => m.name === 'Nova')!;
    expect(member.model).toBe('');
    expect(member.provider).toBeNull();
    expect(member.reasoningEffort).toBeNull();
  });

  it('toggles the leader in/out via POST /team/:id/leader/:action', async () => {
    const h = await installFake();
    const created = await h.post('/eteams-api/team', { name: '领队移除', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    expect(teamSnapshot(readTeam(teamId), workspace, config).leaderRemoved).toBe(false);

    const remove = await h.post(`/eteams-api/team/${teamId}/leader/remove`, {});
    expect(remove.code).toBe(200);
    // v8+：主持行取消——移除 = 班底领队行硬删 + hasLeader false（配置开关）。
    expect(readTeam(teamId).members.some((m) => m.isLeader === true)).toBe(false);
    expect(readTeam(teamId).hasLeader).toBe(false);
    expect(teamSnapshot(readTeam(teamId), workspace, config).leaderRemoved).toBe(true);

    // 幂等重发不翻转。
    await h.post(`/eteams-api/team/${teamId}/leader/remove`, {});
    expect(readTeam(teamId).members.some((m) => m.isLeader === true)).toBe(false);

    // 加回：班底领队行重建（续新工牌），leaderRemoved 翻回。
    const restore = await h.post(`/eteams-api/team/${teamId}/leader/restore`, {});
    expect(restore.code, restore.body).toBe(200);
    expect(teamSnapshot(readTeam(teamId), workspace, config).leaderRemoved).toBe(false);
    expect(readTeam(teamId).members.some((m) => m.isLeader === true)).toBe(true);
  });

  it('exposes maxMembers and leaderRemoved through GET /state', async () => {
    const h = await installFake();
    const created = await h.post('/eteams-api/team', { name: '状态团队', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/leader/remove`, {});
    const state = await h.get('/eteams-api/state');
    const body = json<{ maxMembers: number; teams: { teamId: number; leaderRemoved: boolean }[] }>(
      state.body,
    );
    expect(body.maxMembers).toBe(10);
    expect(body.teams.find((t) => t.teamId === teamId)!.leaderRemoved).toBe(true);
    // archivedTeams 不再随 /state 下发（docs/36 建议 6：归档不入面板）。
    expect(body).not.toHaveProperty('archivedTeams');
  });

  it('caps the team at maxMembers people including the leader（领队也算成员）', async () => {
    const h = await installFake();
    const created = await h.post('/eteams-api/team', { name: '名额团队', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;

    for (let i = 1; i <= 9; i++) {
      const add = await h.post(`/eteams-api/team/${teamId}/member`, { name: `成员-${i}` });
      expect(add.code, add.body).toBe(200);
    }
    const tenth = await h.post(`/eteams-api/team/${teamId}/member`, { name: '成员-10' });
    expect(tenth.code, tenth.body).toBe(400);

    // 移出一人 → 腾出的名额可加（领队在册）。
    const dropOne = await h.post(`/eteams-api/team/${teamId}/member/成员-9/remove`, {});
    expect(dropOne.code, dropOne.body).toBe(200);
    const late = await h.post(`/eteams-api/team/${teamId}/member`, { name: '成员-10' });
    expect(late.code, late.body).toBe(200);
    // v8+ 上限口径：按班底行数计（领队班底行占 1 名额）——领队 + 9 在册成员
    // （成员-9 硬删、成员-10 补位）；主持行取消（v8+）——任务成员表为空。
    const fresh = readTeam(teamId);
    expect(fresh.members).toHaveLength(10);
    expect(fresh.members.find((m) => m.name === '成员-9')).toBeUndefined();
    expect(fresh.members.find((m) => m.name === '成员-10')).toBeDefined();
    expect(fresh.taskMembers).toHaveLength(0);
  });

  it('deletes a team via POST /team/:id/delete and guards active tasks', async () => {
    const h = await installFake();
    const created = await h.post('/eteams-api/team', { name: '待删团队', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;

    const del = await h.post(`/eteams-api/team/${teamId}/delete`, {});
    expect(del.code).toBe(200);
    expect(readTeamSync(stateRoot(), teamId)).toBeUndefined();
    const state = await h.get('/eteams-api/state');
    const body = json<{ teams: { teamId: number }[] }>(state.body);
    expect(body.teams.find((t) => t.teamId === teamId)).toBeUndefined();

    // 再删（或未知 id）→ 404。
    const again = await h.post(`/eteams-api/team/${teamId}/delete`, {});
    expect(again.code).toBe(404);
  });

  it('refuses to delete a team that still has an active task', async () => {
    // suspend 走领队工具（ready 物化 wait 离线可用）；团队按本测试的领队
    // 会话建，工具身份才能对上（建队事件留痕 captainSession === cap-conv）。
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '活跃守卫', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const made = await h.post(`/eteams-api/team/${teamId}/task`, { subject: '在办任务' });
    const taskId = json<{ taskId: number }>(made.body).taskId;
    // ready 不算活跃（新建任务就绪即待派）；挂起物化成 wait 后进入守卫。
    const suspended = await h.call!('eteams_suspend_task', { taskId, note: '先停' });
    expect(suspended.taskId).toBe(taskId);
    const del = await h.post(`/eteams-api/team/${teamId}/delete`, {});
    expect(del.code).toBe(400);
    expect(readTeamSync(stateRoot(), teamId)).toBeDefined();
  });

  it('creates, updates and deletes unclaimed panel tasks（新建即 ready）', async () => {
    const h = await installFake();
    const created = await h.post('/eteams-api/team', {
      name: '小任务团队',
      sessionId: 'sess-panel',
    });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const made = await h.post(`/eteams-api/team/${teamId}/task`, { subject: '待拆任务' });
    const taskId = json<{ taskId: number; status: string }>(made.body).taskId;
    expect(json<{ status: string }>(made.body).status).toBe('ready');

    const upd = await h.post(`/eteams-api/team/${teamId}/task/${taskId}/update`, {
      subject: '改后任务',
      description: '面板改主题',
    });
    expect(upd.code).toBe(200);
    expect(readTeam(teamId).tasks.find((t) => t.id === taskId)!.subject).toBe('改后任务');

    const del = await h.post(`/eteams-api/team/${teamId}/task/${taskId}/delete`, {});
    expect(del.code).toBe(200);
    expect(readTeam(teamId).tasks.some((t) => t.id === taskId)).toBe(false);

    // 缺 subject → 400；未知团队 → 404。
    const blank = await h.post(`/eteams-api/team/${teamId}/task`, {});
    expect(blank.code).toBe(400);
    const missing = await h.post('/eteams-api/team/999/task', { subject: 'x' });
    expect(missing.code).toBe(404);
  });

  it('updates contractMd via the panel task update route（二十八轮 DA41 就地编辑）', async () => {
    // 面板就地编辑把「说明 + 合同」并读成一篇 Markdown 原样发回：description
    // 落严格空串（host 不拒空、不归 null），contractMd 整篇替换且 raw 透传
    // （首尾空白保真，不走 str() 的 trim）；只传 subject 不动合同（undefined
    // 语义回归）；领取后合同冻结，update → 400。
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '合同团队', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Bob', role: 'engineer' });
    const made = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '面板任务',
      description: '旧说明',
    });
    const taskId = json<{ taskId: number }>(made.body).taskId;

    // 1. 并读回写：description 落严格空串，contractMd 整篇替换落库。
    const merged = await h.post(`/eteams-api/team/${teamId}/task/${taskId}/update`, {
      contractMd: '并后全文',
      description: '',
    });
    expect(merged.code).toBe(200);
    const rec = readTeam(teamId).tasks.find((t) => t.id === taskId)!;
    expect(rec.description).toBe('');
    expect(rec.contractMd).toBe('并后全文');

    // 2. 只传 subject 不传 contractMd → 合同保持不变（undefined 语义回归）。
    const subjectOnly = await h.post(`/eteams-api/team/${teamId}/task/${taskId}/update`, {
      subject: '改名不改合同',
    });
    expect(subjectOnly.code).toBe(200);
    const afterSubject = readTeam(teamId).tasks.find((t) => t.id === taskId)!;
    expect(afterSubject.subject).toBe('改名不改合同');
    expect(afterSubject.contractMd).toBe('并后全文');

    // 3. raw 透传：contractMd 首尾空白保真（验证未走 str() 的 trim）。
    const raw = await h.post(`/eteams-api/team/${teamId}/task/${taskId}/update`, {
      contractMd: '  x  ',
    });
    expect(raw.code).toBe(200);
    expect(readTeam(teamId).tasks.find((t) => t.id === taskId)!.contractMd).toBe('  x  ');

    // 4. claim 后合同冻结：update contractMd → 400（沿用既有冻结用例结构）。
    // v6 面板建卡未盖章：派发锚靠心跳回线（客户端开着窗口即心跳，DA38 同款）。
    await h.post('/eteams-api/presence', { sessionId: 'cap-conv' });
    const assigned = await h.call!('eteams_assign_task', { taskId, member: 'Bob' });
    expect(assigned.ok).toBe(true);
    const bob = h.memberAgent!(childIdOf(teamId, 'Bob'));
    const claimed = await h.mem!(bob, 'eteams_claim_task', { taskId });
    expect(claimed.ok).toBe(true);
    const frozen = await h.post(`/eteams-api/team/${teamId}/task/${taskId}/update`, {
      contractMd: '迟到修改',
    });
    expect(frozen.code).toBe(400);
  });

  it('opens a task folder via POST /team/:id/task/:taskId/folder/open（十二轮 DA25）', async () => {
    // 注入假打开器：只记录被打开目录，不真拉 explorer（面板「文件夹路径
    // 可点击」的宿主侧，打开器经 WebSurfaceOptions 注入）。
    const opened: string[] = [];
    const registered: Handler[] = [];
    const captains = new Map<string, { id: string; session: { header: { cwd: string } } }>();
    installWebSurface(surfaceCtx(captains, registered), config, {
      openFolder: (dir) => {
        opened.push(dir);
      },
    });
    const post = async (path: string, body?: unknown) =>
      fire(registered[0]!, 'POST', path, body ?? {});

    const created = await post('/eteams-api/team', {
      name: 'folder-open-team',
      sessionId: 'sess-panel',
    });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    // 团队/任务名取 ASCII：folder 断言要 rmSync 真删掉目录，本机 Windows 对
    // CJK 路径 rmSync 静默不删（环境怪癖，与路由逻辑无关）——CJK 路径已由
    // 其余用例覆盖。
    const made = await post(`/eteams-api/team/${teamId}/task`, { subject: 'folder task' });
    const taskId = json<{ taskId: number }>(made.body).taskId;

    // 建任务即分配目录两列并物化文档树——路由打开的就是它（基址 = 任务自己的
    // work_dir；本用例没带 sessionId，面板退回定位到的工作区）。
    const task = readTeam(teamId).tasks.find((t) => t.id === taskId)!;
    expect(task.workDir).toBe(workspace);
    expect(task.taskDir).toBeDefined();
    const dir = join(task.workDir!, task.taskDir!);
    const openedOk = await post(`/eteams-api/team/${teamId}/task/${taskId}/folder/open`, {});
    expect(openedOk.code, openedOk.body).toBe(200);
    expect(json<{ ok: boolean; dir: string }>(openedOk.body)).toEqual({ ok: true, dir });
    expect(opened).toEqual([dir]);

    // 未知任务 → 404；文件夹被外部清掉 → 400 且不拉打开器。
    const unknownTask = await post(`/eteams-api/team/${teamId}/task/999/folder/open`, {});
    expect(unknownTask.code).toBe(404);
    rmSync(dir, { recursive: true });
    const goneDir = await post(`/eteams-api/team/${teamId}/task/${taskId}/folder/open`, {});
    expect(goneDir.code, goneDir.body).toBe(400);
    expect(opened).toHaveLength(1);
  });

  it('saves the member handbook copy via POST /team/:id/member/:name/persona and projects it in /state', async () => {
    const h = await installFake();
    await h.post('/eteams-api/roster', { name: 'Eve', role: 'engineer', personaMd: '# Eve 初版' });
    const created = await h.post('/eteams-api/team', { name: '手册团队', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const added = await h.post(`/eteams-api/team/${teamId}/member`, {
      name: 'Eve',
      fromRoster: true,
    });
    expect(added.code).toBe(200);

    // 成员详情独立：保存只写成员记录，角色库不受影响。
    const saved = await h.post(`/eteams-api/team/${teamId}/member/Eve/persona`, {
      personaMd: '# Eve 自定义手册',
    });
    expect(saved.code).toBe(200);
    // v7：领队也占班底一行——按名找 Eve 的班底行断言手册副本。
    expect(readTeam(teamId).members.find((m) => m.name === 'Eve')!.persona.personaMd).toBe(
      '# Eve 自定义手册',
    );

    const empty = await h.post(`/eteams-api/team/${teamId}/member/Eve/persona`, {
      personaMd: '  ',
    });
    expect(empty.code).toBe(400);

    const state = await h.get('/eteams-api/state');
    const body = json<{
      teams: { teamId: number; members: { name: string; personaMd: string | null }[] }[];
    }>(state.body);
    const member = body.teams.find((t) => t.teamId === teamId)!.members[0]!;
    expect(member.name).toBe('Eve');
    expect(member.personaMd).toBe('# Eve 自定义手册');
  });

  it('syncs the member handbook back to its roster role via POST /team/:id/member/:name/sync-roster', async () => {
    const h = await installFake();
    await h.post('/eteams-api/roster', {
      name: 'Frank',
      role: 'engineer',
      personaMd: '# Frank 初版',
    });
    const created = await h.post('/eteams-api/team', { name: '同步团队', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const added = await h.post(`/eteams-api/team/${teamId}/member`, {
      name: 'Frank',
      fromRoster: true,
    });
    expect(added.code).toBe(200);

    await h.post(`/eteams-api/team/${teamId}/member/Frank/persona`, { personaMd: '# Frank v2' });
    const synced = await h.post(`/eteams-api/team/${teamId}/member/Frank/sync-roster`, {});
    expect(synced.code).toBe(200);

    const roster = await h.get('/eteams-api/roster');
    const entries = json<{ members: { name: string; personaMd?: string }[] }>(roster.body).members;
    expect(entries.find((m) => m.name === 'Frank')!.personaMd).toBe('# Frank v2');

    // 副本成员同步时无名册条目 → 现建一条。
    const copy = await h.post(`/eteams-api/team/${teamId}/member`, {
      name: 'Frank-2',
      sourceName: 'Frank',
    });
    expect(copy.code).toBe(200);
    const copySync = await h.post(`/eteams-api/team/${teamId}/member/Frank-2/sync-roster`, {
      personaMd: '# Frank-2 副本手册',
    });
    expect(copySync.code).toBe(200);
    const roster2 = await h.get('/eteams-api/roster');
    const entries2 = json<{
      members: { name: string; role: string; personaMd?: string }[];
    }>(roster2.body).members;
    const entry = entries2.find((m) => m.name === 'Frank-2')!;
    expect(entry.role).toBe('engineer');
    expect(entry.personaMd).toBe('# Frank-2 副本手册');
  });

  it('answers 405 for the retired approve route; leader model route is live again', async () => {
    const h = await installFake();
    const created = await h.post('/eteams-api/team', {
      name: '旧路由团队',
      sessionId: 'sess-panel',
    });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const approve = await h.post(`/eteams-api/team/${teamId}/approve`, {});
    expect(approve.code).toBe(405);
    // 领队模型选择恢复（用户迭代 2026-09-04）：POST /team/<id>/leader/model
    // 200 落库，快照 captain 带回路线；空 model 重置为会话默认。v9：provider
    // 整组入档并从快照带回（同 id 模型跨提供方消歧，用户迭代 2026-09-08）。
    const leaderModel = await h.post(`/eteams-api/team/${teamId}/leader/model`, {
      provider: 'tr-test',
      model: 'z-ai/glm-5.3-free',
      reasoningEffort: 'low',
    });
    expect(leaderModel.code).toBe(200);
    const state = await h.get('/eteams-api/state');
    const team = json<{
      teams: {
        teamId: number;
        captain: {
          model?: string;
          provider?: string | null;
          reasoningEffort?: string | null;
        };
      }[];
    }>(state.body).teams.find((t) => t.teamId === teamId)!;
    expect(team.captain.model).toBe('z-ai/glm-5.3-free');
    expect(team.captain.provider).toBe('tr-test');
    expect(team.captain.reasoningEffort).toBe('low');
    const reset = await h.post(`/eteams-api/team/${teamId}/leader/model`, {});
    expect(reset.code).toBe(200);
    const state2 = await h.get('/eteams-api/state');
    const team2 = json<{
      teams: { teamId: number; captain: { model?: string; provider?: string | null } }[];
    }>(state2.body).teams.find((t) => t.teamId === teamId)!;
    expect(team2.captain.model ?? '').toBe('');
    // 重置后 provider 一并清空（路线整体回会话默认）。
    expect(team2.captain.provider ?? null).toBeNull();
  });

  it('collects the shared global state root once (全局单库不重复出队)', async () => {
    // 全局单库（stateDir 绝对路径）：注册表里多个工作区解析到同一个状态根，
    // /state 每个团队只出一条；相对 stateDir 的其他根照常各自收集。
    const registered: Handler[] = [];
    const captains = new Map<string, { id: string; session: { header: { cwd: string } } }>();
    const globalCfg = { ...config, stateDir: stateRoot() } as ETeamsResolvedConfig;
    const ctx = surfaceCtx(captains, registered, [
      { path: workspace, title: 'ws-a' },
      { path: workspace, title: 'ws-b' },
      { path: join(workspace, 'other'), title: 'ws-c' },
    ]);
    installWebSurface(ctx, globalCfg);
    const handler = registered[0]!;
    const created = await fire(handler, 'POST', '/eteams-api/team', {
      name: '单库团队',
      sessionId: 'sess-panel',
    });
    expect(created.code).toBe(200);
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const state = await fire(handler, 'GET', '/eteams-api/state');
    const teams = json<{ teams: { teamId: number }[] }>(state.body).teams;
    expect(teams.filter((t) => t.teamId === teamId)).toHaveLength(1);
  });
});

describe('conversation task workflow (docs/26)', () => {
  it('binds, locks, unlocks on team deletion, and clears via /session-team (对话固定 1 团队)', async () => {
    const h = await installFull();
    const createdA = await h.post('/eteams-api/team', {
      name: '绑定团队甲',
      sessionId: 'cap-conv',
    });
    const teamA = json<{ teamId: number }>(createdA.body).teamId;
    // 乙队换一个领队会话建（createTeam：一个领队同时只带一个团队）。
    const createdB = await h.post('/eteams-api/team', {
      name: '绑定团队乙',
      sessionId: 'cap-second',
    });
    const teamB = json<{ teamId: number }>(createdB.body).teamId;

    // 绑定 + GET 对账回读（客户端挂载的真相源）。
    const bind = await h.post('/eteams-api/session-team', {
      sessionId: 'sess-a',
      teamId: String(teamA),
    });
    expect(bind.code).toBe(200);
    const readback = await h.get('/eteams-api/session-team?sessionId=sess-a');
    expect(readback.code).toBe(200);
    expect(json<{ empty?: boolean; teamId?: string; name?: string }>(readback.body)).toEqual({
      teamId: String(teamA),
      name: '绑定团队甲',
    });
    // GET 未绑定会话 → empty。
    const emptyRead = await h.get('/eteams-api/session-team?sessionId=sess-none');
    expect(json<{ empty?: boolean }>(emptyRead.body)).toEqual({ empty: true });

    // 同队重绑放行（刷新名字/时间，不 409）。
    const rebind = await h.post('/eteams-api/session-team', {
      sessionId: 'sess-a',
      teamId: String(teamA),
    });
    expect(rebind.code).toBe(200);

    // 对话未开始（无活 agent / 无 turn/start）→ 可改选团队（用户迭代
    // 2026-09-13「开始对话后才不能修改」）：换绑乙队放行。
    const blankSwitch = await h.post('/eteams-api/session-team', {
      sessionId: 'sess-a',
      teamId: String(teamB),
    });
    expect(blankSwitch.code).toBe(200);
    const readbackB = await h.get('/eteams-api/session-team?sessionId=sess-a');
    expect(json<{ teamId?: string }>(readbackB.body).teamId).toBe(String(teamB));

    // 对话已开始（会话事件出现 turn/start）→ 锁定：换绑甲队 409
    // （1 对话 1 团队）。
    h.captains.set('sess-a', {
      id: 'sess-a',
      session: { header: { cwd: workspace }, events: [{ type: 'turn/start' }] },
    } as never);
    const locked = await h.post('/eteams-api/session-team', {
      sessionId: 'sess-a',
      teamId: String(teamA),
    });
    expect(locked.code).toBe(409);
    expect(locked.body).toContain('绑定团队乙');
    // GET 仍是乙队。
    const stillB = await h.get('/eteams-api/session-team?sessionId=sess-a');
    expect(json<{ teamId?: string }>(stillB.body).teamId).toBe(String(teamB));

    // 逃生口：删除乙队 → 绑定随之清除 → 重绑甲队放行。
    const del = await h.post(`/eteams-api/team/${teamB}/delete`, {});
    expect(del.code).toBe(200);
    const freed = await h.post('/eteams-api/session-team', {
      sessionId: 'sess-a',
      teamId: String(teamA),
    });
    expect(freed.code).toBe(200);
    const nowA = await h.get('/eteams-api/session-team?sessionId=sess-a');
    expect(json<{ teamId?: string; name?: string }>(nowA.body)).toEqual({
      teamId: String(teamA),
      name: '绑定团队甲',
    });

    // 过期选择（团队已删）→ 404，不是静默绑上。
    const bad = await h.post('/eteams-api/session-team', { sessionId: 'sess-b', teamId: 'ghost' });
    expect(bad.code).toBe(404);
    const blank = await h.post('/eteams-api/session-team', { sessionId: 'sess-b', teamId: '' });
    expect(blank.code).toBe(400);
    const clear = await h.post('/eteams-api/session-team/clear', { sessionId: 'sess-a' });
    expect(clear.code).toBe(200);
    const clearBlank = await h.post('/eteams-api/session-team/clear', {});
    expect(clearBlank.code).toBe(400);
  });

  it('runs the docs/26 loop: 提交 → 拆解 → 指派 → 接取 → 交付 → 主任务自动收口', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '对话任务', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Alice', role: 'researcher' });
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Bob', role: 'engineer' });

    // 1. 对话提交：立即生成任务单（group 容器）+ 专属文件夹；先落「创建中」
    //    （2026-09-12：面板显示「创建中」动画/状态且不可点进），拆解完后由
    //    eteams_submit_task(taskId) 收口转「待开始」。
    const submitted = await h.callRaw!('eteams_submit_task', {
      subject: '官网迁移',
      description: '把官网迁到新域名',
      questionnaire: ['交付形式？', '验收偏好？'],
    });
    expect(submitted.ok).toBe(true);
    expect(submitted.status).toBe('creating');
    let team = readTeam(teamId);
    const group = team.tasks[0]!;
    expect(group.parentId).toBeNull();
    expect(submitted.taskId).toBe(group.id);
    expect(submitted.folder).toBe(group.taskDir);
    // 用户 2026-09-15 扁平化：一个主任务一个目录 —— 留言板 + 每任务一份纪要 +
    // 计划/、文档/ 两个夹；contract.md / notes.md 已并入纪要。
    expect(existsSync(join(group.workDir!, group.taskDir!, minutesFileName(group)))).toBe(true);
    expect(existsSync(join(group.workDir!, group.taskDir!, '计划'))).toBe(true);
    expect(existsSync(join(group.workDir!, group.taskDir!, '文档'))).toBe(true);
    expect(existsSync(join(group.workDir!, group.taskDir!, '留言板.md'))).toBe(true);
    expect(existsSync(join(group.workDir!, group.taskDir!, 'contract.md'))).toBe(false);
    expect(existsSync(join(group.workDir!, group.taskDir!, 'notes.md'))).toBe(false);

    // 1b. 收口：拆解完成后把「创建中」转「待开始」（收口前 startGroupTask 拒绝）。
    // 收口闸要求主任务下至少一个带「## 验收标准」的小任务——先建占位过闸，
    // 收口后删掉（本用例自建小任务，占位只为过闸）。
    const gateStub = await h.callRaw!('eteams_create_task', {
      subject: '收口占位小任务',
      parentTaskId: group.id,
      contractMd: '## 验收标准\n1. 占位',
    });
    const finalized = await h.callRaw!('eteams_submit_task', {
      taskId: group.id,
      subject: '官网迁移',
      description: '把官网迁到新域名',
      skipQuestionnaire: true,
    });
    expect(finalized.status).toBe('ready');
    await h.callRaw!('eteams_delete_task', { taskId: gateStub.taskId });

    // 2. 面板拆解：parentTaskId（数字串）挂任务单；chain 站点 = 成员槽。
    const sub = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '梳理页面清单',
      parentTaskId: String(group.id),
      chain: [
        { member: 'Alice', stageBrief: '调研' },
        { member: 'Bob', stageBrief: '整理' },
      ],
    });
    expect(sub.code).toBe(200);
    const subId = json<{ taskId: number; status: string }>(sub.body).taskId;
    expect(json<{ status: string }>(sub.body).status).toBe('ready');
    team = readTeam(teamId);
    const subRec = team.tasks.find((t) => t.id === subId)!;
    expect(subRec.parentId).toBe(group.id);
    // 小任务不再有自己的目录与两列（共用主任务目录）。
    expect(subRec.workDir).toBeUndefined();
    expect(subRec.taskDir).toBeUndefined();
    expect(existsSync(join(group.workDir!, group.taskDir!, minutesFileName(subRec)))).toBe(true);

    // 3. 面板修改（主题 + 成员槽）与删除。
    const upd = await h.post(`/eteams-api/team/${teamId}/task/${subId}/update`, {
      subject: '梳理新旧页面映射',
      chain: [{ member: 'Bob', stageBrief: 'Bob 先行' }],
    });
    expect(upd.code).toBe(200);
    team = readTeam(teamId);
    expect(team.tasks.find((t) => t.id === subId)!.subject).toBe('梳理新旧页面映射');
    expect(team.tasks.find((t) => t.id === subId)!.chain[0]!.member).toBe('Bob');

    const temp = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '临时小任务',
      parentTaskId: String(group.id),
    });
    const tempId = json<{ taskId: number }>(temp.body).taskId;
    const del = await h.post(`/eteams-api/team/${teamId}/task/${tempId}/delete`, {});
    expect(del.code).toBe(200);
    expect(readTeam(teamId).tasks.some((t) => t.id === tempId)).toBe(false);

    // 4. 执行：指派链首 Bob → 成员起会话 → 接取 → 合同冻结（改删 400）。
    const assigned = await h.call!('eteams_assign_task', { taskId: subId, member: 'Bob' });
    expect(assigned.ok).toBe(true);
    const bob = h.memberAgent!(childIdOf(teamId, 'Bob'));
    const claimed = await h.mem!(bob, 'eteams_claim_task', { taskId: subId });
    expect(claimed.ok).toBe(true);
    expect(readTeam(teamId).tasks.find((t) => t.id === subId)!.status).toBe('start');
    const frozenUpd = await h.post(`/eteams-api/team/${teamId}/task/${subId}/update`, {
      subject: '迟到修改',
    });
    expect(frozenUpd.code).toBe(400);
    const frozenDel = await h.post(`/eteams-api/team/${teamId}/task/${subId}/delete`, {});
    expect(frozenDel.code).toBe(400);

    // 5. 末站交付 → 主任务自动收口（joined outcome）。
    const done = await h.mem!(bob, 'eteams_complete_task', {
      taskId: subId,
      attemptId: claimed.attemptId,
      token: claimed.token,
      output: '新旧页面映射表完成',
    });
    expect(done.done).toBe(true);
    team = readTeam(teamId);
    expect(team.tasks.find((t) => t.id === group.id)!.status).toBe('completed');
    // 产出不落列（docs/35 §5#10）——TaskRecord 无 outcome 字段；组收口的
    // 聚合产出在 task.completed 事件里，由快照投影（见下方 groupView）。

    // 6. 快照投影：kind/parentId/folder；进度只统计真实小任务。
    const snap = teamSnapshot(team, workspace, config);
    expect(snap.progress).toEqual({ completed: 1, total: 1, cancelled: 0, active: 0 });
    const views = snap.tasks as Array<{
      taskId: number;
      kind: string;
      parentId: number | null;
      folder: string;
      status: string;
    }>;
    const subView = views.find((t) => t.taskId === subId)!;
    const groupView = views.find((t) => t.taskId === group.id)!;
    expect(subView.kind).toBe('task');
    expect(subView.parentId).toBe(group.id);
    // 一个主任务一个目录：小任务快照的 folder 也指向主任务目录（不再有 sub/）。
    expect(subView.folder).toBe(groupView.folder);
    expect(subView.folder).not.toContain('sub/');
    expect(groupView.kind).toBe('group');
    expect(groupView.status).toBe('completed');
    expect(groupView.outcome).toContain('映射表完成');
    expect(groupView.folder).not.toContain('sub/');

    // 7. 任务 track 读路由：合同 + 尝试 + 产出反查。
    const track = await h.get(`/eteams-api/team/${teamId}/task/${subId}/track`);
    expect(track.code).toBe(200);
    const trackBody = json<{
      taskId: number;
      attempts: { status: string }[];
      /** 产出反查（docs/35 §5#10）：attempts 最新成功行的 output 正文串。 */
      outcome: string | null;
      contract: { subject: string; chain: { member: string }[] };
    }>(track.body);
    expect(trackBody.taskId).toBe(subId);
    expect(trackBody.attempts).toHaveLength(1);
    expect(trackBody.outcome).toContain('映射表完成');
    expect(trackBody.contract.subject).toBe('梳理新旧页面映射');
    expect(trackBody.contract.chain.map((s) => s.member)).toEqual(['Bob']);
  });

  it('accepts numeric parentTaskId and rewrites dependencies via the update route (七轮 DA20)', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '顺序团队', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const group = (
      (await h.call!('eteams_submit_task', { subject: '主任务' })) as { taskId: number }
    ).taskId;

    // 七轮修复回归锁：客户端（api.ts）发 JSON number，此前路由 str() 只收
    // 字符串 → parentTaskId 被静默丢弃 → 小任务落到顶层（挂靠失败、主任务
    // 计数不变）。number 与数字串都要挂上。
    const first = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '第一步',
      parentTaskId: group,
    });
    expect(first.code).toBe(200);
    const firstId = json<{ taskId: number }>(first.body).taskId;
    const second = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '第二步',
      parentTaskId: group,
    });
    const secondId = json<{ taskId: number }>(second.body).taskId;
    let team = readTeam(teamId);
    expect(team.tasks.find((t) => t.id === firstId)!.parentId).toBe(group);
    expect(team.tasks.find((t) => t.id === secondId)!.parentId).toBe(group);

    // 执行顺序通道：update 路由透传 dependencies（整体替换 + wouldCycle 校验）。
    const dep = await h.post(`/eteams-api/team/${teamId}/task/${secondId}/update`, {
      dependencies: [firstId],
    });
    expect(dep.code).toBe(200);
    team = readTeam(teamId);
    expect(team.tasks.find((t) => t.id === secondId)!.dependencies).toEqual([firstId]);

    // 畸形依赖载荷与既有 panel 通道同口径：整包视为缺省（不改字段）。
    const badDeps = await h.post(`/eteams-api/team/${teamId}/task/${secondId}/update`, {
      dependencies: ['第一步', {}],
    });
    expect(badDeps.code).toBe(200);
    expect(readTeam(teamId).tasks.find((t) => t.id === secondId)!.dependencies).toEqual([firstId]);
  });

  it('starts a ready chain task from the panel via POST /task/:taskId/start（二十四轮 DA37）', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '开始团队', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Alice', role: 'researcher' });
    const group = (
      (await h.call!('eteams_submit_task', { subject: '主任务' })) as { taskId: number }
    ).taskId;
    const sub = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '接力小任务',
      parentTaskId: String(group),
      chain: [{ member: 'Alice', stageBrief: '先做' }],
    });
    const subId = json<{ taskId: number }>(sub.body).taskId;
    const bare = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '没选成员的小任务',
      parentTaskId: String(group),
    });
    const bareId = json<{ taskId: number }>(bare.body).taskId;

    // 本用例走无领队宿主直派路径（有领队走领队的路径见下方 leaderful 用例）。
    await h.post(`/eteams-api/team/${teamId}/leader/remove`, {});

    // 空链：开始被「需要选择成员」闸住（用户拍板原话——客户端对空链卡不
    // 渲染按钮，此处兜底）。
    const bareStart = await h.post(`/eteams-api/team/${teamId}/task/${bareId}/start`, {});
    expect(bareStart.code).toBe(400);
    expect(json<{ error: string }>(bareStart.body).error).toBe('需要选择成员');

    // 有链：派发链首 Alice（用户迭代 2026-09-11：派发不改状态，仍是 ready
    // 待成员接取；首尝试 stage，成员起会话）。
    const started = await h.post(`/eteams-api/team/${teamId}/task/${subId}/start`, {});
    expect(started.code).toBe(200);
    const subRec = readTeam(teamId).tasks.find((t) => t.id === subId)!;
    expect(subRec.status).toBe('ready');
    expect(subRec.attempts).toHaveLength(1);
    expect(subRec.attempts[0]!.member).toBe('Alice');
    expect(childIdOf(teamId, 'Alice')).not.toBe('');

    // 已派发待接取再点开始（用户迭代 2026-09-11 回归修复）：不再被防重复派发
    // 闸拒成 400——幂等重发指派信、不新开 attempt、不改状态（死按钮复活；
    // 成员回合被中断留下的僵尸指派靠这条解开）。
    const again = await h.post(`/eteams-api/team/${teamId}/task/${subId}/start`, {});
    expect(again.code).toBe(200);
    const resent = readTeam(teamId).tasks.find((t) => t.id === subId)!;
    expect(resent.status).toBe('ready');
    expect(resent.attempts).toHaveLength(1);
    expect(resent.attempts[0]!.status).toBe('pending_accept');

    // 未知任务 404。
    const missing = await h.post(`/eteams-api/team/${teamId}/task/99999/start`, {});
    expect(missing.code).toBe(404);
  });

  it('pauses a running group from the panel via POST /task/:taskId/pause（2026-09-11）', async () => {
    // 用户迭代：主任务开始后按钮变「暂停」——挂起在跑小任务 + 容器，再点
    // 「开始」从原站续跑。
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '暂停团队', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Alice', role: 'researcher' });
    const group = (
      (await h.call!('eteams_submit_task', { subject: '主任务' })) as { taskId: number }
    ).taskId;
    const sub = json<{ taskId: number }>(
      (
        await h.post(`/eteams-api/team/${teamId}/task`, {
          subject: '接力小任务',
          parentTaskId: String(group),
          chain: [{ member: 'Alice', stageBrief: '先做' }],
        })
      ).body,
    ).taskId;

    // 本用例走无领队宿主直派路径（有领队走领队的路径见下方 leaderful 用例）。
    await h.post(`/eteams-api/team/${teamId}/leader/remove`, {});

    const started = await h.post(`/eteams-api/team/${teamId}/task/${group}/start`, {});
    expect(started.code).toBe(200);
    // 领取小任务 → 执行中（容器随整体开始 → start）。
    const claim = await h.mem!(h.memberAgent!(childIdOf(teamId, 'Alice')), 'eteams_claim_task', {
      taskId: sub,
    });
    expect(claim.token).not.toBe('');
    expect(readTeam(teamId).tasks.find((t) => t.id === group)!.status).toBe('start');

    // 暂停：小任务 + 容器一起 paused。
    const paused = await h.post(`/eteams-api/team/${teamId}/task/${group}/pause`, {});
    expect(paused.code).toBe(200);
    const pausedTeam = readTeam(teamId);
    expect(pausedTeam.tasks.find((t) => t.id === sub)!.status).toBe('paused');
    expect(pausedTeam.tasks.find((t) => t.id === group)!.status).toBe('paused');

    // 再开始：从原站续跑（新 attempt 待接取），容器回 start。
    const again = await h.post(`/eteams-api/team/${teamId}/task/${group}/start`, {});
    expect(again.code).toBe(200);
    const backTeam = readTeam(teamId);
    expect(backTeam.tasks.find((t) => t.id === sub)!.status).toBe('ready');
    expect(backTeam.tasks.find((t) => t.id === sub)!.attempts.at(-1)!.status).toBe(
      'pending_accept',
    );
    expect(backTeam.tasks.find((t) => t.id === group)!.status).toBe('start');

    // 未知任务 404。
    const missing = await h.post(`/eteams-api/team/${teamId}/task/99999/pause`, {});
    expect(missing.code).toBe(404);
  });

  it('容器没有在办小任务时快照回落「待开始」（读取侧兜底，2026-09-11）', async () => {
    // 用户迭代「没有正在执行的小任务，主任务应该也是待开始状态，没有同步过来」：
    // 容器 start 只应由「有在办小任务」支撑；历史构建留下的陈旧 start 在展示层
    // 回落 ready，避免面板显示执行中却没有任何小任务在跑。
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '容器兜底', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Alice', role: 'researcher' });
    const group = (
      (await h.call!('eteams_submit_task', { subject: '主任务' })) as { taskId: number }
    ).taskId;
    const sub = json<{ taskId: number }>(
      (
        await h.post(`/eteams-api/team/${teamId}/task`, {
          subject: '小任务',
          parentTaskId: String(group),
          chain: [{ member: 'Alice', stageBrief: '做' }],
        })
      ).body,
    ).taskId;

    const statusOf = (id: number): string =>
      (teamSnapshot(readTeam(teamId), workspace, config).tasks as Array<{
        taskId: number;
        status: string;
      }>).find((t) => t.taskId === id)!.status;

    // 直接落一个陈旧 start（模拟历史构建中断后未同步的残留）。
    getDb(stateRoot())
      .prepare("UPDATE task SET status = 'start' WHERE task_id = ?")
      .run(group);
    expect(statusOf(group)).toBe('ready');

    // 陈旧 start + 小任务已挂起（历史中断未回写的另一种残留）→ 快照报 paused，
    // 不漏「小任务挂起」（用户迭代「小任务挂起之后，主任务也同步挂起」）。
    getDb(stateRoot())
      .prepare("UPDATE task SET status = 'paused' WHERE task_id = ?")
      .run(sub);
    expect(statusOf(group)).toBe('paused');
    getDb(stateRoot())
      .prepare("UPDATE task SET status = 'ready' WHERE task_id = ?")
      .run(sub);

    // 本用例走无领队宿主直派路径（有领队走领队的路径见下方 leaderful 用例）。
    await h.post(`/eteams-api/team/${teamId}/leader/remove`, {});

    // 有小任务在办（待接取）→ 快照如实报 start。
    await h.post(`/eteams-api/team/${teamId}/task/${group}/start`, {});
    expect(statusOf(sub)).toBe('ready');
    expect(statusOf(group)).toBe('start');
  });

  it('keeps one main task per conversation: second submit rejected even after the container completed（用户迭代 2026-09-12）', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', {
      name: '单一主任务团队',
      sessionId: 'cap-conv',
    });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const group = (
      (await h.call!('eteams_submit_task', { subject: '主任务' })) as { taskId: number }
    ).taskId;
    // 容器完成只是「当前小任务都完成」的可回退标识——仍是本对话的主任务
    // （completed 不再释放锚点，用户原话「主任务的完成只是暂时的」）。
    getDb(stateRoot())
      .prepare('UPDATE task SET status = ? WHERE task_id = ?')
      .run('completed', group);

    // 同一对话再提交主任务 → 硬兜底拒绝，指引在主任务下增补小任务。
    await expect(h.call!('eteams_submit_task', { subject: '第二个主任务' })).rejects.toThrow(
      /一个对话只有一个主任务/,
    );
    // 完成也不新开：仍只有这一个主任务容器。
    expect(readTeam(teamId).tasks.filter((t) => t.parentId === null)).toHaveLength(1);
  });

  it('starts a group task: dispatches ready chained subs, skips the rest（二十五轮 DA38）', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', {
      name: '整体开始团队',
      sessionId: 'cap-conv',
    });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Alice', role: 'researcher' });
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Bob', role: 'engineer' });
    const group = (
      (await h.call!('eteams_submit_task', { subject: '主任务' })) as { taskId: number }
    ).taskId;
    const chained = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '接力小任务',
      parentTaskId: String(group),
      chain: [{ member: 'Alice', stageBrief: '先做' }],
    });
    const chainedId = json<{ taskId: number }>(chained.body).taskId;
    const bare = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '没选成员的小任务',
      parentTaskId: String(group),
    });
    const bareId = json<{ taskId: number }>(bare.body).taskId;

    // 本用例走无领队宿主直派路径（有领队走领队的路径见下方 leaderful 用例）。
    await h.post(`/eteams-api/team/${teamId}/leader/remove`, {});

    // 主任务「开始」= 链式接力发棒（二十七轮 DA40 收窄）：本例仅一张有链卡，
    // 派发成功（started=1）与二十五轮断言同值；无链的按卡跳过（原因
    // 「需要选择成员」——用户拍板原话）。用户迭代 2026-09-11：容器
    // ready→start，小任务派发后仍 ready（待成员接取）。
    const started = await h.post(`/eteams-api/team/${teamId}/task/${group}/start`, {});
    expect(started.code).toBe(200);
    const body = json<{
      ok: boolean;
      started: number;
      skipped: { taskId: number; subject: string; reason: string }[];
    }>(started.body);
    expect(body.ok).toBe(true);
    expect(body.started).toBe(1);
    expect(body.skipped).toEqual([
      { taskId: bareId, subject: '没选成员的小任务', reason: '需要选择成员' },
    ]);
    const team = readTeam(teamId);
    expect(team.tasks.find((t) => t.id === chainedId)!.status).toBe('ready');
    expect(team.tasks.find((t) => t.id === chainedId)!.attempts[0]!.member).toBe('Alice');
    // 大任务整体开始：容器 ready→start（用户迭代 2026-09-11 大任务状态集）。
    expect(team.tasks.find((t) => t.id === group)!.status).toBe('start');
    // 主会话快照（task.main_session_id，v5 落列 v6 改名）：面板建任务时客户端
    // 透传的主会话 ID（cap-conv）随行落库。
    expect(team.tasks.find((t) => t.id === group)!.mainSessionId).toBe('cap-conv');
    expect(childIdOf(teamId, 'Alice')).not.toBe('');

    // 全 ready 卡都无链：整体开始只回跳过清单（started=0，原因逐卡透出）。
    // 一个团队可以有多个主任务，但只能来自多个对话（每个对话各自锚定一个，
    // 用户迭代 2026-09-12）——绑定第二个对话 cap-conv-2 到同队再建第二个任务单。
    setSessionTeam('cap-conv-2', {
      teamId: String(teamId),
      name: '整体开始团队',
      boundAt: Date.now(),
    });
    const group2 = (
      (await h.call!(
        'eteams_submit_task',
        { subject: '主任务二' },
        h.agentFor!('cap-conv-2'),
      )) as { taskId: number }
    ).taskId;
    await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '也没选成员',
      parentTaskId: String(group2),
    });
    const started2 = await h.post(`/eteams-api/team/${teamId}/task/${group2}/start`, {});
    expect(started2.code).toBe(200);
    const body2 = json<{ started: number; skipped: { reason: string }[] }>(started2.body);
    expect(body2.started).toBe(0);
    expect(body2.skipped).toHaveLength(1);
    expect(body2.skipped[0]!.reason).toBe('需要选择成员');
  });

  it('starts a group task: relay queue, dependency skip, single-task path（用户迭代 2026-09-11：draft/wait 并入 ready）', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', {
      name: '接力跳过团队',
      sessionId: 'cap-conv',
    });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Alice', role: 'researcher' });
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Bob', role: 'engineer' });
    const group = (
      (await h.call!('eteams_submit_task', { subject: '主任务' })) as { taskId: number }
    ).taskId;
    const first = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '接力小任务',
      parentTaskId: String(group),
      chain: [{ member: 'Alice', stageBrief: '先做' }],
    });
    const firstId = json<{ taskId: number }>(first.body).taskId;
    const second = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '后棒小任务',
      parentTaskId: String(group),
      dependencies: [String(firstId)],
      chain: [{ member: 'Bob', stageBrief: '接棒' }],
    });
    const secondId = json<{ taskId: number }>(second.body).taskId;
    const bare = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '没选成员的小任务',
      parentTaskId: String(group),
    });
    const bareId = json<{ taskId: number }>(bare.body).taskId;

    // 本用例走无领队宿主直派路径（有领队走领队的路径见下方 leaderful 用例）。
    await h.post(`/eteams-api/team/${teamId}/leader/remove`, {});

    // 整体开始：首棒派发（ready 待接取——用户迭代 2026-09-11 派发不改状态）；
    // 无链卡「需要选择成员」；后棒「等待链式接力」——跳过原因如实透出。
    const started = await h.post(`/eteams-api/team/${teamId}/task/${group}/start`, {});
    expect(started.code).toBe(200);
    const body = json<{
      ok: boolean;
      started: number;
      skipped: { taskId: number; subject: string; reason: string }[];
    }>(started.body);
    expect(body.ok).toBe(true);
    expect(body.started).toBe(1);
    expect(body.skipped).toEqual([
      {
        taskId: secondId,
        subject: '后棒小任务',
        reason: '等待链式接力（前一小任务完成后自动开始）',
      },
      { taskId: bareId, subject: '没选成员的小任务', reason: '需要选择成员' },
    ]);
    const team = readTeam(teamId);
    expect(team.tasks.find((t) => t.id === firstId)!.status).toBe('ready');
    expect(team.tasks.find((t) => t.id === firstId)!.attempts[0]!.member).toBe('Alice');
    expect(team.tasks.find((t) => t.id === secondId)!.status).toBe('ready');

    // 单任务（非组）路径同理：ready 直接开始 = 派发（attempt 记 Bob）。
    const single = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '单杆小任务',
      chain: [{ member: 'Bob', stageBrief: '直接做' }],
    });
    const singleId = json<{ taskId: number }>(single.body).taskId;
    const singleStart = await h.post(`/eteams-api/team/${teamId}/task/${singleId}/start`, {});
    expect(singleStart.code).toBe(200);
    const teamAfterSingle = readTeam(teamId);
    expect(teamAfterSingle.tasks.find((t) => t.id === singleId)!.status).toBe('ready');
    expect(teamAfterSingle.tasks.find((t) => t.id === singleId)!.attempts[0]!.member).toBe('Bob');

    // 依赖未完成的小任务照派（用户 2026-09-14「闸门拦住去掉吧，不然任意调度
    // 时会出问题」）：依赖只作排布提示，不再拦整体开始的发棒——本卡是组内唯一
    // ready 卡，直接起棒。第二个任务单来自第二个对话（cap-conv-3，各自锚定一个
    // 主任务；同队多任务必须多对话，用户迭代 2026-09-12）。
    setSessionTeam('cap-conv-3', {
      teamId: String(teamId),
      name: '接力跳过团队',
      boundAt: Date.now(),
    });
    const group3 = (
      (await h.call!(
        'eteams_submit_task',
        { subject: '主任务三' },
        h.agentFor!('cap-conv-3'),
      )) as { taskId: number }
    ).taskId;
    const blocked = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '卡在依赖的小任务',
      parentTaskId: String(group3),
      dependencies: [String(singleId)],
      chain: [{ member: 'Bob', stageBrief: '等着' }],
    });
    const blockedId = json<{ taskId: number }>(blocked.body).taskId;
    const started3 = await h.post(`/eteams-api/team/${teamId}/task/${group3}/start`, {});
    expect(started3.code).toBe(200);
    const body3 = json<{ started: number; skipped: { taskId: number; reason: string }[] }>(
      started3.body,
    );
    expect(body3.started).toBe(1);
    expect(body3.skipped).toHaveLength(0);
    expect(readTeam(teamId).tasks.find((t) => t.id === blockedId)!.attempts[0]!.member).toBe('Bob');
  });

  it('starts a group task by cold-resuming the recorded main session（三十七轮 DA50）', async () => {
    const h = await installFull();
    // 建队/建任务都由领队会话（cap-conv 在册）驱动；随后把 cap-conv 从注册
    // 表删掉模拟「主会话窗口已关」，也没有 presence 心跳——两级锚都落空，
    // 只剩冷恢复一条路。
    const created = await h.post('/eteams-api/team', {
      name: '冷恢复团队',
      sessionId: 'cap-conv',
    });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Alice', role: 'researcher' });
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Bob', role: 'engineer' });
    const group = (
      (await h.call!('eteams_submit_task', { subject: '主任务' })) as { taskId: number }
    ).taskId;
    const sub = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '接力小任务',
      parentTaskId: String(group),
      chain: [{ member: 'Alice', stageBrief: '先做' }],
    });
    const subId = json<{ taskId: number }>(sub.body).taskId;

    // fake resume：按持久化记录复活会话并进注册表（复活后 agents.get 命中，
    // 模拟 AgentRegistry.resume 的真实语义；句柄 dispose 不被调用）。
    h.captains.delete('cap-conv');
    const resumed: string[] = [];
    const agents = h.agents as {
      resume?: (options: { resumeSessionId: string }) => Promise<{ agent: unknown }>;
    };
    agents.resume = async (options) => {
      resumed.push(options.resumeSessionId);
      const revived = { id: options.resumeSessionId, session: { header: { cwd: workspace } } };
      h.captains.set(options.resumeSessionId, revived as never);
      return { agent: revived };
    };

    // 本用例走无领队宿主直派路径（有领队走领队的路径见下方 leaderful 用例）。
    await h.post(`/eteams-api/team/${teamId}/leader/remove`, {});

    const started = await h.post(`/eteams-api/team/${teamId}/task/${group}/start`, {});
    expect(started.code).toBe(200);
    const body = json<{ started: number; skipped: unknown[] }>(started.body);
    expect(body.started).toBe(1);
    expect(body.skipped).toEqual([]);
    const team = readTeam(teamId);
    expect(team.tasks.find((t) => t.id === subId)!.status).toBe('ready');
    expect(team.tasks.find((t) => t.id === subId)!.attempts[0]!.member).toBe('Alice');
    // 恢复的就是任务行快照派生的会话 ID（v6 锚点在 task 行）；补章把派发
    // 锚点登记到本任务行（快照语义：登记后不再改写）。
    expect(resumed).toEqual(['cap-conv']);
    expect(team.tasks.find((t) => t.id === subId)!.mainSessionId).toBe('cap-conv');

    // 复活一次常驻：后续派发走 agents.get 命中，不再重复 resume。
    const single = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '单杆任务',
      chain: [{ member: 'Bob', stageBrief: '再做一单' }],
    });
    const singleId = json<{ taskId: number }>(single.body).taskId;
    const singleStart = await h.post(`/eteams-api/team/${teamId}/task/${singleId}/start`, {});
    expect(singleStart.code).toBe(200);
    const teamAfterSingle = readTeam(teamId);
    // 用户迭代 2026-09-11：派发不改状态，仍是 ready（待接取）。
    expect(teamAfterSingle.tasks.find((t) => t.id === singleId)!.status).toBe('ready');
    expect(resumed).toEqual(['cap-conv']);
  });

  it('falls back to the anchor-unavailable error when cold-resume fails（三十七轮 DA50）', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', {
      name: '恢复失败团队',
      sessionId: 'cap-conv',
    });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Alice', role: 'researcher' });
    const group = (
      (await h.call!('eteams_submit_task', { subject: '主任务' })) as { taskId: number }
    ).taskId;
    const sub = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '接力小任务',
      parentTaskId: String(group),
      chain: [{ member: 'Alice', stageBrief: '先做' }],
    });
    const subId = json<{ taskId: number }>(sub.body).taskId;

    // resume 抛错（会话记录被回收/持久层缺失）→ 落回锚点不可用报错。
    h.captains.delete('cap-conv');
    const agents = h.agents as { resume?: () => Promise<never> };
    agents.resume = async () => {
      throw new Error('session record reclaimed');
    };

    // 本用例走无领队宿主直派路径（有领队走领队的路径见下方 leaderful 用例）。
    await h.post(`/eteams-api/team/${teamId}/leader/remove`, {});

    const started = await h.post(`/eteams-api/team/${teamId}/task/${group}/start`, {});
    expect(started.code).toBe(200);
    const body = json<{ started: number; skipped: { reason: string }[] }>(started.body);
    expect(body.started).toBe(0);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0]!.reason).toContain('尚未起会话');
    expect(body.skipped[0]!.reason).toContain('无法冷恢复');
    // 恢复失败不落半步：卡保持 ready，任务行快照保持未登记（v6 快照在 task 行）。
    const team = readTeam(teamId);
    const subRow = team.tasks.find((t) => t.id === subId)!;
    expect(subRow.status).toBe('ready');
    expect(subRow.mainSessionId).toBeUndefined();
  });

  it('dispatches via 主会话窗口（presence 心跳锚点）after leader removal（二十五轮 DA38）', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '无领队团队', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Alice', role: 'researcher' });
    const group = (
      (await h.call!('eteams_submit_task', { subject: '主任务' })) as { taskId: number }
    ).taskId;
    const sub = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '接力小任务',
      parentTaskId: String(group),
      chain: [{ member: 'Alice', stageBrief: '先做' }],
    });
    const subId = json<{ taskId: number }>(sub.body).taskId;

    // 移出领队（hasLeader=false；任务行快照仍记 cap-conv，v6 领队行只记
    // 自己的子代理会话）。
    const removed = await h.post(`/eteams-api/team/${teamId}/leader/remove`, {});
    expect(removed.code).toBe(200);
    // 原主会话下线（注册表 delete 键 = 会话已关），心跳指向另一在册会话。
    h.captains.delete('cap-conv');
    const presence = await h.post('/eteams-api/presence', { sessionId: 'cap-second' });
    expect(presence.code).toBe(200);

    // 派发走「主会话窗口就是领队」：任务行快照锚（cap-conv）已离线，心跳
    // cap-second 兜底起人成功（成员子代理的父会话校验按快照∪心跳判父，
    // 心跳会话在白名单内）。
    const started = await h.post(`/eteams-api/team/${teamId}/task/${subId}/start`, {});
    expect(started.code).toBe(200);
    const team = readTeam(teamId);
    expect(team.tasks.find((t) => t.id === subId)!.status).toBe('ready');
    expect(team.tasks.find((t) => t.id === subId)!.attempts[0]!.member).toBe('Alice');
    expect(childIdOf(teamId, 'Alice')).not.toBe('');
    // 补章：本任务行未登记快照时以本次派发锚点补登（cap-second）；已登记行
    // 不改写（group 任务的 cap-conv 原样保留）。
    expect(team.tasks.find((t) => t.id === subId)!.mainSessionId).toBe('cap-second');
    // v8+：主持行取消——领队的会话锚在本大任务的领队副本行上（未派发保持空串）。
    const leaderRow = team.taskMembers.find((r) => r.mainTaskId === group && r.isLeader === true);
    expect(leaderRow).toBeDefined();
    expect(leaderRow!.sessionId).toBe('');
  });

  it('chains group subs: completing one sub auto-dispatches the next（二十七轮 DA40）', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '链式团队', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Alice', role: 'researcher' });
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Bob', role: 'engineer' });
    const group = (
      (await h.call!('eteams_submit_task', { subject: '主任务' })) as { taskId: number }
    ).taskId;
    const first = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '第一棒',
      parentTaskId: String(group),
      chain: [{ member: 'Alice', stageBrief: '先做' }],
    });
    const firstId = json<{ taskId: number }>(first.body).taskId;
    const second = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '第二棒',
      parentTaskId: String(group),
      dependencies: [String(firstId)],
      chain: [{ member: 'Bob', stageBrief: '接棒' }],
    });
    const secondId = json<{ taskId: number }>(second.body).taskId;

    // 本用例走无领队宿主直派路径（有领队走领队的路径见下方 leaderful 用例）。
    await h.post(`/eteams-api/team/${teamId}/leader/remove`, {});

    // 整体开始 = 链式接力发棒：一次只派第一棒（第二棒进接力队列，原因透出，
    // 状态仍是 ready 等交棒）。
    const started = await h.post(`/eteams-api/team/${teamId}/task/${group}/start`, {});
    expect(started.code).toBe(200);
    const body = json<{
      started: number;
      skipped: { taskId: number; subject: string; reason: string }[];
    }>(started.body);
    expect(body.started).toBe(1);
    expect(body.skipped).toEqual([
      {
        taskId: secondId,
        subject: '第二棒',
        reason: '等待链式接力（前一小任务完成后自动开始）',
      },
    ]);
    expect(readTeam(teamId).tasks.find((t) => t.id === secondId)!.status).toBe('ready');

    // 第一棒完成 → 链式续派：同一完成帧之后第二棒自动进 wait 待接取（无需
    // 再点开始），成员 Bob 起会话。
    const alice = h.memberAgent!(childIdOf(teamId, 'Alice'));
    const claimed = await h.mem!(alice, 'eteams_claim_task', { taskId: firstId });
    expect(claimed.ok).toBe(true);
    const done = await h.mem!(alice, 'eteams_complete_task', {
      taskId: firstId,
      attemptId: claimed.attemptId,
      token: claimed.token,
      output: '第一棒完成',
    });
    expect(done.done).toBe(true);
    const team = readTeam(teamId);
    // 用户迭代 2026-09-11：派发不改状态——续派也是 ready 待接取。
    expect(team.tasks.find((t) => t.id === secondId)!.status).toBe('ready');
    expect(team.tasks.find((t) => t.id === secondId)!.attempts[0]!.member).toBe('Bob');
    expect(childIdOf(teamId, 'Bob')).not.toBe('');
  });

  it('rejects 整体开始 on a terminal group and skips the no-op continue（二十七轮 DA40）', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '收口团队', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Alice', role: 'researcher' });
    const group = (
      (await h.call!('eteams_submit_task', { subject: '主任务' })) as { taskId: number }
    ).taskId;
    const sub = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '唯一小任务',
      parentTaskId: String(group),
      chain: [{ member: 'Alice', stageBrief: '先做' }],
    });
    const subId = json<{ taskId: number }>(sub.body).taskId;
    // 本用例走无领队宿主直派路径（有领队走领队的路径见下方 leaderful 用例）。
    await h.post(`/eteams-api/team/${teamId}/leader/remove`, {});

    const started = await h.post(`/eteams-api/team/${teamId}/task/${group}/start`, {});
    expect(started.code).toBe(200);
    const alice = h.memberAgent!(childIdOf(teamId, 'Alice'));
    const claimed = await h.mem!(alice, 'eteams_claim_task', { taskId: subId });
    const done = await h.mem!(alice, 'eteams_complete_task', {
      taskId: subId,
      attemptId: claimed.attemptId,
      token: claimed.token,
      output: '完成',
    });
    expect(done.done).toBe(true);
    // 末棒完成即全组收口（completeGroupIfDoneInTx）；链式续派预检看到终态组
    // 直接免调用（无 warn 噪音、无二次派发）。
    expect(readTeam(teamId).tasks.find((t) => t.id === group)!.status).toBe('completed');
    // 终态组再点开始：host 直接报错。
    const again = await h.post(`/eteams-api/team/${teamId}/task/${group}/start`, {});
    expect(again.code).toBe(400);
    expect(json<{ error: string }>(again.body).error).toContain('已完成，无法整体开始');
  });

  it('routes panel 开始 through the leader (presence anchor fallback)（2026-09-12）', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', {
      name: '领队在册团队',
      sessionId: 'cap-conv',
    });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Alice', role: 'researcher' });
    const group = (
      (await h.call!('eteams_submit_task', { subject: '主任务' })) as { taskId: number }
    ).taskId;
    const sub = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '接力小任务',
      parentTaskId: String(group),
      chain: [{ member: 'Alice', stageBrief: '先做' }],
    });
    const subId = json<{ taskId: number }>(sub.body).taskId;

    // 用户 2026-09-12「任务重新开始有领队的情况下怎么没有走领队了，开始之前需要
    // 先唤醒一下主对话」：有领队的团队点开始不再由宿直派成员——宿主静默解析/
    // 复活主会话锚点（原主会话 cap-conv 已关，退到心跳 cap-second），再把本大任务
    // 的领队子代理唤醒（turn=start），由领队按执行链指派。
    h.captains.delete('cap-conv');
    const presence = await h.post('/eteams-api/presence', { sessionId: 'cap-second' });
    expect(presence.code).toBe(200);

    const started = await h.post(`/eteams-api/team/${teamId}/task/${subId}/start`, {});
    expect(started.code).toBe(200);
    expect(json<{ started: number }>(started.body).started).toBe(0);
    const team = readTeam(teamId);
    // 宿主不直派：小任务保持 ready、无 attempt，等领队指派。
    expect(team.tasks.find((t) => t.id === subId)!.status).toBe('ready');
    expect(team.tasks.find((t) => t.id === subId)!.attempts).toHaveLength(0);
    // 领队副本行（本大任务）已起会话（dispatchCaptainCore 首次派发）。
    const leaderRow = team.taskMembers.find((r) => r.mainTaskId === group && r.isLeader === true);
    expect(leaderRow).toBeDefined();
    expect(leaderRow!.sessionId).not.toBe('');
    // 回合 sidecar 记的是开跑批准，父会话 = 心跳兜底锚（cap-second）。
    const turn = readCaptainTurn(stateRoot(), String(group));
    expect(turn?.turn).toBe('start');
    expect(turn?.parentSessionId).toBe('cap-second');
  });

  it('routes panel 开始/继续 through the leader for a leaderful team（2026-09-12）', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '领队开跑团队', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Alice', role: 'researcher' });
    const group = (
      (await h.call!('eteams_submit_task', { subject: '主任务' })) as { taskId: number }
    ).taskId;
    const sub = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '接力小任务',
      parentTaskId: String(group),
      chain: [{ member: 'Alice', stageBrief: '先做' }],
    });
    const subId = json<{ taskId: number }>(sub.body).taskId;

    // 首次开始：主任务整体开始也交领队（宿主不直派第一棒）。
    const started = await h.post(`/eteams-api/team/${teamId}/task/${group}/start`, {});
    expect(started.code).toBe(200);
    expect(json<{ started: number }>(started.body).started).toBe(0);
    let team = readTeam(teamId);
    expect(team.tasks.find((t) => t.id === subId)!.status).toBe('ready');
    expect(team.tasks.find((t) => t.id === subId)!.attempts).toHaveLength(0);
    // 用户 2026-09-13「点击开始应该立刻改变状态」：批准转交领队后宿主同步把
    // 主任务置执行中，不再等领队指派才由容器同步翻 start。
    expect(team.tasks.find((t) => t.id === group)!.status).toBe('start');
    // 面板快照同口径（用户 2026-09-13「任务开始应该先改状态」）：无在办小任务
    // 时也被 panel.start 事件豁免，不再被读取侧兜底回落成「待开始」。
    const snapGroup = (
      teamSnapshot(readTeam(teamId), workspace, config).tasks as Array<{
        taskId: number;
        status: string;
      }>
    ).find((t) => t.taskId === group)!;
    expect(snapGroup.status).toBe('start');
    const leaderRow = team.taskMembers.find((r) => r.mainTaskId === group && r.isLeader === true);
    expect(leaderRow).toBeDefined();
    expect(leaderRow!.sessionId).not.toBe('');
    let turn = readCaptainTurn(stateRoot(), String(group));
    expect(turn?.turn).toBe('start');
    expect(turn?.message).toContain('用户批准开跑');

    // 暂停后重新开始：同样走领队（续跑口径，不改状态、不直派）。
    getDb(stateRoot()).prepare("UPDATE task SET status = 'paused' WHERE task_id = ?").run(subId);
    const resumed = await h.post(`/eteams-api/team/${teamId}/task/${subId}/start`, {});
    expect(resumed.code).toBe(200);
    expect(json<{ started: number }>(resumed.body).started).toBe(0);
    team = readTeam(teamId);
    expect(team.tasks.find((t) => t.id === subId)!.attempts).toHaveLength(0);
    turn = readCaptainTurn(stateRoot(), String(group));
    expect(turn?.turn).toBe('start');
    expect(turn?.message).toContain('恢复');
  });

  it('rolls the container back to 待开始 when the leader dispatch fails（先改状态的回滚，2026-09-13）', async () => {
    const h = await installFull({}, { failDispatch: true });
    const created = await h.post('/eteams-api/team', { name: '回滚团队', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Alice', role: 'researcher' });
    const group = (
      (await h.call!('eteams_submit_task', { subject: '主任务' })) as { taskId: number }
    ).taskId;
    await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '接力小任务',
      parentTaskId: String(group),
      chain: [{ member: 'Alice', stageBrief: '先做' }],
    });

    const started = await h.post(`/eteams-api/team/${teamId}/task/${group}/start`, {});
    expect(started.code).toBe(400);
    // 先置「执行中」的过渡态被回滚：raw 与面板快照都退回「待开始」，
    // 不留无人认领的假执行中。
    const team = readTeam(teamId);
    expect(team.tasks.find((t) => t.id === group)!.status).toBe('ready');
    const snapGroup = (
      teamSnapshot(readTeam(teamId), workspace, config).tasks as Array<{
        taskId: number;
        status: string;
      }>
    ).find((t) => t.taskId === group)!;
    expect(snapGroup.status).toBe('ready');
  });
});

describe('panel task commission (docs/panelTaskCommission)', () => {
  it('creates a 「创建中」container and dispatches the leaderful captain (有领队交领队完善)', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '手动建队', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;

    const description =
      '把 docs 目录下所有旧版迁移文档整体搬到 archive 目录并逐条校对失效链接\n\n补充：顺手清理孤儿图片';
    const res = await h.post(`/eteams-api/team/${teamId}/task/commission`, {
      description,
      sessionId: 'cap-conv',
    });
    expect(res.code, res.body).toBe(200);
    const body = json<{ ok: boolean; taskId: number; dispatched: boolean; detail?: string }>(
      res.body,
    );
    expect(body.ok).toBe(true);
    expect(body.dispatched, body.detail ?? '').toBe(true);

    // 容器落「创建中」：主题 = 描述首行截断占位（24 字上限），主会话快照入行。
    const team = readTeam(teamId);
    const task = team.tasks.at(-1)!;
    expect(body.taskId).toBe(task.id);
    expect(task.status).toBe('creating');
    expect(task.parentId).toBeNull();
    const firstLine = description.split('\n')[0]!;
    expect(task.subject).toBe(firstLine.slice(0, 24));
    expect(task.mainSessionId).toBe('cap-conv');
    // 与对话建任务同口径：建任务即物化文档树（留言板 + 本任务纪要 + 计划/文档夹）。
    expect(existsSync(join(task.workDir!, task.taskDir!, '留言板.md'))).toBe(true);
    expect(existsSync(join(task.workDir!, task.taskDir!, minutesFileName(task)))).toBe(true);

    // 有领队 → dispatchCaptainCore 建立本任务的领队副本子代理（durable id
    // 落领队副本行——v8+ 主持行取消）。
    const leaderRow = team.taskMembers.find(
      (r) => r.mainTaskId === task.id && r.isLeader === true,
    )!;
    expect(leaderRow.sessionId).toMatch(/^sess-child-/);

    // 动态事件如实记派发结果；创建中容器不计进度分母。
    const snap = await h.get(`/eteams-api/team/${teamId}`);
    const snapBody = json<{
      progress: { total: number };
      latestEvents: { type: string; text: string }[];
    }>(snap.body);
    expect(snapBody.progress.total).toBe(0);
    expect(snapBody.latestEvents.find((e) => e.type === 'task_commissioned')!.text).toBe(
      `面板创建任务 #${task.id}，已交领队完善`,
    );
    // 跨测试注册表残留清理：captainChildren 是模块级 Map，而每个 installFull
    // 的子会话计数器都从 sess-child-1 重来——不清掉，后面用例的同名成员子
    // 会话会被 identity.resolveCaller 误判成领队（注册表优先）。
    unregisterCaptainChild(leaderRow.sessionId);
  });

  it('keeps the task as creating when no main-session anchor is found (无锚不回滚)', async () => {
    const h = await installFake();
    const created = await h.post('/eteams-api/team', { name: '无锚队', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;

    const res = await h.post(`/eteams-api/team/${teamId}/task/commission`, {
      description: '盘点半导体行业资料',
    });
    expect(res.code, res.body).toBe(200);
    const body = json<{ ok: boolean; dispatched: boolean; detail?: string }>(res.body);
    expect(body.ok).toBe(true);
    expect(body.dispatched).toBe(false);
    expect(body.detail).toContain('未找到主会话锚点');

    // 任务已入册不回滚——留在创建中（删除后重试是逃生门）。
    expect(readTeam(teamId).tasks.at(-1)!.status).toBe('creating');
    const snap = json<{ latestEvents: { type: string; text: string }[] }>(
      (await h.get(`/eteams-api/team/${teamId}`)).body,
    );
    const event = snap.latestEvents.find((e) => e.type === 'task_commissioned')!.text;
    expect(event).toContain('创建中');
    expect(event).toContain('未找到主会话锚点');
  });

  it('rejects the commission when the session is bound to another team (绑定他队拒投)', async () => {
    const h = await installFull();
    const first = await h.post('/eteams-api/team', { name: '甲队', sessionId: 'cap-conv' });
    const teamA = json<{ teamId: number }>(first.body).teamId;
    const second = await h.post('/eteams-api/team', { name: '乙队', sessionId: 'cap-second' });
    const teamB = json<{ teamId: number }>(second.body).teamId;

    // 会话绑定乙队后对甲队投递会错配 caller.team（完善者调 eteams_* 必报
    // 「任务不存在」），路由提前变成可诊断的明确失败。
    await h.post('/eteams-api/session-team', { sessionId: 'cap-conv', teamId: String(teamB) });
    const res = await h.post(`/eteams-api/team/${teamA}/task/commission`, {
      description: '梳理双周报模板',
      sessionId: 'cap-conv',
    });
    expect(res.code, res.body).toBe(200);
    const body = json<{ ok: boolean; dispatched: boolean; detail?: string }>(res.body);
    expect(body.dispatched).toBe(false);
    expect(body.detail).toContain('该会话已绑定其他团队');
    // 任务仍创建（留在创建中可删后重试）。
    expect(readTeam(teamA).tasks.at(-1)!.status).toBe('creating');
    // 绑定表同为模块级状态——清掉，避免污染后续用例的 cap-conv 身份解析。
    clearSessionTeam('cap-conv');
  });

  it('wakes the main conversation directly for a leaderless team (无领队主会话完善)', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '自主持队', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const removed = await h.post(`/eteams-api/team/${teamId}/leader/remove`, {});
    expect(removed.code, removed.body).toBe(200);

    // 无领队路径的唤醒目标是主会话锚（Agent.followup）——harness 的 captain
    // 桩没有 followup 方法，测试内补上（installFull 只起 subagents 桩）。
    const wakes: unknown[] = [];
    const captain = h.captains.get('cap-conv') as unknown as {
      followup?: (msg: unknown) => void;
    };
    captain.followup = (msg) => {
      wakes.push(msg);
    };

    const description = '盘点半导体行业资料并给出选题建议';
    const res = await h.post(`/eteams-api/team/${teamId}/task/commission`, {
      description,
      sessionId: 'cap-conv',
    });
    expect(res.code, res.body).toBe(200);
    const body = json<{ ok: boolean; taskId: number; dispatched: boolean; detail?: string }>(
      res.body,
    );
    expect(body.dispatched, body.detail ?? '').toBe(true);
    expect(wakes).toHaveLength(1);
    // 消息正文带完善指令：任务描述原话 + 任务 #id。
    const sent = JSON.stringify(wakes[0]);
    expect(sent).toContain(description);
    expect(sent).toContain(`#${body.taskId}`);

    const snap = json<{ latestEvents: { type: string; text: string }[] }>(
      (await h.get(`/eteams-api/team/${teamId}`)).body,
    );
    expect(snap.latestEvents.find((e) => e.type === 'task_commissioned')!.text).toBe(
      `面板创建任务 #${body.taskId}，已交主会话完善`,
    );
  });

  it('400s an empty description and 404s unknown teams (入参校验)', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '校验队', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;

    const blank = await h.post(`/eteams-api/team/${teamId}/task/commission`, { description: '' });
    expect(blank.code).toBe(400);
    expect(blank.body).toContain('description 不能为空');

    const ghost = await h.post('/eteams-api/team/999/task/commission', { description: '任意描述' });
    expect(ghost.code).toBe(404);
    expect(ghost.body).toContain('团队 999 不存在');
  });
});

describe('GET /board 跨团队聚合 (docs/35 §6 Q1/Q3/Q4/Q5/Q9)', () => {
  it('aggregates columns, ready lane, group progress, deduped members and open decisions', async () => {
    // maxRetries 0：首次 fail 即进决策（重试预算零）。
    const h = await installFull({ maxRetries: 0 });
    const made = await h.post('/eteams-api/team', { name: '聚合甲', sessionId: 'cap-conv' });
    const teamA = json<{ teamId: number }>(made.body).teamId;
    const madeB = await h.post('/eteams-api/team', { name: '聚合乙', sessionId: 'cap-second' });
    const teamB = json<{ teamId: number }>(madeB.body).teamId;

    await h.post(`/eteams-api/team/${teamA}/member`, { name: 'Alice', role: 'researcher' });
    await h.post(`/eteams-api/team/${teamA}/member`, { name: 'Bob', role: 'engineer' });
    await h.post(`/eteams-api/team/${teamB}/member`, { name: 'Cara', role: 'writer' });

    // 甲队：三支任务单——一个团队可挂多个主任务，但每个只能由不同的对话建
    // （每个对话各自锚定一个主任务，用户迭代 2026-09-12）：group1 走主对话
    // cap-conv，group2/group3 分别由 cap-conv-2 / cap-conv-3 提交。完成是可
    // 回退标识、容器仍收小任务（createTask 命中即回 ready），无时序约束；
    // 小任务全部完成会自动收口容器，看板 groups 读小任务进度。
    const group1 = (
      (await h.call!('eteams_submit_task', { subject: '主任务一' })) as {
        taskId: number;
      }
    ).taskId;

    const makeSub = async (subject: string, parent: number, member: string) =>
      json<{ taskId: number }>(
        (
          await h.post(`/eteams-api/team/${teamA}/task`, {
            subject,
            parentTaskId: String(parent),
            chain: [{ member, stageBrief: '站点' }],
          })
        ).body,
      ).taskId;

    const subA = await makeSub('子任务挂起', group1, 'Alice');
    const subB = await makeSub('子任务完成', group1, 'Alice');
    getDb(stateRoot())
      .prepare('UPDATE task SET status = ? WHERE task_id = ?')
      .run('completed', group1);
    // 第二个任务单来自第二个对话（cap-conv-2，各自锚定一个主任务）。
    setSessionTeam('cap-conv-2', { teamId: String(teamA), name: '聚合甲', boundAt: Date.now() });
    const group2 = (
      (await h.call!('eteams_submit_task', { subject: '主任务二' }, h.agentFor!('cap-conv-2'))) as {
        taskId: number;
      }
    ).taskId;
    const subC = await makeSub('子任务B一', group2, 'Bob');
    getDb(stateRoot())
      .prepare('UPDATE task SET status = ? WHERE task_id = ?')
      .run('completed', group2);
    // 第三个任务单来自第三个对话（cap-conv-3）。
    setSessionTeam('cap-conv-3', { teamId: String(teamA), name: '聚合甲', boundAt: Date.now() });
    const group3 = (
      (await h.call!('eteams_submit_task', { subject: '主任务三' }, h.agentFor!('cap-conv-3'))) as {
        taskId: number;
      }
    ).taskId;
    const subD = await makeSub('子任务B二', group3, 'Bob');
    const subF = await makeSub('子任务失败', group3, 'Alice');
    const subE = json<{ taskId: number }>(
      (await h.post(`/eteams-api/team/${teamA}/task`, { subject: '独立小任务' })).body,
    ).taskId;

    // subA：指派 → wait → 挂起 → paused（看板第三列）。
    await h.call!('eteams_assign_task', { taskId: subA, member: 'Alice' });
    await h.call!('eteams_suspend_task', { taskId: subA, note: '先停' });
    // subB：指派 → 接取 → 交付（组进度 done 1/2）。挂起行不占用（assertNotBusy
    // 只认 working 实例行），同一行接着派。
    await h.call!('eteams_assign_task', { taskId: subB, member: 'Alice' });
    const aliceClaim = await h.mem!(
      h.memberAgent!(childIdOf(teamA, 'Alice')),
      'eteams_claim_task',
      { taskId: subB },
    );
    await h.mem!(h.memberAgent!(childIdOf(teamA, 'Alice')), 'eteams_complete_task', {
      taskId: subB,
      attemptId: aliceClaim.attemptId,
      token: aliceClaim.token,
      output: '交付完成',
    });
    // subC：Bob 接单交付（组二 1/1 收口）。
    await h.call!('eteams_assign_task', { taskId: subC, member: 'Bob' });
    const bobClaim = await h.mem!(h.memberAgent!(childIdOf(teamA, 'Bob')), 'eteams_claim_task', {
      taskId: subC,
    });
    await h.mem!(h.memberAgent!(childIdOf(teamA, 'Bob')), 'eteams_complete_task', {
      taskId: subC,
      attemptId: bobClaim.attemptId,
      token: bobClaim.token,
      output: '映射表完成',
    });
    // subD：Bob 再领一单（group3 → 第二条实例行）；用户迭代 2026-09-11：
    // 派发不改状态——停在 ready（进看板就绪待派列）。
    await h.call!('eteams_assign_task', { taskId: subD, member: 'Bob' });
    // subF：Alice 在另一支大任务上失败（重试预算 0 → 落 wait 待领队）。
    // 同一成员跨大任务各一行实例行（Q5 去重口径的数据形态）。
    await h.call!('eteams_assign_task', { taskId: subF, member: 'Alice' });
    const aliceClaim2 = await h.mem!(
      h.memberAgent!(childIdOf(teamA, 'Alice')),
      'eteams_claim_task',
      { taskId: subF },
    );
    const failed = await h.mem!(h.memberAgent!(childIdOf(teamA, 'Alice')), 'eteams_fail_task', {
      taskId: subF,
      attemptId: aliceClaim2.attemptId,
      token: aliceClaim2.token,
      error: '上游接口超时',
    });
    expect(failed.retried).toBe(false);
    // 失败超限落 wait（待领队分诊），不进 wait_user、不开决策（用户迭代
    // 2026-09-11）——看板出现 wait 列、decisions 为空。
    expect(readTeam(teamA).tasks.find((t) => t.id === subF)!.status).toBe('wait');
    const boardWait = json<{
      teams: Array<{
        teamId: number;
        columns: Record<string, { taskId: number }[]>;
        decisions: unknown[];
      }>;
    }>((await h.get('/eteams-api/board')).body).teams;
    const aw = boardWait.find((t) => t.teamId === teamA)!;
    expect(aw.columns.wait.map((t) => t.taskId)).toEqual([subF]);
    expect(aw.columns.wait_user).toEqual([]);
    expect(aw.decisions).toEqual([]);
    // 领队升级（流程问题分支）→ wait_user + 开决策。
    await h.call!('eteams_escalate_task', { taskId: subF, note: '上游接口超时' });
    expect(readTeam(teamA).tasks.find((t) => t.id === subF)!.status).toBe('wait_user');

    // 乙队：一个就绪任务，无决策。
    await h.post(`/eteams-api/team/${teamB}/task`, { subject: '独立任务' });

    const board = await h.get('/eteams-api/board');
    expect(board.code).toBe(200);
    const teams = json<{
      teams: Array<
        {
          teamId: number;
          name: string;
          ready: { taskId: number; subject: string; status: string }[];
          columns: Record<string, { taskId: number; subject: string }[]>;
          groups: { taskId: number; subject: string; done: number; total: number }[];
          members: { name: string; activeTasks: number; isLeader: boolean }[];
          decisions: { taskId: number; error: string; retryCount: number }[];
        }[]
      >;
      serverTime: number;
    }>(board.body).teams;
    expect(teams).toHaveLength(2);

    const a = teams.find((t) => t.teamId === teamA)!;
    expect(a.name).toBe('聚合甲');
    // 就绪待派列：独立小任务 + 已派发待接取的 subD（用户迭代 2026-09-11：
    // wait 撤销后派发不再出列，仍算待开始）。
    expect([...a.ready.map((t) => t.taskId)].sort((x, y) => x - y)).toEqual(
      [subD, subE].sort((x, y) => x - y),
    );
    expect(a.ready.find((t) => t.taskId === subE)!.subject).toBe('独立小任务');
    expect(a.columns.paused.map((t) => t.taskId)).toEqual([subA]);
    expect(a.columns.wait_user.map((t) => t.taskId)).toEqual([subF]);
    expect(a.columns.start).toEqual([]);
    // wait 列存在但已空（subF 被领队升级为 wait_user）；wait_decision 已退役。
    expect(a.columns.wait).toEqual([]);
    expect(a.columns.wait_decision).toBeUndefined();
    expect(a.groups.find((g) => g.taskId === group1)).toEqual({
      taskId: group1,
      subject: '主任务一',
      done: 1,
      total: 2,
    });
    expect(a.groups.find((g) => g.taskId === group2)).toMatchObject({ done: 1, total: 1 });
    expect(a.groups.find((g) => g.taskId === group3)).toMatchObject({ done: 0, total: 2 });
    expect(a.decisions).toHaveLength(1);
    expect(a.decisions[0]!.taskId).toBe(subF);
    expect(a.decisions[0]!.retryCount).toBe(1);
    expect(a.decisions[0]!.error).toBe('上游接口超时');
    // Q5 按工号聚合：Alice/Bob 各一行成员行；领队行带 isLeader 标记。
    const names = a.members.map((m) => m.name);
    expect(names.filter((n) => n === 'Alice')).toHaveLength(1);
    expect(names.filter((n) => n === 'Bob')).toHaveLength(1);
    // v7 决策 5：建任务即全员铺副本——Alice 在甲队全部 4 支大任务（三张
    // 任务单 + 独立小任务）各一行副本，工号同源不混。
    const aliceRows = readTeam(teamA).taskMembers.filter((r) => r.name === 'Alice');
    expect(aliceRows).toHaveLength(4);
    // 表自增（v7）：工号 = 班底行全局自增主键——甲领队 1、乙领队 2、Alice 3。
    expect(new Set(aliceRows.map((r) => r.employeeId))).toEqual(new Set([3]));
    // activeTasks 按在办尝试归属副本行计（活跃态 = start/paused/wait_user）：
    // subA 挂起（paused）与 subF 失败进待用户（wait_user）虽已释放执行行，
    // 尝试记录仍在案——Alice 计 2；Bob 只有 subD（ready 待接取，不算在办）
    // 与已完成的 subC，计 0。
    expect(a.members.find((m) => m.name === 'Alice')!.activeTasks).toBe(2);
    expect(a.members.find((m) => m.name === 'Bob')!.activeTasks).toBe(0);
    expect(a.members.find((m) => m.name === 'Bob')!.isLeader).toBe(false);
    expect(a.members.find((m) => m.name === '团队领队')!.isLeader).toBe(true);
    expect(a.members).toHaveLength(3);

    const b = teams.find((t) => t.teamId === teamB)!;
    expect(b.ready).toHaveLength(1);
    expect(b.ready[0]!.subject).toBe('独立任务');
    expect(b.decisions).toEqual([]);
    expect(b.groups.find((g) => g.subject === '独立任务')).toMatchObject({ done: 0, total: 0 });
    expect(b.members.find((m) => m.name === 'Cara')).toBeDefined();
  });
});

describe('usage calendar route (docs/28.4)', () => {
  /** 365/366 as the zero-filled grid builds it. */
  function daysInYear(year: number): number {
    let total = 0;
    for (let month = 0; month < 12; month += 1) total += new Date(year, month + 1, 0).getDate();
    return total;
  }

  it('serves the aggregated calendar, 400s a bad year and 404s unknown teams', async () => {
    const h = await installFake();
    const created = await h.post('/eteams-api/team', { name: '用量队', sessionId: 'cap-webui' });
    expect(created.code).toBe(200);
    const teamId = json<{ teamId: number }>(created.body).teamId;
    // 采集面的归属/入库已由 tests/usage.test.ts 覆盖；这里只验证路由组合。
    const year = new Date().getFullYear();
    const row = {
      at: Date.now(),
      day: `${year}-01-02`,
      sessionId: 'm1',
      seq: 1,
      teamId: String(teamId),
      memberName: 'Alice',
      roleKind: 'member',
      provider: 'p',
      model: 'm',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    };
    recordUsage(getDb(joinPath(workspace, '.eteams')), row);
    const r = await h.get(`/eteams-api/team/${teamId}/usage/calendar`);
    expect(r.code).toBe(200);
    const parsed = json<{
      teamId: number;
      year: number;
      days: { date: string; totalTokens: number; calls: number }[];
      totals: { totalTokens: number; firstDay: string | null; lastDay: string | null };
    }>(r.body);
    expect(parsed.teamId).toBe(teamId);
    expect(parsed.year).toBe(year);
    expect(parsed.days).toHaveLength(daysInYear(year));
    expect(parsed.totals.totalTokens).toBe(12);
    expect(parsed.totals.firstDay).toBe(`${year}-01-02`);
    expect(parsed.totals.lastDay).toBe(`${year}-01-02`);
    const bad = await h.get(`/eteams-api/team/${teamId}/usage/calendar?year=abcd`);
    expect(bad.code).toBe(400);
    const missing = await h.get('/eteams-api/team/nope/usage/calendar');
    expect(missing.code).toBe(404);
  });

  it('serves the app-wide calendar; workspace rows count too', async () => {
    const h = await installFake();
    // collectRoots 从工作区注册表取根——先建一支团队把工作区注册进来。
    await h.post('/eteams-api/team', { name: '应用用量队', sessionId: 'cap-app' });
    const year = new Date().getFullYear();
    const row = (seq: number, teamId: string | null, inputTokens: number): UsageRecord => ({
      at: Date.now(),
      day: `${year}-01-03`,
      sessionId: `s${seq}`,
      seq,
      teamId,
      memberName: null,
      roleKind: teamId === null ? 'workspace' : 'member',
      provider: 'p',
      model: 'm',
      inputTokens,
      outputTokens: 0,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    });
    recordUsage(getDb(joinPath(workspace, '.eteams')), row(1, null, 100));
    recordUsage(getDb(joinPath(workspace, '.eteams')), row(2, '999', 50));
    recordUsage(getDb(joinPath(workspace, '.eteams')), row(3, 'no-such-team', 7));
    const r = await h.get('/eteams-api/usage/calendar');
    expect(r.code).toBe(200);
    const parsed = json<{
      teamId: null;
      year: number;
      totals: { totalTokens: number; calls: number };
      days: { date: string; totalTokens: number }[];
    }>(r.body);
    expect(parsed.teamId).toBeNull();
    expect(parsed.year).toBe(year);
    // 全应用口径：null 团队（普通对话）与未知 teamId 的行一并计入。
    expect(parsed.totals.totalTokens).toBe(157);
    expect(parsed.totals.calls).toBe(3);
    expect(parsed.days.find((d) => d.date === `${year}-01-03`)?.totalTokens).toBe(157);
    const bad = await h.get('/eteams-api/usage/calendar?year=abcd');
    expect(bad.code).toBe(400);
  });
});

describe('web surface installation', () => {
  it('stays tool-only when web services are absent (headless)', () => {
    const ctx = fakeCtx();
    expect(installWebSurface(ctx, config)).toBe(false);
  });

  it('registers the prefix route when webServer + workspaceRegistry exist', () => {
    const registered: { kind: string; path: string }[] = [];
    const ctx = {
      get: (key: string) =>
        key === 'webServer'
          ? {
              register: (route: { kind: string; path: string }) => {
                registered.push(route);
              },
            }
          : key === 'workspaceRegistry'
            ? { list: () => [{ path: workspace, title: 'ws' }] }
            : undefined,
      effect: (fn: () => unknown) => {
        fn();
        return () => undefined;
      },
      logger: { info: () => undefined, warn: () => undefined },
    } as unknown as Context;
    expect(installWebSurface(ctx, config)).toBe(true);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.kind).toBe('prefix');
    expect(registered[0]!.path).toBe('/eteams-api');
  });

  it('answers 405 on non-GET reads beyond the write routes', async () => {
    const h = await installFake();
    const put = await fire(h.handler, 'POST', '/eteams-api/state', {});
    expect(put.code).toBe(405);
  });

  it('persists POST /client-log diagnostics under .eteams/logs/client.log', async () => {
    const h = await installFake();
    const posted = await h.post('/eteams-api/client-log', {
      version: 'v0.2.0',
      entries: [{ at: 1, kind: 'error', message: 'boom', source: 'a.js:1:1' }],
    });
    expect(posted.code).toBe(200);
    expect(json<{ ok: boolean; written: number }>(posted.body)).toMatchObject({
      ok: true,
      written: 1,
    });
    const log = readFileSync(join(workspace, '.eteams', 'logs', 'client.log'), 'utf8')
      .split('\n')
      .filter((l) => l !== '');
    expect(log).toHaveLength(1);
    const record = json<{ version: string; entry: { kind: string; message: string } }>(log[0]!);
    expect(record.version).toBe('v0.2.0');
    expect(record.entry).toMatchObject({ kind: 'error', message: 'boom' });
  });
});

describe('POST /eteams-api/rolebuilder/resume (docs/19.16)', () => {
  /** Panel harness with an explicit captains registry: the resume gate reads
   * `agents.get(parentSessionId)` — tests control who is "online". A recording
   * continuable-subagents fake backs the wake path — the cancelled→active
   * flip now happens inside the dispatcher's build lock, so the fake must
   * exist or the wake (and thus the flip) never lands. */
  async function installResumeFake(): Promise<{
    handler: Handler;
    captains: Map<string, { id: string; session: { header: { cwd: string } } }>;
    calls: { followups: string[]; rebuilt: number; interrupts: string[] };
  }> {
    const registered: Handler[] = [];
    const captains = new Map<string, { id: string; session: { header: { cwd: string } } }>();
    const calls = { followups: [] as string[], rebuilt: 0, interrupts: [] as string[] };
    const ctx = {
      logger: { info: () => undefined, warn: () => undefined },
      subagents: {
        async startContinuable() {
          calls.rebuilt += 1;
          return { childId: `resume-rebuild-${calls.rebuilt}`, messageId: 'm' };
        },
        async followup(_parent: unknown, childId: unknown) {
          calls.followups.push(String(childId));
          return 'm';
        },
        interrupt(_childId: unknown, _authority: unknown) {
          calls.interrupts.push(String(_childId));
        },
      },
      agents: { get: (id: string) => captains.get(id) },
      ...surfaceCtx(captains, registered),
    } as unknown as Context;
    installWebSurface(ctx, config);
    return { handler: registered[0]!, captains, calls };
  }

  it('GET /rolebuilder reports parentOnline: false when the parent conversation is offline', async () => {
    const { handler } = await installResumeFake();
    await reportBuildProgress(stateRoot(), { request: '在线检测', step: '收到需求' });
    await cancelBuildSession(stateRoot());
    await setBuildParentSession(stateRoot(), 'cap-offline');
    const got = await fire(handler, 'GET', '/eteams-api/rolebuilder');
    expect(got.code).toBe(200);
    const parsed = json<{ empty: boolean; parentOnline?: boolean }>(got.body);
    expect(parsed.empty).toBe(false);
    expect(parsed.parentOnline).toBe(false);
  });

  it('GET /rolebuilder reports parentOnline: true when the parent conversation is live', async () => {
    const { handler, captains } = await installResumeFake();
    captains.set('cap-live', { id: 'cap-live', session: { header: { cwd: workspace } } });
    await reportBuildProgress(stateRoot(), { request: '在线检测', step: '收到需求' });
    await setBuildParentSession(stateRoot(), 'cap-live');
    const got = await fire(handler, 'GET', '/eteams-api/rolebuilder');
    expect(got.code).toBe(200);
    const parsed = json<{ empty: boolean; parentOnline?: boolean }>(got.body);
    expect(parsed.parentOnline).toBe(true);
  });

  it('refuses with 409 when the parent conversation is offline, session stays cancelled', async () => {
    const { handler } = await installResumeFake();
    // 已放弃的构建 + 记住的父会话；注册表为空 → 父不在线（用户反馈
    // 2026-09-05「点继续构建没反应」的宿主侧根因：拒绝必须带可读原因）。
    await reportBuildProgress(stateRoot(), { request: '恢复回归', step: '收到需求' });
    await cancelBuildSession(stateRoot());
    await setBuildParentSession(stateRoot(), 'cap-offline');
    const refused = await fire(handler, 'POST', '/eteams-api/rolebuilder/resume');
    expect(refused.code).toBe(409);
    expect(json<{ error: string }>(refused.body).error).toContain('不在线');
    expect(json<{ error: string }>(refused.body).error).toContain('继续构建');
    // 诚实拒绝：状态不翻转（否则恢复成 active 却没有代理续跑 = 假卡死）。
    expect(readBuildSession(stateRoot())?.status).toBe('cancelled');
  });

  it('resumes with a live parent: flips to active and keeps the draft context', async () => {
    const { handler, captains, calls } = await installResumeFake();
    captains.set('cap-online', { id: 'cap-online', session: { header: { cwd: workspace } } });
    await reportBuildProgress(stateRoot(), {
      request: '恢复回归',
      stepsDone: ['收到需求'],
      draft: { name: 'partial', role: 'eng' },
    });
    await cancelBuildSession(stateRoot());
    await setBuildParentSession(stateRoot(), 'cap-online');
    const ok = await fire(handler, 'POST', '/eteams-api/rolebuilder/resume');
    expect(ok.code).toBe(200);
    expect(json<{ ok: boolean; status: string }>(ok.body)).toMatchObject({
      ok: true,
      status: 'active',
    });
    const session = readBuildSession(stateRoot());
    expect(session?.status).toBe('active');
    expect(session?.draft?.name).toBe('partial');
    // 持续构建子代理（docs/19.16）：恢复路径会话里还没有 childId → 冷恢复
    // 重建接手同一构建（没有第二次受理，重建计数恰为 1）。
    expect(calls.rebuilt).toBe(1);
    expect(calls.followups).toEqual([]);
  });

  it('resume with a persisted builderChildId wakes the same child via followup (no rebuild)', async () => {
    const { handler, captains, calls } = await installResumeFake();
    captains.set('cap-online', { id: 'cap-online', session: { header: { cwd: workspace } } });
    await reportBuildProgress(stateRoot(), { request: '恢复回归', step: '收到需求' });
    await cancelBuildSession(stateRoot());
    await setBuildParentSession(stateRoot(), 'cap-online');
    await markBuilderChild(stateRoot(), 'build-child-7');
    const ok = await fire(handler, 'POST', '/eteams-api/rolebuilder/resume');
    expect(ok.code).toBe(200);
    const session = readBuildSession(stateRoot());
    expect(session?.status).toBe('active');
    expect(calls.followups).toEqual(['build-child-7']);
    expect(calls.rebuilt).toBe(0);
  });

  it('resume still flips to active when followup fails — rebuild takes over and updates the childId', async () => {
    const registered: Handler[] = [];
    const captains = new Map<string, { id: string; session: { header: { cwd: string } } }>();
    captains.set('cap-online', { id: 'cap-online', session: { header: { cwd: workspace } } });
    const calls = { followups: 0, rebuilt: 0 };
    const ctx = {
      logger: { info: () => undefined, warn: () => undefined },
      subagents: {
        async startContinuable() {
          calls.rebuilt += 1;
          return { childId: `rebuild-${calls.rebuilt}`, messageId: 'm' };
        },
        async followup() {
          calls.followups += 1;
          throw new Error('lineage mismatch');
        },
        interrupt() {},
      },
      agents: { get: (id: string) => captains.get(id) },
      ...surfaceCtx(captains, registered),
    } as unknown as Context;
    installWebSurface(ctx, config);
    const handler = registered[0]!;
    await reportBuildProgress(stateRoot(), { request: '恢复回归', step: '收到需求' });
    await cancelBuildSession(stateRoot());
    await setBuildParentSession(stateRoot(), 'cap-online');
    await markBuilderChild(stateRoot(), 'stale-child');
    const ok = await fire(handler, 'POST', '/eteams-api/rolebuilder/resume');
    expect(ok.code).toBe(200);
    // 同一构建、新持有者：followup 失败 → 重建并覆盖落盘 childId。
    expect(calls.followups).toBe(1);
    expect(calls.rebuilt).toBe(1);
    expect(readBuildSession(stateRoot())?.builderChildId).toBe('rebuild-1');
  });

  it('interview POST wakes the persisted builder child via followup and stores the answers', async () => {
    const { handler, captains, calls } = await installResumeFake();
    captains.set('cap-online', { id: 'cap-online', session: { header: { cwd: workspace } } });
    await reportBuildProgress(stateRoot(), {
      request: '访谈中转',
      step: '意图访谈',
      interview: { questions: [{ id: 'q1', question: '用在哪？', options: [{ label: 'A' }] }] },
    });
    await setBuildParentSession(stateRoot(), 'cap-online');
    await markBuilderChild(stateRoot(), 'build-child-9');
    const got = await fire(handler, 'POST', '/eteams-api/rolebuilder/interview', {
      answers: [{ id: 'q1', choice: 'A' }],
    });
    expect(got.code).toBe(200);
    const session = readBuildSession(stateRoot());
    expect(session?.interview?.answers).toEqual([{ id: 'q1', choice: 'A' }]);
    // 同一持续子代理被 followup 唤醒起草，不再起第二个代理。
    expect(calls.followups).toEqual(['build-child-9']);
    expect(calls.rebuilt).toBe(0);
  });

  it('cancel interrupts the persisted builder child (durable session kept)', async () => {
    const { handler, calls } = await installResumeFake();
    await reportBuildProgress(stateRoot(), { request: '中途放弃', step: '收到需求' });
    await setBuildParentSession(stateRoot(), 'cap-online');
    await markBuilderChild(stateRoot(), 'build-child-11');
    const got = await fire(handler, 'POST', '/eteams-api/rolebuilder/cancel');
    expect(got.code).toBe(200);
    expect(readBuildSession(stateRoot())?.status).toBe('cancelled');
    expect(calls.interrupts).toEqual(['build-child-11']);
    // 放弃不回收 durable 会话（恢复经 followup 或冷恢复重建续聊）。
    expect(calls.rebuilt).toBe(0);
    expect(calls.followups).toEqual([]);
  });
});

describe('GET /session-identity (子代理身份面)', () => {
  it('resolves a member child via its replica row (成员子代理身份面)', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '身份队', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Alice', role: 'researcher' });
    const made = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '接力任务',
      chain: [{ member: 'Alice', stageBrief: '调研' }],
    });
    const taskId = json<{ taskId: number }>(made.body).taskId;
    await h.post('/eteams-api/presence', { sessionId: 'cap-conv' });
    const assigned = await h.call!('eteams_assign_task', { taskId, member: 'Alice' });
    expect(assigned.ok).toBe(true);
    const childId = childIdOf(teamId, 'Alice');

    const got = await h.get(
      `/eteams-api/session-identity?sessionId=${encodeURIComponent(childId)}`,
    );
    expect(got.code, got.body).toBe(200);
    const body = json<{
      empty: boolean;
      kind: string;
      name: string;
      teamId: string | null;
      teamName: string | null;
      avatar: { seed: number; salt: number } | null;
    }>(got.body);
    expect(body.empty).toBe(false);
    expect(body.kind).toBe('member');
    expect(body.name).toBe('Alice');
    expect(body.teamId).toBe(String(teamId));
    expect(body.teamName).toBe('身份队');
    expect(body.avatar).not.toBeNull();
    expect(typeof body.avatar!.seed).toBe('number');
    expect(typeof body.avatar!.salt).toBe('number');
  });

  it('resolves a captain child via the leader replica row (领队子代理身份面)', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '领队身份队', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    // 加一个成员：她的班底副本行建任务时铺下但未起会话（sessionId 空串），
    // 用来锁定「未起会话的成员不进 memberSessions」。
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Alice', role: 'researcher' });
    const res = await h.post(`/eteams-api/team/${teamId}/task/commission`, {
      description: '盘点资料',
      sessionId: 'cap-conv',
    });
    expect(res.code, res.body).toBe(200);
    const team = readTeam(teamId);
    const task = team.tasks.at(-1)!;
    const leaderRow = team.taskMembers.find(
      (r) => r.mainTaskId === task.id && r.isLeader === true,
    )!;
    expect(leaderRow.sessionId).toMatch(/^sess-child-/);

    // 用户 2026-09-14（hover 弹窗「会话成员」按任务口径取）：
    // ① 领队会话必须下发——领队的子会话挂在 isLeader=1 那行上，单按班底
    //    members 取会漏掉领队（旧实现症状「领队已经有会话了但没显示」）；
    // ② 任务还在创建中（commission 容器）时，班底副本行 sessionId 仍为空串
    //    —— 不入 memberSessions（不会把还没有会话的成员放出来）。
    const snap = teamSnapshot(team, workspace, config);
    const groupView = (
      snap.tasks as Array<{
        taskId: number;
        memberSessions: { name: string; sessionId: string }[];
      }>
    ).find((x) => x.taskId === task.id)!;
    expect(groupView.memberSessions.map((m) => m.name)).toEqual(['团队领队']);
    expect(groupView.memberSessions[0]!.sessionId).toBe(leaderRow.sessionId);
    expect(
      team.taskMembers.filter((r) => r.mainTaskId === task.id && r.sessionId === '').length,
    ).toBeGreaterThan(0);

    const got = await h.get(
      `/eteams-api/session-identity?sessionId=${encodeURIComponent(leaderRow.sessionId)}`,
    );
    expect(got.code, got.body).toBe(200);
    const body = json<{
      empty: boolean;
      kind: string;
      name: string;
      teamId: string | null;
      teamName: string | null;
      avatar: unknown;
    }>(got.body);
    expect(body.empty).toBe(false);
    expect(body.kind).toBe('captain');
    expect(body.name).toBe('团队领队');
    expect(body.teamId).toBe(String(teamId));
    expect(body.teamName).toBe('领队身份队');
    expect(body.avatar).not.toBeNull();

    // 跨测试注册表残留清理（与 commission 用例同口径：模块级 Map，而每个
    // installFull 的子会话计数器都从 sess-child-1 重来）。
    unregisterCaptainChild(leaderRow.sessionId);
  });

  it('resolves the builder child via the build session file (构建师子代理身份面)', async () => {
    const h = await installFull();
    await reportBuildProgress(stateRoot(), { request: '造个角色', step: '收到需求' });
    await markBuilderChild(stateRoot(), 'build-child-id');

    const got = await h.get('/eteams-api/session-identity?sessionId=build-child-id');
    expect(got.code, got.body).toBe(200);
    const body = json<{
      empty: boolean;
      kind: string;
      name: string;
      teamId: string | null;
      teamName: string | null;
      avatar: unknown;
    }>(got.body);
    expect(body.empty).toBe(false);
    expect(body.kind).toBe('builder');
    expect(body.name).toBe('角色构建师');
    expect(body.teamId).toBeNull();
    expect(body.teamName).toBeNull();
    expect(body.avatar).not.toBeNull();
  });

  it('hides unrelated subagent sessions (无关子代理 → empty)', async () => {
    const h = await installFull();
    const got = await h.get('/eteams-api/session-identity?sessionId=sess-child-999');
    expect(got.code, got.body).toBe(200);
    expect(json<{ empty: boolean }>(got.body).empty).toBe(true);
    // 缺参（主对话误查此端点同款）也是 empty，不报错。
    const blank = await h.get('/eteams-api/session-identity');
    expect(blank.code, blank.body).toBe(200);
    expect(json<{ empty: boolean }>(blank.body).empty).toBe(true);
  });

  it("hides removed members' sessions (离职截断 → empty)", async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '离职队', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const added = await h.post(`/eteams-api/team/${teamId}/member`, {
      name: 'Alice',
      role: 'researcher',
    });
    const employeeId = json<{ member: { employeeId: number | null } }>(added.body).member
      .employeeId;
    expect(employeeId).not.toBeNull();
    const made = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '接力任务',
      chain: [{ member: 'Alice', stageBrief: '调研' }],
    });
    const taskId = json<{ taskId: number }>(made.body).taskId;
    await h.post('/eteams-api/presence', { sessionId: 'cap-conv' });
    const assigned = await h.call!('eteams_assign_task', { taskId, member: 'Alice' });
    expect(assigned.ok).toBe(true);
    const childId = childIdOf(teamId, 'Alice');
    const before = await h.get(
      `/eteams-api/session-identity?sessionId=${encodeURIComponent(childId)}`,
    );
    expect(json<{ empty: boolean }>(before.body).empty).toBe(false);

    // 工牌收回（移出班底）：副本行留档但身份面失效——resolveCaller 同判据。
    const removed = await h.post(`/eteams-api/team/${teamId}/member/${employeeId}/remove`, {});
    expect(removed.code, removed.body).toBe(200);
    const after = await h.get(
      `/eteams-api/session-identity?sessionId=${encodeURIComponent(childId)}`,
    );
    expect(after.code, after.body).toBe(200);
    expect(json<{ empty: boolean }>(after.body).empty).toBe(true);
  });
});
