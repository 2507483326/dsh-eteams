/**
 * capability_gaps / routing_memos（v16）tests：子代理能力缺口的落表闸（high
 * 风险与未挂钩验收标准一律拒收）、生命周期（open → routed → 终态，先决者胜）、
 * 与常设路线的作用域/过期/唯一性，以及**操作类归一**这条安全关键路径
 * （路线键只能由宿主产出、无通配、同一工作区根下稳定）。
 *
 * 直接驱动 state 层（不起 runtime）：缺口的产出方是子代理、消费方是领队，
 * 本层只保证「存得对、读得回、闸得住」。
 *
 * @module dsh-eteams/tests/capabilityGapStorage
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { joinPath } from '../src/host/runtime/base';
import { getDb } from '../src/host/state/db';
import {
  expireRoutingMemosForTaskSync,
  insertGapInTx,
  insertGapSync,
  isNormalizedOperationClass,
  newGapId,
  normalizeWorkspaceRoot,
  operationClassOf,
  readAllOpenGapsSync,
  readGapSync,
  readGapsByTaskSync,
  readOpenGapsSync,
  readRoutingMemosSync,
  resolveRoutingMemoSync,
  setGapEndedSync,
  setGapRouteInTx,
  setGapRouteSync,
  upsertRoutingMemoInTx,
  upsertRoutingMemoSync,
  type CapabilityGapRecord,
  type RoutingMemoRecord,
} from '../src/host/state/gaps';
import { insertTeamRow, withTeamTx } from '../src/host/state/store';
import { cleanupTempWorkspace } from './support/tmpWorkspace';

let ws: string;
let root: string;
let teamId: number;

const ROOT = 'C:/eTeam';

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'eteams-gap-'));
  // 状态根与 runtime 同口径（base.ts joinPath 的「/」拼法）——getDb 连接缓存
  // 按它做键，afterEach 收尾才能关掉连接再删目录。
  root = joinPath(ws, '.eteams');
  withTeamTx(root, undefined, (tx) => {
    teamId = insertTeamRow(tx, '演示团队', true, tx.now);
  });
});

afterEach(() => {
  cleanupTempWorkspace(ws);
});

/** 缺口工厂（默认一条可入库的 medium 缺口）。 */
function gapOf(over: Partial<CapabilityGapRecord> = {}): CapabilityGapRecord {
  return {
    gapId: newGapId(),
    teamId,
    taskId: 7,
    askingSessionId: 'member-1',
    askingName: '甲',
    risk: 'medium',
    operation: {
      summary: '运行 npm run build 生成 dist/',
      argv: ['npm', 'run', 'build'],
      cwd: ROOT,
      writes: ['dist/**'],
      reason: 'sandbox',
    },
    why: '验收标准第 2 条要求产出可运行构建产物',
    tried: ['改用 tsc --noEmit 做类型检查（通过，但不产出构建产物）'],
    suggestedRoute: 'main-executes',
    status: 'open',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  };
}

/** 路线工厂。 */
function memoOf(over: Partial<RoutingMemoRecord> = {}): RoutingMemoRecord {
  return {
    memoId: 0,
    teamId,
    operationClass: operationClassOf(['npm', 'run', 'build'], ROOT),
    route: 'main-executes',
    decidedBy: 'captain',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  };
}

// --------------------------------------------------------------------------
// 操作类归一（安全关键：路线键的唯一来源）
// --------------------------------------------------------------------------

