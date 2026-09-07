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
import { setLeaderModel, setMemberModel } from '../src/host/runtime/teamOps';
import {
  createTask,
  finalizeCommissionTask,
  startGroupTask,
  type OpActor,
} from '../src/host/runtime/assignment';
import { joinPath, type RuntimeEnv } from '../src/host/runtime/base';
import { readTeamSync } from '../src/host/state/store';
import { readEventsSync, readMailboxSync } from '../src/host/state/events';
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

/** v7 spawn label = `eteams-member:<teamId>:<主任务id>:<工号>`——按工号后缀
 * 定位子代理（队内工号唯一，同名成员也各归各）。 */
function childByEmployee(employeeId: number) {
  const child = runtime.children.find((c) => c.label.endsWith(`:${employeeId}`));
  if (!child) throw new Error(`未找到工号 ${employeeId} 的成员子代理`);
  return child;
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

    // 2. 拉人（班底模板 + staged 实例行；v7 工号 = 班底行自增主键（表自增，
    // 全局只增不复用）——领队 ET-0001，第一名成员 ET-0002，按入班底顺序续编）
    const alice = await cap<{ ok: true; member: string; teamId: number; employeeId: number }>(
      'eteams_add_member',
      { name: 'Alice', role: 'researcher', teamId },
    );
    const bob = await cap<{ ok: true; employeeId: number }>('eteams_add_member', {
      name: 'Bob',
      role: 'engineer',
      teamId,
    });
    const carol = await cap<{ ok: true; employeeId: number }>('eteams_add_member', {
      name: 'Carol',
      role: 'engineer',
      teamId,
    });
    expect(alice.member).toBe('Alice');
    // 表自增（v7）：建队先发领队班底行（主键 1 = ET-0001），成员号紧随其后。
    expect(alice.employeeId).toBe(2);
    expect(bob.employeeId).toBe(3);
    expect(carol.employeeId).toBe(4);
    // 链/占用全按工号（v7）：站点与指派都引用工号数字串（工具层字符串，
    // 宿主解析数字=工号），不再按名找人。
    const aliceId = String(alice.employeeId);
    const bobId = String(bob.employeeId);
    const carolId = String(carol.employeeId);

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
      // 十六轮 DA29：合同四数组（acceptance/inScope/outOfScope/deliverables）
      // 合并为一篇 Markdown（contractMd），工具参数同步收敛。
      contractMd: ['## 验收标准', '', '1. 支持 CSV 导出', '2. 支持 JSON 导出', '3. 单测覆盖'].join(
        '\n',
      ),
      chain: [
        { member: aliceId, stageBrief: '产出选型结论与接口约定' },
        { member: bobId, stageBrief: '按约定实现导出模块与单测' },
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
    // 十六轮 DA29：合同单字段回读（contract_md 列原样装回）。
    expect(sub.contractMd).toContain('支持 CSV 导出');
    expect(existsSync(join(workspace, 'teams', '导出功能团队', 'README.md'))).toBe(true);
    expect(existsSync(join(workspace, sub.workDir!, 'contract.md'))).toBe(true);
    expect(existsSync(join(workspace, sub.workDir!, 'notes.md'))).toBe(true);

    // v7 决策 5：建大任务即按班底全员铺副本（含领队）；领队班底行 ET-0001
    //（表自增：建队即入班底领首号）。
    const leaderTemplate = teamAfterCreate.members.find((m) => m.name === '项目牧羊人')!;
    expect(leaderTemplate.employeeId).toBe(1);
    const replicaIdsOf = (rootId: number) =>
      teamAfterCreate.taskMembers
        .filter((r) => r.mainTaskId === rootId)
        .map((r) => r.employeeId)
        .sort((a, b) => a - b);
    expect(replicaIdsOf(groupId)).toEqual([1, 2, 3, 4]);
    expect(replicaIdsOf(doc.taskId)).toEqual([1, 2, 3, 4]);

    // 5. 领队工具面 / 成员工具面互斥（审批环节已下线：无 approve 工具）
    expect(captainTools.some((t) => t.name === 'eteams_approve_plan')).toBe(false);
    expect(captainTools.some((t) => t.name === 'eteams_claim_task')).toBe(false);
    expect(memberTools.some((t) => t.name === 'eteams_assign_task')).toBe(false);

    // 6. 依赖未完成 → 拒绝指派依赖任务（校验在起会话之前，无副作用）
    await expect(cap('eteams_assign_task', { taskId: doc.taskId, member: bobId })).rejects.toThrow(
      /依赖未完成/,
    );

    // 7. 指派链任务首站 → Alice
    const assigned = await cap<{ ok: true; taskId: number; member: string; attemptId: number }>(
      'eteams_assign_task',
      { taskId: subId, member: aliceId },
    );
    expect(assigned.member).toBe('Alice');
    expect(Number.isInteger(assigned.attemptId) && assigned.attemptId > 0).toBe(true);
    // 指派信已投递（邮箱 + followup 唤醒），链任务首站信头含「执行链」。
    // v7 spawn label = eteams-member:<teamId>:<主任务id>:<工号>——按工号定位子代理。
    const aliceChild = childByEmployee(alice.employeeId);
    expect(
      runtime.deliveries.some((d) => d.childId === aliceChild.childId && d.text.includes('执行链')),
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
    // 收进 wakes 并 runWakes）。续派信下一站按工号渲染（stationLabel）。
    const midBox = await cap<{ ok: true; messages: { content: string }[] }>('eteams_mailbox', {});
    expect(midBox.messages.at(-1)!.content).toContain('下一站');
    expect(midBox.messages.at(-1)!.content).toContain(`ET-${String(bobId).padStart(4, '0')}`);

    // 10. 偏离链：改派 Carol 必须 deviationNote（D11），留痕后放行
    await expect(cap('eteams_assign_task', { taskId: subId, member: carolId })).rejects.toThrow(
      /deviation_note|偏离/,
    );
    await cap<{ ok: true }>('eteams_assign_task', {
      taskId: subId,
      member: carolId,
      deviationNote: 'Bob 临时不可用',
    });
    team = readTeam(teamId);
    expect(team.tasks.find((t) => t.id === subId)!.assignee).toBe('Carol');

    // Carol claim + 末站完成 → completed；chainCursor 不再推进（docs/35 §5#10
    // 观察项：显示层按完成态满进度口径承接，runtime 列保持现状）
    const carolChild = childByEmployee(carol.employeeId);
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
      member: bobId,
    });
    expect(docAssign.ok).toBe(true);

    // 12. 失败重试链：Bob fail ×4（maxRetries=3）→ 第 4 次进 wait_decision
    // （重试指派为 pending_accept，成员需重新 claim 才能再次上报）
    const docAgent = memberAgent(childByEmployee(bob.employeeId).childId);
    const failOnce = async (expectRetried: boolean) => {
      const claim = await mem<{ token: string; attemptId: number }>(docAgent, 'eteams_claim_task', {
        taskId: doc.taskId,
      });
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
    await expect(cap('eteams_assign_task', { taskId: subId, member: aliceId })).rejects.toThrow(
      /只能指派 ready|处于 completed/,
    );

    // 15. 邮箱可见
    const mailbox = await cap<{ ok: true; messages: unknown[] }>('eteams_mailbox', {});
    expect(mailbox.messages.length).toBeGreaterThan(0);
  });

  it('rejects claim by a member the task is not assigned to', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '拒绝测试' });
    const teamId = created.teamId;
    await cap('eteams_add_member', { name: 'Alice', role: 'engineer', teamId });
    const alice = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Alice',
      role: 'engineer',
      teamId,
    });
    const bob = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Bob',
      role: 'engineer',
      teamId,
    });
    const t1 = await cap<{ taskId: number }>('eteams_create_task', { subject: '普通任务' });
    const t2 = await cap<{ taskId: number }>('eteams_create_task', { subject: '旁路任务' });
    // Bob 先领一个自己的任务（首派起会话），才有成员身份可发起 claim。
    await cap('eteams_assign_task', { taskId: t2.taskId, member: String(bob.employeeId) });
    await cap('eteams_assign_task', { taskId: t1.taskId, member: String(alice.employeeId) });
    const bobChild = childByEmployee(bob.employeeId);
    const bobAgent = memberAgent(bobChild.childId);
    await expect(mem(bobAgent, 'eteams_claim_task', { taskId: t1.taskId })).rejects.toThrow(
      /未指派给你/,
    );
  });
});

