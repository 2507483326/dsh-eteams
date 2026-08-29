/**
 * D18 对话式新增成员 tests: prefill template, preset seeding, leader-name
 * guard, prompt sections, the build-session state machine, and the
 * confirm/cancel runtime contracts (docs/19.12).
 *
 * @module dsh-eteams/tests/roleBuilder
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADD_PEOPLE_COMMAND, ADD_PEOPLE_TEMPLATE } from '../src/client/addPeople';
import { CAPTAIN_SECTION_SHORT } from '../src/host/prompts/captain';
import {
  buildActivationMessage,
  ROLE_BUILDER_PRESET,
  ROLE_BUILDER_SECTION,
} from '../src/host/prompts/roleBuilder';
import { PRESET_MEMBER_ROLES, ROLE_TEMPLATES } from '../src/host/prompts/persona';
import {
  answerBuildInterview,
  builderChildRef,
  cancelBuildSession,
  confirmBuildSession,
  readBuildSession,
  reportBuildProgress,
  resumeBuildSession,
  roleBuilderFile,
  setBuildAgentId,
} from '../src/host/runtime/roleBuilder';
import { MEMBER_DENIED_TOOLS } from '../src/host/runtime/members';
import { ensurePresetMembers, upsertRosterMember } from '../src/host/runtime/roster';

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'eteams-rolebuilder-'));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

describe('D18 对话式新增成员', () => {
  it('prefill template matches the canonical script (D18-1)', () => {
    expect(ADD_PEOPLE_COMMAND).toBe('eteam');
    expect(ADD_PEOPLE_TEMPLATE).toBe(
      '/eteam --add-people 我需要创建一个成员 【成员名称】，它的职责是【职责】。',
    );
  });

  it('/eteam activation message normalizes the steered body (docs/19.4)', () => {
    // 裸命令 → 内置模板正文
    expect(buildActivationMessage('')).toBe(
      'eTeam --add-people 我需要创建一个成员 【成员名称】，它的职责是【职责】。',
    );
    // 预填话术原样发送 → 去掉重复的 --add-people
    expect(
      buildActivationMessage(' --add-people 我需要创建一个成员 data-eng，它的职责是负责数据管道。'),
    ).toBe('eTeam --add-people 我需要创建一个成员 data-eng，它的职责是负责数据管道。');
    // 自由描述 → 原文透传
    expect(buildActivationMessage('我想要一个负责写周报的成员')).toBe(
      'eTeam --add-people 我想要一个负责写周报的成员',
    );
  });

  it('seeds the 角色构建师 preset idempotently (D18-3)', async () => {
    await ensurePresetMembers(stateRoot);
    await ensurePresetMembers(stateRoot);
    const file = JSON.parse(readFileSync(join(stateRoot, 'roster.json'), 'utf8')) as {
      members: { name: string; role: string; rules?: string[] }[];
    };
    const rb = file.members.find((m) => m.name === '角色构建师');
    expect(rb).toBeDefined();
    expect(rb?.role).toBe('角色构建师');
    expect(rb?.rules?.length ?? 0).toBeGreaterThan(0);
  });

  it('rejects overwriting the leader via upsert (保留名)', async () => {
    await ensurePresetMembers(stateRoot);
    await expect(upsertRosterMember(stateRoot, { name: '项目牧羊人', role: 'x' })).rejects.toThrow(
      /保留名/,
    );
  });

  it('captain section narrows scope and yields add-people to the role builder (D18-2)', () => {
    expect(CAPTAIN_SECTION_SHORT).toContain('只在用户明确要求多代理协作');
    expect(CAPTAIN_SECTION_SHORT).toContain('`eTeam --add-people`');
    expect(CAPTAIN_SECTION_SHORT).toContain('/eteam');
    expect(CAPTAIN_SECTION_SHORT).toContain('角色构建师');
  });

  it('role builder section carries the direct-call contract (docs/19.8.1)', () => {
    expect(ROLE_BUILDER_SECTION).toContain('`eTeam --add-people`');
    expect(ROLE_BUILDER_SECTION).toContain('/eteam');
    expect(ROLE_BUILDER_SECTION).toContain('eteams_build_report');
    expect(ROLE_BUILDER_SECTION).toContain('eteams_member_save');
    expect(ROLE_BUILDER_SECTION).toContain('awaiting_confirmation');
    expect(ROLE_BUILDER_SECTION).toContain('项目牧羊人');
  });

  it('preset is the single source for the role template (D18-3)', () => {
    expect(PRESET_MEMBER_ROLES).toContain('角色构建师');
    const tpl = ROLE_TEMPLATES['角色构建师'];
    expect(tpl.duty).toBe(ROLE_BUILDER_PRESET.duty);
    expect(tpl.style).toBe(ROLE_BUILDER_PRESET.style);
    expect(tpl.skills).toBe(ROLE_BUILDER_PRESET.skills);
  });

  it('build-session state machine guards transitions (docs/19.9.1)', async () => {
    // 首轮必须以 active 开启会话
    await expect(reportBuildProgress(stateRoot, { status: 'awaiting_confirmation' })).rejects.toThrow();
    const s1 = await reportBuildProgress(stateRoot, { request: 'eTeam --add-people …', step: '收到需求' });
    expect(s1.status).toBe('active');
    expect(s1.startedAt).toBeGreaterThan(0);
    // active 内步进更新 + draft 浅合并累积
    const s2 = await reportBuildProgress(stateRoot, {
      step: '查重',
      stepsDone: ['收到需求'],
      draft: { name: 'data-eng', role: '数据工程师' },
    });
    expect(s2.draft?.name).toBe('data-eng');
    const s3 = await reportBuildProgress(stateRoot, { step: '撰写角色手册', draft: { personaMd: '# 手册' } });
    expect(s3.draft?.name).toBe('data-eng');
    expect(s3.draft?.personaMd).toBe('# 手册');
    const s4 = await reportBuildProgress(stateRoot, { status: 'awaiting_confirmation', note: '等确认' });
    expect(s4.status).toBe('awaiting_confirmation');
    // 确认：roster 落库 + 会话翻转为 confirmed（D18-6 唯一写点）
    const { session, memberName } = await confirmBuildSession(stateRoot, {
      name: 'data-eng',
      role: '数据工程师',
      duty: '管道',
    });
    expect(session.status).toBe('confirmed');
    expect(memberName).toBe('data-eng');
    expect(readBuildSession(stateRoot)?.status).toBe('confirmed');
    const roster = JSON.parse(readFileSync(join(stateRoot, 'roster.json'), 'utf8')) as {
      members: { name: string }[];
    };
    expect(roster.members.some((m) => m.name === 'data-eng')).toBe(true);
    // 终态会话拒绝继续报告（docs/19.16：防后台代理迟到播报复活会话）；
    // 只有显式 newBuild 的 active 报告开启新一轮
    await expect(reportBuildProgress(stateRoot, { step: 'x' })).rejects.toThrow(/已结束/);
    const fresh = await reportBuildProgress(stateRoot, {
      status: 'active',
      request: '新一轮',
      newBuild: true,
    });
    expect(fresh.status).toBe('active');
    expect(fresh.startedAt).toBeGreaterThanOrEqual(s1.startedAt);
  });

  it('cancel works from active, not from terminal', async () => {
    await reportBuildProgress(stateRoot, { request: 'r' });
    const c = await cancelBuildSession(stateRoot);
    expect(c.status).toBe('cancelled');
    await expect(cancelBuildSession(stateRoot)).rejects.toThrow();
  });

  it('resume restores a cancelled build with context (docs/19.16)', async () => {
    await reportBuildProgress(stateRoot, {
      request: 'r2',
      stepsDone: ['收到需求', '查重成员库'],
      draft: { name: 'partial', role: 'engineer' },
    });
    await cancelBuildSession(stateRoot);
    const resumed = await resumeBuildSession(stateRoot);
    expect(resumed.status).toBe('active');
    expect(resumed.stepsDone).toContain('查重成员库');
    expect(resumed.draft?.name).toBe('partial');
    // 只有 cancelled 可恢复；confirmed 已落库，重开走 /eteam 新构建
    await cancelBuildSession(stateRoot);
    await reportBuildProgress(stateRoot, { status: 'active', newBuild: true });
    await reportBuildProgress(stateRoot, { status: 'awaiting_confirmation' });
    await confirmBuildSession(stateRoot, { name: 'partial', role: 'engineer' });
    await expect(resumeBuildSession(stateRoot)).rejects.toThrow(/仅已放弃/);
  });

  it('intent interview lands in the session and records answers (docs/19.16)', async () => {
    await reportBuildProgress(stateRoot, { request: 'r3' });
    await reportBuildProgress(stateRoot, {
      step: '意图访谈',
      interview: {
        questions: [
          { id: 'q1', question: '使用场景？', options: [{ label: 'A' }, { label: 'B' }] },
          { id: 'q2', question: '语气？', options: [{ label: 'C' }, { label: 'D' }], multi: true },
        ],
      },
    });
    const pending = readBuildSession(stateRoot);
    expect(pending?.interview?.questions).toHaveLength(2);
    expect(pending?.interview?.answers).toBeUndefined();
    const answered = await answerBuildInterview(stateRoot, [
      { id: 'q1', choice: 'A' },
      { id: 'q2', choice: 'C、D' },
    ]);
    expect(answered.interview?.answers).toEqual([
      { id: 'q1', choice: 'A' },
      { id: 'q2', choice: 'C、D' },
    ]);
    // 没有 interview 的会话不能作答
    await reportBuildProgress(stateRoot, { status: 'active', newBuild: true });
    await expect(answerBuildInterview(stateRoot, [{ id: 'q1', choice: 'A' }])).rejects.toThrow(
      /没有待回答/,
    );
  });

  it('spawn-time agent ref stamps onto the child-opened session (docs/19.16)', async () => {
    // 派发时会话尚不存在：身份先落旁路文件
    await setBuildAgentId(stateRoot, { agentId: 'child-1', parentSessionId: 'parent-1' });
    expect(readBuildSession(stateRoot)).toBeNull();
    // 子代理首播报（newBuild）开会话：身份合并、旁路文件消费
    const fresh = await reportBuildProgress(stateRoot, {
      request: 'r4',
      newBuild: true,
      step: '收到需求',
    });
    expect(fresh.agentId).toBe('child-1');
    expect(fresh.parentSessionId).toBe('parent-1');
    expect(builderChildRef(stateRoot, readBuildSession(stateRoot))?.agentId).toBe('child-1');
    // 旁路文件已被消费：无会话引用时解析为 null（身份只存活在会话里）
    expect(builderChildRef(stateRoot, null)).toBeNull();
    await reportBuildProgress(stateRoot, { status: 'active', newBuild: true });
    expect(builderChildRef(stateRoot, readBuildSession(stateRoot))).toBeNull();
  });

  it('eteams_build_report is denied to team members (D18-4)', () => {
    expect(MEMBER_DENIED_TOOLS).toContain('eteams_build_report');
  });

  it('state file lives at <stateRoot>/rolebuilder.json (docs/19.9.1)', () => {
    expect(roleBuilderFile(stateRoot).endsWith('rolebuilder.json')).toBe(true);
    expect(existsSync(roleBuilderFile(stateRoot))).toBe(false);
    expect(readBuildSession(stateRoot)).toBeNull();
  });
});
