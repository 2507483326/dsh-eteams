/**
 * 通用成员提示词模板单测（用户迭代 2026-09-11；2026-09-14 增队伍留言板；
 * 2026-09-15 扁平化增「任务目录 / 纪要 / 文档目录」）：每个任务成员的出生包与
 * 每次指派信都由 memberBriefing 包住，固定写明 ①工程根与任务目录（绝对路径）
 * ②队伍留言板（绝对路径 + 读/写纪律）③本任务纪要（绝对路径 + 写在哪一段）
 * ④文档产出目录 ⑤领队（无领队=主会话）与三节点实时汇报（开工/遇问题/完成）。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEMBER_RULES, MEMBER_TOOL_SHEET, memberBriefing, memberWelcome } from '../src/host/prompts/spawn/member';
import { assignmentMail, reportCompletedMail, reportFailedMail } from '../src/host/prompts/handoff/mails';
import { taskBriefing } from '../src/host/runtime/members';
import { boardFileAbs, minutesFileAbs } from '../src/host/runtime/docs';
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
      { name: '团队领队', isLeader: true },
      { name: 'Alice', isLeader: false },
    ],
    pendingDecisions: [],
  } as unknown as TeamState;
}

const BRIEFING_INPUT = {
  teamName: '甲队',
  leaderName: '团队领队',
  projectRoot: 'C:/ws',
  taskDir: 'C:/ws/teams/3-登录服务',
  boardFile: 'C:/ws/teams/3-登录服务/留言板.md',
  minutesFile: 'C:/ws/teams/3-登录服务/3-登录服务.纪要.md',
  docDir: 'C:/ws/teams/3-登录服务/文档',
};

describe('memberBriefing（通用成员模板：工作目录/留言板/纪要/文档/领队/三节点汇报）', () => {
  it('各段固定齐全（绝对路径原样进文）', () => {
    const text = memberBriefing(BRIEFING_INPUT);
    expect(text).toContain('## 你的工作目录');
    // 工程根（代码产出）与任务目录（治理文档）分开写，都由宿主算好下发。
    expect(text).toContain('C:/ws');
    expect(text).toContain('C:/ws/teams/3-登录服务');
    // 队伍留言板（用户 2026-09-14）：绝对路径 + 开工前先读/做完追加的纪律。
    expect(text).toContain('## 队伍留言板（领队与全员共用）');
    expect(text).toContain('C:/ws/teams/3-登录服务/留言板.md');
    expect(text).toContain('开工前先读一遍');
    expect(text).toContain('追加一行');
    // 本任务纪要（用户 2026-09-15 扁平化）：绝对路径 + 写在正文段、勿另建文件。
    expect(text).toContain('## 你这份任务的纪要');
    expect(text).toContain('C:/ws/teams/3-登录服务/3-登录服务.纪要.md');
    expect(text).toContain('## 纪要正文');
    expect(text).toContain('不要另建纪要文件');
    // 文档产出目录（交付说明/验收结论这类）。
    expect(text).toContain('## 文档产出');
    expect(text).toContain('C:/ws/teams/3-登录服务/文档');
    expect(text).toContain('## 你的领队');
    expect(text).toContain('团队领队');
    expect(text).toContain('## 实时汇报（必须发给领队）');
    expect(text).toContain('开工即报');
    expect(text).toContain('遇问题即报');
    expect(text).toContain('完成 / 失败必报');
  });
});

describe('任务成员注入点（出生包 + 每次指派）', () => {
  const briefing = memberBriefing({
    ...BRIEFING_INPUT,
    leaderName: '主会话（用户对话窗口）',
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

describe('taskBriefing（runtime 组装：有领队=领队名，无领队=主会话；留言板/纪要=主任务目录）', () => {
  const env = { workspace: 'C:/ws' } as unknown as RuntimeEnv;

  it('有领队：领队名 + 任务目录 + 留言板与纪要绝对路径', () => {
    const text = taskBriefing(env, teamOf(true), taskOf());
    expect(text).toContain('团队领队');
    expect(text).toContain('3-登录服务');
    expect(text).toContain('留言板.md');
    expect(text).toContain('3-登录服务.纪要.md');
  });

  it('无领队：汇报对象回落主会话', () => {
    const text = taskBriefing(env, teamOf(false), taskOf());
    expect(text).toContain('主会话（用户对话窗口）');
  });

  it('工程根取任务自己的 work_dir，不随调用方会话目录漂移（用户 2026-09-16）', () => {
    const team = teamOf(true);
    // 任务绑定在 C:/own（建任务时冻结的当前会话目录）；env.workspace 是本次调用
    // 的会话目录（别的工作区）——简报必须按任务走，否则成员照它写代码就写错地方。
    const root = taskOf({ id: 3, workDir: 'C:/own', taskDir: 'teams/3-登录服务' });
    team.tasks = [root];
    const text = taskBriefing(env, team, root);
    expect(text).toContain('本任务绑定的工作区');
    expect(text).toContain('C:/own');
    expect(text).not.toContain('C:/ws');
  });

  it('小任务成员拿到的是主任务目录下的同一块留言板与自己的纪要（用户 2026-09-15）', () => {
    const team = teamOf(true);
    const root = taskOf({ id: 3, workDir: 'C:/own', taskDir: 'teams/3-登录服务' });
    const sub = taskOf({
      id: 4,
      parentId: 3,
      subject: '小任务',
      // 小任务两列恒空（共用主任务目录）：基址与目录都上溯主任务。
    });
    team.tasks = [root, sub];
    const text = taskBriefing(env, team, sub);
    const expectedBoard = boardFileAbs(env.workspace, team, sub);
    expect(expectedBoard).toContain('3-登录服务');
    expect(expectedBoard).toContain('留言板.md');
    expect(expectedBoard).toContain(join('C:/own', 'teams'));
    expect(text).toContain(expectedBoard);
    // 纪要按**任务**命名但落主任务目录（一个主任务一个目录，小任务不再有目录）。
    const expectedMinutes = minutesFileAbs(env.workspace, team, sub);
    // 落主任务目录（分隔符随平台，断言只看目录名与文件名）。
    expect(expectedMinutes).toContain('3-登录服务');
    expect(expectedMinutes).toContain('4-小任务.纪要.md');
    expect(expectedMinutes).not.toContain('sub');
    expect(text).toContain(expectedMinutes);
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
    const text = memberBriefing({ ...BRIEFING_INPUT, taskDir: '/ws/t', boardFile: '/ws/t/留言板.md' });
    expect(text).toContain('eteams_ask_user');
    expect(text).toContain('别自己填默认值');
  });
});

describe('成员留言板与纪要纪律（用户 2026-09-14 / 2026-09-15）', () => {
  it('常驻规则写明：开工前先读队伍留言板、做完追加一行，结论进纪要', () => {
    const rules = MEMBER_RULES.join('\n');
    expect(rules).toContain('留言板');
    expect(rules).toContain('队伍留言板');
    expect(rules).toContain('开工前先读');
    expect(rules).toContain('追加一行');
    // 不再写 notes.md：完工结论进「你这份任务的纪要」。
    expect(rules).toContain('纪要');
    expect(rules).toContain('纪要正文');
    expect(rules).not.toContain('notes.md');
  });

  it('交接信要求结论写进纪要（不再是 notes.md）', () => {
    const text = assignmentMail(taskOf(), { attemptId: 7, isStation: false });
    expect(text).toContain('纪要');
    expect(text).not.toContain('notes.md');
  });
});

describe('成员被拒纪律（v16）：换法子 / 报缺口 / 拒 三分', () => {
  it('常驻规则把三种判定写清，工具速查列出 eteams_report_gap', () => {
    const rules = MEMBER_RULES.join('\n');
    expect(rules).toContain('被拒');
    expect(rules).toContain('eteams_report_gap');
    // 「换法子能不能过」是分界线；过不去才报，报完停下等路线。
    expect(rules).toContain('换法子能不能过');
    expect(rules).toContain('停下这条路');
    // 外发/凭据类永不请示授权。
    expect(rules).toContain('verdict=refuse');
    expect(MEMBER_TOOL_SHEET).toContain('eteams_report_gap');
  });

  it('简报「实时汇报」写明被拦住的走法（先报缺口、再报领队、然后停下）', () => {
    const text = memberBriefing(BRIEFING_INPUT);
    expect(text).toContain('eteams_report_gap');
    expect(text).toContain('停下这条路');
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

  it('失败转待领队的邮件给出三条分诊路径（含能力缺口走 route_gap）', () => {
    const text = reportFailedMail(taskOf(), {
      member: 'Alice',
      attemptId: 7,
      error: '被沙箱拦住',
      retryCount: 3,
      maxRetries: 3,
      willRetry: false,
    });
    expect(text).toContain('待领队分诊');
    expect(text).toContain('eteams_reassign_task');
    expect(text).toContain('eteams_escalate_task');
    expect(text).toContain('eteams_route_gap');
  });
});
