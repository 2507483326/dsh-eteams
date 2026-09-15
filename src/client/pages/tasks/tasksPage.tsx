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
 * shared、taskListCard、taskDialogs。面板手动建任务（用户迭代 2026-09-11）：
 * ＋「添加任务」按钮 + addTaskDialog 弹窗（描述 + 选团队）——提交
 * **新开一个对话**并把描述与团队带过去（lib/taskConversation 编排），任务单
 * 由该对话的团队工作流从零建立；目标团队默认当前会话绑定的团队（渲染
 * 闸门见 2026-09-15 二次迭代注记）。
 *
 * 用户迭代 2026-09-12「任务列表直接加线将本会话和其它会话隔离开来」：
 * 列表按会话归属分两段——本会话一段（「本会话」分区线 + 其下本会话卡/
 * 添加按钮）、其它会话一段（「其它会话」分区线 + 其下其它卡），两段
 * **各自独立栅格**、纵向堆叠（同段卡片横排，两段不混行）；本会话无任务
 * 时其分区线下即「＋ 添加任务」按钮（一个会话只挂一个任务：本会话已有
 * 任务就不再给添加入口），标题行的添加按钮撤除。原卡内「本会话」徽标
 * 随之撤除（归属由分区线表达，卡内不再重复）。
 *
 * 用户迭代 2026-09-15「任务列表为空时不展示本会话区分线，添加任务按钮
 * 不应该在任务 title 右边吗，然后显示暂无任务就行」：分区线只在**该段有
 * 卡**时渲染（本会话/其它会话各自判空，空列表不再出现光秃秃的「本会话」
 * 线）；「＋ 添加任务」自分区线下移回卡头行最右（与团队页页头「＋ 新增
 * 团队」同款 sm 钮，2026-09-12 的「按钮落分区线下」就地撤销），空态文案
 * 收成「暂无任务」；页头计数补「共」并与标题底部对齐（同日列表页头口径，
 * 同 rosterPage/teamPage）。
 *
 * 用户迭代 2026-09-15（二次）「不，需要显示添加按钮，点击按钮时再提示用户」
 * +「提示用户 用 warning」：「＋ 添加任务」改**常显**——2026-09-12「本会话已
 * 有任务就不再给添加入口」与「无可选团队不渲染」两条渲染期闸门就地撤销，
 * 限制改为**点击时提示**（openAddDialog 先判：无可选团队 / 本会话已有任务
 * 各弹一枚 **warning 档 toast**（不是错误、只是当前受阻——amber 语义走
 * toast.tsx 本仓扩展的 warning 变体），说明为什么不能加），按钮不再随状态
 * 无声消失（对齐「可点动作禁止静默 no-op」）。
 *
 * @module dsh-eteams/client/pages/tasks/tasksPage
 */
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import Plus from 'lucide-react/dist/esm/icons/plus.mjs';
import { deleteTeamTask, fetchSessionTeam, openTaskFolder, pauseTeamTask, startTeamTask } from '../../lib/api';
import { requestCloseTeamsPage } from '../../lib/bridge';
import { cn } from '../../lib/cn';
import { errorMessageOf, runWithBusy } from '../../lib/errors';
import { refreshActivitySoon, type TaskView, type TeamSnapshot } from '../../lib/monitor';
import { canOpenSession, openSession } from '../../lib/sessionState';
import { openTaskConversation } from '../../lib/taskConversation';
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
 * 显示（槽在 TaskListCard）。添加任务弹窗同为瞬态 useState：open/
 * description/teamId/busy/error，头部行按钮**常显**打开（限制改到点击期
 * 提示，见 openAddDialog + 2026-09-15 二次迭代注记）、teamId 默认当前会话
 * 绑定团队（每次打开重置，防残留）。
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
  // 当前会话绑定团队（异步回填，取不到落队首；池变化不残留悬空 id）；
  // busy/error 壳走 runWithBusy。
  const [addOpen, setAddOpen] = useState(false);
  const [addDesc, setAddDesc] = useState('');
  const [addTeamId, setAddTeamId] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  /* —— 事件处理 —— */

  // 打开弹窗：先过点击期闸门（用户 2026-09-15「需要显示添加按钮，点击按钮
  // 时再提示用户」+「提示用户 用 warning」）——按钮常显，原先「渲染期不满足
  // 条件就不出按钮」的两条限制（无可选团队 / 本会话已有任务）移到这里，点击
  // 时各弹一枚 warning 档 toast（不是错误、只是当前受阻）说清原因，不再让
  // 按钮无声消失（可点动作禁止静默 no-op）。通过后描述清空、目标团队回填当前
  // 会话绑定的团队（取不到落队首）——每次打开重置，防上一次草稿/悬空团队 id
  // 残留。
  const openAddDialog = (): void => {
    if (pool.length === 0) {
      toast({
        variant: 'warning',
        title: '无法添加任务',
        description: '还没有可选的团队，请先创建一个团队。',
      });
      return;
    }
    // 一个会话只挂一个任务（用户迭代 2026-09-12）：本会话已有任务即不放开
    // 入口——2026-09-15 起改为点击时提示（覆盖层无会话上下文，不拦）。
    if (hasSession && sessionTasks.length > 0) {
      toast({
        variant: 'warning',
        title: '本会话已有任务',
        description: '一个会话只能挂一个任务；再建任务请新开一个对话。',
      });
      return;
    }
    const fallback = pool[0]?.teamId ?? '';
    setAddDesc('');
    setAddTeamId(fallback);
    setAddError(null);
    setAddOpen(true);
    // 绑定团队是宿主真相源（fetchSessionTeam）：先落队首让弹窗即刻可用，回填
    // 回来时只覆盖「还是队首」的态——用户已手动改选就不动他（异步回填不打乱
    // 用户操作）。绑定队不在池里（已删）不认，避免 Select 落到无匹配的悬空值。
    if (sessionId === undefined || sessionId === '') return;
    void fetchSessionTeam(sessionId)
      .then((bound) => {
        if (bound === null || !pool.some((t) => t.teamId === bound.teamId)) return;
        setAddTeamId((cur) => (cur === fallback ? bound.teamId : cur));
      })
      .catch(() => undefined);
  };

  // 提交手动建任务（用户迭代 2026-09-11）：不再是面板 commission 建「创建中」
  // 容器，而是**新开一个对话**——描述作为新对话首条消息、所选团队绑定到新
  // 对话（编排见 lib/taskConversation）。新对话无锚定主任务，团队绑定 band
  // 走「两步走」分工（先建任务单再转交领队；无领队由该会话直接主持），
  // 「从零建立一个任务单」因此由对话流程天然完成。
  // 成功关弹窗；部分降级（描述未投递/未切换）走 toast 提示，不再把用户困在
  // 旧对话。失败吃原文就地显示在弹窗内。整页团队页表面（sessionId
  // undefined）= 覆盖层形态——新对话已切过去，覆盖层会挡住它，成功即广播
  // 关页信号收页（对话内 tab 场景无人监听，零副作用）。
  const submitAddTask = async (): Promise<void> => {
    if (addBusy || addTeamId === '' || addDesc.trim() === '') return;
    await runWithBusy(
      async () => {
        const outcome = await openTaskConversation({
          description: addDesc.trim(),
          teamId: addTeamId,
          ...(sessionId !== undefined && sessionId !== '' ? { fromSessionId: sessionId } : {}),
        });
        if (!outcome.ok) throw new Error(outcome.error);
        setAddOpen(false);
        setAddDesc('');
        if (sessionId === undefined || sessionId === '') requestCloseTeamsPage();
        if (outcome.warning !== undefined) {
          toast({ title: '新对话已打开', description: outcome.warning });
        }
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

  // 主任务暂停（用户迭代 2026-09-11：跑起来后「开始」变「暂停」）——容器
  // 挂起在跑小任务 + 容器本身；与 submitStart 共用 busy/error 瞬态槽。
  const submitPause = async (taskId: number): Promise<void> => {
    const owner = ownerByTaskId.get(taskId);
    if (owner === undefined) return;
    setStartBusy(taskId);
    setStartError((cur) => (cur !== null && cur.taskId === taskId ? null : cur));
    try {
      await pauseTeamTask(owner.teamId, taskId);
      refreshActivitySoon();
    } catch (e) {
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
  // （TaskDialogs），状态/提交回调在此。添加任务弹窗同挂此节点：描述 +
  // 团队 Select，提交回调 submitAddTask（新开对话编排）。
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

  // 列表数据源（原内联 IIFE 上提——本会话分区需先分组再渲染）。mainTasks =
  // 各队顶层任务（主任务 + 顶层普通任务）按快照序拼接（跨队同列，一卡一
  // 任务）。会话归属（2026-09-10）：任务主会话快照命中当前面板会话 = 本
  // 会话任务；否则若目标会话在客户端会话列表里 = 可跳转。面板无会话上下文
  // （整页覆盖层 sessionId undefined）时不分区，全部按其它会话处理。
  const mainTasks = pool.flatMap((t) => t.tasks.filter((task) => task.parentId === null));
  const hasSession = sessionId !== undefined && sessionId !== '';
  const isCurrentSession = (t: TaskView): boolean => hasSession && t.sessionId === sessionId;
  const sessionTasks = hasSession ? mainTasks.filter(isCurrentSession) : [];
  const otherTasks = hasSession ? mainTasks.filter((t) => !isCurrentSession(t)) : mainTasks;
  // 空态判据只看总量（用户 2026-09-15「然后显示暂无任务就行」）：列表无卡即
  // 显示「暂无任务」，与是否还有添加入口无关（按钮常显在卡头行，不再顶掉
  // 空态文案）。
  const showEmpty = mainTasks.length === 0;

  // 三十一轮 DA44④：列表卡身抽 taskListCard（TaskListCard）——subs 统计/
  // deletable 判据随迁卡内现算（task/allTasks 进 props，allTasks 取归属团队
  // 的任务全集）。会话归属（2026-09-10）随卡下发；2026-09-12 起卡内不再画
  // 「本会话」徽标（归属由分区线表达，见 SessionDivider）。
  const renderCard = (t: TaskView): ReactNode => {
    const currentSession = isCurrentSession(t);
    const canJump =
      !currentSession &&
      typeof t.sessionId === 'string' &&
      t.sessionId !== '' &&
      canOpenSession(t.sessionId);
    return (
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
        // M3 拆页：整卡点击进详情改导航——drawerTaskId 由 routes.tsx 的
        // location sync 回写（仅本会话卡可点，见卡内判据）。
        onOpen={() => navigate(`/tasks/${t.taskId}`)}
        onJump={() => {
          if (typeof t.sessionId === 'string') jumpToSession(t.sessionId);
        }}
        onOpenFolder={(taskId) => void openFolder(taskId)}
        onDelete={() => setDeleteTarget(t)}
        onStart={() => void submitStart(t.taskId)}
        onPause={() => void submitPause(t.taskId)}
      />
    );
  };

  // docs/29 DA2：DndProvider 只包本页（消费面唯一，单实例单 Provider，随页
  // 卸载销毁；1s 轮询只换数据不重挂 Provider）。列表/详情页各包各的。
  return (
    <TaskDndProvider>
      {/* 列表卡满高（用户迭代 2026-09-07）：页根占内容列剩余空间，卡 flex-1
      拉满、栅格 min-h-0 内部滚动（卡满高、页头常驻可视）。 */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* 平铺小卡栅格（十一…十五轮 DA24…DA28 视觉口径不变；2026-09-10
        用户拍板「直接显示所有任务」）。2026-09-12 会话归属分区（用户
        「任务列表直接加线将本会话和其它会话隔离开来」）：本会话一段
        （「本会话」分区线 + 其下本会话卡）、其它会话一段（「其它会话」分区线
        + 其下其它卡），**两段各自独立栅格**——同段卡片横排、两段纵向堆叠，
        不让本会话卡与其它卡混进同一行。2026-09-15：分区线只在该段有卡时
        渲染（空列表不出现光秃秃的线），添加按钮上移卡头行最右。 */}
        <Card className={cn(PANEL_CARD_CLASS, 'pb-3 flex min-h-0 flex-1 flex-col')}>
          {/* 卡头行（用户 2026-09-15「添加任务按钮不应该在任务 title 右边
            吗」）：标题 + 计数子行（同日列表页头口径「共 N 个」+ 底部对齐，
            同 rosterPage/teamPage），「＋ 添加任务」压轴贴行最右。 */}
          <div className="mb-2.5 flex items-center gap-2">
            <div className="flex min-w-0 flex-none items-baseline gap-2">
              <h3 className={cn(LIST_TITLE_CLASS, 'flex-none')}>任务</h3>
              <span className={LIST_COUNT_CLASS}>共 {mainTasks.length} 个</span>
            </div>
            <span className="min-w-0 flex-1" />
            {/* 「＋ 添加任务」**常显**（用户 2026-09-15「需要显示添加按钮，
                点击按钮时再提示用户」）：原先「本会话已有任务 / 无可选团队
                就不渲染」的渲染期闸门就地撤销，两条限制移进 openAddDialog
                的点击期提示（按钮不再无声消失）。 */}
            <Button type="button" variant="outline" size="sm" onClick={openAddDialog}>
              <Plus className="h-3.5 w-3.5" />
              添加任务
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* 分区线只在该段有卡时渲染（用户 2026-09-15「任务列表为空时不展示
                本会话区分线」）——空列表不再出现光秃秃的「本会话」线。 */}
            {sessionTasks.length > 0 && <SessionDivider label="本会话" />}
            {sessionTasks.length > 0 && (
              <div className={TASK_GRID_CLASS}>{sessionTasks.map(renderCard)}</div>
            )}
            {otherTasks.length > 0 && (
              <SessionDivider
                label="其它会话"
                className={sessionTasks.length > 0 ? 'mt-5' : undefined}
              />
            )}
            {otherTasks.length > 0 && (
              <div className={TASK_GRID_CLASS}>{otherTasks.map(renderCard)}</div>
            )}
            {showEmpty && <div className={EMPTY_CLASS}>暂无任务</div>}
          </div>
        </Card>
        {dialogs}
      </div>
    </TaskDndProvider>
  );
}

/** 会话分区线（用户迭代 2026-09-12「-本会话-------」）：任务列表按会话归属
 * 分段的标题线——短横线夹标签、右侧长横线收尾（Separator 同款 bg-border
 * token）。两段各一条（label=本会话 / 其它会话），线在段上、内容在段下。 */
function SessionDivider({ label, className }: { label: string; className?: string }): ReactNode {
  return (
    <div className={cn('mb-2.5 flex items-center gap-2', className)}>
      <span className="h-px w-4 shrink-0 bg-border" />
      <span className="shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
