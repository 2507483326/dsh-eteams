/**
 * 任务列表页小卡（2026-09-05 三十一轮 DA44④ 自 tasksTab 纯移动抽离）：
 * TASK_CARD_CLASS + deletableOf（私有，仅本文件消费）+ TaskListCard，承载
 * 列表卡身（头行/信息行/文件夹行/底栏）；subs 统计与 deletable 判据在卡内
 * 现算（task/allTasks 进 props）。原注释逐字随迁（纯移动、零行为变更）。
 *
 * 用户迭代 2026-09-10「任务页平铺全部任务（跨队聚合）」：卡身带会话归属
 * 语义——当前会话创建的任务（currentSession）头行前置「本会话」徽标、
 * 整卡点击进详情；其它任务（其它会话建的）点击**不进**详情，底栏「详情」
 * 钮位换成「跳转会话」钮（canJump = 目标会话在会话列表里，经客户端
 * sessions.open 切换；目标不在列表/无会话快照的卡两钮皆无、纯展示）。
 *
 * 用户迭代 2026-09-11「创建中不允许点进去，加上创建中 loading 效果」：
 * creating 容器（面板手动创建、待完善收口）整卡禁点——完善中进详情无意义
 * （子任务尚未落库，收口瞬间结构可能塌缩成普通任务面，成员条/小任务列表
 * 一起消失）；进度计数行换 CreatingLoadingRow（loader + 「正在完善任务…」）。
 * 删除钮照旧保留：创建中是手动建任务占位的逃生门（docs/panelTaskCommission）。
 *
 * @module dsh-eteams/client/pages/tasks/taskListCard
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { TaskView } from '../../lib/monitor';
import { groupDisplayOf, isGroupStartable } from '../../features/tasks/taskDisplayStatus';
import { DeleteButton } from '../../components/deleteButton';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import {
  CreatingLoadingRow,
  FormErrorNote,
  GroupSummaryChip,
  TaskStatusPill,
} from '../shared/components';
import { LIST_COUNT_CLASS } from '../shared/styles';

/** 列表页任务小卡（十一轮 DA24 与团队列表小卡同款三段式，十二轮 DA25 修订：
 * 头行（主题截断，**无 #id 前缀**）、信息**逐行分行**（进度行/汇总 chip 行/
 * 阻塞行各自独立）、文件夹行（点击打开）、底栏（border-t 分区）；十三轮 DA26
 * 修订：内容行顶格对齐、每卡必有进度行（无小任务显「小任务 0」）、底栏
 * mt-auto 沉底；十四轮 DA27 修订：底栏每卡常驻——左状态 pill（圆角 2px）+
 * 右详情/删除钮（删除仍仅可删的卡渲染）、进度行改共/已完成/未完成三计数
 * （数字着色）、文件夹行「工作目录」标签钮；十五轮 DA28 修订：状态 pill
 * 描边压平 hover、工作目录改幽灵文字钮；底色/边框/悬停由 .eteams-task-card
 * 样式表接管，p-3.5 = 卡内高度呼吸感）。cursor-pointer 移出常量——
 * 2026-09-10 起只有当前会话卡整卡可点（其它任务卡不可点进详情，见头注）；
 * 2026-09-11 起创建中卡也不可点（见头注）。 */
const TASK_CARD_CLASS = 'flex min-w-0 flex-col gap-2 rounded-xl p-3.5';

/** 列表卡删除按钮显隐判据（十二轮 DA25，用户拍板「仅可删除的卡显示」）——
 * 与 host deleteTask 守卫（assignment.ts）同口径：本身 creating/ready
 * （docs/panelTaskCommission：creating 仅容器分支放宽——创建中的容器是
 * 手动建任务占位、计划未定，删除 = 逃生门；小任务分支判据不动）；主任务
 * 级联删除要求全部小任务 ready；删除集（自身 + 小任务）不得被任何
 * 未入集任务依赖。host 仍是最终裁决，弹窗内就地显示拒绝原因。
 * （M3：改具名导出供 tests/taskListCard.test.ts 锁定镜像口径——判定式
 * 一字未动。） */
