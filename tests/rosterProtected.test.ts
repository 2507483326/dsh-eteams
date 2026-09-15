/**
 * Roster protection (docs/13.8.2, 用户反馈): the leader (团队领队) and the
 * role builder (角色构建师) are system members — deletion is rejected, and
 * the role builder sits right under the leader in the panel order (client
 * memberRank mirrors this).
 *
 * @module dsh-eteams/tests/rosterProtected
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  avatarSeedFor,
  ensurePresetMembers,
  LEADER_NAME,
  readRoster,
  removeRosterMember,
  ROLE_BUILDER_NAME,
  upsertRosterMember,
} from '../src/host/runtime/roster.js';
import { LEADER_NAME, closeDb, getDb } from '../src/host/state/db';
import { readTeamSync, withTeamTx, writeTeamInTx } from '../src/host/state/store';
import { cleanupTempWorkspace } from './support/tmpWorkspace';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eteams-roster-'));
});

afterEach(() => {
  cleanupTempWorkspace(root);
});

describe('protected system members', () => {
  it('seeds both the leader and the role builder', async () => {
    await ensurePresetMembers(root);
    const names = readRoster(root).map((m) => m.name);
    expect(names).toContain(LEADER_NAME);
    expect(names).toContain(ROLE_BUILDER_NAME);
  });

  it('rejects deleting the leader and the role builder', async () => {
    await ensurePresetMembers(root);
    await expect(removeRosterMember(root, LEADER_NAME)).rejects.toThrow('不可删除');
    await expect(removeRosterMember(root, ROLE_BUILDER_NAME)).rejects.toThrow('不可删除');
    // both still present afterwards
    const names = readRoster(root).map((m) => m.name);
    expect(names).toContain(LEADER_NAME);
    expect(names).toContain(ROLE_BUILDER_NAME);
  });

  it('still deletes ordinary members and still allows builder edits', async () => {
    await ensurePresetMembers(root);
    await upsertRosterMember(root, { name: '临时成员', role: 'tester' });
    await removeRosterMember(root, '临时成员');
    expect(readRoster(root).map((m) => m.name)).not.toContain('临时成员');
    // The role builder's handbook is editable (upsert allowed, delete not).
    const stored = await upsertRosterMember(root, {
      name: ROLE_BUILDER_NAME,
      role: '角色构建师',
      personaMd: '# 自定义手册',
    });
    expect(stored.personaMd).toBe('# 自定义手册');
  });

  it('角色修改保存后按 role_id 同步 team_members 副本列（含头像，v10）', async () => {
    await ensurePresetMembers(root);
    await upsertRosterMember(root, { name: '临时成员', role: 'tester' });
    const db = getDb(root);
    // 模拟一条班底引用行（角色修改保存 → 引用它的班底行镜像全量刷新；
    // 用户迭代 2026-09-10 起删除角色不再被引用行挡下——本测只覆盖保存路径）。
    const roleId = (
      db.prepare('SELECT role_id FROM roles WHERE role_name = ?').get('临时成员') as {
        role_id: number;
      }
    ).role_id;
    db.prepare(
      'INSERT INTO team_members (team_member_id, team_id, role_id, created_time, update_time) ' +
        'VALUES (11, 1, ?, 1, 1)',
    ).run(roleId);
    // 角色修改保存（改头像+简介）→ 引用它的班底行镜像全量刷新。
    await upsertRosterMember(root, {
      name: '临时成员',
      role: 'tester',
      profile: '新简介',
      avatar: { seed: 5, salt: 6 },
    });
    const mirror = db
      .prepare('SELECT role_name, profile, avatar FROM team_members WHERE team_member_id = 11')
      .get() as { role_name: string | null; profile: string | null; avatar: string | null };
    expect(mirror.role_name).toBe('临时成员');
    expect(mirror.profile).toBe('新简介');
    expect(mirror.avatar).toBe(JSON.stringify({ seed: 5, salt: 6 }));
    closeDb(root);
  });

  it('edits the leader only through the explicit panel opt-in（用户迭代 2026-09-03）', async () => {
    await ensurePresetMembers(root);
    // 默认（对话流/构建器写路径）依旧拒绝。
    await expect(upsertRosterMember(root, { name: LEADER_NAME, role: 'x' })).rejects.toThrow(
      /保留名/,
    );
    // 面板显式保存（POST /roster → allowLeader）放行：手册与头像可改，
    // 工号等既有字段保留。
    const stored = await upsertRosterMember(
      root,
      { name: LEADER_NAME, role: '领队', personaMd: '# 领队手册（面板编辑）' },
      { allowLeader: true },
    );
    expect(stored.personaMd).toBe('# 领队手册（面板编辑）');
    const entry = readRoster(root).find((m) => m.name === LEADER_NAME);
    expect(entry?.personaMd).toBe('# 领队手册（面板编辑）');
    // 未传 avatar 沿用预设脸（seed = hashName(领队名)，salt 固定 7）——
    // 落库（avatar 列 JSON）后读回应原样保留。
    expect(stored.avatar).toEqual({ seed: avatarSeedFor(LEADER_NAME), salt: 7 });
    expect(entry?.avatar).toEqual({ seed: avatarSeedFor(LEADER_NAME), salt: 7 });
  });

  it('角色删除与团队不挂钩（用户迭代 2026-09-10）：班底引用行冻结存活', async () => {
    await ensurePresetMembers(root);
    await upsertRosterMember(root, { name: '在团角色', role: 'engineer', profile: '简介A' });
    const db = getDb(root);
    // 建一个团队 + 一条引用该角色的班底行（副本列手工同步好，模拟正常写路径）。
    db.prepare(
      "INSERT INTO team (team_name, has_leader, created_time, update_time) VALUES ('甲队', 1, 1, 1)",
    ).run();
    const roleId = (
      db.prepare('SELECT role_id FROM roles WHERE role_name = ?').get('在团角色') as {
        role_id: number;
      }
    ).role_id;
    db.prepare(
      'INSERT INTO team_members (team_member_id, team_id, role_id, role_name, persona_md, created_time, update_time) ' +
        'VALUES (21, 1, ?, ?, ?, 1, 1)',
    ).run(roleId, '在团角色', '- 角色：engineer');
    // 删除角色：不再被「仍在团队班底中」挡下。
    await removeRosterMember(root, '在团角色');
    expect(readRoster(root).map((m) => m.name)).not.toContain('在团角色');
    // 班底行按冻结副本装回（工牌跟人走），人设拷贝仍在。
    const team = readTeamSync(root, 1);
    expect(team?.members.map((m) => m.name)).toEqual(['在团角色']);
    expect(team?.members[0]?.role).toBe('engineer');
    // 快照重写不回建角色行（删除保持生效），人设跨重写不丢。
    withTeamTx(root, 1, (tx) => {
      writeTeamInTx(tx, team!);
    });
    expect(readRoster(root).some((m) => m.name === '在团角色')).toBe(false);
    const team2 = readTeamSync(root, 1);
    expect(team2?.members.map((m) => m.name)).toEqual(['在团角色']);
    expect(team2?.members[0]?.role).toBe('engineer');
    closeDb(root);
  });
});
