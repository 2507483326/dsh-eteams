/**
 * Offline lifecycle verification: the full DoD flow on the wave-2 SQLite
 * runtime（docs/35 §5#1 建队即生效，审批环节已下线）: 建队 → 拉人 →
 * submit_task（任务单容器）→ create_task 拆解（执行链）→ 指派 → 接取 → 进度
 * → 中间站完成 → 偏离改派 → 末站完成 → 组收口 → 依赖解锁 → 失败重试链 →
 * 待决策 → 通知/事件一致性；非法转换 / 坏 token / 无偏离说明的改派全部拒绝。
 * Runs against the real tool face with a fake subagent/agent runtime
 * replacing ctx.subagents/ctx.agents.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { resolveConfig, type ETeamsResolvedConfig } from '../src/host/config';
import { createCaptainTools } from '../src/host/tools/captainTools';
import { createMemberTools } from '../src/host/tools/memberTools';
import { setMemberModel } from '../src/host/runtime/teamOps';
import { joinPath, type RuntimeEnv } from '../src/host/runtime/base';
import { readTeamSync } from '../src/host/state/store';
import { readEventsSync } from '../src/host/state/events';
import type { TeamState } from '../src/host/model/types';
import { cleanupTempWorkspace } from './support/tmpWorkspace';

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
let root: string;
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

/** SQLite 契约读取（team.json 已随 SQLite 改造退场）：按 team_id 重装快照。
 * 状态根 root 与 runtime 同口径（base.ts joinPath 的「/」拼法）——getDb 连接
 * 缓存按它做键，afterEach 收尾才能关掉连接再删目录。 */
function readTeam(teamId: number): TeamState {
  const team = readTeamSync(root, teamId);
  if (team === undefined) throw new Error(`团队 ${teamId} 不存在`);
  return team;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'eteams-lifecycle-'));
  root = joinPath(workspace, '.eteams');
  config = resolveConfig({ stateDir: '.eteams' });
  runtime = fakeRuntime(workspace);
  captain = fakeAgent('cap-1', workspace);
  runtime.addChild(captain);
  captainTools = createCaptainTools(config, runtime.ctx);
  memberTools = createMemberTools(config, runtime.ctx);
  for (const tool of captainTools) runtime.ctx.tools.register(tool);
});

afterEach(() => {
  // 先关 SQLite 连接（两把键口径）再退避删目录——tests/support/tmpWorkspace。
  cleanupTempWorkspace(workspace);
});

// ---------- the DoD flow ----------

