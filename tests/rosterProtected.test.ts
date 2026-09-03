/**
 * Roster protection (docs/13.8.2, 用户反馈): the leader (项目牧羊人) and the
 * role builder (角色构建师) are system members — deletion is rejected, and
 * the role builder sits right under the leader in the panel order (client
 * memberRank mirrors this).
 *
 * @module dsh-eteams/tests/rosterProtected
 */
import { mkdtempSync, rmSync } from 'node:fs';
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

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eteams-roster-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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
    // 未传 avatar 沿用预设脸（seed = hashName(领队名)，salt 固定 7）。
    expect(entry?.avatar).toEqual({ seed: avatarSeedFor(LEADER_NAME), salt: 7 });
  });
});
