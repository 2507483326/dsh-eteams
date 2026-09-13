/**
 * 任务卡片折叠核单测（src/client/lib/taskCardDefinition.ts）：主会话
 * `eteams_submit_task`（不带 taskId）建主任务后，卡片必须能从 **tool-result
 * 块嵌套的 content 渲染文本**里取回任务号并出卡。
 *
 * 锁定的真实形状（dsh-client-connection `createToolResultMessage`）：
 *   { type:'tool-result', toolCallId, content:[{type:'text', text:'任务 #N 已提交（…）'}], isError }
 * ——早期实现误读块自身的 `text` 且 JSON.parse，taskId 恒为 null、卡片永不渲染；
 * 本单测是那条回归的护栏（宿主 render 文案改动时这里先红）。
 */
import { describe, expect, it } from 'vitest';
import {
  parseSubmitArgs,
  parseTaskIdFromResult,
  taskCardDefinition,
  type SessionEventLike,
  type TaskCardState,
} from '../src/client/lib/taskCardDefinition';

/** tool/call 会话事件（结构视图：name/callId/arguments 都在 data 上）。 */
const callEvent = (
  args: Record<string, unknown>,
  name = 'eteams_submit_task',
  callId = 'c1',
): SessionEventLike => ({
  type: 'tool/call',
  data: { name, callId, arguments: JSON.stringify(args) },
});

/** tool/result 会话事件：模型可见内容在工具结果块**嵌套的 content** 里。 */
const resultEvent = (
  content: unknown,
  opts: { callId?: string; isError?: boolean; error?: unknown } = {},
): SessionEventLike => ({
  type: 'tool/result',
  data: {
    ...(opts.error !== undefined ? { error: opts.error } : {}),
    message: {
      source: { kind: 'tool', callId: opts.callId ?? 'c1' },
      content: [
        {
          type: 'tool-result',
          toolCallId: opts.callId ?? 'c1',
          content,
          isError: opts.isError ?? false,
        },
      ],
    },
  },
});

/** 宿主 `eteams_submit_task` 新建路径的真实 render 内容。 */
const submittedText = (taskId: number): { type: 'text'; text: string }[] => [
  { type: 'text', text: `任务 #${taskId} 已提交（任务单文件夹 teams/demo/tasks/t${taskId}-slug）` },
];

/** 折叠起点状态（match=start 后的 state）。 */
const startedState = (subject: string): TaskCardState => ({
  subject,
  taskId: null,
  accepted: false,
});

describe('parseSubmitArgs（新建/收口判别）', () => {
  it('接受不带 taskId 的新建提交（对象与 JSON 串两种入参）', () => {
    expect(parseSubmitArgs({ subject: '导出报表' })).toEqual({ subject: '导出报表' });
    expect(parseSubmitArgs('{"subject":"导出报表"}')).toEqual({ subject: '导出报表' });
  });

  it('带 taskId 的收口提交不出卡；不可解析一律 undefined', () => {
    expect(parseSubmitArgs({ subject: '导出报表', taskId: 3 })).toBeUndefined();
    expect(parseSubmitArgs('{ not json')).toBeUndefined();
    expect(parseSubmitArgs(undefined)).toBeUndefined();
  });
});

describe('parseTaskIdFromResult（嵌套 content 取号）', () => {
  it('从 tool-result 块嵌套的渲染文本取 #N', () => {
    const blocks = [
      {
        type: 'tool-result',
        toolCallId: 'c1',
        content: submittedText(7),
        isError: false,
      },
    ];
    expect(parseTaskIdFromResult(blocks)).toBe(7);
  });

  it('JSON 载荷（数字 / 数字串）优先', () => {
    const wrap = (text: string): unknown => [
      { type: 'tool-result', content: [{ type: 'text', text }] },
    ];
    expect(parseTaskIdFromResult(wrap('{"taskId":9}'))).toBe(9);
    expect(parseTaskIdFromResult(wrap('{"taskId":"12"}'))).toBe(12);
  });

  it('取不到号/形状不对时返回 null', () => {
    expect(
      parseTaskIdFromResult([
        { type: 'tool-result', content: [{ type: 'text', text: '任务已完成' }] },
      ]),
    ).toBeNull();
    expect(parseTaskIdFromResult([{ type: 'text', text: '任务 #3 已提交' }])).toBeNull();
    expect(parseTaskIdFromResult(undefined)).toBeNull();
    expect(parseTaskIdFromResult('任务 #3')).toBeNull();
  });
});

