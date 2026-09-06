/**
 * docs/40 usage meter tests: attribution priority, live write-through into
 * the two SQLite tables (usage_detail + usage_daily_total), both read scopes
 * and root merging. The file ledger / watermark / rotation machinery is gone
 * - a negative test pins that no usage files appear on disk. Fake host ctx
 * captures the firehose listener installed by installUsageMeter (E18
 * same-shape).
 *
 * @module dsh-eteams/tests/usage
 */
import { existsSync, mkdtempSync } from 'node:fs';
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
  readAppUsageCalendar,
  readUsageCalendar,
  registerMemberSession,
  resetUsageMeterForTests,
  usageWritesIdle,
} from '../src/host/runtime/usage';
import { getDb, LEADER_NAME } from '../src/host/state/db';
import { recordUsage, type UsageRecord } from '../src/host/state/usageStore';
import { insertTeamRow, withTeamTx, writeTeam } from '../src/host/state/store';
import { cleanupTempWorkspace } from './support/tmpWorkspace';

let root: string;
let stateRoot: string;
const config: ETeamsResolvedConfig = resolveConfig({ stateDir: '.eteams' });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eteams-usage-'));
  stateRoot = join(root, '.eteams');
  resetUsageMeterForTests();
});

afterEach(() => {
  resetUsageMeterForTests();
  // Close the SQLite connection before deleting the directory (getDb caches
  // per state root; on Windows an open connection blocks rmSync with EPERM).
  cleanupTempWorkspace(root);
});

/** SQLite seed: team row + leader instance row (usage captain attribution
 * matches the leader row's mainSessionId on disk). */
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
  emit(session: Session, event: SessionEvent): void;
}

function installMeter(): MeterHarness {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const ctx = {
    on(name: unknown, listener: (...args: unknown[]) => unknown): void {
      listeners.set(String(name), listener);
    },
    logger: { info(): void {}, warn(): void {} },
  };
  installUsageMeter(ctx as unknown as Context, config);
  return {
    emit: (session, event) => {
      listeners.get('session/event')?.(session, event);
    },
  };
}

function makeSession(id: string): Session {
  return {
    id,
    header: { version: 1, id, createdAt: 0, cwd: root },
    events: [],
    firstLiveSeq: 0,
  } as unknown as Session;
}

/** assistant/message carrying usage (TokenUsage subset as needed). */
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

/** Local-noon timestamps: dayKeyOf lands on the same local date. */
function noon(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12, 0, 0).getTime();
}

/** 365/366 as the zero-filled grid builds it. */
function daysInYear(year: number): number {
  let total = 0;
  for (let month = 0; month < 12; month += 1) total += new Date(year, month + 1, 0).getDate();
  return total;
}

type DetailRow = Record<string, unknown>;

/** All usage_detail rows in insertion order. */
function detailRows(): DetailRow[] {
  return getDb(stateRoot)
    .prepare('SELECT * FROM usage_detail ORDER BY usage_detail_id')
    .all() as DetailRow[];
}

/** The usage_daily_total row for one day (undefined when absent). */
function totalRow(day: string): DetailRow | undefined {
  return getDb(stateRoot).prepare('SELECT * FROM usage_daily_total WHERE day = ?').get(day) as
    | DetailRow
    | undefined;
}

/** Seed one detail row straight through the write path (recordUsage). */
function seedRow(partial: {
  sessionId: string;
  seq: number;
  teamId: string | null;
  roleKind: UsageRecord['roleKind'];
  at: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
}): void {
  const row: UsageRecord = {
    at: partial.at,
    day: dayKeyOf(partial.at),
    sessionId: partial.sessionId,
    seq: partial.seq,
    teamId: partial.teamId,
    memberName: null,
    roleKind: partial.roleKind,
    provider: null,
    model: null,
    inputTokens: partial.inputTokens,
    outputTokens: partial.outputTokens,
    cacheReadTokens: partial.cacheReadTokens ?? null,
    cacheWriteTokens: partial.cacheWriteTokens ?? null,
    reasoningTokens: partial.reasoningTokens ?? null,
  };
  recordUsage(getDb(stateRoot), row);
}

// ---------- attribution priority ----------

