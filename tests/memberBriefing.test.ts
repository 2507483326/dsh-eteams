/**
 * 通用成员提示词模板单测（用户迭代 2026-09-11；2026-09-14 增队伍留言板）：每个
 * 任务成员的出生包与每次指派信都由 memberBriefing 包住，固定写明 ①工作目录
 * （绝对路径）②队伍留言板（绝对路径 + 读/写纪律）③领队（无领队=主会话）
 * ④三节点实时汇报（开工/遇问题/完成）。
 */
import { describe, expect, it } from 'vitest';
import { MEMBER_RULES, MEMBER_TOOL_SHEET, memberBriefing, memberWelcome } from '../src/host/prompts/spawn/member';
import { assignmentMail, reportCompletedMail } from '../src/host/prompts/handoff/mails';
import { taskBriefing } from '../src/host/runtime/members';
import { boardFileAbs } from '../src/host/runtime/docs';
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

describe('memberBriefing（通用成员模板：工作目录/留言板/领队/三节点汇报）', () => {
  it('四段固定齐全（绝对路径原样进文）', () => {
    const text = memberBriefing({
      teamName: '甲队',
      leaderName: '项目牧羊人',
      workDir: 'C:/ws/teams/甲队/tasks/3-登录服务',
      boardFile: 'C:/ws/teams/甲队/tasks/3-登录服务/留言板.md',
    });
    expect(text).toContain('## 你的工作目录');
    expect(text).toContain('C:/ws/teams/甲队/tasks/3-登录服务');
    // 队伍留言板（用户 2026-09-14）：绝对路径 + 开工前先读/做完追加的纪律。
    expect(text).toContain('## 队伍留言板（领队与全员共用）');
    expect(text).toContain('C:/ws/teams/甲队/tasks/3-登录服务/留言板.md');
    expect(text).toContain('开工前先读一遍');
    expect(text).toContain('追加一行');
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
    boardFile: 'C:/ws/teams/甲队/tasks/3-登录服务/留言板.md',
  });

  it('memberWelcome 带上简报（无领队时领队=主会话）', () => {
    const text = memberWelcome(teamOf(false), 'Alice', undefined, briefing);
    expect(text).toContain('## 你的工作目录');
    expect(text).toContain('主会话（用户对话窗口）');
  });

  it('assignmentMail 带上简报（每次指派都在）', () => {
    const text = assignmentMail(taskOf(), {
      attemptId: 7,
      isStation: false,
      briefing,
    });
    expect(text).toContain('【指派】任务 3 登录服务');
    expect(text).toContain('## 你的工作目录');
    expect(text).toContain('主会话（用户对话窗口）');
  });
});

describe('taskBriefing（runtime 组装：有领队=领队名，无领队=主会话；留言板=主任务根）', () => {
  const env = { workspace: 'C:/ws' } as unknown as RuntimeEnv;

  it('有领队：领队名 + 任务文件夹绝对路径 + 留言板路径', () => {
    const text = taskBriefing(env, teamOf(true), taskOf());
    expect(text).toContain('项目牧羊人');
    expect(text).toContain('3-登录服务');
    expect(text).toContain('留言板.md');
  });

  it('无领队：汇报对象回落主会话', () => {
    const text = taskBriefing(env, teamOf(false), taskOf());
    expect(text).toContain('主会话（用户对话窗口）');
  });

  it('小任务成员拿到的是主任务文件夹根下的同一块留言板（用户 2026-09-14）', () => {
    const team = teamOf(true);
    const root = taskOf({ id: 3 });
    const sub = taskOf({
      id: 4,
      parentId: 3,
      subject: '小任务',
      workDir: 'teams/甲队/tasks/3-登录服务/sub/4-小任务',
    });
    team.tasks = [root, sub];
    const text = taskBriefing(env, team, sub);
    // 自己的工作目录 = 小任务文件夹；留言板 = 上溯主任务根下的那块（共享）。
    expect(text).toContain('4-小任务');
    const expectedBoard = boardFileAbs(env.workspace, team, sub);
    expect(expectedBoard).toContain('3-登录服务');
    expect(expectedBoard).toContain('留言板.md');
    expect(text).toContain(expectedBoard);
  });
});

describe('成员未决项纪律（用户 2026-09-13）：需要用户确认的必须完全澄清', () => {
  it('只有用户能定的问题走 eteams_ask_user、不得用推荐默认硬推', () => {
    const rules = MEMBER_RULES.join('\n');
    expect(rules).toContain('未决项');
    expect(rules).toContain('eteams_ask_user');
    expect(rules).toContain('推荐默认');
    expect(rules).toContain('直到无未决项');
    // 提问口径（用户 2026-09-14）：弹窗弹到主对话时用户只有问题本身——成员直问
    // 用户也必须自包含/说人话/选项写清后果。
    expect(rules).toContain('提问口径');
    expect(MEMBER_TOOL_SHEET).toContain('eteams_ask_user');
  });

  it('简报「遇问题即报」把用户未决项与领队汇报区分开', () => {
    const text = memberBriefing({
      teamName: '甲队',
      leaderName: '项目牧羊人',
      workDir: '/ws/t',
      boardFile: '/ws/t/留言板.md',
    });
    expect(text).toContain('eteams_ask_user');
    expect(text).toContain('别自己填默认值');
  });
});

describe('成员留言板纪律（用户 2026-09-14）', () => {
  it('常驻规则写明：开工前先读队伍留言板、做完追加一行', () => {
    const rules = MEMBER_RULES.join('\n');
    expect(rules).toContain('留言板');
    expect(rules).toContain('留言板.md');
    expect(rules).toContain('开工前先读');
    expect(rules).toContain('追加一行');
  });
});

describe('完成汇报邮件带未决项自检（用户 2026-09-13）', () => {
  it('提醒领队：产出含待用户确认项时先问清再推进', () => {
    const text = reportCompletedMail(taskOf(), {
      member: 'Alice',
      attemptId: 7,
      isFinalStation: true,
      output: '完成',
    });
    expect(text).toContain('未决项自检');
    expect(text).toContain('eteams_ask_user');
  });
});
