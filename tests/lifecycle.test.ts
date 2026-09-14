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
import { addMember, setLeaderModel, setMemberModel } from '../src/host/runtime/teamOps';
import {
  assignTask,
  cancelTask,
  createTask,
  finalizeCommissionTask,
  handleCaptainInterrupt,
  pauseTaskOnInterrupt,
  redeliverAssignment,
  startGroupTask,
  suspendGroupTask,
  type OpActor,
} from '../src/host/runtime/assignment';
import { joinPath, type RuntimeEnv } from '../src/host/runtime/base';
import { getDb } from '../src/host/state/db';
import { readTeamSync } from '../src/host/state/store';
import { readEventsSync, readMailboxSync } from '../src/host/state/events';
import { wakeMember } from '../src/host/runtime/notifier';
import {
  registerCaptainChild,
  unregisterCaptainChild,
} from '../src/host/runtime/captainChildRegistry';
import { clearSessionTeam, setSessionTeam } from '../src/host/runtime/sessionTeam';
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

/** 同 `cap`，但换一个调用会话（工具按会话身份解析 caller）。 */
async function capAs<T>(agent: FakeAgent, name: string, args: Record<string, unknown>): Promise<T> {
  return (await captainTool(name).execute(
    args as never,
    { agent, signal: undefined } as never,
  )) as T;
}

/** 已开出的「另一个对话」id（afterEach 清绑定，防跨用例泄漏）。 */
const otherConversations: string[] = [];

/**
 * 另开一个对话并绑定到同队（一个会话一个主任务：同队第二个顶层任务必须来自
 * 别的对话——`eteams_create_task` 在已锚定主任务的会话里会被入库守卫拒绝，
 * 用户迭代 2026-09-12）。
 */
function anotherConversation(teamId: number, name: string): FakeAgent {
  const id = `cap-${otherConversations.length + 2}`;
  const agent = fakeAgent(id, workspace);
  runtime.addChild(agent);
  setSessionTeam(id, { teamId: String(teamId), name, boundAt: Date.now() });
  otherConversations.push(id);
  return agent;
}

function memberAgent(childId: string): FakeAgent {
  const agent = fakeAgent(childId, workspace, captain.id);
  runtime.addChild(agent);
  return agent;
}

/** spawn label = `eteams-member:<名字>（T<主任务id>-ET<工号>）`——按工牌后缀
 * 定位子代理（队内工号唯一，同名成员也各归各）。 */
function childByEmployee(employeeId: number) {
  const badge = `ET${String(Math.max(0, Math.floor(employeeId))).padStart(4, '0')}`;
  const child = runtime.children.find((c) => c.label.includes(badge));
  if (!child) throw new Error(`未找到工号 ${employeeId} 的成员子代理`);
  return child;
}

/** 按 (大任务, 工号) 工牌精确定位子代理：同一成员跨任务各一行子会话，单按工号
 * 会命中该成员在别的任务下的子代理（弱顺序链用例里 Bob 同时进了两个任务）。 */
