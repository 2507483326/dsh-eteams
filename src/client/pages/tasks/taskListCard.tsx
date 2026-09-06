/**
 * 任务列表页小卡（2026-09-05 三十一轮 DA44④ 自 tasksTab 纯移动抽离）：
 * TASK_CARD_CLASS + deletableOf（私有，仅本文件消费）+ TaskListCard，承载
 * 列表卡身（头行/信息行/文件夹行/底栏）；subs 统计与 deletable 判据在卡内
 * 现算（task/allTasks 进 props）。原注释逐字随迁（纯移动、零行为变更）。
 *
 * @module dsh-eteams/client/pages/tasks/taskListCard
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { TaskView } from '../../lib/monitor';
import { groupDisplayOf, isTerminal } from '../../features/tasks/taskDisplayStatus';
import { DeleteButton } from '../../components/deleteButton';
import { Button } from '../../components/ui/button';
import { FormErrorNote } from '../shared/components';
import { LIST_COUNT_CLASS } from '../shared/styles';
import { BlockedPill, GroupSummaryChip, TaskStatusPill } from './taskPills';

/** 列表页任务小卡（十一轮 DA24 与团队列表小卡同款三段式，十二轮 DA25 修订：
 * 头行（主题截断，**无 #id 前缀**）、信息**逐行分行**（进度行/汇总 chip 行/
 * 阻塞行各自独立）、文件夹行（点击打开）、底栏（border-t 分区）；十三轮 DA26
 * 修订：内容行顶格对齐、每卡必有进度行（无小任务显「小任务 0」）、底栏
 * mt-auto 沉底；十四轮 DA27 修订：底栏每卡常驻——左状态 pill（圆角 2px）+
 * 右详情/删除钮（删除仍仅可删的卡渲染）、进度行改共/已完成/未完成三计数
 * （数字着色）、文件夹行「工作目录」标签钮；十五轮 DA28 修订：状态 pill
 * 描边压平 hover、工作目录改幽灵文字钮；底色/边框/悬停由 .eteams-task-card
 * 样式表接管，p-3.5 = 卡内高度呼吸感）。 */
const TASK_CARD_CLASS = 'flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl p-3.5';

/** 列表卡删除按钮显隐判据（十二轮 DA25，用户拍板「仅可删除的卡显示」）——
 * 与 host deleteTask 守卫（assignment.ts）同口径：本身 draft/ready；主任务
 * 级联删除要求全部小任务 draft/ready；删除集（自身 + 小任务）不得被任何
 * 未入集任务依赖。host 仍是最终裁决，弹窗内就地显示拒绝原因。
 * （M3：改具名导出供 tests/taskListCard.test.ts 锁定镜像口径——判定式
 * 一字未动。） */
export function deletableOf(t: TaskView, tasks: readonly TaskView[]): boolean {
  if (t.status !== 'draft' && t.status !== 'ready') return false;
  const doomedIds = new Set<number>([t.taskId]);
  for (const sub of tasks) {
    if (sub.parentId !== t.taskId) continue;
    if (sub.status !== 'draft' && sub.status !== 'ready') return false;
    doomedIds.add(sub.taskId);
  }
  for (const other of tasks) {
    if (doomedIds.has(other.taskId)) continue;
    if (other.dependencies.some((dep) => doomedIds.has(dep))) return false;
  }
  return true;
}

/** 列表页任务小卡（DA44④ 自 tasksTab 列表卡身抽离）：整卡点击 onOpen、
 * 文件夹行 onOpenFolder（宿主拉系统文件管理器）、删除 onDelete、组卡开始
 * onStart；folderError/startError 行内就地显示（瞬态槽在 tasksTab）。 */
