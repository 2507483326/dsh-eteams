/**
 * M4 web-surface tests: the TeamSnapshot builder over real on-disk state
 * (docs/12.2 shape) and the event summarizer, driven offline through the
 * runtime ops with a fake subagent runtime.
 */
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { ETeamsConfig, type ETeamsResolvedConfig } from '../src/host/config';
import { createCaptainTools } from '../src/host/tools/captainTools';
import { createMemberTools } from '../src/host/tools/memberTools';
import { installWebSurface, summarizeEvent, teamSnapshot } from '../src/host/runtime/webui';
import { archiveRoot } from '../src/host/state/events';
import { taskSlug } from '../src/host/model/taskMachine';
import type { TeamState } from '../src/host/model/types';

let workspace: string;
let config: ETeamsResolvedConfig;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'eteams-webui-'));
  config = ETeamsConfig({}) as ETeamsResolvedConfig;
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** Minimal host ctx: no subagents (members stay staged), no services. */
function fakeCtx(): {
  ctx: Context;
  tools: ReturnType<typeof createCaptainTools>;
  call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
} {
  const ctx = {
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
  const tools = createCaptainTools(config, ctx);
  const captain = { id: 'cap-webui', session: { header: { cwd: workspace } } };
  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return (await tool.execute(
      args as never,
      { agent: captain, signal: undefined } as never,
    )) as Record<string, unknown>;
  };
  return { ctx, tools, call };
}

function readTeamFromDisk(teamId: string): TeamState {
  return JSON.parse(readFileSync2(join(workspace, '.eteams', teamId, 'team.json'))) as TeamState;
}

import { readFileSync } from 'node:fs';
function readFileSync2(file: string): string {
  return readFileSync(file, 'utf8');
}

describe('TeamSnapshot builder (docs/12.2)', () => {
  it('projects members, tasks, chain stations, progress and events', async () => {
    const { ctx, call } = fakeCtx();
    const created = await call('eteams_create_team', { name: '面板测试', goal: '验证快照' });
    const teamId = created.teamId as string;
    await call('eteams_add_member', { name: 'Alice', role: 'researcher', teamId });
    await call('eteams_add_member', { name: 'Bob', role: 'engineer', teamId });
    await call('eteams_create_task', {
      subject: '建站任务',
      chain: [
        { member: 'Alice', stageBrief: '调研' },
        { member: 'Bob', stageBrief: '实现' },
      ],
    });
    await call('eteams_create_task', { subject: '普通任务' });
    // headless approve (fake spawn assigns childId c1 to both members)
    const approveTool = false; // approvePlan is runtime-level; drive via export
    void approveTool;
    const { approvePlan } = await import('../src/host/runtime/teamOps');
    const env = { ctx, config, workspace };
    await approvePlan(
      env,
      { id: 'cap-webui', session: { header: { cwd: workspace } } } as never,
      teamId,
    );
    await call('eteams_assign_task', { taskId: 't1', member: 'Alice' });

    const snap = teamSnapshot(readTeamFromDisk(teamId), workspace, config);
    expect(snap.teamId).toBe(teamId);
    expect(snap.phase).toBe('running');
    expect(snap.captainSessionId).toBe('cap-webui');
    expect(snap.workDir).toBe('teams/面板测试');
    expect(snap.progress).toEqual({ completed: 0, total: 2, cancelled: 0, active: 1 });

    const members = snap.members as {
      name: string;
      role: string;
      currentTaskId: string | null;
      childId: string;
    }[];
    expect(members.map((m) => m.name)).toEqual(['Alice', 'Bob']);
    expect(members[0]!.currentTaskId).toBe('t1');
    expect(members[0]!.childId).toBe('c1');

    const tasks = snap.tasks as {
      taskId: string;
      status: string;
      chain: { stationStatus: string; member: string }[];
      attemptSummary: unknown[];
    }[];
    const t1 = tasks.find((t) => t.taskId === 't1')!;
    expect(t1.status).toBe('assigned');
    expect(t1.chain.map((s) => s.stationStatus)).toEqual(['current', 'pending']);
    expect(t1.attemptSummary).toHaveLength(1);
    const t2 = tasks.find((t) => t.taskId === 't2')!;
    expect(t2.status).toBe('ready');
    expect(t2.chain).toEqual([]);

    const events = snap.latestEvents as { type: string; text: string }[];
    expect(events.some((e) => e.type === 'plan.approved' && e.text.includes('批准'))).toBe(true);
    expect(events.some((e) => e.type === 'task.assigned' && e.text.includes('Alice'))).toBe(true);
  });

  it('summarizes lifecycle events into one-line zh strings', () => {
    const actor = { kind: 'system' as const };
    expect(summarizeEvent({ seq: 1, at: 0, actor, type: 'plan.approved' })).toContain('批准');
    expect(
      summarizeEvent({
        seq: 2,
        at: 0,
        actor,
        type: 'task.assigned',
        payload: { member: 'Alice', taskId: 't1' },
      }),
    ).toContain('Alice');
    expect(
      summarizeEvent({
        seq: 3,
        at: 0,
        actor,
        type: 'chain.deviated',
        payload: { note: 'Bob 不可用' },
      }),
    ).toContain('偏离');
    expect(summarizeEvent({ seq: 4, at: 0, actor, type: 'custom.future' })).toBe('custom.future');
  });
});

