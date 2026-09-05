/**
 * 任务 tab（2026-09-05 九轮 DA22 + 十轮 DA23 修订）：**任务列表页 ↔ 任务
 * 详情页**两级导航，编排全部收进详情页。列表页 = 组卡**状态概览**（头部
 * 信息 + 进度/汇总，不列小任务明细——整个任务列表点进主任务详情看，九轮
 * DA22；**无拖拽**，十轮 DA23 订正）+ 顶层任务分组行；详情页 = 返回条 +
 * 头部卡 + 编排（主任务：新增小任务 + 小任务卡片全套（卡槽/改删/**把手
 * 拖拽调序**——十轮 DA23：只有卡片左上 grip 把手可拖，卡身点击进小任务
 * 详情）+ 成员罗列条；任务：合同/时间线正文 + 卡槽 + 站点行）。导航状态
 * 复用 ui model drawerTaskId（语义 = 详情页选中的任务 id）；依赖
 * taskDrawer（详情正文）、features/tasks（拖拽指派）与 shared。
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
import { STATUS_GROUPS, displayStatusOf, groupDisplayOf, type GroupSummary } from '../../features/tasks/taskDisplayStatus';
import { Button } from '../../components/ui/button';
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
  MUTED_CLASS,
  Pill,
  dotClass,
} from './shared';

/** 原 styles.taskRow（任务行：l1 下边线 / 8px 圆角 / 指针）。 */
const TASK_ROW_CLASS = `cursor-pointer rounded-[8px] border-b border-solid px-2 py-2.5 ${BORDER_L1_CLASS}`;

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

/** 列表页组卡（九轮 DA22 状态概览）：整卡点击进主任务详情，无拖拽。 */
const GROUP_CARD_CLASS = `mb-2.5 cursor-pointer rounded-[8px] border border-solid bg-background px-3 py-2.5 ${BORDER_L1_CLASS}`;

/** 展示态徽标（docs/29 B.3 渲染位）：中性 pill（Badge secondary + 6px dot，
 * tone 按展示态逐格对表——29-M3 同桶异色）+ 重试计数 detail 小字。八轮 DA21
 * 页面化后列表行/组卡/详情页头部统一走展示态（原 TaskDrawer Dialog 的任务态
 * 精确文案随页面化撤除）。 */
function DisplayStatusPill({
  status,
  retryCount = 0,
  className,
}: {
  status: string;
  retryCount?: number;
  className?: string;
}): ReactNode {
  const d = displayStatusOf(status, retryCount);
  return (
    <span className={cn('inline-flex items-baseline gap-1.5 whitespace-nowrap', className)}>
      <Pill tone={d.tone}>{d.label}</Pill>
      {d.detail !== '' && <span className={MUTED_CLASS}>{d.detail}</span>}
    </span>
  );
}

