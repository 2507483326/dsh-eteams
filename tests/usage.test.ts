/**
 * docs/28 usage meter tests: attribution priority (28.3.2), live append +
 * route folding, watermark reconcile/dedup (28.3.4), rotation (28.6.1) and
 * the aggregation API (28.4). Fake host ctx captures the firehose listeners
 * installed by installUsageMeter (E18 same-shape).
 *
 * @module dsh-eteams/tests/usage
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig, type ETeamsResolvedConfig } from '../src/host/config';
import type { TeamState } from '../src/host/model/types';
import { registerCaptainChild } from '../src/host/runtime/captainAgent';
import { setSessionTeam } from '../src/host/runtime/sessionTeam';
import {
  dayKeyOf,
  installUsageMeter,
  readUsageCalendar,
  registerMemberSession,
  resetUsageMeterForTests,
  rotateUsage,
  usageArchiveFile,
  usageCheckpointFile,
  usageFile,
  usageWritesIdle,
  type UsageMeterHandle,
  type UsageRecord,
} from '../src/host/runtime/usage';
import { insertTeamRow, withTeamTx, writeTeam } from '../src/host/state/store';
import { LEADER_NAME } from '../src/host/state/db';
import { cleanupTempWorkspace } from './support/tmpWorkspace';

let root: string;
let stateRoot: string;
const config: ETeamsResolvedConfig = resolveConfig({ stateDir: '.eteams' });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eteams-usage-'));
  stateRoot = join(root, '.eteams');
  // 逐项写 usage.jsonl 的用例需要目录先在（meter 写路径自带 mkdir）。
  mkdirSync(stateRoot, { recursive: true });
  resetUsageMeterForTests();
});

afterEach(() => {
  resetUsageMeterForTests();
  // SQLite 连接先关（本套件只在领队归属测试落库）再删目录——退避重试兜住
  // 刚写完的 usage 文件被扫描短暂占住的情形（tests/support/tmpWorkspace）。
  cleanupTempWorkspace(root);
});

/** SQLite 契约播种：team 行 + 领队实例行（usage 的领队归属读领队行
 * mainSessionId，team.captainSessionId 字段已随锚点迁走，docs/36 建议 3）。 */
async function seedTeam(name: string, leaderSession: string): Promise<number> {
  let teamId = 0;
  withTeamTx(stateRoot, undefined, (tx) => {
    teamId = insertTeamRow(tx, name, true, tx.now);
  });
  const state = {
    id: teamId,
    name,
    hasLeader: true,
    createdAt: 1,
    updatedAt: 1,
    taskMembers: [
      {
        id: 0,
        teamId,
        mainTaskId: null,
        nowTaskId: null,
        name: LEADER_NAME,
        employeeId: null,
        mainSessionId: leaderSession,
        childSessionId: '',
        roleId: null,
        status: 'ready' as const,
        createdAt: 1,
      },
    ],
    members: [],
    tasks: [],
    pendingDecisions: [],
  } satisfies TeamState;
  await writeTeam(stateRoot, state);
  return teamId;
}

// ---------- fake host ctx (capturing firehose) ----------

interface MeterHarness {
  handle: UsageMeterHandle;
  emit(session: Session, event: SessionEvent): void;
  emitCreated(session: Session): void;
  setSessions(list: Session[]): void;
}

function installMeter(sessions: Session[] = []): MeterHarness {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  let live: Session[] = sessions;
  const ctx = {
    on(name: unknown, listener: (...args: unknown[]) => unknown): void {
      listeners.set(String(name), listener);
    },
    logger: { info(): void {}, warn(): void {} },
    sessions: { list: (): Session[] => live },
  };
  const handle = installUsageMeter(ctx as unknown as Context, config);
  return {
    handle,
    emit: (session, event) => {
      listeners.get('session/event')?.(session, event);
    },
    emitCreated: (session) => {
      listeners.get('session/created')?.(session);
    },
    setSessions: (list) => {
      live = list;
    },
  };
}

