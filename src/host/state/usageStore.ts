/**
 * Daily token usage persistence (docs/40): two tables in eteams.db —
 * usage_detail (one row per usage-bearing model reply step) and
 * usage_daily_total (one row per day, app-wide). The DB is the sole storage
 * for metering (2026-09-05 user iteration: no file ledger, no reconciliation,
 * no strong consistency). Write = one transaction: a detail INSERT plus a
 * day-total increment upsert. Reads return the zero-filled year grid for
 * both scopes: app scope reads usage_daily_total directly (merged across
 * roots by the caller), team scope aggregates usage_detail from
 * usage_detail. Finer slices (member/session/model) re-derive from
 * usage_detail by GROUP BY.
 *
 * @module dsh-eteams/state/usageStore
 */
import type { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------

/** Five-level attribution role (matches the attribution priority table). */
export type UsageRoleKind = 'captain' | 'captain-child' | 'member' | 'conversation' | 'workspace';

/**
 * One usage-bearing model reply step (one usage_detail row; `day` is the
 * host-local calendar day snapshotted at record time).
 */
export interface UsageRecord {
  /** event.time (Unix ms). */
  readonly at: number;
  readonly day: string;
  readonly sessionId: string;
  readonly seq: number;
  /** Attribution snapshot; null = workspace bucket (plain conversations,
   * one-shot build subagents). */
  readonly teamId: string | null;
  /** Attribution snapshot; null for non-members. */
  readonly memberName: string | null;
  readonly roleKind: UsageRoleKind;
  /** Route snapshot (request/header + request/context folded per session). */
  readonly provider: string | null;
  readonly model: string | null;
  /** Billed input (excludes cache reads). */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** null = not reported by the adapter. */
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  /** Reasoning tokens; NOT part of totalTokens. */
  readonly reasoningTokens: number | null;
}

/** One aggregated calendar day (calls = detail row count). */
export interface UsageDayAgg {
  readonly date: string;
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly calls: number;
}
// ---------------------------------------------------------------------
// Year totals + write path
// ---------------------------------------------------------------------

/** Year totals (firstDay/lastDay = first/last day with data; null when none). */
export interface UsageTotals {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly calls: number;
  readonly firstDay: string | null;
  readonly lastDay: string | null;
}

/** Accumulation cell for the zero-filled year grid. */
interface MutableUsageDay {
  date: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  calls: number;
}

// ---------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------

/** Shared statement bodies (one detail INSERT + one day-total upsert). */
const DETAIL_INSERT_SQL =
  'INSERT INTO usage_detail (' +
  'day, event_time, session_id, seq, team_key, member_name, role_kind, ' +
  'provider, model, input_tokens, output_tokens, cache_read_tokens, ' +
  'cache_write_tokens, reasoning_tokens, total_tokens, created_time, update_time' +
  ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

const DAY_TOTAL_UPSERT_SQL =
  'INSERT INTO usage_daily_total (' +
  'day, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ' +
  'reasoning_tokens, total_tokens, calls, created_time, update_time' +
  ') VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?) ' +
  'ON CONFLICT(day) DO UPDATE SET ' +
  'input_tokens = input_tokens + excluded.input_tokens, ' +
  'output_tokens = output_tokens + excluded.output_tokens, ' +
  'cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens, ' +
  'cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens, ' +
  'reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens, ' +
  'total_tokens = total_tokens + excluded.total_tokens, ' +
  'calls = calls + 1, ' +
  'update_time = excluded.update_time';

/** Non-transactional row write (the body of recordUsage). */
function writeUsageRow(db: DatabaseSync, row: UsageRecord): void {
  const now = Date.now();
  const total =
    row.inputTokens + row.outputTokens + (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0);
  db.prepare(DETAIL_INSERT_SQL).run(
    row.day,
    row.at,
    row.sessionId,
    row.seq,
    row.teamId,
    row.memberName,
    row.roleKind,
    row.provider,
    row.model,
    row.inputTokens,
    row.outputTokens,
    row.cacheReadTokens,
    row.cacheWriteTokens,
    row.reasoningTokens,
    total,
    now,
    now,
  );
  db.prepare(DAY_TOTAL_UPSERT_SQL).run(
    row.day,
    row.inputTokens,
    row.outputTokens,
    row.cacheReadTokens ?? 0,
    row.cacheWriteTokens ?? 0,
    row.reasoningTokens ?? 0,
    total,
    now,
    now,
  );
}

/**
 * Persist one usage row: detail INSERT + day-total increment upsert in a
 * single immediate transaction. No dedup - cordis delivers each committed
 * event once per listener; the feature explicitly accepts eventual
 * consistency (docs/40). Throws on DB errors (the caller swallows + warns).
 */
export function recordUsage(db: DatabaseSync, row: UsageRecord): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    writeUsageRow(db, row);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// ---------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------

/** Build the zero-filled full-year grid (Jan 1 .. Dec 31). */
function zeroFilledYear(year: number): Map<string, MutableUsageDay> {
  const acc = new Map<string, MutableUsageDay>();
  for (let month = 0; month < 12; month += 1) {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${year}-${pad2(month + 1)}-${pad2(day)}`;
      acc.set(date, {
        date,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        calls: 0,
      });
    }
  }
  return acc;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Accumulate one query row into its grid cell (defensive skip on bad day). */
function accumulateCell(
  acc: Map<string, MutableUsageDay>,
  day: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  reasoningTokens: number,
  totalTokens: number,
  calls: number,
): void {
  const cell = acc.get(day);
  if (cell === undefined) return; // out-of-range/malformed day: drop
  cell.totalTokens += totalTokens;
  cell.inputTokens += inputTokens;
  cell.outputTokens += outputTokens;
  cell.cacheReadTokens += cacheReadTokens;
  cell.cacheWriteTokens += cacheWriteTokens;
  cell.reasoningTokens += reasoningTokens;
  cell.calls += calls;
}

/** Sort the grid into days and assemble year totals. */
function freezeGrid(acc: Map<string, MutableUsageDay>): {
  days: UsageDayAgg[];
  totals: UsageTotals;
} {
  const days = [...acc.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const totals = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    calls: 0,
    firstDay: null as string | null,
    lastDay: null as string | null,
  };
  for (const day of days) {
    totals.totalTokens += day.totalTokens;
    totals.inputTokens += day.inputTokens;
    totals.outputTokens += day.outputTokens;
    totals.cacheReadTokens += day.cacheReadTokens;
    totals.cacheWriteTokens += day.cacheWriteTokens;
    totals.reasoningTokens += day.reasoningTokens;
    totals.calls += day.calls;
    if (day.totalTokens > 0) {
      if (totals.firstDay === null) totals.firstDay = day.date;
      totals.lastDay = day.date;
    }
  }
  return { days, totals };
}

/** Shared query-row shape for both scopes. */
interface UsageDayRow {
  day: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  calls: number;
}

/**
 * Zero-filled year grid for one scope: app scope (no teamId) reads
 * usage_daily_total directly; team scope aggregates usage_detail by team_key
 * (exact GROUP BY on the detail table).
 */
export function readUsageDays(
  db: DatabaseSync,
  year: number,
  opts: { teamId?: string } = {},
): { days: UsageDayAgg[]; totals: UsageTotals } {
  const acc = zeroFilledYear(year);
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const rows: Array<UsageDayRow> =
    opts.teamId === undefined
      ? (db
          .prepare(
            'SELECT day, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ' +
              'reasoning_tokens, total_tokens, calls FROM usage_daily_total ' +
              'WHERE day >= ? AND day <= ? ORDER BY day',
          )
          .all(from, to) as unknown as Array<UsageDayRow>)
      : (db
          .prepare(
            'SELECT day, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, ' +
              'SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens, ' +
              'SUM(COALESCE(cache_write_tokens, 0)) AS cache_write_tokens, ' +
              'SUM(COALESCE(reasoning_tokens, 0)) AS reasoning_tokens, ' +
              'SUM(total_tokens) AS total_tokens, COUNT(*) AS calls ' +
              'FROM usage_detail WHERE team_key = ? AND day >= ? AND day <= ? GROUP BY day',
          )
          .all(opts.teamId, from, to) as unknown as Array<UsageDayRow>);
  for (const r of rows) {
    accumulateCell(
      acc,
      r.day,
      r.input_tokens,
      r.output_tokens,
      r.cache_read_tokens,
      r.cache_write_tokens,
      r.reasoning_tokens,
      r.total_tokens,
      r.calls,
    );
  }
  return freezeGrid(acc);
}

/**
 * Merge per-root calendars for the app scope (every part shares the same
 * zero-filled year grid): add cells and totals, firstDay/lastDay min/max.
 */
export function mergeUsageCalendars(
  parts: ReadonlyArray<{ days: UsageDayAgg[]; totals: UsageTotals }>,
): { days: UsageDayAgg[]; totals: UsageTotals } {
  const days = new Map<string, MutableUsageDay>();
  const totals = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    calls: 0,
    firstDay: null as string | null,
    lastDay: null as string | null,
  };
  for (const part of parts) {
    for (const day of part.days) {
      const cell = days.get(day.date) ?? {
        date: day.date,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        calls: 0,
      };
      cell.totalTokens += day.totalTokens;
      cell.inputTokens += day.inputTokens;
      cell.outputTokens += day.outputTokens;
      cell.cacheReadTokens += day.cacheReadTokens;
      cell.cacheWriteTokens += day.cacheWriteTokens;
      cell.reasoningTokens += day.reasoningTokens;
      cell.calls += day.calls;
      days.set(day.date, cell);
    }
    totals.totalTokens += part.totals.totalTokens;
    totals.inputTokens += part.totals.inputTokens;
    totals.outputTokens += part.totals.outputTokens;
    totals.cacheReadTokens += part.totals.cacheReadTokens;
    totals.cacheWriteTokens += part.totals.cacheWriteTokens;
    totals.reasoningTokens += part.totals.reasoningTokens;
    totals.calls += part.totals.calls;
    if (
      part.totals.firstDay !== null &&
      (totals.firstDay === null || part.totals.firstDay < totals.firstDay)
    ) {
      totals.firstDay = part.totals.firstDay;
    }
    if (
      part.totals.lastDay !== null &&
      (totals.lastDay === null || part.totals.lastDay > totals.lastDay)
    ) {
      totals.lastDay = part.totals.lastDay;
    }
  }
  const mergedDays = [...days.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  return { days: mergedDays, totals };
}