describe('panel write routes (M5 first slice)', () => {
  /** Install the web surface against a minimal registry ctx; return the handler. */
  async function installFake(): Promise<{
    handler: (req: unknown, res: unknown) => Promise<void>;
    res: () => {
      code: number;
      body: string;
      writeHead(code: number): void;
      end(data?: string): void;
    };
    post: (path: string, body: unknown) => Promise<{ code: number; body: string }>;
  }> {
    const registered: { handler: (req: unknown, res: unknown) => Promise<void> }[] = [];
    const ctx = {
      get: (key: string) =>
        key === 'webServer'
          ? {
              register: (route: { handler: (req: unknown, res: unknown) => Promise<void> }) => {
                registered.push(route);
              },
            }
          : key === 'workspaceRegistry'
            ? { list: () => [{ path: workspace, title: 'ws' }] }
            : undefined,
      // delete/archive ops resolve the captain's live agent through the
      // registry (absent here → the op falls back to the session-id agent).
      agents: { get: () => undefined },
      effect: (fn: () => unknown) => {
        fn();
        return () => undefined;
      },
      logger: { info: () => undefined, warn: () => undefined },
    } as unknown as Context;
    installWebSurface(ctx, config);
    const handler = registered[0]!.handler;
    const res = () => ({
      code: 0,
      body: '',
      writeHead(code: number) {
        this.code = code;
      },
      end(data?: string) {
        this.body = data ?? '';
      },
    });
    const post = async (path: string, body: unknown) => {
      const r = res();
      const payload = JSON.stringify(body);
      await handler(
        {
          method: 'POST',
          url: path,
          on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data') cb(Buffer.from(payload, 'utf8'));
            if (event === 'end') cb();
          },
        },
        r,
      );
      return { code: r.code, body: r.body };
    };
    return { handler, res, post };
  }

  it('upserts roster entries and serves GET /roster', async () => {
    const { handler, res, post } = await installFake();
    await post('/eteams-api/roster', { name: 'Alice', role: 'researcher', duty: '调研与检索' });
    const again = await post('/eteams-api/roster', {
      name: 'Alice',
      role: 'writer',
      style: '简洁',
    });
    expect(again.code).toBe(200);
    const r = res();
    await handler({ method: 'GET', url: '/eteams-api/roster' }, r);
    expect(r.code).toBe(200);
    const parsed = JSON.parse(r.body) as { members: { name: string; role: string }[] };
    // 角色构建师 (D18-3) + the leader are seeded on first GET (2026-09 起
    // 默认角色仅此两项); Alice upserts on top.
    expect(parsed.members).toHaveLength(3);
    expect(parsed.members.find((m) => m.name === 'Alice')!.role).toBe('writer');
  });

  it('seeds preset members once and preserves user edits', async () => {
    const { handler, res, post } = await installFake();
    const r1 = res();
    await handler({ method: 'GET', url: '/eteams-api/roster' }, r1);
    const first = JSON.parse(r1.body) as {
      members: { name: string; role: string; avatar?: unknown }[];
    };
    const presetNames = ['角色构建师'];
    expect(first.members.map((m) => m.name)).toEqual(expect.arrayContaining(presetNames));
    // The leader (项目牧羊人) is also a preset member (默认入团、不可删除).
    const leader = first.members.find((m) => m.name === '项目牧羊人')!;
    expect(leader).toBeDefined();
    expect(leader.role).toContain('领队');
    expect(first.members).toHaveLength(2);
    for (const p of first.members) expect(p.avatar).toBeDefined();

    // Second GET is idempotent — no duplicates.
    const r2 = res();
    await handler({ method: 'GET', url: '/eteams-api/roster' }, r2);
    expect((JSON.parse(r2.body) as { members: unknown[] }).members).toHaveLength(2);

    // User edit to a preset is preserved on later GETs.
    await post('/eteams-api/roster', {
      name: '角色构建师',
      role: '角色构建师',
      duty: '自定义职责',
    });
    const r3 = res();
    await handler({ method: 'GET', url: '/eteams-api/roster' }, r3);
    const third = JSON.parse(r3.body) as { members: { name: string; duty?: string }[] };
    expect(third.members).toHaveLength(2);
    expect(third.members.find((m) => m.name === '角色构建师')!.duty).toBe('自定义职责');
  });

  it('deletes roster members but protects the leader', async () => {
    const { handler, res, post } = await installFake();
    const seeded = res();
    await handler({ method: 'GET', url: '/eteams-api/roster' }, seeded);
    await post('/eteams-api/roster', { name: 'Temp', role: 'engineer' });

    const removed = await post('/eteams-api/roster/Temp/remove', {});
    expect(removed.code).toBe(200);

    const leaderAttempt = await post('/eteams-api/roster/项目牧羊人/remove', {});
    expect(leaderAttempt.code).toBe(400);

    const r = res();
    await handler({ method: 'GET', url: '/eteams-api/roster' }, r);
    const parsed = JSON.parse(r.body) as { members: { name: string }[] };
    expect(parsed.members.find((m) => m.name === 'Temp')).toBeUndefined();
    expect(parsed.members.find((m) => m.name === '项目牧羊人')).toBeDefined();
  });

  it('removes a team member via the panel route', async () => {
    const { handler, res, post } = await installFake();
    const seeded = res();
    await handler({ method: 'GET', url: '/eteams-api/roster' }, seeded);
    await post('/eteams-api/roster', { name: 'Dave', role: 'engineer' });
    const created = await post('/eteams-api/team', {
      name: '移出团队测试',
      sessionId: 'sess-panel',
    });
    const teamId = (JSON.parse(created.body) as { teamId: string }).teamId;
    const added = await post(`/eteams-api/team/${teamId}/member`, {
      name: 'Dave',
      fromRoster: true,
    });
    expect(added.code).toBe(200);
    expect(readTeamFromDisk(teamId).members).toHaveLength(1);

    const removed = await post(`/eteams-api/team/${teamId}/member/Dave/remove`, {});
    expect(removed.code).toBe(200);
    const fresh = readTeamFromDisk(teamId);
    expect(fresh.members.filter((m) => m.status !== 'removed')).toHaveLength(0);
  });

  it('creates a staged team via POST /team and adopts a roster member', async () => {
    const { post } = await installFake();
    const saved = await post('/eteams-api/roster', {
      name: 'Bob',
      role: 'engineer',
      skills: '实现与测试',
      executionPrompt: '你是 Bob。',
    });
    expect(saved.code).toBe(200);
    // Name-only creation (docs/13.x IA): no goal field — the host supplies a
    // placeholder the captain refines in conversation.
    const created = await post('/eteams-api/team', {
      name: '面板建队',
      sessionId: 'sess-panel',
    });
    expect(created.code).toBe(200);
    const teamId = (JSON.parse(created.body) as { teamId: string }).teamId;
    const team = readTeamFromDisk(teamId);
    expect(team.phase).toBe('staged');
    expect(team.captainSessionId).toBe('sess-panel');
    expect(team.goal).toContain('待完善');

    const added = await post(`/eteams-api/team/${teamId}/member`, {
      name: 'Bob',
      fromRoster: true,
    });
    expect(added.code).toBe(200);
    const fresh = readTeamFromDisk(teamId);
    expect(fresh.members).toHaveLength(1);
    expect(fresh.members[0]!.persona.skills).toBe('实现与测试');
    expect(fresh.members[0]!.persona.executionPrompt).toBe('你是 Bob。');
    const rosterMember = fresh.members[0]!;
    expect(rosterMember.status).toBe('staged');
  });

  it('pre-generates a roster avatar and the adopted team member inherits it', async () => {
    const { handler, res, post } = await installFake();
    const saved = await post('/eteams-api/roster', { name: 'Cara', role: '前端开发者' });
    expect(saved.code).toBe(200);
    const stored = (
      JSON.parse(saved.body) as { member: { avatar?: { seed: number; salt: number } } }
    ).member;
    expect(typeof stored.avatar?.seed).toBe('number');
    expect(typeof stored.avatar?.salt).toBe('number');

    const created = await post('/eteams-api/team', { name: '头像团队', sessionId: 'sess-panel' });
    const teamId = (JSON.parse(created.body) as { teamId: string }).teamId;
    await post(`/eteams-api/team/${teamId}/member`, { name: 'Cara', fromRoster: true });
    const fresh = readTeamFromDisk(teamId);
    expect(fresh.members[0]!.avatar).toEqual(stored.avatar);

    // Snapshot projection exposes the avatar pair for the panel renderer.
    const { teamSnapshot } = await import('../src/host/runtime/webui');
    const snap = teamSnapshot(fresh, workspace, config);
    const member = (snap.members as { name: string; avatar: unknown }[]).find(
      (m) => m.name === 'Cara',
    )!;
    expect(member.avatar).toEqual(stored.avatar);
    // The captain (项目牧羊人) travels with the snapshot for the leader card.
    const captain = snap.captain as {
      name: string;
      role: string;
      personaMd: string | null;
      avatar: { seed: number; salt: number };
    };
    expect(captain.name).toBe('项目牧羊人');
    expect(captain.role).toContain('领队');
    expect(captain.personaMd).toContain('核心使命');
    expect(typeof captain.avatar.seed).toBe('number');
    void handler;
    void res;
  });

  it('carries the preset personaMd through adoption and spawn rendering', async () => {
    const { handler, res, post } = await installFake();
    // GET /roster triggers the preset seeding, then adopt the preset member.
    const seeded = res();
    await handler({ method: 'GET', url: '/eteams-api/roster' }, seeded);
    const created = await post('/eteams-api/team', { name: '手册团队', sessionId: 'sess-panel' });
    const teamId = (JSON.parse(created.body) as { teamId: string }).teamId;
    await post(`/eteams-api/team/${teamId}/member`, { name: '角色构建师', fromRoster: true });
    const fresh = readTeamFromDisk(teamId);
    const md = fresh.members[0]!.persona.personaMd;
    expect(md).toBeDefined();
    // Verbatim agency-agents-zh source markers (not a distilled summary).
    expect(md).toContain('核心使命');
    expect(md).toContain('关键规则');
    const { renderPersonaBlock } = await import('../src/host/prompts/persona');
    const block = renderPersonaBlock(fresh.members[0]!.persona, '角色构建师');
    expect(block).toContain('# 角色手册');
    expect(block).toContain('核心使命');
  });

  it('rejects adding a roster name that does not exist', async () => {
    const { post } = await installFake();
    const created = await post('/eteams-api/team', {
      name: '拒绝测试',
      sessionId: 'sess-panel',
    });
    const teamId = (JSON.parse(created.body) as { teamId: string }).teamId;
    const added = await post(`/eteams-api/team/${teamId}/member`, {
      name: 'Ghost',
      fromRoster: true,
    });
    expect(added.code).toBe(404);
  });

  // ---------- employee id 工号 (docs/21) ----------

  it('allocates sequential ids on roster upsert and keeps them on update', async () => {
    const { handler, res, post } = await installFake();
    const first = await post('/eteams-api/roster', { name: 'Alice', role: 'researcher' });
    const second = await post('/eteams-api/roster', { name: 'Bob', role: 'engineer' });
    const a1 = (JSON.parse(first.body) as { member: { employeeId?: string } }).member.employeeId;
    const b1 = (JSON.parse(second.body) as { member: { employeeId?: string } }).member.employeeId;
    expect(a1).toBe('ET-0001');
    expect(b1).toBe('ET-0002');
    // Update keeps the existing 工号.
    const updated = await post('/eteams-api/roster', { name: 'Alice', role: 'writer' });
    const a2 = (JSON.parse(updated.body) as { member: { employeeId?: string } }).member.employeeId;
    expect(a2).toBe('ET-0001');
    // GET /roster backfills every member (including presets) with a unique id.
    const seeded = res();
    await handler({ method: 'GET', url: '/eteams-api/roster' }, seeded);
    const parsed = JSON.parse(seeded.body) as {
      members: { name: string; employeeId?: string }[];
    };
    const ids = parsed.members.map((m) => m.employeeId);
    for (const id of ids) expect(id).toMatch(/^ET-\d{4}$/);
    expect(new Set(ids).size).toBe(ids.length);
    // The counter kept moving: the next upsert never reuses a backfilled id.
    const third = await post('/eteams-api/roster', { name: 'Cara', role: 'tester' });
    const c1 = (JSON.parse(third.body) as { member: { employeeId?: string } }).member.employeeId;
    expect(ids).not.toContain(c1);
  });

  it('adopts the roster 工号 when pulling a member into a team', async () => {
    const { post } = await installFake();
    const saved = await post('/eteams-api/roster', { name: 'Bob', role: 'engineer' });
    const rosterId = (JSON.parse(saved.body) as { member: { employeeId?: string } }).member
      .employeeId;
    expect(rosterId).toMatch(/^ET-\d{4}$/);
    const created = await post('/eteams-api/team', { name: '共号团队', sessionId: 'sess-panel' });
    const teamId = (JSON.parse(created.body) as { teamId: string }).teamId;
    const added = await post(`/eteams-api/team/${teamId}/member`, {
      name: 'Bob',
      fromRoster: true,
    });
    expect(added.code).toBe(200);
    const member = readTeamFromDisk(teamId).members[0]!;
    expect(member.employeeId).toBe(rosterId);
  });

  it('allocates a fresh non-colliding 工号 for direct adds without a roster entry', async () => {
    const { handler, res, post } = await installFake();
    const created = await post('/eteams-api/team', { name: '直加团队', sessionId: 'sess-panel' });
    const teamId = (JSON.parse(created.body) as { teamId: string }).teamId;
    const added = await post(`/eteams-api/team/${teamId}/member`, { name: 'Ghost' });
    expect(added.code).toBe(200);
    const directId = readTeamFromDisk(teamId).members[0]!.employeeId;
    expect(directId).toMatch(/^ET-\d{4}$/);
    // A later roster upsert must draw the next number, not collide with it.
    await post('/eteams-api/roster', { name: 'Later', role: 'tester' });
    const seeded = res();
    await handler({ method: 'GET', url: '/eteams-api/roster' }, seeded);
    const parsed = JSON.parse(seeded.body) as {
      members: { name: string; employeeId?: string }[];
    };
    const ids = parsed.members.map((m) => m.employeeId);
    expect(ids).not.toContain(directId);
  });

  it('projects 工号 through the team snapshot (members and captain)', async () => {
    const { handler, res, post } = await installFake();
    await handler({ method: 'GET', url: '/eteams-api/roster' }, res());
    // 2026-09 起预置只保留 角色构建师（persona.ts PRESET_MEMBER_ROLES），
    // 前端开发者不再自动入库——先手动 upsert，再 fromRoster 收编。
    const seeded = await post('/eteams-api/roster', { name: '前端开发者', role: '前端开发者' });
    expect((JSON.parse(seeded.body) as { member: { name: string } }).member.name).toBe(
      '前端开发者',
    );
    const created = await post('/eteams-api/team', { name: '快照团队', sessionId: 'sess-panel' });
    const teamId = (JSON.parse(created.body) as { teamId: string }).teamId;
    const added = await post(`/eteams-api/team/${teamId}/member`, {
      name: '前端开发者',
      fromRoster: true,
    });
    expect(added.code).toBe(200);
    const fresh = readTeamFromDisk(teamId);
    const { teamSnapshot } = await import('../src/host/runtime/webui');
    const snap = teamSnapshot(fresh, workspace, config);
    const member = (snap.members as { name: string; employeeId: string | null }[]).find(
      (m) => m.name === '前端开发者',
    )!;
    expect(member.employeeId).toMatch(/^ET-\d{4}$/);
    const captain = snap.captain as { name: string; employeeId: string };
    expect(captain.name).toBe('项目牧羊人');
    expect(captain.employeeId).toMatch(/^ET-\d{4}$/);
    void handler;
  });

  it('accepts an explicit 工号 and a sourceName copy (same role twice)', async () => {
    const { post } = await installFake();
    await post('/eteams-api/roster', { name: '文档织娘', role: '文档工程师' });
    const created = await post('/eteams-api/team', { name: '同角多人', sessionId: 'sess-panel' });
    const teamId = (JSON.parse(created.body) as { teamId: string }).teamId;

    // First copy: an explicit 工号 (dialog input) wins over the roster id.
    const first = await post(`/eteams-api/team/${teamId}/member`, {
      name: '文档织娘',
      fromRoster: true,
      employeeId: 'ET-9001',
    });
    expect(first.code).toBe(200);
    const m1 = readTeamFromDisk(teamId).members.find((m) => m.name === '文档织娘')!;
    expect(m1.employeeId).toBe('ET-9001');

    // Second copy under a suffixed name: sourceName points at the roster
    // entry so role/persona defaults copy through; blank 工号 → host allocates.
    const second = await post(`/eteams-api/team/${teamId}/member`, {
      name: '文档织娘-2',
      sourceName: '文档织娘',
      fromRoster: true,
    });
    expect(second.code).toBe(200);
    const m2 = readTeamFromDisk(teamId).members.find((m) => m.name === '文档织娘-2')!;
    expect(m2.role).toBe('文档工程师');
    expect(m2.employeeId).toMatch(/^ET-\d{4}$/);
    expect(m2.employeeId).not.toBe('ET-9001');
  });

  it('sets and resets a member model route via POST /team/:id/member/:name/model', async () => {
    const { post } = await installFake();
    await post('/eteams-api/roster', { name: 'Nova', role: 'engineer' });
    const created = await post('/eteams-api/team', { name: '模型团队', sessionId: 'sess-panel' });
    const teamId = (JSON.parse(created.body) as { teamId: string }).teamId;
    await post(`/eteams-api/team/${teamId}/member`, { name: 'Nova', fromRoster: true });

    const set = await post(`/eteams-api/team/${teamId}/member/Nova/model`, {
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
    });
    expect(set.code).toBe(200);
    const overridden = readTeamFromDisk(teamId).members[0]!.modelRoute;
    expect(overridden).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
      source: 'override',
    });

    // Empty body = 跟随领队 — resets the route to inherited.
    const reset = await post(`/eteams-api/team/${teamId}/member/Nova/model`, {});
    expect(reset.code).toBe(200);
    const inherited = readTeamFromDisk(teamId).members[0]!.modelRoute;
    expect(inherited.source).toBe('inherited');
    expect(inherited.model).toBe('inherit');
  });

  it('toggles the leader in/out via POST /team/:id/leader/:action', async () => {
    const { post } = await installFake();
    const created = await post('/eteams-api/team', { name: '领队移除', sessionId: 'sess-panel' });
    const teamId = (JSON.parse(created.body) as { teamId: string }).teamId;
    expect(readTeamFromDisk(teamId).leaderRemoved).toBeUndefined();

    const remove = await post(`/eteams-api/team/${teamId}/leader/remove`, {});
    expect(remove.code).toBe(200);
    expect(readTeamFromDisk(teamId).leaderRemoved).toBe(true);

    // Idempotent repeat keeps the flag.
    await post(`/eteams-api/team/${teamId}/leader/remove`, {});
    expect(readTeamFromDisk(teamId).leaderRemoved).toBe(true);

    const restore = await post(`/eteams-api/team/${teamId}/leader/restore`, {});
    expect(restore.code).toBe(200);
    expect(readTeamFromDisk(teamId).leaderRemoved).toBe(false);
  });

  it('exposes maxMembers and leaderRemoved through GET /state', async () => {
    const { handler, res, post } = await installFake();
    const created = await post('/eteams-api/team', { name: '状态团队', sessionId: 'sess-panel' });
    const teamId = (JSON.parse(created.body) as { teamId: string }).teamId;
    await post(`/eteams-api/team/${teamId}/leader/remove`, {});
    const r = res();
    await handler({ method: 'GET', url: '/eteams-api/state' }, r);
    expect(r.code).toBe(200);
    const body = JSON.parse(r.body) as {
      maxMembers: number;
      teams: { teamId: string; leaderRemoved: boolean }[];
    };
    expect(body.maxMembers).toBe(10);
    expect(body.teams.find((t) => t.teamId === teamId)!.leaderRemoved).toBe(true);
  });

  it('sets the leader model route via POST /team/:id/leader/model and projects it on the captain', async () => {
    const { handler, res, post } = await installFake();
    const created = await post('/eteams-api/team', { name: '领队模型', sessionId: 'sess-panel' });
    const teamId = (JSON.parse(created.body) as { teamId: string }).teamId;

    const set = await post(`/eteams-api/team/${teamId}/leader/model`, {
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
    });
    expect(set.code).toBe(200);
    expect(readTeamFromDisk(teamId).leaderModelRoute).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
      source: 'override',
    });

    const r = res();
    await handler({ method: 'GET', url: '/eteams-api/state' }, r);
    const body = JSON.parse(r.body) as {
      teams: {
        teamId: string;
        captain: { provider: string; model: string; reasoningEffort: string | null };
      }[];
    };
    const captain = body.teams.find((t) => t.teamId === teamId)!.captain;
    expect(captain.provider).toBe('deepseek');
    expect(captain.model).toBe('deepseek-chat');
    expect(captain.reasoningEffort).toBe('high');

    // Empty body clears back to 会话默认（inherited）.
    const reset = await post(`/eteams-api/team/${teamId}/leader/model`, {});
    expect(reset.code).toBe(200);
    expect(readTeamFromDisk(teamId).leaderModelRoute).toMatchObject({
      provider: 'inherit',
      model: 'inherit',
      source: 'inherited',
    });
  });

  it('caps the team at maxMembers people including the leader（领队也算成员，用户迭代 2026-09 六）', async () => {
    const { post } = await installFake();
    const created = await post('/eteams-api/team', { name: '名额团队', sessionId: 'sess-panel' });
    const teamId = (JSON.parse(created.body) as { teamId: string }).teamId;

    // Leader in team (default) → 9 addable members, 10 people total (含领队).
    for (let i = 1; i <= 9; i++) {
      const add = await post(`/eteams-api/team/${teamId}/member`, { name: `成员-${i}` });
      expect(add.code).toBe(200);
    }
    const tenth = await post(`/eteams-api/team/${teamId}/member`, { name: '成员-10' });
    expect(tenth.code).toBe(400);

    // Leader out → the freed slot is addable again (也可以没有领队).
    const remove = await post(`/eteams-api/team/${teamId}/leader/remove`, {});
    expect(remove.code).toBe(200);
    const late = await post(`/eteams-api/team/${teamId}/member`, { name: '成员-10' });
    expect(late.code).toBe(200);

    // Full house (10 members, no leader) → restoring the leader hits the cap.
    const restore = await post(`/eteams-api/team/${teamId}/leader/restore`, {});
    expect(restore.code).toBe(400);
    expect(readTeamFromDisk(teamId).leaderRemoved).toBe(true);

    // One member out → the leader fits again.
    const dropOne = await post(`/eteams-api/team/${teamId}/member/成员-10/remove`, {});
    expect(dropOne.code).toBe(200);
    const restoreOk = await post(`/eteams-api/team/${teamId}/leader/restore`, {});
    expect(restoreOk.code).toBe(200);
    expect(readTeamFromDisk(teamId).leaderRemoved).toBe(false);
  });

  it('deletes a staged team via POST /team/:id/delete (团队列表小卡片删除，用户迭代 2026-09 七)', async () => {
    const { handler, res, post } = await installFake();
    const created = await post('/eteams-api/team', { name: '待删团队', sessionId: 'sess-panel' });
    const teamId = (JSON.parse(created.body) as { teamId: string }).teamId;

    const del = await post(`/eteams-api/team/${teamId}/delete`, {});
    expect(del.code).toBe(200);
    // Directory removed from disk and the team no longer lists in /state.
    expect(existsSync(join(workspace, '.eteams', teamId))).toBe(false);
    const r = res();
    await handler({ method: 'GET', url: '/eteams-api/state' }, r);
    const body = JSON.parse(r.body) as { teams: { teamId: string }[] };
    expect(body.teams.find((t) => t.teamId === teamId)).toBeUndefined();

    // Deleting again (or an unknown id) → 404 from the route locator.
    const again = await post(`/eteams-api/team/${teamId}/delete`, {});
    expect(again.code).toBe(404);
  });

  it('saves the member handbook copy via POST /team/:id/member/:name/persona and projects it in /state', async () => {
    const { handler, res, post } = await installFake();
    await post('/eteams-api/roster', { name: 'Eve', role: 'engineer', personaMd: '# Eve 初版' });
    const created = await post('/eteams-api/team', { name: '手册团队', sessionId: 'sess-panel' });
    const teamId = (JSON.parse(created.body) as { teamId: string }).teamId;
    const added = await post(`/eteams-api/team/${teamId}/member`, {
      name: 'Eve',
      fromRoster: true,
    });
    expect(added.code).toBe(200);

    // 成员详情独立：保存只写成员记录，角色库不受影响。
    const saved = await post(`/eteams-api/team/${teamId}/member/Eve/persona`, {
      personaMd: '# Eve 自定义手册',
    });
    expect(saved.code).toBe(200);
    expect(readTeamFromDisk(teamId).members[0]!.persona.personaMd).toBe('# Eve 自定义手册');

    // Empty handbook is rejected.
    const empty = await post(`/eteams-api/team/${teamId}/member/Eve/persona`, { personaMd: '  ' });
    expect(empty.code).toBe(400);

    // The member's own copy travels with /state (成员详情页的数据源).
    const r = res();
    await handler({ method: 'GET', url: '/eteams-api/state' }, r);
    const body = JSON.parse(r.body) as {
      teams: { teamId: string; members: { name: string; personaMd: string | null }[] }[];
    };
    const member = body.teams.find((t) => t.teamId === teamId)!.members[0]!;
    expect(member.name).toBe('Eve');
    expect(member.personaMd).toBe('# Eve 自定义手册');
  });

  it('syncs the member handbook back to its roster role via POST /team/:id/member/:name/sync-roster', async () => {
    const { handler, res, post } = await installFake();
    await post('/eteams-api/roster', {
      name: 'Frank',
      role: 'engineer',
      personaMd: '# Frank 初版',
    });
    const created = await post('/eteams-api/team', { name: '同步团队', sessionId: 'sess-panel' });
    const teamId = (JSON.parse(created.body) as { teamId: string }).teamId;
    const added = await post(`/eteams-api/team/${teamId}/member`, {
      name: 'Frank',
      fromRoster: true,
    });
    expect(added.code).toBe(200);

    // Member edits its own copy, then syncs back — the roster entry follows.
    await post(`/eteams-api/team/${teamId}/member/Frank/persona`, { personaMd: '# Frank v2' });
    const synced = await post(`/eteams-api/team/${teamId}/member/Frank/sync-roster`, {});
    expect(synced.code).toBe(200);

    const r = res();
    await handler({ method: 'GET', url: '/eteams-api/roster' }, r);
    const roster = JSON.parse(r.body) as { members: { name: string; personaMd?: string }[] };
    expect(roster.members.find((m) => m.name === 'Frank')!.personaMd).toBe('# Frank v2');

    // A copy member without a roster entry gets one created on sync.
    const copy = await post(`/eteams-api/team/${teamId}/member`, {
      name: 'Frank-2',
      sourceName: 'Frank',
    });
    expect(copy.code).toBe(200);
    const copySync = await post(`/eteams-api/team/${teamId}/member/Frank-2/sync-roster`, {
      personaMd: '# Frank-2 副本手册',
    });
    expect(copySync.code).toBe(200);
    const r2 = res();
    await handler({ method: 'GET', url: '/eteams-api/roster' }, r2);
    const roster2 = JSON.parse(r2.body) as {
      members: { name: string; role: string; personaMd?: string }[];
    };
    const entry = roster2.members.find((m) => m.name === 'Frank-2')!;
    expect(entry.role).toBe('engineer');
    expect(entry.personaMd).toBe('# Frank-2 副本手册');
  });
});

