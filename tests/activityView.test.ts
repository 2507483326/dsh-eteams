/**
 * 看板动态派生层（features/activity/activityView）单测：`activityRowsOf`
 * （任务标签主题解析/兜底、倒序、色调兜底）与 `pendingActionsOf` / `decidedActionsOf`
 * （三列列镜像：#id 任务号、对话名称（主对话 / 提问代理名）、详情拼装，加跳转
 * 目标与排序）。用户 2026-09-14「看板里面的动态改成和任务绑定……另加一个决策
 * 面板」；2026-09-15「都在一行，按照 #任务ID  对话名称  详情 显示」。
 *
 * @module dsh-eteams/tests/activityView
 */
import { describe, expect, it } from 'vitest';
import {
  activityRowsOf,
  decidedActionsOf,
  pendingActionsOf,
} from '../src/client/features/activity/activityView';
import type { TaskView, TeamSnapshot } from '../src/client/lib/monitor';

const task = (taskId: number, subject: string, sessionId: string | null): TaskView => ({
  taskId,
  subject,
  kind: 'task',
  parentId: null,
  folder: null,
  description: null,
  contractMd: null,
  idempotencyNote: null,
  statusNote: null,
  sessionId,
  status: 'start',
  assignee: null,
  dependencies: [],
  chain: [],
  chainCursor: -1,
  chainLength: 0,
  retryCount: 0,
  currentAttemptId: null,
  outcome: null,
  attemptSummary: [],
  updatedAt: 1,
});

const team = (over: Partial<TeamSnapshot> = {}): TeamSnapshot => ({
  teamId: 'team-1',
  name: '团队',
  progress: { completed: 0, total: 0, cancelled: 0, active: 0 },
  leaderRemoved: false,
  captain: {
    name: '团队领队',
    employeeId: 'ET-0001',
    role: 'captain',
    duty: '',
    style: '',
    skills: '',
    personaMd: null,
    avatar: { seed: 1, salt: 2 },
  },
  members: [],
  tasks: [task(3, '接口开发', 'cap-1'), task(7, '联调', 'cap-2')],
  pendingDecisions: [],
  pendingAsks: [],
  latestEvents: [],
  ...over,
});

describe('activityRowsOf（任务绑定时间线）', () => {
  it('按 taskId 解析任务主题；显式 taskSubject 优先；已删任务退化为 null', () => {
    const rows = activityRowsOf(
      team({
        latestEvents: [
          { seq: 1, at: 10, actor: '甲', actorKind: 'member', type: 'x', taskId: 3, text: 'a' },
          {
            seq: 2,
            at: 20,
            actor: '乙',
            actorKind: 'member',
            type: 'x',
            taskId: 3,
            text: 'b',
            taskSubject: '服务器主题',
          },
          { seq: 3, at: 30, actor: '系统', actorKind: 'system', type: 'x', taskId: 99, text: 'c' },
          { seq: 4, at: 40, actor: '系统', actorKind: 'system', type: 'x', taskId: null, text: 'd' },
        ],
      }),
    );
    // 倒序（新→旧）。
    expect(rows.map((r) => r.key)).toEqual(['e4', 'e3', 'e2', 'e1']);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get('e1')?.taskSubject).toBe('接口开发'); // 现查任务集
    expect(byKey.get('e2')?.taskSubject).toBe('服务器主题'); // 事件自带优先
    expect(byKey.get('e3')?.taskSubject).toBeNull(); // 任务已删
    expect(byKey.get('e4')?.taskSubject).toBeNull(); // 无任务
  });

  it('显式按时间倒序（乱序输入重排，最新在最上）', () => {
    const rows = activityRowsOf(
      team({
        latestEvents: [
          { seq: 1, at: 30, actor: 'a', actorKind: 'member', type: 'x', taskId: null, text: 'a' },
          { seq: 2, at: 10, actor: 'a', actorKind: 'member', type: 'x', taskId: null, text: 'b' },
          { seq: 3, at: 20, actor: 'a', actorKind: 'member', type: 'x', taskId: null, text: 'c' },
        ],
      }),
    );
    expect(rows.map((r) => r.key)).toEqual(['e1', 'e3', 'e2']);
  });

  it('同毫秒按 seq 倒序（稳定）', () => {
    const rows = activityRowsOf(
      team({
        latestEvents: [
          { seq: 1, at: 5, actor: 'a', actorKind: 'member', type: 'x', taskId: null, text: 'a' },
          { seq: 2, at: 5, actor: 'a', actorKind: 'member', type: 'x', taskId: null, text: 'b' },
        ],
      }),
    );
    expect(rows.map((r) => r.key)).toEqual(['e2', 'e1']);
  });

  it('色调缺省/未知 → info（旧运行时兼容）', () => {
    const rows = activityRowsOf(
      team({
        latestEvents: [
          { seq: 1, at: 1, actor: 'a', actorKind: 'member', type: 'x', taskId: null, text: 'a' },
          {
            seq: 2,
            at: 2,
            actor: 'a',
            actorKind: 'member',
            type: 'x',
            taskId: null,
            text: 'b',
            tone: 'warn',
          },
          {
            seq: 3,
            at: 3,
            actor: 'a',
            actorKind: 'member',
            type: 'x',
            taskId: null,
            text: 'c',
            tone: 'bogus',
          },
        ],
      }),
    );
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get('e1')?.tone).toBe('info');
    expect(byKey.get('e2')?.tone).toBe('warn');
    expect(byKey.get('e3')?.tone).toBe('info');
  });
});