export function TaskListCard({
  task,
  allTasks,
  folderBusy,
  folderError,
  startError,
  startBusy,
  onOpen,
  onOpenFolder,
  onDelete,
  onStart,
}: {
  task: TaskView;
  allTasks: TaskView[];
  folderBusy: number | null;
  folderError: { taskId: number; message: string } | null;
  startError: { taskId: number; message: string } | null;
  startBusy: number | null;
  onOpen: () => void;
  onOpenFolder: (taskId: number) => void;
  onDelete: () => void;
  onStart: () => void;
}): ReactNode {
  // 组卡进度：小任务计数与汇总（九轮 DA22 概览口径——只计数
  // 不列明细；draft 只显示个数，ready 且有明细时叠加汇总）。
  const subs = task.kind === 'group' ? allTasks.filter((s) => s.parentId === task.taskId) : [];
  const done = subs.filter((s) => s.status === 'completed').length;
  const summary =
    task.kind === 'group' && task.status === 'ready' && subs.length > 0
      ? groupDisplayOf(subs)
      : null;
  // 进度行（十四轮 DA27 改版，用户拍板「别小任务 个了，改成
  // 共 x 个任务，已完成 x , 未完成 x 数字用颜色标识一下」）：
  // 每卡统一渲染（十三轮口径），三种身份同格式——总数/已完成/
  // 未完成三分计数（原「进行中」计数不再单列），数字着色：
  // 已完成 success 绿、未完成 warning 琥珀、总数走行底灰；
  // 顶层普通任务的指派人沿用同行尾注。
  const progress = (
    <>
      共 {subs.length} 个任务，已完成 <span className="text-success">{done}</span>
      ，未完成 <span className="text-warning">{subs.length - done}</span>
      {task.kind !== 'group' && task.assignee !== null ? ` · 指派 ${task.assignee}` : ''}
    </>
  );
  const deletable = deletableOf(task, allTasks);
  return (
    <div className={cn('eteams-task-card', TASK_CARD_CLASS)} onClick={onOpen}>
      {/* 头行：主题（十四轮 DA27：展示态 pill 挪出头部——用户
          「状态挪到卡片的左边下面」，入底栏左侧；十二轮 DA25
          已去 #id 前缀）。 */}
      <div className="truncate text-sm font-semibold text-foreground">{task.subject}</div>
      {/* 信息分行（十二轮 DA25 分行 + 十三轮 DA26 统一渲染）：
        进度/汇总 chip/阻塞各自独立行，每卡都有进度行（对齐）。 */}
      {/* 进度行（M7-11 计数行档收编 shared LIST_COUNT_CLASS，原内联同值）。 */}
      <div className={LIST_COUNT_CLASS}>{progress}</div>
      {summary !== null && <GroupSummaryChip summary={summary} />}
      {task.blocked && <BlockedPill blockedFrom={task.blockedFrom} />}
      {/* 文件夹行（十二轮 DA25 可点击 + 十三轮 DA26 目录标签 +
          十四轮 DA27 工作目录标签钮 + 十五轮 DA28 融入卡片）：
          十四轮用户「就显示工作目录就行，别显示具体路径了，
          别用灰色打底了不好看」——文案只留「工作目录」四字，
          完整路径仅在 title 悬浮提示；十五轮用户「还是不协调，
          修改一下更好融入卡片」——撤掉描边小按钮外壳（border/
          底色/内边距全去），改**幽灵文字钮**：常规字色 + hover
          下划线，与卡内其它文字行同权重、不再像外来件；点击 =
          宿主拉系统文件管理器，不冒泡到整卡。 */}
      {task.folder !== null && (
        <button
          type="button"
          title={`在文件管理器中打开：${task.folder}`}
          disabled={folderBusy === task.taskId}
          className="self-start cursor-pointer text-xs text-foreground underline-offset-2 hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            onOpenFolder(task.taskId);
          }}
        >
          工作目录
        </button>
      )}
      {folderError !== null && folderError.taskId === task.taskId && (
        <FormErrorNote>{folderError.message}</FormErrorNote>
      )}
      {/* 二十六轮 DA39：主任务卡开始的行内提示（跳过原因清单
          /部分成功计数，与详情页同槽语义——FormErrorNote 就地
          展示，不绕过）。 */}
      {startError !== null && startError.taskId === task.taskId && (
        <FormErrorNote>{startError.message}</FormErrorNote>
      )}
      {/* 底栏（十二轮 DA25 删除栏 + 十三轮 DA26 mt-auto 沉底 +
          十四轮 DA27 重构 + 十五轮 DA28 状态 pill 描边）：
          mt-auto 把底栏压到卡底——同一栅格行内内容行数不同的
          卡，底栏齐平；border-t 分区。十四轮起每卡常驻：左侧 =
          展示态 pill（用户「状态挪到卡片的左边下面」；
          rounded-[2px] 用户拍板「圆角改成 2px」），右侧 = 详情
          + 删除（用户「删除旁边加一个详情按钮」——详情每卡都
          有，整卡点击的等价显式入口；删除仍仅可删的卡渲染，
          deletableOf 与 host deleteTask 守卫同口径）。十五轮
          用户「优化一下左下角状态的样式，去掉放上去变淡，加上
          边框」——pill 加 --border 描边（BORDER_L1_CLASS 压过
          Badge 的 border-transparent）、hover 淡底（badge.tsx
          secondary 80% 淡化，D19c color-mix 任意值实现）以同色
          hover 压平（hover 后底色不变）；按钮区不冒泡——点详情/删除不触发整卡进
          详情。 */}
      <div
        className="mt-auto flex items-center justify-between gap-2 border-t border-solid pt-2"
        onClick={(e) => e.stopPropagation()}
      >
        <TaskStatusPill status={task.status} retryCount={task.retryCount} />
        <div className="flex items-center gap-1.5">
          {/* 二十六轮 DA39：主任务卡「开始」按钮（用户拍板
            「主任务需要加开始按钮，没看到加在那里」——DA38
            只加在详情页标题行，列表页看不到；点击逐个派发
            ready 小任务（host startGroupTask，跳过卡回传原因，
            行内就地提示）；底栏容器已有 stopPropagation，
            不触发整卡进详情。二十七轮 DA40：判据放宽——
            非终态（completed/cancelled 外）一律渲染（用户
            「还是没看到开始按钮」——终态才收，详情页同口径）。
            M3：状态窗口收拢 isTerminal 谓词（判定逐位等价）。
            二十八轮 DA41：渲染序改**组卡 [删除][开始]（开始
            最右）、顶层普通任务 [详情][删除] 逐位不变**——
            组卡整卡点击即进详情，「详情」钮对组卡是冗余件
            （用户「主任务不需要详情按钮」），开始钮挪到最右。 */}
          {task.kind !== 'group' && (
            <Button type="button" variant="outline" size="sm" onClick={onOpen}>
              详情
            </Button>
          )}
          {/* 删除（M7-4 收口 components/deleteButton，destructive 默认档）。 */}
          {deletable && <DeleteButton label="删除" onClick={onDelete} />}
          {task.kind === 'group' && !isTerminal(task.status) && subs.length > 0 && (
            <Button type="button" size="sm" disabled={startBusy === task.taskId} onClick={onStart}>
              开始
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
