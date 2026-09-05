/**
 * 任务详情页头部卡（2026-09-05 三十一轮 DA44④ 自 tasksTab 纯移动抽离）：
 * 原 tasksTab 内联函数 detailHeader 改具名导出组件 TaskHeaderCard，options
 * 三元改 props（undefined 判断，语义等价），主任务/任务详情页两处调用共用。
 * 原注释逐字随迁（纯移动、零行为变更）。
 *
 * @module dsh-eteams/client/pages/teamsView/taskHeaderCard
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { TaskView } from '../../lib/monitor';
import { BORDER_L1_CLASS, MUTED_CLASS } from './shared';
import { BlockedPill, TaskStatusPill } from './taskPills';

/** 详情页头部卡（主任务/任务共用：#id 主题 + 展示态 pill + blocked + assignee）。
 * 二十轮 DA33：主任务详情页增 extra 槽——进度三计数/汇总 chip 收进卡内
 * （用户拍板「把团队成员放到上面去和任务标题放一起」）；成员罗列条曾随
 * extra 入卡，二十三轮 DA36 移出卡置卡下方（左竖线提示块）；任务详情页
 * 不传保持原观感。二十八轮 DA41：签名改 options 对象——actions 槽承载
 * 组详情页头部「开始」钮（自「任务列表」行上移）与任务详情页头部「编辑」
 * 钮，editor 槽承载头部卡就地编辑器（编辑时静态主题隐藏，Input 承担标题
 * 展示）；标题行原内联 ml-1 间距改 flex gap 承载。三十轮 DA43：编辑块
 * 撤标题 Input，主题展示改 subjectEditor 槽原位切换（编辑态行头 Input
 * 承担标题；不传时静态主题 span 照旧——组详情页零变化）。 */
export function TaskHeaderCard({
  task,
  extra,
  actions,
  editor,
  subjectEditor,
}: {
  task: TaskView;
  extra?: ReactNode;
  actions?: ReactNode;
  editor?: ReactNode;
  subjectEditor?: ReactNode;
}): ReactNode {
  return (
    <div
      className={cn('rounded-[8px] border border-solid bg-background px-3 py-2.5', BORDER_L1_CLASS)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <strong className="shrink-0">#{task.taskId}</strong>
          {subjectEditor !== undefined ? (
            subjectEditor
          ) : (
            <span className="min-w-0">{task.subject}</span>
          )}
          <TaskStatusPill status={task.status} retryCount={task.retryCount} />
          {task.blocked && <BlockedPill blockedFrom={task.blockedFrom} />}
          {task.assignee !== null && <span className={MUTED_CLASS}>· {task.assignee}</span>}
        </div>
        {actions !== undefined && (
          <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
        )}
      </div>
      {task.folder !== null && (
        <div className={cn(MUTED_CLASS, 'mt-1.5')}>文件夹：{task.folder}/</div>
      )}
      {extra}
      {editor}
    </div>
  );
}
