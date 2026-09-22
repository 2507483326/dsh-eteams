/**
 * 常驻角色段分流（用户 2026-09-18「为什么不是领队的成员也出现这个系统提示词？
 * 应该为成员构筑专属的提示词」；用户 2026-09-22「为什么角色构建的文本会出现在领队
 * 中？」）：order 105/106 都是静态字符串时口径被注入到每个 agent；本测试钉住分流
 * ——主对话=领队段+构建师段、成员面=成员段（构建师段静默）、领队/构建师子代理静默。
 * 另钉**结构兜底**（用户 2026-09-22「领队的文本出现在了子成员中」）：身份登记还没
 * 跟上的 spawn 窗口里，子代理会话头（origin/delegationDepth）也足以让主对话段不发。
 *
 * @module dsh-eteams/tests/standingSection
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ETeamsResolvedConfig } from '../src/host/config';
import { CAPTAIN_SECTION_SHORT } from '../src/host/prompts/system/captain';
import { MEMBER_SECTION_SHORT } from '../src/host/prompts/system/member';
import { ROLE_BUILDER_SECTION } from '../src/host/prompts/system/roleBuilder';
import { joinPath } from '../src/host/runtime/base';
import {
  registerCaptainChild,
  unregisterCaptainChild,
} from '../src/host/runtime/captainChildRegistry';
import { markBuilderChild, reportBuildProgress } from '../src/host/runtime/roleBuilder';
import { clearSessionPersona, setSessionPersona } from '../src/host/runtime/sessionPersona';
import { roleBuilderSection, standingSection } from '../src/host/runtime/standingSection';
import { registerMemberSession, resetUsageMeterForTests } from '../src/host/runtime/usage';
import { getDb } from '../src/host/state/db';
import { cleanupTempWorkspace } from './support/tmpWorkspace';

let ws: string;
let root: string;
const config = { stateDir: '.eteams' } as ETeamsResolvedConfig;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'eteams-standing-'));
  // 状态根与 runtime 同口径（base.ts joinPath 的「/」拼法）——getDb 按它缓存连接。
  root = joinPath(ws, '.eteams');
  resetUsageMeterForTests();
});

afterEach(() => {
  resetUsageMeterForTests();
  clearSessionPersona('s-persona');
  unregisterCaptainChild('s-captain-child');
  cleanupTempWorkspace(ws);
});

/** 装配 scope（宿主同一口径：scope 即 agent，id 即会话 id）。 */
function scope(id: string): { id: string; session: { header: { cwd: string } } } {
  return { id, session: { header: { cwd: ws } } };
}