function childByBadge(mainTaskId: number, employeeId: number) {
  const badge = `T${mainTaskId}-ET${String(Math.max(0, Math.floor(employeeId))).padStart(4, '0')}`;
  const child = runtime.children.find((c) => c.label.includes(badge));
  if (!child) throw new Error(`未找到任务 ${mainTaskId} 工号 ${employeeId} 的成员子代理`);
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

/** 建一个 ready 主任务容器：收口闸（docs/taskOrchestrationRefinement）要求主任务
 * 下至少一个带非空「## 验收标准」的小任务——先建占位小任务过闸、收口后删掉，
 * 让只借收口拿 ready 容器的用例保持原语义（自建小任务的用例不受影响）。 */
async function submitReady(subject: string): Promise<{ taskId: number }> {
  const created = await cap<{ taskId: number }>('eteams_submit_task', { subject });
  const stub = await cap<{ taskId: number }>('eteams_create_task', {
    subject: '收口占位小任务',
    parentTaskId: created.taskId,
    contractMd: '## 验收标准\n1. 占位',
  });
  await cap('eteams_submit_task', { taskId: created.taskId, subject, skipQuestionnaire: true });
  await cap('eteams_delete_task', { taskId: stub.taskId });
  return created;
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
  // 会话绑定是模块级常驻状态（sessionTeam.bindings）：清掉本用例开出的额外
  // 对话，防跨用例泄漏（下一个用例 team id 从 1 重来，旧绑定会错配）。
  for (const id of otherConversations.splice(0)) clearSessionTeam(id);
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
    // 用户迭代 2026-09-12：对话建的主任务先落「创建中」（面板显示创建中/动画/禁点），
    // 拆解完后由 eteams_submit_task(taskId) 收口转「待开始」。
    expect(submitted.status).toBe('creating');
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
    // 收口：拆解完成后把「创建中」转「待开始」（收口闸要求主任务下至少一个带
    // 「## 验收标准」的小任务，故拆解完再收口）。
    const finalized = await cap<{ ok: true; status: string }>('eteams_submit_task', {
      taskId: groupId,
      subject: '调研导出方案并实现',
      description: '先调研 CSV/JSON 方案，再实现导出模块',
      questionnaire: ['交付格式？', '验收偏好？'],
    });
    expect(finalized.status).toBe('ready');

    // 一个会话一个主任务（入库守卫，用户迭代 2026-09-12）：第二个顶层任务
    // 必须来自另一个对话——用第二对话建它（同一会话会被入库守卫拒绝）。
    const doc = await capAs<{ ok: true; taskId: number }>(
      anotherConversation(teamId, '导出功能团队'),
      'eteams_create_task',
      { subject: '编写导出功能文档', dependencies: [subId] },
    );
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
    // 队伍留言板挂在**主任务**文件夹根下（小任务成员共享同一块，用户 2026-09-14）。
    expect(existsSync(join(workspace, group.workDir!, '留言板.md'))).toBe(true);

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

    // 6. 指派链任务首站 → Alice（依赖不再拦截派发，用户 2026-09-14
    // 「闸门拦住去掉吧」——该口径由「依赖未完成不再拦截派发」用例单独覆盖）
    const assigned = await cap<{ ok: true; taskId: number; member: string; attemptId: number }>(
      'eteams_assign_task',
      { taskId: subId, member: aliceId },
    );
    expect(assigned.member).toBe('Alice');
    expect(Number.isInteger(assigned.attemptId) && assigned.attemptId > 0).toBe(true);
    // 指派信已投递（邮箱 + followup 唤醒），链任务首站信头含「执行链」。
    // spawn label = eteams-member:<名字>（T<主任务id>-ET<工号>）——按工牌后缀定位子代理。
    const aliceChild = childByEmployee(alice.employeeId);
    expect(
      runtime.deliveries.some((d) => d.childId === aliceChild.childId && d.text.includes('执行链')),
    ).toBe(true);

    const aliceAgent = memberAgent(aliceChild.childId);

    // 7. claim → token；错误 token 拒绝
    const claimed = await mem<{ ok: true; attemptId: number; token: string; contract: string }>(
      aliceAgent,
      'eteams_claim_task',
      { taskId: subId },
    );
    expect(claimed.token).toMatch(/^[0-9a-f]{24}$/);
    expect(claimed.contract).toContain('验收标准');

    // render 是模型可见通道（dsh-tools 契约）：token 必须出现在 render 里，
    // 否则成员只看到 attempt_id，上报时会拿 attempt_id 冒充 token（token 校验失败）。
    const claimBlocks = memberTool('eteams_claim_task').output.render(
      {},
      claimed as never,
    ) as Array<{ type: string; text?: string }>;
    const claimRendered = claimBlocks.map((b) => b.text ?? '').join('');
    expect(claimRendered).toContain(claimed.token);
    expect(claimRendered).toContain(String(claimed.attemptId));

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

    // 8. 中间站完成 → 任务回 ready + 领队收到续派通知（完成即续派）
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

    // 9. 弱顺序链（用户 2026-09-13）：改派不在链上的 Carol 不再需要 deviationNote
    // ——系统自动补 task_members 副本行（幂等去重）并把 Carol 追加到链尾。
    const rowsBefore = readTeam(teamId).taskMembers.filter((r) => r.mainTaskId === groupId).length;
    await cap<{ ok: true; member: string }>('eteams_assign_task', {
      taskId: subId,
      member: carolId,
    });
    team = readTeam(teamId);
    const carolTask = team.tasks.find((t) => t.id === subId)!;
    expect(carolTask.assignee).toBe('Carol');
    expect(carolTask.chain.map((s) => s.member)).toEqual([
      alice.employeeId,
      bob.employeeId,
      carol.employeeId,
    ]);
    expect(team.taskMembers.filter((r) => r.mainTaskId === groupId).length).toBe(rowsBefore);

    // Carol claim + 完成（追加站 index 2）：因 Bob 站（index 1）还没跑，任务回 ready
    // 继续往后跑剩余站点，不误收口——弱顺序链 frontier 口径。
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
    const carolDone = await mem<{ ok: true; done: boolean }>(carolAgent, 'eteams_complete_task', {
      taskId: subId,
      attemptId: carolClaim.attemptId,
      token: carolClaim.token,
      output: '导出模块实现完成，单测通过',
      changedPaths: ['src/export/index.ts'],
    });
    expect(carolDone.done).toBe(false);
    team = readTeam(teamId);
    let doneSub = team.tasks.find((t) => t.id === subId)!;
    expect(doneSub.status).toBe('ready');
    expect(doneSub.chainCursor).toBe(0);
    const stageBox = await cap<{ ok: true; messages: { content: string }[] }>('eteams_mailbox', {});
    expect(stageBox.messages.at(-1)!.content).toContain('下一站');

    // 11. 继续把剩余站点跑完：Bob 跑 index 1 → 全站都有成功尝试 → 收口 completed。
    await cap<{ ok: true }>('eteams_assign_task', { taskId: subId, member: bobId });
    const bobChild = childByBadge(groupId, bob.employeeId);
    const bobAgent = memberAgent(bobChild.childId);
    const bobClaim = await mem<{ token: string; attemptId: number }>(bobAgent, 'eteams_claim_task', {
      taskId: subId,
    });
    const finalDone = await mem<{ ok: true; done: boolean }>(bobAgent, 'eteams_complete_task', {
      taskId: subId,
      attemptId: bobClaim.attemptId,
      token: bobClaim.token,
      output: '导出模块实现完成，单测通过',
      changedPaths: ['src/export/index.ts'],
    });
    expect(finalDone.done).toBe(true);
    team = readTeam(teamId);
    doneSub = team.tasks.find((t) => t.id === subId)!;
    expect(doneSub.status).toBe('completed');
    // 终站完成后 cursor 记末站下标（进度口径 cursor+1 = 全长，docs/26 链语义）。
    expect(doneSub.chainCursor).toBe(doneSub.chain.length - 1);
    const finalBox = await cap<{ ok: true; messages: { content: string }[] }>('eteams_mailbox', {});
    expect(finalBox.messages.at(-1)!.content).toContain('任务已全部完成');

    // 组收口（docs/26）：唯一小任务完成 → 任务单 ready→completed
    expect(team.tasks.find((t) => t.id === groupId)!.status).toBe('completed');

    // 12. 已完成任务不能再 advance；依赖任务在上游完成后可指派
    await expect(cap('eteams_advance_task', { taskId: subId })).rejects.toThrow(
      /只能指派 ready|处于 completed|无后续站点/,
    );
    const docAssign = await cap<{ ok: true; member: string }>('eteams_assign_task', {
      taskId: doc.taskId,
      member: bobId,
    });
    expect(docAssign.ok).toBe(true);

    // 12. 失败重试链：Bob fail ×4（maxRetries=3）→ 第 4 次落 wait（待领队
    // 分诊，用户迭代 2026-09-11）——不再进 wait_user/DecisionRecord，改由
    // 领队 reassign loop 或 escalate 升级（重试指派为 pending_accept，成员
    // 需重新 claim 才能再次上报）。
    const docAgent = memberAgent(childByBadge(doc.taskId, bob.employeeId).childId);
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
    // 用户迭代 2026-09-11：重试排队归位 ready。
    expect(docTask.status).toBe('ready');
    expect(docTask.attempts.at(-1)!.kind).toBe('retry');
    expect(docTask.attempts.at(-1)!.member).toBe('Bob');
    expect(docTask.retryCount).toBe(1);

    await failOnce(true);
    await failOnce(true);
    await failOnce(false); // 第 4 次失败：retryCount 4 > maxRetries 3 → wait
    team = readTeam(teamId);
    docTask = team.tasks.find((t) => t.id === doc.taskId)!;
    expect(docTask.status).toBe('wait');
    expect(docTask.retryCount).toBe(4);
    // 失败不再开决策（那是待用户的载体）——先交领队分诊。
    expect(team.pendingDecisions).toHaveLength(0);
    const failedBox = await cap<{ ok: true; messages: { content: string }[] }>('eteams_mailbox', {});
    expect(failedBox.messages.at(-1)!.content).toContain('待领队');

    // 12b. 领队从 wait 重新指派 loop（小 bug 分支）：member 缺省=最近执行者
    // Bob，任务回 ready、开新 attempt。
    const looped = await cap<{ ok: true; member: string; attemptId: number }>(
      'eteams_reassign_task',
      { taskId: doc.taskId, member: bobId },
    );
    expect(looped.member).toBe('Bob');
    team = readTeam(teamId);
    docTask = team.tasks.find((t) => t.id === doc.taskId)!;
    expect(docTask.status).toBe('ready');

    // 12c. 再失败一次超限（retryCount 5）→ 落 wait，再用 eteams_escalate_task
    // 升级为 wait_user + 开决策（流程/环境问题分支）。
    await failOnce(false); // 第 5 次失败：5 > 3 → 直接 wait（不重试）
    team = readTeam(teamId);
    docTask = team.tasks.find((t) => t.id === doc.taskId)!;
    expect(docTask.status).toBe('wait');
    expect(docTask.retryCount).toBe(5);
    const escalated = await cap<{ ok: true; taskId: number }>('eteams_escalate_task', {
      taskId: doc.taskId,
      note: '环境缺少依赖，需要用户决策',
    });
    expect(escalated.ok).toBe(true);
    team = readTeam(teamId);
    docTask = team.tasks.find((t) => t.id === doc.taskId)!;
    expect(docTask.status).toBe('wait_user');
    expect(team.pendingDecisions).toHaveLength(1);
    expect(team.pendingDecisions[0]!.status).toBe('open');
    const decisionBox = await cap<{ ok: true; messages: { content: string }[] }>(
      'eteams_mailbox',
      {},
    );
    expect(decisionBox.messages.at(-1)!.content).toContain('待领队');

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
      'task.wait',
      'task.escalated',
      'decision.requested',
    ]) {
      expect(types).toContain(expected);
    }
    expect(types).not.toContain('chain.deviated');
    // 弱顺序链自动入链的留痕：Carol 的派发事件 station=2（追加到链尾的站），
    // 本次没有 deviationNote（不需要偏离审计）。
    const carolAssign = events.find(
      (e) => e.type === 'task.assigned' && e.payload?.member === 'Carol',
    );
    expect(carolAssign?.payload?.station).toBe(2);
    expect(carolAssign?.payload?.deviation).toBeUndefined();

    // 14. 非法转换被拒绝：completed 任务不能再 assign
    await expect(cap('eteams_assign_task', { taskId: subId, member: aliceId })).rejects.toThrow(
      /只能指派 ready|处于 completed/,
    );

    // 15. 邮箱可见
    const mailbox = await cap<{ ok: true; messages: unknown[] }>('eteams_mailbox', {});
    expect(mailbox.messages.length).toBeGreaterThan(0);
  });

  it('弱顺序链：不在链上的成员自动入链（幂等）且完成后继续跑剩余站点（用户 2026-09-13）', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '弱链团队' });
    const teamId = created.teamId;
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
    const task = await cap<{ ok: true; taskId: number }>('eteams_create_task', {
      subject: '弱链任务',
      chain: [{ member: String(alice.employeeId), stageBrief: 'A 站' }],
    });

    // 指派不在链上的 Bob：不需要 deviationNote，自动补副本行 + 追加到链尾。
    const rowsBefore = readTeam(teamId).taskMembers.filter(
      (r) => r.mainTaskId === task.taskId,
    ).length;
    await cap<{ ok: true }>('eteams_assign_task', {
      taskId: task.taskId,
      member: String(bob.employeeId),
    });
    let team = readTeam(teamId);
    let t = team.tasks.find((x) => x.id === task.taskId)!;
    expect(t.chain.map((s) => s.member)).toEqual([alice.employeeId, bob.employeeId]);
    expect(team.taskMembers.filter((r) => r.mainTaskId === task.taskId).length).toBe(rowsBefore);

    // Bob 先跑（追加站 index 1）：Alice 站（index 0）未跑 → 任务回 ready 继续往后，
    // 不误收口（弱顺序链 frontier = 最靠前未成功站）。
    const bobAgent = memberAgent(childByBadge(task.taskId, bob.employeeId).childId);
    const bobClaim = await mem<{ token: string; attemptId: number }>(
      bobAgent,
      'eteams_claim_task',
      { taskId: task.taskId },
    );
    const bobDone = await mem<{ ok: true; done: boolean }>(bobAgent, 'eteams_complete_task', {
      taskId: task.taskId,
      attemptId: bobClaim.attemptId,
      token: bobClaim.token,
      output: 'Bob 先做',
    });
    expect(bobDone.done).toBe(false);
    team = readTeam(teamId);
    t = team.tasks.find((x) => x.id === task.taskId)!;
    expect(t.status).toBe('ready');
    expect(t.chainCursor).toBe(-1); // frontier=0（Alice 站未跑）
    expect(t.attempts.at(-1)!.stationIndex).toBe(1);

    // 再次指派已在链上的 Bob（幂等）：链不重复追加。
    await cap<{ ok: true }>('eteams_assign_task', {
      taskId: task.taskId,
      member: String(bob.employeeId),
    });
    t = readTeam(teamId).tasks.find((x) => x.id === task.taskId)!;
    expect(t.chain).toHaveLength(2);

    // 改派回链上的 Alice 跑剩余站（index 0）→ 全站都有成功尝试 → 收口 completed。
    await cap<{ ok: true }>('eteams_reassign_task', {
      taskId: task.taskId,
      member: String(alice.employeeId),
    });
    t = readTeam(teamId).tasks.find((x) => x.id === task.taskId)!;
    expect(t.chain).toHaveLength(2);
    const aliceAgent = memberAgent(childByBadge(task.taskId, alice.employeeId).childId);
    const aliceClaim = await mem<{ token: string; attemptId: number }>(
      aliceAgent,
      'eteams_claim_task',
      { taskId: task.taskId },
    );
    const aliceDone = await mem<{ ok: true; done: boolean }>(aliceAgent, 'eteams_complete_task', {
      taskId: task.taskId,
      attemptId: aliceClaim.attemptId,
      token: aliceClaim.token,
      output: 'Alice 收尾',
    });
    expect(aliceDone.done).toBe(true);
    t = readTeam(teamId).tasks.find((x) => x.id === task.taskId)!;
    expect(t.status).toBe('completed');
    expect(t.chainCursor).toBe(1);
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
    // 第二个顶层任务来自另一个对话（一个会话一个主任务，入库守卫）。
    const t2 = await capAs<{ taskId: number }>(
      anotherConversation(teamId, '拒绝测试'),
      'eteams_create_task',
      { subject: '旁路任务' },
    );
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
    // agentOptions 的旧行为。v9 provider 回归：覆盖路线带目录 provider，
    // spawn 原样传 agentOptions.provider（不再是 'spawn'/'fork' 传输名）。
    await setMemberModel(runtimeEnvFor(), captain as never, {
      teamId,
      name: 'Overrider',
      provider: 'deepseek',
      model: 'deepseek-chat',
    });

    const t1 = await cap<{ taskId: number }>('eteams_create_task', { subject: '默认任务' });
    await cap('eteams_assign_task', { taskId: t1.taskId, member: String(followerId) });
    const followerChild = childByEmployee(followerId);
    expect(followerChild.request.agentOptions).toBeUndefined();

    // 第二个顶层任务来自另一个对话（一个会话一个主任务，入库守卫）。
    const t2 = await capAs<{ taskId: number }>(
      anotherConversation(teamId, '路线团队'),
      'eteams_create_task',
      { subject: '覆盖任务' },
    );
    await cap('eteams_assign_task', { taskId: t2.taskId, member: String(overriderId) });
    const overriderChild = childByEmployee(overriderId);
    expect(overriderChild.request.agentOptions).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-chat',
    });

    // 清空路线（不传 model）回会话默认；服务未挂的 ctx 里派发不带 agentOptions。
    await setMemberModel(runtimeEnvFor(), captain as never, { teamId, name: 'Overrider' });
    const latecomer = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Latecomer',
      role: 'engineer',
      teamId,
    });
    // 第三个顶层任务再来自第三个对话（同上，一个会话一个主任务）。
    const t3 = await capAs<{ taskId: number }>(
      anotherConversation(teamId, '路线团队'),
      'eteams_create_task',
      { subject: '后补任务' },
    );
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

  it('setLeaderModel writes the 班底领队行 route (团队默认路线, 团队页领队卡)', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '领队路线' });
    const teamId = created.teamId;
    await setLeaderModel(runtimeEnvFor(), captain as never, {
      teamId,
      provider: 'tr-test',
      model: 'deepseek-chat',
      reasoningEffort: 'low',
    });
    // v9 存储位 = 班底领队行（team_members.is_leader=1 的 modelRoute，与
    // 成员同表同列——用户手改/查看都在 team_members）。
    const leader = readTeam(teamId).members.find((m) => m.isLeader === true)!;
    expect(leader.modelRoute.model).toBe('deepseek-chat');
    expect(leader.modelRoute.provider).toBe('tr-test');
    expect(leader.modelRoute.reasoningEffort).toBe('low');
    // 空 model 重置为会话默认（round-trip 后空串落库为 null → 内存缺省）。
    await setLeaderModel(runtimeEnvFor(), captain as never, { teamId });
    const after = readTeam(teamId).members.find((m) => m.isLeader === true)!.modelRoute;
    expect(after.model).toBe('');
    expect(after.provider).toBeUndefined();
    expect(after.reasoningEffort).toBeUndefined();
  });

  it('syncs a member route into its task_members replica rows (成员表, 2026-09-12)', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '同步成员表' });
    const teamId = created.teamId;
    const nova = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Nova',
      role: 'engineer',
      teamId,
    });
    const twin = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Nova',
      role: 'engineer',
      teamId,
    });
    // 建两个大任务 → 各成员名下各两条副本行（同名按工号各归各）。第二个大
    // 任务来自第二个对话（一个会话一个主任务，入库守卫，用户迭代 2026-09-12）。
    await cap<{ taskId: number }>('eteams_create_task', { subject: '任务一' });
    await capAs<{ taskId: number }>(
      anotherConversation(teamId, '同步成员表'),
      'eteams_create_task',
      { subject: '任务二' },
    );
    const rowsOf = (employeeId: number): TeamState['taskMembers'] =>
      readTeam(teamId).taskMembers.filter((r) => r.employeeId === employeeId);
    expect(rowsOf(nova.employeeId)).toHaveLength(2);

    // 改模型 → 该工号名下每条副本行整组带上新路线（用户迭代 2026-09-12：
    // 副本行不再停在建任务时的旧值）；同名另一人的副本行不受影响。
    await setMemberModel(runtimeEnvFor(), captain as never, {
      teamId,
      name: 'Nova',
      employeeId: nova.employeeId,
      provider: 'tr-test',
      model: 'z-ai/glm-5.3-free',
      reasoningEffort: 'high',
    });
    for (const row of rowsOf(nova.employeeId)) {
      expect(row.model).toBe('z-ai/glm-5.3-free');
      expect(row.provider).toBe('tr-test');
      expect(row.reasoningEffort).toBe('high');
    }
    for (const row of rowsOf(twin.employeeId)) {
      expect(row.model ?? '').toBe('');
      expect(row.provider ?? '').toBe('');
      expect(row.reasoningEffort ?? '').toBe('');
    }

    // 重置回会话默认 → 副本行三列一并清空（空串 = 跟随，不留旧 override）。
    await setMemberModel(runtimeEnvFor(), captain as never, {
      teamId,
      name: 'Nova',
      employeeId: nova.employeeId,
    });
    for (const row of rowsOf(nova.employeeId)) {
      expect(row.model ?? '').toBe('');
      expect(row.provider ?? '').toBe('');
      expect(row.reasoningEffort ?? '').toBe('');
    }
  });

  it('syncs the leader route into its task_members replica rows (领队同口径)', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '同步领队' });
    const teamId = created.teamId;
    await cap<{ taskId: number }>('eteams_create_task', { subject: '领队任务' });
    const leaderId = readTeam(teamId).members.find((m) => m.isLeader === true)!.employeeId!;
    expect(readTeam(teamId).taskMembers.some((r) => r.employeeId === leaderId)).toBe(true);

    await setLeaderModel(runtimeEnvFor(), captain as never, {
      teamId,
      provider: 'tr-test',
      model: 'deepseek-chat',
      reasoningEffort: 'low',
    });
    for (const row of readTeam(teamId).taskMembers.filter((r) => r.employeeId === leaderId)) {
      expect(row.model).toBe('deepseek-chat');
      expect(row.provider).toBe('tr-test');
      expect(row.reasoningEffort).toBe('low');
    }

    await setLeaderModel(runtimeEnvFor(), captain as never, { teamId });
    for (const row of readTeam(teamId).taskMembers.filter((r) => r.employeeId === leaderId)) {
      expect(row.model ?? '').toBe('');
      expect(row.provider ?? '').toBe('');
    }
  });

  it('copies the full route (含 provider) into replica rows when adding a member', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '加人带路线' });
    const teamId = created.teamId;
    // 先建任务，再带路线加人 —— 加成员路径的副本行整组抄（v9 provider 不再漏抄，
    // 与 createTask 副本口径同源）。
    await cap<{ taskId: number }>('eteams_create_task', { subject: '既有任务' });
    const { member } = await addMember(runtimeEnvFor(), captain as never, {
      teamId,
      name: 'Route',
      role: 'engineer',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'medium',
    });
    const rows = readTeam(teamId).taskMembers.filter((r) => r.employeeId === member.employeeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe('deepseek-reasoner');
    expect(rows[0]!.provider).toBe('deepseek');
    expect(rows[0]!.reasoningEffort).toBe('medium');
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
    // 第二个顶层任务来自另一个对话（一个会话一个主任务，入库守卫）。
    const t2 = await capAs<{ taskId: number }>(
      anotherConversation(teamId, '同名团队'),
      'eteams_create_task',
      { subject: '任务二' },
    );
    await cap('eteams_assign_task', { taskId: t1.taskId, member: String(first.employeeId) });
    await cap('eteams_assign_task', { taskId: t2.taskId, member: String(second.employeeId) });

    // spawn label = eteams-member:<名字>（T<主任务id>-ET<工号>）——同名各是一行，
    // 名字在头部可见、工牌后缀保作用域。
    const firstChild = childByEmployee(first.employeeId);
    const secondChild = childByEmployee(second.employeeId);
    expect(firstChild.childId).not.toBe(secondChild.childId);
    expect(firstChild.label).toBe(`eteams-member:张三（T${t1.taskId}-ET0002）`);
    expect(secondChild.label).toBe(`eteams-member:张三（T${t2.taskId}-ET0003）`);
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
    // 第二单来自另一个对话（一个会话一个主任务，入库守卫）。
    const t2 = await capAs<{ taskId: number }>(
      anotherConversation(teamId, '同名接单'),
      'eteams_create_task',
      { subject: '次份的单' },
    );
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
    // 在册时工面正常（看板可读）。task_board 已并入 captain 工具（0.1.2 起
    // 同名工具合一）：成员 caller 走成员分支，用 captain 工具查找 + 成员
    // exec 调用。
    await captainTool('eteams_task_board').execute(
      {} as never,
      { agent: daveAgent, signal: undefined } as never,
    );

    // 移出：班底行硬删（号作废）；任务回池；副本行不动（会话锚保留冷恢复价值）。
    await cap<{ ok: true }>('eteams_remove_member', { name: 'Dave', teamId });
    const fresh = readTeam(teamId);
    expect(fresh.members.find((m) => m.name === 'Dave')).toBeUndefined();
    expect(fresh.tasks.find((t) => t.id === t1.taskId)!.status).toBe('ready');

    // R1 离职截断：工牌已不在班底 → 存活子会话解析不出成员身份，工面就地失效。
    await expect(
      captainTool('eteams_task_board').execute(
        {} as never,
        { agent: daveAgent, signal: undefined } as never,
      ) as Promise<unknown>,
    ).rejects.toThrow(/不在任何 eteams 团队中/);

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
    // 收口闸要求主任务下至少一个带「## 验收标准」的小任务。
    await createTask(env, who(teamId), {
      subject: '迁移目录结构',
      parentTaskId: group.id,
      contractMd: '## 验收标准\n1. 目录归位',
    });
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

  it('收口问询自检闸：未问询且未显式跳过 → 拒绝收口，容器停在「创建中」', async () => {
    // 用户 2026-09-12「应该要问就要在任务执行之前问」：收口（creating→ready）
    // 是开跑闸，未问询不得放行——宿主硬闸要求 questionnaire 或 skipQuestionnaire。
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '问询闸团队' });
    const teamId = created.teamId;
    const env = runtimeEnvFor();
    const group = await createTask(env, who(teamId), {
      subject: '未命名任务',
      kind: 'group',
      status: 'creating',
    });
    // 收口闸先过拆解质量（建一个带验收标准的小任务）；本用例只验问询闸。
    await createTask(env, who(teamId), {
      subject: '占位小任务',
      parentTaskId: group.id,
      contractMd: '## 验收标准\n1. 占位',
    });
    await expect(
      finalizeCommissionTask(env, who(teamId), group.id, { subject: '直接收口' }),
    ).rejects.toThrow(/收口前必须先完成问询/);
    // 被拒后主任务仍停在「创建中」——开不了跑（2026-09-13 起创建中可点进
    // 详情只读观望，此处只锁「不可开跑」语义）。
    expect(readTeam(teamId).tasks.find((t) => t.id === group.id)!.status).toBe('creating');
    // 显式跳过（用户已给全/要求直接开始）→ 放行转 ready。
    const skipped = await finalizeCommissionTask(env, who(teamId), group.id, {
      subject: '直接收口',
      skipQuestionnaire: true,
    });
    expect(skipped.status).toBe('ready');
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
      contractMd: '## 验收标准\n1. 拆解完成',
    });
    // 小任务（parent_id 非空）不能作为收口目标——拆解用 create_task。
    await expect(
      finalizeCommissionTask(env, who(teamId), sub.id, { subject: 'x' }),
    ).rejects.toThrow(/不是主任务/);
    // 已收口（ready）的主任务不能重复提交。
    await finalizeCommissionTask(env, who(teamId), group.id, {
      subject: '收口一次',
      skipQuestionnaire: true,
    });
    await expect(
      finalizeCommissionTask(env, who(teamId), group.id, { subject: '收口两次' }),
    ).rejects.toThrow(/无需重复提交/);
  });
});

