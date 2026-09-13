/**
 * 任务卡片（用户迭代 2026-09-12「任务创建好后，主会话应该有一个卡片让用户
 * 跳转到任务页面」）：主会话调 `eteams_submit_task` 新建主任务（任务单）后，
 * 在该 tool call 的会话日志位置折出一张卡片，展示任务主题 / 状态 / 小任务
 * 计数，并提供「打开任务」按钮直达任务页面（/tasks/:taskId）。
 *
 * 机制与 {@link ETeamsCard}（teamCard）同款：client-runtime 的 Conversation
 * Node——`uiConversation.events.register(definition)` 折 tool call/result，
 * `slots.register({ name: 'conversation.chat.node', key: 'eteams-task' })` 落
 * 渲染位。折叠定义与结果解析在 React-free 纯核 {@link taskCardDefinition}
 * （lib/taskCardDefinition.ts），本模块只负责渲染与注册；状态与计数走轮询
 * 快照（useActivityState）。
 *
 * 「打开任务」走 {@link enterTeamsPanel}（tab 可见→点宿主「团队」tab，未开始屏
 * →整页团队页），与 hero 按钮 / 输入栏弹层同一落地口径。
 *
 * @module dsh-eteams/client/task-card
 */
import { useEffect, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import type { Context } from '@deepseek-ai/cordis';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { ClientErrorBoundary } from '../lib/diagnostics';
import {
  refreshActivitySoon,
  useActivityState,
  type TeamSnapshot,
  type TaskView,
} from '../lib/monitor';
import { taskCardDefinition } from '../lib/taskCardDefinition';
import { STATUS_LABELS } from '../features/tasks/taskDisplayStatus';
import { getApp } from '../store/app';
import { enterTeamsPanel } from './teamsPanel';

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
  // 建单即出卡：挂载立即拉一次快照，别让首帧停在「连接中…/等待面板同步…」。
  useEffect(() => {
    refreshActivitySoon();
  }, []);
  const found = findTask(state, data.taskId);
  const subs =
    found === undefined ? [] : found.team.tasks.filter((t) => t.parentId === data.taskId);
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
            // tab 可见走宿主「团队」tab；未开始屏（tab 环不渲染）落整页团队页
            // ——与 hero 按钮/输入栏弹层同一条 enterTeamsPanel 落地口径。
            enterTeamsPanel({ taskId: data.taskId });
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
