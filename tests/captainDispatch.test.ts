/**
 * eteams_dispatch_captain (docs/26 用户迭代 2026-09-03): the relay tool that
 * hands a conversation task to the 持续领队子代理 (persistent continuable
 * child) — captain-only gate, first-dispatch spawn contract
 * (label/persona+leader handbook/deny/prompt snapshot) with the durable
 * child id persisted on the team, followup continuation on later dispatches,
 * fallback to a fresh child when the lineage no longer matches, and the
 * subagent-service guard.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ETeamsConfig, type ETeamsResolvedConfig } from '../src/host/config';
import { createCaptainDispatchTool } from '../src/host/tools/captainDispatch';
import { captainChildPersona } from '../src/host/prompts/captain';
import { composeCaptainPersona } from '../src/host/prompts/persona';
import {
  CAPTAIN_CHILD_DENIED_TOOLS,
  captainChildTeamOf,
  registerCaptainChild,
  unregisterCaptainChild,
} from '../src/host/runtime/captainAgent';
import { resolveCaller } from '../src/host/tools/identity';
import { readTeam, writeTeam } from '../src/host/state/store';
import { teamView } from '../src/host/runtime/teamOps';
import { deliverMail } from '../src/host/runtime/notifier';
import type { RuntimeEnv } from '../src/host/runtime/base';
import type { MailMessage, TeamState } from '../src/host/model/types';

// ---------- fake runtime (subagents surface used by the dispatch tool) ----

interface ContinuableSpec {
  provider?: string;
  label?: string;
  request: {
    prompt: { type: string; text: string }[];
    parent: unknown;
    persona?: string;
    toolFilter?: { deny: string[] };
  };
  signal?: unknown;
}

let childSeq = 0;

function fakeRuntime() {
  const starts: ContinuableSpec[] = [];
  const spawnedIds: string[] = [];
  const followups: { childId: string; text: string }[] = [];
  const failingFollowups = new Set<string>();

  const ctx = {
    logger: { info: () => undefined, warn: () => undefined },
    subagents: {
      async startContinuable(spec: ContinuableSpec): Promise<{ childId: string; messageId: string }> {
        const childId = `sess-child-${++childSeq}`;
        starts.push(spec);
        spawnedIds.push(childId);
        return { childId, messageId: `${childId}-m1` };
      },
      async followup(parent: unknown, childId: string, content: { text: string }[]) {
        void parent;
        if (failingFollowups.has(childId)) {
          throw new Error(`subagent "${childId}" is unavailable`);
        }
        followups.push({ childId, text: content.map((c) => c.text).join('\n') });
        return `${childId}-m${followups.length + 1}`;
      },
    },
  } as unknown as Context;

  return { ctx, starts, spawnedIds, followups, failingFollowups };
}

let ws: string;
let config: ETeamsResolvedConfig;
let runtime: ReturnType<typeof fakeRuntime>;
let captain: Agent;
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

function agentOf(id: string, cwd?: string): Agent {
  return { id, session: { header: { cwd: cwd ?? ws } } } as unknown as Agent;
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
  config = ETeamsConfig({}) as ETeamsResolvedConfig;
  runtime = fakeRuntime();
  captain = agentOf('cap-1');
  tool = createCaptainDispatchTool(config, runtime.ctx);
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  unregisterCaptainChild('sess-stale');
  unregisterCaptainChild('sess-child-1');
  unregisterCaptainChild('sess-child-2');
});

describe('eteams_dispatch_captain', () => {
  it('starts a persistent continuable child on first dispatch', async () => {
    await writeTeam(join(ws, '.eteams'), team());
    const out = (await tool.execute(
      { message: '帮我做一个导出功能' } as never,
      { agent: captain, signal: undefined } as never,
    )) as { ok: boolean; relayed: string };

    expect(out.ok).toBe(true);
    expect(out.relayed).toContain('已转交持续领队子代理');

    // Spawn contract: continuable, leader persona + handbook, deny, snapshot.
    const spec = runtime.starts[0]!;
    expect(spec.provider).toBe(config.memberProvider);
    expect(spec.label).toBe('eteams-captain:demo');
    const fallbackMd = composeCaptainPersona(ws, '.eteams').personaMd;
    expect(spec.request.persona).toBe(captainChildPersona(fallbackMd));
    expect(spec.request.persona).toContain('角色手册（领队 · 项目牧羊人）');
    expect(spec.request.toolFilter?.deny).toEqual([...CAPTAIN_CHILD_DENIED_TOOLS]);
    expect(spec.request.parent).toBe(captain);
    expect(spec.request.prompt).toHaveLength(1);
    const promptText = spec.request.prompt.map((p) => p.text).join('\n');
    expect(promptText).toContain('【团队现状】');
    expect(promptText).toContain('演示团队');
    expect(promptText).toContain('【用户/主对话最新消息】');
    expect(promptText).toContain('帮我做一个导出功能');

    // Identity registry + durable child id persisted on the team.
    expect(captainChildTeamOf('sess-child-1')).toBe('demo');
    const persisted = await readTeam(join(ws, '.eteams'), 'demo');
    expect(persisted?.captainChildId).toBe('sess-child-1');
    // The child's eteams_* calls resolve as this team's captain.
    const caller = await resolveCaller(envFor(ws), agentOf('sess-child-1'));
    expect(caller.kind).toBe('captain');
    if (caller.kind === 'captain') expect(caller.team.id).toBe('demo');
  });

  it('continues the same child via followup on later dispatches', async () => {
    await writeTeam(join(ws, '.eteams'), team({ captainChildId: 'sess-child-1' }));
    const out = (await tool.execute(
      { message: '改成导出 Excel' } as never,
      { agent: captain, signal: undefined } as never,
    )) as { ok: boolean; relayed: string };

    expect(out.ok).toBe(true);
    expect(runtime.starts).toHaveLength(0);
    expect(runtime.followups).toHaveLength(1);
    expect(runtime.followups[0]!.childId).toBe('sess-child-1');
    expect(runtime.followups[0]!.text).toContain('改成导出 Excel');
    expect(runtime.followups[0]!.text).toContain('【团队现状】');
    expect(captainChildTeamOf('sess-child-1')).toBe('demo');
    const persisted = await readTeam(join(ws, '.eteams'), 'demo');
    expect(persisted?.captainChildId).toBe('sess-child-1');
  });

  it('falls back to a fresh child when the stored child is unavailable', async () => {
    // The registry still holds the live entry for the old child (written by
    // the dispatch that created it); the followup failure drops it and the
    // fresh spawn re-registers under the new id.
    registerCaptainChild('sess-stale', 'demo');
    runtime.failingFollowups.add('sess-stale');
    await writeTeam(join(ws, '.eteams'), team({ captainChildId: 'sess-stale' }));
    const out = (await tool.execute(
      { message: '继续' } as never,
      { agent: captain, signal: undefined } as never,
    )) as { ok: boolean; relayed: string };

    expect(out.ok).toBe(true);
    expect(runtime.followups).toHaveLength(0);
    expect(runtime.starts).toHaveLength(1);
    const freshId = runtime.spawnedIds[0]!;
    expect(captainChildTeamOf('sess-stale')).toBeUndefined();
    expect(captainChildTeamOf(freshId)).toBe('demo');
    const persisted = await readTeam(join(ws, '.eteams'), 'demo');
    expect(persisted?.captainChildId).toBe(freshId);
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
    await expect(
      tool.execute(
        { message: 'hi' } as never,
        { agent: agentOf('m-1'), signal: undefined } as never,
      ) as Promise<unknown>,
    ).rejects.toThrow('只有团队领队会话可以转交领队子代理');
    expect(runtime.starts).toHaveLength(0);
  });

  it('errors when the subagent service is unavailable', async () => {
    await writeTeam(join(ws, '.eteams'), team());
    const bare = createCaptainDispatchTool(config, {
      logger: { info: () => undefined, warn: () => undefined },
    } as unknown as Context);
    await expect(
      bare.execute(
        { message: 'x' } as never,
        { agent: captain, signal: undefined } as never,
      ) as Promise<unknown>,
    ).rejects.toThrow('子代理服务不可用');
  });
});

describe('teamView 团队现状精简 (用户迭代 2026-09-03)', () => {
  it('members keep only 工号/角色/状态 and the mailbox is trimmed', async () => {
    const env = envFor(ws);
    const base = team({
      members: [
        {
          id: 'm-1',
          name: '甲',
          employeeId: 'ET-0001',
          role: '前端',
          status: 'active',
          persona: { executionPrompt: 'p' },
          modelRoute: { primary: 'x' },
          avatar: {},
          createdAt: 1,
        } as TeamState['members'][0],
        { id: 'm-2', name: '乙', role: '后端', status: 'removed' } as TeamState['members'][0],
      ],
    });
    // Seven captain mails → only the last five reach the snapshot; one is
    // longer than the 300-char cap. (appendMail expects the team inbox to
    // exist — production creates it with the team.)
    mkdirSync(join(ws, '.eteams', 'demo', 'inbox'), { recursive: true });
    for (let i = 0; i < 7; i++) {
      await deliverMail(env, base, 'captain', {
        id: `m${i}`,
        seq: 0,
        at: i,
        from: { kind: 'member', name: '甲' },
        to: { kind: 'captain', name: '领队' },
        kind: 'report',
        content: i === 3 ? 'x'.repeat(320) : `第${i}条`,
      } as MailMessage);
    }

    const view = teamView(env, base);
    expect(view.members).toEqual([
      { name: '甲', employeeId: 'ET-0001', role: '前端', status: 'active' },
    ]);
    // Member persona/route never leak into the snapshot.
    const json = JSON.stringify(view);
    expect(json).not.toContain('modelRoute');
    expect(json).not.toContain('executionPrompt');

    const mailbox = view.captainMailbox as { seq: number; content: string }[];
    expect(mailbox).toHaveLength(5);
    expect(mailbox[0]!.seq).toBe(3);
    expect(mailbox.at(-1)!.content).toBe('第6条');
    const truncated = mailbox.find((m) => m.content.endsWith('…'));
    expect(truncated?.content).toHaveLength(301); // 300 chars + ellipsis
  });
});