describe('收口拆解质量闸（docs/taskOrchestrationRefinement 议题一）', () => {
  const who = (teamId: number): OpActor => ({ teamId, actor: { kind: 'user', name: '用户' } });

  async function freshGroup(): Promise<{ teamId: number; env: RuntimeEnv; groupId: number }> {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '收口闸团队' });
    const env = runtimeEnvFor();
    const group = await createTask(env, who(created.teamId), {
      subject: '主任务',
      kind: 'group',
      status: 'creating',
    });
    return { teamId: created.teamId, env, groupId: group.id };
  }

  it('空容器收口被拒：主任务必须拆出至少一个小任务，容器停在「创建中」', async () => {
    const { teamId, env, groupId } = await freshGroup();
    await expect(
      finalizeCommissionTask(env, who(teamId), groupId, {
        subject: '空容器',
        skipQuestionnaire: true,
      }),
    ).rejects.toThrow(/还没有任何小任务/);
    expect(readTeam(teamId).tasks.find((t) => t.id === groupId)!.status).toBe('creating');
  });

  it('小任务缺合同 → 拒绝收口', async () => {
    const { teamId, env, groupId } = await freshGroup();
    await createTask(env, who(teamId), { subject: '无合同小任务', parentTaskId: groupId });
    await expect(
      finalizeCommissionTask(env, who(teamId), groupId, {
        subject: '主任务',
        skipQuestionnaire: true,
      }),
    ).rejects.toThrow(/缺少任务合同/);
  });

  it('小任务合同缺「## 验收标准」段 → 拒绝收口', async () => {
    const { teamId, env, groupId } = await freshGroup();
    await createTask(env, who(teamId), {
      subject: '无验收标准小任务',
      parentTaskId: groupId,
      contractMd: '## 允许改动\n- x',
    });
    await expect(
      finalizeCommissionTask(env, who(teamId), groupId, {
        subject: '主任务',
        skipQuestionnaire: true,
      }),
    ).rejects.toThrow(/缺少「## 验收标准」段/);
  });

  it('全部小任务带非空验收标准 → 放行 creating→ready', async () => {
    const { teamId, env, groupId } = await freshGroup();
    await createTask(env, who(teamId), {
      subject: '合格小任务',
      parentTaskId: groupId,
      contractMd: '## 验收标准\n1. 通过',
    });
    const done = await finalizeCommissionTask(env, who(teamId), groupId, {
      subject: '主任务',
      skipQuestionnaire: true,
    });
    expect(done.status).toBe('ready');
  });
});

