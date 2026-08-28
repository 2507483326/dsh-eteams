/**
 * Team state store (docs/09): directory layout, atomic writes with the
 * Windows rename-retry protocol, snapshot read/write, and discovery.
 * Pure Node — no cordis — so the verify script can drive it headless.
 *
 * @module dsh-eteams/state/store
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizeKey } from '../model/taskMachine.js';
import { SCHEMA_VERSION } from '../model/types.js';
import type { TeamState } from '../model/types.js';

/** Windows rename hazards that trigger the retry-then-degrade protocol. */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);

let tmpSeq = 0;

/**
 * Atomic text write (docs/09.2): same-directory temp file + rename; on the
 * documented Windows hazards retry ≤3× (50ms) then degrade to a direct
 * overwrite. A total failure throws and the caller rolls back in memory.
 */
export async function atomicWriteText(file: string, content: string): Promise<void> {
  const dir = join(file, '..');
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${file.slice(dir.length + 1)}.${process.pid}.${++tmpSeq}.tmp`);
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await writeFile(tmp, content, 'utf8');
      await rename(tmp, file);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException)?.code ?? '';
      if (!RENAME_RETRY_CODES.has(code)) throw error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      // Retries exhausted (docs/09.2): degrade to a direct overwrite, the
      // same strategy as the reference implementation.
      await writeFile(file, content, 'utf8');
      await rm(tmp, { force: true });
      return;
    }
  }
  throw lastError;
}

/** Absolute team directory for a state root. */
export function teamDir(stateRoot: string, teamId: string): string {
  return join(stateRoot, teamId);
}

/** Absolute snapshot path. */
export function snapshotFile(stateRoot: string, teamId: string): string {
  return join(teamDir(stateRoot, teamId), 'team.json');
}

/** Absolute events log path. */
export function eventsFile(stateRoot: string, teamId: string): string {
  return join(teamDir(stateRoot, teamId), 'events.jsonl');
}

/** Absolute mailbox path for one inbox key (`captain` or member key). */
export function inboxFile(stateRoot: string, teamId: string, box: string): string {
  return join(teamDir(stateRoot, teamId), 'inbox', `${sanitizeKey(box)}.jsonl`);
}

/** Serialize a snapshot to its on-disk JSON form. */
export function serializeTeam(state: TeamState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * Persist the full snapshot atomically and bump `updatedAt`/`version`.
 * Callers already inside `withTeamLock` invoke this as the transaction tail.
 */
export async function writeTeam(stateRoot: string, state: TeamState): Promise<void> {
  state.version += 1;
  state.updatedAt = Date.now();
  state.schemaVersion = SCHEMA_VERSION;
  await atomicWriteText(snapshotFile(stateRoot, state.id), serializeTeam(state));
}

/**
 * Read one team snapshot; `undefined` when the directory does not exist.
 * A parse failure surfaces to the caller (corruption handling lands with
 * recovery, docs/09.7).
 */
export async function readTeam(stateRoot: string, teamId: string): Promise<TeamState | undefined> {
  const file = snapshotFile(stateRoot, teamId);
  if (!existsSync(file)) return undefined;
  const raw = await readFile(file, 'utf8');
  return JSON.parse(raw) as TeamState;
}

/** Synchronous read used inside continuable setup hooks (must not await). */
export function readTeamSync(stateRoot: string, teamId: string): TeamState | undefined {
  const file = snapshotFile(stateRoot, teamId);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as TeamState;
  } catch {
    return undefined;
  }
}

/** All team ids present under the state root (unsorted). */
export async function listTeamIds(stateRoot: string): Promise<string[]> {
  if (!existsSync(stateRoot)) return [];
  const entries = await readdir(stateRoot, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && e.name !== 'archive' && e.name !== 'corrupt').map((e) => e.name);
}

/** Load every non-archived team snapshot (UI listing, M4+). */
export async function listTeams(stateRoot: string): Promise<TeamState[]> {
  const ids = await listTeamIds(stateRoot);
  const teams: TeamState[] = [];
  for (const id of ids) {
    const team = await readTeam(stateRoot, id);
    if (team !== undefined) teams.push(team);
  }
  return teams;
}

/** The team currently led by one captain session, if any. */
export async function findTeamByCaptain(stateRoot: string, captainSessionId: string): Promise<TeamState | undefined> {
  const teams = await listTeams(stateRoot);
  return teams.find((t) => t.captainSessionId === captainSessionId && t.phase !== 'completed');
}

/**
 * Create a fresh TeamState with a unique directory id. Caller picks the
 * display name; the id is `sanitizeKey(name)` disambiguated with `-2`, `-3`…
 */
export async function allocateTeamDir(stateRoot: string, name: string): Promise<string> {
  const base = sanitizeKey(name);
  let id = base;
  for (let n = 2; existsSync(join(stateRoot, id)); n++) {
    id = `${base}-${n}`;
  }
  await mkdir(join(stateRoot, id, 'inbox'), { recursive: true });
  return id;
}
