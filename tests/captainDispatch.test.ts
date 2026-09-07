/**
 * eteams_dispatch_captain (docs/26 用户迭代 2026-09-03): the relay tool that
 * hands a conversation task to the 持续领队子代理 (persistent continuable
 * child) — captain-only gate, first-dispatch spawn contract
 * (label/persona+leader handbook/deny/prompt snapshot) with the durable
 * child id persisted on the task_members 领队行, followup continuation on
 * later dispatches, fallback to a fresh child when the lineage no longer
 * matches, and the subagent-service guard. Plus the 团队现状精简 teamView.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { resolveConfig, type ETeamsResolvedConfig } from '../src/host/config';
import { createCaptainDispatchTool } from '../src/host/tools/captainDispatch';
import { captainChildPersona } from '../src/host/prompts/spawn/captainChild';
import { composeCaptainPersona } from '../src/host/prompts/personas/captain';
import {
  CAPTAIN_CHILD_DENIED_TOOLS,
  captainChildTeamOf,
  leaderHandbookForChild,
  registerCaptainChild,
  unregisterCaptainChild,
} from '../src/host/runtime/captainAgent';
import { resolveCaller } from '../src/host/tools/identity';
import { insertTeamRow, readTeamSync, withTeamTx, writeTeamInTx } from '../src/host/state/store';
import { appendMail } from '../src/host/state/events';
import { teamView } from '../src/host/runtime/teamOps';
import { LEADER_NAME, upsertRosterMember } from '../src/host/runtime/roster';
import { joinPath, type RuntimeEnv } from '../src/host/runtime/base';
import type { MailMessage, TaskMemberRecord, TeamState } from '../src/host/model/types';
import { cleanupTempWorkspace } from './support/tmpWorkspace';

// ---------- fake runtime (subagents surface used by the dispatch tool) ----

interface ContinuableSpec {
  provider: string;
  label: string;
  childId?: string;
  request: {
    prompt: { type: string; text: string }[];
    parent: unknown;
    persona?: string;
    toolFilter?: { deny: string[] };
    agentOptions?: Record<string, unknown>;
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
      async startContinuable(
        spec: ContinuableSpec,
      ): Promise<{ childId: string; messageId: string }> {
        // 真实契约：调用方预留的 childId 兑现为 durable id（无预留才自增）。
        const childId = spec.childId ?? `sess-child-${++childSeq}`;
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
let root: string;
let config: ETeamsResolvedConfig;
let runtime: ReturnType<typeof fakeRuntime>;
let captain: Agent;
let tool: ReturnType<typeof createCaptainDispatchTool>;

function leaderRow(teamId: number, childSessionId = '', personaMd?: string): TaskMemberRecord {
  return {
    id: 0,
    teamId,
    mainTaskId: null,
    nowTaskId: null,
    name: LEADER_NAME,
    employeeId: null,
    sessionId: childSessionId,
    roleId: null,
    status: 'ready',
    ...(personaMd !== undefined ? { personaMd } : {}),
    createdAt: 1,
  };
}

function memberRow(teamId: number, childSessionId: string): TaskMemberRecord {
  return {
    id: 0,
    teamId,
    mainTaskId: null,
    nowTaskId: null,
    name: '甲',
    // v7：实例行也带工号（按工号定位聚合）——与班底 '甲' 的 employeeId 对齐。
    employeeId: 1,
    sessionId: childSessionId,
    roleId: null,
    status: 'ready',
    createdAt: 1,
  };
}

/** SQLite 契约播种（team.json 已退场）：team 行 + 演示主任务的领队副本行
 * （可预置子会话 id 与建队时烘焙的手册缓存——v8+ 主持行取消，领队会话锚
 * 在副本行）+ 可选成员实例行；领队身份锚点盖章在任务行快照（v6）。 */