describe('主会话锚定（用户迭代 2026-09-12：子代理不挂在领队下面）', () => {
  const who = (teamId: number): OpActor => ({ teamId, actor: { kind: 'user', name: '用户' } });

  it('领队子代理拆解的小任务派发成员时，父锚换成主会话（不挂到领队子代理下）', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '锚定团队' });
    const teamId = created.teamId;
    const member = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Alice',
      role: 'engineer',
      teamId,
    });
    // 主对话建容器（main_session_id 快照 = cap-1）并收口转 ready。
    const group = await submitReady('导出主任务');
    // 领队子代理（独立会话）拆解小任务：小任务行快照记的是领队子会话
    // （既有口径，不改），但派发成员时锚点要换回它的主会话父（cap-1）——否则
    // 成员子代理挂到领队子代理下，harness 顶部列表要先展开领队才看得到其它
    // 子代理（用户迭代 2026-09-12）。
    const leaderEnv: RuntimeEnv = { ...runtimeEnvFor(), sessionId: 'leader-child-1' };
    const sub = await createTask(leaderEnv, who(teamId), {
      subject: '执行小任务',
      parentTaskId: group.taskId,
    });
    expect(readTeam(teamId).tasks.find((t) => t.id === sub.id)!.mainSessionId).toBe(
      'leader-child-1',
    );
    // 模拟领队子代理派发时的注册表条目（直接父 = 主会话 cap-1）。
    registerCaptainChild('leader-child-1', String(teamId), root, String(sub.id), 'cap-1');
    try {
      await cap('eteams_assign_task', { taskId: sub.id, member: String(member.employeeId) });
    } finally {
      unregisterCaptainChild('leader-child-1');
    }
    // spawn 的父锚是主会话（cap-1）——成员子代理与领队子代理平级，
    // harness 顶部子代理列表无需展开领队即可见。
    expect(childByEmployee(member.employeeId).request.parent.id).toBe('cap-1');
  });
});

