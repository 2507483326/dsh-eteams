/**
 * 构建访谈统一问答 tests（2026-09-10）：eteams_build_report(interview) 只把
 * 问题写入构建会话（发布即返回——无 popSelf 路由、无转交、无问答单），弹窗
 * 由构建子代理随后自己 eteams_ask_user 发起（答案宿主自动写回，见
 * askUser.test.ts 的构建师分支）；build_report(answers) 旁路面保留（主对话
 * 亲自构建的降级路径/面板补交）。eteams_interview_answer 与 eteams_ask_answer
 * 已随转交路径退役（工具不再注册）。直接驱动工具 execute，走与
 * buildWait.test.ts 同款的离线 ctx 桩。
 *
 * @module dsh-eteams/tests/buildInterviewRelay
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { ETeamsResolvedConfig } from '../src/host/config';
import { ETeamsConfig } from '../src/host/config';
import { createCaptainTools } from '../src/host/tools/captainTools';
import { createAskUserTools } from '../src/host/tools/askUserTools';
import { markBuilderChild, readBuildSession, reportBuildProgress } from '../src/host/runtime/roleBuilder';
import { readAllPendingAsksSync } from '../src/host/state/asks';
import { cleanupTempWorkspace } from './support/tmpWorkspace';

let workspace: string;
let config: ETeamsResolvedConfig;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'eteams-interview-relay-'));
  config = ETeamsConfig({}) as ETeamsResolvedConfig;
});

afterEach(() => {
  cleanupTempWorkspace(workspace);
});

const stateRoot = (): string => join(workspace, '.eteams');

const QUESTIONS = [
  {
    id: 'q1',
    question: '你主要用它做什么？',
    options: [{ label: '写数据管道（推荐）' }, { label: '写前端' }],
  },
];

/** 构建子代理侧的假调用者（id 即守卫凭据；cwd 定位状态根）。 */
function childAgent(): { id: string; session: { header: { cwd: string } } } {
  return { id: 'builder-child-1', session: { header: { cwd: workspace } } };
}

function fakeCtx(): Context {
  return {
    logger: { info: () => undefined, warn: () => undefined },
    agents: { get: () => undefined },
    tools: { register() {} },
    systemPrompt: { section() {} },
    get: (key: string) =>
      key === 'workspaceRegistry'
        ? { list: () => [{ path: workspace, title: 'ws' }] }
        : undefined,
  } as unknown as Context;
}

function callReport(
  args: Record<string, unknown>,
  agent: { id: string } = childAgent(),
): Promise<Record<string, unknown>> {
  const tools = createCaptainTools(config, fakeCtx());
  const tool = tools.find((t) => t.name === 'eteams_build_report');
  if (!tool) throw new Error('eteams_build_report 未注册');
  return tool.execute(args as never, { agent, signal: undefined } as never) as Promise<
    Record<string, unknown>
  >;
}

const publishInterview = (): Record<string, unknown> => ({
  step: '意图访谈',
  interview: { questions: QUESTIONS },
});

async function seedSession(): Promise<void> {
  await reportBuildProgress(stateRoot(), { request: 'r' });
  await markBuilderChild(stateRoot(), 'builder-child-1');
}

describe('eteams_build_report 访谈发布（统一问答：只写会话，不路由）', () => {
  it('发布访谈 → 问题落构建会话，返回无 popSelf、无问答单、无转交', async () => {
    await seedSession();
    const result = await callReport(publishInterview());
    expect(result).toMatchObject({ ok: true, status: 'active', step: '意图访谈' });
    expect(result).not.toHaveProperty('popSelf');
    // 不落统一问答单（弹窗由子代理自己 eteams_ask_user 发起）。
    expect(readAllPendingAsksSync(stateRoot())).toHaveLength(0);
    // 问题已进构建会话（面板工作台/快照读端）。
    expect(readBuildSession(stateRoot())?.interview?.questions).toEqual(QUESTIONS);
    expect(readBuildSession(stateRoot())?.interview?.answers).toBeUndefined();
  });

  it('同题复发重发布 → 直接覆写 questions（无路由痕迹字段，无去重特殊态）', async () => {
    await seedSession();
    await callReport(publishInterview());
    const revised = [
      {
        id: 'q1',
        question: '改后的问法？',
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ];
    const result = await callReport({ interview: { questions: revised } });
    expect(result).toMatchObject({ ok: true });
    expect(readBuildSession(stateRoot())?.interview?.questions).toEqual(revised);
    expect(readAllPendingAsksSync(stateRoot())).toHaveLength(0);
  });

  it('answers 旁路面保留：build_report(answers) 直接落盘（主对话降级路径/面板补交）', async () => {
    await seedSession();
    await callReport(publishInterview());
    const result = await callReport({ answers: [{ id: 'q1', choice: '写数据管道（推荐）' }] });
    expect(result).toMatchObject({ ok: true, status: 'active' });
    expect(readBuildSession(stateRoot())?.interview?.answers).toEqual([
      { id: 'q1', choice: '写数据管道（推荐）' },
    ]);
  });

  it('退役工具不再注册：eteams_interview_answer / eteams_ask_answer 缺席', () => {
    const names = createCaptainTools(config, fakeCtx()).map((t) => t.name);
    expect(names).not.toContain('eteams_interview_answer');
    const askNames = createAskUserTools(config, fakeCtx()).map((t) => t.name);
    expect(askNames).not.toContain('eteams_ask_answer');
    expect(askNames).toContain('eteams_ask_user');
  });
});