describe('conversation task workflow (docs/26)', () => {
  /**
   * Combined harness: the captain/member tool face and the panel web surface
   * share one host ctx (fake subagent runtime hands out sequential childIds),
   * so a test can drive the full loop — 对话提交 → 面板拆解 → 面板批准 →
   * 执行 → 主任务自动收口 — end to end.
   */
  async function installFull(): Promise<{
    handler: (req: unknown, res: unknown) => Promise<void>;
    post: (path: string, body: unknown) => Promise<{ code: number; body: string }>;
    call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    mem: (
      agent: { id: string },
      name: string,
      args: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    memberAgent: (childId: string) => { id: string; session: { header: { cwd: string } } };
  }> {
    const registered: { handler: (req: unknown, res: unknown) => Promise<void> }[] = [];
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
      get: (key: string) =>
        key === 'webServer'
          ? {
              register: (route: { handler: (req: unknown, res: unknown) => Promise<void> }) => {
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
    } as unknown as Context;
    const captainAgent = { id: 'cap-conv', session: { header: { cwd: workspace } } };
    captains.set(captainAgent.id, captainAgent);
    const captainTools = createCaptainTools(config, ctx);
    const memberTools = createMemberTools(config, ctx);
    const call = async (name: string, args: Record<string, unknown>) => {
      const tool = captainTools.find((t) => t.name === name);
      if (!tool) throw new Error(`missing captain tool ${name}`);
      return (await tool.execute(
        args as never,
        { agent: captainAgent, signal: undefined } as never,
      )) as Record<string, unknown>;
    };
    const memberAgent = (childId: string) => ({
      id: childId,
      session: { header: { cwd: workspace } },
    });
    const mem = async (agent: { id: string }, name: string, args: Record<string, unknown>) => {
      const tool = memberTools.find((t) => t.name === name);
      if (!tool) throw new Error(`missing member tool ${name}`);
      return (await tool.execute(args as never, { agent, signal: undefined } as never)) as Record<
        string,
        unknown
      >;
    };
    installWebSurface(ctx, config);
    const handler = registered[0]!.handler;
    const post = async (path: string, body: unknown) => {
      const r = {
        code: 0,
        body: '',
        writeHead(code: number) {
          this.code = code;
        },
        end(data?: string) {
          this.body = data ?? '';
        },
      };
      const payload = JSON.stringify(body);
      await handler(
        {
          method: 'POST',
          url: path,
          on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data') cb(Buffer.from(payload, 'utf8'));
            if (event === 'end') cb();
          },
        },
        r,
      );
      return { code: r.code, body: r.body };
    };
    return { handler, post, call, mem, memberAgent };
  }

  it('binds and clears the session team via POST /session-team (团队必须存在)', async () => {
    const { post } = await installFull();
    const created = await post('/eteams-api/team', { name: '绑定团队', sessionId: 'cap-conv' });
    const teamId = (JSON.parse(created.body) as { teamId: string }).teamId;
    const bind = await post('/eteams-api/session-team', { sessionId: 'sess-a', teamId });
    expect(bind.code).toBe(200);
    // Stale selection (team deleted) → 404, not a silent bind.
    const bad = await post('/eteams-api/session-team', { sessionId: 'sess-a', teamId: 'ghost' });
    expect(bad.code).toBe(404);
    // Empty fields are rejected.
    const blank = await post('/eteams-api/session-team', { sessionId: 'sess-a', teamId: '' });
    expect(blank.code).toBe(400);
    const clear = await post('/eteams-api/session-team/clear', { sessionId: 'sess-a' });
    expect(clear.code).toBe(200);
    const clearBlank = await post('/eteams-api/session-team/clear', {});
    expect(clearBlank.code).toBe(400);
  });

  it('runs the docs/26 loop: 提交 → 面板拆解 → 批准 → 执行 → 主任务自动收口', async () => {
    const h = await installFull();
    const created = await h.post('/eteams-api/team', { name: '对话任务', sessionId: 'cap-conv' });
    const teamId = (JSON.parse(created.body) as { teamId: string }).teamId;
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Alice', role: 'researcher' });
    await h.post(`/eteams-api/team/${teamId}/member`, { name: 'Bob', role: 'engineer' });

    // 1. 对话提交：staged 团队立即生成任务 ID + 专属文件夹（不等批准）。
    const submitted = await h.call('eteams_submit_task', {
      subject: '官网迁移',
      description: '把官网迁到新域名',
      questionnaire: ['交付形式？', '验收偏好？'],
    });
    expect(submitted.ok).toBe(true);
    expect(submitted.status).toBe('draft');
    let team = readTeamFromDisk(teamId);
    const group = team.tasks[0]!;
    expect(group.kind).toBe('group');
    expect(team.workDir).toBeTruthy();
    expect(submitted.folder).toBe(`${team.workDir}/tasks/${taskSlug(group)}`);
    const groupDir = join(workspace, team.workDir!, 'tasks', taskSlug(group));
    expect(existsSync(join(groupDir, 'contract.md'))).toBe(true);
    expect(existsSync(join(groupDir, 'notes.md'))).toBe(true);

    // 2. 面板拆解：parentTaskId 挂任务单；chain 站点 = 成员槽接力。
    const sub = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '梳理页面清单',
      parentTaskId: group.id,
      chain: [
        { member: 'Alice', stageBrief: '调研' },
        { member: 'Bob', stageBrief: '整理' },
      ],
    });
    expect(sub.code).toBe(200);
    const subId = (JSON.parse(sub.body) as { taskId: string }).taskId;
    team = readTeamFromDisk(teamId);
    const subRec = team.tasks.find((t) => t.id === subId)!;
    expect(subRec.parentId).toBe(group.id);
    expect(subRec.status).toBe('draft');
    // 小任务文件夹落在主任务 sub/ 下（问询结论写回主任务 contract）。
    expect(
      existsSync(
        join(
          workspace,
          team.workDir!,
          'tasks',
          taskSlug(group),
          'sub',
          taskSlug(subRec),
          'notes.md',
        ),
      ),
    ).toBe(true);

    // 3. 面板修改（主题 + 成员槽）与删除。
    const upd = await h.post(`/eteams-api/team/${teamId}/task/${subId}/update`, {
      subject: '梳理新旧页面映射',
      chain: [{ member: 'Bob', stageBrief: 'Bob 先行' }],
    });
    expect(upd.code).toBe(200);
    team = readTeamFromDisk(teamId);
    expect(team.tasks.find((t) => t.id === subId)!.subject).toBe('梳理新旧页面映射');
    expect(team.tasks.find((t) => t.id === subId)!.chain[0]!.member).toBe('Bob');

    const temp = await h.post(`/eteams-api/team/${teamId}/task`, {
      subject: '临时小任务',
      parentTaskId: group.id,
    });
    const tempId = (JSON.parse(temp.body) as { taskId: string }).taskId;
    const del = await h.post(`/eteams-api/team/${teamId}/task/${tempId}/delete`, {});
    expect(del.code).toBe(200);
    expect(readTeamFromDisk(teamId).tasks.some((t) => t.id === tempId)).toBe(false);

    // 4. 面板批准：staged → running（fake spawn 两成员）；重复批准 400。
    const approve = await h.post(`/eteams-api/team/${teamId}/approve`, {});
    expect(approve.code).toBe(200);
    team = readTeamFromDisk(teamId);
    expect(team.phase).toBe('running');
    expect(team.tasks.find((t) => t.id === subId)!.status).toBe('ready');
    const again = await h.post(`/eteams-api/team/${teamId}/approve`, {});
    expect(again.code).toBe(400);

    // 5. 执行：指派链首 Bob → claim → 未领取窗口关闭（合同冻结，改删 400）。
    const assigned = await h.call('eteams_assign_task', { taskId: subId, member: 'Bob' });
    expect(assigned.ok).toBe(true);
    const childId = readTeamFromDisk(teamId).members.find((m) => m.name === 'Bob')!.id!;
    const bob = h.memberAgent(childId);
    const claimed = await h.mem(bob, 'eteams_claim_task', { taskId: subId });
    const frozenUpd = await h.post(`/eteams-api/team/${teamId}/task/${subId}/update`, {
      subject: '迟到修改',
    });
    expect(frozenUpd.code).toBe(400);
    const frozenDel = await h.post(`/eteams-api/team/${teamId}/task/${subId}/delete`, {});
    expect(frozenDel.code).toBe(400);

    // 6. 末个小任务完成 → 主任务自动收口（joined outcome + 事件）。
    const done = await h.mem(bob, 'eteams_complete_task', {
      taskId: subId,
      attemptId: claimed.attemptId,
      token: claimed.token,
      output: '新旧页面映射表完成',
    });
    expect(done.done).toBe(true);
    team = readTeamFromDisk(teamId);
    expect(team.tasks.find((t) => t.id === group.id)!.status).toBe('completed');
    expect(team.tasks.find((t) => t.id === group.id)!.outcome).toContain('映射表完成');

    // 快照投影：kind/parentId/folder；progress 只统计非 group 任务。
    const snap = teamSnapshot(team, workspace, config);
    expect(snap.workDir).toBe(team.workDir);
    expect(snap.progress).toEqual({ completed: 1, total: 1, cancelled: 0, active: 0 });
    const views = snap.tasks as {
      taskId: string;
      kind: string;
      parentId: string | null;
      folder: string | null;
    }[];
    const subView = views.find((t) => t.taskId === subId)!;
    expect(subView.kind).toBe('task');
    expect(subView.parentId).toBe(group.id);
    expect(subView.folder).toContain('sub/');
    const groupView = views.find((t) => t.taskId === group.id)!;
    expect(groupView.kind).toBe('group');
    expect(groupView.folder).not.toContain('sub/');
    void h.handler;
  });
});