function makeSession(id: string, events: SessionEvent[] = [], cwd = root): Session {
  return {
    id,
    header: { version: 1, id, createdAt: 0, cwd },
    events,
    firstLiveSeq: 0,
  } as unknown as Session;
}

/** assistant/message carrying usage（TokenUsage 子集按测试需要给）。 */
function usageEvent(
  seq: number,
  at: number,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  },
): SessionEvent {
  return { type: 'assistant/message', seq, time: at, data: { usage } } as unknown as SessionEvent;
}

function headerEvent(provider: string, model: string): SessionEvent {
  return {
    type: 'request/header',
    seq: 0,
    time: 0,
    data: { header: { config: { provider, model } } },
  } as unknown as SessionEvent;
}

/** Local-noon timestamps → dayKeyOf lands on the same local date deterministically. */
function noon(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12, 0, 0).getTime();
}

/** 365/366 as the zero-filled grid builds it (28.4). */
function daysInYear(year: number): number {
  let total = 0;
  for (let month = 0; month < 12; month += 1) total += new Date(year, month + 1, 0).getDate();
  return total;
}

function readRows(file: string): UsageRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as UsageRecord);
}

// ---------- 归属优先级（28.3.2） ----------

describe('attribution priority', () => {
  it('member registry wins with memberName', async () => {
    registerMemberSession('mem-1', { teamId: 'team-a', memberName: 'Alice' });
    const meter = installMeter();
    meter.emit(
      makeSession('mem-1'),
      usageEvent(1, noon(2025, 6, 15), { inputTokens: 10, outputTokens: 5 }),
    );
    await usageWritesIdle();
    const rows = readRows(usageFile(stateRoot));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: 'mem-1',
      teamId: 'team-a',
      memberName: 'Alice',
      roleKind: 'member',
      day: '2025-06-15',
    });
  });

  it('captain-child registry resolves before conversation binding', async () => {
    registerCaptainChild('child-1', 'team-b');
    setSessionTeam('child-1', { teamId: 'team-z', name: 'Z', boundAt: 0 });
    const meter = installMeter();
    meter.emit(
      makeSession('child-1'),
      usageEvent(1, noon(2025, 6, 15), { inputTokens: 1, outputTokens: 1 }),
    );
    await usageWritesIdle();
    const rows = readRows(usageFile(stateRoot));
    expect(rows[0]?.roleKind).toBe('captain-child');
    expect(rows[0]?.teamId).toBe('team-b');
    expect(rows[0]?.memberName).toBeNull();
  });

  it('captain session matches the leader row mainSessionId on disk', async () => {
    const teamId = await seedTeam('丙队', 'cap-9');
    const meter = installMeter();
    meter.emit(
      makeSession('cap-9'),
      usageEvent(1, noon(2025, 6, 15), { inputTokens: 2, outputTokens: 2 }),
    );
    await usageWritesIdle();
    const rows = readRows(usageFile(stateRoot));
    expect(rows[0]).toMatchObject({
      teamId: String(teamId),
      roleKind: 'captain',
      memberName: null,
    });
  });

  it('panel binding (conversation) beats workspace bucket', async () => {
    setSessionTeam('conv-1', { teamId: 'team-d', name: 'D', boundAt: 0 });
    const meter = installMeter();
    meter.emit(
      makeSession('conv-1'),
      usageEvent(1, noon(2025, 6, 15), { inputTokens: 3, outputTokens: 4 }),
    );
    await usageWritesIdle();
    const rows = readRows(usageFile(stateRoot));
    expect(rows[0]).toMatchObject({ teamId: 'team-d', roleKind: 'conversation' });
  });

  it('unattributable sessions land in the workspace bucket (teamId null)', async () => {
    const meter = installMeter();
    meter.emit(
      makeSession('stray-1'),
      usageEvent(1, noon(2025, 6, 15), { inputTokens: 9, outputTokens: 9 }),
    );
    await usageWritesIdle();
    const rows = readRows(usageFile(stateRoot));
    expect(rows[0]).toMatchObject({ teamId: null, roleKind: 'workspace', memberName: null });
  });
});