describe('入库守卫：一个会话一个主任务（用户迭代 2026-09-12）', () => {
  const who = (teamId: number): OpActor => ({ teamId, actor: { kind: 'user', name: '用户' } });

  it('领队子代理漏传 parentTaskId：拒绝并**不落库**（#43–#45 事故回归）', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '守卫团队' });
    const teamId = created.teamId;
    // 主对话建容器（main_session_id 快照 = cap-1）并收口。
    const group = await submitReady('新建一个 Vue 项目');
    // 领队子代理（独立会话）带 parentTaskId 拆第一个小任务：照常入库。
    const leaderEnv: RuntimeEnv = { ...runtimeEnvFor(), sessionId: 'leader-child-1' };
    const sub = await createTask(leaderEnv, who(teamId), {
      subject: '初始化 Vue 3 + Vite + TS 工程与依赖配置',
      parentTaskId: group.taskId,
    });
    // 真实派发时锚定它主持的大任务的两条线索：注册表（进程内）+ 直接父会话。
    registerCaptainChild('leader-child-1', String(teamId), root, String(group.taskId), 'cap-1');
    try {
      // 漏传 parentTaskId：入库守卫在写库前拒绝——不能静默建成顶层任务
      // （主任务详情页的小任务列表按 parentId 过滤，散开就只剩一个）。
      await expect(
        createTask(leaderEnv, who(teamId), { subject: '路由首页与基础布局示例页' }),
      ).rejects.toThrow(new RegExp(`已有主任务 #${group.taskId}`));
    } finally {
      unregisterCaptainChild('leader-child-1');
    }
    const tasks = readTeam(teamId).tasks;
    // 只有带 parentTaskId 的那条挂上了；被拒的那条完全没落库。
    expect(tasks.filter((t) => t.parentId === group.taskId).map((t) => t.subject)).toEqual([
      sub.subject,
    ]);
    expect(tasks.some((t) => t.subject === '路由首页与基础布局示例页')).toBe(false);
    expect(tasks.filter((t) => t.parentId === null)).toHaveLength(1);
  });

  it('首次（本对话尚无主任务）放行：顶层任务照常入库', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '首次团队' });
    const task = await cap<{ taskId: number }>('eteams_create_task', { subject: '首个任务' });
    expect(readTeam(created.teamId).tasks.find((t) => t.id === task.taskId)!.parentId).toBeNull();
  });

  it('主会话已有主任务：不带 parentTaskId 的顶层任务同样拒绝（同一判据）', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '主会话守卫' });
    const teamId = created.teamId;
    const group = await submitReady('主任务');
    await expect(cap('eteams_create_task', { subject: '散开的顶层任务' })).rejects.toThrow(
      new RegExp(`已有主任务 #${group.taskId}`),
    );
    expect(readTeam(teamId).tasks.filter((t) => t.parentId === null)).toHaveLength(1);
  });
});

