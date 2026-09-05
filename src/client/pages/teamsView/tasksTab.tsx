/**
 * 任务 tab：分组任务清单 + 编辑/删除弹窗 + 展示态徽标（docs/26/docs/29）。
 * 符号自 eteamsView.tsx 原样搬出（docs/32 32.5.1 纯移动、零行为变更），
 * 依赖 taskDrawer（详情抽屉）、features/tasks（拖拽指派 + 展示态）与 shared。
 *
 * @module dsh-eteams/client/pages/teamsView/tasksTab
 */
import { useState, type ReactNode } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import Plus from 'lucide-react/dist/esm/icons/plus.mjs';
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
import { TaskDrawer, TaskStations } from './taskDrawer';
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

/** 七轮 DA20：小任务卡片——与组卡同观感的全边框卡（挂靠缩进 ml-4 保留），
 * 兼作拖拽源/放置目标（拖 A 到 B = A 搬到 B 的执行位）。 */
const SUBTASK_CARD_CLASS = `mt-1.5 ml-4 cursor-pointer rounded-[8px] border border-solid bg-background px-3 py-2.5 ${BORDER_L1_CLASS}`;

/** 小任务卡片（七轮 DA20）：拖拽源（eteams-subtask，draft/ready 才可拖）+
 * 放置目标（同父兄弟卡才亮；drop 时 onReorder 以最新快照现算依赖改写补丁，
 * 非乐观更新）。拖拽中半透明、悬停 ring 高亮；执行序号徽标由调用方渲染；
 * 点击整卡 = 开合详情抽屉（拖拽不触发 click）。 */
function SubtaskCard({
  task,
  onReorder,
  onToggle,
  children,
}: {
  task: TaskView;
  onReorder: (fromTaskId: number, toTaskId: number) => void;
  onToggle: () => void;
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
      ref={(node) => {
        dragRef(node);
        dropRef(node);
      }}
      className={cn(
        SUBTASK_CARD_CLASS,
        isDragging && 'opacity-50',
        isOver && 'ring-1 ring-primary',
      )}
      onClick={onToggle}
    >
      {children}
    </div>
  );
}

/** 展示态徽标（docs/29 B.3 渲染位）：中性 pill（Badge secondary + 6px dot，
 * tone 按展示态逐格对表——29-M3 同桶异色）+ 重试计数 detail 小字。TaskDrawer
 * 与任务详情**保留任务态精确文案**（STATUS_LABELS），展示态只用于任务行/
 * 组卡/分组头。 */
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

