/**
 * 任务列表页（docs/44 M3 自 tasksTab 拆出）：路由 /tasks——平铺小卡栅格
 * （Card 面板 + 任务小卡，一卡一顶层任务，无拖拽；不列小任务明细——九轮
 * DA22 口径）+ 空态行。用户迭代 2026-09-10「直接显示所有任务」：数据源
 * 改**全团队聚合**（pool 各队顶层任务原序平铺，不再按选中团队过滤——
 * 团队选中语义只属看板/团队页），行动作按任务归属团队派发；会话归属
 * 语义（provenance）见 taskListCard 头注——当前会话建的卡前置「本会话」
 * 徽标、点击进详情，其它会话的卡不进详情、底栏「跳转会话」钮经客户端
 * sessions.open 切换。整卡/详情钮点击经 navigate('/tasks/:taskId') 进
 * 详情页（ui model drawerTaskId 语义不变：routes.tsx 的 location sync
 * 回写）；删除确认弹窗就地（TaskDialogs——编辑/新增弹窗入口都在详情页，
 * 本页 editTarget 恒 null、编辑弹窗不渲染，props 以惰性值占位）。列表本
 * 地态：folderBusy/folderError（文件夹打开）、startBusy/startError（组卡
 * 开始）、deleteTarget/deleteBusy/deleteError（删除确认）。导航状态不在
 * 本页：详情选中的任务 id 走 :taskId 路由参数。依赖 features/tasks 与
 * shared、taskListCard、taskDialogs。面板手动建任务（docs/panelTask
 * Commission）：头部行「＋ 添加任务」按钮 + addTaskDialog 弹窗（描述 +
 * 选团队）——提交走宿主 commission 路由建「创建中」容器交完善者（仅
 * 有团队可选时渲染按钮）。
 *
 * @module dsh-eteams/client/pages/tasks/tasksPage
 */
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import Plus from 'lucide-react/dist/esm/icons/plus.mjs';
import { createTaskCommission, deleteTeamTask, openTaskFolder, startTeamTask } from '../../lib/api';
import { cn } from '../../lib/cn';
import { errorMessageOf, runWithBusy } from '../../lib/errors';
import { refreshActivitySoon, type TaskView, type TeamSnapshot } from '../../lib/monitor';
import { canOpenSession, openSession } from '../../lib/sessionState';
import { toast } from '../../hooks/useToast';
import { TaskDndProvider } from '../../features/tasks/taskAssign';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import {
  EMPTY_CLASS,
  LIST_COUNT_CLASS,
  LIST_TITLE_CLASS,
  PANEL_CARD_CLASS,
  TASK_GRID_CLASS,
} from '../shared/styles';
import { TaskListCard } from './taskListCard';
import { TaskDialogs } from './taskDialogs';
import { AddTaskDialog } from './addTaskDialog';

/** ================================== 类型 ================================== */

/** 路由页入参（壳状态经 routes.tsx 传入）。 */
export interface TasksPageProps {
  /** 全部团队池（任务列表数据源 = 各队顶层任务聚合；添加任务弹窗的团队选项）。 */
  pool: TeamSnapshot[];
  /** 当前宿主会话 id（整页覆盖层 undefined）——会话归属比对 + commission 会话锚。 */
  sessionId: string | undefined;
}

/** ================================== 主组件 ================================== */

/**
 * 任务列表页：与团队列表同款 Card 面板 + **平铺任务小卡栅格**（不分「对话
 * 任务」/状态分区——用户十一轮拍板「任务主列表不分对话任务、待指派这种，
 * 做成团队那种小卡片」；一卡一顶层任务；**不列小任务明细**——用户九轮
 * 拍板；无编排 UI、无拖拽）。2026-09-10 改**全团队聚合平铺**：pool 各队
 * 顶层任务（主任务 + 顶层普通任务）按快照序拼接，行动作按任务归属团队
 * 派发（ownerByTaskId 现算映射）；会话归属语义随卡下发（本会话 = 徽标 +
 * 可点进详情；其它 = 跳转会话钮 + 卡身不可点）。编辑/删除弹窗为组件内
 * 瞬态 useState（编辑弹窗入口在详情页，本页仅删除确认可达），删除成功后
 * refreshActivitySoon 回拉快照；folderError/startError 瞬态错误行内就地
 * 显示（槽在 TaskListCard）。添加任务弹窗（docs/panelTaskCommission）同为
 * 瞬态 useState：open/description/teamId/busy/error，头部行按钮打开（仅
 * 有团队可选时渲染）、teamId 默认队首（每次打开重置，防残留）。
 */
