import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LockMap, teamLockKey } from '../src/host/state/lock';
import {
  insertEventInTx,
  lastEventSeq,
  parseJsonl,
  readEventsSync,
  recordEvent,
} from '../src/host/state/events';
import {
  atomicWriteText,
  insertTeamRow,
  readTeam,
  withTeamTx,
  writeTeam,
} from '../src/host/state/store';
import { LEADER_NAME } from '../src/host/state/db';
import { cleanupTempWorkspace } from './support/tmpWorkspace';
import type { TeamState } from '../src/host/model/types';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eteams-store-'));
});

afterEach(() => {
  // 先关 SQLite 连接（getDb 按状态根缓存，不关则 db/-wal/-shm 占住文件，
  // Windows 上 rmSync EPERM），再退避删目录——tests/support/tmpWorkspace。
  cleanupTempWorkspace(root);
});

/** 建一条团队行（team_id 由库发号），返回 team_id。 */
function seedTeamRow(name: string, hasLeader = true): number {
  let teamId = 0;
  withTeamTx(root, undefined, (tx) => {
    teamId = insertTeamRow(tx, name, hasLeader, tx.now);
  });
  return teamId;
}

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
  /** SQLite 契约的最小 TeamState：id 是库发的 team_id，无 phase/goal/version。 */
  function seedTeam(name: string, hasLeader = true): TeamState {
    const teamId = seedTeamRow(name, hasLeader);
    return {
      id: teamId,
      name,
      hasLeader,
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
          mainSessionId: 'cap-1',
          childSessionId: '',
          roleId: null,
          status: 'ready',
          createdAt: 1,
        },
      ],
      members: [],
      tasks: [
        {
          id: 1,
          subject: '映射表',
          parentId: null,
          dependencies: [],
          chain: [{ member: 'Bob', stageBrief: '产出映射表' }],
          chainCursor: 0,
          status: 'wait',
          attempts: [],
          retryCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      pendingDecisions: [],
    };
  }

  it('writeTeam persists the full snapshot（整存整取）and round-trips', async () => {
    const state = seedTeam('演示团队');
    const before = Date.now();
    await writeTeam(root, state);
    // writeTeam 落库时统一刷新 update_time（内存镜像同步回填）。
    expect(state.updatedAt).toBeGreaterThanOrEqual(before);
    const loaded = await readTeam(root, state.id);
    expect(loaded?.name).toBe('演示团队');
    expect(loaded?.hasLeader).toBe(true);
    expect(loaded?.taskMembers).toHaveLength(1);
    expect(loaded?.taskMembers[0]?.name).toBe(LEADER_NAME);
    expect(loaded?.taskMembers[0]?.status).toBe('ready');
    expect(loaded?.tasks[0]?.subject).toBe('映射表');
    expect(loaded?.tasks[0]?.status).toBe('wait');
    expect(loaded?.tasks[0]?.chain[0]?.member).toBe('Bob');
    expect(loaded?.pendingDecisions).toEqual([]);
    // 重写一次：同号覆盖（DELETE + 带原号重 INSERT），不产生重复行。
    await writeTeam(root, state);
    const again = await readTeam(root, state.id);
    expect(again?.tasks).toHaveLength(1);
    expect(again?.taskMembers).toHaveLength(1);
    expect(again?.updatedAt).toBeGreaterThanOrEqual(state.updatedAt);
  });

  it('readTeam returns undefined for missing teams', async () => {
    expect(await readTeam(root, 'nope')).toBeUndefined();
    expect(await readTeam(root, 999)).toBeUndefined();
  });

  it('insertTeamRow issues sequential team ids and keeps same-name teams distinct', async () => {
    let first = 0;
    let second = 0;
    withTeamTx(root, undefined, (tx) => {
      first = insertTeamRow(tx, '演示', true, tx.now);
      second = insertTeamRow(tx, '演示', true, tx.now);
    });
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first + 1);
    // 团队现在是行不是目录：同名各自成行，team_id 唯一即可区分。
    const byId = await readTeam(root, first);
    expect(byId?.name).toBe('演示');
    const byName = await readTeam(root, '演示');
    expect([first, second]).toContain(byName?.id);
  });
});

describe('event journal', () => {
  it('appends events with incrementing seq（全库自增 event_id）', async () => {
    const teamId = seedTeamRow('t1');
    const first = await recordEvent(root, teamId, { kind: 'captain' }, 'team.created', {
      payload: { name: 'x' },
    });
    const second = await recordEvent(root, teamId, { kind: 'system' }, 'task.created', {
      taskId: 5,
    });
    expect(second.seq).toBe(first.seq + 1);
    const events = readEventsSync(root, teamId);
    expect(events.map((e) => e.seq)).toEqual([first.seq, second.seq]);
    expect(lastEventSeq(root, teamId)).toBe(second.seq);
    expect(events[1]?.taskId).toBe(5);
    expect(events[0]?.payload).toEqual({ name: 'x' });
  });

  it('parseJsonl drops a torn tail and keeps good lines', () => {
    const good = '{"a":1}\n{"a":2}\n{"a":3';
    expect(parseJsonl(good)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseJsonl('')).toEqual([]);
  });

  it('insertEventInTx writes raw rows with an explicit seq（导入原号路径）', async () => {
    const teamId = seedTeamRow('t2');
    withTeamTx(root, teamId, (tx) => {
      insertEventInTx(tx, teamId, {
        seq: 42,
        at: 5,
        actor: { kind: 'user' },
        type: 'plan.approved',
      });
    });
    const events = readEventsSync(root, teamId);
    expect(events[0]?.type).toBe('plan.approved');
    expect(events[0]?.seq).toBe(42);
    expect(lastEventSeq(root, teamId)).toBe(42);
  });
});
