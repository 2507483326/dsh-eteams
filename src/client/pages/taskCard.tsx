/**
 * 任务卡片（用户迭代 2026-09-12「任务创建好后，主会话应该有一个卡片让用户
 * 跳转到任务页面」）：主会话调 `eteams_submit_task` 新建主任务（任务单）后，
 * 在该 tool call 的会话日志位置折出一张卡片，展示任务主题 / 状态 / 小任务
 * 计数，并提供「去任务」按钮直达任务页面（/tasks/:taskId）。
 *
 * 用户 2026-09-15「对话里面的任务卡片完全按照任务列表中的任务卡片样式来，
 * 只是按钮部分变成去任务」：卡面改与 {@link TaskListCard} 同构——复用 shared
 * 的子件与类（TASK_LIST_CARD_CLASS / CARD_SURFACE_CLASS / TaskIdBadge /
 * TaskStatusPill / CreatingLoadingRow / GroupSummaryChip / LIST_COUNT_CLASS），
 * 底栏按钮换成单枚「去任务」；卡身不整卡可点（动作收口到按钮，与列表页
 * 「其它会话」卡同为 cursor-default 观感）。卡面自带 CARD_SURFACE_CLASS 而非
 * 复用 .eteams-task-card 类——后者样式表只在 teamsView 运行时注入，对话界面
 * 拿不到（同值卡面，见下）。
 *
 * 机制与 {@link ETeamsCard}（teamCard）同款：client-runtime 的 Conversation
 * Node——`uiConversation.events.register(definition)` 折 tool call/result，
 * `slots.register({ name: 'conversation.chat.node', key: 'eteams-task' })` 落
 * 渲染位。折叠定义与结果解析在 React-free 纯核 {@link taskCardDefinition}
 * （lib/taskCardDefinition.ts），本模块只负责渲染与注册；状态与计数走轮询
 * 快照（useActivityState）。
 *
 * 「去任务」走 {@link enterTeamsPanel}（tab 可见→点宿主「团队」tab，未开始屏
 * →整页团队页），与 hero 按钮 / 输入栏弹层同一落地口径。
 *
 * @module dsh-eteams/client/task-card
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import type { Context } from '@deepseek-ai/cordis';
import { Button } from '../components/ui/button';
import { openTaskFolder } from '../lib/api';
import { cn } from '../lib/cn';
import { ClientErrorBoundary } from '../lib/diagnostics';
import { errorMessageOf } from '../lib/errors';
import {
  refreshActivitySoon,
  useActivityState,
  type TeamSnapshot,
  type TaskView,
} from '../lib/monitor';
import { taskCardDefinition } from '../lib/taskCardDefinition';
import { groupDisplayOf } from '../features/tasks/taskDisplayStatus';
import { getApp } from '../store/app';
import {
  CreatingLoadingRow,
  FormErrorNote,
  GroupSummaryChip,
  TaskIdBadge,
  TaskStatusPill,
} from './shared/components';
import { CARD_SURFACE_CLASS, LIST_COUNT_CLASS, TASK_LIST_CARD_CLASS } from './shared/styles';
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
  // 建单即出卡：挂载立即拉一次快照，别让首帧停在「等待面板同步…」。
  useEffect(() => {
    refreshActivitySoon();
  }, []);
  // 文件夹打开瞬态（列表卡同款行内错误槽；对话卡只此一任务，槽位不按 id 分）。
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const found = findTask(state, data.taskId);
  const task = found?.task;
  // 组卡进度：小任务计数与汇总（与 TaskListCard 同口径——仅 group 统计）。
  const allTasks = found?.team.tasks ?? [];
  const subs =
    task !== undefined && task.kind === 'group'
      ? allTasks.filter((t) => t.parentId === data.taskId)
      : [];
  const done = subs.filter((t) => t.status === 'completed').length;
  const creating = task !== undefined && task.status === 'creating';
  const summary =
    task !== undefined && task.kind === 'group' && task.status === 'ready' && subs.length > 0
      ? groupDisplayOf(subs)
      : null;
  const openFolder = async (): Promise<void> => {
    if (found === undefined) return;
    setFolderBusy(true);
    setFolderError(null);
    try {
      await openTaskFolder(found.team.teamId, data.taskId);
    } catch (e) {
      setFolderError(errorMessageOf(e));
    } finally {
      setFolderBusy(false);
    }
  };
  return (
    /* 表面根（D19b）：.eteams-ui 作用域根，工具类经后代选择器作用于子树。 */
    <div className="eteams-ui">
      {/* 卡面与任务列表小卡同构（2026-09-15）：布局类走 shared/TASK_LIST_CARD_CLASS。
          列表卡的底色/边框/悬停由 .eteams-task-card 样式表接管，但该表仅在
          teamsView 运行时注入——对话界面拿不到，故此处以 CARD_SURFACE_CLASS
          自带同值卡面（底色 --background / 1px --border / 同款阴影）。 */}
      <div className={cn(CARD_SURFACE_CLASS, TASK_LIST_CARD_CLASS, 'my-2 cursor-default')}>
        {/* 头行（十四轮 DA27 口径）：编号徽章（用户 2026-09-14「任务卡片 title
            前面加上编号徽章」）+ 主题截断。 */}
        <div className="flex min-w-0 items-center gap-1.5">
          <TaskIdBadge taskId={data.taskId} />
          <div className="truncate text-sm font-semibold text-foreground">
            {data.subject !== '' ? data.subject : '任务'}
          </div>
        </div>
        {/* 进度行：快照未到时显「等待面板同步…」，创建中换加载行（列表卡同款
            CreatingLoadingRow），否则共/已完成/未完成三计数（数字着色）。 */}
        {task === undefined ? (
          <div className={LIST_COUNT_CLASS}>等待面板同步…</div>
        ) : creating ? (
          <CreatingLoadingRow />
        ) : (
          <div className={LIST_COUNT_CLASS}>
            共 {subs.length} 个任务，已完成 <span className="text-success">{done}</span>，未完成{' '}
            <span className="text-warning">{subs.length - done}</span>
          </div>
        )}
        {summary !== null && <GroupSummaryChip summary={summary} />}
        {/* 文件夹行（列表卡同款幽灵文字钮）：完整路径只在 title 悬浮提示，
            点击 = 宿主拉系统文件管理器。 */}
        {task !== undefined && task.folder !== null && (
          <button
            type="button"
            title={`在文件管理器中打开：${task.folder}`}
            disabled={folderBusy}
            className="self-start cursor-pointer text-xs text-foreground underline-offset-2 hover:underline"
            onClick={() => void openFolder()}
          >
            工作目录
          </button>
        )}
        {folderError !== null && <FormErrorNote>{folderError}</FormErrorNote>}
        {/* 底栏（列表卡同款 border-t 分区）：左展示态 pill、右单枚「去任务」
            （原「打开任务」更名，2026-09-15）。 */}
        <div className="mt-auto flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 border-t border-solid pt-2">
          {task !== undefined && (
            <TaskStatusPill status={task.status} retryCount={task.retryCount} />
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                // tab 可见走宿主「团队」tab；未开始屏（tab 环不渲染）落整页团队页
                // ——与 hero 按钮/输入栏弹层同一条 enterTeamsPanel 落地口径。
                enterTeamsPanel({ taskId: data.taskId });
              }}
            >
              去任务
            </Button>
          </div>
        </div>
      </div>
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
