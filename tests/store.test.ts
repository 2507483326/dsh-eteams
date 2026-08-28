import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LockMap, teamLockKey } from '../src/host/state/lock';
import {
  appendEvent,
  lastEventSeq,
  parseJsonl,
  readEventsSync,
  recordEvent,
} from '../src/host/state/events';
import {
  allocateTeamDir,
  atomicWriteText,
  readTeam,
  snapshotFile,
  writeTeam,
} from '../src/host/state/store';
import type { TeamState } from '../src/host/model/types';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eteams-store-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('atomicWriteText', () => {
  it('writes and overwrites atomically', async () => {
    const file = join(root, 'nested', 'data.json');
    await atomicWriteText(file, 'one\n');
    expect(readFileSync(file, 'utf8')).toBe('one\n');
    await atomicWriteText(file, 'two\n');
    expect(readFileSync(file, 'utf8')).toBe('two\n');
    expect(existsSync(join(root, 'nested'))).toBe(true);
  });

  it('leaves no temp files behind', async () => {
    const file = join(root, 'x.txt');
    await atomicWriteText(file, 'body');
    const dir = join(root);
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('LockMap', () => {
  it('serializes concurrent critical sections FIFO', async () => {
    const locks = new LockMap();
    const order: string[] = [];
    const run = (name: string, delay: number) =>
      locks.withLock('k', async () => {
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, delay));
        order.push(`${name}:end`);
      });
    await Promise.all([run('a', 30), run('b', 1), run('c', 1)]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('a throwing section does not poison the chain', async () => {
    const locks = new LockMap();
    await expect(
      locks.withLock('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const result = await locks.withLock('k', async () => 'ok');
    expect(result).toBe('ok');
  });

  it('teamLockKey formats the documented key', () => {
    expect(teamLockKey('C:/ws/.eteams', 'demo')).toBe('team:C:/ws/.eteams:demo');
  });
});

describe('team snapshots', () => {
  const base: TeamState = {
    schemaVersion: 2,
    id: 'demo',
    name: '演示团队',
    goal: '目标',
    captainSessionId: 's-1',
    phase: 'staged',
    createdAt: 1,
    updatedAt: 1,
    version: 0,
    taskSeq: 0,
    attemptSeq: 0,
    mailSeq: 0,
    maxRetries: 3,
    members: [],
    tasks: [],
    pendingDecisions: [],
  };

  it('writeTeam bumps version + updatedAt and round-trips', async () => {
    await writeTeam(root, base);
    const loaded = await readTeam(root, 'demo');
    expect(loaded?.version).toBe(1);
    expect(loaded?.schemaVersion).toBe(2);
    expect(loaded?.name).toBe('演示团队');
  });

  it('readTeam returns undefined for missing teams', async () => {
    expect(await readTeam(root, 'nope')).toBeUndefined();
  });

  it('allocateTeamDir disambiguates collisions', async () => {
    const first = await allocateTeamDir(root, '演示');
    writeFileSync(snapshotFile(root, first), 'x');
    const second = await allocateTeamDir(root, '演示');
    expect(first).toBe('演示');
    expect(second).toBe('演示-2');
    expect(existsSync(join(root, first, 'inbox'))).toBe(true);
  });
});

describe('event journal', () => {
  it('appends events with incrementing seq', async () => {
    await mkdirSync(join(root, 't1'), { recursive: true });
    await recordEvent(root, 't1', { kind: 'captain' }, 'team.created', { payload: { name: 'x' } });
    await recordEvent(root, 't1', { kind: 'system' }, 'task.created', { taskId: 't1' });
    const events = readEventsSync(root, 't1');
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(lastEventSeq(root, 't1')).toBe(2);
    expect(events[1]?.taskId).toBe('t1');
  });

  it('parseJsonl drops a torn tail and keeps good lines', () => {
    const good = '{"a":1}\n{"a":2}\n{"a":3';
    expect(parseJsonl(good)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseJsonl('')).toEqual([]);
  });

  it('appendEvent writes raw rows', async () => {
    await mkdirSync(join(root, 't2'), { recursive: true });
    await appendEvent(root, 't2', {
      seq: 1,
      at: 5,
      actor: { kind: 'user' },
      type: 'plan.approved',
    });
    const events = readEventsSync(root, 't2');
    expect(events[0]?.type).toBe('plan.approved');
  });
});