describe('pendingActionsOf（决策面板）', () => {
  it('决策 → 跳任务主对话、列值 #id/主对话/主题·原因；问答 → 跳弹窗落点', () => {
    const actions = pendingActionsOf(
      team({
        pendingDecisions: [{ id: 5, taskId: 3, error: '重试超限', retryCount: 3, createdAt: 50 }],
        pendingAsks: [
          {
            askId: 'ask-1',
            askingName: '甲',
            askingKind: 'member',
            questionCount: 2,
            createdAt: 60,
            askingSessionId: 'member-1',
            mainTaskId: 3,
            deliverySessionId: 'cap-1',
            deliveryIsMain: true,
          },
        ],
      }),
    );
    expect(actions.map((a) => a.key)).toEqual(['d5', 'aask-1']);
    const decision = actions[0]!;
    expect(decision.sessionId).toBe('cap-1'); // task 3 的主会话
    expect(decision.isMainSession).toBe(true);
    expect(decision.taskId).toBe(3); // #id 列
    expect(decision.conversationName).toBe('主对话'); // 对话名称列
    expect(decision.detail).toBe('接口开发 · 重试超限'); // 详情列：主题 · 失败原因
    const ask = actions[1]!;
    expect(ask.taskId).toBe(3); // #id 列取绑定的大任务
    expect(ask.conversationName).toBe('主对话'); // 落点主对话
    expect(ask.detail).toBe('甲 的问答（2 问）');
    expect(ask.sessionId).toBe('cap-1'); // 弹窗落点
    expect(ask.isMainSession).toBe(true);
  });

  it('问答缺落点 → 退任务主对话、再退提问会话；isMain 未知按否', () => {
    const actions = pendingActionsOf(
      team({
        pendingAsks: [
          {
            askId: 'ask-1',
            askingName: '甲',
            askingKind: 'member',
            questionCount: 1,
            createdAt: 1,
            askingSessionId: 'member-1',
            mainTaskId: 7,
          },
          {
            askId: 'ask-2',
            askingName: '乙',
            askingKind: 'member',
            questionCount: 1,
            createdAt: 2,
            askingSessionId: 'member-2',
            mainTaskId: 99,
          },
          {
            askId: 'ask-3',
            askingName: '丙',
            askingKind: 'member',
            questionCount: 1,
            createdAt: 3,
            askingSessionId: 'member-3',
          },
        ],
      }),
    );
    expect(actions[0]?.sessionId).toBe('cap-2'); // task 7 主会话
    expect(actions[0]?.isMainSession).toBe(false);
    expect(actions[0]?.conversationName).toBe('甲'); // 非主对话 → 提问代理名
    expect(actions[0]?.taskId).toBe(7);
    expect(actions[1]?.sessionId).toBe('member-2'); // 任务已删 → 提问会话兜底
    expect(actions[1]?.conversationName).toBe('乙');
    expect(actions[1]?.taskId).toBe(99); // 任务已删仍留着任务号
    // 旧快照缺 mainTaskId：`#id` 列无值（页面留占位），对话名称仍给代理名。
    expect(actions[2]?.taskId).toBeNull();
    expect(actions[2]?.conversationName).toBe('丙');
  });

  it('按时间升序（最早待处理在前）', () => {
    const actions = pendingActionsOf(
      team({
        pendingDecisions: [
          { id: 1, taskId: 3, error: 'e', retryCount: 0, createdAt: 300 },
          { id: 2, taskId: 7, error: 'e', retryCount: 0, createdAt: 100 },
        ],
      }),
    );
    expect(actions.map((a) => a.key)).toEqual(['d2', 'd1']);
  });
});