function seedTeam(
  opts: { memberChild?: string; leaderChild?: string; leaderHandbook?: string } = {},
): TeamState {
  const name = '演示团队';
  let teamId = 0;
  withTeamTx(root, undefined, (tx) => {
    teamId = insertTeamRow(tx, name, true, tx.now);
  });
  const taskMembers: TaskMemberRecord[] = [
    {
      // 领队副本行（v8+：主持行取消——会话锚在 mainTaskId=演示任务 的行上）。
      ...leaderRow(teamId, opts.leaderChild ?? '', opts.leaderHandbook),
      mainTaskId: 1,
    },
  ];
  // v7：成员有工牌才有身份——拉人即落班底行（工牌发放处），实例行（工牌 1）
  // 靠它过 resolveCaller 的 R1 离职截断。
  const members =
    opts.memberChild !== undefined
      ? [
          {
            // v7 表自增：工号 = 班底行主键（employeeId 恒等于 memberId）。
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
        ]
      : [];
  if (opts.memberChild !== undefined) taskMembers.push(memberRow(teamId, opts.memberChild));
  const state: TeamState = {
    id: teamId,
    name,
    hasLeader: true,
    createdAt: 1,
    updatedAt: 1,
    taskMembers,
    members,
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
  // 状态根与 runtime 同口径（base.ts joinPath 的「/」拼法）——getDb 连接缓存
  // 按它做键，afterEach 收尾才能关掉连接再删目录。
  root = joinPath(ws, '.eteams');
  config = resolveConfig({ stateDir: '.eteams' });
  runtime = fakeRuntime();
  captain = agentOf('cap-1');
  tool = createCaptainDispatchTool(config, runtime.ctx);
});

afterEach(() => {
  // 先关 SQLite 连接再退避删目录——tests/support/tmpWorkspace。
  cleanupTempWorkspace(ws);
  unregisterCaptainChild('sess-stale');
  unregisterCaptainChild('sess-child-1');
  unregisterCaptainChild('sess-child-2');
});

describe('eteams_dispatch_captain', () => {
  it('starts a persistent continuable child on first dispatch', async () => {
    const seeded = seedTeam();
    const out = (await tool.execute(
      { message: '帮我做一个导出功能' } as never,
      { agent: captain, signal: undefined } as never,
    )) as { ok: boolean; relayed: string };

    expect(out.ok).toBe(true);
    expect(out.relayed).toContain('已转交持续领队子代理');

    // Spawn contract: continuable, leader persona + handbook, deny, snapshot.
    const spec = runtime.starts[0]!;
    expect(spec.provider).toBe(config.memberProvider);
    // 子代理以领队的名字命名（用户迭代 2026-09-07）。
    expect(spec.label).toBe(`eteams-captain:${LEADER_NAME}`);
    // persona 段只含领队手册插槽引用（2026-09-08：手册走团队成员表缓存，
    // 由 index.ts 注册的 prompt 变量按装配注入，真实 {{}} 不经插值）。
    expect(spec.request.persona).toBe(captainChildPersona('{{eteams_leader_handbook}}'));
    expect(spec.request.persona).toContain('角色手册（领队 · 项目牧羊人）');
    expect(spec.request.toolFilter?.deny).toEqual([...CAPTAIN_CHILD_DENIED_TOOLS]);
    expect(spec.request.parent).toBe(captain);
    expect(spec.request.prompt).toHaveLength(1);
    const promptText = spec.request.prompt.map((p) => p.text).join('\n');
    // prompt 只带现状自取指令 + 用户消息（现状 JSON 与手册原文都不内嵌，
    // 手册走 persona 系统段）。
    expect(promptText).toContain('【团队现状】');
    expect(promptText).toContain('eteams_team_status');
    expect(promptText).not.toContain('"members"');
    expect(promptText).not.toContain('【领队手册');
    expect(promptText).toContain('【用户/主对话最新消息】');
    expect(promptText).toContain('帮我做一个导出功能');

    // Identity registry + durable child id persisted on the 领队副本行（调用
    // 方预留 childId 被兑现——registry 以预留 id 为键，先登记后 spawn）。
    const persisted = readTeamSync(root, seeded.id);
    const childId =
      persisted?.taskMembers.find((r) => r.mainTaskId === 1 && r.isLeader === true)?.sessionId ??
      '';
    expect(childId).not.toBe('');
    expect(runtime.spawnedIds).toContain(childId);
    expect(captainChildTeamOf(childId)).toBe(String(seeded.id));
    // fixture 副本行无手册缓存 → 插槽 provider 退内置手册（绝不返回空）。
    expect(leaderHandbookForChild(config, childId)).toBe(composeCaptainPersona(root).personaMd);
    // The child's eteams_* calls resolve as this team's captain.
    const caller = await resolveCaller(envFor(ws), agentOf(childId));
    expect(caller.kind).toBe('captain');
    if (caller.kind === 'captain') expect(caller.team.id).toBe(seeded.id);
  });

  it('continues the same child via followup on later dispatches', async () => {
    const seeded = seedTeam({ leaderChild: 'sess-child-1' });
    const out = (await tool.execute(
      { message: '改成导出 Excel' } as never,
      { agent: captain, signal: undefined } as never,
    )) as { ok: boolean; relayed: string };

    expect(out.ok).toBe(true);
    expect(runtime.starts).toHaveLength(0);
    expect(runtime.followups).toHaveLength(1);
    expect(runtime.followups[0]!.childId).toBe('sess-child-1');
    expect(runtime.followups[0]!.text).toContain('改成导出 Excel');
    expect(runtime.followups[0]!.text).toContain('eteams_team_status');
    expect(captainChildTeamOf('sess-child-1')).toBe(String(seeded.id));
    const persisted = readTeamSync(root, seeded.id);
    expect(persisted?.taskMembers.find((r) => r.mainTaskId === 1 && r.isLeader === true)?.sessionId).toBe(
      'sess-child-1',
    );
  });

  it('serves the 领队行 persona_md cache and ignores later role edits (团队成员表缓存)', async () => {
    // 2026-09-08 定案：领队手册源 = 领队主持行 persona_md（建队时烘焙的冻结
    // 列，插槽 provider 直读原始列、绕过 hydration 的 roles join）——角色库
    // 后续修改不影响本团队。
    const marker = '# 建队缓存手册标记 XYZ456';
    seedTeam({ leaderChild: 'sess-child-1', leaderHandbook: marker });
    await tool.execute(
      { message: '继续' } as never,
      { agent: captain, signal: undefined } as never,
    );
    const childId = 'sess-child-1';
    expect(leaderHandbookForChild(config, childId)).toContain(marker);
    // 角色库随后修改（面板保存路径）→ 缓存原样，插槽读到的仍是建队时手册。
    await upsertRosterMember(
      root,
      {
        name: LEADER_NAME,
        role: '领队（项目牧羊人）',
        personaMd: '# 角色库新手册（应被忽略）',
      },
      { allowLeader: true },
    );
    expect(leaderHandbookForChild(config, childId)).toContain(marker);
    expect(leaderHandbookForChild(config, childId)).not.toContain('应被忽略');
    // 未登记的会话（非领队子代理）→ 内置手册兜底，绝不返回空。
    expect(leaderHandbookForChild(config, 'sess-stranger')).toBe(
      composeCaptainPersona(root).personaMd,
    );
  });

  it('falls back to a fresh child when the stored child is unavailable', async () => {
    // The registry still holds the live entry for the old child (written by
    // the dispatch that created it); the followup failure drops it and the
    // fresh spawn re-registers under the new id.
    const seeded = seedTeam({ leaderChild: 'sess-stale' });
    registerCaptainChild('sess-stale', String(seeded.id));
    runtime.failingFollowups.add('sess-stale');
    const out = (await tool.execute(
      { message: '继续' } as never,
      { agent: captain, signal: undefined } as never,
    )) as { ok: boolean; relayed: string };

    expect(out.ok).toBe(true);
    expect(runtime.followups).toHaveLength(0);
    expect(runtime.starts).toHaveLength(1);
    const freshId = String(runtime.starts[0]!.childId);
    expect(captainChildTeamOf('sess-stale')).toBeUndefined();
    expect(captainChildTeamOf(freshId)).toBe(String(seeded.id));
    const persisted = readTeamSync(root, seeded.id);
    expect(persisted?.taskMembers.find((r) => r.mainTaskId === 1 && r.isLeader === true)?.sessionId).toBe(freshId);
  });

  it('rejects a member caller (只有团队领队会话可以转交)', async () => {
    seedTeam({ memberChild: 'm-1' });
    await expect(
      tool.execute(
        { message: 'hi' } as never,
        { agent: agentOf('m-1'), signal: undefined } as never,
      ) as Promise<unknown>,
    ).rejects.toThrow('只有团队领队会话可以转交领队子代理');
    expect(runtime.starts).toHaveLength(0);
  });

  it('spawns the fresh child on the leader route override (领队模型选择)', async () => {
    const seeded = seedTeam();
    // 领队行预置路线（setLeaderModel 的写入路径由 lifecycle.test.ts 覆盖）。
    // v9 存储位 = 班底领队行（team_members.is_leader=1 的 modelRoute）——
    // seedTeam 不带成员班底，这里显式补一条领队班底行并挂覆盖路线。
    const withRoute: TeamState = {
      ...seeded,
      members: [
        ...seeded.members,
        {
          memberId: 100,
          roleId: null,
          name: LEADER_NAME,
          employeeId: 100,
          role: '领队',
          persona: {
            frameworkVersion: 1,
            role: '领队',
            duty: '',
            style: '',
            skills: '',
            rules: [],
            executionPrompt: '',
          },
          modelRoute: {
            model: 'deepseek-reasoner',
            provider: 'tr-test',
            reasoningEffort: 'high',
          },
          avatar: { seed: 9, salt: 9 },
          isLeader: true,
          createdAt: 1,
        },
      ],
    };
    withTeamTx(root, seeded.id, (tx) => writeTeamInTx(tx, withRoute));
    await tool.execute(
      { message: '帮我做一个导出功能' } as never,
      { agent: captain, signal: undefined } as never,
    );
    expect(runtime.starts[0]!.request.agentOptions).toEqual({
      // v9 provider 回归：覆盖路线的目录 provider 原样传 agentOptions
      // （同 id 模型跨提供方消歧；不再是 'spawn'/'fork' 传输名）。
      provider: 'tr-test',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
    });
  });

  it('pins the fresh child to the host session-default model when the route is empty', async () => {
    seedTeam();
    // 宿主 agent-default-model 服务（settings 即时快照）挂到 fake ctx 上。
    (runtime.ctx as unknown as { agentDefaultModel?: unknown }).agentDefaultModel = {
      currentSelection: () => ({ provider: 'ollama', model: 'glm-5.3-flash:cloud' }),
    };
    await tool.execute(
      { message: '继续' } as never,
      { agent: captain, signal: undefined } as never,
    );
    expect(runtime.starts[0]!.request.agentOptions).toEqual({
      provider: 'ollama',
      model: 'glm-5.3-flash:cloud',
    });
  });

  it('degrades a throwing cordis ctx to no agentOptions (without inject 兜底)', async () => {
    seedTeam();
    // cordis 4：未声明 inject 的服务在 ctx 属性访问时直接抛「cannot get
    // property … without inject」（实测 2026-09-07 dispatch 整体失败）——
    // sessionDefaultRouteOf 必须按「服务未挂」契约吞错，派发照常受理且退回
    // 不带 agentOptions 的旧行为。
    const throwing = new Proxy(runtime.ctx, {
      get(target, prop) {
        if (prop === 'agentDefaultModel') {
          throw new Error('cannot get property "agentDefaultModel" without inject');
        }
        return Reflect.get(target, prop);
      },
    });
    const hostile = createCaptainDispatchTool(config, throwing as unknown as Context);
    await hostile.execute(
      { message: '继续' } as never,
      { agent: captain, signal: undefined } as never,
    );
    expect(runtime.starts[0]!.request.agentOptions).toBeUndefined();
  });

  it('errors when the subagent service is unavailable', async () => {
    seedTeam();
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
    const seeded = seedTeam();
    // 班底模板行（teamView.members 的来源）+ 一条 ready 实例行（聚合状态）。
    // v3 成员=角色：角色名随 persona.role 烘进 roles 角色行（writeTeamInTx
    // 的 ensureRolesRowInTx 自愈入库），无需手工补角色行。
    const withTemplate: TeamState = {
      ...seeded,
      members: [
        {
          // v7 表自增：工号 = 班底行主键（employeeId 恒等于 memberId）——
          // 实例行按工号聚合，fixture 三处（memberId/employeeId/实例行）对齐。
          memberId: 1,
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
            executionPrompt: 'p',
          },
          modelRoute: { model: '' },
          avatar: { seed: 1, salt: 1 },
          createdAt: 1,
        },
      ],
      taskMembers: [...seeded.taskMembers, memberRow(seeded.id, 'm-1')],
    };
    withTeamTx(root, seeded.id, (tx) => writeTeamInTx(tx, withTemplate));
    // Seven captain mails → only the last five reach the snapshot; one is
    // longer than the 300-char cap.（邮件随团队快照同库落存。）
    for (let i = 0; i < 7; i++) {
      await appendMail(root, seeded.id, 'captain', {
        id: `m${i}`,
        seq: 0,
        at: i,
        from: { kind: 'member', name: '甲' },
        to: { kind: 'captain', name: '领队' },
        kind: 'report',
        content: i === 3 ? 'x'.repeat(320) : `第${i}条`,
      } as MailMessage);
    }

    const view = teamView(env, readTeamSync(root, seeded.id)!);
    // 角色库无 profile、班底 persona 也没烘 → null；role 已从快照移除（v7
    // 成员名=角色名，与 name 冗余）。
    expect(view.members).toEqual([{ name: '甲', employeeId: 1, profile: null, status: 'ready' }]);
    // 角色库 profile 列是 live 源（用户迭代 2026-09-08）：upsert 后现读透出。
    await upsertRosterMember(root, { name: '甲', role: '前端', profile: '一句话简介：前端交付' });
    const fresh = teamView(env, readTeamSync(root, seeded.id)!);
    expect(fresh.members).toEqual([
      { name: '甲', employeeId: 1, profile: '一句话简介：前端交付', status: 'ready' },
    ]);
    // Member persona/route never leak into the snapshot.
    const json = JSON.stringify(fresh);
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
