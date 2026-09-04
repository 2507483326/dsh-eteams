/**
 * 任务 tab：分组任务清单 + 编辑/删除弹窗 + 展示态徽标（docs/26/docs/29）。
 * 符号自 eteamsView.tsx 原样搬出（docs/32 32.5.1 纯移动、零行为变更），
 * 依赖 taskDrawer（详情抽屉）、features/tasks（拖拽指派 + 展示态）与 shared。
 *
 * @module dsh-eteams/client/pages/teamsView/tasksTab
 */
import { useState, type ReactNode } from 'react';
import Minus from 'lucide-react/dist/esm/icons/minus.mjs';
import Plus from 'lucide-react/dist/esm/icons/plus.mjs';
import {
  createTeamTask,
  deleteTeamTask,
  updateTeamTask,
  type TaskSlotInput,
} from '../../lib/api';
import { cn } from '../../lib/cn';
import { refreshActivitySoon, type TaskView, type TeamSnapshot } from '../../lib/monitor';
import { TaskAssignDropBox, TaskDndProvider, TeamMemberStrip } from '../../features/tasks/taskAssign';
import { boxRendersContent, clearedChain } from '../../features/tasks/taskAssignCore';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { TaskDrawer, TaskStations } from './taskDrawer';
import {
  BORDER_L1_CLASS,
  CHIP_CLASS,
  EMPTY_CLASS,
  FORM_LABEL_CLASS,
  FormErrorNote,
  MUTED_CLASS,
  Pill,
  SELECT_NONE,
  dotClass,
} from './shared';

/** 原 styles.taskRow（任务行：l1 下边线 / 8px 圆角 / 指针）。 */
const TASK_ROW_CLASS = `cursor-pointer rounded-[8px] border-b border-solid px-2 py-2.5 ${BORDER_L1_CLASS}`;

/** 展示态徽标（docs/29 B.3 渲染位）：中性 pill（Badge secondary + 6px dot，
 * tone 按展示态逐格对表——29-M3 同桶异色）+ 13 态差异 detail 小字（重试 n/
 * 待决策/已挂起…）。TaskDrawer 与任务详情**保留 13 态精确文案**（STATUS_
 * LABELS），展示态只用于任务行/组卡/分组头。 */
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

/** 成员槽编辑行（任务编辑弹窗内的一站草稿）。 */
interface SlotDraft {
  member: string;
  stageBrief: string;
}

/** 任务编辑/新增弹窗目标（docs/26）：group = 挂靠的主任务（任务单）；
 * task = 被编辑的小任务，null = 新增小任务。 */
interface TaskEditTarget {
  group: TaskView;
  task: TaskView | null;
}