describe('大任务状态语义 + 依赖派发闸（用户迭代 2026-09-11 精简状态机）', () => {
  const who = (teamId: number): OpActor => ({ teamId, actor: { kind: 'user', name: '用户' } });

  it('completed 容器追加小任务 → 自动回 ready（完成后可继续，completed 只是标识）', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '续做团队' });
    const teamId = created.teamId;
    const env = runtimeEnvFor();
    const group = await createTask(env, who(teamId), { subject: '主任务', kind: 'group' });
    // 模拟「全部小任务已完成」的收口标识（completeGroupIfDoneInTx 的产物）。
    getDb(root)
      .prepare('UPDATE task SET status = ? WHERE task_id = ?')
      .run('completed', group.id);
    const more = await createTask(env, who(teamId), {
      subject: '续做小任务',
      parentTaskId: group.id,
    });
    expect(more.parentId).toBe(group.id);
    expect(readTeam(teamId).tasks.find((t) => t.id === group.id)!.status).toBe('ready');
  });

  it('取消大任务 → 未完成小任务取消 + 容器回 ready（不置 cancelled 终态）', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '取消团队' });
    const teamId = created.teamId;
    const env = runtimeEnvFor();
    const group = await createTask(env, who(teamId), { subject: '主任务', kind: 'group' });
    const sub = await createTask(env, who(teamId), { subject: '小任务', parentTaskId: group.id });
    await cancelTask(env, who(teamId), group.id, '不做了');
    const team = readTeam(teamId);
    // 容器不落 cancelled（用户原话「不要 cancelled，终端直接变回 ready」）。
    expect(team.tasks.find((t) => t.id === group.id)!.status).toBe('ready');
    // 未完成小任务逐个取消。
    expect(team.tasks.find((t) => t.id === sub.id)!.status).toBe('cancelled');
  });

  it('依赖未完成不再拦截派发（用户 2026-09-14「闸门拦住去掉吧」）', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '依赖团队' });
    const teamId = created.teamId;
    const dave = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Dave',
      role: 'engineer',
      teamId,
    });
    const group = await submitReady('依赖主任务');
    const first = await cap<{ taskId: number }>('eteams_create_task', {
      subject: '前置任务',
      parentTaskId: group.taskId,
      chain: [{ member: String(dave.employeeId), stageBrief: '先做' }],
    });
    const second = await cap<{ taskId: number }>('eteams_create_task', {
      subject: '后置任务',
      parentTaskId: group.taskId,
      dependencies: [first.taskId],
      chain: [{ member: String(dave.employeeId), stageBrief: '后做' }],
    });
    // 依赖只作排布提示（面板执行序按兄弟依赖拓扑排），不再拦截派发——前置未完成
    // 也照派，是否等前置由领队判断（用户 2026-09-14「不然任意调度时会出问题」）。
    const assigned = await cap<{ ok: true; member: string }>('eteams_assign_task', {
      taskId: second.taskId,
      member: String(dave.employeeId),
    });
    expect(assigned.member).toBe('Dave');
    const t = readTeam(teamId).tasks.find((x) => x.id === second.taskId)!;
    expect(t.status).toBe('ready'); // 派发不改状态（成员领取才 start）
    expect(t.attempts).toHaveLength(1);
    expect(t.attempts[0]!.status).toBe('pending_accept');
    expect(t.attempts[0]!.stationIndex).toBe(0);
    // 依赖字段仍在（排布提示用），只是不再当闸门。
    expect(t.dependencies).toEqual([first.taskId]);
  });

  it('成员回合中断 → 小任务挂起（attempt 吊销、站号不丢），整体开始自动恢复续跑', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '中断团队' });
    const teamId = created.teamId;
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
    const group = await submitReady('中断主任务');
    const sub = await cap<{ taskId: number }>('eteams_create_task', {
      subject: '两站任务',
      parentTaskId: group.taskId,
      chain: [
        { member: String(alice.employeeId), stageBrief: '调研' },
        { member: String(bob.employeeId), stageBrief: '实现' },
      ],
    });
    const started = await startGroupTask(runtimeEnvFor(), who(teamId), group.taskId);
    expect(started.started).toBe(1);
    // 派发不改状态：任务留 ready，首站 attempt 待接取，成员会话已起。
    const row = readTeam(teamId).taskMembers.find(
      (r) => r.mainTaskId === group.taskId && r.employeeId === alice.employeeId,
    )!;
    expect(row.sessionId).not.toBe('');

    // 模拟手动停止 Alice 回合（宿主 turn/end{reason.kind:'aborted'}）→ 任务挂起。
    const pausedId = await pauseTaskOnInterrupt(runtimeEnvFor(), teamId, row.sessionId, 'aborted');
    expect(pausedId).toBe(sub.taskId);
    const paused = readTeam(teamId).tasks.find((t) => t.id === sub.taskId)!;
    expect(paused.status).toBe('paused');
    // chain_cursor 保持「已完成站」语义：首站未完成 → -1；进行中站在撤销的
    // attempt.station_index 上（进度不丢的依据）。
    expect(paused.chainCursor).toBe(-1);
    expect(paused.attempts.at(-1)!.status).toBe('revoked');
    expect(paused.attempts.at(-1)!.stationIndex).toBe(0);
    // 容器同步（用户迭代 2026-09-11「小任务挂起之后，主任务也同步挂起」）：
    // 唯一小任务被中断挂起、没有在办小任务 → 容器同步落 paused（主任务 pill
    // 显示「已挂起」；面板按钮回「开始」，点它续跑）。
    expect(readTeam(teamId).tasks.find((t) => t.id === group.taskId)!.status).toBe('paused');

    // 再点大任务「开始」→ 自动恢复并从同一站续派（不再静默无反馈）。
    const resumed = await startGroupTask(runtimeEnvFor(), who(teamId), group.taskId);
    expect(resumed.started).toBe(1);
    const back = readTeam(teamId).tasks.find((t) => t.id === sub.taskId)!;
    expect(back.status).toBe('ready');
    expect(back.attempts.at(-1)!.status).toBe('pending_accept');
    expect(back.attempts.at(-1)!.stationIndex).toBe(0);
    // 续派即在办 → 容器回 start。
    expect(readTeam(teamId).tasks.find((t) => t.id === group.taskId)!.status).toBe('start');
  });

  it('领队被用户主动停止（aborted）→ 锚定的大任务挂起（不再卡「执行中」，可点开始续跑）', async () => {
    // 现场：在子代理窗口停止领队，主任务却留在 start（执行中），再派发会重新
    // 唤醒领队导致状态对不上（用户迭代 2026-09-14）。观察者按 captainChildRegistry
    // （teamId/taskId）派发到 handleCaptainInterrupt；此处直连验证效果。
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '领队中断团队' });
    const teamId = created.teamId;
    const alice = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Alice',
      role: 'engineer',
      teamId,
    });
    const group = await submitReady('领队中断主任务');
    const sub = await cap<{ taskId: number }>('eteams_create_task', {
      subject: '单站任务',
      parentTaskId: group.taskId,
      chain: [{ member: String(alice.employeeId), stageBrief: '实现' }],
    });
    const started = await startGroupTask(runtimeEnvFor(), who(teamId), group.taskId);
    expect(started.started).toBe(1);
    // 派发即在办 → 容器 start（正是用户看到「执行中」的那一态）。
    expect(readTeam(teamId).tasks.find((t) => t.id === group.taskId)!.status).toBe('start');

    const handled = await handleCaptainInterrupt(
      runtimeEnvFor(),
      teamId,
      group.taskId,
      'aborted',
    );
    expect(handled).toBe('paused');
    const container = readTeam(teamId).tasks.find((t) => t.id === group.taskId)!;
    expect(container.status).toBe('paused');
    expect(container.statusNote).toContain('领队回合被中断');
    // 面板暂停主任务同语义：在跑小任务一并挂起。
    expect(readTeam(teamId).tasks.find((t) => t.id === sub.taskId)!.status).toBe('paused');

    // 点「开始」→ 从挂起态续派，状态回一致。
    const resumed = await startGroupTask(runtimeEnvFor(), who(teamId), group.taskId);
    expect(resumed.started).toBe(1);
    expect(readTeam(teamId).tasks.find((t) => t.id === sub.taskId)!.status).toBe('ready');
    expect(readTeam(teamId).tasks.find((t) => t.id === group.taskId)!.status).toBe('start');
  });

  it('领队中断：容器已终态 → no-op（删除团队等自愈路径不误伤）', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '领队中断终态' });
    const teamId = created.teamId;
    const group = await submitReady('终态主任务');
    // 模拟已收口（终态容器）：不应被领队中断改写。
    getDb(root)
      .prepare('UPDATE task SET status = ? WHERE task_id = ?')
      .run('completed', group.taskId);
    const out = await handleCaptainInterrupt(runtimeEnvFor(), teamId, group.taskId, 'aborted');
    expect(out).toBeUndefined();
    expect(readTeam(teamId).tasks.find((t) => t.id === group.taskId)!.status).toBe('completed');
  });

  it('领队会话异常中断（interrupted）→ 不挂起工作流，只落异常备注 + 事件交主会话判读', async () => {
    // 用户迭代 2026-09-14：区分中断类型——用户主动停止才挂起；宿主崩溃补记等
    // 异常不冻结工作流，只留可判读的痕迹（status_note 与 member 挂起文案相区别）。
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '领队异常中断' });
    const teamId = created.teamId;
    const alice = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Alice',
      role: 'engineer',
      teamId,
    });
    const group = await submitReady('异常中断主任务');
    const sub = await cap<{ taskId: number }>('eteams_create_task', {
      subject: '单站任务',
      parentTaskId: group.taskId,
      chain: [{ member: String(alice.employeeId), stageBrief: '实现' }],
    });
    const started = await startGroupTask(runtimeEnvFor(), who(teamId), group.taskId);
    expect(started.started).toBe(1);

    const handled = await handleCaptainInterrupt(
      runtimeEnvFor(),
      teamId,
      group.taskId,
      'interrupted',
    );
    expect(handled).toBe('noted');
    const container = readTeam(teamId).tasks.find((t) => t.id === group.taskId)!;
    // 不挂起：容器与在跑小任务都保持原状（工作流不冻结）。
    expect(container.status).toBe('start');
    expect(container.statusNote).toContain('领队会话异常中断');
    expect(readTeam(teamId).tasks.find((t) => t.id === sub.taskId)!.status).toBe('ready');

    // 事件留痕：主会话可据此区分「用户主动停止」与「异常」。
    const events = readEventsSync(root, teamId);
    expect(
      events.some(
        (e) => e.type === 'task.updated' && (e.payload as { via?: string })?.via === 'captain.interrupted',
      ),
    ).toBe(true);
  });

  it('僵尸指派（ready + 待接取）：开始被闸拒死 → 幂等重发复活（2026-09-11 回归）', async () => {
    // 实测根因：成员回合被中断的那一轮若没有落 paused（旧构建），任务留在
    // ready、尝试停在 pending_accept、副本行被占用——此后「开始」被防重复
    // 派发闸拒绝（「已有进行中的指派」），面板点开始等于无操作。修复=重发。
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '僵尸指派' });
    const teamId = created.teamId;
    const alice = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Alice',
      role: 'engineer',
      teamId,
    });
    const group = await submitReady('重发主任务');
    const sub = await cap<{ taskId: number }>('eteams_create_task', {
      subject: '单站任务',
      parentTaskId: group.taskId,
      chain: [{ member: String(alice.employeeId), stageBrief: '实现' }],
    });
    const env = runtimeEnvFor();
    await assignTask(env, who(teamId), { taskId: sub.taskId, member: alice.employeeId });

    const before = readTeam(teamId).tasks.find((t) => t.id === sub.taskId)!;
    const attemptsBefore = before.attempts.length;
    const mailsBefore = readMailboxSync(root, teamId, String(alice.employeeId)).length;

    // 旧行为：防重复派发闸拒绝（死按钮）。
    await expect(
      assignTask(env, who(teamId), { taskId: sub.taskId, member: alice.employeeId }),
    ).rejects.toThrow(/已有进行中的指派/);

    // 新行为：重发不新开 attempt、不改状态，只再投一封指派信。
    const redelivered = await redeliverAssignment(env, who(teamId), sub.taskId);
    expect(redelivered?.id).toBe(sub.taskId);
    const after = readTeam(teamId).tasks.find((t) => t.id === sub.taskId)!;
    expect(after.attempts).toHaveLength(attemptsBefore);
    expect(after.status).toBe('ready');
    expect(after.attempts.at(-1)!.status).toBe('pending_accept');
    const mailsAfter = readMailboxSync(root, teamId, String(alice.employeeId));
    expect(mailsAfter.length).toBe(mailsBefore + 1);
    expect(mailsAfter.at(-1)!.content).toContain('请重新接取开工');

    // 无僵尸指派 → 返回 undefined（调用方走正常派发，不误吞首派）。
    const clean = await cap<{ taskId: number }>('eteams_create_task', {
      subject: '干净任务',
      parentTaskId: group.taskId,
      chain: [{ member: String(alice.employeeId), stageBrief: '实现' }],
    });
    expect(await redeliverAssignment(env, who(teamId), clean.taskId)).toBeUndefined();

    // 整体开始也走重发：僵尸卡不再被拒成 skipped。
    const started = await startGroupTask(env, who(teamId), group.taskId);
    expect(started.started).toBe(1);
    expect(started.skipped.some((s) => s.taskId === sub.taskId)).toBe(false);
  });

  it('唤醒锚点用成员登记的直接父，不被全队最早任务的陈旧快照毒化（2026-09-11 回归）', async () => {
    // 根因：wakeMember 原先一律用 teamMainSessionOf（本队任务号最小的那条
    // 任务的主会话快照）。团队的历史任务各记各的快照，最早那条早已关闭 →
    // 拿不到活锚点、又不冷恢复，指派信静默留在邮箱（「点开始没反应」）。
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '锚点团队' });
    const teamId = created.teamId;
    const alice = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Alice',
      role: 'engineer',
      teamId,
    });
    const task = await cap<{ taskId: number }>('eteams_create_task', {
      subject: '锚点任务',
      chain: [{ member: String(alice.employeeId), stageBrief: '做' }],
    });
    const env = runtimeEnvFor();
    await assignTask(env, who(teamId), { taskId: task.taskId, member: alice.employeeId });

    // 制造分歧：任务行快照指向一个早已关闭的旧会话（全队最早快照同样陈旧）
    // ——成员登记表里的直接父仍是活着的 cap-1。
    getDb(root)
      .prepare('UPDATE task SET main_session_id = ? WHERE task_id = ?')
      .run('offline-old-session', task.taskId);
    const team = readTeam(teamId);
    expect(team.tasks.find((t) => t.id === task.taskId)!.mainSessionId).toBe('offline-old-session');
    const row = team.taskMembers.find(
      (r) => r.mainTaskId === task.taskId && r.employeeId === alice.employeeId,
    )!;
    expect(row.sessionId).not.toBe('');

    const delivered = await wakeMember(env, team, row, '【重发】指派信');
    expect(delivered).toBe(true);
    expect(runtime.deliveries.at(-1)!.text).toBe('【重发】指派信');
  });

  it('主任务暂停/继续：在跑小任务挂起 + 容器 paused，再开始从原站续跑（2026-09-11）', async () => {
    // 用户迭代：主任务开始后按钮应变「暂停」——暂停 = 挂起在跑小任务 + 容器，
    // 未开跑的小任务保持 ready（它们本来就没在跑）。
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '暂停团队' });
    const teamId = created.teamId;
    const alice = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Alice',
      role: 'engineer',
      teamId,
    });
    const group = await submitReady('暂停主任务');
    const first = await cap<{ taskId: number }>('eteams_create_task', {
      subject: '第一棒',
      parentTaskId: group.taskId,
      chain: [{ member: String(alice.employeeId), stageBrief: '做' }],
    });
    const second = await cap<{ taskId: number }>('eteams_create_task', {
      subject: '第二棒',
      parentTaskId: group.taskId,
      chain: [{ member: String(alice.employeeId), stageBrief: '再做' }],
    });
    const env = runtimeEnvFor();
    const started = await startGroupTask(env, who(teamId), group.taskId);
    expect(started.started).toBe(1);
    // 领取第一棒 → start（执行中）。
    const claim = await mem<{ token: string; attemptId: number }>(
      memberAgent(childByEmployee(alice.employeeId).childId),
      'eteams_claim_task',
      { taskId: first.taskId },
    );
    expect(claim.token).not.toBe('');
    expect(readTeam(teamId).tasks.find((t) => t.id === first.taskId)!.status).toBe('start');
    expect(readTeam(teamId).tasks.find((t) => t.id === group.taskId)!.status).toBe('start');

    // 暂停：在跑的第一棒 → paused，容器 → paused；未跑的第二棒留 ready。
    await suspendGroupTask(env, who(teamId), group.taskId);
    const pausedTeam = readTeam(teamId);
    expect(pausedTeam.tasks.find((t) => t.id === first.taskId)!.status).toBe('paused');
    expect(pausedTeam.tasks.find((t) => t.id === group.taskId)!.status).toBe('paused');
    expect(pausedTeam.tasks.find((t) => t.id === second.taskId)!.status).toBe('ready');
    // 暂停要真停机（用户 2026-09-12「点击暂停没有用，对话还是在进行」）：按副本行
    // session_id 打断在跑成员的回合，而不是只发一封唤醒通知。
    const firstTask = pausedTeam.tasks.find((t) => t.id === first.taskId)!;
    const firstRow = pausedTeam.taskMembers.find(
      (r) => r.id === firstTask.attempts.at(-1)!.taskMemberId,
    )!;
    expect(firstRow.sessionId).not.toBe('');
    expect(runtime.interrupts).toContain(firstRow.sessionId);
    // 挂起通知只留档（邮箱），不再唤醒投递——唤醒会把对话重新开起来。
    expect(runtime.deliveries.some((d) => d.text.includes('【挂起】'))).toBe(false);

    // 再开始：第一棒从原站续跑（新 attempt 待接取），容器回 start。
    const resumed = await startGroupTask(env, who(teamId), group.taskId);
    expect(resumed.started).toBe(1);
    const backTeam = readTeam(teamId);
    const back = backTeam.tasks.find((t) => t.id === first.taskId)!;
    expect(back.status).toBe('ready');
    expect(back.attempts.at(-1)!.status).toBe('pending_accept');
    expect(back.attempts.at(-1)!.stationIndex).toBe(0);
    expect(backTeam.tasks.find((t) => t.id === group.taskId)!.status).toBe('start');
  });

  it('小任务挂起 → 主任务同步挂起（2026-09-11）', async () => {
    // 用户迭代「主任务好像没有挂起状态……小任务挂起之后，主任务也同步挂起」：
    // 领队单独挂起一个在跑小任务（非整体暂停），容器也应同步落 paused——面板
    // 主任务 pill 显示「已挂起」，点「开始」与整体暂停一样原站续跑。
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '同步挂起' });
    const teamId = created.teamId;
    const alice = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Alice',
      role: 'engineer',
      teamId,
    });
    const group = await submitReady('同步挂起主任务');
    const sub = await cap<{ taskId: number }>('eteams_create_task', {
      subject: '在跑小任务',
      parentTaskId: group.taskId,
      chain: [{ member: String(alice.employeeId), stageBrief: '做' }],
    });
    const env = runtimeEnvFor();
    await startGroupTask(env, who(teamId), group.taskId);
    const claim = await mem<{ token: string; attemptId: number }>(
      memberAgent(childByEmployee(alice.employeeId).childId),
      'eteams_claim_task',
      { taskId: sub.taskId },
    );
    expect(claim.token).not.toBe('');
    expect(readTeam(teamId).tasks.find((t) => t.id === group.taskId)!.status).toBe('start');

    // 单独挂起小任务：attempt 吊销、小任务 paused，容器同步 paused（不再停在 start）。
    await cap('eteams_suspend_task', { taskId: sub.taskId, note: '单独挂起' });
    const pausedTeam = readTeam(teamId);
    expect(pausedTeam.tasks.find((t) => t.id === sub.taskId)!.status).toBe('paused');
    expect(pausedTeam.tasks.find((t) => t.id === group.taskId)!.status).toBe('paused');

    // 主任务「开始」→ 挂起小任务原站续跑（新 attempt 待接取），容器回 start。
    const resumed = await startGroupTask(env, who(teamId), group.taskId);
    expect(resumed.started).toBe(1);
    const backTeam = readTeam(teamId);
    const back = backTeam.tasks.find((t) => t.id === sub.taskId)!;
    expect(back.status).toBe('ready');
    expect(back.attempts.at(-1)!.status).toBe('pending_accept');
    expect(back.attempts.at(-1)!.stationIndex).toBe(0);
    expect(backTeam.tasks.find((t) => t.id === group.taskId)!.status).toBe('start');
  });

  it('整体开始：start 未收尾的小任务进跳过清单带原因（原静默 continue 无反馈）', async () => {
    const created = await cap<{ teamId: number }>('eteams_create_team', { name: '反馈团队' });
    const teamId = created.teamId;
    const alice = await cap<{ employeeId: number }>('eteams_add_member', {
      name: 'Alice',
      role: 'engineer',
      teamId,
    });
    const group = await submitReady('主任务');
    const sub = await cap<{ taskId: number }>('eteams_create_task', {
      subject: '单站任务',
      parentTaskId: group.taskId,
      chain: [{ member: String(alice.employeeId), stageBrief: '做' }],
    });
    await startGroupTask(runtimeEnvFor(), who(teamId), group.taskId);
    // 成员接取 → 小任务进入 start（执行中）。
    const agent = memberAgent(childByEmployee(alice.employeeId).childId);
    await mem(agent, 'eteams_claim_task', { taskId: sub.taskId });
    expect(readTeam(teamId).tasks.find((t) => t.id === sub.taskId)!.status).toBe('start');

    const again = await startGroupTask(runtimeEnvFor(), who(teamId), group.taskId);
    expect(again.started).toBe(0);
    expect(again.skipped).toContainEqual({
      taskId: sub.taskId,
      subject: '单站任务',
      reason: '执行中，等本回合收尾',
    });
  });

  it('render 回传工号与邮箱摘要（model-facing content = render 输出，2026-09-14 同类排查）', () => {
    // add_member：工号不进 render，后续 assign/reassign（member 传工号）无从指称。
    const addBlocks = captainTool('eteams_add_member').output.render(
      {},
      { ok: true, member: 'Alice', teamId: 1, employeeId: 7 } as never,
    ) as Array<{ type: string; text?: string }>;
    const added = addBlocks.map((b) => b.text ?? '').join('');
    expect(added).toContain('ET-0007');

    // claim_task：邮箱摘要是成员侧唯一的自有箱快照，必须进 render。
    const claimBlocks = memberTool('eteams_claim_task').output.render(
      {},
      {
        ok: true,
        taskId: 3,
        attemptId: 9,
        token: 'abc123',
        contract: '合同正文',
        inboxPreview: ['[notice] 领队：先做选型'],
      } as never,
    ) as Array<{ type: string; text?: string }>;
    const claimed = claimBlocks.map((b) => b.text ?? '').join('');
    expect(claimed).toContain('先做选型');
  });
});
