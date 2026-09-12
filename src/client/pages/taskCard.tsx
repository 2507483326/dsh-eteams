/**
 * 任务卡片（用户迭代 2026-09-12「任务创建好后，主会话应该有一个卡片让用户
 * 跳转到任务页面」）：主会话调 `eteams_submit_task` 新建主任务（任务单）后，
 * 在该 tool call 的会话日志位置折出一张卡片，展示任务主题 / 状态 / 小任务
 * 计数，并提供「打开任务」按钮直达任务页面（/tasks/:taskId）。
 *
 * 机制与 {@link ETeamsCard}（teamCard）同款：client-runtime 的 Conversation
 * Node——`uiConversation.events.register(definition)` 折 tool call/result，
 * `slots.register({ name: 'conversation.chat.node', key: 'eteams-task' })` 落
 * 渲染位。只认**不带 taskId 的提交**（新建主任务）；带 taskId 的收口提交由
 * 领队/主会话发起，不重复出卡。状态与计数走轮询快照（useActivityState）。
 *
 * @module dsh-eteams/client/task-card
 */
import { type ReactNode } from 'react';
import { Provider } from 'react-redux';
import type { Context } from '@deepseek-ai/cordis';
import { openTask } from '../lib/bridge';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { ClientErrorBoundary } from '../lib/diagnostics';
import { useActivityState, type TeamSnapshot, type TaskView } from '../lib/monitor';
import { STATUS_LABELS } from '../features/tasks/taskDisplayStatus';
import { getApp } from '../store/app';

/** ================================== 类型 ================================== */

/** Card state folded from the submit-task tool events. */
interface TaskCardState {
  subject: string;
  taskId: number | null;
  accepted: boolean;
}

/** Structural view of the Session events the definition matches. */
interface SessionEventLike {
  type: string;
  data: Record<string, unknown>;
}

/** Structural view of a tool-result content block. */
interface ToolResultBlock {
  type: string;
  text?: string;
  isError?: boolean;
}

/** ================================== 常量与映射表 ================================== */

/** Conversation Node definition: submit-task call/result → card node. */
const taskCardDefinition = {
  kind: 'eteams-task',
  target: 'chat',
  match(event: SessionEventLike): { id: string; role: 'start' | 'update' } | null {
    if (event.type === 'tool/call' && event.data.name === 'eteams_submit_task') {
      // 只认新建（不带 taskId）的提交；带 taskId 的收口提交不出卡。
      return parseSubmitArgs(event.data.arguments) === undefined
        ? null
        : { id: String(event.data.callId), role: 'start' };
    }
    if (event.type === 'tool/result') {
      const source = (
        event.data.message as { source?: { kind?: string; callId?: unknown } } | undefined
      )?.source;
      if (source?.kind === 'tool') return { id: String(source.callId), role: 'update' };
    }
    return null;
  },
  start(_context: unknown, match: { event: SessionEventLike }): TaskCardState {
    const parsed = parseSubmitArgs(match.event.data.arguments);
    if (parsed === undefined) throw new Error('task card start requires a new-task submit');
    return { subject: parsed.subject, taskId: null, accepted: false };
  },
  update(context: { state: TaskCardState }, match: { event: SessionEventLike }): TaskCardState {
    if (match.event.type !== 'tool/result') return context.state;
    const data = match.event.data as { error?: unknown; message?: { content?: unknown } };
    if (data.error !== undefined) return context.state;
    const content = data.message?.content;
    const errored =
      Array.isArray(content) &&
      (content as ToolResultBlock[]).some((b) => b.type === 'tool-result' && b.isError === true);
    if (errored) return context.state;
    const taskId = parseTaskIdFromResult(content);
    return { ...context.state, accepted: true, taskId: taskId ?? context.state.taskId };
  },
  buildViewNode(context: {
    key: string;
    id: string;
    start?: { event: { seq: number }; location: unknown };
    state?: TaskCardState;
  }): {
    key: string;
    kind: string;
    id: string;
    target: string;
    anchorSeq: number;
    location: unknown;
    visibility: 'visible';
    data: Record<string, unknown>;
  } | null {
    if (context.start === undefined || context.state === undefined) return null;
    if (!context.state.accepted || context.state.taskId === null) return null;
    return {
      key: context.key,
      kind: 'eteams-task',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: { taskId: context.state.taskId, subject: context.state.subject },
    };
  },
};

/** ================================== 工具函数 ================================== */

