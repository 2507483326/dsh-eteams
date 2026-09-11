/**
 * 看板「任务动态」分区卡（docs/47）：当前团队的顶层任务平铺小卡（任务列表
 * 页同栅格 TASK_GRID_CLASS、同卡面 .eteams-task-card 样式表的只读轻量版——
 * 无开始/删除/详情钮、无文件夹行、无错误槽），主任务卡内嵌小任务窗口：按
 * 执行序（executionOrderOf，与主任务详情页同款）最多 4 行（MAX_SUBTASK_ROWS，
 * 需求「最多显示4个小任务」），超出折叠「还有 n 个小任务」；汇总 chip（DB6
 * 判据与列表卡/详情页同款）兜住隐藏小任务的异常汇总；阻塞行照列表卡口径
 * 渲染（DB11）。整卡点击进 /tasks/:taskId（routes.tsx location sync 回写
 * drawerTaskId，零新增接线）。依赖 features/tasks、lib/monitor、shared。
 *
 * 用户迭代 2026-09-11「创建中不允许点进去，加上创建中 loading 效果」：
 * creating 容器整卡禁点（与任务列表卡同口径——完善收口前进详情无意义）、
 * 进度行换 CreatingLoadingRow（shared/components，两卡共用）。
 *
 * @module dsh-eteams/client/pages/board/taskActivity
 */
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { executionOrderOf } from '../../features/tasks/taskAssignCore';
import { groupDisplayOf } from '../../features/tasks/taskDisplayStatus';
import { cn } from '../../lib/cn';
import type { TaskView, TeamSnapshot } from '../../lib/monitor';
import { CreatingLoadingRow, GroupSummaryChip, TaskStatusPill } from '../shared/components';
import {
  LIST_COUNT_CLASS,
  LIST_TITLE_CLASS,
  MUTED_CLASS,
  PANEL_CARD_CLASS,
  TASK_GRID_CLASS,
} from '../shared/styles';
import { Card } from '../../components/ui/card';

/** ================================== 常量与纯函数 ================================== */

/** 小任务窗口上限（docs/47 DB3：需求原话「最多显示4个小任务」）。 */
export const MAX_SUBTASK_ROWS = 4;

/** 看板任务小卡身（docs/47 DB4）：任务列表页卡同款观感（底色/边框/悬停由
 * .eteams-task-card 样式表接管）+ 卡内呼吸感/纵向排布同列表卡；命名避开
 * shared/styles 已有的同名异值 TASK_CARD_CLASS（小任务卡面 rounded-[8px]
 * 档，docs/47 E14 同名异值陷阱）。 */
const BOARD_TASK_CARD_CLASS = 'flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl p-3.5';

/**
 * 小任务窗口截取（docs/47 DB8，纯函数供单测锁口径）：入参已按执行序排好
 * （排序留在组件内——与详情页 executionOrderOf 调用位同构，本函数不重排），
 * 只做窗口截取：前 MAX_SUBTASK_ROWS 行 + 溢出计数；空集 → 空窗零溢出。
 */
export function subtaskWindowOf(
  subs: readonly TaskView[],
): { shown: TaskView[]; hidden: number } {
  return {
    shown: subs.slice(0, MAX_SUBTASK_ROWS),
    hidden: Math.max(0, subs.length - MAX_SUBTASK_ROWS),
  };
}

/** ================================== 子组件 ================================== */

/**
 * 看板任务小卡（docs/47 47.4.2，一卡一顶层任务）：头行主题 + 主任务进度
 * 三分计数行（列表卡 E4 同款；DB9——顶层普通任务不渲染「共 0」，改指派
 * 行）+ 汇总 chip（DB6）+ 阻塞行（DB11）+ 小任务窗口（DB3/DB5）+ 底栏
 * 展示态 pill（retryCount 随传——审核 P2）。行不可点（点击落整卡进详情，
 * DB5）；小任务不设详情页是既有口径——进组详情即达同一信息。
 */