describe('taskCardDefinition（会话折叠）', () => {
  it('只对不带 taskId 的 eteams_submit_task 起卡', () => {
    expect(taskCardDefinition.match(callEvent({ subject: '导出报表' }))).toEqual({
      id: 'c1',
      role: 'start',
    });
    expect(taskCardDefinition.match(callEvent({ subject: '导出报表', taskId: 3 }))).toBeNull();
    expect(taskCardDefinition.match(callEvent({ subject: 'x' }, 'eteams_create_task'))).toBeNull();
  });

  it('tool/result 按 callId 折成 update', () => {
    expect(taskCardDefinition.match(resultEvent([]))).toEqual({ id: 'c1', role: 'update' });
  });

  it('start 取 subject，taskId 先为 null、未受理', () => {
    const match = { event: callEvent({ subject: '导出报表' }) };
    expect(taskCardDefinition.start({}, match)).toEqual(startedState('导出报表'));
  });

  it('update：成功结果解出 taskId 并置 accepted', () => {
    const context = { state: startedState('导出报表') };
    const next = taskCardDefinition.update(context, { event: resultEvent(submittedText(7)) });
    expect(next).toEqual({ subject: '导出报表', taskId: 7, accepted: true });
  });

  it('update：isError / data.error 不改状态（不出卡）', () => {
    const context = { state: startedState('导出报表') };
    expect(
      taskCardDefinition.update(context, {
        event: resultEvent(submittedText(7), { isError: true }),
      }),
    ).toEqual(context.state);
    expect(
      taskCardDefinition.update(context, {
        event: resultEvent(submittedText(7), { error: 'boom' }),
      }),
    ).toEqual(context.state);
  });

  it('update：结果里没有号时 accepted 但不带 taskId（仍不出卡）', () => {
    const next = taskCardDefinition.update(
      { state: startedState('导出报表') },
      { event: resultEvent([{ type: 'text', text: '任务已完成' }]) },
    );
    expect(next).toEqual({ subject: '导出报表', taskId: null, accepted: true });
  });

  it('buildViewNode：受理且有号才出节点，锚在 start 事件 seq', () => {
    const base = {
      key: 'k1',
      id: 'c1',
      start: { event: { seq: 3 }, location: { kind: 'session' } },
    };
    expect(
      taskCardDefinition.buildViewNode({
        ...base,
        state: { subject: '导出报表', taskId: 7, accepted: true },
      }),
    ).toEqual({
      key: 'k1',
      kind: 'eteams-task',
      id: 'c1',
      target: 'chat',
      anchorSeq: 3,
      location: { kind: 'session' },
      visibility: 'visible',
      data: { taskId: 7, subject: '导出报表' },
    });
    expect(
      taskCardDefinition.buildViewNode({ ...base, state: startedState('导出报表') }),
    ).toBeNull();
    expect(
      taskCardDefinition.buildViewNode({
        ...base,
        state: { subject: '导出报表', taskId: null, accepted: true },
      }),
    ).toBeNull();
    expect(taskCardDefinition.buildViewNode(base)).toBeNull();
  });

  it('buildViewNode：回合收尾后锚到「回合末尾 - 0.1」，避免被折进过程块', () => {
    const node = taskCardDefinition.buildViewNode({
      key: 'k1',
      id: 'c1',
      start: {
        event: { seq: 3 },
        location: {
          kind: 'step',
          turn: { start: { seq: 1 }, end: { seq: 20 } },
          step: { seq: 3 },
        },
      },
      state: { subject: '导出报表', taskId: 7, accepted: true },
    });
    expect(node?.anchorSeq).toBeCloseTo(19.9);
  });
});
