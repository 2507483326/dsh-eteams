/**
 * 能力缺口运行时编排（runtime/gaps，v16）tests：Layer 0 确定性预筛的四条判据
 * （高风险/自判 refuse → 拒、命中常设路线 → 按路线走、同操作 open 缺口 → 去重、
 * 其余 → 落表）、落表后的读回，以及 {@link applyGapRoute} 的原子性与**先决者胜**
 * （输家不写常设路线——否则会留下一条与缺口实际处置不符的备忘）。
 *
 * 分级判定由上报子代理自己做（宿主的 RuntimeContext 没有 llm 面），本层只测
 * 宿主侧那三件事：确定性预筛、落表闸、结构性决定的原子落地。
 *
 * @module dsh-eteams/tests/capabilityGapRuntime
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { resolveConfig } from '../src/host/config';
import { joinPath, type RuntimeContext } from '../src/host/runtime/base';
import {
  applyGapRoute,
  handoffTextOf,
  handoffToMain,
  mainSessionIdOfGap,
  prefilterGap,
  reportGap,
  type GapReportInput,
  type GapRuntimeEnv,
} from '../src/host/runtime/gaps';
import {
  readGapSync,
  readOpenGapsSync,
  readRoutingMemosSync,
  type CapabilityGapRecord,
} from '../src/host/state/gaps';
import { insertTeamRow, withTeamTx } from '../src/host/state/store';
import type { TeamState } from '../src/host/model/types';
import { cleanupTempWorkspace } from './support/tmpWorkspace';

let ws: string;
let env: GapRuntimeEnv;
let teamId: number;

const BUILD_ARGV = ['npm', 'run', 'build'];
const TEST_ARGV = ['npm', 'run', 'test'];

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'eteams-gap-rt-'));
  env = { config: resolveConfig({ stateDir: '.eteams' }), workspace: ws };
  const root = joinPath(ws, '.eteams');
  withTeamTx(root, undefined, (tx) => {
    teamId = insertTeamRow(tx, '演示团队', true, tx.now);
  });
});

afterEach(() => {
  cleanupTempWorkspace(ws);
});

/** 一次上报（默认：medium + report-gap + npm run build，挂验收标准）。 */
function inputOf(over: Partial<GapReportInput> = {}): GapReportInput {
  return {
    teamId,
    taskId: 7,
    askingSessionId: 'member-1',
    askingName: '甲',
    risk: 'medium',
    verdict: 'report-gap',
    operation: {
      summary: '运行 npm run build 生成 dist/',
      argv: BUILD_ARGV,
      cwd: ws,
      reason: 'sandbox',
    },
    why: '验收标准第 2 条要求产出可运行构建产物',
    tried: ['改用 tsc --noEmit 做类型检查（通过，但不产出构建产物）'],
    suggestedRoute: 'main-executes',
    ...over,
  };
}

