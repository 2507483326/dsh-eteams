/**
 * 主对话注入角色（v12 用户迭代「system 角色」）：is_root 保留行的播种/守卫
 * /迁移与注入段过滤——播种即空 MD + 提示简介；upsert 默认拒、面板 allowRoot
 * 放行且原文逐字落库（不烘 personaToMd）；拒删；旧库 v12 迁移补列回填；
 * rootPromptSection 只对非 eteams 子代理的会话贡献 band（领队注册表/
 * task_members 副本行/构建器 childId 三路过滤），MD 空贡献 ''（空段语义）。
 *
 * @module dsh-eteams/tests/rootRole
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ETeamsConfig, type ETeamsResolvedConfig } from '../src/host/config';
import { stateRootFor } from '../src/host/runtime/base';
import { registerCaptainChild, unregisterCaptainChild } from '../src/host/runtime/captainChildRegistry';
import { markBuilderChild, reportBuildProgress } from '../src/host/runtime/roleBuilder';
import { rootPromptSection } from '../src/host/runtime/rootPrompt';
import {
  ensurePresetMembers,
  findRosterMember,
  removeRosterMember,
  ROOT_ROLE_NAME,
  upsertRosterMember,
} from '../src/host/runtime/roster';
import { closeDb, getDb } from '../src/host/state/db';
import { cleanupTempWorkspace } from './support/tmpWorkspace';

let root = '';
let config: ETeamsResolvedConfig;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eteams-rootrole-'));
  config = ETeamsConfig({}) as ETeamsResolvedConfig;
});

afterEach(() => {
  // 先关 SQLite 连接再删目录：连接按状态根字符串缓存（workspace 与其下
  // .eteams 两把键都关，见 tests/support/tmpWorkspace）。
  cleanupTempWorkspace(root);
});

/** 本套件的 SQLite 状态根（与 rootPromptSection 的推导同口径）。 */
function stateRoot(): string {
  return stateRootFor(config, root);
}

/** 主对话 scope 假件：会话代理 cwd 指向临时工作区。 */
function mainScope(id: string): unknown {
  return { id, session: { header: { cwd: root } } };
}

describe('is_root 保留角色（v12 播种与守卫）', () => {
  it('seeds the system role with empty raw MD and the hint profile', async () => {
    await ensurePresetMembers(stateRoot());
    const entry = findRosterMember(stateRoot(), ROOT_ROLE_NAME);
    expect(entry?.isRoot).toBe(true);
    expect(entry?.role).toBe('system');
    expect(entry?.personaMd).toBe('');
    expect(entry?.profile).toContain('主对话注入');
  });

  it('rejects plain upserts, allows the panel opt-in, and stores the MD verbatim', async () => {
    await ensurePresetMembers(stateRoot());
    // 对话流/构建器写路径默认拒绝（eteams_member_save 不传 allowRoot）。
    await expect(
      upsertRosterMember(stateRoot(), { name: ROOT_ROLE_NAME, role: 'system', personaMd: '# x' }),
    ).rejects.toThrow(/保留角色/);
    // 面板显式保存（POST /roster → allowRoot）：原文直存，不烘结构脚手架。
    await upsertRosterMember(
      stateRoot(),
      { name: ROOT_ROLE_NAME, role: 'system', personaMd: '# 注入规则\n- {{占位}} 原样保留' },
      { allowRoot: true },
    );
    const entry = findRosterMember(stateRoot(), ROOT_ROLE_NAME);
    expect(entry?.personaMd).toBe('# 注入规则\n- {{占位}} 原样保留');
    expect(entry?.isRoot).toBe(true);
    // 保留行不可删除。
    await expect(removeRosterMember(stateRoot(), ROOT_ROLE_NAME)).rejects.toThrow('不可删除');
  });
});