describe('attribution priority', () => {
  it('member registry wins with memberName', async () => {
    registerMemberSession('mem-1', {
      teamId: 'team-a',
      memberName: 'Alice',
      parentSessionId: 'leader-1',
    });
    const meter = installMeter();
    meter.emit(
      makeSession('mem-1'),
      usageEvent(1, noon(2025, 6, 15), { inputTokens: 10, outputTokens: 5 }),
    );
    await usageWritesIdle();
    const rows = detailRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: 'mem-1',
      team_key: 'team-a',
      member_name: 'Alice',
      role_kind: 'member',
      day: '2025-06-15',
    });
    expect(totalRow('2025-06-15')).toMatchObject({ calls: 1, total_tokens: 15 });
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
    const rows = detailRows();
    expect(rows[0]?.role_kind).toBe('captain-child');
    expect(rows[0]?.team_key).toBe('team-b');
    expect(rows[0]?.member_name).toBeNull();
  });

  it('captain session matches the leader row mainSessionId on disk', async () => {
    const teamId = await seedTeam('bing-dui', 'cap-9');
    const meter = installMeter();
    meter.emit(
      makeSession('cap-9'),
      usageEvent(1, noon(2025, 6, 15), { inputTokens: 2, outputTokens: 2 }),
    );
    await usageWritesIdle();
    const rows = detailRows();
    expect(rows[0]).toMatchObject({ team_key: String(teamId), role_kind: 'captain' });
    expect(rows[0]?.member_name).toBeNull();
  });

  it('panel binding (conversation) beats workspace bucket', async () => {
    setSessionTeam('conv-1', { teamId: 'team-d', name: 'D', boundAt: 0 });
    const meter = installMeter();
    meter.emit(
      makeSession('conv-1'),
      usageEvent(1, noon(2025, 6, 15), { inputTokens: 3, outputTokens: 4 }),
    );
    await usageWritesIdle();
    expect(detailRows()[0]).toMatchObject({ team_key: 'team-d', role_kind: 'conversation' });
  });

  it('unattributable sessions land in the workspace bucket (teamId null)', async () => {
    const meter = installMeter();
    meter.emit(
      makeSession('stray-1'),
      usageEvent(1, noon(2025, 6, 15), { inputTokens: 9, outputTokens: 9 }),
    );
    await usageWritesIdle();
    const rows = detailRows();
    expect(rows[0]).toMatchObject({ team_key: null, role_kind: 'workspace', member_name: null });
  });
});

// ---------- live accounting ----------

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
    const rows = detailRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'deepseek',
      model: 'v3.2',
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      cache_read_tokens: null,
      cache_write_tokens: null,
      reasoning_tokens: null,
    });
    expect(totalRow('2025-06-15')).toMatchObject({
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      calls: 1,
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
    const rows = detailRows();
    expect(rows[0]).toMatchObject({
      input_tokens: 0,
      output_tokens: 7,
      total_tokens: 7,
      cache_read_tokens: null,
      cache_write_tokens: null,
      reasoning_tokens: 512,
    });
    expect(totalRow('2025-06-15')).toMatchObject({ reasoning_tokens: 512, total_tokens: 7 });
  });

  it('increments the day-total row across events of the same day', async () => {
    const meter = installMeter();
    registerMemberSession('s-inc', {
      teamId: 'team-a',
      memberName: 'Alice',
      parentSessionId: 'leader-1',
    });
    meter.emit(
      makeSession('s-inc'),
      usageEvent(1, noon(2025, 6, 15), { inputTokens: 10, outputTokens: 1 }),
    );
    meter.emit(
      makeSession('s-inc'),
      usageEvent(2, noon(2025, 6, 15), { inputTokens: 20, outputTokens: 2, cacheReadTokens: 5 }),
    );
    await usageWritesIdle();
    expect(detailRows()).toHaveLength(2);
    expect(totalRow('2025-06-15')).toMatchObject({
      input_tokens: 30,
      output_tokens: 3,
      cache_read_tokens: 5,
      total_tokens: 38,
      calls: 2,
    });
  });

  it('writes no ledger/watermark/archive files (DB is the sole storage)', async () => {
    const meter = installMeter();
    meter.emit(
      makeSession('s-1'),
      usageEvent(1, noon(2025, 6, 15), { inputTokens: 10, outputTokens: 5 }),
    );
    await usageWritesIdle();
    expect(detailRows()).toHaveLength(1);
    expect(existsSync(join(stateRoot, 'usage.jsonl'))).toBe(false);
    expect(existsSync(join(stateRoot, 'usage-checkpoint.json'))).toBe(false);
    expect(existsSync(join(stateRoot, 'usage-archive.jsonl'))).toBe(false);
  });
});

// ---------- read scopes ----------

