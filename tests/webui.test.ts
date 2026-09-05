/**
 * M4 web-surface tests (docs/35 §5/§6): the TeamSnapshot builder over the
 * SQLite state root, the panel write routes, the docs/26 conversation task
 * loop, the GET /board cross-team aggregation and the usage-calendar route —
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
import {
  cancelBuildSession,
  readBuildSession,
  reportBuildProgress,
  setBuildParentSession,
} from '../src/host/runtime/roleBuilder';
import { joinPath } from '../src/host/runtime/base';
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
  call?: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  mem?: (
    agent: { id: string },
    name: string,
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  memberAgent?: (childId: string) => { id: string; session: { header: { cwd: string } } };
}

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
async function installFull(overrides: Partial<ETeamsResolvedConfig> = {}): Promise<SurfaceHarness> {
  const cfg = { ...config, ...overrides };
  const registered: Handler[] = [];
  const captains = new Map<string, { id: string; session: { header: { cwd: string } } }>();
  let childCounter = 0;
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined },
    subagents: {
      async startContinuable() {
        const childId = `sess-child-${++childCounter}`;
        return { childId, messageId: 'm-fake' };
      },
      async followup() {
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
  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const tool = captainTools.find((t) => t.name === name);
    if (!tool) throw new Error(`missing captain tool ${name}`);
    return (await tool.execute(
      args as never,
      {
        agent: captainAgent,
        signal: undefined,
      } as never,
    )) as Record<string, unknown>;
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
  return {
    handler,
    get: async (url) => fire(handler, 'GET', url),
    post: async (path, body) => fire(handler, 'POST', path, body ?? {}),
    call,
    mem,
    memberAgent,
  };
}

/** Instance row → live child session id (member identity anchor). */
function childIdOf(teamId: number, name: string): string {
  const team = readTeam(teamId);
  const row = team.taskMembers
    .filter((r) => r.name === name && r.childSessionId !== '' && r.status !== 'removed')
    .at(-1);
  if (row === undefined) throw new Error(`成员 ${name} 还没有起会话`);
  return row.childSessionId;
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
    // 进度只统计真实小任务（任务单容器不计入）。
    expect(snap.progress).toEqual({ completed: 0, total: 2, cancelled: 0, active: 1 });
    const captain = snap.captain as {
      name: string;
      employeeId: string;
      role: string;
      personaMd: string | null;
      avatar: { seed: number; salt: number };
    };
    expect(captain.name).toBe('项目牧羊人');
    expect(captain.employeeId).toMatch(/^ET-\d{4}$/);
    expect(captain.personaMd).toContain('核心使命');
    expect(typeof captain.avatar.seed).toBe('number');

    const members = snap.members as Array<{
      name: string;
      employeeId: string | null;
      role: string;
      currentTaskId: number | null;
      childId: string | null;
      status: string;
      model: string | null;
      removed: boolean;
    }>;
    expect(members.map((m) => m.name)).toEqual(['Alice', 'Bob']);
    expect(members[0]!.currentTaskId).toBe(t1);
    expect(members[0]!.status).toBe('working');
    expect(members[0]!.childId).toMatch(/^sess-child-/);
    expect(members[0]!.employeeId).toMatch(/^ET-\d{4}$/);
    expect(members[0]!.removed).toBe(false);
    expect(members[1]!.status).toBe('staged');

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
    }>;
    const v1 = tasks.find((t) => t.taskId === t1)!;
    expect(v1.status).toBe('wait');
    expect(v1.assignee).toBe('Alice');
    expect(v1.kind).toBe('task');
    expect(v1.parentId).toBeNull();
    expect(v1.chain.map((s) => s.stationStatus)).toEqual(['current', 'pending']);
    expect(v1.attemptSummary).toHaveLength(1);
    const v2 = tasks.find((t) => t.taskId === t2)!;
    expect(v2.status).toBe('ready');
    expect(v2.chain).toEqual([]);
    expect(v2.assignee).toBeNull();

    const events = snap.latestEvents as Array<{ type: string; text: string }>;
    expect(events.some((e) => e.type === 'team.created')).toBe(true);
    expect(events.some((e) => e.type === 'member.added' && e.text.includes('Alice'))).toBe(true);
    expect(events.some((e) => e.type === 'task.assigned' && e.text.includes('Alice'))).toBe(true);

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
    // 预置（领队 + 角色构建师）随首启播种在库，Alice 是第三个。
    expect(parsed.members).toHaveLength(3);
    expect(parsed.members.find((m) => m.name === 'Alice')!.role).toBe('writer');
  });

  it('seeds preset members once and preserves user edits', async () => {
    const h = await installFake();
    const first = await h.get('/eteams-api/roster');
    const seeded = json<{
      members: { name: string; role: string; avatar?: unknown }[];
    }>(first.body);
    expect(seeded.members.map((m) => m.name)).toEqual(
      expect.arrayContaining(['角色构建师', '项目牧羊人']),
    );
    expect(seeded.members).toHaveLength(2);
    for (const p of seeded.members) expect(p.avatar).toBeDefined();

    const second = await h.get('/eteams-api/roster');
    expect(json<{ members: unknown[] }>(second.body).members).toHaveLength(2);

    await h.post('/eteams-api/roster', {
      name: '角色构建师',
      role: '角色构建师',
      duty: '自定义职责',
    });
    const third = await h.get('/eteams-api/roster');
    const roster = json<{ members: { name: string; duty?: string }[] }>(third.body);
    expect(roster.members).toHaveLength(2);
    expect(roster.members.find((m) => m.name === '角色构建师')!.duty).toBe('自定义职责');
  });

  it('deletes roster members but protects the leader and the role builder', async () => {
    const h = await installFake();
    await h.get('/eteams-api/roster');
    await h.post('/eteams-api/roster', { name: 'Temp', role: 'engineer' });

    const removed = await h.post('/eteams-api/roster/Temp/remove', {});
    expect(removed.code).toBe(200);

    // 领队路由特判 400；角色构建师走 removeRosterMember 的系统保留校验 404。
    const leaderAttempt = await h.post('/eteams-api/roster/项目牧羊人/remove', {});
    expect(leaderAttempt.code).toBe(400);
    const builderAttempt = await h.post('/eteams-api/roster/角色构建师/remove', {});
    expect(builderAttempt.code).toBe(404);

    const r = await h.get('/eteams-api/roster');
    const parsed = json<{ members: { name: string }[] }>(r.body);
    expect(parsed.members.find((m) => m.name === 'Temp')).toBeUndefined();
    expect(parsed.members.find((m) => m.name === '项目牧羊人')).toBeDefined();
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
    expect(readTeam(teamId).members).toHaveLength(1);

    const removed = await h.post(`/eteams-api/team/${teamId}/member/Dave/remove`, {});
    expect(removed.code).toBe(200);
    const fresh = readTeam(teamId);
    expect(
      fresh.taskMembers.filter((r) => r.name === 'Dave').every((r) => r.status === 'removed'),
    ).toBe(true);
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
    expect(fresh.members[0]!.persona.skills).toBe('实现与测试');
    expect(fresh.members[0]!.persona.executionPrompt).toBe('你是 Bob。');
    // taskMembers[0] 是领队行（建队即 ready）；Bob 的实例行 = staged 未锚定。
    expect(fresh.taskMembers.find((r) => r.name === 'Bob')!.status).toBe('staged');
    const snap = teamSnapshot(fresh, workspace, config);
    expect((snap.members as { name: string; status: string }[])[0]!.status).toBe('staged');
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
    expect(fresh.members[0]!.avatar?.seed).toBe(stored.avatar!.seed);

    const snap = teamSnapshot(fresh, workspace, config);
    const member = (snap.members as { name: string; avatar: { seed: number } }[]).find(
      (m) => m.name === 'Cara',
    )!;
    expect(member.avatar.seed).toBe(stored.avatar!.seed);
    expect((snap.captain as { name: string }).name).toBe('项目牧羊人');
  });

  it('carries the preset personaMd through adoption and spawn rendering', async () => {
    const h = await installFake();
    await h.get('/eteams-api/roster');
    const created = await h.post('/eteams-api/team', { name: '手册团队', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: '角色构建师', fromRoster: true });
    const md = readTeam(teamId).members[0]!.persona.personaMd;
    expect(md).toBeDefined();
    // 逐字原文（agency-agents-zh），不是蒸馏摘要。
    expect(md).toContain('核心使命');
    expect(md).toContain('关键规则');
    const { renderPersonaBlock } = await import('../src/host/prompts/personas/framework');
    const block = renderPersonaBlock(readTeam(teamId).members[0]!.persona, '角色构建师');
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

  it('allocates sequential integer ids on roster upsert and keeps them on update', async () => {
    const h = await installFake();
    const first = await h.post('/eteams-api/roster', { name: 'Alice', role: 'researcher' });
    const second = await h.post('/eteams-api/roster', { name: 'Bob', role: 'engineer' });
    const a1 = json<{ member: { employeeId?: number } }>(first.body).member.employeeId;
    const b1 = json<{ member: { employeeId?: number } }>(second.body).member.employeeId;
    expect(typeof a1).toBe('number');
    expect(b1).toBe(a1! + 1);
    // 更新保留原号。
    const updated = await h.post('/eteams-api/roster', { name: 'Alice', role: 'writer' });
    expect(json<{ member: { employeeId?: number } }>(updated.body).member.employeeId).toBe(a1);
    // GET /roster 补齐全部成员工号且唯一。
    const seeded = await h.get('/eteams-api/roster');
    const parsed = json<{ members: { name: string; employeeId?: number }[] }>(seeded.body);
    const ids = parsed.members.map((m) => m.employeeId);
    for (const id of ids) expect(typeof id).toBe('number');
    expect(new Set(ids).size).toBe(ids.length);
    // 计数器继续走：下一次 upsert 不复用任何已发号。
    const third = await h.post('/eteams-api/roster', { name: 'Cara', role: 'tester' });
    const c1 = json<{ member: { employeeId?: number } }>(third.body).member.employeeId;
    expect(ids).not.toContain(c1);
  });

  it('adopts the roster 工号 when pulling a member into a team', async () => {
    const h = await installFake();
    const saved = await h.post('/eteams-api/roster', { name: 'Bob', role: 'engineer' });
    const rosterId = json<{ member: { employeeId?: number } }>(saved.body).member.employeeId;
    expect(typeof rosterId).toBe('number');
    const created = await h.post('/eteams-api/team', { name: '共号团队', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const added = await h.post(`/eteams-api/team/${teamId}/member`, {
      name: 'Bob',
      fromRoster: true,
    });
    expect(added.code).toBe(200);
    expect(readTeam(teamId).members[0]!.employeeId).toBe(rosterId);
  });

  it('allocates a fresh non-colliding 工号 for direct adds without a roster entry', async () => {
    const h = await installFake();
    const created = await h.post('/eteams-api/team', { name: '直加团队', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const added = await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Ghost' });
    expect(added.code).toBe(200);
    const directId = readTeam(teamId).members[0]!.employeeId;
    expect(typeof directId).toBe('number');
    // 后续 roster upsert 取下一个号，不与团队直加撞号。
    await h.post('/eteams-api/roster', { name: 'Later', role: 'tester' });
    const seeded = await h.get('/eteams-api/roster');
    const parsed = json<{ members: { name: string; employeeId?: number }[] }>(seeded.body);
    const ids = parsed.members.map((m) => m.employeeId);
    expect(ids).not.toContain(directId);
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
    expect(captain.name).toBe('项目牧羊人');
    expect(captain.employeeId).toMatch(/^ET-\d{4}$/);
  });

  it('accepts an explicit 工号 and a sourceName copy (same role twice)', async () => {
    const h = await installFake();
    await h.post('/eteams-api/roster', { name: '文档织娘', role: '文档工程师' });
    const created = await h.post('/eteams-api/team', { name: '同角多人', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;

    // 第一份：显式工号（纯数字串）压过名册号。
    const first = await h.post(`/eteams-api/team/${teamId}/member`, {
      name: '文档织娘',
      fromRoster: true,
      employeeId: '9001',
    });
    expect(first.code).toBe(200);
    const m1 = readTeam(teamId).members.find((m) => m.name === '文档织娘')!;
    expect(m1.employeeId).toBe(9001);
    const snap = teamSnapshot(readTeam(teamId), workspace, config);
    expect(
      (snap.members as { name: string; employeeId: string }[]).find((m) => m.name === '文档织娘')!
        .employeeId,
    ).toBe('ET-9001');

    // 第二份：sourceName 指向名册条目，角色默认随拷；工号由宿主续发。
    const second = await h.post(`/eteams-api/team/${teamId}/member`, {
      name: '文档织娘-2',
      sourceName: '文档织娘',
      fromRoster: true,
    });
    expect(second.code).toBe(200);
    const m2 = readTeam(teamId).members.find((m) => m.name === '文档织娘-2')!;
    expect(m2.role).toBe('文档工程师');
    expect(m2.employeeId).not.toBe(9001);
  });

  it('sets and resets a member model route via POST /team/:id/member/:name/model', async () => {
    const h = await installFake();
    await h.post('/eteams-api/roster', { name: 'Nova', role: 'engineer' });
    const created = await h.post('/eteams-api/team', { name: '模型团队', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Nova', fromRoster: true });

    const set = await h.post(`/eteams-api/team/${teamId}/member/Nova/model`, {
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
    });
    expect(set.code).toBe(200);
    const overridden = readTeam(teamId).members[0]!.modelRoute;
    expect(overridden).toMatchObject({ model: 'deepseek-reasoner', reasoningEffort: 'high' });

    // 空 body = 跟随领队 — 路线清回空（派发时解析）。
    const reset = await h.post(`/eteams-api/team/${teamId}/member/Nova/model`, {});
    expect(reset.code).toBe(200);
    const inherited = readTeam(teamId).members[0]!.modelRoute;
    expect(inherited.model).toBe('');
    expect(inherited.reasoningEffort).toBeUndefined();
    const snap = teamSnapshot(readTeam(teamId), workspace, config);
    const member = (
      snap.members as { name: string; model: string; reasoningEffort: string | null }[]
    ).find((m) => m.name === 'Nova')!;
    expect(member.model).toBe('');
    expect(member.reasoningEffort).toBeNull();
  });

  it('toggles the leader in/out via POST /team/:id/leader/:action', async () => {
    const h = await installFake();
    const created = await h.post('/eteams-api/team', { name: '领队移除', sessionId: 'sess-panel' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    expect(teamSnapshot(readTeam(teamId), workspace, config).leaderRemoved).toBe(false);

    const remove = await h.post(`/eteams-api/team/${teamId}/leader/remove`, {});
    expect(remove.code).toBe(200);
    expect(
      readTeam(teamId).taskMembers.find((r) => r.mainTaskId === null && r.name === '项目牧羊人')!
        .status,
    ).toBe('removed');
    expect(teamSnapshot(readTeam(teamId), workspace, config).leaderRemoved).toBe(true);

    // 幂等重发不翻转。
    await h.post(`/eteams-api/team/${teamId}/leader/remove`, {});
    expect(
      readTeam(teamId).taskMembers.some((r) => r.name === '项目牧羊人' && r.status === 'removed'),
    ).toBe(true);

    // 领队行 removed 后 restore 走通（requireTeamById 放行 removed 行，
    // 身份仍按 main_session_id 锚定；需要活跃领队的操作自带更严守卫）。
    const restore = await h.post(`/eteams-api/team/${teamId}/leader/restore`, {});
    expect(restore.code, restore.body).toBe(200);
    expect(teamSnapshot(readTeam(teamId), workspace, config).leaderRemoved).toBe(false);
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
    // 领队行 + 8 个在册成员行（成员-9 移出、成员-10 补位）。
    expect(readTeam(teamId).taskMembers.filter((r) => r.status !== 'removed')).toHaveLength(10);
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
    // 会话建，工具身份才能对上（领队行 mainSessionId === cap-conv）。
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

    // 建任务即分配 work_dir 并物化文档树（docs/35 §3#8）——路由打开的就是它。
    const task = readTeam(teamId).tasks.find((t) => t.id === taskId)!;
    expect(task.workDir).toBeDefined();
    const dir = join(workspace, task.workDir!);
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
    expect(readTeam(teamId).members[0]!.persona.personaMd).toBe('# Eve 自定义手册');

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
    // 200 落库，快照 captain 带回路线；空 model 重置为会话默认。
    const leaderModel = await h.post(`/eteams-api/team/${teamId}/leader/model`, {
      model: 'deepseek-chat',
      reasoningEffort: 'low',
    });
    expect(leaderModel.code).toBe(200);
    const state = await h.get('/eteams-api/state');
    const team = json<{
      teams: { teamId: number; captain: { model?: string; reasoningEffort?: string | null } }[];
    }>(state.body).teams.find((t) => t.teamId === teamId)!;
    expect(team.captain.model).toBe('deepseek-chat');
    expect(team.captain.reasoningEffort).toBe('low');
    const reset = await h.post(`/eteams-api/team/${teamId}/leader/model`, {});
    expect(reset.code).toBe(200);
    const state2 = await h.get('/eteams-api/state');
    const team2 = json<{ teams: { teamId: number; captain: { model?: string } }[] }>(
      state2.body,
    ).teams.find((t) => t.teamId === teamId)!;
    expect(team2.captain.model ?? '').toBe('');
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
  it('binds and clears the session team via POST /session-team (团队必须存在)', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '绑定团队', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const bind = await h.post('/eteams-api/session-team', {
      sessionId: 'sess-a',
      teamId: String(teamId),
    });
    expect(bind.code).toBe(200);
    // 过期选择（团队已删）→ 404，不是静默绑上。
    const bad = await h.post('/eteams-api/session-team', { sessionId: 'sess-a', teamId: 'ghost' });
    expect(bad.code).toBe(404);
    const blank = await h.post('/eteams-api/session-team', { sessionId: 'sess-a', teamId: '' });
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

    // 1. 对话提交：立即生成任务单（group 容器，新建即 ready）+ 专属文件夹。
    const submitted = await h.call!('eteams_submit_task', {
      subject: '官网迁移',
      description: '把官网迁到新域名',
      questionnaire: ['交付形式？', '验收偏好？'],
    });
    expect(submitted.ok).toBe(true);
    expect(submitted.status).toBe('ready');
    let team = readTeam(teamId);
    const group = team.tasks[0]!;
    expect(group.parentId).toBeNull();
    expect(submitted.taskId).toBe(group.id);
    expect(submitted.folder).toBe(group.workDir);
    expect(existsSync(join(workspace, group.workDir!, 'contract.md'))).toBe(true);
    expect(existsSync(join(workspace, group.workDir!, 'notes.md'))).toBe(true);

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
    expect(subRec.workDir).toContain('/sub/');

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
    expect(subView.kind).toBe('task');
    expect(subView.parentId).toBe(group.id);
    expect(subView.folder).toContain('sub/');
    const groupView = views.find((t) => t.taskId === group.id)!;
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

    // 8. 成员对话时间线：指派邮件 + 进度可见；完成后无当前任务。
    const dialog = await h.get(`/eteams-api/team/${teamId}/member/Bob/dialog`);
    expect(dialog.code).toBe(200);
    const dialogBody = json<{
      memberStatus: string;
      currentTaskId: number | null;
      items: unknown[];
    }>(dialog.body);
    expect(dialogBody.currentTaskId).toBeNull();
    expect(dialogBody.items.length).toBeGreaterThan(0);
    const unknownDialog = await h.get(`/eteams-api/team/${teamId}/member/Ghost/dialog`);
    expect(unknownDialog.code).toBe(404);
  });

  it('accepts numeric parentTaskId and rewrites dependencies via the update route (七轮 DA20)', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '顺序团队', sessionId: 'cap-conv' });
    const teamId = json<{ teamId: number }>(created.body).teamId;
    const group = ((await h.call!('eteams_submit_task', { subject: '主任务' })) as { taskId: number })
      .taskId;

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

    // 甲队：两个任务单 + 一个独立任务。
    const group1 = (
      (await h.call!('eteams_submit_task', { subject: '主任务一' })) as {
        taskId: number;
      }
    ).taskId;
    const group2 = (
      (await h.call!('eteams_submit_task', { subject: '主任务二' })) as {
        taskId: number;
      }
    ).taskId;
    const group3 = (
      (await h.call!('eteams_submit_task', { subject: '主任务三' })) as {
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
    const subC = await makeSub('子任务B一', group2, 'Bob');
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
    // subD：Bob 再领一单（group3 → 第二条实例行）；停在 wait（看板第二列）。
    await h.call!('eteams_assign_task', { taskId: subD, member: 'Bob' });
    // subF：Alice 在另一支大任务上失败（重试预算 0 → wait_decision + 决策）。
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
          members: { name: string; status: string; activeTasks: number; isLeader: boolean }[];
          decisions: { taskId: number; error: string; retryCount: number }[];
        }[]
      >;
      serverTime: number;
    }>(board.body).teams;
    expect(teams).toHaveLength(2);

    const a = teams.find((t) => t.teamId === teamA)!;
    expect(a.name).toBe('聚合甲');
    expect(a.ready.map((t) => t.taskId)).toEqual([subE]);
    expect(a.ready[0]!.subject).toBe('独立小任务');
    expect(a.columns.paused.map((t) => t.taskId)).toEqual([subA]);
    expect(a.columns.wait.map((t) => t.taskId)).toEqual([subD]);
    expect(a.columns.wait_decision.map((t) => t.taskId)).toEqual([subF]);
    expect(a.columns.start).toEqual([]);
    expect(a.columns.wait_user).toEqual([]);
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
    // Q5 按名去重：Alice/Bob 各两条实例行（跨大任务）但各一行成员行；
    // 领队行带 isLeader 标记。
    const names = a.members.map((m) => m.name);
    expect(names.filter((n) => n === 'Alice')).toHaveLength(1);
    expect(names.filter((n) => n === 'Bob')).toHaveLength(1);
    expect(
      readTeam(teamA).taskMembers.filter((r) => r.name === 'Alice' && r.status !== 'removed'),
    ).toHaveLength(2);
    // activeTasks 按任务占用计（current_member 落在活跃五态）：subA 挂起与
    // subF 失败进决策都释放了执行者（freeMember 清 current_member）——
    // Alice 名下无占位任务，Bob 的 subD 还在 wait。
    expect(a.members.find((m) => m.name === 'Alice')!.activeTasks).toBe(0);
    expect(a.members.find((m) => m.name === 'Alice')!.status).toBe('ready');
    expect(a.members.find((m) => m.name === 'Bob')!.activeTasks).toBe(1);
    expect(a.members.find((m) => m.name === 'Bob')!.status).toBe('working');
    expect(a.members.find((m) => m.name === 'Bob')!.isLeader).toBe(false);
    expect(a.members.find((m) => m.name === '项目牧羊人')!.isLeader).toBe(true);
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
   * `agents.get(parentSessionId)` — tests control who is "online". */
  async function installResumeFake(): Promise<{
    handler: Handler;
    captains: Map<string, { id: string; session: { header: { cwd: string } } }>;
  }> {
    const registered: Handler[] = [];
    const captains = new Map<string, { id: string; session: { header: { cwd: string } } }>();
    const ctx = surfaceCtx(captains, registered);
    installWebSurface(ctx, config);
    return { handler: registered[0]!, captains };
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
    const registered: Handler[] = [];
    const captains = new Map<string, { id: string; session: { header: { cwd: string } } }>();
    captains.set('cap-online', { id: 'cap-online', session: { header: { cwd: workspace } } });
    const ctx = surfaceCtx(captains, registered);
    installWebSurface(ctx, config);
    const handler = registered[0]!;
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
  });
});
