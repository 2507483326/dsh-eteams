import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
import { LEADER_NAME, closeDb, dbDirOf, dbFileOf, getDb } from '../src/host/state/db';
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

// 十六轮 DA29：task 合同四数组列 → contract_md 单列（DB v1→v2）。旧库在
// getDb 首次连接时 ALTER + 按旧列数据合成回填；全新库 DDL 即新形状、迁移
// 零操作（lifecycle 的 contractMd 回读锁覆盖新库路径，这里只锁迁移）。
describe('v1→v2 task contract migration (DA29)', () => {
  const V1_TASK_DDL = `CREATE TABLE task (
    task_id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    parent_id INTEGER,
    subject TEXT NOT NULL,
    description TEXT,
    depend_tasks TEXT NOT NULL DEFAULT '[]',
    member_chain_list TEXT NOT NULL DEFAULT '[]',
    chain_cursor INTEGER NOT NULL DEFAULT -1,
    status TEXT NOT NULL DEFAULT 'draft',
    current_member TEXT,
    current_member_id INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0,
    status_note TEXT,
    acceptance TEXT,
    in_scope TEXT,
    out_of_scope TEXT,
    deliverables TEXT,
    idempotency_note TEXT,
    blocked_from TEXT,
    work_dir TEXT,
    completed_time INTEGER,
    created_time INTEGER NOT NULL,
    update_time INTEGER NOT NULL
  );`;

  it('backfills contract_md from legacy four-array columns on connect', () => {
    const legacyRoot = mkdtempSync(join(tmpdir(), 'eteams-mig-'));
    try {
      mkdirSync(dbDirOf(legacyRoot), { recursive: true });
      const legacy = new DatabaseSync(dbFileOf(legacyRoot));
      legacy.exec(V1_TASK_DDL);
      legacy
        .prepare(
          "INSERT INTO task (task_id, team_id, subject, depend_tasks, member_chain_list, " +
            "chain_cursor, status, retry_count, acceptance, in_scope, out_of_scope, deliverables, " +
            "created_time, update_time) VALUES (1, 1, '导出模块', '[]', '[]', -1, 'ready', 0, " +
            "?, ?, ?, ?, 1, 1)",
        )
        .run(
          JSON.stringify(['支持 CSV 导出', '支持 JSON 导出']),
          JSON.stringify(['src/export']),
          JSON.stringify(['导入功能']),
          JSON.stringify(['export 模块与单测']),
        );
      legacy.close();

      const db = getDb(legacyRoot);
      const row = db.prepare('SELECT contract_md FROM task WHERE task_id = 1').get() as {
        contract_md: string | null;
      };
      expect(row.contract_md).toContain('## 验收标准');
      expect(row.contract_md).toContain('1. 支持 CSV 导出');
      expect(row.contract_md).toContain('## 允许改动');
      expect(row.contract_md).toContain('## 禁止改动');
      expect(row.contract_md).toContain('## 交付物');

      // 幂等：关连接重开（迁移重入）不重复改写、不报错。
      closeDb(legacyRoot);
      const again = getDb(legacyRoot);
      const reread = again.prepare('SELECT contract_md FROM task WHERE task_id = 1').get() as {
        contract_md: string | null;
      };
      expect(reread.contract_md).toBe(row.contract_md);
      closeDb(legacyRoot);
    } finally {
      cleanupTempWorkspace(legacyRoot);
    }
  });
});

