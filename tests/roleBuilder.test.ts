/**
 * D18 对话式新增成员 tests: prefill template, preset seeding, leader-name
 * guard, prompt sections, the build-session state machine, and the
 * confirm/cancel runtime contracts (docs/19.12).
 *
 * @module dsh-eteams/tests/roleBuilder
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADD_PEOPLE_COMMAND, ADD_PEOPLE_TEMPLATE } from '../src/client/lib/addPeople';
import { CAPTAIN_SECTION_SHORT } from '../src/host/prompts/system/captain';
import { buildActivationMessage, steerEngageNotice } from '../src/host/commands/eteam';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import type { ETeamsResolvedConfig } from '../src/host/config';
import { ROLE_BUILDER_PRESET, ROLE_BUILDER_CHILD_PERSONA } from '../src/host/prompts/personas/builder';
import { builderPhasePrompt } from '../src/host/prompts/spawn/builderPhases';
import { createCaptainTools } from '../src/host/tools/captainTools';
import { ROLE_BUILDER_SECTION } from '../src/host/prompts/system/roleBuilder';
import { PRESET_MEMBER_ROLES, ROLE_TEMPLATES } from '../src/host/prompts/personas/presets';
import {
  answerBuildInterview,
  cancelBuildSession,
  confirmBuildSession,
  readBuildParentSession,
  readBuildSession,
  reportBuildProgress,
  resumeBuildSession,
  roleBuilderFile,
  setBuildParentSession,
} from '../src/host/runtime/roleBuilder';
import type { BuildDraft } from '../src/host/runtime/roleBuilder';
import { MEMBER_DENIED_TOOLS } from '../src/host/runtime/members';
import {
  ensurePresetMembers,
  findRosterMember,
  upsertRosterMember,
} from '../src/host/runtime/roster';
import { cleanupTempWorkspace } from './support/tmpWorkspace';

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'eteams-rolebuilder-'));
});

afterEach(() => {
  // roster 写路径已落 SQLite（<stateRoot>/eteams.db）：先关连接（两把键口径）
  // 再退避删目录——tests/support/tmpWorkspace。
  cleanupTempWorkspace(stateRoot);
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

  it('engage notice steers only conversationally blank sessions (docs/19.16 空会话唤醒)', async () => {
    const steer = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn() };
    // 新版本迁移后签名：steerEngageNotice(ctx, agent, stateRoot, log)——
    // ctx.agents.get 命中活 agent 即不走到 resume；stateRoot 只落诊断日志。
    const live = { id: 'engage-1', session: { events: [] }, steer } as unknown as Agent;
    const ctx = { agents: { get: () => live } } as unknown as Parameters<
      typeof steerEngageNotice
    >[0];
    // 空白会话（从未开过 turn）→ steer 一条 engage 通知
    await steerEngageNotice(ctx, live, stateRoot, log);
    expect(steer).toHaveBeenCalledTimes(1);
    // 已开过 turn 的会话 → 不加应答回合（无噪音）
    const engaged = {
      id: 'engage-2',
      session: { events: [{ type: 'turn/start' }] },
      steer,
    } as unknown as Agent;
    await steerEngageNotice(
      { agents: { get: () => engaged } } as unknown as Parameters<typeof steerEngageNotice>[0],
      engaged,
      stateRoot,
      log,
    );
    expect(steer).toHaveBeenCalledTimes(1);
    // steer 抛错不外溢（构建照常在后台进行）
    const failing = {
      id: 'engage-3',
      session: { events: [] },
      steer: (): void => {
        throw new Error('boom');
      },
    } as unknown as Agent;
    await steerEngageNotice(
      { agents: { get: () => failing } } as unknown as Parameters<typeof steerEngageNotice>[0],
      failing,
      stateRoot,
      log,
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('seeds the 角色构建师 preset idempotently (D18-3)', async () => {
    await ensurePresetMembers(stateRoot);
    await ensurePresetMembers(stateRoot);
    // roster.json 已随 SQLite 改造退场（roster.ts：roster.json 不再读写），
    // 预置行改走 member 表公共模板行断言。
    const rb = findRosterMember(stateRoot, '角色构建师');
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

  it('build child prompts stay brief and fetch the guide first (用户迭代 2026-09-10)', () => {
    const start = builderPhasePrompt('start', { request: 'eTeam --add-people 建一个数据工程师' });
    const wake = builderPhasePrompt('continue', {
      request: 'eTeam --add-people 建一个数据工程师',
      interview: {
        questions: [{ id: 'q1', question: '使用场景？', options: [{ label: 'A' }] }],
        answers: [{ id: 'q1', choice: 'A' }],
      },
    });
    for (const text of [start, wake]) {
      // 可见回合提示词不再整墙复述纪律：persona 正文不进 prompt，第一步
      // 自己调 eteams_build_guide 领取
      expect(text).not.toContain('持久记忆是');
      expect(text).not.toContain('agency-agents-zh');
      expect(text).toContain('eteams_build_guide');
      expect(text).toContain('【本回合任务】');
    }
    // 数据快照保留（激活原文 / 访谈作答是模型干活的原材料）
    expect(start).toContain('【激活原文】');
    expect(wake).toContain('【意图访谈逐题作答】');
    // 纪律全在 persona 系统段（eteams_build_guide 返回同一常量，双通道同文）
    expect(ROLE_BUILDER_CHILD_PERSONA).toContain('eteams_build_wait');
    expect(ROLE_BUILDER_CHILD_PERSONA).toContain('awaiting_confirmation');
    expect(ROLE_BUILDER_CHILD_PERSONA).toContain('multi_select');
    expect(ROLE_BUILDER_CHILD_PERSONA).toContain('一次报全');
  });

  it('eteams_build_guide hands the builder discipline to the caller (用户迭代 2026-09-10)', async () => {
    const tools = createCaptainTools({} as ETeamsResolvedConfig, {} as Context);
    const guide = tools.find((t) => t.name === 'eteams_build_guide');
    expect(guide).toBeDefined();
    const out = (await guide!.execute({}, {} as never)) as { ok: boolean; guide: string };
    expect(out.ok).toBe(true);
    // 单一来源：工具返回与 persona 系统段同一段纪律全文
    expect(out.guide).toBe(ROLE_BUILDER_CHILD_PERSONA);
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
    await expect(
      reportBuildProgress(stateRoot, { status: 'awaiting_confirmation' }),
    ).rejects.toThrow();
    const s1 = await reportBuildProgress(stateRoot, {
      request: 'eTeam --add-people …',
      step: '收到需求',
    });
    expect(s1.status).toBe('active');
    expect(s1.startedAt).toBeGreaterThan(0);
    // active 内步进更新 + draft 浅合并累积
    const s2 = await reportBuildProgress(stateRoot, {
      step: '查重',
      stepsDone: ['收到需求'],
      draft: { name: 'data-eng', role: '数据工程师' },
    });
    expect(s2.draft?.name).toBe('data-eng');
    const s3 = await reportBuildProgress(stateRoot, {
      step: '撰写角色手册',
      draft: { personaMd: '# 手册', profile: '一句话简介' },
    });
    expect(s3.draft?.name).toBe('data-eng');
    expect(s3.draft?.personaMd).toBe('# 手册');
    const s4 = await reportBuildProgress(stateRoot, {
      status: 'awaiting_confirmation',
      note: '等确认',
    });
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
    // 确认入库 = member 表公共模板行（roster.json 已退场）。
    expect(findRosterMember(stateRoot, 'data-eng')).toBeDefined();
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

  it('derives stepsDone from the canonical timeline (2026-09-08 蓝点乱序反馈)', async () => {
    // 受理即完成「收到需求」（时间线第一项，受理即建会话、无中间态）
    const s1 = await reportBuildProgress(stateRoot, { request: 'r4', step: '收到需求' });
    expect(s1.step).toBe('收到需求');
    expect(s1.stepsDone).toEqual(['收到需求']);
    // 旧提示词的「查重成员库」按别名归一到时间线第二项（面板逐字匹配点亮）
    const s2 = await reportBuildProgress(stateRoot, { step: '查重成员库' });
    expect(s2.step).toBe('查重角色库');
    expect(s2.stepsDone).toEqual(['收到需求']);
    // 报「意图访谈」时前两步必已完成——模型自报的 stepsDone 不再整体替换
    const s3 = await reportBuildProgress(stateRoot, { step: '意图访谈', stepsDone: ['意图访谈'] });
    expect(s3.stepsDone).toEqual(['收到需求', '查重角色库']);
    // 非时间线步骤（重启核查）不推导：显式 stepsDone 照旧整体替换
    const s4 = await reportBuildProgress(stateRoot, { step: '重启核查', stepsDone: [] });
    expect(s4.step).toBe('重启核查');
    expect(s4.stepsDone).toEqual([]);
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
    await reportBuildProgress(stateRoot, {
      status: 'awaiting_confirmation',
      draft: {
        name: 'partial',
        role: 'engineer',
        personaMd: '# partial 手册',
        profile: '一句话简介',
      },
    });
    await confirmBuildSession(stateRoot, { name: 'partial', role: 'engineer' });
    await expect(resumeBuildSession(stateRoot)).rejects.toThrow(/仅已放弃/);
  });

  it('awaiting_confirmation requires a non-empty personaMd, name and profile (docs/19.17.2 + 19.19)', async () => {
    await reportBuildProgress(stateRoot, { request: 'r' });
    // 无 draft / 空白手册一律拒绝——确认页直接渲染 personaMd，空手册= 空白页
    await expect(
      reportBuildProgress(stateRoot, { status: 'awaiting_confirmation' }),
    ).rejects.toThrow(/personaMd/);
    await expect(
      reportBuildProgress(stateRoot, {
        status: 'awaiting_confirmation',
        draft: { name: 'x', role: 'y', personaMd: '   ' },
      }),
    ).rejects.toThrow(/personaMd/);
    // 顺序钉死（docs/19.19）：手册在而简介缺 → 报 profile，不冒充 personaMd 错
    await expect(
      reportBuildProgress(stateRoot, {
        status: 'awaiting_confirmation',
        draft: { name: 'x', role: 'y', personaMd: '# x 手册' },
      }),
    ).rejects.toThrow(/profile/);
    // name 缺失同样拒绝（2026-09-10 面板 trim 崩溃：确认页/入库都以角色名
    // 为键，缺名会让确认表单拿 undefined 去 trim）。本会话草稿已带 name
    // （浅合并保旧值），先开新局再报一份缺名草稿。
    await reportBuildProgress(stateRoot, { status: 'active', newBuild: true });
    await expect(
      reportBuildProgress(stateRoot, {
        status: 'awaiting_confirmation',
        draft: { role: 'y', personaMd: '# x 手册', profile: '一句话简介' },
      }),
    ).rejects.toThrow(/name/);
    // 带手册全文 + 一句话简介则放行
    const s = await reportBuildProgress(stateRoot, {
      status: 'awaiting_confirmation',
      draft: { name: 'x', role: 'y', personaMd: '# x 手册', profile: '一句话简介' },
    });
    expect(s.status).toBe('awaiting_confirmation');
    expect(s.draft?.personaMd).toBe('# x 手册');
    expect(s.draft?.profile).toBe('一句话简介');
  });

  it('report drafts sanitize at the write path: bad-typed fields dropped, old values kept (2026-09-10 面板 trim 崩溃)', async () => {
    await reportBuildProgress(stateRoot, { request: 'r' });
    // 模型自由上报的 draft：null / 错类型字段视同未上报剔除，不许落盘
    const s1 = await reportBuildProgress(stateRoot, {
      step: '查重角色库',
      draft: {
        name: '甲',
        role: '工程师',
        profile: null,
        duty: 42,
        rules: '错类型',
      } as unknown as BuildDraft,
    });
    expect(s1.draft?.name).toBe('甲');
    expect(s1.draft?.profile).toBeUndefined();
    expect(s1.draft?.duty).toBeUndefined();
    expect(s1.draft?.rules).toBeUndefined();
    // 合法字段照常累积；rules 混入非字符串项只留合法项
    const s2 = await reportBuildProgress(stateRoot, {
      step: '起草统一手册',
      draft: {
        profile: '一句话简介',
        rules: ['纪律一', 7, '纪律二'],
      } as unknown as BuildDraft,
    });
    expect(s2.draft?.profile).toBe('一句话简介');
    expect(s2.draft?.rules).toEqual(['纪律一', '纪律二']);
    // null 视同未上报：浅合并保旧值，已定名不会被 null 清掉
    const s3 = await reportBuildProgress(stateRoot, {
      step: '深化领域章节',
      draft: { name: null } as unknown as BuildDraft,
    });
    expect(s3.draft?.name).toBe('甲');
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

  it('spawn-time parent ref is remembered for later phase attribution (docs/19.16)', async () => {
    // 派发时记住主会话 id（一次性阶段代理的后续阶段归属）
    await setBuildParentSession(stateRoot, 'parent-1');
    expect(readBuildParentSession(stateRoot)).toBe('parent-1');
    await setBuildParentSession(stateRoot, 'parent-2');
    expect(readBuildParentSession(stateRoot)).toBe('parent-2');
    expect(readBuildParentSession(join(stateRoot, 'nonexistent-dir'))).toBeNull();
  });

  it('eteams_build_report / eteams_build_wait / eteams_build_guide are denied to team members (D18-4, docs/19.17.1)', () => {
    expect(MEMBER_DENIED_TOOLS).toContain('eteams_build_report');
    expect(MEMBER_DENIED_TOOLS).toContain('eteams_build_guide');
    expect(MEMBER_DENIED_TOOLS).toContain('eteams_build_wait');
  });

  it('state file lives at <stateRoot>/rolebuilder.json (docs/19.9.1)', () => {
    expect(roleBuilderFile(stateRoot).endsWith('rolebuilder.json')).toBe(true);
    expect(existsSync(roleBuilderFile(stateRoot))).toBe(false);
    expect(readBuildSession(stateRoot)).toBeNull();
  });
});
