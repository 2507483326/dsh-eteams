/**
 * M1 offline lifecycle verification (docs/15.3 item 9): the full DoD flow —
 * 问询 → 建队 → staged（含链）→ 批准（生成任务文件夹与文档）→ 指派 → 站点完成
 * → advance → 末站完成 → 领队收到通知；illegal transitions / bad tokens /
 * deviations without note are all rejected. Runs against the real tool face
 * with a fake subagent/agent runtime replacing ctx.subagents/ctx.agents.
 */
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { ETeamsConfig, type ETeamsResolvedConfig } from '../src/host/config';
import { createCaptainTools } from '../src/host/tools/captainTools';
import { createMemberTools } from '../src/host/tools/memberTools';
import { approvePlan, setLeaderModel, setMemberModel } from '../src/host/runtime/teamOps';
import type { RuntimeEnv } from '../src/host/runtime/base';
import type { TeamState } from '../src/host/model/types';

// ---------- fake runtime ----------

interface FakeAgent {
  id: string;
  session: {
    header: { cwd: string; parentSession?: string; seedLength?: number };
    events: unknown[];
  };
  followups: { text: string; source: unknown }[];
  followup(msg: { content: { type: string; text: string }[]; source: unknown }): void;
}

function fakeAgent(id: string, cwd: string, parent?: string): FakeAgent {
  const agent: FakeAgent = {
    id,
    session: { header: { cwd, parentSession: parent, seedLength: 0 }, events: [] },
    followups: [],
    followup(msg) {
      this.followups.push({
        text: msg.content.map((c) => ('text' in c ? c.text : '')).join(''),
        source: msg.source,
      });
    },
  };
  return agent;
}

function fakeRuntime(_workspace: string) {
  const children: {
    childId: string;
    label: string;
    request: {
      parent: FakeAgent;
      persona?: string;
      toolFilter?: { deny: string[] };
      agentOptions?: Record<string, unknown>;
    };
  }[] = [];
  const deliveries: { childId: string; text: string }[] = [];
  const interrupts: string[] = [];
  const captains = new Map<string, FakeAgent>();
  let childCounter = 0;

  const ctx = {
    logger: { info: () => undefined, warn: (m: string) => console.warn(`[warn] ${m}`) },
    subagents: {
      async startContinuable(spec: {
        label: string;
        request: { parent: FakeAgent; toolFilter?: { deny: string[] } };
      }) {
        const childId = `sess-child-${++childCounter}`;
        children.push({ childId, label: spec.label, request: spec.request });
        return { childId, messageId: 'm-fake' };
      },
      async followup(_parent: unknown, childId: string, content: { type: string; text: string }[]) {
        deliveries.push({
          childId,
          text: content.map((c) => ('text' in c ? c.text : '')).join(''),
        });
        return 'm-fake';
      },
      interrupt(target: string) {
        interrupts.push(target);
      },
    },
    agents: { get: (id: string) => captains.get(id) },
    tools: {
      registered: [] as { name: string }[],
      register(tool: { name: string }) {
        this.registered.push(tool);
      },
    },
    systemPrompt: {
      sections: [] as { name: string; order: number; text: string }[],
      section(s: { name: string; order: number; text: string }) {
        this.sections.push(s);
      },
    },
  } as unknown as Context;

  const runtime = {
    ctx,
    children,
    deliveries,
    interrupts,
    captains,
    addChild(agent: FakeAgent) {
      captains.set(agent.id, agent);
    },
  };
  return runtime;
}

// ---------- harness ----------

let workspace: string;
let config: ETeamsResolvedConfig;
let runtime: ReturnType<typeof fakeRuntime>;
let captain: FakeAgent;
let captainTools: ReturnType<typeof createCaptainTools>;
let memberTools: ReturnType<typeof createMemberTools>;

function captainTool(name: string) {
  const tool = captainTools.find((t) => t.name === name);
  if (!tool) throw new Error(`captain tool missing: ${name}`);
  return tool;
}

function memberTool(name: string) {
  const tool = memberTools.find((t) => t.name === name);
  if (!tool) throw new Error(`member tool missing: ${name}`);
  return tool;
}

async function cap<T>(name: string, args: Record<string, unknown>): Promise<T> {
  return (await captainTool(name).execute(
    args as never,
    { agent: captain, signal: undefined } as never,
  )) as T;
}

function memberAgent(childId: string): FakeAgent {
  const agent = fakeAgent(childId, workspace, captain.id);
  runtime.addChild(agent);
  return agent;
}

async function mem<T>(agent: FakeAgent, name: string, args: Record<string, unknown>): Promise<T> {
  return (await memberTool(name).execute(
    args as never,
    { agent, signal: undefined } as never,
  )) as T;
}