/** 任务：按状态分组的任务清单（原「任务」）。S13 Tailwind 化：分组头 pill、
任务行、依赖芯片与空态全迁 Tailwind 类；详情抽屉为 shadcn Dialog（见
TaskDrawer），开合仍走 ui model 的 setExpandedTask。
docs/26 对话任务：顶部「对话任务」区块渲染 kind==='group' 的主任务（任务
单）卡 + 嵌套小任务行；小任务在 draft/ready（未领取）时面板可改删——修
改弹窗（主题/说明；六轮 DA19 起不再编排链）与删除确认弹窗，主任务卡内可
新增小任务。编辑/删除弹窗为组件内瞬态 useState，不入 ui model；保存/删除
成功后 refreshActivitySoon 立即回拉快照。
docs/29 拖拽指派：根包 TaskDndProvider（单实例）；每张组卡下方成员罗列条
（拖拽源）+ 小任务行下方成员卡槽（TaskAssignDropBox，链编排唯一入口——
拖放追加/替换/调序、＋多选、×移除；整链重发 updateTeamTask、非乐观更新）；
assignBusy/assignError 瞬态同 editBusy/editError 模式，错误就地 FormErrorNote。
七轮 DA20：小任务渲染为全边框卡片（SubtaskCard），按执行序（兄弟依赖拓扑序）
展示并带序号；拖 A 卡到 B 卡 = 调执行顺序（depPatchesForReorder 现算依赖
改写补丁，逐发 updateTeamTask({dependencies})），reorderError 同模式。 */
export function TasksTab({
  team,
  now,
  expandedTask,
  setExpandedTask,
}: {
  team: TeamSnapshot;
  now: number;
  expandedTask: number | null;
  setExpandedTask: (id: number | null) => void;
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

  // 拖卡调执行顺序（七轮 DA20）：补丁由 depPatchesForReorder 以当前快照现算
  // （兄弟依赖线性链改写，只含 deps 实际变化且 draft/ready 的卡），按序逐发
  // updateTeamTask({dependencies})——非乐观更新；部分失败也回拉快照对齐。
  const submitReorder = async (fromTaskId: number, toTaskId: number): Promise<void> => {
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
  // docs/29 DA2：DndProvider 只包 TasksTab（消费面唯一，单实例单 Provider，
  // 随 tab 卸载销毁；1s 轮询只换数据不重挂 Provider）。
  return (
    <TaskDndProvider>
      <div>
        {/* docs/26 对话任务：主任务（任务单）卡 + 嵌套小任务行。小任务在
      draft/ready（未领取）时可改删；领取后合同冻结，按钮消失（06.4）。 */}
        {groups.length > 0 && (
          <div className="mb-3.5">
            <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold leading-6 text-foreground">
              <span className={dotClass('info')} />
              对话任务
              <span className="text-xs font-normal text-muted-foreground">· {groups.length}</span>
            </div>
            {groups.map((group) => {
              // 七轮 DA20：小任务按执行序展示（兄弟依赖拓扑序，创建序平局）——
              // 计数/汇总与顺序无关，修复「数量没有变化」的口径不变。
              const subs = executionOrderOf(
                team.tasks.filter((t) => t.parentId === group.taskId),
              );
              const done = subs.filter((t) => t.status === 'completed').length;
              const mutable = group.status === 'draft' || group.status === 'ready';
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
                  className={cn(
                    'mb-2.5 rounded-[8px] border border-solid bg-background px-3 py-2.5',
                    BORDER_L1_CLASS,
                  )}
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
                  {mutable && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-1.5"
                      onClick={() => openEdit(group, null)}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      新增小任务
                    </Button>
                  )}
                  {subs.map((t, subIndex) => {
                    const subMutable = t.status === 'draft' || t.status === 'ready';
                    // docs/29 DA5/DA13：可编辑窗口内成员框承整链（boxCoversChain）
                    // ——站点行与框内容重合，抑制 TaskStations；开跑/冻结后框只
                    // 承单站，站点行照常。
                    const suppressStations = boxCoversChain(t);
                    return (
                      <div key={t.taskId}>
                        <SubtaskCard
                          task={t}
                          onReorder={(from, to) => void submitReorder(from, to)}
                          onToggle={() =>
                            setExpandedTask(expandedTask === t.taskId ? null : t.taskId)
                          }
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              {/* 七轮 DA20：执行序号（executionOrderOf 位次）。 */}
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
                                    onClick={() => openEdit(group, t)}
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
                          {/* docs/29 A.8（四轮 DA17）：成员卡槽移到任务行下方独立
                            一行（拖拽指派 drop target；框自身对不可渲染情形返回
                            null——空链只读等）。点击不冒泡到行（不触发展开）。 */}
                          <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
                            <TaskAssignDropBox
                              task={t}
                              members={team.members}
                              busy={assignBusy === t.taskId}
                              onAssign={(chain) => void submitAssignChain(t.taskId, chain)}
                              onRemoveStation={(index) =>
                                void submitAssignChain(t.taskId, chainAfterRemove(t, index))
                              }
                              onOpenEdit={() => openEdit(group, t)}
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
                        {expandedTask === t.taskId && (
                          <TaskDrawer
                            team={team}
                            task={t}
                            now={now}
                            onClose={() => setExpandedTask(null)}
                          />
                        )}
                      </div>
                    );
                  })}
                  {/* docs/29 A.5.3（用户 2026-09-04 拍板）：成员罗列条每张组卡
                下方一条（小任务行之后），chip 副本相同；只在存在可放置小任务
                （draft/ready）时渲染。 */}
                  {subs.some((t) => t.status === 'draft' || t.status === 'ready') && (
                    <TeamMemberStrip team={team} />
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
                <div key={t.taskId}>
                  <div
                    className={TASK_ROW_CLASS}
                    onClick={() => setExpandedTask(expandedTask === t.taskId ? null : t.taskId)}
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
                    <TaskStations task={t} />
                    {t.dependencies.length > 0 && (
                      <div className="mt-[3px]">
                        {t.dependencies.map((d) => (
                          <span key={d} className={CHIP_CLASS}>
                            依赖 {d}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {expandedTask === t.taskId && (
                    <TaskDrawer
                      team={team}
                      task={t}
                      now={now}
                      onClose={() => setExpandedTask(null)}
                    />
                  )}
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

        {/* docs/26 小任务编辑/新增弹窗：主题 + 说明（六轮 DA19：成员槽编辑
      段撤除——链编排只走任务行下方卡槽：＋多选 / × / chip 拖动调序）。
      新增时空表单。host 校验合同冻结（领取后），错误就地显示。 */}
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
                ）；成员接力请在任务行下方的卡槽中拖放或点「＋」添加。
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
      </div>
    </TaskDndProvider>
  );
}
