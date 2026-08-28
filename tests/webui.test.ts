/**
 * M4 web-surface tests: the TeamSnapshot builder over real on-disk state
 * (docs/12.2 shape) and the event summarizer, driven offline through the
 * runtime ops with a fake subagent runtime.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { ETeamsConfig, type ETeamsResolvedConfig } from '../src/host/config';
import { createCaptainTools } from '../src/host/tools/captainTools';
import { installWebSurface, summarizeEvent, teamSnapshot } from '../src/host/runtime/webui';
import { archiveRoot } from '../src/host/state/events';
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
    // Four presets are seeded on first GET; Alice upserts on top.
    expect(parsed.members).toHaveLength(5);
    expect(parsed.members.find((m) => m.name === 'Alice')!.role).toBe('writer');
  });

  it('seeds preset members once and preserves user edits', async () => {
    const { handler, res, post } = await installFake();
    const r1 = res();
    await handler({ method: 'GET', url: '/eteams-api/roster' }, r1);
    const first = JSON.parse(r1.body) as { members: { name: string; avatar?: unknown }[] };
    const presetNames = ['前端开发者', '后端架构师', 'UI 设计师', '趣味注入师'];
    expect(first.members.map((m) => m.name)).toEqual(expect.arrayContaining(presetNames));
    expect(first.members).toHaveLength(4);
    for (const p of first.members) expect(p.avatar).toBeDefined();

    // Second GET is idempotent — no duplicates.
    const r2 = res();
    await handler({ method: 'GET', url: '/eteams-api/roster' }, r2);
    expect((JSON.parse(r2.body) as { members: unknown[] }).members).toHaveLength(4);

    // User edit to a preset is preserved on later GETs.
    await post('/eteams-api/roster', {
      name: '前端开发者',
      role: '前端开发者',
      duty: '自定义职责',
    });
    const r3 = res();
    await handler({ method: 'GET', url: '/eteams-api/roster' }, r3);
    const third = JSON.parse(r3.body) as { members: { name: string; duty?: string }[] };
    expect(third.members).toHaveLength(4);
    expect(third.members.find((m) => m.name === '前端开发者')!.duty).toBe('自定义职责');
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
    expect(captain.personaMd).toContain('## 使命');
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
    await post(`/eteams-api/team/${teamId}/member`, { name: '前端开发者', fromRoster: true });
    const fresh = readTeamFromDisk(teamId);
    const md = fresh.members[0]!.persona.personaMd;
    expect(md).toBeDefined();
    expect(md).toContain('## 使命');
    expect(md).toContain('## 交付标准');
    const { renderPersonaBlock } = await import('../src/host/prompts/persona');
    const block = renderPersonaBlock(fresh.members[0]!.persona, '前端开发者');
    expect(block).toContain('# 角色手册');
    expect(block).toContain('## 核心职责');
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