// v3 成员=角色合并（docs/27 v3）：member 表拆成 roles 角色库表 + team_members
// 班底表，旧 roles 标签登记表删除，task_members 的 role_id 死列移除。旧库在
// getDb 首次连接时单事务迁移；全新库 DDL 即新形状、迁移零操作（store 读写
// 用例覆盖新库路径，这里只锁 v2 旧库迁移）。
describe('v2→v3 member/roles consolidation migration', () => {
  // v2 DDL（与 HEAD 的 SCHEMA_SQL 同形状，字段名以迁移读取列为准）。
  const V2_ROLES_DDL = `CREATE TABLE roles (
    role_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    role_name      TEXT NOT NULL,
    persona_md     TEXT,
    description    TEXT,
    avatar         TEXT,
    source         TEXT,
    created_time   INTEGER NOT NULL,
    update_time    INTEGER NOT NULL
  );`;
  const V2_MEMBER_DDL = `CREATE TABLE member (
    member_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id          INTEGER,
    role_id          INTEGER,
    role_name        TEXT NOT NULL,
    employee_id      INTEGER,
    persona_md       TEXT,
    model            TEXT,
    reasoning_effort TEXT,
    avatar           TEXT,
    created_time     INTEGER NOT NULL,
    update_time      INTEGER NOT NULL
  );`;
  const V2_TASK_MEMBERS_DDL = `CREATE TABLE task_members (
    task_member_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id          INTEGER NOT NULL,
    main_task_id     INTEGER,
    now_task_id      INTEGER,
    name             TEXT NOT NULL,
    employee_id      INTEGER,
    main_session_id  TEXT NOT NULL DEFAULT '',
    child_session_id TEXT NOT NULL DEFAULT '',
    role_id          INTEGER,
    status           TEXT NOT NULL DEFAULT 'staged',
    persona_md       TEXT,
    model            TEXT,
    reasoning_effort TEXT,
    avatar           TEXT,
    created_time     INTEGER NOT NULL,
    update_time      INTEGER NOT NULL
  );`;
  const LEGACY_PERSONA_MD =
    '# 人设 · 张工程师\n- 角色：前端工程师\n- 简介：负责页面骨架与交互\n- 职责边界：写页面\n- 执行提示：p';

  it('moves member rows into roles + team_members on connect', () => {
    const legacyRoot = mkdtempSync(join(tmpdir(), 'eteams-mig-v3-'));
    try {
      mkdirSync(dbDirOf(legacyRoot), { recursive: true });
      const legacy = new DatabaseSync(dbFileOf(legacyRoot));
      legacy.exec(V2_ROLES_DDL);
      legacy.exec(V2_MEMBER_DDL);
      legacy.exec(V2_TASK_MEMBERS_DDL);
      // 工作区公共行（角色库本体）：工号保留、简介从手册提取。
      legacy
        .prepare(
          'INSERT INTO member (member_id, team_id, role_name, employee_id, persona_md, avatar, ' +
            'created_time, update_time) VALUES (1, NULL, ?, 7, ?, ?, 10, 11)',
        )
        .run('张工程师', LEGACY_PERSONA_MD, '{"seed":3,"salt":4}');
      // 旧 roles 标签行：与公共行不同名（role_id=1 与 member_id=1 同号起步，
      // 迁移不得撞主键），补缺成角色条目。
      legacy
        .prepare(
          "INSERT INTO roles (role_id, role_name, persona_md, source, created_time, update_time) " +
            "VALUES (1, '前端', NULL, 'user', 10, 11)",
        )
        .run();
      // 班底行 1：同名公共行已有角色行 → role_id 按名解析 + 路线搬列。
      legacy
        .prepare(
          'INSERT INTO member (member_id, team_id, role_name, employee_id, persona_md, model, ' +
            'reasoning_effort, created_time, update_time) ' +
            "VALUES (10, 1, '张工程师', 7, ?, 'deepseek-chat', 'high', 20, 21)",
        )
        .run(LEGACY_PERSONA_MD);
      // 班底行 2：无同名角色行 → 从班底行自建 roles 行。
      legacy
        .prepare(
          'INSERT INTO member (member_id, team_id, role_name, employee_id, persona_md, avatar, ' +
            'created_time, update_time) ' +
            "VALUES (11, 1, '李新员', 8, ?, NULL, 22, 23)",
        )
        .run('# 人设 · 李新员\n- 角色：测试\n- 执行提示：q');
      // task_members 旧行带 role_id 数据：移除死列后行数不丢。
      legacy
        .prepare(
          "INSERT INTO task_members (task_member_id, team_id, name, role_id, status, created_time, update_time) " +
            "VALUES (1, 1, '张工程师', 99, 'ready', 30, 31)",
        )
        .run();
      legacy.close();

      const db = getDb(legacyRoot);
      const tableNames = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
      // 旧表已删，新形状表已建。
      expect(tableNames).toContain('roles');
      expect(tableNames).toContain('team_members');
      expect(tableNames).not.toContain('member');
      expect(tableNames).not.toContain('member_legacy');
      expect(tableNames).not.toContain('roles_legacy');

      // roles：公共行工号/手册/头像原样，简介从 `- 简介：` 行提取成列。
      const zhang = db.prepare('SELECT * FROM roles WHERE role_name = ?').get('张工程师') as {
        role_id: number;
        employee_id: number | null;
        persona_md: string | null;
        profile: string | null;
        avatar: string | null;
      };
      expect(zhang.employee_id).toBe(7);
      expect(zhang.profile).toBe('负责页面骨架与交互');
      expect(zhang.persona_md).toBe(LEGACY_PERSONA_MD);
      expect(zhang.avatar).toBe('{"seed":3,"salt":4}');
      // 旧标签行补缺（发新号，不撞公共行主键）。
      const label = db.prepare('SELECT role_id FROM roles WHERE role_name = ?').get('前端') as {
        role_id: number;
      };
      expect(label.role_id).not.toBe(zhang.role_id);
      // 班底行自建角色行：工号/手册带上。
      const li = db.prepare('SELECT * FROM roles WHERE role_name = ?').get('李新员') as {
        employee_id: number | null;
        persona_md: string | null;
      };
      expect(li.employee_id).toBe(8);
      expect(li.persona_md).toContain('李新员');

      // team_members：班底行搬表，role_id 按名解析，路线列跟着走。
      const teamRows = db
        .prepare(
          'SELECT team_member_id, team_id, role_id, model, reasoning_effort FROM team_members ' +
            'WHERE team_id = 1 ORDER BY team_member_id',
        )
        .all() as Array<{
        team_member_id: number;
        team_id: number;
        role_id: number;
        model: string | null;
        reasoning_effort: string | null;
      }>;
      expect(teamRows).toHaveLength(2);
      expect(teamRows[0]).toMatchObject({ team_member_id: 10, role_id: zhang.role_id,
        model: 'deepseek-chat', reasoning_effort: 'high' });
      expect(teamRows[1]).toMatchObject({ team_member_id: 11, role_id: li.role_id,
        model: null, reasoning_effort: null });

      // task_members 的 role_id 死列已移除，行数不丢。
      const tmColumns = (
        db.prepare('PRAGMA table_info(task_members)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(tmColumns).not.toContain('role_id');
      expect((db.prepare('SELECT COUNT(*) AS n FROM task_members').get() as { n: number }).n).toBe(
        1,
      );

      // 幂等：关连接重开（迁移重入）不再改写、不报错。
      closeDb(legacyRoot);
      const again = getDb(legacyRoot);
      expect(
        (again.prepare('SELECT COUNT(*) AS n FROM roles').get() as { n: number }).n,
      ).toBe(3);
      closeDb(legacyRoot);
    } finally {
      cleanupTempWorkspace(legacyRoot);
    }
  });
});