function readTeam(): TeamState {
  const file = join(workspace, '.eteams');
  // Team dirs only — the state root also holds files (roster.json,
  // employee-seq.json) and sibling dirs (archive/, logs/).
  const dirs = readdirSync(file, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const id = dirs[0]!;
  return JSON.parse(readFileSync(join(file, id, 'team.json'), 'utf8')) as TeamState;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'eteams-lifecycle-'));
  const resolved = ETeamsConfig({}) as ETeamsResolvedConfig;
  config = { ...resolved, stateDir: '.eteams' };
  runtime = fakeRuntime(workspace);
  captain = fakeAgent('cap-1', workspace);
  runtime.addChild(captain);
  captainTools = createCaptainTools(config, runtime.ctx);
  memberTools = createMemberTools(config, runtime.ctx);
  for (const tool of captainTools) runtime.ctx.tools.register(tool);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

// ---------- the DoD flow ----------

describe('M1 lifecycle (offline full flow)', () => {
  it('runs 问询 → 建队 → staged → 批准 → 指派 → 链推进 → 完成 → 通知', async () => {
    // 1. 问询 + 建队（staged）
    const created = await cap<{ ok: true; teamId: string; phase: string }>('eteams_create_team', {
      name: '导出功能团队',
      goal: '为应用实现数据导出功能',
      questionnaire: ['交付格式？', '验收偏好？', '范围边界？', '技术约束？', '优先级？'],
    });
    expect(created.ok).toBe(true);
    expect(created.phase).toBe('staged');
    expect(created.planReviewState).toBe('awaiting_review');

    const teamId = created.teamId;

    // 2. 成员 + 任务（含执行链）进入计划
    const alice = await cap<{ ok: true; member: string; status: string }>('eteams_add_member', {
      name: 'Alice',
      role: 'researcher',
      teamId,
    });
    const bob = await cap<{ ok: true }>('eteams_add_member', {
      name: 'Bob',
      role: 'engineer',
      teamId,
    });
    expect(alice.status).toBe('staged');
    expect(bob.ok).toBe(true);

    const task = await cap<{ ok: true; taskId: string; status: string }>('eteams_create_task', {
      subject: '调研导出方案并实现',
      description: '先调研 CSV/JSON 方案，再实现导出模块',
      acceptance: ['支持 CSV 导出', '支持 JSON 导出', '单测覆盖'],
      inScope: ['src/export'],
      outOfScope: ['导入功能'],
      dependencies: [],
      chain: [
        { member: 'Alice', stageBrief: '产出选型结论与接口约定' },
        { member: 'Bob', stageBrief: '按约定实现导出模块与单测' },
      ],
      // staged 队伍 → 草稿
      ...{},
    });
    expect(task.status).toBe('draft');

    const dependent = await cap<{ ok: true; taskId: string }>('eteams_create_task', {
      subject: '编写导出功能文档',
      dependencies: [task.taskId],
    });
    expect(dependent.ok).toBe(true);

    // 3. 领队不可自批：eteams_approve_plan 不存在于领队工具面
    expect(captainTools.some((t) => t.name === 'eteams_approve_plan')).toBe(false);
    expect(captainTools.some((t) => t.name === 'eteams_claim_task')).toBe(false);
    expect(memberTools.some((t) => t.name === 'eteams_assign_task')).toBe(false);

    // 4. 批准（UI 路由模拟；M1 headless 用内部函数）→ 生成文档 + spawn
    const approved = await approvePlan(runtimeEnvFor(), captain as never, teamId);
    expect(approved.phase).toBe('running');
    expect(approved.planReviewState).toBe('approved');
    expect(approved.workDir).toBe('teams/导出功能团队');
    expect(runtime.children).toHaveLength(2);
    expect(runtime.children[0]!.request.toolFilter?.deny).toContain('eteams_assign_task');

    // 任务文件夹（D12）
    const workDir = join(workspace, 'teams', '导出功能团队');
    expect(existsSync(join(workDir, 'README.md'))).toBe(true);
    const taskFolders = readdirSync(join(workDir, 'tasks'));
    expect(taskFolders.some((f) => f.startsWith('t1-'))).toBe(true);
    expect(existsSync(join(workDir, 'tasks', taskFolders[0]!, 'contract.md'))).toBe(true);
    expect(existsSync(join(workDir, 'tasks', taskFolders[0]!, 'notes.md'))).toBe(true);

    // 5. 指派链任务首站 → Alice
    const assigned = await cap<{ ok: true; taskId: string; member: string; attemptId: string }>(
      'eteams_assign_task',
      {
        taskId: task.taskId,
        member: 'Alice',
      },
    );
    expect(assigned.member).toBe('Alice');
    expect(assigned.attemptId).toBe('a1');
    // 指派信已投递（邮箱 + followup 唤醒）
    expect(
      runtime.deliveries.some(
        (d) => d.childId === runtime.children[0]!.childId && d.text.includes('执行链'),
      ),
    ).toBe(true);

    const aliceAgent = memberAgent(runtime.children[0]!.childId);

    // 6. claim → token；错误 token 全部拒绝
    const claimed = await mem<{ ok: true; attemptId: string; token: string; contract: string }>(
      aliceAgent,
      'eteams_claim_task',
      { taskId: task.taskId },
    );
    expect(claimed.token).toMatch(/^[0-9a-f]{24}$/);
    expect(claimed.contract).toContain('验收标准');

    const badToken = {
      taskId: task.taskId,
      attemptId: claimed.attemptId,
      token: 'deadbeef'.repeat(3),
      text: '开工',
    };
    await expect(mem(aliceAgent, 'eteams_append_progress', badToken)).rejects.toThrow(/token/);

    await mem(aliceAgent, 'eteams_append_progress', {
      taskId: task.taskId,
      attemptId: claimed.attemptId,
      token: claimed.token,
      text: '方案调研完成',
    });

    // 7. 中间站完成 → 任务回 ready + 领队收到续派通知
    const stationDone = await mem<{ ok: true; done: boolean }>(aliceAgent, 'eteams_complete_task', {
      taskId: task.taskId,
      attemptId: claimed.attemptId,
      token: claimed.token,
      output: '选型 CSV+JSON 双方案，接口约定见 notes',
      changedPaths: ['docs/export.md'],
    });
    expect(stationDone.done).toBe(false);
    let team = readTeam();
    expect(team.tasks[0]!.status).toBe('ready');
    expect(team.tasks[0]!.chainCursor).toBe(0);
    const captainNotified = captain.followups.at(-1)!.text;
    expect(captainNotified).toContain('下一站');
    expect(captainNotified).toContain('Bob');

    // 8. 偏离链被拒绝（无 deviationNote）
    const carol = await cap<{ ok: true }>('eteams_add_member', {
      name: 'Carol',
      role: 'engineer',
      teamId,
    });
    expect(carol.ok).toBe(true);
    await expect(
      cap('eteams_assign_task', { taskId: task.taskId, member: 'Carol' }),
    ).rejects.toThrow(/deviation_note|偏离/);
    // deviation_note 提供时放行 → chain.deviated 事件
    await expect(
      cap('eteams_assign_task', {
        taskId: task.taskId,
        member: 'Carol',
        deviationNote: 'Bob 临时不可用',
      }),
    ).resolves.toBeTruthy();
    team = readTeam();
    expect(team.tasks[0]!.assignee).toBe('Carol');

    // Carol claim + 完成末站
    const carolChild = runtime.children.find((c) => c.label.endsWith(':Carol'))!;
    const carolAgent = memberAgent(carolChild.childId);
    const carolClaim = await mem<{ token: string; attemptId: string }>(
      carolAgent,
      'eteams_claim_task',
      { taskId: task.taskId },
    );
    await mem(carolAgent, 'eteams_append_progress', {
      taskId: task.taskId,
      attemptId: carolClaim.attemptId,
      token: carolClaim.token,
      text: '实现中',
    });
    const finalDone = await mem<{ done: boolean }>(carolAgent, 'eteams_complete_task', {
      taskId: task.taskId,
      attemptId: carolClaim.attemptId,
      token: carolClaim.token,
      output: '导出模块实现完成，单测通过',
      changedPaths: ['src/export/index.ts'],
    });
    expect(finalDone.done).toBe(true);
    team = readTeam();
    expect(team.tasks[0]!.status).toBe('completed');
    expect(captain.followups.at(-1)!.text).toContain('任务已全部完成');

    // 9. advance 用尽后报错；依赖任务已可指派
    await expect(cap('eteams_advance_task', { taskId: task.taskId })).rejects.toThrow(
      /无后续站点|没有执行链|处于/,
    );
    const docAssign = await cap<{ ok: true }>('eteams_assign_task', {
      taskId: dependent.taskId,
      member: 'Alice',
    });
    expect(docAssign.ok).toBe(true);

    // 10. 失败重试链：Alice fail ×(maxRetries+1) → awaiting_decision
    // （重试指派为 pending_accept，成员需重新 claim 才能再次上报）
    const failOnce = async () => {
      const claim = await mem<{ token: string; attemptId: string }>(
        aliceAgent,
        'eteams_claim_task',
        { taskId: dependent.taskId },
      );
      await mem(aliceAgent, 'eteams_fail_task', {
        taskId: dependent.taskId,
        attemptId: claim.attemptId,
        token: claim.token,
        error: '格式不对',
      });
    };
    await failOnce();
    // 第一次失败 → 同成员立即重试（attempt kind=retry）
    team = readTeam();
    expect(team.tasks[1]!.status).toBe('assigned');
    const retryAttempt = team.tasks[1]!.attempts.at(-1)!;
    expect(retryAttempt.kind).toBe('retry');
    expect(retryAttempt.member).toBe('Alice');

    // 连续失败到超限（共 4 次 fail：1 + 3）
    for (let i = 0; i < 3; i++) {
      await failOnce();
    }
    team = readTeam();
    expect(team.tasks[1]!.status).toBe('awaiting_decision');
    expect(team.pendingDecisions).toHaveLength(1);
    expect(team.pendingDecisions[0]!.status).toBe('open');
    expect(captain.followups.at(-1)!.text).toContain('需决策');

    // 11. 状态与事件一致性
    const eventsRaw = readFileSync(join(workspace, '.eteams', teamId, 'events.jsonl'), 'utf8');
    expect(eventsRaw).toContain('team.created');
    expect(eventsRaw).toContain('plan.questionnaire');
    expect(eventsRaw).toContain('plan.approved');
    expect(eventsRaw).toContain('task.stage_completed');
    expect(eventsRaw).toContain('chain.deviated');
    expect(eventsRaw).toContain('task.completed');
    expect(eventsRaw).toContain('decision.requested');

    // 12. 非法转换被拒绝：completed 任务不能再 assign
    await expect(
      cap('eteams_assign_task', { taskId: task.taskId, member: 'Alice' }),
    ).rejects.toThrow(/只能指派 ready 任务|处于 completed/);

    // 13. 邮箱可见
    const mailbox = await cap<{ ok: true; messages: unknown[] }>('eteams_mailbox', {});
    expect(mailbox.messages.length).toBeGreaterThan(0);
  });

  it('rejects claim by a member the task is not assigned to', async () => {
    const created = await cap<{ teamId: string }>('eteams_create_team', {
      name: '拒绝测试',
      goal: 'g',
    });
    await cap('eteams_add_member', { name: 'Alice', role: 'engineer', teamId: created.teamId });
    await cap('eteams_add_member', { name: 'Bob', role: 'engineer', teamId: created.teamId });
    await approvePlan(runtimeEnvFor(), captain as never, created.teamId);
    await cap('eteams_create_task', { subject: '普通任务' });
    await cap('eteams_assign_task', { taskId: 't1', member: 'Alice' });
    const bobChild = runtime.children.find((c) => c.label.endsWith(':Bob'))!;
    const bobAgent = memberAgent(bobChild.childId);
    await expect(mem(bobAgent, 'eteams_claim_task', { taskId: 't1' })).rejects.toThrow(
      /未指派给你/,
    );
  });
});

