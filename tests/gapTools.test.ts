/**
 * 能力缺口工具面（v16）tests：
 * - `eteams_report_gap`（上报，全体子代理共用）：入参校验（`report-gap` 必带 `why`、
 *   `self-resolvable` 必带 `next`、argv 形状干净、路线枚举收口）与身份解析（成员/领队
 *   按团队、构建师按构建会话、路人原样抛错）；宿主的确定性预筛与落表交给 runtime/gaps。
 *   站点下标由宿主派生：成员在自己那张任务的执行链上按工号找，不让上报方自报。
 * - `eteams_route_gap`（处置，领队面）：定路线 + 可选沉淀常设路线；成员被身份门禁拦下、
 *   跨团队被守卫拦下（单库多团队共用状态根）、已处置的回 already-decided 不覆盖。
 *
 * @module dsh-eteams/tests/gapTools
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { resolveConfig } from '../src/host/config';
import { applyGapRoute } from '../src/host/runtime/gaps';
import { createGapTools } from '../src/host/tools/gapTools';
import { registerCaptainChild } from '../src/host/runtime/captainChildRegistry';
import { joinPath } from '../src/host/runtime/base';
import { LEADER_NAME } from '../src/host/runtime/roster';
import { readGapSync, readOpenGapsSync, readRoutingMemosSync } from '../src/host/state/gaps';
import { insertTeamRow, withTeamTx, writeTeamInTx } from '../src/host/state/store';
import type { TaskMemberRecord, TeamState } from '../src/host/model/types';
import { cleanupTempWorkspace } from './support/tmpWorkspace';

let ws: string;
let root: string;
let teamId: number;
let config: ReturnType<typeof resolveConfig>;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'eteams-gap-tool-'));
  root = joinPath(ws, '.eteams');
  config = resolveConfig({ stateDir: '.eteams' });
});

afterEach(() => {
  cleanupTempWorkspace(ws);
});

/** 播种一个团队：成员甲在办小任务 2（执行链站点 0），大任务锚为 1。 */
function seedTeam(): TeamState {
  const name = '演示团队';
  withTeamTx(root, undefined, (tx) => {
    teamId = insertTeamRow(tx, name, true, tx.now);
  });
  const leaderRow: TaskMemberRecord = {
    id: 0,
    teamId,
    mainTaskId: 1,
    nowTaskId: null,
    name: LEADER_NAME,
    employeeId: null,
    sessionId: '',
    isLeader: true,
    createdAt: 1,
  };
  const memberRow: TaskMemberRecord = {
    id: 0,
    teamId,
    mainTaskId: 1,
    nowTaskId: 2,
    name: '甲',
    employeeId: 1,
    sessionId: 'member-1',
    createdAt: 1,
  };
  const state: TeamState = {
    id: teamId,
    name,
    hasLeader: true,
    createdAt: 1,
    updatedAt: 1,
    taskMembers: [leaderRow, memberRow],
    members: [
      {
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
    ],
    tasks: [
      {
        id: 1,
        subject: '主任务',
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
      {
        id: 2,
        subject: '构建产物',
        parentId: 1,
        dependencies: [],
        chain: [
          { member: 1, stageBrief: '产出可运行构建产物' },
          { member: 2, stageBrief: '验收构建产物' },
        ],
        chainCursor: -1,
        status: 'start',
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

function agentOf(id: string): Agent {
  return { id, session: { header: { cwd: ws } } } as unknown as Agent;
}

function fakeCtx(
  /** 相邻投递桩（P2 交付动作会用到；不给就是「宿主缺能力」）。 */
  subagents?: { sendMessage: (...args: unknown[]) => Promise<unknown> },
): Context {
  return {
    logger: { info: () => undefined, warn: () => undefined },
    ...(subagents !== undefined ? { subagents } : {}),
    agents: { get: () => undefined },
    tools: { register() {} },
    systemPrompt: { section() {} },
    get: (key: string) =>
      key === 'workspaceRegistry' ? { list: () => [{ path: ws, title: 'ws' }] } : undefined,
  } as unknown as Context;
}

function callGap(
  args: Record<string, unknown>,
  agentId: string,
  ctx: Context = fakeCtx(),
): Promise<Record<string, unknown>> {
  const tool = createGapTools(config, ctx).find((t) => t.name === 'eteams_report_gap');
  if (!tool) throw new Error('eteams_report_gap 未注册');
  return tool.execute(
    args as never,
    { agent: agentOf(agentId), signal: undefined } as never,
  ) as Promise<Record<string, unknown>>;
}

/** 一条 report-gap 的完整入参。 */
function gapArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: 'report-gap',
    risk: 'medium',
    operation: {
      summary: '运行 npm run build 生成 dist/',
      argv: ['npm', 'run', 'build'],
      cwd: ws,
      reason: 'sandbox',
    },
    why: '验收标准第 1 条要求产出可运行构建产物',
    tried: ['改用 tsc --noEmit 做类型检查（通过，但不产出构建产物）'],
    ...over,
  };
}

describe('eteams_report_gap —— 入参校验', () => {
  it('report-gap 缺 why → 拒收并给可执行提示', async () => {
    seedTeam();
    await expect(callGap(gapArgs({ why: '  ' }), 'member-1')).rejects.toThrow(/why/);
  });

  it('self-resolvable 缺 next → 拒收（说不出换成什么就不算能自解）', async () => {
    seedTeam();
    await expect(
      callGap(gapArgs({ verdict: 'self-resolvable', why: '' }), 'member-1'),
    ).rejects.toThrow(/next/);
  });

  it('非法 verdict → 拒收，提示按 report-gap 处理', async () => {
    seedTeam();
    await expect(callGap(gapArgs({ verdict: 'maybe' }), 'member-1')).rejects.toThrow(/verdict/);
  });

  it('argv 形状：空数组 / 含空项 / 含换行 一律拒收', async () => {
    seedTeam();
    const bad = (argv: unknown) =>
      callGap(
        gapArgs({ operation: { summary: 's', argv, cwd: ws, reason: 'sandbox' } }),
        'member-1',
      );
    await expect(bad([])).rejects.toThrow(/argv/);
    await expect(bad(['npm', ''])).rejects.toThrow(/argv/);
    await expect(bad(['npm', 'run\nbuild'])).rejects.toThrow(/argv/);
  });

  it('cwd / reason / summary 必填', async () => {
    seedTeam();
    const withOp = (operation: Record<string, unknown>) =>
      callGap(gapArgs({ operation }), 'member-1');
    await expect(withOp({ summary: 's', argv: ['a'], cwd: '', reason: 'sandbox' })).rejects.toThrow(
      /cwd/,
    );
    await expect(withOp({ summary: 's', argv: ['a'], cwd: ws, reason: '' })).rejects.toThrow(
      /reason/,
    );
    await expect(withOp({ summary: '', argv: ['a'], cwd: ws, reason: 'sandbox' })).rejects.toThrow(
      /summary/,
    );
  });

  it('suggestedRoute 只接受三个合法路线，拿不准请省略', async () => {
    seedTeam();
    await expect(callGap(gapArgs({ suggestedRoute: 'auto-allow' }), 'member-1')).rejects.toThrow(
      /只接受/,
    );
  });
});

describe('eteams_report_gap —— 身份与派生', () => {
  it('成员上报 → 落表，团队/任务由身份派生，站点下标由链上工号派生', async () => {
    seedTeam();
    const result = await callGap(gapArgs(), 'member-1');
    expect(result).toMatchObject({ ok: true, mode: 'reported' });
    const gap = readGapSync(root, String(result.gapId));
    expect(gap?.askingName).toBe('甲');
    expect(gap?.taskId).toBe(2); // nowTaskId（在办的小任务），不是大任务锚 1
    expect(gap?.stationIndex).toBe(0); // 链上工号 1 = 第 0 站
    expect(gap?.operation.argv).toEqual(['npm', 'run', 'build']);
    expect(String(result.hint)).toContain('eteams_send_message');
  });

  it('领队子代理上报 → 无在办任务时不带 taskId（不猜）', async () => {
    seedTeam();
    const result = await callGap(gapArgs(), 'cap-1');
    expect(result).toMatchObject({ ok: true, mode: 'reported' });
    expect(readGapSync(root, String(result.gapId))?.askingName).toBe('领队');
    expect(readGapSync(root, String(result.gapId))?.taskId).toBeUndefined();
  });

  it('路人会话 → 原样抛错（身份门禁不放宽）', async () => {
    seedTeam();
    await expect(callGap(gapArgs(), 'stranger-1')).rejects.toThrow(/不在任何 eteams 团队中/);
  });

  it('显式 taskId 覆盖默认（成员可给别的任务报缺口）', async () => {
    seedTeam();
    const result = await callGap(gapArgs({ taskId: 1 }), 'member-1');
    expect(readGapSync(root, String(result.gapId))?.taskId).toBe(1);
  });
});

describe('eteams_report_gap —— 预筛透出与指引', () => {
  it('high 风险 → refused，不落表，指引要求失败收尾而非请人授权', async () => {
    seedTeam();
    const result = await callGap(gapArgs({ risk: 'high' }), 'member-1');
    expect(result).toMatchObject({ ok: true, mode: 'refused' });
    expect(String(result.hint)).toContain('不要请人授权');
    expect(readOpenGapsSync(root, teamId)).toHaveLength(0);
  });

  it('self-resolvable → 不落表，回显替代做法', async () => {
    seedTeam();
    const result = await callGap(
      gapArgs({ verdict: 'self-resolvable', next: '改用 head 读前 50 行' }),
      'member-1',
    );
    expect(result).toMatchObject({ ok: true, mode: 'self-resolvable' });
    expect(String(result.hint)).toContain('改用 head 读前 50 行');
    expect(readOpenGapsSync(root, teamId)).toHaveLength(0);
  });

  it('同一堵墙报两次 → 第二次 deduped，复用同一 gapId', async () => {
    seedTeam();
    const first = await callGap(gapArgs(), 'member-1');
    const second = await callGap(gapArgs(), 'member-1');
    expect(first.mode).toBe('reported');
    expect(second).toMatchObject({ mode: 'deduped', gapId: first.gapId });
    expect(readOpenGapsSync(root, teamId)).toHaveLength(1);
  });

  it('命中常设路线 → known-route，指引明确「不要自己重试」', async () => {
    seedTeam();
    const first = await callGap(gapArgs(), 'member-1');
    // 领队/用户处置：定路线并沉淀
    applyGapRoute(
      { config, workspace: ws },
      {
        gapId: String(first.gapId),
        route: 'split-stage',
        decidedBy: 'captain',
        memoize: true,
      },
    );
    const again = await callGap(gapArgs(), 'member-1');
    expect(again).toMatchObject({ ok: true, mode: 'known-route', route: 'split-stage' });
    expect(String(again.hint)).toContain('不要自己重试');
  });
});

/** 处置工具的调用入口（与 callGap 同款离线桩驱动）。 */
function callRoute(
  args: Record<string, unknown>,
  agentId: string,
  ctx: Context = fakeCtx(),
): Promise<Record<string, unknown>> {
  const tool = createGapTools(config, ctx).find((t) => t.name === 'eteams_route_gap');
  if (!tool) throw new Error('eteams_route_gap 未注册');
  return tool.execute(
    args as never,
    { agent: agentOf(agentId), signal: undefined } as never,
  ) as Promise<Record<string, unknown>>;
}

/**
 * 再播一个团队（领队会话 cap-2，**不建任何任务**）：跨团队守卫的对照。领队身份走
 * leaderRowOf（is_leader=1 且 main_task_id 为空）那一支，不需要任务行——单库多
 * 团队共用状态根，任务号会撞，所以刻意不造任务。
 */
function seedSecondTeam(): void {
  let otherId = 0;
  withTeamTx(root, undefined, (tx) => {
    otherId = insertTeamRow(tx, '另一个团队', true, tx.now);
  });
  const state: TeamState = {
    id: otherId,
    name: '另一个团队',
    hasLeader: true,
    createdAt: 1,
    updatedAt: 1,
    taskMembers: [
      {
        id: 0,
        teamId: otherId,
        mainTaskId: null,
        nowTaskId: null,
        name: LEADER_NAME,
        employeeId: null,
        sessionId: 'cap-2',
        isLeader: true,
        createdAt: 1,
      },
    ],
    members: [],
    tasks: [],
    pendingDecisions: [],
  };
  withTeamTx(root, otherId, (tx) => writeTeamInTx(tx, state));
}

describe('eteams_route_gap —— 处置面（领队）', () => {
  it('领队定路线 → routed；未开 memoize 时明说下次还会来问', async () => {
    seedTeam();
    const reported = await callGap(gapArgs(), 'member-1');
    const result = await callRoute(
      { gapId: reported.gapId, route: 'main-executes', note: '一次性，交给主会话' },
      'cap-1',
    );
    expect(result).toMatchObject({ ok: true, mode: 'routed', route: 'main-executes' });
    const gap = readGapSync(root, String(reported.gapId));
    expect(gap?.status).toBe('routed');
    expect(gap?.decidedBy).toBe('captain'); // decidedBy 缺省
    expect(gap?.routeNote).toBe('一次性，交给主会话');
    expect(String(result.hint)).toContain('主会话');
    expect(String(result.hint)).toContain('未沉淀');
    expect(readRoutingMemosSync(root, teamId)).toHaveLength(0);
  });

  it('memoize=true → 返回备忘号并沉淀，同类操作此后直接命中 known-route', async () => {
    seedTeam();
    const reported = await callGap(gapArgs(), 'member-1');
    const result = await callRoute(
      { gapId: reported.gapId, route: 'split-stage', memoize: true },
      'cap-1',
    );
    expect(result.mode).toBe('routed');
    expect(Number(result.memoId)).toBeGreaterThan(0);
    expect(String(result.hint)).toContain('已沉淀常设路线');
    expect(readRoutingMemosSync(root, teamId)).toHaveLength(1);
    // 同类操作再报：命中常设路线，不再产生新缺口
    const again = await callGap(gapArgs(), 'member-1');
    expect(again).toMatchObject({ mode: 'known-route', route: 'split-stage' });
  });

  it('成员不能处置（身份门禁；缺口保持 open）', async () => {
    seedTeam();
    const reported = await callGap(gapArgs(), 'member-1');
    await expect(
      callRoute({ gapId: reported.gapId, route: 'main-executes' }, 'member-1'),
    ).rejects.toThrow(/只有领队/);
    expect(readGapSync(root, String(reported.gapId))?.status).toBe('open');
  });

  it('跨团队守卫：别的团队的领队处置不了（单库多团队共用状态根）', async () => {
    seedTeam();
    seedSecondTeam();
    const reported = await callGap(gapArgs(), 'member-1');
    await expect(
      callRoute({ gapId: reported.gapId, route: 'main-executes' }, 'cap-2'),
    ).rejects.toThrow(/不属于你的团队/);
    expect(readGapSync(root, String(reported.gapId))?.status).toBe('open');
  });

  it('已处置 → already-decided，不覆盖既有路线', async () => {
    seedTeam();
    const reported = await callGap(gapArgs(), 'member-1');
    await callRoute({ gapId: reported.gapId, route: 'main-executes' }, 'cap-1');
    const again = await callRoute({ gapId: reported.gapId, route: 'split-stage' }, 'cap-1');
    expect(again).toMatchObject({ ok: true, mode: 'already-decided', route: 'main-executes' });
    expect(readGapSync(root, String(reported.gapId))?.route).toBe('main-executes');
  });

  it('decidedBy=user 记为用户拍板（审计标签）', async () => {
    seedTeam();
    const reported = await callGap(gapArgs(), 'member-1');
    await callRoute(
      { gapId: reported.gapId, route: 'widen-and-redelegate', decidedBy: 'user' },
      'cap-1',
    );
    expect(readGapSync(root, String(reported.gapId))?.decidedBy).toBe('user');
  });

  it('入参校验：route 未知 / gapId 缺失 / 缺口不存在 一律拒收', async () => {
    seedTeam();
    const reported = await callGap(gapArgs(), 'member-1');
    await expect(
      callRoute({ gapId: reported.gapId, route: 'auto-allow' }, 'cap-1'),
    ).rejects.toThrow(/只接受/);
    await expect(callRoute({ route: 'main-executes' }, 'cap-1')).rejects.toThrow(/gapId/);
    await expect(callRoute({ gapId: '不存在', route: 'main-executes' }, 'cap-1')).rejects.toThrow(
      /不存在/,
    );
    expect(readGapSync(root, String(reported.gapId))?.status).toBe('open');
  });
});

describe('eteams_route_gap —— main-executes 自动交付（P2）', () => {
  /** 领队子代理（会话 ≠ 主会话）：交付才有「子 → 父」这一跳。 */
  function seedLeaderChild(): void {
    registerCaptainChild('leader-child-1', String(teamId), root);
  }

  it('领队定 main-executes → 自动把操作发给主会话，指引改口为「已自动交付」', async () => {
    seedTeam();
    seedLeaderChild();
    const sent: unknown[][] = [];
    const ctx = fakeCtx({
      sendMessage: async (...args: unknown[]) => {
        sent.push(args);
      },
    });
    const reported = await callGap(gapArgs(), 'member-1');
    const result = await callRoute(
      { gapId: reported.gapId, route: 'main-executes' },
      'leader-child-1',
      ctx,
    );
    expect(result).toMatchObject({ ok: true, mode: 'routed', handoff: true });
    expect(sent).toHaveLength(1);
    const [sender, targetId, content] = sent[0]!;
    // 发信人必须是领队自己的会话（相邻投递按它校验 parentSession），目标是锚定主会话。
    expect(String((sender as { id?: unknown }).id)).toBe('leader-child-1');
    expect(String(targetId)).toBe('cap-1');
    // 正文带来源与精确命令——执行侧按它构造命令，不按散文。
    const body = (content as { text: string }[])[0]!.text;
    expect(body).toContain(String(reported.gapId));
    expect(body).toContain('argv: npm run build');
    expect(String(result.hint)).toContain('已自动把这条操作交给主会话');
  });

  it('交付失败只降级：路线仍落库，指引改成「需要你手动交付」并带上原因', async () => {
    seedTeam();
    seedLeaderChild();
    const ctx = fakeCtx({
      sendMessage: async () => {
        throw new Error('UNAUTHORIZED');
      },
    });
    const reported = await callGap(gapArgs(), 'member-1');
    const result = await callRoute(
      { gapId: reported.gapId, route: 'main-executes' },
      'leader-child-1',
      ctx,
    );
    expect(result).toMatchObject({ mode: 'routed', handoff: false });
    expect(String(result.hint)).toContain('需要你手动交付');
    expect(String(result.hint)).toContain('UNAUTHORIZED');
    // 交付失败不该让处置回滚：路线已经写下了。
    expect(readGapSync(root, String(reported.gapId))?.status).toBe('routed');
  });

  it('其余两条路线不触发交付（不额外发消息）', async () => {
    seedTeam();
    seedLeaderChild();
    const sent: unknown[][] = [];
    const ctx = fakeCtx({
      sendMessage: async (...args: unknown[]) => {
        sent.push(args);
      },
    });
    const reported = await callGap(gapArgs(), 'member-1');
    const result = await callRoute(
      { gapId: reported.gapId, route: 'split-stage' },
      'leader-child-1',
      ctx,
    );
    expect(result.mode).toBe('routed');
    expect(result.handoff).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it('调用方就是主会话时不自投：走手动指引', async () => {
    seedTeam();
    const sent: unknown[][] = [];
    const ctx = fakeCtx({
      sendMessage: async (...args: unknown[]) => {
        sent.push(args);
      },
    });
    const reported = await callGap(gapArgs(), 'member-1');
    const result = await callRoute({ gapId: reported.gapId, route: 'main-executes' }, 'cap-1', ctx);
    expect(result).toMatchObject({ mode: 'routed', handoff: false });
    expect(String(result.hint)).toContain('主会话本身');
    expect(sent).toHaveLength(0);
  });
});