/** 落一条任务成员副本行（注入分流的持久判据）。 */
function insertReplicaRow(sessionId: string, isLeader: 0 | 1): void {
  getDb(root)
    .prepare(
      'INSERT INTO task_members (team_id, name, session_id, is_leader, created_time, update_time) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(1, isLeader === 1 ? '团队领队' : '甲', sessionId, isLeader, 1, 1);
}

describe('standingSection 分流', () => {
  it('无会话作用域不贡献文本（空段语义）', () => {
    expect(standingSection(config, undefined)).toBe('');
    expect(standingSection(config, null)).toBe('');
    expect(standingSection(config, {})).toBe('');
  });

  it('主对话拿领队段', () => {
    expect(standingSection(config, scope('s-main'))).toBe(CAPTAIN_SECTION_SHORT);
  });

  it('成员子代理（注册表）拿成员段，且不再出现领队口径', () => {
    registerMemberSession('s-member', {
      teamId: '1',
      memberName: '甲',
      parentSessionId: 's-main',
    });
    const section = standingSection(config, scope('s-member'));
    expect(section).toBe(MEMBER_SECTION_SHORT);
    expect(section).toContain('团队（eteams）· 成员');
    expect(section).not.toContain('你是领队');
    expect(section).not.toContain('eteams_dispatch_captain');
  });

  it('成员副本行（冷恢复兜底）也拿成员段', () => {
    insertReplicaRow('s-member-row', 0);
    expect(standingSection(config, scope('s-member-row'))).toBe(MEMBER_SECTION_SHORT);
  });

  it('领队副本行静默（领队常驻面由人格段负责）', () => {
    insertReplicaRow('s-leader-row', 1);
    expect(standingSection(config, scope('s-leader-row'))).toBe('');
  });

  it('领队子代理静默（转交指引对它不可见且本就错）', () => {
    registerCaptainChild('s-captain-child', '1');
    expect(standingSection(config, scope('s-captain-child'))).toBe('');
  });

  it('构建师子代理静默（人格段自带构建纪律）', async () => {
    await reportBuildProgress(root, { request: 'r' });
    await markBuilderChild(root, 's-builder');
    expect(standingSection(config, scope('s-builder'))).toBe('');
  });

  it('被成员人设接管的会话拿成员段（不给矛盾的领队段）', () => {
    setSessionPersona('s-persona', { name: '研究员', role: 'researcher' });
    expect(standingSection(config, scope('s-persona'))).toBe(MEMBER_SECTION_SHORT);
  });
});

/** 装配 scope 带子代理会话头（宿主建子代理会话时写 origin/delegationDepth）。 */
function subagentScope(
  id: string,
  header: { origin?: string; delegationDepth?: number },
): { id: string; session: { header: Record<string, unknown> } } {
  return { id, session: { header: { cwd: ws, parentSession: 's-main', ...header } } };
}

describe('子代理结构兜底（用户 2026-09-22「领队的文本出现在了子成员中」）', () => {
  it('身份还没登记的子代理：主对话的领队段/构建师段一律不发', () => {
    for (const header of [{ origin: 'subagent' }, { delegationDepth: 1 }]) {
      const child = subagentScope('s-unregistered-child', header);
      expect(standingSection(config, child)).toBe('');
      expect(roleBuilderSection(config, child)).toBe('');
    }
  });

  it('成员子代理首轮装配（结构头在、注册表也在）拿成员段而不是领队段', () => {
    registerMemberSession('s-member-first', {
      teamId: '1',
      memberName: '甲',
      parentSessionId: 's-main',
    });
    const section = standingSection(
      config,
      subagentScope('s-member-first', { origin: 'subagent', delegationDepth: 1 }),
    );
    expect(section).toBe(MEMBER_SECTION_SHORT);
    expect(section).not.toContain('你是领队');
  });

  it('用户 fork 的会话（带父会话血缘 / depth 0）仍是主对话面，不因结构兜底静默', () => {
    const fork = { id: 's-fork', session: { header: { cwd: ws, parentSession: 's-main', seedLength: 12 } } };
    expect(standingSection(config, fork)).toBe(CAPTAIN_SECTION_SHORT);
    expect(roleBuilderSection(config, fork)).toBe(ROLE_BUILDER_SECTION);
    // delegationDepth 0 / 非数字一律不是子代理（子代理恒 >= 1）。
    expect(standingSection(config, subagentScope('s-depth0', { delegationDepth: 0 }))).toBe(
      CAPTAIN_SECTION_SHORT,
    );
  });

  it('无会话头（旧宿主 / 极简 scope）不误判为子代理', () => {
    expect(standingSection(config, { id: 's-bare' })).toBe(CAPTAIN_SECTION_SHORT);
  });
});

describe('roleBuilderSection 分流（order 106 只发主对话面）', () => {
  it('无会话作用域不贡献文本（空段语义）', () => {
    expect(roleBuilderSection(config, undefined)).toBe('');
    expect(roleBuilderSection(config, null)).toBe('');
    expect(roleBuilderSection(config, {})).toBe('');
  });

  it('主对话拿构建师段（前缀路由在模型侧，段本身常驻主对话）', () => {
    expect(roleBuilderSection(config, scope('s-main'))).toBe(ROLE_BUILDER_SECTION);
  });

  it('领队子代理静默（用户 2026-09-22「角色构建文本出现在领队中」）', () => {
    registerCaptainChild('s-captain-child', '1');
    const section = roleBuilderSection(config, scope('s-captain-child'));
    expect(section).toBe('');
    expect(section).not.toContain('eTeam --add-people');
    expect(section).not.toContain('eteams_build_dispatch');
  });

  it('构建师子代理静默（人格段自带构建纪律）', async () => {
    await reportBuildProgress(root, { request: 'r' });
    await markBuilderChild(root, 's-builder');
    expect(roleBuilderSection(config, scope('s-builder'))).toBe('');
  });

  it('成员面一律静默：成员子代理 / 成员副本行 / 领队副本行 / 人设接管会话', () => {
    registerMemberSession('s-rb-member', {
      teamId: '1',
      memberName: '甲',
      parentSessionId: 's-main',
    });
    expect(roleBuilderSection(config, scope('s-rb-member'))).toBe('');
    insertReplicaRow('s-rb-member-row', 0);
    expect(roleBuilderSection(config, scope('s-rb-member-row'))).toBe('');
    insertReplicaRow('s-rb-leader-row', 1);
    expect(roleBuilderSection(config, scope('s-rb-leader-row'))).toBe('');
    setSessionPersona('s-persona', { name: '研究员', role: 'researcher' });
    expect(roleBuilderSection(config, scope('s-persona'))).toBe('');
  });
});