describe('member spawn route resolution (per-member model, docs/35 §3#5)', () => {
  it('spawns members without agentOptions when no session default service is mounted', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '路线团队' });
    const teamId = created.teamId;
    const follower = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Follower',
      role: 'engineer',
      teamId,
    });
    const overrider = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Overrider',
      role: 'engineer',
      teamId,
    });
    const followerId = follower.employeeId;
    const overriderId = overrider.employeeId;

    // Overrider pins its own model; Follower keeps 会话默认（用户迭代
    // 2026-09-04：model 空串 = settings agent-default-model 即时快照）——
    // 本测试的 fake ctx 不挂 agentDefaultModel 服务，spawn 退回不带
    // agentOptions 的旧行为（provider 不再入档，派发时按
    // config.memberProvider 解析）。
    await setMemberModel(runtimeEnvFor(), captain as never, {
      teamId,
      name: 'Overrider',
      model: 'deepseek-chat',
    });

    const t1 = await cap<{ taskId: number }>('eteams_create_task', { subject: '默认任务' });
    await cap('eteams_assign_task', { taskId: t1.taskId, member: String(followerId) });
    const followerChild = childByEmployee(followerId);
    expect(followerChild.request.agentOptions).toBeUndefined();

    const t2 = await cap<{ taskId: number }>('eteams_create_task', { subject: '覆盖任务' });
    await cap('eteams_assign_task', { taskId: t2.taskId, member: String(overriderId) });
    const overriderChild = childByEmployee(overriderId);
    expect(overriderChild.request.agentOptions).toMatchObject({
      provider: 'spawn',
      model: 'deepseek-chat',
    });

    // 清空路线（不传 model）回会话默认；服务未挂的 ctx 里派发不带 agentOptions。
    await setMemberModel(runtimeEnvFor(), captain as never, { teamId, name: 'Overrider' });
    const latecomer = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Latecomer',
      role: 'engineer',
      teamId,
    });
    const t3 = await cap<{ taskId: number }>('eteams_create_task', { subject: '后补任务' });
    await cap('eteams_assign_task', { taskId: t3.taskId, member: String(latecomer.employeeId) });
    const latecomerChild = childByEmployee(latecomer.employeeId);
    expect(latecomerChild.request.agentOptions).toBeUndefined();
  });

  it('pins empty-route members to the host session-default model (会话默认)', async () => {
    // 宿主 agent-default-model 服务（settings 即时快照）挂到 fake ctx 上：
    // 模型路线为空的成员派发固定到它的 provider/model/reasoningEffort。
    (runtime.ctx as { agentDefaultModel?: unknown }).agentDefaultModel = {
      currentSelection: () => ({
        provider: 'ollama',
        model: 'glm-5.3-flash:cloud',
        reasoningEffort: 'low',
      }),
    };
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '默认团队' });
    const teamId = created.teamId;
    const defaults = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Defaults',
      role: 'engineer',
      teamId,
    });
    const t1 = await cap<{ taskId: number }>('eteams_create_task', { subject: '默认任务' });
    await cap('eteams_assign_task', { taskId: t1.taskId, member: String(defaults.employeeId) });
    const defaultsChild = childByEmployee(defaults.employeeId);
    expect(defaultsChild.request.agentOptions).toEqual({
      provider: 'ollama',
      model: 'glm-5.3-flash:cloud',
      reasoningEffort: 'low',
    });
  });

  it('setLeaderModel writes the 领队行 route (团队默认路线, 团队页领队卡)', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '领队路线' });
    const teamId = created.teamId;
    await setLeaderModel(runtimeEnvFor(), captain as never, {
      teamId,
      model: 'deepseek-chat',
      reasoningEffort: 'low',
    });
    const leader = readTeam(teamId).taskMembers.find((r) => r.mainTaskId === null)!;
    expect(leader.model).toBe('deepseek-chat');
    expect(leader.reasoningEffort).toBe('low');
    // 空 model 重置为会话默认（round-trip 后空串落库为 null → 内存缺省）。
    await setLeaderModel(runtimeEnvFor(), captain as never, { teamId });
    const after = readTeam(teamId).taskMembers.find((r) => r.mainTaskId === null)!;
    expect(after.model ?? '').toBe('');
    expect(after.reasoningEffort).toBeUndefined();
  });
});

