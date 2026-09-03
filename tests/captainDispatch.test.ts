/**
 * eteams_dispatch_captain (docs/26 用户迭代 2026-09-03): the relay tool that
 * hands a conversation task to the one-shot 领队子代理 — captain-only gate,
 * spawn contract (label/persona/deny/prompt snapshot), relay passthrough,
 * abnormal-stop handling, and the always-dispose contract.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ETeamsConfig, type ETeamsResolvedConfig } from '../src/host/config';
import { createCaptainDispatchTool } from '../src/host/tools/captainDispatch';
import { CAPTAIN_CHILD_PERSONA } from '../src/host/prompts/captain';
import { CAPTAIN_CHILD_DENIED_TOOLS, captainChildTeamOf } from '../src/host/runtime/captainAgent';
import { resolveCaller } from '../src/host/tools/identity';
import { writeTeam } from '../src/host/state/store';
import type { RuntimeEnv } from '../src/host/runtime/base';
import type { TeamState } from '../src/host/model/types';

// ---------- fake runtime (mirrors lifecycle.test.ts) ----------

interface FakeAgent {
  id: string;
  session: { header: { cwd: string; parentSession?: string } };
}

interface SpawnSpec {
  label?: string;
  persona?: string;
  toolFilter?: { deny: string[] };
  prompt: { type: string; text: string }[];
  parent: FakeAgent;
  signal?: AbortSignal;
}

interface FakeRun {
  id: string;
  result: Promise<unknown>;
  dispose(): Promise<void>;
}

function fakeRuntime() {
  const spawns: SpawnSpec[] = [];
  const disposed: string[] = [];
  const resolvers = new Map<string, (value: unknown) => void>();
  let childCounter = 0;

  const ctx = {
    logger: { info: () => undefined, warn: () => undefined },
    subagents: {
      async start(_provider: unknown, spec: SpawnSpec): Promise<FakeRun> {
        const childId = `sess-child-${++childCounter}`;
        spawns.push(spec);
        const result = new Promise<unknown>((resolve) => resolvers.set(childId, resolve));
        return {
          id: childId,
          result,
          async dispose() {
            disposed.push(childId);
          },
        };
      },
    },
  } as unknown as Context;

  return { ctx, spawns, disposed, resolvers };
}

let ws: string;
let config: ETeamsResolvedConfig;
let runtime: ReturnType<typeof fakeRuntime>;
let captain: FakeAgent;
let tool: ReturnType<typeof createCaptainDispatchTool>;

function team(overrides: Partial<TeamState> = {}): TeamState {
  return {
    schemaVersion: 2,
    id: 'demo',
    name: '演示团队',
    goal: '为应用实现数据导出',
    captainSessionId: 'cap-1',
    phase: 'staged',
    createdAt: 1,
    updatedAt: 1,
    version: 0,
    taskSeq: 0,
    attemptSeq: 0,
    mailSeq: 0,
    maxRetries: 3,
    members: [],
    tasks: [],
    pendingDecisions: [],
    ...overrides,
  };
}

function agentOf(id: string, parent?: string): Agent {
  return {
    id,
    session: { header: { cwd: ws, parentSession: parent } },
  } as unknown as Agent;
}

function envFor(workspace: string): RuntimeEnv {
  return {
    workspace,
    config: { stateDir: '.eteams' },
    ctx: {},
  } as unknown as RuntimeEnv;
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'eteams-dispatch-'));
  const resolved = ETeamsConfig({}) as ETeamsResolvedConfig;
  config = { ...resolved, stateDir: '.eteams' };
  runtime = fakeRuntime();
  captain = {
    id: 'cap-1',
    session: { header: { cwd: ws } },
  } as unknown as FakeAgent;
  tool = createCaptainDispatchTool(config, runtime.ctx);
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('eteams_dispatch_captain', () => {
  it('spawns the one-shot captain child and relays its report', async () => {
    await writeTeam(join(ws, '.eteams'), team());
    const pending = tool.execute(
      { message: '帮我做一个导出功能' } as never,
      { agent: captain as unknown as Agent, signal: undefined } as never,
    ) as Promise<{ ok: boolean; relayed: string }>;
    // Identity registration happens while the run is in flight: the child's
    // eteams_* calls resolve as this team's captain (incl. cross-workspace).
    await expect.poll(() => captainChildTeamOf('sess-child-1')).toBe('demo');
    expect(captainChildTeamOf('sess-child-1')).toBe('demo');
    const caller = await resolveCaller(envFor(ws), agentOf('sess-child-1', 'cap-1'));
    expect(caller.kind).toBe('captain');
    if (caller.kind === 'captain') expect(caller.team.id).toBe('demo');

    runtime.resolvers.get('sess-child-1')!({
      output: [{ type: 'text', text: '计划已就绪（2 个小任务）——可在面板批准计划' }],
      stopReason: 'completed',
    });
    const out = await pending;
    expect(out.ok).toBe(true);
    expect(out.relayed).toBe('计划已就绪（2 个小任务）——可在面板批准计划');

    // Always-dispose contract + registry drop after settle.
    expect(runtime.disposed).toContain('sess-child-1');
    expect(captainChildTeamOf('sess-child-1')).toBeUndefined();

    // Spawn contract.
    const spec = runtime.spawns[0]!;
    expect(spec.label).toBe('eteams-captain:demo');
    expect(spec.persona).toBe(CAPTAIN_CHILD_PERSONA);
    expect(spec.parent).toBe(captain);
    expect(spec.toolFilter?.deny).toEqual([...CAPTAIN_CHILD_DENIED_TOOLS]);
    const promptText = spec.prompt.map((p) => p.text).join('\n');
    expect(promptText).toContain('【团队现状】');
    expect(promptText).toContain('演示团队');
    expect(promptText).toContain('【用户/主对话最新消息】');
    expect(promptText).toContain('帮我做一个导出功能');
  });

  it('rejects a member caller (只有团队领队会话可以转交)', async () => {
    await writeTeam(
      join(ws, '.eteams'),
      team({
        members: [
          {
            id: 'm-1',
            name: '甲',
            status: 'active',
            persona: { executionPrompt: 'p' },
          } as TeamState['members'][0],
        ],
      }),
    );
    const member = agentOf('m-1', 'cap-1') as unknown as FakeAgent;
    await expect(
      tool.execute(
        { message: 'hi' } as never,
        { agent: member as unknown as Agent, signal: undefined } as never,
      ) as Promise<unknown>,
    ).rejects.toThrow('只有团队领队会话可以转交领队子代理');
    expect(runtime.spawns).toHaveLength(0);
  });

  it('flags an abnormal child stop and still disposes', async () => {
    await writeTeam(join(ws, '.eteams'), team());
    const pending = tool.execute(
      { message: '继续' } as never,
      { agent: captain as unknown as Agent, signal: undefined } as never,
    ) as Promise<{ ok: boolean; relayed: string }>;
    await expect.poll(() => captainChildTeamOf('sess-child-1')).toBe('demo');
    runtime.resolvers.get('sess-child-1')!({
      output: [],
      stopReason: 'cancelled',
      diagnostic: 'user aborted',
    });
    const out = await pending;
    expect(out.ok).toBe(false);
    expect(out.relayed).toContain('异常结束');
    expect(out.relayed).toContain('cancelled');
    expect(runtime.disposed).toContain('sess-child-1');
    expect(captainChildTeamOf('sess-child-1')).toBeUndefined();
  });

  it('passes the child text through even on abnormal stop', async () => {
    await writeTeam(join(ws, '.eteams'), team());
    const pending = tool.execute(
      { message: '继续' } as never,
      { agent: captain as unknown as Agent, signal: undefined } as never,
    ) as Promise<{ ok: boolean; relayed: string }>;
    await expect.poll(() => captainChildTeamOf('sess-child-1')).toBe('demo');
    runtime.resolvers.get('sess-child-1')!({
      output: [{ type: 'text', text: '成员卡住了——正在换人重派' }],
      stopReason: 'error',
    });
    const out = await pending;
    expect(out.ok).toBe(false);
    expect(out.relayed).toBe('成员卡住了——正在换人重派');
  });

  it('still disposes when the run result rejects', async () => {
    await writeTeam(join(ws, '.eteams'), team());
    const pending = tool.execute(
      { message: '继续' } as never,
      { agent: captain as unknown as Agent, signal: undefined } as never,
    ) as Promise<unknown>;
    await expect.poll(() => captainChildTeamOf('sess-child-1')).toBe('demo');
    runtime.resolvers.get('sess-child-1')!(Promise.reject(new Error('child crashed')));
    await expect(pending).rejects.toThrow('child crashed');
    expect(runtime.disposed).toContain('sess-child-1');
    expect(captainChildTeamOf('sess-child-1')).toBeUndefined();
  });

  it('errors when the subagent service is unavailable', async () => {
    await writeTeam(join(ws, '.eteams'), team());
    const bare = createCaptainDispatchTool(config, {
      logger: { info: () => undefined, warn: () => undefined },
    } as unknown as Context);
    await expect(
      bare.execute(
        { message: 'x' } as never,
        { agent: captain as unknown as Agent, signal: undefined } as never,
      ) as Promise<unknown>,
    ).rejects.toThrow('子代理服务不可用');
  });
});