describe('lifecycle (offline full flow)', () => {
  it('runs 建队 → 拉人 → 任务单 → 拆解 → 指派 → 链推进 → 末站完成 → 组收口 → 重试 → 待决策', async () => {
    // 1. 建队（建队即生效，无审批环节）+ 问询留档
    const created = await cap<{ ok: true; teamId: number }>('eteams_create_team', {
      name: '导出功能团队',
      questionnaire: ['交付格式？', '验收偏好？', '范围边界？', '技术约束？', '优先级？'],
    });
    expect(created.ok).toBe(true);
    const teamId = created.teamId;
    expect(Number.isInteger(teamId) && teamId > 0).toBe(true);

    // 2. 拉人（班底模板 + staged 实例行；工号全库自增）
    const alice = await cap<{ ok: true; member: string; teamId: number; employeeId: number }>(
      'eteams_add_member',
      { name: 'Alice', role: 'researcher', teamId },
    );
    const bob = await cap<{ ok: true }>('eteams_add_member', {
      name: 'Bob',
      role: 'engineer',
      teamId,
    });
    await cap<{ ok: true }>('eteams_add_member', { name: 'Carol', role: 'engineer', teamId });
    expect(alice.member).toBe('Alice');
    expect(Number.isInteger(alice.employeeId) && alice.employeeId > 0).toBe(true);
    expect(bob.ok).toBe(true);

    // 3. 对话任务入口：任务单容器（docs/26）→ 专属文件夹立即分配
    const submitted = await cap<{ ok: true; taskId: number; status: string; folder: string }>(
      'eteams_submit_task',
      {
        subject: '调研导出方案并实现',
        description: '先调研 CSV/JSON 方案，再实现导出模块',
        questionnaire: ['交付格式？', '验收偏好？'],
      },
    );
    expect(submitted.status).toBe('ready');
    expect(submitted.folder).toMatch(/^teams\//);
    const groupId = submitted.taskId;

    // 4. 拆解：小任务挂到任务单下（chain 站点即成员槽）+ 依赖小任务
    const task = await cap<{ ok: true; taskId: number; status: string }>('eteams_create_task', {
      subject: '调研导出方案并实现',
      parentTaskId: groupId,
      acceptance: ['支持 CSV 导出', '支持 JSON 导出', '单测覆盖'],
      inScope: ['src/export'],
      outOfScope: ['导入功能'],
      chain: [
        { member: 'Alice', stageBrief: '产出选型结论与接口约定' },
        { member: 'Bob', stageBrief: '按约定实现导出模块与单测' },
      ],
    });
    expect(task.status).toBe('ready');
    const subId = task.taskId;

    const doc = await cap<{ ok: true; taskId: number }>('eteams_create_task', {
      subject: '编写导出功能文档',
      dependencies: [subId],
    });
    expect(doc.ok).toBe(true);

    // 任务文件夹（work_dir 归任务）：团队 README + 小任务 contract/notes 物化
    const teamAfterCreate = readTeam(teamId);
    const group = teamAfterCreate.tasks.find((t) => t.id === groupId)!;
    const sub = teamAfterCreate.tasks.find((t) => t.id === subId)!;
    expect(group.parentId).toBeNull();
    expect(sub.parentId).toBe(groupId);
    expect(existsSync(join(workspace, 'teams', '导出功能团队', 'README.md'))).toBe(true);
    expect(existsSync(join(workspace, sub.workDir!, 'contract.md'))).toBe(true);
    expect(existsSync(join(workspace, sub.workDir!, 'notes.md'))).toBe(true);

    // 5. 领队工具面 / 成员工具面互斥（审批环节已下线：无 approve 工具）
    expect(captainTools.some((t) => t.name === 'eteams_approve_plan')).toBe(false);
    expect(captainTools.some((t) => t.name === 'eteams_claim_task')).toBe(false);
    expect(memberTools.some((t) => t.name === 'eteams_assign_task')).toBe(false);

    // 6. 依赖未完成 → 拒绝指派依赖任务（校验在起会话之前，无副作用）
    await expect(
      cap('eteams_assign_task', { taskId: doc.taskId, member: 'Bob' }),
    ).rejects.toThrow(/依赖未完成/);

    // 7. 指派链任务首站 → Alice
    const assigned = await cap<{ ok: true; taskId: number; member: string; attemptId: number }>(
      'eteams_assign_task',
      { taskId: subId, member: 'Alice' },
    );
    expect(assigned.member).toBe('Alice');
    expect(Number.isInteger(assigned.attemptId) && assigned.attemptId > 0).toBe(true);
    // 指派信已投递（邮箱 + followup 唤醒），链任务首站信头含「执行链」
    const aliceChild = runtime.children.find((c) => c.label.endsWith(':Alice'))!;
    expect(
      runtime.deliveries.some(
        (d) => d.childId === aliceChild.childId && d.text.includes('执行链'),
      ),
    ).toBe(true);

    const aliceAgent = memberAgent(aliceChild.childId);

    // 8. claim → token；错误 token 拒绝
    const claimed = await mem<{ ok: true; attemptId: number; token: string; contract: string }>(
      aliceAgent,
      'eteams_claim_task',
      { taskId: subId },
    );
    expect(claimed.token).toMatch(/^[0-9a-f]{24}$/);
    expect(claimed.contract).toContain('验收标准');

    await expect(
      mem(aliceAgent, 'eteams_append_progress', {
        taskId: subId,
        attemptId: claimed.attemptId,
        token: 'deadbeef'.repeat(3),
        text: '开工',
      }),
    ).rejects.toThrow(/token/);

    await mem(aliceAgent, 'eteams_append_progress', {
      taskId: subId,
      attemptId: claimed.attemptId,
      token: claimed.token,
      text: '方案调研完成',
    });

    // 9. 中间站完成 → 任务回 ready + 领队收到续派通知（完成即续派）
    const stationDone = await mem<{ ok: true; done: boolean }>(aliceAgent, 'eteams_complete_task', {
      taskId: subId,
      attemptId: claimed.attemptId,
      token: claimed.token,
      output: '选型 CSV+JSON 双方案，接口约定见 notes',
      changedPaths: ['docs/export.md'],
    });
    expect(stationDone.done).toBe(false);
    let team = readTeam(teamId);
    const midTask = team.tasks.find((t) => t.id === subId)!;
    expect(midTask.status).toBe('ready');
    expect(midTask.chainCursor).toBe(0);
    // 领队通知落领队邮箱且领队会话被唤醒（notifyCaptainInTx 返回的 Wake
    // 收进 wakes 并 runWakes）。
    const midBox = await cap<{ ok: true; messages: { content: string }[] }>('eteams_mailbox', {});
    expect(midBox.messages.at(-1)!.content).toContain('下一站');
    expect(midBox.messages.at(-1)!.content).toContain('Bob');

    // 10. 偏离链：改派 Carol 必须 deviationNote（D11），留痕后放行
    await expect(
      cap('eteams_assign_task', { taskId: subId, member: 'Carol' }),
    ).rejects.toThrow(/deviation_note|偏离/);
    await cap<{ ok: true }>('eteams_assign_task', {
      taskId: subId,
      member: 'Carol',
      deviationNote: 'Bob 临时不可用',
    });
    team = readTeam(teamId);
    expect(team.tasks.find((t) => t.id === subId)!.assignee).toBe('Carol');

    // Carol claim + 末站完成 → completed；chainCursor 不再推进（docs/35 §5#10
    // 观察项：显示层按完成态满进度口径承接，runtime 列保持现状）
    const carolChild = runtime.children.find((c) => c.label.endsWith(':Carol'))!;
    const carolAgent = memberAgent(carolChild.childId);
    const carolClaim = await mem<{ token: string; attemptId: number }>(
      carolAgent,
      'eteams_claim_task',
      { taskId: subId },
    );
    await mem(carolAgent, 'eteams_append_progress', {
      taskId: subId,
      attemptId: carolClaim.attemptId,
      token: carolClaim.token,
      text: '实现中',
    });
    const finalDone = await mem<{ ok: true; done: boolean }>(carolAgent, 'eteams_complete_task', {
      taskId: subId,
      attemptId: carolClaim.attemptId,
      token: carolClaim.token,
      output: '导出模块实现完成，单测通过',
      changedPaths: ['src/export/index.ts'],
    });
    expect(finalDone.done).toBe(true);
    team = readTeam(teamId);
    const doneSub = team.tasks.find((t) => t.id === subId)!;
    expect(doneSub.status).toBe('completed');
    // 终站完成后 cursor 记末站下标（进度口径 cursor+1 = 全长，docs/26 链语义）。
    expect(doneSub.chainCursor).toBe(doneSub.chain.length - 1);
    const finalBox = await cap<{ ok: true; messages: { content: string }[] }>('eteams_mailbox', {});
    expect(finalBox.messages.at(-1)!.content).toContain('任务已全部完成');

    // 组收口（docs/26）：唯一小任务完成 → 任务单 ready→completed
    expect(team.tasks.find((t) => t.id === groupId)!.status).toBe('completed');

    // 11. 已完成任务不能再 advance；依赖任务在上游完成后可指派
    await expect(cap('eteams_advance_task', { taskId: subId })).rejects.toThrow(
      /只能指派 ready|处于 completed|无后续站点/,
    );
    const docAssign = await cap<{ ok: true; member: string }>('eteams_assign_task', {
      taskId: doc.taskId,
      member: 'Bob',
    });
    expect(docAssign.ok).toBe(true);

    // 12. 失败重试链：Bob fail ×4（maxRetries=3）→ 第 4 次进 wait_decision
    // （重试指派为 pending_accept，成员需重新 claim 才能再次上报）
    const docAgent = memberAgent(runtime.children.find((c) => c.label.endsWith(':Bob'))!.childId);
    const failOnce = async (expectRetried: boolean) => {
      const claim = await mem<{ token: string; attemptId: number }>(
        docAgent,
        'eteams_claim_task',
        { taskId: doc.taskId },
      );
      const failed = await mem<{
        ok: true;
        retried: boolean;
        retryCount: number;
        maxRetries: number;
      }>(docAgent, 'eteams_fail_task', {
        taskId: doc.taskId,
        attemptId: claim.attemptId,
        token: claim.token,
        error: '格式不对',
      });
      expect(failed.retried).toBe(expectRetried);
      expect(failed.maxRetries).toBe(3);
    };
    await failOnce(true); // 第 1 次失败 → 同成员立即重试（attempt kind=retry）
    team = readTeam(teamId);
    let docTask = team.tasks.find((t) => t.id === doc.taskId)!;
    expect(docTask.status).toBe('wait');
    expect(docTask.attempts.at(-1)!.kind).toBe('retry');
    expect(docTask.attempts.at(-1)!.member).toBe('Bob');
    expect(docTask.retryCount).toBe(1);

    await failOnce(true);
    await failOnce(true);
    await failOnce(false); // 第 4 次失败：retryCount 4 > maxRetries 3 → 待决策
    team = readTeam(teamId);
    docTask = team.tasks.find((t) => t.id === doc.taskId)!;
    expect(docTask.status).toBe('wait_decision');
    expect(docTask.retryCount).toBe(4);
    expect(team.pendingDecisions).toHaveLength(1);
    expect(team.pendingDecisions[0]!.status).toBe('open');
    const decisionBox = await cap<{ ok: true; messages: { content: string }[] }>(
      'eteams_mailbox',
      {},
    );
    expect(decisionBox.messages.at(-1)!.content).toContain('需决策');

    // 13. 事件一致性（SQLite events 表；偏离在 task.assigned payload，
    // chain.deviated 事件已随波次 2 下线）
    const events = readEventsSync(root, teamId);
    const types = events.map((e) => e.type);
    for (const expected of [
      'team.created',
      'plan.questionnaire',
      'task.created',
      'task.assigned',
      'attempt.claimed',
      'task.stage_completed',
      'task.completed',
      'task.retrying',
      'decision.requested',
    ]) {
      expect(types).toContain(expected);
    }
    expect(types).not.toContain('chain.deviated');
    const deviated = events.find(
      (e) => e.type === 'task.assigned' && e.payload?.deviation !== undefined,
    );
    expect(deviated?.payload?.deviation).toBe('Bob 临时不可用');

    // 14. 非法转换被拒绝：completed 任务不能再 assign
    await expect(
      cap('eteams_assign_task', { taskId: subId, member: 'Alice' }),
    ).rejects.toThrow(/只能指派 ready|处于 completed/);

    // 15. 邮箱可见
    const mailbox = await cap<{ ok: true; messages: unknown[] }>('eteams_mailbox', {});
    expect(mailbox.messages.length).toBeGreaterThan(0);
  });

  it('rejects claim by a member the task is not assigned to', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '拒绝测试' });
    const teamId = created.teamId;
    await cap('eteams_add_member', { name: 'Alice', role: 'engineer', teamId });
    await cap('eteams_add_member', { name: 'Bob', role: 'engineer', teamId });
    const t1 = await cap<{ taskId: number }>('eteams_create_task', { subject: '普通任务' });
    const t2 = await cap<{ taskId: number }>('eteams_create_task', { subject: '旁路任务' });
    // Bob 先领一个自己的任务（首派起会话），才有成员身份可发起 claim。
    await cap('eteams_assign_task', { taskId: t2.taskId, member: 'Bob' });
    await cap('eteams_assign_task', { taskId: t1.taskId, member: 'Alice' });
    const bobChild = runtime.children.find((c) => c.label.endsWith(':Bob'))!;
    const bobAgent = memberAgent(bobChild.childId);
    await expect(mem(bobAgent, 'eteams_claim_task', { taskId: t1.taskId })).rejects.toThrow(
      /未指派给你/,
    );
  });
});