describe('v12 迁移（旧库补列回填）', () => {
  it('adds is_root to a v11-shape roles table and backfills the system row', () => {
    // 手工建 v11 形状的库（roles 无 is_root 列），插一行 system。
    mkdirSync(join(root, 'db'), { recursive: true });
    const raw = new DatabaseSync(join(root, 'db', 'eteams.db'));
    raw.exec(
      'CREATE TABLE roles (' +
        'role_id INTEGER PRIMARY KEY AUTOINCREMENT,' +
        'role_name TEXT NOT NULL,' +
        'employee_id INTEGER,' +
        'is_leader INTEGER NOT NULL DEFAULT 0,' +
        'persona_md TEXT,' +
        'profile TEXT,' +
        'avatar TEXT,' +
        'created_time INTEGER NOT NULL,' +
        'update_time INTEGER NOT NULL);',
    );
    raw.prepare(
      'INSERT INTO roles (role_name, persona_md, profile, avatar, is_leader, created_time, update_time) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('system', '', '旧简介', null, 0, 1, 1);
    raw.close();
    // getDb 跑 v12 迁移：列补上，保留名行回填 is_root=1。
    const db = getDb(root);
    const columns = (db.prepare('PRAGMA table_info(roles)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns).toContain('is_root');
    const row = db.prepare('SELECT is_root FROM roles WHERE role_name = ?').get('system') as {
      is_root: number;
    };
    expect(row.is_root).toBe(1);
    closeDb(root);
  });
});

describe('主对话注入段过滤（rootPromptSection）', () => {
  it('contributes nothing without a session scope or with the default empty MD', async () => {
    await ensurePresetMembers(stateRoot());
    expect(rootPromptSection(config, undefined)).toBe('');
    expect(rootPromptSection(config, {})).toBe('');
    // 播种的 system 行 MD 为空 → 主对话也不注入（空段语义）。
    expect(rootPromptSection(config, mainScope('main-sess'))).toBe('');
  });

  it('injects the raw MD band into a main-conversation scope, braces neutralized', async () => {
    await ensurePresetMembers(stateRoot());
    await upsertRosterMember(
      stateRoot(),
      { name: ROOT_ROLE_NAME, role: 'system', personaMd: '规则一：{{变量}} 保持全角' },
      { allowRoot: true },
    );
    const band = rootPromptSection(config, mainScope('main-sess'));
    expect(band).toContain('主对话注入');
    expect(band).toContain('「system」');
    // 手册原文进 band，且 {{}} 全角化（防宿主插值渲染器炸装配）。
    expect(band).toContain('规则一：｛｛变量｝｝ 保持全角');
    expect(band).not.toContain('{{变量}}');
  });

  it('stays silent for eteams child sessions (captain registry / task_members row / builder child)', async () => {
    const sr = stateRoot();
    await ensurePresetMembers(sr);
    await upsertRosterMember(
      sr,
      { name: ROOT_ROLE_NAME, role: 'system', personaMd: '注入内容' },
      { allowRoot: true },
    );
    // 主对话本身照常注入（对照组）。
    expect(rootPromptSection(config, mainScope('main-sess'))).not.toBe('');
    // 领队子代理（captainChildren 注册表命中）静默。
    registerCaptainChild('s-leader', 't1');
    expect(rootPromptSection(config, mainScope('s-leader'))).toBe('');
    unregisterCaptainChild('s-leader');
    // 成员/领队副本行（task_members.session_id 持久命中）静默。
    const db = getDb(sr);
    db.prepare(
      'INSERT INTO task_members (team_id, name, session_id, status, created_time, update_time) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    ).run(1, 'Alice', 's-member', 'ready', 1, 1);
    expect(rootPromptSection(config, mainScope('s-member'))).toBe('');
    // 构建器子代理（rolebuilder.json 的 builderChildId）静默。
    await reportBuildProgress(sr, { request: '建角色', step: '收到需求' });
    await markBuilderChild(sr, 's-builder');
    expect(rootPromptSection(config, mainScope('s-builder'))).toBe('');
  });
});