describe('operationClassOf —— 路线键归一', () => {
  it('工作区根归一：反斜杠、尾斜杠、大小写都折成同一键', () => {
    expect(normalizeWorkspaceRoot('C:\\eTeam\\')).toBe('c:/eteam');
    expect(normalizeWorkspaceRoot('C:/eTeam')).toBe('c:/eteam');
    expect(operationClassOf(['git', 'status'], 'C:\\eTeam\\')).toBe(
      operationClassOf(['git', 'status'], 'C:/eTeam'),
    );
  });

  it('非任意代码基命令：键 = 基命令 + 首个非选项参数（后续选项/参数不进键）', () => {
    const a = operationClassOf(['git', 'status', '--short'], ROOT);
    const b = operationClassOf(['git', '--no-pager', 'status'], ROOT);
    const c = operationClassOf(['git', 'status', '--porcelain'], ROOT);
    expect(a).toBe('c:/eteam::git::status');
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('任意代码基命令：键 = 完整 argv（前缀会放大成一批操作的通行证）', () => {
    const build = operationClassOf(['npm', 'run', 'build'], ROOT);
    const test = operationClassOf(['npm', 'run', 'test'], ROOT);
    expect(build).toBe('c:/eteam::npm::npm run build');
    expect(build).not.toBe(test);
    // 同一条命令带不同选项也不同键（任意代码基命令不做前缀收敛）
    expect(operationClassOf(['npm', 'run', 'build', '--watch'], ROOT)).not.toBe(build);
  });

  it('argv[0] 剥路径与扩展名', () => {
    expect(operationClassOf(['C:/tools/Node.EXE', 'x'], ROOT)).toBe(
      operationClassOf(['node', 'x'], ROOT),
    );
  });

  it('形状守卫：拒空串、拒无 :: 分隔、拒任何通配符', () => {
    expect(isNormalizedOperationClass('c:/eteam::npm::npm run build')).toBe(true);
    expect(isNormalizedOperationClass('')).toBe(false);
    expect(isNormalizedOperationClass('npm')).toBe(false);
    expect(isNormalizedOperationClass('c:/eteam::npm::npm run *')).toBe(false);
    expect(isNormalizedOperationClass('c:/eteam::npm::npm run ?')).toBe(false);
    expect(isNormalizedOperationClass('c:/eteam::npm::npm run [ab]')).toBe(false);
  });
});

// --------------------------------------------------------------------------
// 缺口落表与读回
// --------------------------------------------------------------------------

describe('capability_gaps —— 落表闸与读回', () => {
  it('落一条缺口并原样读回（含操作块与已试替代）', () => {
    const gap = gapOf();
    insertGapSync(root, gap);
    const back = readGapSync(root, gap.gapId);
    expect(back).toBeDefined();
    expect(back?.operation.argv).toEqual(['npm', 'run', 'build']);
    expect(back?.operation.cwd).toBe(ROOT);
    expect(back?.operation.writes).toEqual(['dist/**']);
    expect(back?.tried).toHaveLength(1);
    expect(back?.why).toContain('验收标准');
    expect(back?.status).toBe('open');
  });

  it('high 风险拒收（一律 refuse，不请人类授权外泄类操作）', () => {
    expect(() => insertGapSync(root, gapOf({ risk: 'high' }))).toThrow(/high 风险/);
    expect(readAllOpenGapsSync(root)).toHaveLength(0);
  });

  it('未挂钩验收标准拒收（否则「我觉得需要」变成特权的滑坡）', () => {
    expect(() => insertGapSync(root, gapOf({ why: '   ' }))).toThrow(/验收标准/);
  });

  it('缺 argv 拒收（代执行只按宿主可核对字段构造命令）', () => {
    const gap = gapOf();
    gap.operation.argv = [];
    expect(() => insertGapSync(root, gap)).toThrow(/argv/);
  });

  it('读端按 status / task 过滤，且含已定路线者（领队要看历史判「这一站的固定需求」）', () => {
    const a = gapOf({ taskId: 7 });
    const b = gapOf({ taskId: 8 });
    insertGapSync(root, a);
    insertGapSync(root, b);
    setGapRouteSync(root, b.gapId, { route: 'split-stage', decidedBy: 'captain' });

    const open = readOpenGapsSync(root, teamId);
    expect(open.map((g) => g.gapId)).toEqual([a.gapId]);
    expect(readAllOpenGapsSync(root).map((g) => g.gapId)).toEqual([a.gapId]);

    const byTask = readGapsByTaskSync(root, teamId, 8);
    expect(byTask.map((g) => g.gapId)).toEqual([b.gapId]);
    expect(byTask[0]?.status).toBe('routed');
  });

  it('坏 JSON 容错：operation 解析失败按空操作块装回，读端不炸', () => {
    const gap = gapOf();
    insertGapSync(root, gap);
    // 直接污染列（模拟手工行/旧版本残留）：读端必须降级而不是抛
    const db = getDb(root);
    db.prepare('UPDATE capability_gaps SET operation = ? WHERE gap_id = ?').run(
      '{不是 JSON',
      gap.gapId,
    );
    const back = readGapSync(root, gap.gapId);
    expect(back).toBeDefined();
    expect(back?.operation.argv).toEqual([]);
    expect(back?.why).toContain('验收标准');
  });

  it('缺口不落关联字段（交付操作给主会话是消息，不经问答单）', () => {
    const gap = gapOf();
    insertGapSync(root, gap);
    const back = readGapSync(root, gap.gapId);
    expect(back).toBeDefined();
    expect(Object.keys(back ?? {})).not.toContain('askId');
  });
});

// --------------------------------------------------------------------------
// 缺口生命周期：先决者胜
// --------------------------------------------------------------------------

describe('capability_gaps —— 路线决定与终态', () => {
  it('open → routed 写入路线四要素', () => {
    const gap = gapOf();
    insertGapSync(root, gap);
    setGapRouteSync(root, gap.gapId, {
      route: 'widen-and-redelegate',
      note: '本站可整体重跑',
      decidedBy: 'user',
    });
    const back = readGapSync(root, gap.gapId);
    expect(back?.status).toBe('routed');
    expect(back?.route).toBe('widen-and-redelegate');
    expect(back?.routeNote).toBe('本站可整体重跑');
    expect(back?.decidedBy).toBe('user');
    expect(back?.decidedAt).toBeGreaterThan(0);
  });

  it('先决者胜：第二个路线决定静默落空，且返回值标明谁赢了', () => {
    const gap = gapOf();
    insertGapSync(root, gap);
    const first = setGapRouteSync(root, gap.gapId, {
      route: 'main-executes',
      decidedBy: 'captain',
    });
    const second = setGapRouteSync(root, gap.gapId, { route: 'split-stage', decidedBy: 'user' });
    expect(first).toBe(true);
    expect(second).toBe(false);
    const back = readGapSync(root, gap.gapId);
    expect(back?.route).toBe('main-executes');
    expect(back?.decidedBy).toBe('captain');
  });

  it('终态收尾只从 open/routed 迁移，终态不可再迁移', () => {
    const gap = gapOf();
    insertGapSync(root, gap);
    setGapRouteSync(root, gap.gapId, { route: 'main-executes', decidedBy: 'captain' });
    setGapEndedSync(root, gap.gapId, 'resolved');
    expect(readGapSync(root, gap.gapId)?.status).toBe('resolved');
    setGapEndedSync(root, gap.gapId, 'expired');
    expect(readGapSync(root, gap.gapId)?.status).toBe('resolved');
  });
});

// --------------------------------------------------------------------------
// 常设路线：作用域、过期、唯一性、安全闸
// --------------------------------------------------------------------------

describe('routing_memos —— 常设路线', () => {
  it('团队级路线命中本团队任一任务；任务级优先于团队级', () => {
    const cls = operationClassOf(['npm', 'run', 'build'], ROOT);
    upsertRoutingMemoSync(root, memoOf({ operationClass: cls }));
    expect(resolveRoutingMemoSync(root, teamId, 7, cls)?.route).toBe('main-executes');

    upsertRoutingMemoSync(
      root,
      memoOf({ operationClass: cls, taskId: 7, route: 'split-stage', decidedBy: 'user' }),
    );
    expect(resolveRoutingMemoSync(root, teamId, 7, cls)?.route).toBe('split-stage');
    // 别的任务只拿到团队级那条
    expect(resolveRoutingMemoSync(root, teamId, 8, cls)?.route).toBe('main-executes');
    // 任务级不跨工作区/跨团队：别的团队查不到
    expect(resolveRoutingMemoSync(root, teamId + 1, 7, cls)).toBeUndefined();
  });

  it('同作用域同键 upsert 为一行（唯一性由写入代码保证，不靠 UNIQUE）', () => {
    const cls = operationClassOf(['npm', 'run', 'build'], ROOT);
    upsertRoutingMemoSync(root, memoOf({ operationClass: cls, route: 'main-executes' }));
    const id = upsertRoutingMemoSync(root, memoOf({ operationClass: cls, route: 'split-stage' }));
    expect(readRoutingMemosSync(root, teamId)).toHaveLength(1);
    expect(resolveRoutingMemoSync(root, teamId, 7, cls)?.memoId).toBe(id);
    expect(resolveRoutingMemoSync(root, teamId, 7, cls)?.route).toBe('split-stage');
  });

  it('过期路线不命中、不进列表', () => {
    const cls = operationClassOf(['npm', 'run', 'build'], ROOT);
    upsertRoutingMemoSync(root, memoOf({ operationClass: cls, expiresAt: Date.now() - 1000 }));
    expect(resolveRoutingMemoSync(root, teamId, 7, cls)).toBeUndefined();
    expect(readRoutingMemosSync(root, teamId)).toHaveLength(0);
  });

  it('任务收口清理只失效任务级路线，团队级保留', () => {
    const cls = operationClassOf(['npm', 'run', 'build'], ROOT);
    upsertRoutingMemoSync(root, memoOf({ operationClass: cls }));
    upsertRoutingMemoSync(root, memoOf({ operationClass: cls, taskId: 7 }));
    expect(expireRoutingMemosForTaskSync(root, teamId, 7)).toBe(1);
    // 任务级已失效 → 回落到团队级
    expect(resolveRoutingMemoSync(root, teamId, 7, cls)?.taskId).toBeUndefined();
    expect(readRoutingMemosSync(root, teamId)).toHaveLength(1);
  });

  it('安全闸：非法路线 / 未归一的操作键 / 无出处的决定一律拒收', () => {
    expect(() => upsertRoutingMemoSync(root, memoOf({ route: 'auto-allow' as never }))).toThrow(
      /非法路线/,
    );
    expect(() => upsertRoutingMemoSync(root, memoOf({ operationClass: 'npm run *' }))).toThrow(
      /归一/,
    );
    expect(() => upsertRoutingMemoSync(root, memoOf({ decidedBy: undefined as never }))).toThrow(
      /出处/,
    );
    expect(readRoutingMemosSync(root, teamId)).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// *InTx 形态：随动写并入调用方事务，失败整体回滚
// --------------------------------------------------------------------------

describe('*InTx —— 随动写与原子性', () => {
  it('缺口与路线在同一事务里提交', () => {
    const gap = gapOf();
    const cls = operationClassOf(['npm', 'run', 'build'], ROOT);
    withTeamTx(root, teamId, (tx) => {
      insertGapInTx(tx, gap);
      setGapRouteInTx(tx, gap.gapId, { route: 'main-executes', decidedBy: 'captain' });
      upsertRoutingMemoInTx(tx, memoOf({ operationClass: cls, taskId: 7 }));
    });
    expect(readGapSync(root, gap.gapId)?.status).toBe('routed');
    expect(resolveRoutingMemoSync(root, teamId, 7, cls)?.route).toBe('main-executes');
  });

  it('事务内抛错 → 缺口与路线一并回滚（「改派 + 记路线」必须原子）', () => {
    const gap = gapOf();
    const cls = operationClassOf(['npm', 'run', 'build'], ROOT);
    expect(() =>
      withTeamTx(root, teamId, (tx) => {
        insertGapInTx(tx, gap);
        upsertRoutingMemoInTx(tx, memoOf({ operationClass: cls, taskId: 7 }));
        throw new Error('注入失败');
      }),
    ).toThrow('注入失败');
    expect(readGapSync(root, gap.gapId)).toBeUndefined();
    expect(readRoutingMemosSync(root, teamId)).toHaveLength(0);
  });

  it('*InTx 的落表闸与 *Sync 一致（high 风险在事务内同样拒收）', () => {
    expect(() =>
      withTeamTx(root, teamId, (tx) => {
        insertGapInTx(tx, gapOf({ risk: 'high' }));
      }),
    ).toThrow(/high 风险/);
    expect(readAllOpenGapsSync(root)).toHaveLength(0);
  });
});