describe('Layer 0 确定性预筛', () => {
  it('self-resolvable → 不落表（换法子能过，不打扰任何人）', () => {
    const input = inputOf({ verdict: 'self-resolvable' });
    expect(prefilterGap(env, input).kind).toBe('self-resolvable');
    expect(reportGap(env, input)).toEqual({ kind: 'self-resolvable' });
    expect(readOpenGapsSync(envRoot(), teamId)).toHaveLength(0);
  });

  it('high 风险 → 拒（不落表、不升级，即便上报方说 report-gap）', () => {
    const input = inputOf({ risk: 'high' });
    const pre = prefilterGap(env, input);
    expect(pre.kind).toBe('refused');
    expect(reportGap(env, input).kind).toBe('refused');
    expect(readOpenGapsSync(envRoot(), teamId)).toHaveLength(0);
  });

  it('上报方自判 refuse → 拒', () => {
    const input = inputOf({ verdict: 'refuse' });
    expect(prefilterGap(env, input).kind).toBe('refused');
    expect(readOpenGapsSync(envRoot(), teamId)).toHaveLength(0);
  });

  it('report-gap → 落表，字段原样读回', () => {
    const outcome = reportGap(env, inputOf());
    expect(outcome.kind).toBe('reported');
    if (outcome.kind !== 'reported') return;
    const gap = readGapSync(envRoot(), outcome.gapId);
    expect(gap?.operation.argv).toEqual(BUILD_ARGV);
    expect(gap?.why).toContain('验收标准');
    expect(gap?.risk).toBe('medium');
    expect(gap?.status).toBe('open');
    expect(gap?.taskId).toBe(7);
  });

  it('同任务同操作已有 open 缺口 → 去重（同一堵墙只留一条）', () => {
    const first = reportGap(env, inputOf());
    const second = reportGap(env, inputOf());
    expect(first.kind).toBe('reported');
    expect(second.kind).toBe('deduped');
    if (first.kind !== 'reported' || second.kind !== 'deduped') return;
    expect(second.gapId).toBe(first.gapId);
    expect(readOpenGapsSync(envRoot(), teamId)).toHaveLength(1);
  });

  it('去重按任务分桶：不同任务各留一条', () => {
    const a = reportGap(env, inputOf({ taskId: 7 }));
    const b = reportGap(env, inputOf({ taskId: 8 }));
    expect(a.kind).toBe('reported');
    expect(b.kind).toBe('reported');
    expect(readOpenGapsSync(envRoot(), teamId)).toHaveLength(2);
  });
});

describe('applyGapRoute —— 结构性决定的原子落地', () => {
  it('写路线栏 + 沉淀常设路线，返回备忘号', () => {
    const outcome = reportGap(env, inputOf());
    if (outcome.kind !== 'reported') throw new Error('前置失败');
    const applied = applyGapRoute(env, {
      gapId: outcome.gapId,
      route: 'main-executes',
      decidedBy: 'user',
      note: '用户拍板：这条构建由主对话代跑',
      memoize: true,
    });
    expect(applied.won).toBe(true);
    expect(applied.memoId ?? 0).toBeGreaterThan(0);
    const gap = readGapSync(envRoot(), outcome.gapId);
    expect(gap?.status).toBe('routed');
    expect(gap?.route).toBe('main-executes');
    expect(gap?.decidedBy).toBe('user');
    expect(readRoutingMemosSync(envRoot(), teamId)).toHaveLength(1);
  });

  it('沉淀后同类操作直接命中 known-route（不再升级）', () => {
    const outcome = reportGap(env, inputOf());
    if (outcome.kind !== 'reported') throw new Error('前置失败');
    applyGapRoute(env, {
      gapId: outcome.gapId,
      route: 'split-stage',
      decidedBy: 'captain',
      memoize: true,
    });
    const pre = prefilterGap(env, inputOf({ taskId: 7 }));
    expect(pre.kind).toBe('known-route');
    if (pre.kind !== 'known-route') return;
    expect(pre.route).toBe('split-stage');
  });

  it('常设路线按操作类区分：别的命令不受影响', () => {
    const outcome = reportGap(env, inputOf());
    if (outcome.kind !== 'reported') throw new Error('前置失败');
    applyGapRoute(env, {
      gapId: outcome.gapId,
      route: 'main-executes',
      decidedBy: 'captain',
      memoize: true,
    });
    const other = prefilterGap(
      env,
      inputOf({ operation: { summary: '跑测试', argv: TEST_ARGV, cwd: ws, reason: 'sandbox' } }),
    );
    expect(other.kind).toBe('report');
  });

  it('不开 memoize：只写路线栏，不沉淀（一次性决定）', () => {
    const outcome = reportGap(env, inputOf());
    if (outcome.kind !== 'reported') throw new Error('前置失败');
    const applied = applyGapRoute(env, {
      gapId: outcome.gapId,
      route: 'widen-and-redelegate',
      decidedBy: 'captain',
    });
    // 赢了（路线已写）但没沉淀——两个字段必须分开，否则调用方分不清「没沉淀」与「输了」。
    expect(applied.won).toBe(true);
    expect(applied.memoId).toBeUndefined();
    expect(readGapSync(envRoot(), outcome.gapId)?.status).toBe('routed');
    expect(readRoutingMemosSync(envRoot(), teamId)).toHaveLength(0);
  });

  it('先决者胜：输家不改路线、也不沉淀（否则会留下与缺口不符的备忘）', () => {
    const outcome = reportGap(env, inputOf());
    if (outcome.kind !== 'reported') throw new Error('前置失败');
    const winner = applyGapRoute(env, {
      gapId: outcome.gapId,
      route: 'main-executes',
      decidedBy: 'captain',
      memoize: true,
    });
    expect(winner.won).toBe(true);
    expect(winner.memoId ?? 0).toBeGreaterThan(0);
    // 后到的用户作答：静默落空
    const loser = applyGapRoute(env, {
      gapId: outcome.gapId,
      route: 'split-stage',
      decidedBy: 'user',
      memoize: true,
    });
    expect(loser.won).toBe(false);
    expect(loser.memoId).toBeUndefined();
    const gap = readGapSync(envRoot(), outcome.gapId);
    expect(gap?.route).toBe('main-executes');
    expect(gap?.decidedBy).toBe('captain');
    expect(readRoutingMemosSync(envRoot(), teamId)).toHaveLength(1);
  });

  it('缺口不存在 → 抛可读错误', () => {
    expect(() =>
      applyGapRoute(env, { gapId: '不存在', route: 'main-executes', decidedBy: 'captain' }),
    ).toThrow(/不存在/);
  });

  it('已定路线的缺口再调 → 静默落空（不抛）', () => {
    const outcome = reportGap(env, inputOf());
    if (outcome.kind !== 'reported') throw new Error('前置失败');
    applyGapRoute(env, { gapId: outcome.gapId, route: 'main-executes', decidedBy: 'captain' });
    expect(
      applyGapRoute(env, { gapId: outcome.gapId, route: 'split-stage', decidedBy: 'user' }).won,
    ).toBe(false);
  });
});

