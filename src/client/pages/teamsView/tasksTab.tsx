/**
 * 任务 tab（2026-09-05 九…十五轮 DA22…DA28 修订）：**任务
 * 列表页 ↔ 任务详情页**两级导航，编排全部收进详情页。列表页 = **平铺小卡栅格**
 * （十一轮 DA24：不分「对话任务」/状态分区，与团队列表同款 Card 面板 + 任务
 * 小卡，一卡一顶层任务，整卡点击进详情，无拖拽；十二轮 DA25 修订：头行去
 * #id 前缀、信息逐行分行、卡片加大一档、文件夹路径去标签且**可点击**——
 * 宿主拉起系统文件管理器、可删的卡底栏放删除按钮（draft/ready 且无下游
 * 依赖/级联障碍，与 host deleteTask 守卫同口径）；十三轮 DA26 修订：卡内
 * 内容顶格对齐（阻塞徽标 ml-1 外置）、每卡必有进度行（无小任务显「小任务
 * 0」）、文件夹行恢复「目录」标签且只显示末段路径（全路径进悬停 title），
 * 底栏 mt-auto 沉底——同栅格行各卡删除栏齐平；十四轮 DA27 修订：展示态
 * pill 挪到卡底栏左侧且圆角收 2px、进度行改「共 x 个任务，已完成 x，未完成
 * x」（数字着色 success/warning）、文件夹行只留「工作目录」标签钮（路径全
 * 撤、去灰改描边钮）、底栏每卡常驻且加「详情」按钮（删除仍仅可删的卡渲染）；
 * 十五轮 DA28 修订：底栏状态 pill 加 --border 描边并压平 hover 淡底（badge
 * secondary 80% 淡化的同色 hover 压平）、文件夹行改幽灵文字钮融入卡片（border/
 * 底色/内边距全去，常规字色 + hover 下划线）；
 * 不列小任务明细——九轮
 * DA22）+ 空态行；详情页 = 返回条 + 头部卡 + 编排（主任务：新增小任务 +
 * 小任务卡片全套（卡槽/改删/**把手拖拽调序**——十轮 DA23：只有卡片左上
 * grip 把手可拖，卡身点击进小任务详情）+ 成员罗列条；任务：合同/时间线
 * 正文 + 卡槽 + 站点行）。导航状态复用 ui model drawerTaskId（语义 = 详情页
 * 选中的任务 id）；依赖 taskDrawer（详情正文）、features/tasks（拖拽指派）
 * 与 shared。
 *
 * @module dsh-eteams/client/pages/teamsView/tasksTab
 */
import { useState, type ReactNode } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import Plus from 'lucide-react/dist/esm/icons/plus.mjs';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left.mjs';
import GripVertical from 'lucide-react/dist/esm/icons/grip-vertical.mjs';
import {
  createTeamTask,
  deleteTeamTask,
  openTaskFolder,
  updateTeamTask,
  type TaskSlotInput,
} from '../../lib/api';
import { cn } from '../../lib/cn';
import { refreshActivitySoon, type TaskView, type TeamSnapshot } from '../../lib/monitor';
import {
  SUBTASK_DRAG_TYPE,
  TaskAssignDropBox,
  TaskDndProvider,
  TeamMemberStrip,
  type SubtaskDragItem,
} from '../../features/tasks/taskAssign';
import {
  boxCoversChain,
  chainAfterRemove,
  depPatchesForReorder,
  executionOrderOf,
} from '../../features/tasks/taskAssignCore';
import { displayStatusOf, groupDisplayOf, type GroupSummary } from '../../features/tasks/taskDisplayStatus';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { TaskDetailContent, TaskStations } from './taskDrawer';
import {
  BORDER_L1_CLASS,
  CHIP_CLASS,
  EMPTY_CLASS,
  FormErrorNote,
  LIST_COUNT_CLASS,
  LIST_TITLE_CLASS,
  MUTED_CLASS,
  PANEL_CARD_CLASS,
  Pill,
  TASK_GRID_CLASS,
} from './shared';

/** 七轮 DA20 + 十轮 DA23：小任务卡片——与组卡同观感的全边框卡（挂靠缩进
 * ml-4 保留），左上 grip 把手 = 唯一拖拽源，卡身兼放置目标（拖 A 到 B =
 * A 搬到 B 的执行位）。 */