describe('member spawn route resolution (leader model, user iteration 2026-09)', () => {
  it('spawns 跟随领队 members on the leader route; member overrides keep theirs', async () => {
    const created = await cap<{ teamId: string }>('eteams_create_team', {
      name: '领队路线团队',
      goal: 'g',
    });
    const teamId = created.teamId;
    await cap('eteams_add_member', { name: 'Follower', role: 'engineer', teamId });
    await cap('eteams_add_member', { name: 'Overrider', role: 'engineer', teamId });

    // Overrider pins its own route; the leader picks the team default.
    await setMemberModel(runtimeEnvFor(), captain as never, {
      teamId,
      name: 'Overrider',
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
    await setLeaderModel(runtimeEnvFor(), captain as never, {
      teamId,
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
    });
    expect(readTeam().leaderModelRoute).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      source: 'override',
    });

    await approvePlan(runtimeEnvFor(), captain as never, teamId);
    const follower = runtime.children.find((c) => c.label.endsWith(':Follower'))!;
    expect(follower.request.agentOptions).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
    });
    const overrider = runtime.children.find((c) => c.label.endsWith(':Overrider'))!;
    expect(overrider.request.agentOptions).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-chat',
    });

    // Clearing the leader route (empty body) back to 会话默认: a mid-run add
    // spawns with no agentOptions at all (session default).
    await setLeaderModel(runtimeEnvFor(), captain as never, { teamId });
    await cap('eteams_add_member', { name: 'Latecomer', role: 'engineer', teamId });
    const latecomer = runtime.children.find((c) => c.label.endsWith(':Latecomer'))!;
    expect(latecomer.request.agentOptions).toBeUndefined();
  });
});

// env builder shared by direct runtime calls
function runtimeEnvFor(): RuntimeEnv {
  return { ctx: runtime.ctx, config, workspace, signal: undefined };
}
