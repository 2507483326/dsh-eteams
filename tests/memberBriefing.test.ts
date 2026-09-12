/**
 * 通用成员提示词模板单测（用户迭代 2026-09-11）：每个任务成员的出生包与每次
 * 指派信都由 memberBriefing 包住，固定写明 ①工作目录（绝对路径）②领队
 * （无领队=主会话）③三节点实时汇报（开工/遇问题/完成）。
 */
import { describe, expect, it } from 'vitest';
import { memberBriefing, memberWelcome } from '../src/host/prompts/spawn/member';
import { assignmentMail } from '../src/host/prompts/handoff/mails';
import { taskBriefing } from '../src/host/runtime/members';
import type { RuntimeEnv } from '../src/host/runtime/base';
import type { TaskRecord, TeamState } from '../src/host/model/types';

const T0 = 1_000;

function taskOf(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 3,
    subject: '登录服务',
    parentId: null,
    dependencies: [],
    chain: [],
    chainCursor: -1,
    status: 'ready',
    attempts: [],
    retryCount: 0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function teamOf(hasLeader: boolean): TeamState {
  return {
    id: 1,
    name: '甲队',
    hasLeader,
    createdAt: T0,
    updatedAt: T0,
    taskMembers: [],
    tasks: [],
    members: [
      { name: '项目牧羊人', isLeader: true },
      { name: 'Alice', isLeader: false },
    ],
    pendingDecisions: [],
  } as unknown as TeamState;
}

describe('memberBriefing（通用成员模板：工作目录/领队/三节点汇报）', () => {
  it('三段固定齐全（绝对工作目录原样进文）', () => {
    const text = memberBriefing({
      teamName: '甲队',
      leaderName: '项目牧羊人',
      workDir: 'C:/ws/teams/甲队/tasks/3-登录服务',
    });
    expect(text).toContain('## 你的工作目录');
    expect(text).toContain('C:/ws/teams/甲队/tasks/3-登录服务');
    expect(text).toContain('## 你的领队');
    expect(text).toContain('项目牧羊人');
    expect(text).toContain('## 实时汇报（必须发给领队）');
    expect(text).toContain('开工即报');
    expect(text).toContain('遇问题即报');
    expect(text).toContain('完成 / 失败必报');
  });
});

describe('任务成员注入点（出生包 + 每次指派）', () => {
  const briefing = memberBriefing({
    teamName: '甲队',
    leaderName: '主会话（用户对话窗口）',
    workDir: 'C:/ws/teams/甲队/tasks/3-登录服务',
  });

  it('memberWelcome 带上简报（无领队时领队=主会话）', () => {
    const text = memberWelcome(teamOf(false), 'Alice', undefined, briefing);
    expect(text).toContain('## 你的工作目录');
    expect(text).toContain('主会话（用户对话窗口）');
  });

  it('assignmentMail 带上简报（每次指派都在）', () => {
    const text = assignmentMail(taskOf(), {
      teamName: '甲队',
      attemptId: 7,
      isStation: false,
      briefing,
    });
    expect(text).toContain('【指派】任务 3 登录服务');
    expect(text).toContain('## 你的工作目录');
    expect(text).toContain('主会话（用户对话窗口）');
  });
});

describe('taskBriefing（runtime 组装：有领队=领队名，无领队=主会话）', () => {
  const env = { workspace: 'C:/ws' } as unknown as RuntimeEnv;

  it('有领队：领队名 + 任务文件夹绝对路径', () => {
    const text = taskBriefing(env, teamOf(true), taskOf());
    expect(text).toContain('项目牧羊人');
    expect(text).toContain('3-登录服务');
  });

  it('无领队：汇报对象回落主会话', () => {
    const text = taskBriefing(env, teamOf(false), taskOf());
    expect(text).toContain('主会话（用户对话窗口）');
  });
});