describe('v7 同名成员按工号各归各', () => {
  it('spawns distinct labels/templates per employee id and keeps mailboxes apart', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '同名团队' });
    const teamId = created.teamId;
    const first = await cap<{ employeeId: number }>('eteams_add_member', {
      name: '张三',
      role: 'engineer',
      teamId,
    });
    const second = await cap<{ employeeId: number }>('eteams_add_member', {
      name: '张三',
      role: 'engineer',
      teamId,
    });
    // 同名成员各拿各号（表自增续编）。
    expect(first.employeeId).toBe(2);
    expect(second.employeeId).toBe(3);

    // 模板各归各：只给第二份设派发路线——按工号定位班底行，不错拿首份的。
    await setMemberModel(runtimeEnvFor(), captain as never, {
      teamId,
      name: '张三',
      employeeId: second.employeeId,
      model: 'deepseek-chat',
    });

    const t1 = await cap<{ taskId: number }>('eteams_create_task', { subject: '任务一' });
    const t2 = await cap<{ taskId: number }>('eteams_create_task', { subject: '任务二' });
    await cap('eteams_assign_task', { taskId: t1.taskId, member: String(first.employeeId) });
    await cap('eteams_assign_task', { taskId: t2.taskId, member: String(second.employeeId) });

    // spawn label = eteams-member:<teamId>:<主任务id>:<工号>——同名各是一行。
    const firstChild = childByEmployee(first.employeeId);
    const secondChild = childByEmployee(second.employeeId);
    expect(firstChild.childId).not.toBe(secondChild.childId);
    expect(firstChild.label).toBe(`eteams-member:${teamId}:${t1.taskId}:${first.employeeId}`);
    expect(secondChild.label).toBe(`eteams-member:${teamId}:${t2.taskId}:${second.employeeId}`);
    // 模板路线：首份空路线（无 agentOptions），第二份带上自己的覆盖。
    expect(firstChild.request.agentOptions).toBeUndefined();
    expect(secondChild.request.agentOptions).toMatchObject({ model: 'deepseek-chat' });

    // 邮箱按 (team, 工号) 分箱：各只收到自己的指派信，同名不串箱。
    const firstBox = readMailboxSync(root, teamId, String(first.employeeId));
    expect(firstBox.some((m) => m.content.includes('任务一'))).toBe(true);
    expect(firstBox.some((m) => m.content.includes('任务二'))).toBe(false);
    const secondBox = readMailboxSync(root, teamId, String(second.employeeId));
    expect(secondBox.some((m) => m.content.includes('任务二'))).toBe(true);
    expect(secondBox.some((m) => m.content.includes('任务一'))).toBe(false);
  });

  it('keeps claim attempts apart between same-name members（归属按副本行 id）', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '同名接单' });
    const teamId = created.teamId;
    const first = await cap<{ employeeId: number }>('eteams_add_member', {
      name: '张三',
      role: 'engineer',
      teamId,
    });
    const second = await cap<{ employeeId: number }>('eteams_add_member', {
      name: '张三',
      role: 'engineer',
      teamId,
    });
    const t1 = await cap<{ taskId: number }>('eteams_create_task', { subject: '首份的单' });
    const t2 = await cap<{ taskId: number }>('eteams_create_task', { subject: '次份的单' });
    // 两人各领一单 → 各有会话。
    await cap('eteams_assign_task', { taskId: t1.taskId, member: String(first.employeeId) });
    await cap('eteams_assign_task', { taskId: t2.taskId, member: String(second.employeeId) });
    const firstAgent = memberAgent(childByEmployee(first.employeeId).childId);
    const secondAgent = memberAgent(childByEmployee(second.employeeId).childId);

    // 同名第二人 claim 首份的任务：名字对得上（assignee 同名），但 attempt
    // 归属按副本行 id 精确匹配 → 「没有待接取的指派」，不越权接走。
    await expect(
      mem(secondAgent, 'eteams_claim_task', { taskId: t1.taskId }) as Promise<unknown>,
    ).rejects.toThrow(/没有待接取的指派/);
    // 首份本人 claim 正常拿 token。
    const claimed = await mem<{ token: string }>(firstAgent, 'eteams_claim_task', {
      taskId: t1.taskId,
    });
    expect(claimed.token).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe('v7 删除成员（工牌作废 + 会话工面截断 + 发号不回退）', () => {
  it('voids the badge: live child loses the member tool face and the sequence never reissues', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '离职团队' });
    const teamId = created.teamId;
    const dave = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Dave',
      role: 'engineer',
      teamId,
    });
    const t1 = await cap<{ taskId: number }>('eteams_create_task', { subject: '在办任务' });
    await cap('eteams_assign_task', { taskId: t1.taskId, member: String(dave.employeeId) });
    const daveChild = childByEmployee(dave.employeeId);
    const daveAgent = memberAgent(daveChild.childId);
    // 在册时工面正常（看板可读）。
    await mem(daveAgent, 'eteams_task_board', {});

    // 移出：班底行硬删（号作废）；任务回池；副本行不动（会话锚保留冷恢复价值）。
    await cap<{ ok: true }>('eteams_remove_member', { name: 'Dave', teamId });
    const fresh = readTeam(teamId);
    expect(fresh.members.find((m) => m.name === 'Dave')).toBeUndefined();
    expect(fresh.tasks.find((t) => t.id === t1.taskId)!.status).toBe('ready');

    // R1 离职截断：工牌已不在班底 → 存活子会话解析不出成员身份，工面就地失效。
    await expect(mem(daveAgent, 'eteams_task_board', {}) as Promise<unknown>).rejects.toThrow(
      /不在任何 eteams 团队中/,
    );

    // 发号不回退：新成员拿到计数器下一个号（3），不复用 Dave 的 2。
    const later = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Later',
      role: 'engineer',
      teamId,
    });
    expect(later.employeeId).toBe(3);
  });
});