function BoardTaskTile({
  task,
  allTasks,
  onOpen,
}: {
  task: TaskView;
  allTasks: TaskView[];
  onOpen: () => void;
}): ReactNode {
  // 组卡小任务按执行序展示（docs/47 DB3：兄弟依赖拓扑序，创建序平局——
  // 详情页 411-412 同款取法）；顶层普通任务无小任务，窗口不渲染。
  const subs =
    task.kind === 'group'
      ? executionOrderOf(allTasks.filter((s) => s.parentId === task.taskId))
      : [];
  const done = subs.filter((s) => s.status === 'completed').length;
  const { shown, hidden } = subtaskWindowOf(subs);
  // 汇总 chip（docs/47 DB6）：判据与列表卡/详情页同款（ready 且有小任务，
  // groupDisplayOf 全 done 返回 null 不渲染）——窗口只显 4 行时兜住隐藏
  // 小任务的异常汇总（✕ n 项异常）。
  const summary =
    task.kind === 'group' && task.status === 'ready' && subs.length > 0
      ? groupDisplayOf(subs)
      : null;
  // 创建中容器禁点（用户迭代 2026-09-11，与任务列表卡同口径）：完善收口前
  // 进详情无意义。不可点卡身压掉常量里的 cursor-pointer（cn/tailwind-merge
  // 以后者覆盖）。
  const creating = task.status === 'creating';
  return (
    <div
      className={cn('eteams-task-card', BOARD_TASK_CARD_CLASS, creating && 'cursor-default')}
      onClick={creating ? undefined : onOpen}
    >
      {/* 头行：主题截断（title 兜底全文）。 */}
      <div className="truncate text-sm font-semibold text-foreground" title={task.subject}>
        {task.subject}
      </div>
      {/* 进度行（主任务，列表卡三分计数同款：已完成 success 绿/未完成
          warning 琥珀）；顶层普通任务改指派行（DB9）。 */}
      {creating ? (
        // 创建中：子任务未落库、计数恒 0 无信息量，换加载行（2026-09-11，
        // 任务列表卡同款 CreatingLoadingRow）。
        <CreatingLoadingRow />
      ) : task.kind === 'group' ? (
        <div className={LIST_COUNT_CLASS}>
          共 {subs.length} 个任务，已完成 <span className="text-success">{done}</span>
          ，未完成 <span className="text-warning">{subs.length - done}</span>
        </div>
      ) : (
        task.assignee !== null && <div className={MUTED_CLASS}>指派 {task.assignee}</div>
      )}
      {summary !== null && <GroupSummaryChip summary={summary} />}
      {/* 小任务窗口（docs/47 DB3/DB5）：执行序前 4 行——状态 pill（重试
          计数随传）+ 序号 + 主题截断 + 指派灰注（非空守卫）；超出折叠为
          「还有 n 个小任务」灰字行。行不可点：点击落整卡进主任务详情。 */}
      {subs.length > 0 && (
        <div className="flex flex-col gap-1 text-xs">
          {shown.map((s, i) => (
            <div key={s.taskId} className="flex min-w-0 items-center gap-1.5">
              <TaskStatusPill status={s.status} retryCount={s.retryCount} className="shrink-0" />
              <span className={cn(MUTED_CLASS, 'shrink-0')}>{i + 1}.</span>
              <span className="min-w-0 truncate" title={s.subject}>
                {s.subject}
              </span>
              {s.assignee !== null && (
                <span className={cn(MUTED_CLASS, 'shrink-0')}>· {s.assignee}</span>
              )}
            </div>
          ))}
          {hidden > 0 && <div className={MUTED_CLASS}>还有 {hidden} 个小任务</div>}
        </div>
      )}
      {/* 底栏（列表卡 mt-auto 沉底口径 + border-t 分区）：左展示态 pill
          （retryCount 随传，审核 P2）——无按钮区，无 stopPropagation 需求。 */}
      <div className="mt-auto flex items-center gap-2 border-t border-solid pt-2">
        <TaskStatusPill status={task.status} retryCount={task.retryCount} />
      </div>
    </div>
  );
}

/** ================================== 主组件 ================================== */

/**
 * 看板「任务动态」卡（docs/47）：Card 面板 + 标题行（任务动态 · N 个，
 * 任务列表页表头同款容器）+ TASK_GRID_CLASS 栅格（一卡一顶层任务——
 * 主任务 + 顶层普通任务，快照序，不过滤状态 DB2）；无顶层任务仍渲染分区
 * （muted「暂无任务」行，与同页「最近动态」空态同款 DB7）。整卡点击进
 * /tasks/:taskId（47.4.3）。
 */
export function TaskActivityCard({ team }: { team: TeamSnapshot }): ReactNode {
  const navigate = useNavigate();
  // 顶层任务 = parentId === null（主任务 + 顶层普通任务，快照序）——任务
  // 列表页同款过滤（docs/47 E3），口径可预期。
  const topTasks = team.tasks.filter((t) => t.parentId === null);
  return (
    <Card className={cn(PANEL_CARD_CLASS, 'pb-3')}>
      <div className="mb-2.5 flex items-center gap-2">
        <h3 className={LIST_TITLE_CLASS}>任务动态</h3>
        <span className={LIST_COUNT_CLASS}>{topTasks.length} 个</span>
      </div>
      {topTasks.length === 0 ? (
        <div className={MUTED_CLASS}>暂无任务</div>
      ) : (
        <div className={TASK_GRID_CLASS}>
          {topTasks.map((t) => (
            <BoardTaskTile
              key={t.taskId}
              task={t}
              allTasks={team.tasks}
              onOpen={() => navigate(`/tasks/${t.taskId}`)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}