describe('readUsageCalendar (team scope)', () => {
  it('aggregates by day across months and filters year/team', () => {
    seedRow({
      sessionId: 'a1', seq: 1, teamId: 'team-a', roleKind: 'member',
      at: noon(2025, 6, 15), inputTokens: 100, outputTokens: 10,
      cacheReadTokens: 50, cacheWriteTokens: 25, reasoningTokens: 512,
    });
    seedRow({ sessionId: 'a2', seq: 2, teamId: 'team-a', roleKind: 'member', at: noon(2025, 6, 15), inputTokens: 200, outputTokens: 20 });
    seedRow({ sessionId: 'a3', seq: 3, teamId: 'team-a', roleKind: 'member', at: noon(2025, 7, 1), inputTokens: 300, outputTokens: 30 });
    seedRow({ sessionId: 'a4', seq: 4, teamId: 'team-b', roleKind: 'member', at: noon(2025, 7, 2), inputTokens: 999, outputTokens: 1 });
    seedRow({ sessionId: 'a5', seq: 5, teamId: null, roleKind: 'workspace', at: noon(2024, 2, 1), inputTokens: 500, outputTokens: 50 });
    const calendar = readUsageCalendar(stateRoot, 'team-a', 2025);
    expect(calendar.days).toHaveLength(365); // 2025 is not a leap year
    const june15 = calendar.days.find((d) => d.date === '2025-06-15');
    expect(june15).toMatchObject({
      date: '2025-06-15',
      totalTokens: 405, // reasoning (512) is excluded from totalTokens
      inputTokens: 300,
      outputTokens: 30,
      cacheReadTokens: 50,
      cacheWriteTokens: 25,
      reasoningTokens: 512,
      calls: 2,
    });
    expect(calendar.totals).toMatchObject({
      totalTokens: 405 + 330,
      inputTokens: 600,
      outputTokens: 60,
      calls: 3,
      firstDay: '2025-06-15',
      lastDay: '2025-07-01',
    });
    // Other years / other teams stay in their own buckets.
    const y2024 = readUsageCalendar(stateRoot, 'team-a', 2024);
    expect(y2024.totals.totalTokens).toBe(0);
    const b2025 = readUsageCalendar(stateRoot, 'team-b', 2025);
    expect(b2025.totals.inputTokens).toBe(999);
    expect(b2025.days).toHaveLength(365);
  });

  it('app scope counts every row; team scope filters by teamId', () => {
    seedRow({ sessionId: 'w1', seq: 1, teamId: null, roleKind: 'workspace', at: noon(2025, 6, 15), inputTokens: 900, outputTokens: 0 });
    seedRow({ sessionId: 'm1', seq: 2, teamId: 'team-a', roleKind: 'member', at: noon(2025, 6, 15), inputTokens: 100, outputTokens: 0 });
    seedRow({ sessionId: 'cap', seq: 3, teamId: 'team-a', roleKind: 'captain', at: noon(2025, 6, 15), inputTokens: 500, outputTokens: 0 });
    seedRow({ sessionId: 'cv', seq: 4, teamId: 'team-b', roleKind: 'conversation', at: noon(2025, 6, 15), inputTokens: 700, outputTokens: 0 });
    const app = readAppUsageCalendar([stateRoot], 2025);
    expect(app.totals.inputTokens).toBe(2200);
    expect(app.totals.calls).toBe(4);
    const teamA = readUsageCalendar(stateRoot, 'team-a', 2025);
    expect(teamA.totals.inputTokens).toBe(600);
    expect(teamA.totals.calls).toBe(2);
  });

  it('merges per-root calendars for the app scope', () => {
    seedRow({ sessionId: 'r1', seq: 1, teamId: null, roleKind: 'workspace', at: noon(2025, 6, 15), inputTokens: 100, outputTokens: 0 });
    const rootB = mkdtempSync(join(tmpdir(), 'eteams-usage-b-'));
    try {
      recordUsage(getDb(join(rootB, '.eteams')), {
        at: noon(2025, 6, 15),
        day: '2025-06-15',
        sessionId: 'r2',
        seq: 1,
        teamId: null,
        memberName: null,
        roleKind: 'workspace',
        provider: null,
        model: null,
        inputTokens: 40,
        outputTokens: 0,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
      });
      const app = readAppUsageCalendar([stateRoot, join(rootB, '.eteams')], 2025);
      expect(app.totals.inputTokens).toBe(140);
      expect(app.totals.calls).toBe(2);
      expect(app.days.find((d) => d.date === '2025-06-15')?.totalTokens).toBe(140);
    } finally {
      cleanupTempWorkspace(rootB);
    }
  });

  it('returns a zero-filled full-year grid for a future year (not 404)', () => {
    const year = new Date().getFullYear() + 1;
    const calendar = readUsageCalendar(stateRoot, 'team-x', year);
    expect(calendar.days).toHaveLength(daysInYear(year));
    expect(calendar.totals.totalTokens).toBe(0);
    expect(calendar.totals.firstDay).toBeNull();
  });
});

// ---------- install surface (E18 same-shape) ----------

describe('installUsageMeter', () => {
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