describe('v7 删任务级联删副本 + drain', () => {
  it('cascades replica rows with the root task and drains resident children', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '删任务团队' });
    const teamId = created.teamId;
    await cap('eteams_add_member', { name: 'Dave', role: 'engineer', teamId });
    const made = await cap<{ taskId: number }>('eteams_create_task', { subject: '待删任务' });
    const rootId = made.taskId;
    // 建任务即全员铺副本（含领队）。
    expect(readTeam(teamId).taskMembers.filter((r) => r.mainTaskId === rootId)).toHaveLength(2);

    // 首派起会话（副本行拿到 session 锚），婉拒回池——pending_accept 的
    // attempt 婉拒即 revoked，行保留会话供 drain 验证。
    await cap('eteams_assign_task', { taskId: rootId, member: '2' });
    const daveAgent = memberAgent(childByEmployee(2).childId);
    await mem(daveAgent, 'eteams_decline_task', {
      taskId: rootId,
      reason: '先不动',
    });

    // 删除：副本行级联删（有会话的行 drain 驻留），任务行一并移除。
    await cap<{ ok: true }>('eteams_delete_task', { taskId: rootId });
    const fresh = readTeam(teamId);
    expect(fresh.tasks.find((t) => t.id === rootId)).toBeUndefined();
    expect(fresh.taskMembers.filter((r) => r.mainTaskId === rootId)).toHaveLength(0);
    // task.deleted 事件带 drain 留痕（副本行数量）。
    const events = readEventsSync(root, teamId);
    const deleted = events.find((e) => e.type === 'task.deleted');
    expect(deleted?.payload?.drainedReplicas).toBe(1);
  });
});