/** 状态根（与 runtime 同口径）。 */
function envRoot(): string {
  return joinPath(ws, '.eteams');
}

// --------------------------------------------------------------------------
// main-executes 的交付动作（P2）：把操作交给主会话
// --------------------------------------------------------------------------

/** 只读 `tasks` 的最小 TeamState（本组用例只关心会话锚）。 */
function teamWithTasks(
  tasks: Array<{ id: number; parentId: number | null; mainSessionId?: string }>,
): TeamState {
  return { tasks } as unknown as TeamState;
}

function gapRecordOf(over: Partial<CapabilityGapRecord> = {}): CapabilityGapRecord {
  return {
    gapId: 'gap-1',
    teamId,
    taskId: 2,
    askingSessionId: 'member-1',
    askingName: '甲',
    risk: 'medium',
    operation: {
      summary: '运行 npm run build 生成 dist/',
      argv: ['npm', 'run', 'build'],
      cwd: 'C:/eTeam',
      reason: 'sandbox',
    },
    why: '验收标准第 1 条要求产出可运行构建产物',
    tried: ['改用 tsc --noEmit 做类型检查（通过，但不产出构建产物）'],
    status: 'open',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/** 只读 `id` 的 sender 桩。 */
const senderOf = (id: string): Agent => ({ id }) as unknown as Agent;

describe('main-executes 交付（P2）', () => {
  it('handoffTextOf：来源 / 精确 argv 与 cwd / 为什么 / 已试替代 / 不要转回成员', () => {
    const team = teamWithTasks([{ id: 1, parentId: null, mainSessionId: 'cap-1' }]);
    const text = handoffTextOf(gapRecordOf({ taskId: 1 }), team);
    expect(text).toContain('请主会话代执行');
    expect(text).toContain('gapId=gap-1');
    expect(text).toContain('甲 上报');
    // 执行侧按 argv/cwd 构造命令，不按散文——两者都要在正文里逐项可见。
    expect(text).toContain('cwd:  C:/eTeam');
    expect(text).toContain('argv: npm run build');
    expect(text).toContain('为什么需要：验收标准第 1 条');
    expect(text).toContain('已试过的替代');
    expect(text).toContain('不要把它转回上报的成员');
    expect(text).toContain('原生审批流');
  });

  it('mainSessionIdOfGap：小任务锚到大任务行的 mainSessionId 快照', () => {
    const team = teamWithTasks([
      { id: 1, parentId: null, mainSessionId: 'cap-anchor' },
      { id: 2, parentId: 1 },
    ]);
    expect(mainSessionIdOfGap(team, 2)).toBe('cap-anchor');
    expect(mainSessionIdOfGap(team, 1)).toBe('cap-anchor');
  });

  it('mainSessionIdOfGap：锚缺快照时退回任务自身；任务不存在 / 无 taskId → undefined', () => {
    const team = teamWithTasks([
      { id: 1, parentId: null },
      { id: 2, parentId: 1, mainSessionId: 'cap-self' },
    ]);
    expect(mainSessionIdOfGap(team, 2)).toBe('cap-self');
    expect(mainSessionIdOfGap(team, 99)).toBeUndefined();
    expect(mainSessionIdOfGap(team, undefined)).toBeUndefined();
  });

  it('handoffToMain：投递给主会话，正文含精确命令', async () => {
    const team = teamWithTasks([{ id: 1, parentId: null, mainSessionId: 'cap-1' }]);
    const seen: unknown[][] = [];
    const subagents = {
      sendMessage: vi.fn(async (...args: unknown[]) => {
        seen.push(args);
      }),
    } as unknown as RuntimeContext['subagents'];
    const result = await handoffToMain(
      subagents,
      senderOf('leader-child-1'),
      team,
      gapRecordOf({ taskId: 1 }),
    );
    expect(result).toMatchObject({ delivered: true, targetSessionId: 'cap-1' });
    expect(seen).toHaveLength(1);
    expect(String(seen[0]![1])).toBe('cap-1');
    expect((seen[0]![2] as { text: string }[])[0]!.text).toContain('npm run build');
  });

  it('handoffToMain：四条失败路径都只降级不抛（路线已落库，交付失败不该回滚）', async () => {
    const noAnchor = teamWithTasks([{ id: 2, parentId: null }]);
    const ok = {
      sendMessage: vi.fn(async () => undefined),
    } as unknown as RuntimeContext['subagents'];

    // ① 无锚会话
    const a = await handoffToMain(
      ok,
      senderOf('leader-child-1'),
      noAnchor,
      gapRecordOf({ taskId: 2 }),
    );
    expect(a.delivered).toBe(false);
    expect(a.reason).toContain('mainSessionId');

    // ② 调用方就是主会话（不自投）
    const team = teamWithTasks([{ id: 1, parentId: null, mainSessionId: 'cap-1' }]);
    const b = await handoffToMain(ok, senderOf('cap-1'), team, gapRecordOf({ taskId: 1 }));
    expect(b.delivered).toBe(false);
    expect(b.reason).toContain('主会话本身');

    // ③ 宿主缺 sendMessage 能力
    const c = await handoffToMain(
      {} as unknown as RuntimeContext['subagents'],
      senderOf('leader-child-1'),
      team,
      gapRecordOf({ taskId: 1 }),
    );
    expect(c.delivered).toBe(false);
    expect(c.reason).toContain('sendMessage');

    // ④ 投递抛错（例如相邻鉴权失败）
    const boom = {
      sendMessage: vi.fn(async () => {
        throw new Error('UNAUTHORIZED');
      }),
    } as unknown as RuntimeContext['subagents'];
    const d = await handoffToMain(
      boom,
      senderOf('leader-child-1'),
      team,
      gapRecordOf({ taskId: 1 }),
    );
    expect(d.delivered).toBe(false);
    expect(d.reason).toContain('UNAUTHORIZED');
  });
});