describe('web surface installation', () => {
  it('stays tool-only when web services are absent (headless)', () => {
    const { ctx } = fakeCtx();
    expect(installWebSurface(ctx, config)).toBe(false);
  });

  it('registers the prefix route when webServer + workspaceRegistry exist', () => {
    const registered: { kind: string; path: string }[] = [];
    const disposers: (() => void)[] = [];
    const ctx = {
      get: (key: string) =>
        key === 'webServer'
          ? {
              register: (route: { kind: string; path: string }) => {
                registered.push(route);
                disposers.push(() => undefined);
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

  it('serves archived team summaries from archive/', async () => {
    // Fabricate one archived team directly on disk.
    const archive = archiveRoot(join(workspace, '.eteams'));
    mkdirSync(join(archive, 'arch-1'), { recursive: true });
    const archived = {
      id: 'arch-1',
      name: '旧团队',
      goal: 'g',
      phase: 'completed',
      workDir: 'teams/旧团队',
    };
    writeFileSync(join(archive, 'arch-1', 'team.json'), JSON.stringify(archived), 'utf8');

    const registered: { handler: (req: unknown, res: unknown) => Promise<void> }[] = [];
    const ctx = {
      get: (key: string) =>
        key === 'webServer'
          ? {
              register: (route: { handler: (req: unknown, res: unknown) => Promise<void> }) => {
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
    installWebSurface(ctx, config);
    const res = {
      code: 0,
      body: '',
      writeHead(code: number) {
        this.code = code;
      },
      end(data?: string) {
        this.body = data ?? '';
      },
    };
    await registered[0]!.handler({ method: 'GET', url: '/eteams-api/state' }, res);
    const captured = JSON.parse(res.body) as {
      archivedTeams: { teamId: string }[];
    };
    expect(res.code).toBe(200);
    expect(captured.archivedTeams[0]!.teamId).toBe('arch-1');
  });

  it('persists POST /client-log diagnostics under .eteams/logs/client.log', async () => {
    const registered: { handler: (req: unknown, res: unknown) => Promise<void> }[] = [];
    const ctx = {
      get: (key: string) =>
        key === 'webServer'
          ? {
              register: (route: { handler: (req: unknown, res: unknown) => Promise<void> }) => {
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
    installWebSurface(ctx, config);
    const res = {
      code: 0,
      body: '',
      writeHead(code: number) {
        this.code = code;
      },
      end(data?: string) {
        this.body = data ?? '';
      },
    };
    const body = JSON.stringify({
      version: 'v0.2.0',
      entries: [{ at: 1, kind: 'error', message: 'boom', source: 'a.js:1:1' }],
    });
    const req = {
      method: 'POST',
      url: '/eteams-api/client-log',
      on(event: string, cb: (chunk?: Buffer) => void) {
        if (event === 'data') cb(Buffer.from(body, 'utf8'));
        if (event === 'end') cb();
      },
    };
    await registered[0]!.handler(req, res);
    expect(res.code).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, written: 1 });
    const log = readFileSync(join(workspace, '.eteams', 'logs', 'client.log'), 'utf8')
      .split('\n')
      .filter((l) => l !== '');
    expect(log).toHaveLength(1);
    const record = JSON.parse(log[0]!) as {
      version: string;
      entry: { kind: string; message: string };
    };
    expect(record.version).toBe('v0.2.0');
    expect(record.entry).toMatchObject({ kind: 'error', message: 'boom' });
  });
});