describe('member spawn route resolution (per-member model, docs/35 §3#5)', () => {
  it('spawns 跟随 members with no agentOptions; member overrides keep theirs', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '路线团队' });
    const teamId = created.teamId;
    await cap('eteams_add_member', { name: 'Follower', role: 'engineer', teamId });
    await cap('eteams_add_member', { name: 'Overrider', role: 'engineer', teamId });

    // Overrider pins its own model; Follower stays 跟随（无 agentOptions，子
    // 会话继承领队会话模型——领队默认模型路线已随 docs/27 取消，provider 不
    // 再入档，派发时按 config.memberProvider 解析）。
    await setMemberModel(runtimeEnvFor(), captain as never, {
      teamId,
      name: 'Overrider',
      model: 'deepseek-chat',
    });

    const t1 = await cap<{ taskId: number }>('eteams_create_task', { subject: '跟随任务' });
    await cap('eteams_assign_task', { taskId: t1.taskId, member: 'Follower' });
    const follower = runtime.children.find((c) => c.label.endsWith(':Follower'))!;
    expect(follower.request.agentOptions).toBeUndefined();

    const t2 = await cap<{ taskId: number }>('eteams_create_task', { subject: '覆盖任务' });
    await cap('eteams_assign_task', { taskId: t2.taskId, member: 'Overrider' });
    const overrider = runtime.children.find((c) => c.label.endsWith(':Overrider'))!;
    expect(overrider.request.agentOptions).toMatchObject({
      provider: 'spawn',
      model: 'deepseek-chat',
    });

    // 清空路线（不传 model）回跟随：后加入成员的派发不带 agentOptions。
    await setMemberModel(runtimeEnvFor(), captain as never, { teamId, name: 'Overrider' });
    await cap('eteams_add_member', { name: 'Latecomer', role: 'engineer', teamId });
    const t3 = await cap<{ taskId: number }>('eteams_create_task', { subject: '后补任务' });
    await cap('eteams_assign_task', { taskId: t3.taskId, member: 'Latecomer' });
    const latecomer = runtime.children.find((c) => c.label.endsWith(':Latecomer'))!;
    expect(latecomer.request.agentOptions).toBeUndefined();
  });
});

// env builder shared by direct runtime calls
function runtimeEnvFor(): RuntimeEnv {
  return { ctx: runtime.ctx, config, workspace, signal: undefined };
}