export function TasksPage({ pool, sessionId }: TasksPageProps): ReactNode {
  const navigate = useNavigate();
  // 任务 → 归属团队映射（行动作 API 都要 teamId；跨队聚合后每卡各归各队）。
  const ownerByTaskId = new Map<number, TeamSnapshot>();
  for (const t of pool) {
    for (const task of t.tasks) ownerByTaskId.set(task.taskId, t);
  }
  // 文件夹打开瞬态（对齐 assignError 模式）：error 按卡定位行内展示。
  const [folderBusy, setFolderBusy] = useState<number | null>(null);
  const [folderError, setFolderError] = useState<{ taskId: number; message: string } | null>(null);
  // 组卡开始瞬态：busy 按小任务 taskId 定位，error 单槽记录受影响小任务。
  const [startBusy, setStartBusy] = useState<number | null>(null);
  const [startError, setStartError] = useState<{ taskId: number; message: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskView | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // 添加任务弹窗：open/description/teamId/busy/error 瞬态组——teamId 默认
  // 队首（open 即回填，池变化不残留悬空 id）；busy/error 壳走 runWithBusy。
  const [addOpen, setAddOpen] = useState(false);
  const [addDesc, setAddDesc] = useState('');
  const [addTeamId, setAddTeamId] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  /* —— 事件处理 —— */

  // 打开弹窗：描述清空、目标团队回填队首（每次打开重置，防上一次草稿/
  // 悬空团队 id 残留）。
  const openAddDialog = (): void => {
    setAddDesc('');
    setAddTeamId(pool[0]?.teamId ?? '');
    setAddError(null);
    setAddOpen(true);
  };

  // 提交手动建任务（docs/panelTaskCommission §4.2）：宿主建「创建中」容器
  // 并交完善者（有领队 = 领队子代理；无领队 = 主会话唤醒）。成功关弹窗 +
  // 回拉快照——统一任务列表下新卡就地出现（主会话快照命中 = 本会话徽标，
  // 不再需要跨队切选中团队）。dispatched:false = 任务仍创建成功、完善者
  // 未送达（无锚/绑定他队）——toast 提示原因，卡片保留创建中可删（逃生
  // 门）。失败吃 400 原文就地显示在弹窗内。
  const submitAddTask = async (): Promise<void> => {
    if (addBusy || addTeamId === '' || addDesc.trim() === '') return;
    await runWithBusy(
      async () => {
        const result = await createTaskCommission(addTeamId, {
          description: addDesc.trim(),
          ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}),
        });
        setAddOpen(false);
        setAddDesc('');
        if (!result.dispatched) {
          toast({
            title: '任务已创建，完善者未送达',
            description: result.detail ?? '该团队暂无可托管完善的主会话锚点，任务保留为创建中，可删除后重试。',
          });
        }
        refreshActivitySoon();
      },
      setAddBusy,
      setAddError,
    );
  };

  // 面板开始任务（用户拍板「卡片加上开始按钮」）：派发给执行链下一站
  // （host /task/<id>/start 复用 assignTask 派发核——起子会话 + 投递指派信，
  // ready→wait 待接取）；空链卡不渲染按钮（行内「需要选择成员」提示），
  // 失败行内就地显示。非乐观更新，成功 refreshActivitySoon。主任务路径 =
  // 逐个派发 ready 小任务（host 分支，响应带 started/skipped）——有跳过时
  // 行内就地提示。按任务归属团队派发（ownerByTaskId，跨队聚合口径）。
  const submitStart = async (taskId: number): Promise<void> => {
    const owner = ownerByTaskId.get(taskId);
    if (owner === undefined) return;
    setStartBusy(taskId);
    setStartError((cur) => (cur !== null && cur.taskId === taskId ? null : cur));
    try {
      const result = await startTeamTask(owner.teamId, taskId);
      if (result.skipped.length > 0) {
        const reason = result.skipped.map((s) => `${s.subject}：${s.reason}`).join('；');
        setStartError({
          taskId,
          message:
            result.started > 0
              ? `已开始 ${result.started} 个小任务，${result.skipped.length} 个未开始：${reason}`
              : reason,
        });
      }
      refreshActivitySoon();
    } catch (e) {
      // 错误规范化收口 errorMessageOf（M7-5；错误槽是对象——不套 runWithBusy）。
      setStartError({ taskId, message: errorMessageOf(e) });
    } finally {
      setStartBusy(null);
    }
  };

  // 打开任务文件夹（列表卡文件夹路径点击）。非乐观：成功无回执 UI（文件
  // 管理器窗口即回执），失败按卡行内 FormErrorNote。按归属团队派发。
  const openFolder = async (taskId: number): Promise<void> => {
    const owner = ownerByTaskId.get(taskId);
    if (owner === undefined) return;
    setFolderBusy(taskId);
    setFolderError((cur) => (cur !== null && cur.taskId === taskId ? null : cur));
    try {
      await openTaskFolder(owner.teamId, taskId);
    } catch (e) {
      // 错误规范化收口 errorMessageOf（M7-5；错误槽是对象——不套 runWithBusy）。
      setFolderError({ taskId, message: errorMessageOf(e) });
    } finally {
      setFolderBusy(null);
    }
  };

  // 删除确认（列表卡删除钮）：host 仍是最终裁决，拒绝原因就地显示。
  // 按归属团队派发（被删任务正处详情页就地编辑时，详情页卸载即弃，无
  // 陈旧草稿复活路径）。
  const confirmDelete = async (): Promise<void> => {
    const target = deleteTarget;
    if (target === null) return;
    const owner = ownerByTaskId.get(target.taskId);
    if (owner === undefined) return;
    // M7-5 busy/error 壳收口 runWithBusy（守卫留在调用点）。
    await runWithBusy(
      async () => {
        await deleteTeamTask(owner.teamId, target.taskId);
        setDeleteTarget(null);
        refreshActivitySoon();
      },
      setDeleteBusy,
      setDeleteError,
    );
  };

  // 跳转到任务所属会话（其它会话卡的「跳转会话」钮）：客户端
  // sessions.open 把目标会话选为当前——宿主布局切到该会话对话。目标
  // 不在会话列表（已被清理/未知结构）时 toast 兜底提示。
  const jumpToSession = (taskSessionId: string): void => {
    if (!openSession(taskSessionId)) {
      toast({ title: '无法跳转', description: '目标会话不在当前会话列表中。' });
    }
  };

  // 共用弹窗（原 tasksTab 列表/详情两分支同挂一个 TaskDialogs 节点；拆页后
  // 两页各挂各的）。本页仅删除确认可达：编辑/新增弹窗入口（新增小任务/
  // 卡槽「修改」）都在详情页，editTarget 恒 null、编辑弹窗不渲染——编辑
  // 侧 props 以惰性值占位（瞬态 useState 不入 ui model；host 校验合同冻结
  // （领取后），错误就地显示）。三十一轮 DA44④：弹窗 JSX 抽 taskDialogs
  // （TaskDialogs），状态/提交回调在此。添加任务弹窗（docs/panelTask
  // Commission）同挂此节点：描述 + 团队 Select，提交回调 submitAddTask。
  const dialogs = (
    <>
      <TaskDialogs
        editTarget={null}
        editSubject=""
        editDesc=""
        editBusy={false}
        editError={null}
        onCloseEdit={() => undefined}
        onSaveEdit={() => undefined}
        onEditSubject={() => undefined}
        onEditDesc={() => undefined}
        deleteTarget={deleteTarget}
        deleteBusy={deleteBusy}
        deleteError={deleteError}
        onDeleteConfirm={confirmDelete}
        onDeleteDismiss={() => {
          setDeleteTarget(null);
          setDeleteError(null);
        }}
      />
      <AddTaskDialog
        open={addOpen}
        description={addDesc}
        teamId={addTeamId}
        pool={pool}
        busy={addBusy}
        error={addError}
        onDescription={setAddDesc}
        onTeamId={setAddTeamId}
        onClose={() => {
          setAddOpen(false);
          setAddError(null);
        }}
        onSubmit={() => void submitAddTask()}
      />
    </>
  );

  // docs/29 DA2：DndProvider 只包本页（消费面唯一，单实例单 Provider，随页
  // 卸载销毁；1s 轮询只换数据不重挂 Provider）。列表/详情页各包各的。
  return (
    <TaskDndProvider>
      {/* 列表卡满高（用户迭代 2026-09-07）：页根占内容列剩余空间，卡 flex-1
      拉满、栅格 min-h-0 内部滚动（卡满高、页头常驻可视）。 */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* 平铺小卡栅格（十一…十五轮 DA24…DA28 视觉口径不变；2026-09-10
        用户拍板「直接显示所有任务」）：撤掉按选中团队过滤——**全团队顶层
        任务（主任务 + 顶层普通任务）聚合平铺**（pool 快照序拼接，跨队同列
        ，一卡一任务）；会话归属语义见 taskListCard 头注（本会话徽标/其它
        卡跳转会话）。Card 与头部行常驻（空态也在卡内）；「添加任务」钮
        仅在有团队可选时渲染（无可选团队开弹窗无意义）。 */}
        {(() => {
          const mainTasks = pool.flatMap((t) => t.tasks.filter((task) => task.parentId === null));
          return (
            <Card className={cn(PANEL_CARD_CLASS, 'pb-3 flex min-h-0 flex-1 flex-col')}>
              <div className="mb-2.5 flex items-center gap-2">
                <h3 className={LIST_TITLE_CLASS}>任务</h3>
                <span className={LIST_COUNT_CLASS}>{mainTasks.length} 个</span>
                {pool.length > 0 && (
                  <Button type="button" size="sm" className="ml-auto" onClick={openAddDialog}>
                    <Plus className="h-3.5 w-3.5" />
                    添加任务
                  </Button>
                )}
              </div>
              {mainTasks.length === 0 ? (
                <div className={EMPTY_CLASS}>
                  还没有任务。在对话中把任务交给团队，或计划批准后任务会出现在这里；也可以点右上角「添加任务」手动创建。
                </div>
              ) : (
                <div className={cn(TASK_GRID_CLASS, 'min-h-0 flex-1 content-start overflow-y-auto')}>
                  {mainTasks.map((t) => {
                    // 会话归属（2026-09-10）：任务主会话快照命中当前面板
                    // 会话 = 本会话卡（徽标 + 可点进详情）；否则若目标会话
                    // 在客户端会话列表里 = 可跳转。面板无会话上下文（整页
                    // 覆盖层 sessionId undefined）时一律按其它会话处理。
                    const currentSession =
                      sessionId !== undefined && sessionId !== '' && t.sessionId === sessionId;
                    const canJump =
                      !currentSession &&
                      typeof t.sessionId === 'string' &&
                      t.sessionId !== '' &&
                      canOpenSession(t.sessionId);
                    return (
                      // 三十一轮 DA44④：列表卡身抽 taskListCard（TaskListCard）——
                      // subs 统计/deletable 判据随迁卡内现算（task/allTasks 进
                      // props，allTasks 取归属团队的任务全集）。
                      <TaskListCard
                        key={t.taskId}
                        task={t}
                        allTasks={ownerByTaskId.get(t.taskId)?.tasks ?? []}
                        currentSession={currentSession}
                        canJump={canJump}
                        folderBusy={folderBusy}
                        folderError={folderError}
                        startError={startError}
                        startBusy={startBusy}
                        // M3 拆页：整卡点击进详情改导航——drawerTaskId 由
                        // routes.tsx 的 location sync 回写（仅本会话卡可点，
                        // 见卡内判据）。
                        onOpen={() => navigate(`/tasks/${t.taskId}`)}
                        onJump={() => {
                          if (typeof t.sessionId === 'string') jumpToSession(t.sessionId);
                        }}
                        onOpenFolder={(taskId) => void openFolder(taskId)}
                        onDelete={() => setDeleteTarget(t)}
                        onStart={() => void submitStart(t.taskId)}
                      />
                    );
                  })}
                </div>
              )}
            </Card>
          );
        })()}
        {dialogs}
      </div>
    </TaskDndProvider>
  );
}
