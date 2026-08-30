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
});