// ---------- 记账与路线折叠 ----------

describe('live accounting', () => {
  it('folds provider/model from request/header and skips usage-less messages', async () => {
    const meter = installMeter();
    const session = makeSession('s-1');
    meter.emit(session, headerEvent('deepseek', 'v3.2'));
    meter.emit(session, usageEvent(1, noon(2025, 6, 15), { inputTokens: 100, outputTokens: 20 }));
    meter.emit(session, {
      type: 'assistant/message',
      seq: 2,
      time: noon(2025, 6, 15),
      data: {},
    } as unknown as SessionEvent);
    await usageWritesIdle();
    const rows = readRows(usageFile(stateRoot));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'deepseek',
      model: 'v3.2',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    });
  });

  it('keeps non-finite/absent optional counts as null and clamps input/output', async () => {
    const meter = installMeter();
    meter.emit(
      makeSession('s-2'),
      usageEvent(1, noon(2025, 6, 15), {
        inputTokens: Number.NaN,
        outputTokens: 7,
        cacheReadTokens: 0,
        reasoningTokens: 512,
      }),
    );
    await usageWritesIdle();
    const rows = readRows(usageFile(stateRoot));
    expect(rows[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 7,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: 512,
    });
  });
});

// ---------- 水位对账（28.3.4） ----------

describe('watermark reconcile', () => {
  it('folds live sessions once, persists checkpoints, and skips refolds', async () => {
    const session = makeSession('s-3', [
      usageEvent(1, noon(2025, 6, 15), { inputTokens: 10, outputTokens: 1 }),
      usageEvent(3, noon(2025, 6, 16), { inputTokens: 20, outputTokens: 2 }),
    ]);
    registerMemberSession('s-3', { teamId: 'team-a', memberName: 'Alice' });
    const meter = installMeter([session]);
    await meter.handle.reconcileAll();
    expect(readRows(usageFile(stateRoot))).toHaveLength(2);
    await meter.handle.flush();
    expect(JSON.parse(readFileSync(usageCheckpointFile(stateRoot), 'utf8'))).toMatchObject({
      's-3': { lastSeq: 3 },
    });
    // 重启模拟：内存清空后按水位文件重折 → 无新行（种子不重发 + 水位）
    resetUsageMeterForTests();
    await meter.handle.reconcileAll();
    expect(readRows(usageFile(stateRoot))).toHaveLength(2);
  });

  it('persists the checkpoint of live rows via flush()', async () => {
    // 会话在装机会话清单里 → reconcileAll 先装在 checkpoint map（loader 完成）
    const meter = installMeter([makeSession('s-4')]);
    registerMemberSession('s-4', { teamId: 'team-a', memberName: 'Bob' });
    await meter.handle.reconcileAll();
    meter.emit(
      makeSession('s-4'),
      usageEvent(5, noon(2025, 6, 15), { inputTokens: 1, outputTokens: 1 }),
    );
    await meter.handle.flush();
    expect(JSON.parse(readFileSync(usageCheckpointFile(stateRoot), 'utf8'))).toMatchObject({
      's-4': { lastSeq: 5 },
    });
    // 水位在盘：重启后对账不再重折该事件（读侧也无重复行）
    resetUsageMeterForTests();
    meter.setSessions([
      makeSession('s-4', [usageEvent(5, noon(2025, 6, 15), { inputTokens: 1, outputTokens: 1 })]),
    ]);
    await meter.handle.reconcileAll();
    expect(readRows(usageFile(stateRoot))).toHaveLength(1);
  });

  it('read-side (sessionId, seq) dedup hides repeated folds from aggregation', async () => {
    const base = {
      at: noon(2025, 6, 15),
      day: '2025-06-15',
      sessionId: 's-5',
      seq: 9,
      teamId: 'team-a',
      memberName: 'Alice',
      roleKind: 'member',
      provider: null,
      model: null,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    } satisfies UsageRecord;
    writeFileSync(usageFile(stateRoot), `${JSON.stringify(base)}\n${JSON.stringify(base)}\n`);
    const calendar = readUsageCalendar(stateRoot, 'team-a', 2025);
    expect(calendar.totals.inputTokens).toBe(100);
    expect(calendar.totals.calls).toBe(1);
  });
});