/** 任务：按状态分组的任务清单（原「任务」）。S13 Tailwind 化：分组头 pill、
任务行、依赖芯片与空态全迁 Tailwind 类；详情抽屉为 shadcn Dialog（见
TaskDrawer），开合仍走 ui model 的 setExpandedTask。
docs/26 对话任务：顶部「对话任务」区块渲染 kind==='group' 的主任务（任务
单）卡 + 嵌套小任务行；小任务在 draft/ready（未领取）时面板可改删——修
改弹窗（主题/说明/成员槽编辑）与删除确认弹窗，主任务卡内可新增小任务。
编辑/删除弹窗为组件内瞬态 useState，不入 ui model；保存/删除成功后
refreshActivitySoon 立即回拉快照。
docs/29 拖拽指派：根包 TaskDndProvider（单实例）；每张组卡下方成员罗列条
（拖拽源）+ 小任务行尾成员框（TaskAssignDropBox，drop=下一待执行站快捷位，
整链重发 updateTeamTask、非乐观更新）；assignBusy/assignError 瞬态同
editBusy/editError 模式，错误就地 FormErrorNote。 */
export function TasksTab({
  team,
  now,
  expandedTask,
  setExpandedTask,
}: {
  team: TeamSnapshot;
  now: number;
  expandedTask: string | null;
  setExpandedTask: (id: string | null) => void;
}): ReactNode {
  const [editTarget, setEditTarget] = useState<TaskEditTarget | null>(null);
  const [editSubject, setEditSubject] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editSlots, setEditSlots] = useState<SlotDraft[]>([]);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskView | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // docs/29 拖拽指派瞬态（对齐 editBusy/editError 模式）：busy 按小任务
  // taskId 定位（框禁用 + 透明度），error 单槽记录受影响小任务（行内展示）。
  const [assignBusy, setAssignBusy] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<{ taskId: string; message: string } | null>(null);
  const editingTask = editTarget !== null && editTarget.task !== null ? editTarget.task : null;

  const openEdit = (group: TaskView, task: TaskView | null): void => {
    setEditTarget({ group, task });
    setEditSubject(task?.subject ?? '');
    setEditDesc(task?.description ?? '');
    setEditSlots(
      task === null ? [] : task.chain.map((s) => ({ member: s.member, stageBrief: s.stageBrief })),
    );
    setEditError(null);
  };
  const closeEdit = (): void => {
    setEditTarget(null);
    setEditError(null);
  };
  const saveEdit = async (): Promise<void> => {
    const target = editTarget;
    if (target === null) return;
    // 未选成员的空站点丢弃；chain 整体替换——未动的站原样重发。
    const chain: TaskSlotInput[] = editSlots
      .filter((s) => s.member !== '')
      .map((s) => ({ member: s.member, stageBrief: s.stageBrief.trim() }));
    setEditBusy(true);
    setEditError(null);
    try {
      if (target.task === null) {
        await createTeamTask(team.teamId, {
          subject: editSubject.trim(),
          ...(editDesc.trim() !== '' ? { description: editDesc.trim() } : {}),
          parentTaskId: target.group.taskId,
          ...(chain.length > 0 ? { chain } : {}),
        });
      } else {
        await updateTeamTask(team.teamId, target.task.taskId, {
          subject: editSubject.trim(),
          description: editDesc.trim(),
          chain,
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
  const submitAssignChain = async (taskId: string, chain: TaskSlotInput[]): Promise<void> => {
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
              const subs = team.tasks.filter((t) => t.parentId === group.taskId);
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
                    <strong>{group.taskId}</strong> {group.subject}
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
                  {subs.map((t) => {
                    const subMutable = t.status === 'draft' || t.status === 'ready';
                    // docs/29 A.5.1：单站点（chain≤1）且框有内容时站点行与框
                    // 内容重合——抑制 TaskStations；多站点保留（框只承下一站）。
                    const suppressStations = t.chain.length === 1 && boxRendersContent(t);
                    return (
                      <div key={t.taskId}>
                        <div
                          className={cn(TASK_ROW_CLASS, 'ml-4')}
                          onClick={() =>
                            setExpandedTask(expandedTask === t.taskId ? null : t.taskId)
                          }
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <strong>{t.taskId}</strong> {t.subject}
                              <DisplayStatusPill status={t.status} className="ml-1" />
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
                              {/* docs/29 A.8：行尾成员框（拖拽指派 drop target；
                            框自身对不可渲染情形返回 null——空链只读等）。 */}
                              <TaskAssignDropBox
                                task={t}
                                members={team.members}
                                busy={assignBusy === t.taskId}
                                onAssign={(chain) => void submitAssignChain(t.taskId, chain)}
                                onClear={() => void submitAssignChain(t.taskId, clearedChain(t))}
                                onOpenEdit={() => openEdit(group, t)}
                              />
                            </div>
                          </div>
                          {!suppressStations && <TaskStations task={t} />}
                        </div>
                        {assignError !== null && assignError.taskId === t.taskId && (
                          <FormErrorNote className="ml-4">{assignError.message}</FormErrorNote>
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
                      <strong>{t.taskId}</strong> {t.subject}
                      {/* docs/29 B.3：展示态 pill（retryCount 并入 detail，
                    顶层行既有「重试 n」标记并入）；assignee 小字保留。 */}
                      <DisplayStatusPill
                        status={t.status}
                        retryCount={t.retryCount}
                        className="ml-1"
                      />
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

        {/* docs/26 小任务编辑/新增弹窗：主题 + 说明 + 成员槽（站点按序接力）。
      新增时空表单；修改时按当前值回填（成员槽从执行链展开）。host 校验
      成员在团/合同冻结（领取后），错误就地显示。 */}
        <Dialog
          open={editTarget !== null}
          onOpenChange={(next) => {
            if (!next) closeEdit();
          }}
        >
          <DialogContent className="max-w-md">
            <DialogHeader className="space-y-1 text-left">
              <DialogTitle>
                {editingTask !== null ? `修改 ${editingTask.taskId}` : '新增小任务'}
              </DialogTitle>
              <DialogDescription className={MUTED_CLASS}>
                挂靠任务单 {editTarget?.group.taskId ?? ''}（{editTarget?.group.subject ?? ''}）；
                成员槽按序接力，站点留空可跳过。
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
              <div>
                <span className={FORM_LABEL_CLASS}>成员槽（按序接力）</span>
                {editSlots.map((s, i) => (
                  <div key={i} className="mt-1.5 flex items-center gap-1.5">
                    <Select
                      value={s.member === '' ? SELECT_NONE : s.member}
                      onValueChange={(v) =>
                        setEditSlots((list) =>
                          list.map((x, j) =>
                            j === i ? { ...x, member: v === SELECT_NONE ? '' : v } : x,
                          ),
                        )
                      }
                    >
                      <SelectTrigger className="h-[30px] w-[42%] shrink-0 px-2.5 text-[12px] font-medium">
                        <SelectValue placeholder="— 成员 —" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SELECT_NONE} className="text-[12px]">
                          — 成员 —
                        </SelectItem>
                        {team.members.map((m) => (
                          <SelectItem key={m.name} value={m.name} className="text-[12px]">
                            {m.name}（{m.role}）
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      className="h-[30px] min-w-0 flex-1 px-2.5 text-[12px]"
                      value={s.stageBrief}
                      placeholder="该站产出 / 交接物"
                      onChange={(e) =>
                        setEditSlots((list) =>
                          list.map((x, j) => (j === i ? { ...x, stageBrief: e.target.value } : x)),
                        )
                      }
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-[30px] w-[30px] shrink-0"
                      aria-label="移除站点"
                      onClick={() => setEditSlots((list) => list.filter((_, j) => j !== i))}
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-1.5"
                  onClick={() => setEditSlots((list) => [...list, { member: '', stageBrief: '' }])}
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加站点
                </Button>
              </div>
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
                确定删除「{deleteTarget?.taskId ?? ''} {deleteTarget?.subject ?? ''}」？未领取的
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
