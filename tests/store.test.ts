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
          sessionId: '',
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
          // 主会话快照（task.main_session_id，v5 落列 v6 改名）：随快照整存整取。
          mainSessionId: 'cap-1',
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
    expect(loaded?.tasks[0]?.mainSessionId).toBe('cap-1');
    expect(loaded?.tasks[0]?.chain[0]?.member).toBe('Bob');
    expect(loaded?.pendingDecisions).toEqual([]);
    // 重写一次：同号覆盖（DELETE + 带原号重 INSERT），不产生重复行。
    await writeTeam(root, state);
    const again = await readTeam(root, state.id);
    expect(again?.tasks).toHaveLength(1);
    expect(again?.taskMembers).toHaveLength(1);
    expect(again?.updatedAt).toBeGreaterThanOrEqual(state.updatedAt);
  });

  it('writeTeam fills team_members mirror columns from roles（v4 副本列）', async () => {
    const state = seedTeam('镜像团队');
    state.members.push({
      memberId: 1,
      roleId: null,
      name: '王测试',
      role: '测试工程师',
      persona: {
        frameworkVersion: 1,
        role: '测试工程师',
        duty: '验证交付',
        style: '严谨',
        skills: '用例设计',
        rules: [],
        executionPrompt: 'ep',
      },
      modelRoute: { model: '' },
      avatar: { seed: 9, salt: 8 },
      createdAt: 1,
    });
    await writeTeam(root, state);
    const db = getDb(root);
    const mirror = db
      .prepare(
        'SELECT tm.role_name, tm.persona_md, tm.profile FROM team_members tm WHERE tm.team_id = ?',
      )
      .get(state.id) as {
      role_name: string | null;
      persona_md: string | null;
      profile: string | null;
    };
    expect(mirror.role_name).toBe('王测试');
    expect(mirror.persona_md).toContain('王测试');
    expect(mirror.profile).toBeNull();
    // 重写快照：同名角色行已存在时人设以角色行为准（同源语义），镜像随
    // 角色行刷新、不被内存 persona 覆盖。
    state.members[0].persona.profile = '内存里的一句话';
    await writeTeam(root, state);
    const again = db
      .prepare('SELECT tm.profile FROM team_members tm WHERE tm.team_id = ?')
      .get(state.id) as { profile: string | null };
    expect(again.profile).toBeNull();
    expect(
      (db.prepare('SELECT profile FROM roles WHERE role_name = ?').get('王测试') as {
        profile: string | null;
      }).profile,
    ).toBeNull();
  });

  it('readTeam returns undefined for missing teams', async () => {
    expect(await readTeam(root, 'nope')).toBeUndefined();
    expect(await readTeam(root, 999)).toBeUndefined();
  });

  it('insertTeamRow issues sequential team ids and keeps same-name teams distinct', async () => {
    let first = 0;
    let second = 0;
    withTeamTx(root, undefined, (tx) => {
      first = insertTeamRow(tx, '演示', true, 0, tx.now);
      second = insertTeamRow(tx, '演示', true, 0, tx.now);
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

      // roles：公共行手册/头像原样，简介从 `- 简介：` 行提取成列。v7 起
      // roles.employee_id 列保留但弃用（运行时不再读写）——迁移仍落值只是
      // 旧数据留档，真相已挪到 team_members 行自增主键（表自增即工号）。
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
      // 班底行自建角色行：手册带上；工号列弃用但旧值留档（不再当种子）。
      const li = db.prepare('SELECT * FROM roles WHERE role_name = ?').get('李新员') as {
        employee_id: number | null;
        persona_md: string | null;
      };
      expect(li.employee_id).toBe(8);
      expect(li.persona_md).toContain('李新员');

      // v7 表自增真相：班底行主键 = 工号——旧 member 行的 member_id 原号随行
      // 搬进 team_members（10/11），不再有独立工号列。
      const tmNumbers = db
        .prepare(
          'SELECT role_name, team_member_id FROM team_members ORDER BY team_member_id',
        )
        .all() as Array<{ role_name: string | null; team_member_id: number }>;
      expect(tmNumbers).toHaveLength(2);
      expect(tmNumbers[0]).toEqual({ role_name: '张工程师', team_member_id: 10 });
      expect(tmNumbers[1]).toEqual({ role_name: '李新员', team_member_id: 11 });

      // team_members：班底行搬表，role_id 按名解析，路线列跟着走；v4 副本列
      //（role_name/persona_md/profile）从 roles 回填到位。
      const teamRows = db
        .prepare(
          'SELECT team_member_id, team_id, role_id, role_name, persona_md, profile, model, ' +
            'reasoning_effort FROM team_members WHERE team_id = 1 ORDER BY team_member_id',
        )
        .all() as Array<{
        team_member_id: number;
        team_id: number;
        role_id: number;
        role_name: string | null;
        persona_md: string | null;
        profile: string | null;
        model: string | null;
        reasoning_effort: string | null;
      }>;
      expect(teamRows).toHaveLength(2);
      expect(teamRows[0]).toMatchObject({ team_member_id: 10, role_id: zhang.role_id,
        model: 'deepseek-chat', reasoning_effort: 'high' });
      expect(teamRows[1]).toMatchObject({ team_member_id: 11, role_id: li.role_id,
        model: null, reasoning_effort: null });
      expect(teamRows[0]?.role_name).toBe('张工程师');
      expect(teamRows[0]?.persona_md).toBe(LEGACY_PERSONA_MD);
      expect(teamRows[0]?.profile).toBe('负责页面骨架与交互');
      expect(teamRows[1]?.role_name).toBe('李新员');
      expect(teamRows[1]?.profile).toBeNull();

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

// getDb 首次连接时 ALTER + 从 roles 回填（v4 班底行角色信息副本）：v3 旧库
// team_members 缺 role_name/persona_md/profile 三列，补列后按角色行刷新
//（悬空 role_id 行刷成 NULL，与 loadMembers 防御性跳过同口径）；全新库 DDL
// 即新形状、只跑幂等回填兜底。
describe('v3→v4 team_members role mirror columns migration', () => {
  const V3_ROLES_DDL = `CREATE TABLE roles (
    role_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    role_name    TEXT NOT NULL,
    employee_id  INTEGER,
    persona_md   TEXT,
    profile      TEXT,
    avatar       TEXT,
    created_time INTEGER NOT NULL,
    update_time  INTEGER NOT NULL
  );`;
  const V3_TEAM_MEMBERS_DDL = `CREATE TABLE team_members (
    team_member_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id          INTEGER NOT NULL,
    role_id          INTEGER,
    model            TEXT,
    reasoning_effort TEXT,
    created_time     INTEGER NOT NULL,
    update_time      INTEGER NOT NULL
  );`;

  it('adds mirror columns to team_members and backfills from roles on connect', () => {
    const legacyRoot = mkdtempSync(join(tmpdir(), 'eteams-mig-v4-'));
    try {
      mkdirSync(dbDirOf(legacyRoot), { recursive: true });
      const legacy = new DatabaseSync(dbFileOf(legacyRoot));
      legacy.exec(V3_ROLES_DDL);
      legacy.exec(V3_TEAM_MEMBERS_DDL);
      legacy
        .prepare(
          'INSERT INTO roles (role_id, role_name, employee_id, persona_md, profile, avatar, created_time, update_time) ' +
            "VALUES (5, '张工程师', 7, '# 人设 · 张工程师', '负责页面', NULL, 10, 11)",
        )
        .run();
      // 班底行一行引用角色行、一行悬空（role_id 指向不存在的角色）。
      legacy
        .prepare(
          'INSERT INTO team_members (team_member_id, team_id, role_id, model, created_time, update_time) ' +
            'VALUES (1, 1, 5, NULL, 20, 21)',
        )
        .run();
      legacy
        .prepare(
          'INSERT INTO team_members (team_member_id, team_id, role_id, created_time, update_time) ' +
            'VALUES (2, 1, 999, 22, 23)',
        )
        .run();
      legacy.close();

      const db = getDb(legacyRoot);
      const columns = (
        db.prepare('PRAGMA table_info(team_members)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(columns).toEqual(expect.arrayContaining(['role_name', 'persona_md', 'profile']));
      // 引用行：三列从 roles 回填。
      const linked = db
        .prepare('SELECT role_name, persona_md, profile FROM team_members WHERE team_member_id = 1')
        .get() as { role_name: string | null; persona_md: string | null; profile: string | null };
      expect(linked.role_name).toBe('张工程师');
      expect(linked.persona_md).toBe('# 人设 · 张工程师');
      expect(linked.profile).toBe('负责页面');
      // 悬空行：三列刷成 NULL（与 loadMembers 防御性跳过同口径）。
      const dangling = db
        .prepare('SELECT role_name, persona_md, profile FROM team_members WHERE team_member_id = 2')
        .get() as { role_name: string | null; persona_md: string | null; profile: string | null };
      expect(dangling.role_name).toBeNull();
      expect(dangling.persona_md).toBeNull();
      expect(dangling.profile).toBeNull();

      // 幂等：重开连接只重复回填（自愈），不报错、不改行数。
      closeDb(legacyRoot);
      const again = getDb(legacyRoot);
      expect(
        (again.prepare('SELECT COUNT(*) AS n FROM team_members').get() as { n: number }).n,
      ).toBe(2);
      closeDb(legacyRoot);
    } finally {
      cleanupTempWorkspace(legacyRoot);
    }
  });
});

// getDb 首次连接时的会话列迁移链（v5 + v6，docs/51）：v4 旧库 task 缺
// session_id 列——v5 补列后按 task_members 领队行（name=项目牧羊人、
// main_task_id 为空）锚定的 main_session_id 回填（只补 NULL 行：快照语义，
// 已盖章行不随领队重锚改写）；v6 再把 session_id 改名 main_session_id、
// task_members 的 main_session_id+child_session_id 合并成 session_id（领队
// 行留自己的子代理会话，主会话锚点归任务行）；无领队行/未锚定的任务保持
// NULL；全新库 DDL 即 v6 形状、迁移零操作。
describe('v4→v5→v6 task/member session column migration', () => {
  const V4_TASK_DDL = `CREATE TABLE task (
    task_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id           INTEGER NOT NULL,
    parent_id         INTEGER,
    subject           TEXT NOT NULL,
    description       TEXT,
    depend_tasks      TEXT NOT NULL DEFAULT '[]',
    member_chain_list TEXT NOT NULL DEFAULT '[]',
    chain_cursor      INTEGER NOT NULL DEFAULT -1,
    status            TEXT NOT NULL DEFAULT 'draft',
    current_member    TEXT,
    current_member_id INTEGER,
    retry_count       INTEGER NOT NULL DEFAULT 0,
    status_note       TEXT,
    contract_md       TEXT,
    idempotency_note  TEXT,
    blocked_from      TEXT,
    work_dir          TEXT,
    completed_time    INTEGER,
    created_time      INTEGER NOT NULL,
    update_time       INTEGER NOT NULL
  );`;
  const V4_TASK_MEMBERS_DDL = `CREATE TABLE task_members (
    task_member_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id          INTEGER NOT NULL,
    main_task_id     INTEGER,
    now_task_id      INTEGER,
    name             TEXT NOT NULL,
    employee_id      INTEGER,
    main_session_id  TEXT NOT NULL DEFAULT '',
    child_session_id TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'staged',
    persona_md       TEXT,
    model            TEXT,
    reasoning_effort TEXT,
    avatar           TEXT,
    created_time     INTEGER NOT NULL,
    update_time      INTEGER NOT NULL
  );`;

  function columnNames(db: DatabaseSync, table: string): string[] {
    return (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((c) => c.name);
  }

  it('renames task session_id and merges member session columns on connect', () => {
    const legacyRoot = mkdtempSync(join(tmpdir(), 'eteams-mig-v5-'));
    try {
      mkdirSync(dbDirOf(legacyRoot), { recursive: true });
      const legacy = new DatabaseSync(dbFileOf(legacyRoot));
      legacy.exec(V4_TASK_DDL);
      legacy.exec(V4_TASK_MEMBERS_DDL);
      // 领队行：团队 1 锚 cap-old（子会话 lead-child）；团队 2 无领队行。
      legacy
        .prepare(
          'INSERT INTO task_members (task_member_id, team_id, main_task_id, name, main_session_id, child_session_id, status, created_time, update_time) ' +
            "VALUES (1, 1, NULL, '项目牧羊人', 'cap-old', 'lead-child', 'ready', 10, 11)",
        )
        .run();
      // 任务行：团队 1 一行（从领队行回填）、团队 2 一行（无领队行 → NULL）、
      // 一行迁移后手工盖章（重开回填不覆盖——快照语义）。
      const insTask = legacy.prepare(
        'INSERT INTO task (task_id, team_id, subject, status, created_time, update_time) ' +
          'VALUES (?, ?, ?, ?, 20, 21)',
      );
      insTask.run(1, 1, '回填行', 'ready');
      insTask.run(2, 2, '无领队行', 'ready');
      insTask.run(3, 1, '已盖章行', 'ready');
      legacy.close();

      const db = getDb(legacyRoot);
      // v6 终态：task 列已改名 main_session_id；task_members 只剩 session_id。
      expect(columnNames(db, 'task')).toContain('main_session_id');
      expect(columnNames(db, 'task')).not.toContain('session_id');
      expect(columnNames(db, 'task_members')).toContain('session_id');
      expect(columnNames(db, 'task_members')).not.toContain('main_session_id');
      expect(columnNames(db, 'task_members')).not.toContain('child_session_id');
      const rows = db
        .prepare('SELECT task_id, main_session_id FROM task ORDER BY task_id')
        .all() as Array<{ task_id: number; main_session_id: string | null }>;
      // v5 回填按领队行锚定，v6 原值改名（快照语义：落库后不变）。
      expect(rows[0]).toEqual({ task_id: 1, main_session_id: 'cap-old' });
      expect(rows[1]).toEqual({ task_id: 2, main_session_id: null });
      // 领队行只留自己的子代理会话（child_session_id 合并进来），主会话锚点
      // 不再落行。
      const leader = db
        .prepare('SELECT session_id FROM task_members WHERE task_member_id = 1')
        .get() as { session_id: string };
      expect(leader.session_id).toBe('lead-child');
      // 迁移后手工盖章，重开迁移不得覆盖（快照落库后不变）。
      db.prepare('UPDATE task SET main_session_id = ? WHERE task_id = 3').run('cap-mine');

      // 幂等：重开连接迁移逐步跳过，不报错、不改行数、不覆盖已盖章行。
      closeDb(legacyRoot);
      const again = getDb(legacyRoot);
      expect(
        (again.prepare('SELECT COUNT(*) AS n FROM task').get() as { n: number }).n,
      ).toBe(3);
      expect(
        (again.prepare('SELECT main_session_id FROM task WHERE task_id = 3').get() as {
          main_session_id: string | null;
        }).main_session_id,
      ).toBe('cap-mine');
      expect(
        (again.prepare('SELECT main_session_id FROM task WHERE task_id = 1').get() as {
          main_session_id: string | null;
        }).main_session_id,
      ).toBe('cap-old');
      closeDb(legacyRoot);
    } finally {
      cleanupTempWorkspace(legacyRoot);
    }
  });
});

describe('v6→v7 工牌迁移（工号=班底自增主键：副本重键/邮件分箱/链站点）', () => {
  it('re-keys replicas, mail and chains to team_member_id, backfills leader roster row and container replicas on connect', () => {
    // v6 → v7 的形状差只有 2 列（mail_messages.employee_id /
    // attempts.task_member_id）——先用当前 DDL 建全新库，再 DROP 这 2 列并把
    // 版本号降回 6，重开连接即走 v7 迁移。team / roles / team_members 三表
    // 形状 v6 与 v7 一致（表自增不加列；roles.employee_id 弃用列保留）。
    const legacyRoot = mkdtempSync(join(tmpdir(), 'eteams-mig-v7-'));
    try {
      mkdirSync(dbDirOf(legacyRoot), { recursive: true });
      getDb(legacyRoot); // 建 v7 全新库
      closeDb(legacyRoot);
      const legacy = new DatabaseSync(dbFileOf(legacyRoot));
      legacy.exec('ALTER TABLE mail_messages DROP COLUMN employee_id');
      legacy.exec('ALTER TABLE attempts DROP COLUMN task_member_id');
      legacy
        .prepare("UPDATE schema_meta SET value = '6' WHERE key = 'db_schema_version'")
        .run();
      legacy.exec('PRAGMA user_version = 6');

      // 团队 1 + 角色行（v6：工号在 roles 上——v7 起弃用，值不再被读）。
      legacy
        .prepare(
          'INSERT INTO team (team_id, team_name, has_leader, created_time, update_time) ' +
            "VALUES (1, '迁移队', 1, 10, 11)",
        )
        .run();
      const insRole = legacy.prepare(
        'INSERT INTO roles (role_id, role_name, employee_id, persona_md, created_time, update_time) ' +
          'VALUES (?, ?, ?, ?, 10, 11)',
      );
      insRole.run(1, '张三', 5, '# 人设 · 张三');
      insRole.run(2, '李四', 9, '# 人设 · 李四');
      insRole.run(3, '项目牧羊人', null, '# 人设 · 领队');
      // 班底（v6/v7 同形状）：张三同角色两行——表自增口径下行主键即工号，
      // 同名行天然各拿各号，无需去重。
      const insTm = legacy.prepare(
        'INSERT INTO team_members (team_member_id, team_id, role_id, role_name, created_time, update_time) ' +
          'VALUES (?, 1, ?, ?, 10, 11)',
      );
      insTm.run(1, 1, '张三');
      insTm.run(2, 2, '李四');
      insTm.run(3, 1, '张三');
      // task_members（v6）：领队主持行 + 团队级 staged 行（v7 删）+ 任务锚定行
      // （工号来自 roles 全局序列 → 迁移按名 join 班底重键到主键号）。
      const insRow = legacy.prepare(
        'INSERT INTO task_members (task_member_id, team_id, main_task_id, name, employee_id, session_id, status, created_time, update_time) ' +
          'VALUES (?, 1, ?, ?, ?, ?, ?, 10, 11)',
      );
      insRow.run(10, null, '项目牧羊人', null, '', 'ready');
      insRow.run(11, null, '张三', null, '', 'staged');
      insRow.run(12, 10, '张三', null, '', 'staged');
      // 存量大任务 + 名字站点执行链（幽灵不在班底 → legacy 保留）。
      legacy
        .prepare(
          'INSERT INTO task (task_id, team_id, subject, member_chain_list, status, created_time, update_time) ' +
            "VALUES (10, 1, '存量任务', ?, 'ready', 10, 11)",
        )
        .run(
          JSON.stringify([
            { member: '张三', stageBrief: '先做' },
            { member: '幽灵', stageBrief: '后做' },
          ]),
        );
      // 邮件：张三箱（换工号箱）/ 幽灵箱（解析不到，保留名字兜底）/ 领队箱（不动）。
      const insMail = legacy.prepare(
        'INSERT INTO mail_messages (team_id, message_id, box_key, from_kind, to_kind, kind, content, created_time, update_time) ' +
          "VALUES (1, ?, ?, 'captain', 'member', 'assignment', '正文', 10, 11)",
      );
      insMail.run('m1', '张三');
      insMail.run('m2', '幽灵');
      insMail.run('m3', 'captain');
      // 尝试：按 (task, 成员名) join 副本行回填 task_member_id。
      const insAttempt = legacy.prepare(
        'INSERT INTO attempts (team_id, task_id, kind, member, status, token, created_time, update_time) ' +
          "VALUES (1, 10, 'initial', ?, 'succeeded', ?, 10, 11)",
      );
      insAttempt.run('张三', 'tok-a');
      insAttempt.run('李四', 'tok-b');
      legacy.close();

      const db = getDb(legacyRoot);

      // 步骤 3（M1）：领队班底行补建——班底主键续编到 4（v6 领队不入班底）。
      const roster = db
        .prepare('SELECT team_member_id, role_name FROM team_members ORDER BY team_member_id')
        .all() as Array<{ team_member_id: number; role_name: string }>;
      expect(roster).toEqual([
        { team_member_id: 1, role_name: '张三' },
        { team_member_id: 2, role_name: '李四' },
        { team_member_id: 3, role_name: '张三' },
        { team_member_id: 4, role_name: '项目牧羊人' },
      ]);

      // 步骤 2/4/5：团队级 staged 行删除；容器任务按班底全员补副本（李四 +
      // 领队补建，张三已有锚定行跳过）；锚定行/主持行工号重键到班底主键号。
      const rows = db
        .prepare(
          'SELECT task_member_id, main_task_id, name, employee_id, status FROM task_members ORDER BY task_member_id',
        )
        .all() as Array<{
        task_member_id: number;
        main_task_id: number | null;
        name: string;
        employee_id: number | null;
        status: string;
      }>;
      expect(rows).toHaveLength(4); // 主持行 + 张三锚定副本 + 李四/领队补建副本
      expect(rows[0]).toMatchObject({
        task_member_id: 10,
        name: '项目牧羊人',
        main_task_id: null,
        employee_id: 4,
      });
      expect(rows[1]).toMatchObject({
        task_member_id: 12,
        name: '张三',
        main_task_id: 10,
        employee_id: 1,
      });
      expect(rows[2]).toMatchObject({ name: '李四', main_task_id: 10, employee_id: 2, status: 'staged' });
      expect(rows[3]).toMatchObject({
        name: '项目牧羊人',
        main_task_id: 10,
        employee_id: 4,
        status: 'staged',
      });
      const rowIdOf = (name: string) =>
        rows.find((r) => r.name === name && r.main_task_id === 10)!.task_member_id;

      // 步骤 7：邮件按号换箱（张三首行 = 主键 1）；解析不到的名字箱与领队箱原样。
      const mails = db
        .prepare('SELECT message_id, box_key, employee_id FROM mail_messages ORDER BY mail_message_id')
        .all() as Array<{ message_id: string; box_key: string; employee_id: number | null }>;
      expect(mails[0]).toEqual({ message_id: 'm1', box_key: '1', employee_id: 1 });
      expect(mails[1]).toEqual({ message_id: 'm2', box_key: '幽灵', employee_id: null });
      expect(mails[2]).toEqual({ message_id: 'm3', box_key: 'captain', employee_id: null });

      // 步骤 8：尝试按 (task, 名) join 副本行回填 task_member_id。
      const attempts = db
        .prepare('SELECT member, task_member_id FROM attempts ORDER BY attempt_id')
        .all() as Array<{ member: string; task_member_id: number | null }>;
      expect(attempts[0]).toEqual({ member: '张三', task_member_id: 12 });
      expect(attempts[1]).toEqual({ member: '李四', task_member_id: rowIdOf('李四') });

      // 步骤 9：链站点名字 → 工号（班底主键）；解析不到的站点保留名字（legacy）。
      const chain = JSON.parse(
        (db.prepare('SELECT member_chain_list FROM task WHERE task_id = 10').get() as {
          member_chain_list: string;
        }).member_chain_list,
      ) as Array<{ member: number | string }>;
      expect(chain[0]!.member).toBe(1);
      expect(chain[1]!.member).toBe('幽灵');

      // 幂等：重开连接不再动任何行（形状检测全命中 → v7 迁移跳过）。
      closeDb(legacyRoot);
      const again = getDb(legacyRoot);
      expect(
        (again.prepare('SELECT box_key FROM mail_messages WHERE message_id = \'m1\'').get() as {
          box_key: string;
        }).box_key,
      ).toBe('1');
      expect(
        (again.prepare('SELECT COUNT(*) AS n FROM task_members').get() as { n: number }).n,
      ).toBe(4);
      closeDb(legacyRoot);
    } finally {
      cleanupTempWorkspace(legacyRoot);
    }
  });
});