const SUBTASK_CARD_CLASS = `mt-1.5 ml-4 cursor-pointer rounded-[8px] border border-solid bg-background px-3 py-2.5 ${BORDER_L1_CLASS}`;

/** 小任务卡片（七轮 DA20 调序 + 十轮 DA23 把手化）：**只有左上 grip 把手
 * 可拖**（'eteams-subtask'，draft/ready 才可拖，不可编辑态把手淡化），
 * 卡身不可拖——整卡点击 = 进小任务详情页（拖拽不触发 click）。整卡作为
 * 放置目标（同父兄弟卡才亮；drop 时 onReorder 以最新快照现算依赖改写补丁，
 * 非乐观更新）。拖拽中半透明、悬停 ring 高亮；执行序号徽标由调用方渲染。 */
function SubtaskCard({
  task,
  onReorder,
  onOpen,
  children,
}: {
  task: TaskView;
  onReorder: (fromTaskId: number, toTaskId: number) => void;
  onOpen: () => void;
  children: ReactNode;
}): ReactNode {
  const editable = task.status === 'draft' || task.status === 'ready';
  const [{ isDragging }, dragRef] = useDrag<
    SubtaskDragItem,
    unknown,
    { isDragging: boolean }
  >(
    () => ({
      type: SUBTASK_DRAG_TYPE,
      item: { taskId: task.taskId, parentId: task.parentId, editable },
      canDrag: () => editable,
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    }),
    [task.taskId, task.parentId, editable],
  );
  const [{ isOver }, dropRef] = useDrop<SubtaskDragItem, unknown, { isOver: boolean }>(
    () => ({
      accept: SUBTASK_DRAG_TYPE,
      canDrop: (item) =>
        item.editable &&
        item.taskId !== task.taskId &&
        item.parentId === task.parentId &&
        editable,
      drop: (item) => onReorder(item.taskId, task.taskId),
      collect: (monitor) => ({ isOver: monitor.isOver() && monitor.canDrop() }),
    }),
    [task.taskId, task.parentId, editable, onReorder],
  );
  return (
    <div
      ref={dropRef}
      className={cn(
        SUBTASK_CARD_CLASS,
        isDragging && 'opacity-50',
        isOver && 'ring-1 ring-primary',
      )}
      onClick={onOpen}
    >
      <div className="flex items-start gap-1.5">
        <span
          ref={dragRef}
          title="拖动调整执行顺序"
          className={cn(
            'mt-0.5 shrink-0',
            editable ? 'cursor-grab text-muted-foreground' : 'cursor-default opacity-40',
          )}
        >
          <GripVertical className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

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
 * 未入集任务依赖。host 仍是最终裁决，弹窗内就地显示拒绝原因。 */
function deletableOf(t: TaskView, tasks: readonly TaskView[]): boolean {
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

/** 展示态徽标（docs/29 B.3 渲染位）：中性 pill（Badge secondary + 6px dot，
 * tone 按展示态逐格对表——29-M3 同桶异色）+ 重试计数 detail 小字。八轮 DA21
 * 页面化后列表行/组卡/详情页头部统一走展示态（原 TaskDrawer Dialog 的任务态
 * 精确文案随页面化撤除）。十四轮 DA27：新增 pillClassName 直通内层 Pill——
 * 任务列表卡底栏的状态 pill 用 rounded-[2px]（用户拍板「圆角改成 2px」），
 * pill 挪到卡底栏左侧（「状态挪到卡片的左边下面」——十二轮「下面放删除
 * 按钮」同词汇，「下面」= 卡底栏）；十五轮 DA28 底栏位再叠 border-[--border]
 * 描边 + 同色 hover 压平 Badge 淡底（用户「去掉放上去变淡，加上边框」）；
 * 其余调用位不传保持原观感。 */
function DisplayStatusPill({
  status,
  retryCount = 0,
  className,
  pillClassName,
}: {
  status: string;
  retryCount?: number;
  className?: string;
  /** 直通内层 Pill 的类（tailwind-merge 压过基础圆角）。 */
  pillClassName?: string;
}): ReactNode {
  const d = displayStatusOf(status, retryCount);
  return (
    <span className={cn('inline-flex items-baseline gap-1.5 whitespace-nowrap', className)}>
      <Pill tone={d.tone} className={pillClassName}>
        {d.label}
      </Pill>
      {d.detail !== '' && <span className={MUTED_CLASS}>{d.detail}</span>}
    </span>
  );
}

/** 阻塞徽标（docs/36 建议 1）：wait + blockedFrom 非空的物化阻塞行内标记。
 * 十三轮 DA26：ml-1 不再内建——行内文字流场景（详情页）由调用位补 ml-1，
 * 列表卡独立行场景顶格与其它行对齐。 */
function BlockedPill({
  blockedFrom,
  className,
}: {
  blockedFrom: number | null;
  className?: string;
}): ReactNode {
  return (
    <span className={cn('inline-flex items-baseline whitespace-nowrap', className)}>
      <Pill tone="warn">阻塞中{blockedFrom !== null ? ` · 前置 #${blockedFrom}` : ''}</Pill>
    </span>
  );
}

/** 组卡汇总 chip（B.2 规则 2）：异常 chip 带前缀 ✕（「✕ n 项异常」，err 红
 * ——与行内 awaiting/needs_user pill 的 warning 黄同桶异色）+ 首个异常
 * detail 小字；执行中/等待执行/待指派按优先级降档。 */
function GroupSummaryChip({ summary }: { summary: GroupSummary }): ReactNode {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <Pill tone={summary.tone}>
        {summary.icon !== '' ? `${summary.icon} ${summary.label}` : summary.label}
      </Pill>
      {summary.detail !== '' && <span className={MUTED_CLASS}>{summary.detail}</span>}
    </span>
  );
}

/** 任务编辑/新增弹窗目标（docs/26）：group = 挂靠的主任务（任务单）；
 * task = 被编辑的小任务，null = 新增小任务。六轮 DA19：弹窗不再编排链
 * （成员槽编辑段撤除）——链增删调序只走任务行下方卡槽（＋多选/×/拖动）。 */
interface TaskEditTarget {
  group: TaskView;
  task: TaskView | null;
}

/** 任务 tab：**任务列表页 ↔ 任务详情页**两级导航（八轮 DA21，2026-09-05
用户拍板「将任务做成任务详情页面和任务列表页面，点击到详情再编排整个任务」；
九轮 DA22 修订：列表不列小任务明细；十一轮 DA24 修订：列表平铺小卡栅格）。
列表页：与团队列表同款 Card 面板 + **平铺任务小卡栅格**（不分「对话任务」/
状态分区——用户十一轮拍板「任务主列表不分对话任务、待指派这种，做成团队那种
小卡片」；一卡一顶层任务，整卡点击进详情；**不列小任务明细**——用户九轮拍板
「任务卡片不展示任务详情和整个任务列表，需要点击进去再看到整个任务列表」；
无编排 UI、无拖拽——卡槽/罗列条/改删按钮全迁详情）。
详情页（导航状态 = ui model drawerTaskId，语义「选中的任务 id」）：
- 主任务（group）详情 = **整个任务的编排面**：返回条 + 头部卡 + 新增小任务 +
  小任务卡片全套（执行序号/卡槽 TaskAssignDropBox/拖拽调执行顺序/修改删除）
  + 成员罗列条（单条）；
- 任务/小任务详情 = 头部卡（含小任务的修改/删除）+ 挂靠行 + 详情正文
  （TaskDetailContent：合同四数组/状态说明/阻塞/产出/尝试时间线）+ 卡槽
  （小任务可拖拽指派）+ 站点行 + 依赖 chips + 成员罗列条。
编辑/删除弹窗为组件内瞬态 useState（两页共用），保存/删除成功后
refreshActivitySoon 回拉快照；assignBusy/assignError/reorderError 瞬态错误
就地 FormErrorNote。 */
export function TasksTab({
  team,
  now,
  selectedTaskId,
  setSelectedTaskId,
}: {
  team: TeamSnapshot;
  now: number;
  selectedTaskId: number | null;
  setSelectedTaskId: (id: number | null) => void;
}): ReactNode {
  const [editTarget, setEditTarget] = useState<TaskEditTarget | null>(null);
  const [editSubject, setEditSubject] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskView | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // docs/29 拖拽指派瞬态（对齐 editBusy/editError 模式）：busy 按小任务
  // taskId 定位（框禁用 + 透明度），error 单槽记录受影响小任务（行内展示）。
  const [assignBusy, setAssignBusy] = useState<number | null>(null);
  const [assignError, setAssignError] = useState<{ taskId: number; message: string } | null>(null);
  // 七轮 DA20 拖卡调执行顺序瞬态：补丁按序逐发（dependencies 整体替换），
  // error 记落点卡（行内展示，同 assignError 模式）。
  const [reorderError, setReorderError] = useState<{ taskId: number; message: string } | null>(
    null,
  );
  // 十二轮 DA25 文件夹打开瞬态（对齐 assignError 模式）：error 按卡定位行内
  // 展示（宿主 404/400/500 原样透出——文件夹缺失等）。
  const [folderBusy, setFolderBusy] = useState<number | null>(null);
  const [folderError, setFolderError] = useState<{ taskId: number; message: string } | null>(null);
  const editingTask = editTarget !== null && editTarget.task !== null ? editTarget.task : null;

  const openEdit = (group: TaskView, task: TaskView | null): void => {
    setEditTarget({ group, task });
    setEditSubject(task?.subject ?? '');
    setEditDesc(task?.description ?? '');
    setEditError(null);
  };
  const closeEdit = (): void => {
    setEditTarget(null);
    setEditError(null);
  };
  const saveEdit = async (): Promise<void> => {
    const target = editTarget;
    if (target === null) return;
    // 六轮 DA19：弹窗不再编排链——update 不发 chain（host 不改链，卡槽为
    // 链编排唯一入口）；新增不带 chain（建后经卡槽添加）。
    setEditBusy(true);
    setEditError(null);
    try {
      if (target.task === null) {
        await createTeamTask(team.teamId, {
          subject: editSubject.trim(),
          ...(editDesc.trim() !== '' ? { description: editDesc.trim() } : {}),
          parentTaskId: target.group.taskId,
        });
      } else {
        await updateTeamTask(team.teamId, target.task.taskId, {
          subject: editSubject.trim(),
          description: editDesc.trim(),
        });
      }
      setEditTarget(null);
      refreshActivitySoon();
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      setEditBusy(false);
    }
  };
  const confirmDelete = async (): Promise<void> => {
    const target = deleteTarget;
    if (target === null) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteTeamTask(team.teamId, target.taskId);
      setDeleteTarget(null);
      refreshActivitySoon();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleteBusy(false);
    }
  };
  // 拖拽指派提交（DA10/A.4）：新链由 TaskAssignDropBox 在 drop 时刻以最新
  // 快照的 chain 现算（不缓存旧链），这里只整链重发 updateTeamTask——
  // 非乐观更新，成功后 refreshActivitySoon 立即回拉；失败行内就地显示。
  const submitAssignChain = async (taskId: number, chain: TaskSlotInput[]): Promise<void> => {
    setAssignBusy(taskId);
    setAssignError((cur) => (cur !== null && cur.taskId === taskId ? null : cur));
    try {
      await updateTeamTask(team.teamId, taskId, { chain });
      refreshActivitySoon();
    } catch (e) {
      setAssignError({ taskId, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setAssignBusy(null);
    }
  };

  // 拖卡调执行顺序（七轮 DA20；十轮 DA23 订正：拖拽只在小任务卡把手——
  // 任务列表页无拖拽）：补丁由 depPatchesForReorder 以全量 team.tasks 现算
  // （兄弟集按同 parentId 从传入数组取），线性链改写只含 deps 实际变化且
  // draft/ready 的卡，按序逐发 updateTeamTask({dependencies})——非乐观更新；
  // 部分失败也回拉快照对齐。
  const submitReorder = async (
    fromTaskId: number,
    toTaskId: number,
  ): Promise<void> => {
    const patches = depPatchesForReorder(team.tasks, fromTaskId, toTaskId);
    if (patches === null) return;
    setReorderError(null);
    try {
      for (const patch of patches) {
        await updateTeamTask(team.teamId, patch.taskId, { dependencies: patch.dependencies });
      }
      refreshActivitySoon();
    } catch (e) {
      setReorderError({ taskId: toTaskId, message: e instanceof Error ? e.message : String(e) });
      refreshActivitySoon();
    }
  };

  // 十二轮 DA25：打开任务文件夹（列表卡文件夹路径点击）。非乐观：成功无
  // 回执 UI（文件管理器窗口即回执），失败按卡行内 FormErrorNote。
  const openFolder = async (taskId: number): Promise<void> => {
    setFolderBusy(taskId);
    setFolderError((cur) => (cur !== null && cur.taskId === taskId ? null : cur));
    try {
      await openTaskFolder(team.teamId, taskId);
    } catch (e) {
      setFolderError({ taskId, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setFolderBusy(null);
    }
  };

  // 八轮 DA21 导航：selectedTaskId（ui model drawerTaskId）非空 = 详情页；
  // 选中任务被删（快照里已无此 id）自动回落列表页。
  const selected =
    selectedTaskId === null
      ? null
      : (team.tasks.find((t) => t.taskId === selectedTaskId) ?? null);
  // 返回列表条（详情页顶部；ArrowLeft + 可点击文字）。
  const backBar = (
    <button
      type="button"
      className="mb-2.5 inline-flex cursor-pointer items-center gap-1 text-sm leading-6 text-muted-foreground hover:text-foreground"
      onClick={() => setSelectedTaskId(null)}
    >
      <ArrowLeft className="h-4 w-4" />
      返回列表
    </button>
  );
  // 详情页头部卡（主任务/任务共用：#id 主题 + 展示态 pill + blocked + assignee）。
  const detailHeader = (task: TaskView): ReactNode => (
    <div
      className={cn(
        'rounded-[8px] border border-solid bg-background px-3 py-2.5',
        BORDER_L1_CLASS,
      )}
    >
      <div>
        <strong>#{task.taskId}</strong> {task.subject}
        <DisplayStatusPill status={task.status} retryCount={task.retryCount} className="ml-1" />
        {task.blocked && <BlockedPill blockedFrom={task.blockedFrom} className="ml-1" />}
        {task.assignee !== null && (
          <span className={cn(MUTED_CLASS, 'ml-1')}>· {task.assignee}</span>
        )}
      </div>
      {task.folder !== null && <div className={MUTED_CLASS}>文件夹：{task.folder}/</div>}
    </div>
  );
  // 详情页成员罗列条（八轮 DA21：编排收进详情，罗列条随编排走——仅
  // 存在可放置任务（draft/ready）时渲染，作为卡槽的拖拽源）。
  const detailStrip = (show: boolean): ReactNode =>
    show ? <TeamMemberStrip team={team} /> : null;

  // 共用弹窗（列表/详情两页都挂）：编辑/新增 + 删除确认。瞬态 useState
  // 不入 ui model；host 校验合同冻结（领取后），错误就地显示。
  const dialogs = (
    <>
      {/* docs/26 小任务编辑/新增弹窗：主题 + 说明（六轮 DA19：成员槽编辑
      段撤除——链编排只走任务行下方卡槽：＋多选 / × / chip 拖动调序）。
      新增时空表单。 */}
      <Dialog
        open={editTarget !== null}
        onOpenChange={(next) => {
          if (!next) closeEdit();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle>
              {editingTask !== null ? `修改 #${editingTask.taskId}` : '新增小任务'}
            </DialogTitle>
            <DialogDescription className={MUTED_CLASS}>
              挂靠任务单 #{editTarget?.group.taskId ?? ''}（{editTarget?.group.subject ?? ''}
              ）；成员接力请在详情页小任务卡下方的卡槽中拖放或点「＋」添加。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2.5">
            <Input
              value={editSubject}
              autoFocus
              placeholder="小任务主题"
              onChange={(e) => setEditSubject(e.target.value)}
            />
            <Textarea
              value={editDesc}
              rows={2}
              placeholder="说明 / 验收要点（可空）"
              onChange={(e) => setEditDesc(e.target.value)}
            />
            {editError !== null && <FormErrorNote>{editError}</FormErrorNote>}
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={editBusy}
                onClick={closeEdit}
              >
                取消
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={editBusy || editSubject.trim() === ''}
                onClick={() => void saveEdit()}
              >
                {editingTask !== null ? '保存' : '新增'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 任务删除确认弹窗（十二轮 DA25 共用面扩大：列表卡删除 + 详情页
      小任务删除；标题去「小任务」限定，主任务追加级联提示）。未领取
      （draft/ready）可删，host 校验，拒绝原因就地显示。 */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle>删除任务</DialogTitle>
            <DialogDescription className={MUTED_CLASS}>
              确定删除「{deleteTarget?.subject ?? ''}」？
              {deleteTarget?.kind === 'group' ? '主任务将级联删除全部小任务，' : ''}
              未领取的任务删除后不可恢复。
            </DialogDescription>
          </DialogHeader>
          {deleteError !== null && <FormErrorNote>{deleteError}</FormErrorNote>}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={deleteBusy}
              onClick={() => {
                setDeleteTarget(null);
                setDeleteError(null);
              }}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={deleteBusy}
              onClick={() => void confirmDelete()}
            >
              删除
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );

  // ---- 主任务（group）详情页 = 整个任务的编排面（八轮 DA21）：返回条 +
  // 头部卡 + 新增小任务 + 小任务卡片全套（执行序号/卡槽/把手拖拽调序（十轮
  // DA23）/改删）+ 成员罗列条。小任务卡点击 → 小任务详情页。
  if (selected !== null && selected.kind === 'group') {
    // 七轮 DA20：小任务按执行序展示（兄弟依赖拓扑序，创建序平局）。
    const subs = executionOrderOf(team.tasks.filter((t) => t.parentId === selected.taskId));
    const done = subs.filter((t) => t.status === 'completed').length;
    const mutable = selected.status === 'draft' || selected.status === 'ready';
    // docs/29 B.2 组卡汇总：ready 且有小任务时叠加汇总 chip。
    const summary = selected.status === 'ready' && subs.length > 0 ? groupDisplayOf(subs) : null;
    const progressText =
      selected.status === 'draft'
        ? `小任务 ${subs.length} 个`
        : `小任务 ${done}/${subs.length} 完成`;
    return (
      <TaskDndProvider>
        <div>
          {backBar}
          {detailHeader(selected)}
          <div className={cn(MUTED_CLASS, 'mt-1')}>
            · {progressText}
            {summary !== null && <GroupSummaryChip summary={summary} />}
          </div>
          {mutable && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-1.5"
              onClick={() => openEdit(selected, null)}
            >
              <Plus className="h-3.5 w-3.5" />
              新增小任务
            </Button>
          )}
          {subs.map((t, subIndex) => {
            const subMutable = t.status === 'draft' || t.status === 'ready';
            // docs/29 DA5/DA13：可编辑窗口内成员框承整链（boxCoversChain）
            // ——站点行与框内容重合，抑制 TaskStations。
            const suppressStations = boxCoversChain(t);
            return (
              <div key={t.taskId}>
                <SubtaskCard
                  task={t}
                  onReorder={(from, to) => void submitReorder(from, to)}
                  onOpen={() => setSelectedTaskId(t.taskId)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <span className={cn(MUTED_CLASS, 'mr-0.5')}>{subIndex + 1}.</span>
                      <strong>#{t.taskId}</strong> {t.subject}
                      <DisplayStatusPill status={t.status} className="ml-1" />
                      {t.blocked && <BlockedPill blockedFrom={t.blockedFrom} className="ml-1" />}
                      {t.assignee !== null && (
                        <span className={cn(MUTED_CLASS, 'ml-1')}>· {t.assignee}</span>
                      )}
                    </div>
                    <div
                      className="flex shrink-0 items-center gap-1.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {subMutable && (
                        <div className="flex shrink-0 gap-1.5">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => openEdit(selected, t)}
                          >
                            修改
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setDeleteTarget(t)}
                          >
                            删除
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                  {/* docs/29 A.8（四轮 DA17）：成员卡槽在任务卡下方独立一行
                    （拖拽指派 drop target；点击不冒泡到卡）。 */}
                  <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
                    <TaskAssignDropBox
                      task={t}
                      members={team.members}
                      busy={assignBusy === t.taskId}
                      onAssign={(chain) => void submitAssignChain(t.taskId, chain)}
                      onRemoveStation={(index) =>
                        void submitAssignChain(t.taskId, chainAfterRemove(t, index))
                      }
                      onOpenEdit={() => openEdit(selected, t)}
                    />
                  </div>
                  {!suppressStations && <TaskStations task={t} />}
                </SubtaskCard>
                {assignError !== null && assignError.taskId === t.taskId && (
                  <FormErrorNote className="ml-4">{assignError.message}</FormErrorNote>
                )}
                {reorderError !== null && reorderError.taskId === t.taskId && (
                  <FormErrorNote className="ml-4">{reorderError.message}</FormErrorNote>
                )}
              </div>
            );
          })}
          {detailStrip(subs.some((t) => t.status === 'draft' || t.status === 'ready'))}
          {dialogs}
        </div>
      </TaskDndProvider>
    );
  }

  // ---- 任务/小任务详情页（八轮 DA21）：返回条 + 头部卡（小任务含修改/
  // 删除）+ 挂靠行 + 详情正文（合同/时间线）+ 卡槽（小任务可拖拽指派）+
  // 站点行 + 依赖 chips + 成员罗列条。
  if (selected !== null) {
    const parent =
      selected.parentId !== null
        ? (team.tasks.find((t) => t.taskId === selected.parentId) ?? null)
        : null;
    const subMutable = selected.status === 'draft' || selected.status === 'ready';
    return (
      <TaskDndProvider>
        <div>
          {backBar}
          {detailHeader(selected)}
          {parent !== null && (
            <div className={cn(MUTED_CLASS, 'mt-1')}>
              挂靠：#{parent.taskId} {parent.subject}
            </div>
          )}
          {parent !== null && subMutable && (
            <div className="mt-1.5 flex gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => openEdit(parent, selected)}
              >
                修改
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDeleteTarget(selected)}
              >
                删除
              </Button>
            </div>
          )}
          <div className="mt-2.5">
            <TaskDetailContent team={team} task={selected} now={now} />
          </div>
          <TaskStations task={selected} />
          {selected.dependencies.length > 0 && (
            <div className="mt-[3px]">
              {selected.dependencies.map((d) => (
                <span key={d} className={CHIP_CLASS}>
                  依赖 {d}
                </span>
              ))}
            </div>
          )}
          {parent !== null && subMutable && (
            <div className="mt-2">
              <TaskAssignDropBox
                task={selected}
                members={team.members}
                busy={assignBusy === selected.taskId}
                onAssign={(chain) => void submitAssignChain(selected.taskId, chain)}
                onRemoveStation={(index) =>
                  void submitAssignChain(selected.taskId, chainAfterRemove(selected, index))
                }
                onOpenEdit={() => openEdit(parent, selected)}
              />
            </div>
          )}
          {assignError !== null && assignError.taskId === selected.taskId && (
            <FormErrorNote className="ml-4">{assignError.message}</FormErrorNote>
          )}
          {detailStrip(parent !== null && subMutable)}
          {dialogs}
        </div>
      </TaskDndProvider>
    );
  }

  // docs/29 DA2：DndProvider 只包 TasksTab（消费面唯一，单实例单 Provider，
  // 随 tab 卸载销毁；1s 轮询只换数据不重挂 Provider）。
  return (
    <TaskDndProvider>
      <div>
        {/* 十一…十五轮 DA24…DA28：任务主列表**平铺小卡栅格**（用户十一轮拍板
        「任务主列表不分对话任务、待指派这种，做成团队那种小卡片」；十二轮
        修订「去掉 #1 这种，文件夹左边…做成可以点击的，卡片再大一点，分行，
        下面放删除按钮」；十三轮修订「任务卡片内容对齐，没有小任务就显示0，
        而且目录两个字没有了，路径太长了截断大部分的」；十四轮修订「状态挪到
        卡片的左边下面，圆角改成 2px／目录样式调整一下，就显示工作目录就行，
        别显示具体路径了，别用灰色打底了不好看／别小任务 个了，改成 共 x 个
        任务，已完成 x , 未完成 x 数字用颜色标识一下／删除旁边加一个详情
        按钮」；十五轮修订「优化一下左下角状态的样式，去掉放上去变淡，加上
        边框／工作目录还是不协调，修改一下更好融入卡片」）——撤掉「对话任务」
        区块与 STATUS_GROUPS 十态分区，顶层任务（主任务 + 顶层普通任务）
        一卡一任务平铺进 Card 面板栅格（TASK_GRID_CLASS 260px 加大一档）；
        整卡点击进详情（主任务 → 主任务详情、普通任务 → 任务详情），无拖拽
        （十轮订正）；文件夹路径点击 = 宿主拉起系统文件管理器，删除按钮仅可删
        的卡渲染。九轮 DA22 口径不变：不列小任务明细，小任务列表在主任务详情页。 */}
        {(() => {
          // 平铺列表 = 全部顶层任务（主任务 + 顶层普通任务，快照序）。
          const mainTasks = team.tasks.filter((t) => t.parentId === null);
          if (mainTasks.length === 0) {
            return (
              <div className={EMPTY_CLASS}>
                还没有任务。在对话中把任务交给团队，或计划批准后任务会出现在这里。
              </div>
            );
          }
          return (
            <Card className={cn(PANEL_CARD_CLASS, 'pb-3')}>
              <div className="mb-2.5 flex items-center gap-2">
                <h3 className={LIST_TITLE_CLASS}>任务</h3>
                <span className={LIST_COUNT_CLASS}>{mainTasks.length} 个</span>
              </div>
              <div className={TASK_GRID_CLASS}>
                {mainTasks.map((t) => {
                  // 组卡进度：小任务计数与汇总（九轮 DA22 概览口径——只计数
                  // 不列明细；draft 只显示个数，ready 且有明细时叠加汇总）。
                  const subs = t.kind === 'group'
                    ? team.tasks.filter((s) => s.parentId === t.taskId)
                    : [];
                  const done = subs.filter((s) => s.status === 'completed').length;
                  const summary =
                    t.kind === 'group' && t.status === 'ready' && subs.length > 0
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
                      {t.kind !== 'group' && t.assignee !== null ? ` · 指派 ${t.assignee}` : ''}
                    </>
                  );
                  const deletable = deletableOf(t, team.tasks);
                  return (
                    <div
                      key={t.taskId}
                      className={cn('eteams-task-card', TASK_CARD_CLASS)}
                      onClick={() => setSelectedTaskId(t.taskId)}
                    >
                      {/* 头行：主题（十四轮 DA27：展示态 pill 挪出头部——用户
                          「状态挪到卡片的左边下面」，入底栏左侧；十二轮 DA25
                          已去 #id 前缀）。 */}
                      <div className="truncate text-sm font-semibold text-foreground">
                        {t.subject}
                      </div>
                      {/* 信息分行（十二轮 DA25 分行 + 十三轮 DA26 统一渲染）：
                        进度/汇总 chip/阻塞各自独立行，每卡都有进度行（对齐）。 */}
                      <div className="text-xs text-muted-foreground">{progress}</div>
                      {summary !== null && <GroupSummaryChip summary={summary} />}
                      {t.blocked && <BlockedPill blockedFrom={t.blockedFrom} />}
                      {/* 文件夹行（十二轮 DA25 可点击 + 十三轮 DA26 目录标签 +
                          十四轮 DA27 工作目录标签钮 + 十五轮 DA28 融入卡片）：
                          十四轮用户「就显示工作目录就行，别显示具体路径了，
                          别用灰色打底了不好看」——文案只留「工作目录」四字，
                          完整路径仅在 title 悬浮提示；十五轮用户「还是不协调，
                          修改一下更好融入卡片」——撤掉描边小按钮外壳（border/
                          底色/内边距全去），改**幽灵文字钮**：常规字色 + hover
                          下划线，与卡内其它文字行同权重、不再像外来件；点击 =
                          宿主拉系统文件管理器，不冒泡到整卡。 */}
                      {t.folder !== null && (
                        <button
                          type="button"
                          title={`在文件管理器中打开：${t.folder}`}
                          disabled={folderBusy === t.taskId}
                          className="self-start cursor-pointer text-xs text-foreground underline-offset-2 hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            void openFolder(t.taskId);
                          }}
                        >
                          工作目录
                        </button>
                      )}
                      {folderError !== null && folderError.taskId === t.taskId && (
                        <FormErrorNote>{folderError.message}</FormErrorNote>
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
                        className="mt-auto flex items-center justify-between gap-2 border-t border-solid pt-2.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <DisplayStatusPill
                          status={t.status}
                          retryCount={t.retryCount}
                          pillClassName={`rounded-[2px] ${BORDER_L1_CLASS} hover:bg-[color:var(--eteams-pill-bg)]`}
                        />
                        <div className="flex items-center gap-1.5">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setSelectedTaskId(t.taskId)}
                          >
                            详情
                          </Button>
                          {deletable && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="text-destructive hover:text-destructive"
                              onClick={() => setDeleteTarget(t)}
                            >
                              删除
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })()}
        {dialogs}
      </div>
    </TaskDndProvider>
  );
}