describe('decidedActionsOf（已决策历史）', () => {
  it('决策：任务主题 + 处置结论译名 + 跳任务主对话（按处置时刻降序）', () => {
    const actions = decidedActionsOf(
      team({
        resolvedDecisions: [
          {
            id: 5,
            taskId: 3,
            error: '重试超限',
            retryCount: 3,
            createdAt: 50,
            resolvedAt: 80,
            choice: 'reassign',
            note: null,
          },
          {
            id: 6,
            taskId: 7,
            error: '缺环境',
            retryCount: 1,
            createdAt: 10,
            resolvedAt: 20,
            choice: 'suspend',
            note: 'task cancelled',
          },
        ],
      }),
    );
    expect(actions.map((a) => a.key)).toEqual(['rd5', 'rd6']);
    const first = actions[0]!;
    expect(first.kind).toBe('decision');
    expect(first.taskId).toBe(3); // #id 列
    expect(first.conversationName).toBe('主对话'); // 对话名称列
    expect(first.detail).toBe('接口开发 · 已换人重派'); // 详情列：主题 · 处置结论
    expect(first.at).toBe(80);
    expect(first.sessionId).toBe('cap-1'); // task 3 主会话
    expect(first.isMainSession).toBe(true);
    expect(first.outcome).toBe('ok');
    expect(actions[1]!.detail).toBe('联调 · 已挂起 · task cancelled'); // 主题 · 结论（note 追加）
  });

  it('问答：答案摘要 / 状态兜底 / 落点会话 / isMain 透传', () => {
    const actions = decidedActionsOf(
      team({
        recentAsks: [
          {
            askId: 'ask-1',
            askingName: '甲',
            askingKind: 'member',
            questionCount: 2,
            createdAt: 10,
            answeredAt: 30,
            status: 'answered',
            answerSummary: '选项A；自填B',
            mainTaskId: 3,
            deliverySessionId: 'cap-1',
            deliveryIsMain: true,
          },
          {
            askId: 'ask-2',
            askingName: '乙',
            askingKind: 'member',
            questionCount: 1,
            createdAt: 5,
            answeredAt: null,
            status: 'cancelled',
            answerSummary: '',
            mainTaskId: 99,
            askingSessionId: 'member-2',
          },
        ],
      }),
    );
    // answeredAt 空 → 回退 createdAt(5)；ask-1 at=30 在前。
    expect(actions.map((a) => a.key)).toEqual(['raask-1', 'raask-2']);
    const first = actions[0]!;
    expect(first.kind).toBe('ask');
    expect(first.taskId).toBe(3);
    expect(first.conversationName).toBe('主对话'); // 落点主对话
    expect(first.detail).toBe('甲 的问答（2 问） · 选项A；自填B'); // 问题 · 答案摘要
    expect(first.sessionId).toBe('cap-1');
    expect(first.isMainSession).toBe(true);
    expect(first.outcome).toBe('ok');
    const second = actions[1]!;
    expect(second.detail).toBe('乙 的问答（1 问） · 已取消'); // 无答案 → 状态文案
    expect(second.at).toBe(5);
    expect(second.outcome).toBe('muted');
    expect(second.sessionId).toBe('member-2'); // 任务已删 + 无落点 → 提问会话兜底
    expect(second.conversationName).toBe('乙'); // 非主对话 → 提问代理名
    expect(second.isMainSession).toBe(false);
  });

  it('决策 + 问答混排按时刻降序；缺字段旧快照 → 空数组', () => {
    const actions = decidedActionsOf(
      team({
        resolvedDecisions: [
          {
            id: 1,
            taskId: 3,
            error: 'e',
            retryCount: 0,
            createdAt: 10,
            resolvedAt: 20,
            choice: null,
            note: null,
          },
        ],
        recentAsks: [
          {
            askId: 'a',
            askingName: '甲',
            askingKind: 'member',
            questionCount: 1,
            createdAt: 30,
            answeredAt: 40,
            status: 'answered',
            answerSummary: 'x',
            mainTaskId: 3,
          },
        ],
      }),
    );
    expect(actions.map((a) => a.key)).toEqual(['raa', 'rd1']);
    expect(actions[1]!.detail).toBe('接口开发 · 已处理'); // 主题 · choice 缺省
    expect(decidedActionsOf(team())).toEqual([]); // 旧快照无历史字段
  });
});

describe('无团队（尚未建队时看板照常渲染）', () => {
  // 用户 2026-09-15「看板，团队为空时，还是显示原来的东西，不需要还没有团队
  // 提示」：看板不再有「还没有团队」早退分支，决策面板与动态卡在 team
  // undefined 时照常挂载——三个选择器必须把缺省当空快照（各自空列表、
  // 不抛错），卡内走自己的空态行（暂无待决策 / 暂无已决策 / 暂无动态）。
  it('三个选择器收到 undefined 团队 → 各自空列表', () => {
    expect(activityRowsOf(undefined)).toEqual([]);
    expect(pendingActionsOf(undefined)).toEqual([]);
    expect(decidedActionsOf(undefined)).toEqual([]);
  });
});