export function deletableOf(t: TaskView, tasks: readonly TaskView[]): boolean {
  if (t.status !== 'creating' && t.status !== 'ready') return false;
  const doomedIds = new Set<number>([t.taskId]);
  for (const sub of tasks) {
    if (sub.parentId !== t.taskId) continue;
    if (sub.status !== 'ready') return false;
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
 * onStart；folderError/startError 行内就地显示（瞬态槽在 tasksTab）。
 * 2026-09-10 会话归属语义：currentSession 卡（当前会话建的）整卡可点 +
 * 头行「本会话」徽标；其它卡整卡不可点，「详情」钮位换「跳转会话」钮
 * （canJump 门控，onJump 经 sessions.open 落地）。 */
export function TaskListCard({
  task,
  allTasks,
  currentSession,
  canJump,
  folderBusy,
  folderError,
  startError,
  startBusy,
  onOpen,
  onJump,
  onOpenFolder,
  onDelete,
  onStart,
}: {
  task: TaskView;
  allTasks: TaskView[];
  /** 本卡是否为当前会话创建的任务（面板 sessionId 与任务主会话快照比对）。 */
  currentSession: boolean;
  /** 目标会话是否可跳转（在客户端会话列表里）——仅非当前会话卡消费。 */
  canJump: boolean;
  folderBusy: number | null;
  folderError: { taskId: number; message: string } | null;
  startError: { taskId: number; message: string } | null;
  startBusy: number | null;
  onOpen: () => void;
  onJump: () => void;
  onOpenFolder: (taskId: number) => void;
  onDelete: () => void;
  onStart: () => void;
}): ReactNode {
  // 组卡进度：小任务计数与汇总（九轮 DA22 概览口径——只计数
  // 不列明细；ready 且有明细时叠加汇总）。
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
  // 创建中容器禁点（用户迭代 2026-09-11「创建中不允许点进去」）：完善收口前
  // 进详情无意义（见头注）；删除钮照旧（逃生门）。判据在卡内现算，调用位只
  // 需照旧传 onOpen（不新增 props，禁止进详情的规则收口在本卡）。
  const creating = task.status === 'creating';
  const openable = currentSession && !creating;
  return (
    // 整卡点击只对可进的当前会话卡生效（其它任务不进详情——2026-09-10 口径；
    // 创建中禁点——2026-09-11 口径）；不可点卡身不加 cursor-pointer
    // （悬停语义与行为一致）。
    <div
      className={cn('eteams-task-card', TASK_CARD_CLASS, openable ? 'cursor-pointer' : 'cursor-default')}
      onClick={openable ? onOpen : undefined}
    >
      {/* 头行：主题（十四轮 DA27：展示态 pill 挪出头部——用户
          「状态挪到卡片的左边下面」，入底栏左侧；十二轮 DA25
          已去 #id 前缀）。2026-09-10：当前会话卡在主题前挂
          「本会话」徽标（compact 档——shrink-0 防挤压换行，
          主题本体 truncate 收窄）。 */}
      <div className="flex min-w-0 items-center gap-1.5">
        {currentSession && (
          <Badge variant="default" className="shrink-0 rounded-[2px] px-1.5 py-0 text-[10px] font-medium">
            本会话
          </Badge>
        )}
        <div className="truncate text-sm font-semibold text-foreground">{task.subject}</div>
      </div>
      {/* 信息分行（十二轮 DA25 分行 + 十三轮 DA26 统一渲染）：
        进度/汇总 chip/阻塞各自独立行，每卡都有进度行（对齐）。 */}
      {/* 进度行（M7-11 计数行档收编 shared LIST_COUNT_CLASS，原内联同值）；
          创建中换加载行（2026-09-11）：完善收口前子任务未落库、计数恒 0
          无信息量，改用 CreatingLoadingRow 交代「正在完善」。 */}
      {creating ? <CreatingLoadingRow /> : <div className={LIST_COUNT_CLASS}>{progress}</div>}
      {summary !== null && <GroupSummaryChip summary={summary} />}
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
        {/* 状态 pill（docs/panelTaskCommission）。用户迭代 2026-09-11：原 pill
        旁 14px 小 loader 撤除——创建中加载观感上移到卡身进度行
        CreatingLoadingRow（同一加载信号不留两处冗余呈现，pill 只担状态文案）。 */}
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
            （用户「主任务不需要详情按钮」），开始钮挪到最右。
            docs/panelTaskCommission：判据收拢 isGroupStartable——creating
            容器（手动建任务占位）计划未定不渲染开始钮（与宿主 startGroup
            Task 同闸镜像），终态照旧收。2026-09-10：「详情」钮仅当前
            会话卡渲染；其它会话卡同位渲染「跳转会话」钮（canJump 门控
            ——目标会话已不在会话列表的卡无此钮，纯展示）。2026-09-11：
            详情钮同禁创建中（显式闸——creating 恒为 group 分支本就无此
            钮，闸在此防 kind 判据将来变动时漏出进详情的旁路）。 */}
          {currentSession && task.kind !== 'group' && !creating && (
            <Button type="button" variant="outline" size="sm" onClick={onOpen}>
              详情
            </Button>
          )}
          {!currentSession && canJump && (
            <Button type="button" variant="outline" size="sm" onClick={onJump}>
              跳转会话
            </Button>
          )}
          {/* 删除（M7-4 收口 components/deleteButton，destructive 默认档）。 */}
          {deletable && <DeleteButton label="删除" onClick={onDelete} />}
          {task.kind === 'group' && isGroupStartable(task.status) && subs.length > 0 && (
            <Button type="button" size="sm" disabled={startBusy === task.taskId} onClick={onStart}>
              开始
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