/** 新建主任务的提交参数：只要 subject；带 taskId（收口提交）返回 undefined。 */
function parseSubmitArgs(raw: unknown): { subject: string } | undefined {
  try {
    const args =
      typeof raw === 'string'
        ? (JSON.parse(raw) as Record<string, unknown>)
        : (raw as Record<string, unknown>);
    if (args.taskId !== undefined) return undefined;
    if (typeof args.subject === 'string') return { subject: args.subject };
  } catch {
    // unparseable arguments: no card
  }
  return undefined;
}

function parseTaskIdFromResult(blocks: unknown): number | null {
  for (const block of (Array.isArray(blocks) ? blocks : []) as ToolResultBlock[]) {
    if (block.type !== 'tool-result' || typeof block.text !== 'string') continue;
    try {
      const parsed = JSON.parse(block.text) as { taskId?: unknown };
      if (typeof parsed.taskId === 'number') return parsed.taskId;
      if (typeof parsed.taskId === 'string' && parsed.taskId !== '' && Number.isFinite(Number(parsed.taskId))) {
        return Number(parsed.taskId);
      }
    } catch {
      // not our JSON payload
    }
  }
  return null;
}

/** 快照里按 taskId 定位任务与其所属团队（跨队聚合口径）。 */
function findTask(
  state: { teams: TeamSnapshot[] },
  taskId: number,
): { task: TaskView; team: TeamSnapshot } | undefined {
  for (const team of state.teams) {
    const task = team.tasks.find((t) => t.taskId === taskId);
    if (task !== undefined) return { task, team };
  }
  return undefined;
}

/**
 * Register the task card definition and its chat-node renderer seat — same
 * degradation as {@link installCard}: absent `uiConversation` drops only the
 * card.
 * @param ctx - client root context (cordis).
 */
export function installTaskCard(ctx: Context): void {
  const events = (
    ctx as unknown as {
      uiConversation?: { events?: { register: (d: unknown) => () => void } };
    }
  ).uiConversation?.events;
  if (typeof events?.register !== 'function') return;
  events.register(taskCardDefinition);
  (
    ctx as unknown as {
      slots: {
        inject: (n: string, f: () => unknown) => void;
        register: (d: Record<string, unknown>, c: unknown) => unknown;
      };
    }
  ).slots.inject('conversation.chat.node', () =>
    (
      ctx as unknown as { slots: { register: (d: Record<string, unknown>, c: unknown) => unknown } }
    ).slots.register({ name: 'conversation.chat.node', key: 'eteams-task' }, TaskCard),
  );
}

/** ================================== 子组件 ================================== */

/** Card body — mounted inside the Provider (see {@link TaskCard}). */
function TaskCardBody({ node }: { node: { data: unknown } }): ReactNode {
  const state = useActivityState();
  const data = node.data as { taskId: number; subject: string };
  const found = findTask(state, data.taskId);
  const subs = found === undefined ? [] : found.team.tasks.filter((t) => t.parentId === data.taskId);
  const done = subs.filter((t) => t.status === 'completed').length;
  const status = found?.task.status ?? '';
  return (
    /* 表面根（D19b）：.eteams-ui 作用域根，工具类经后代选择器作用于子树。 */
    <div className="eteams-ui">
      <Card className="eteams-ui my-2 border-solid px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-sm font-semibold tracking-tight text-foreground">
            {data.subject !== '' ? data.subject : `任务 #${data.taskId}`}
          </strong>
          <Badge
            variant="outline"
            className="rounded-full border-solid px-2 py-px text-xs font-normal"
          >
            {status !== '' ? (STATUS_LABELS[status] ?? status) : '连接中…'}
          </Badge>
          {found !== undefined && (
            <span className="text-xs text-muted-foreground">{found.team.name}</span>
          )}
        </div>
        {found !== undefined ? (
          <div className="my-1.5 text-xs text-muted-foreground">
            共 {subs.length} 个任务，已完成 {done}
          </div>
        ) : (
          <div className="my-1.5 text-xs text-muted-foreground">等待面板同步…</div>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-solid"
          onClick={() => {
            openTask(data.taskId);
          }}
        >
          打开任务
        </Button>
      </Card>
    </div>
  );
}

/** ================================== 主组件 ================================== */

/**
 * The in-transcript task card renderer (live via polled snapshots). Same
 * two-layer shape as {@link ETeamsCard}: error boundary + Provider wrapper,
 * then the hook-consuming body.
 */
export function TaskCard({ node }: { node: { data: unknown } }): ReactNode {
  return (
    <ClientErrorBoundary label="任务卡片">
      <Provider store={getApp().store}>
        <TaskCardBody node={node} />
      </Provider>
    </ClientErrorBoundary>
  );
}