/** 阻塞徽标（docs/36 建议 1）：wait + blockedFrom 非空的物化阻塞行内标记。 */
function BlockedPill({ blockedFrom }: { blockedFrom: number | null }): ReactNode {
  return (
    <span className="ml-1 inline-flex items-baseline whitespace-nowrap">
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
九轮 DA22 修订：列表页组卡只承状态概览）。列表页：对话任务区块 = 组卡状态
概览（头部 + 文件夹 + 进度/汇总 chip；**不列小任务明细**——用户九轮拍板
「任务卡片不展示任务详情和整个任务列表，需要点击进去再看到整个任务列表」），
整卡点击进主任务详情；列表上无任何编排 UI（卡槽/罗列条/拖拽/改删按钮全迁
详情）。
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

  const groups = team.tasks.filter((t) => t.kind === 'group');
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
        {task.blocked && <BlockedPill blockedFrom={task.blockedFrom} />}
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

      {/* docs/26 小任务删除确认弹窗：未领取（draft/ready）可删，host 校验。 */}
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
            <DialogTitle>删除小任务</DialogTitle>
            <DialogDescription className={MUTED_CLASS}>
              确定删除「#{deleteTarget?.taskId ?? ''} {deleteTarget?.subject ?? ''}」？未领取的
              任务删除后不可恢复。
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
                      {t.blocked && <BlockedPill blockedFrom={t.blockedFrom} />}
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
        {/* docs/26 对话任务：主任务（任务单）卡概览（八轮 DA21 页面化 +
        九轮 DA22 概览化：列表页无编排 UI、不列小任务明细——整卡点进
        主任务详情看整个任务列表，新增/改删/卡槽全在详情页）。 */}
        {groups.length > 0 && (
          <div className="mb-3.5">
            <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold leading-6 text-foreground">
              <span className={dotClass('info')} />
              对话任务
              <span className="text-xs font-normal text-muted-foreground">· {groups.length}</span>
            </div>
            {groups.map((group) => {
              // 九轮 DA22：列表页组卡只承**状态概览**（进度计数 + 汇总 chip），
              // 不列小任务明细——整个任务列表点进主任务详情页看（用户九轮
              // 拍板「任务卡片不展示任务详情和整个任务列表」）。计数/汇总与
              // 顺序无关，无需拓扑排序；十轮 DA23 订正：任务列表页无拖拽。
              const subs = team.tasks.filter((t) => t.parentId === group.taskId);
              const done = subs.filter((t) => t.status === 'completed').length;
              // docs/29 B.2 组卡汇总：ready 且有小任务时叠加汇总 chip（error >
              // doing > waiting > created；全 completed 不加——进度行已表达）。
              const summary =
                group.status === 'ready' && subs.length > 0 ? groupDisplayOf(subs) : null;
              // draft（批准前拆解中）不做汇总——只显示计数（B.2 规则尾部）。
              const progressText =
                group.status === 'draft'
                  ? `小任务 ${subs.length} 个`
                  : `小任务 ${done}/${subs.length} 完成`;
              return (
                <div
                  key={group.taskId}
                  className={GROUP_CARD_CLASS}
                  onClick={() => setSelectedTaskId(group.taskId)}
                >
                  <div>
                    <strong>#{group.taskId}</strong> {group.subject}
                    <DisplayStatusPill status={group.status} className="ml-1" />
                    <span className={cn(MUTED_CLASS, 'ml-1')}>· {progressText}</span>
                    {summary !== null && <GroupSummaryChip summary={summary} />}
                  </div>
                  {group.folder !== null && (
                    <div className={MUTED_CLASS}>文件夹：{group.folder}/</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {STATUS_GROUPS.map((group) => {
          // docs/26：主任务（group）在上方「对话任务」区块，小任务挂在组卡内
          // ——状态分组只列顶层普通任务。
          const rows = team.tasks.filter(
            (t) => group.statuses.includes(t.status) && t.parentId === null && t.kind !== 'group',
          );
          if (rows.length === 0) return null;
          return (
            <div key={group.id} className="mb-3.5">
              {/* D22e 任务页组头降噪：彩 pill → 中性文字 + 计数 + 彩色 6px dot。 */}
              <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold leading-6 text-foreground">
                <span className={dotClass(group.tone)} />
                {group.label}
                <span className="text-xs font-normal text-muted-foreground">· {rows.length}</span>
              </div>
              {rows.map((t) => (
                // 八轮 DA21：列表页顶层任务精简行（站点行/依赖 chips 迁详情），
                // 点击进任务详情页。
                <div
                  key={t.taskId}
                  className={TASK_ROW_CLASS}
                  onClick={() => setSelectedTaskId(t.taskId)}
                >
                  <div>
                    <strong>#{t.taskId}</strong> {t.subject}
                    {/* docs/29 B.3：展示态 pill（retryCount 并入 detail，
                  顶层行既有「重试 n」标记并入）；assignee 小字保留。 */}
                    <DisplayStatusPill
                      status={t.status}
                      retryCount={t.retryCount}
                      className="ml-1"
                    />
                    {t.blocked && <BlockedPill blockedFrom={t.blockedFrom} />}
                    {t.assignee !== null && (
                      <span className={cn(MUTED_CLASS, 'ml-1')}>· {t.assignee}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
        {team.tasks.length === 0 && (
          <div className={EMPTY_CLASS}>
            还没有任务。在对话中把任务交给团队，或计划批准后任务会出现在这里。
          </div>
        )}
        {dialogs}
      </div>
    </TaskDndProvider>
  );
}