// ---------- 聚合（28.4） ----------

describe('readUsageCalendar', () => {
  it('aggregates by day across months and filters year/team', () => {
    const row = (
      sessionId: string,
      teamId: string | null,
      at: number,
      day: string,
      input: number,
      output: number,
      seq = 1,
      extra: Partial<UsageRecord> = {},
    ): UsageRecord => ({
      at,
      day,
      sessionId,
      seq,
      teamId,
      memberName: null,
      roleKind: teamId === null ? 'workspace' : 'captain',
      provider: null,
      model: null,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      ...extra,
    });
    const rows: UsageRecord[] = [
      row('a1', 'team-a', noon(2025, 6, 15), '2025-06-15', 100, 10, 1, {
        cacheReadTokens: 50,
        cacheWriteTokens: 25,
        reasoningTokens: 512,
      }),
      row('a2', 'team-a', noon(2025, 6, 15), '2025-06-15', 200, 20, 2),
      row('a3', 'team-a', noon(2025, 7, 1), '2025-07-01', 300, 30, 3),
      row('a4', 'team-b', noon(2025, 7, 2), '2025-07-02', 999, 1, 4),
      row('a5', null, noon(2024, 2, 1), '2024-02-01', 500, 50, 5),
    ];
    writeFileSync(usageFile(stateRoot), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const calendar = readUsageCalendar(stateRoot, 'team-a', 2025);
    // 2025 全年 365 格（非闰年）零填充
    expect(calendar.days).toHaveLength(365);
    const june15 = calendar.days.find((d) => d.date === '2025-06-15');
    expect(june15).toMatchObject({
      date: '2025-06-15',
      totalTokens: 405,
      inputTokens: 300,
      outputTokens: 30,
      cacheReadTokens: 50,
      cacheWriteTokens: 25,
      reasoningTokens: 512,
      calls: 2,
    });
    // reasoning 不计入 totalTokens（28.3.3）
    expect(june15?.totalTokens).toBe(100 + 10 + 50 + 25 + 200 + 20);
    expect(calendar.totals).toMatchObject({
      totalTokens: 405 + 330,
      inputTokens: 600,
      outputTokens: 60,
      calls: 3,
      firstDay: '2025-06-15',
      lastDay: '2025-07-01',
    });
    // 别的年份 / 别的团队不串桶
    const y2024 = readUsageCalendar(stateRoot, 'team-a', 2024);
    expect(y2024.totals.totalTokens).toBe(0);
    const b2025 = readUsageCalendar(stateRoot, 'team-b', 2025);
    expect(b2025.totals.inputTokens).toBe(999);
    expect(b2025.days).toHaveLength(365);
  });

  it('returns a zero-filled full-year grid for a future year (not 404)', () => {
    const year = new Date().getFullYear() + 1;
    const calendar = readUsageCalendar(stateRoot, 'team-x', year);
    expect(calendar.days).toHaveLength(daysInYear(year));
    expect(calendar.totals.totalTokens).toBe(0);
    expect(calendar.totals.firstDay).toBeNull();
  });

  it('merges archived rows after rotation (read side)', async () => {
    const oldAt = noon(2024, 1, 1);
    const newAt = noon(2026, 6, 1);
    const oldRow: UsageRecord = {
      at: oldAt,
      day: dayKeyOf(oldAt),
      sessionId: 'r-1',
      seq: 1,
      teamId: 'team-a',
      memberName: null,
      roleKind: 'captain',
      provider: null,
      model: null,
      inputTokens: 111,
      outputTokens: 0,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    };
    const newRow: UsageRecord = { ...oldRow, at: newAt, day: dayKeyOf(newAt), seq: 2, inputTokens: 222 };
    writeFileSync(usageFile(stateRoot), `${JSON.stringify(oldRow)}\n${JSON.stringify(newRow)}\n`);
    // 双阈值：老行（>730 天）搬出 → 归档；新行保留
    const rotated = await rotateUsage(stateRoot);
    expect(rotated).toBe(true);
    expect(existsSync(usageArchiveFile(stateRoot))).toBe(true);
    expect(readRows(usageFile(stateRoot))).toHaveLength(1);
    expect(readRows(usageArchiveFile(stateRoot))).toHaveLength(1);
    // 聚合仍能看到轮转出的老行（主文件 + 归档合并读，28.6.2）
    expect(readUsageCalendar(stateRoot, 'team-a', 2024).totals.inputTokens).toBe(111);
    expect(readUsageCalendar(stateRoot, 'team-a', 2026).totals.inputTokens).toBe(222);
  });

  it('size threshold moves older rows and keeps the tail', async () => {
    const bigAt = noon(2025, 5, 1);
    const big: UsageRecord = {
      at: bigAt,
      day: dayKeyOf(bigAt),
      sessionId: 'sz',
      seq: 5,
      teamId: 'team-a',
      memberName: null,
      roleKind: 'workspace',
      provider: null,
      model: 'x'.repeat(400_000),
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    };
    const rows: UsageRecord[] = [1, 2, 3, 4, 5].map((seq) => ({
      ...big,
      seq,
      day: `2025-04-${String(seq).padStart(2, '0')}`,
      at: noon(2025, 4, seq),
    }));
    writeFileSync(usageFile(stateRoot), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    // maxBytes=1 → overSize；尾部保留到 KEEP_BYTES 预算（约 3 行大行）即停
    const rotated = await rotateUsage(stateRoot, { maxBytes: 1 });
    expect(rotated).toBe(true);
    const kept = readRows(usageFile(stateRoot));
    const archived = readRows(usageArchiveFile(stateRoot));
    expect(kept.length + archived.length).toBe(5);
    expect(kept.length).toBeGreaterThan(0);
    expect(archived.length).toBeGreaterThan(0);
    // 保留段是最新行（seq 递增序），搬出段是头部老行
    expect(kept[0]!.seq).toBe(archived.length + 1);
    expect(kept[kept.length - 1]!.seq).toBe(5);
    // 聚合合并读：搬出行仍可见
    expect(readUsageCalendar(stateRoot, 'team-a', 2025).totals.calls).toBe(5);
  });

  it('no rotation on a young small file', async () => {
    const now = Date.now();
    const row: UsageRecord = {
      at: now,
      day: dayKeyOf(now),
      sessionId: 'now',
      seq: 1,
      teamId: null,
      memberName: null,
      roleKind: 'workspace',
      provider: null,
      model: null,
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    };
    writeFileSync(usageFile(stateRoot), `${JSON.stringify(row)}\n`);
    expect(await rotateUsage(stateRoot)).toBe(false);
    expect(existsSync(usageArchiveFile(stateRoot))).toBe(false);
  });
});

// ---------- 安装面（E18 同型） ----------

describe('installUsageMeter', () => {
  it('session/created triggers a fold of that session', async () => {
    const meter = installMeter();
    registerMemberSession('s-6', { teamId: 'team-a', memberName: 'Alice' });
    meter.emitCreated(
      makeSession('s-6', [usageEvent(2, noon(2025, 6, 15), { inputTokens: 5, outputTokens: 5 })]),
    );
    await usageWritesIdle();
    expect(readRows(usageFile(stateRoot))).toHaveLength(1);
  });

  it('listener failures never escape (meter never breaks sessions)', () => {
    const meter = installMeter();
    expect(() =>
      meter.emit(makeSession('s-7'), {
        type: 'assistant/message',
        seq: 1,
        time: 0,
      } as unknown as SessionEvent),
    ).not.toThrow();
  });
});