// env builder shared by direct runtime calls
function runtimeEnvFor(): RuntimeEnv {
  return { ctx: runtime.ctx, config, workspace, signal: undefined };
}

describe('面板手动建任务（docs/panelTaskCommission）', () => {
  /** 直连运行时的调用面（绕过工具层——宿主闸守卫在 runtime 层测）。 */
  const who = (teamId: number): OpActor => ({ teamId, actor: { kind: 'user', name: '用户' } });

  it('createTask status 覆盖：容器落 creating 占位，副本/文档树照常铺', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '建任务团队' });
    const env = runtimeEnvFor();
    const task = await createTask(env, who(created.teamId), {
      subject: '未命名任务',
      description: '把 docs 迁到新结构',
      kind: 'group',
      status: 'creating',
    });
    expect(task.status).toBe('creating');
    expect(task.parentId).toBeNull();
    // 建大任务即全员铺副本（含领队）+ work_dir 即分配 + 文档树物化。
    expect(readTeam(created.teamId).taskMembers.filter((r) => r.mainTaskId === task.id)).toHaveLength(
      1,
    );
    expect(task.workDir).toMatch(/^teams\//);
    expect(existsSync(join(workspace, task.workDir!, 'contract.md'))).toBe(true);
    // task.created 事件带初始 status（审计可回溯「这个容器是创建中来的」）。
    const events = readEventsSync(root, created.teamId);
    const createdEvent = events.find((e) => e.type === 'task.created' && e.taskId === task.id);
    expect(createdEvent?.payload?.status).toBe('creating');
  });

  it('startGroupTask 拒绝 creating 容器：计划未定不可开跑', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '开跑团队' });
    const env = runtimeEnvFor();
    const group = await createTask(env, who(created.teamId), {
      subject: '未命名任务',
      kind: 'group',
      status: 'creating',
    });
    // 整体开始的入口判据要求组内已有小任务（无子任务先撞「不是主任务」闸）
    // ——完善期拆出小任务后再整体开始，仍被创建中闸拦下。
    await createTask(env, who(created.teamId), {
      subject: '完善期拆出的小任务',
      parentTaskId: group.id,
    });
    await expect(startGroupTask(env, who(created.teamId), group.id)).rejects.toThrow(/创建中/);
  });

  it('assignTask 拒绝派发 creating 容器下的小任务（prepareAssignment 同闸，完善期不可偷跑）', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '偷跑团队' });
    const teamId = created.teamId;
    await cap('eteams_add_member', { name: 'Dave', role: 'engineer', teamId });
    const env = runtimeEnvFor();
    const group = await createTask(env, who(teamId), {
      subject: '未命名任务',
      kind: 'group',
      status: 'creating',
    });
    const sub = await createTask(env, who(teamId), {
      subject: '完善期拆出的小任务',
      parentTaskId: group.id,
    });
    expect(sub.status).toBe('ready');
    // 派发被宿主闸拦：父容器创建中，等完善收口。
    await expect(
      cap('eteams_assign_task', { taskId: sub.id, member: '2' }),
    ).rejects.toThrow(/创建中/);
  });

  it('finalizeCommissionTask：回写主题/说明 + creating→ready + 事件留痕 + 目录改名', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '收口团队' });
    const teamId = created.teamId;
    const env = runtimeEnvFor();
    const group = await createTask(env, who(teamId), {
      subject: '未命名任务',
      description: '原始一句话',
      kind: 'group',
      status: 'creating',
    });
    const oldDir = group.workDir!;
    const done = await finalizeCommissionTask(env, who(teamId), group.id, {
      subject: '迁移文档结构',
      description: '完善后的任务说明',
      contractMd: '## 验收标准\n1. 目录归位',
      questionnaire: ['范围边界？'],
    });
    expect(done.status).toBe('ready');
    expect(done.subject).toBe('迁移文档结构');
    expect(done.description).toBe('完善后的任务说明');
    // 改主题即目录改名（work_dir 归任务）：新目录存在、旧目录清空。
    expect(done.workDir).not.toBe(oldDir);
    expect(existsSync(join(workspace, done.workDir!, 'contract.md'))).toBe(true);
    expect(existsSync(join(workspace, oldDir))).toBe(false);
    // 事件：task.updated（via=commission.finalize）+ 问询留档 plan.questionnaire。
    const events = readEventsSync(root, teamId);
    const updated = events.find((e) => e.type === 'task.updated' && e.taskId === group.id);
    expect(updated?.payload?.via).toBe('commission.finalize');
    expect(updated?.payload?.fields).toContain('subject');
    const questionnaire = events.find(
      (e) => e.type === 'plan.questionnaire' && e.taskId === group.id,
    );
    expect(questionnaire?.payload?.questions).toEqual(['范围边界？']);
  });

  it('finalizeCommissionTask 非法目标拒绝：小任务不是提交目标、非 creating 不重复提交', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '收口拒团队' });
    const teamId = created.teamId;
    const env = runtimeEnvFor();
    const group = await createTask(env, who(teamId), {
      subject: '未命名任务',
      kind: 'group',
      status: 'creating',
    });
    const sub = await createTask(env, who(teamId), {
      subject: '完善期拆出的小任务',
      parentTaskId: group.id,
    });
    // 小任务（parent_id 非空）不能作为收口目标——拆解用 create_task。
    await expect(
      finalizeCommissionTask(env, who(teamId), sub.id, { subject: 'x' }),
    ).rejects.toThrow(/不是主任务/);
    // 已收口（ready）的主任务不能重复提交。
    await finalizeCommissionTask(env, who(teamId), group.id, { subject: '收口一次' });
    await expect(
      finalizeCommissionTask(env, who(teamId), group.id, { subject: '收口两次' }),
    ).rejects.toThrow(/无需重复提交/);
  });
});
