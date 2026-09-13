/**
 * 任务详情页（docs/44 M3 自 tasksTab 拆出，行为零变更）：路由 /tasks/:taskId
 * ——头部卡（taskHeaderCard）+ 编排（返回钮统一走壳层页头 onBack 槽，用户
 * 迭代 2026-09-08）。:taskId 路由参数即选中的任务
 * id（语义 = 原 ui model drawerTaskId「详情页选中的任务 id」，八轮 DA21
 * 用户拍板「将任务做成任务详情页面和任务列表页面，点击到详情再编排整个
 * 任务」；store 持久层回写由 routes.tsx 的 location sync 承担——ui model
 * 语义不变）；选中任务被删（快照里已无此 id）自动回落列表页（原 tasksTab
 * 分支注记口径，navigate('/tasks') 落地）。用户 2026-09-13「我希望任务在
 * 创建中也能点进去看到子任务一个一个生成出来」：创建中容器放开进详情
 * （推翻 2026-09-11「创建中不允许点进去」口径），但走**只读观望档**
 * （isDetailReadOnly——团队成员 + 小任务随快照陆续长出，不给新增/删除/
 * 卡槽/开始；收口转 ready 后自动恢复既有编排面）。
 * 主任务（group）详情 = **整个任务的编排面**：新增小任务 + 小任务卡片全套
 * （taskSubtaskItem：执行序号/卡槽/把手拖拽调序——十轮 DA23 把手化/改删/
 * 展开/就地编辑；把手拖拽 2026-09-13 经 SUBTASK_REORDER_ENABLED 暂时停用）
 * + 成员罗列条；任务/小任务：详情正文（taskDrawer 的
 * TaskDetailContent）+ 卡槽 + 站点行 + 依赖 chips + 成员罗列条。编辑/删除
 * 弹窗（taskDialogs，组件内瞬态 useState）就地挂载；展示态徽标居 shared/
 * components（docs/47 DB10 自 taskPills 纯移动，跨域复用归 shared/）、
 * 列表卡身抽 taskListCard（列表页见 tasksPage）。依赖 features/tasks
 * （拖拽指派——TaskDndProvider 随页包裹，现状本就按分支分别包裹）与
 * shared、taskDrawer、taskHeaderCard、taskSubtaskItem、taskDialogs。
 *
 * @module dsh-eteams/client/pages/tasks/taskDetailPage
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Plus from 'lucide-react/dist/esm/icons/plus.mjs';
import {
  createTeamTask,
  deleteTeamTask,
  pauseTeamTask,
  startTeamTask,
  updateTeamTask,
  type TaskSlotInput,
} from '../../lib/api';
import { cn } from '../../lib/cn';
import { errorMessageOf, runWithBusy } from '../../lib/errors';
import { refreshActivitySoon, type TaskView, type TeamSnapshot } from '../../lib/monitor';
import {
  StripAssignHint,
  TaskAssignDropBox,
  TaskDndProvider,
  TeamMemberStrip,
} from '../../features/tasks/taskAssign';
import {
  chainAfterRemove,
  depPatchesForReorder,
  executionOrderOf,
} from '../../features/tasks/taskAssignCore';
import {
  groupDisplayOf,
  isDetailReadOnly,
  isGroupStartable,
} from '../../features/tasks/taskDisplayStatus';
import { Button } from '../../components/ui/button';
import { TaskDetailContent, TaskStations } from './taskDrawer';
import { CreatingLoadingRow, FormErrorNote, GroupSummaryChip } from '../shared/components';
import { CHIP_CLASS, LIST_TITLE_CLASS, MUTED_CLASS } from '../shared/styles';
import { TaskHeaderCard } from './taskHeaderCard';
import { SubtaskItem } from './taskSubtaskItem';
import { TaskDialogs, type TaskEditTarget } from './taskDialogs';

/** ================================== 类型 ================================== */

/** 路由页入参（壳状态经 routes.tsx 传入，数据流与拆分前逐位一致）。 */
export interface TaskDetailPageProps {
  /** 当前团队快照（任务详情取数上下文；routes.tsx 保留 team undefined 守卫）。 */
  team: TeamSnapshot;
  /** 服务器时间（快照 serverTime/fetchedAt 派生，尝试时间线相对时间基准）。 */
  now: number;
}

/** ================================== 工具函数 ================================== */

/** ================================== 主组件 ================================== */

/**
 * 任务详情页（原 tasksTab 详情两分支收编，编辑态/编排瞬态随页）：
 * - 主任务（group）详情 = **整个任务的编排面**：头部卡 + 新增小
 *   任务 + 小任务卡片全套（执行序号/卡槽 TaskAssignDropBox/拖拽调执行顺序
 *   ——2026-09-13 经 SUBTASK_REORDER_ENABLED 暂时停用/修改删除）+ 成员
 *   罗列条（单条）；
 * - 任务/小任务详情 = 头部卡（含小任务的修改/删除）+ 挂靠行 + 详情正文
 *   （TaskDetailContent：合同四数组/状态说明/阻塞/产出/尝试时间线）+ 卡槽
 *   （小任务可拖拽指派）+ 站点行 + 依赖 chips + 成员罗列条。
 * 编辑/删除弹窗为组件内瞬态 useState（列表页各挂各的实例），保存/删除成功
 * 后 refreshActivitySoon 回拉快照；assignBusy/assignError/reorderError/
 * startError 瞬态错误就地 FormErrorNote。
 */
export function TaskDetailPage({ team, now }: TaskDetailPageProps): ReactNode {
  const navigate = useNavigate();
  // :taskId 路由参数即选中任务（八轮 DA21 导航：语义 = 原 ui model
  // drawerTaskId「详情页选中的任务 id」——改经路由参数进入，store 持久层
  // 由 routes.tsx 的 location sync 回写，语义不变）。
  const { taskId } = useParams();
  const selected =
    taskId === undefined ? null : (team.tasks.find((t) => t.taskId === Number(taskId)) ?? null);
  // 选中任务被删（快照里已无此 id；含 :taskId 非法段——Number NaN 查无）
  // 自动回落列表页（原 tasksTab 分支注记口径）：拆页前该窗口原地回落列表
  // 渲染，拆页后 navigate('/tasks')——渲染一帧空即跳列表（拆页显式接受的
  // 差异，见 46 清单 M3 验收注记）。
  // 用户 2026-09-13「我希望任务在创建中也能点进去看到子任务一个一个生成
  // 出来」：创建中容器放开进详情（推翻 2026-09-11「创建中不允许点进去」
  // 口径），只读档由下方 isDetailReadOnly 承担——本判据只剩 not-found
  // （快照里查无此 id，含 :taskId 非法段 Number NaN 查无）回落列表页。
  const enterable = selected !== null;
  useEffect(() => {
    if (!enterable) navigate('/tasks');
  }, [enterable, navigate]);
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
  // 二十四轮 DA37 面板开始任务瞬态（对齐 assignError 模式）：busy 按小任务
  // taskId 定位，error 单槽记录受影响小任务（行内展示——host 400 原文透出，
  // 含「需要选择成员」兜底）。
  const [startBusy, setStartBusy] = useState<number | null>(null);
  const [startError, setStartError] = useState<{ taskId: number; message: string } | null>(null);

  /* —— 事件处理 —— */

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
    // M7-5 busy/error 壳收口 runWithBusy（守卫留在调用点）。
    await runWithBusy(
      async () => {
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
      },
      setEditBusy,
      setEditError,
    );
  };
  // DA42 就地编辑整链随「撤下拉与修改」下线（用户迭代 2026-09-11）——小任务
  // 卡与头部卡都不再有「修改」钮/展开区/内联编辑器。
  const confirmDelete = async (): Promise<void> => {
    const target = deleteTarget;
    if (target === null) return;
    // M7-5 busy/error 壳收口 runWithBusy。
    await runWithBusy(
      async () => {
        await deleteTeamTask(team.teamId, target.taskId);
        setDeleteTarget(null);
        refreshActivitySoon();
      },
      setDeleteBusy,
      setDeleteError,
    );
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
      // 错误规范化收口 errorMessageOf（M7-5；错误槽是对象——不套 runWithBusy）。
      setAssignError({ taskId, message: errorMessageOf(e) });
    } finally {
      setAssignBusy(null);
    }
  };

  // 拖卡调执行顺序（七轮 DA20；十轮 DA23 订正：拖拽只在小任务卡把手——
  // 任务列表页无拖拽）：补丁由 depPatchesForReorder 以全量 team.tasks 现算
  // （兄弟集按同 parentId 从传入数组取），线性链改写只含 deps 实际变化且
  // ready 的卡，按序逐发 updateTeamTask({dependencies})——非乐观更新；
  // 部分失败也回拉快照对齐。
  // 2026-09-13「任务列表卡片暂时去掉拖拽」：把手拖拽经 taskSubtaskItem 的
  // SUBTASK_REORDER_ENABLED 暂时停用，本提交核与 reorderError 槽保留为恢复
  // 挂载位（关闭后不可达，不改变行为）。
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
      // 错误规范化收口 errorMessageOf（M7-5）。
      setReorderError({ taskId: toTaskId, message: errorMessageOf(e) });
      refreshActivitySoon();
    }
  };

  // 二十四轮 DA37 面板开始任务（用户拍板「卡片加上开始按钮」）：派发给执行
  // 链下一站（host /task/<id>/start 复用 assignTask 派发核——起子会话 +
  // 投递指派信，ready→wait 待接取）；空链卡不渲染按钮（行内「需要选择
  // 成员」提示），失败行内就地显示。非乐观更新，成功 refreshActivitySoon。
  // 二十五轮 DA38：同一路由开始主任务 = 逐个派发 ready 小任务（host 分支，
  // 响应带 started/skipped）——有跳过时行内就地提示（全跳过列首个原因、
  // 部分成功带计数；单任务路径跳过恒空，行为不变）。
  const submitStart = async (taskId: number): Promise<void> => {
    setStartBusy(taskId);
    setStartError((cur) => (cur !== null && cur.taskId === taskId ? null : cur));
    try {
      const result = await startTeamTask(team.teamId, taskId);
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
      // 错误规范化收口 errorMessageOf（M7-5）。
      setStartError({ taskId, message: errorMessageOf(e) });
    } finally {
      setStartBusy(null);
    }
  };

  // 用户迭代 2026-09-11：主任务开始后按钮变「暂停」——容器挂起在跑小任务 +
  // 容器本身；再点「开始」由宿主续跑。与 submitStart 共用 busy/error 瞬态槽。
  const submitPause = async (taskId: number): Promise<void> => {
    setStartBusy(taskId);
    setStartError((cur) => (cur !== null && cur.taskId === taskId ? null : cur));
    try {
      await pauseTeamTask(team.teamId, taskId);
      refreshActivitySoon();
    } catch (e) {
      setStartError({ taskId, message: errorMessageOf(e) });
    } finally {
      setStartBusy(null);
    }
  };

  if (selected === null) {
    // 防御位：:taskId 在快照里查无此任务（被删/非法段）——回列表导航已在上方
    // effect 落地，本帧渲染空（roster/rosterDetailPage 同款先例，名册回拉/
    // 导航到位即恢复）。创建中任务不再走本分支（2026-09-13 放开进详情，
    // 只读档见下方 isDetailReadOnly）。
    return null;
  }

  // 返回钮走壳层页头 onBack（用户迭代 2026-09-08：页面返回统一收口
  // PageHeader onBack 槽，页头行最右图标钮）——原页顶文字返回条撤。M3 拆页：
  // 导航回 /tasks——drawerTaskId 由 routes.tsx 的 location sync 回写（持久
  // 层终态与拆页前逐位一致）。
  // 详情页成员罗列条（八轮 DA21：编排收进详情，罗列条随编排走——仅
  // 存在可放置任务（ready）时渲染，作为卡槽的拖拽源）。二十四轮
  // DA37：指派提示拆出 StripAssignHint（与罗列条同判据另行渲染）。
  // 2026-09-13 只读档：创建中详情仍显示罗列条（成员全程可见）但 chip 禁拖
  // （readOnly 透传 TeamMemberStrip）。
  const detailStrip = (show: boolean, readOnly: boolean): ReactNode =>
    show ? <TeamMemberStrip team={team} readOnly={readOnly} /> : null;

  // 共用弹窗（详情页实例；列表页另有各挂各的）：编辑/新增 + 删除确认。
  // 瞬态 useState 不入 ui model；host 校验合同冻结（领取后），错误就地显示。
  // 三十一轮 DA44④：弹窗 JSX 抽 taskDialogs（TaskDialogs），状态/提交回调在此。
  const dialogs = (
    <TaskDialogs
      editTarget={editTarget}
      editSubject={editSubject}
      editDesc={editDesc}
      editBusy={editBusy}
      editError={editError}
      deleteTarget={deleteTarget}
      deleteBusy={deleteBusy}
      deleteError={deleteError}
      onCloseEdit={closeEdit}
      onSaveEdit={saveEdit}
      onEditSubject={setEditSubject}
      onEditDesc={setEditDesc}
      onDeleteConfirm={confirmDelete}
      onDeleteDismiss={() => {
        setDeleteTarget(null);
        setDeleteError(null);
      }}
    />
  );

  // ---- 主任务（group）详情页 = 整个任务的编排面（八轮 DA21）：头部卡 +
  // 新增小任务 + 小任务卡片全套（执行序号/卡槽/把手拖拽调序（十轮
  // DA23）/改删）+ 成员罗列条。二十五轮 DA38：小任务卡点击 → 小任务详情页
  // 的口径撤除（用户拍板「小任务不需要再点击进入任务详情了」）；主任务卡
  // 加整体「开始」按钮（见下任务列表标题行）。
  if (selected.kind === 'group') {
    // 七轮 DA20：小任务按执行序展示（兄弟依赖拓扑序，创建序平局）。
    const subs = executionOrderOf(team.tasks.filter((t) => t.parentId === selected.taskId));
    const done = subs.filter((t) => t.status === 'completed').length;
    // 用户 2026-09-13「任务在创建中也能点进去看到子任务一个一个生成出来」：
    // 创建中容器 = 只读观望档——团队成员/小任务照常可见（随快照陆续长出），
    // 但不给就地编辑入口（新增小任务/卡槽拖拽/删除/开始全收；宿主同闸拒
    // creating 的派发与开跑）。收口转 ready 后 readOnly 变 false，自动恢复
    // 既有编排面。
    const readOnly = isDetailReadOnly(selected.status, null);
    // docs/panelTaskCommission：就地编辑入口判据（与宿主 updateTask 白名单
    // 对齐）。用户迭代 2026-09-11：draft 并入 ready；2026-09-13：创建中只读，
    // 编辑窗口收窄为 ready。
    const mutable = !readOnly && selected.status === 'ready';
    // docs/29 B.2 组卡汇总：ready 且有小任务时叠加汇总 chip。
    const summary = selected.status === 'ready' && subs.length > 0 ? groupDisplayOf(subs) : null;
    // 罗列条/指派提示块渲染判据（八轮 DA21 口径；用户迭代 2026-09-11：
    // draft 并入 ready）：存在可放置任务（ready）才渲染，仍是卡槽拖拽源。
    // docs/panelTaskCommission：creating 占位也显示罗列条（成员随完善全程
    // 可见，仅展示无卡槽可放）；2026-09-13：只读档罗列条照显但 chip 禁拖，
    // 指派提示块不渲染。
    const stripShow = readOnly || subs.some((t) => t.status === 'ready');
    const assignHintShow = !readOnly && subs.some((t) => t.status === 'ready');
    return (
      <TaskDndProvider>
        <div>
          {/* 二十轮 DA33：头部卡收三件（用户拍板「把团队成员放到上面去和
            任务标题放一起」）——①进度行改**任务卡片同款三计数**（共 x 个
            任务，已完成 x，未完成 x，数字着色 success/warning；原「· 小任务
            n/m 完成」行与 draft 特例撤除）；②汇总 chip 随行入卡（ready 时，
            B.2 判据不变）；③成员罗列条上移入卡——二十三轮 DA36 曾移出卡，
            二十四轮 DA37 订正（用户拍板「团队成员还是在卡片内，只是拖拽
            成员到下方的成员卡槽完成指派不在」）：罗列条回卡内原位（只留
            chips 行），指派提示拆出 StripAssignHint 仍置卡下方（见下）。 */}
          <TaskHeaderCard
            task={selected}
            // 进度行 + 汇总 chip + 成员罗列条（DA41 行距规整：进度行与
            // chip 行 mt-1.5，对齐头部卡文件夹行）。
            extra={
              <>
                <div className="mt-1.5 text-xs text-muted-foreground">
                  共 {subs.length} 个任务，已完成 <span className="text-success">{done}</span>
                  ，未完成 <span className="text-warning">{subs.length - done}</span>
                </div>
                {summary !== null && (
                  <div className="mt-1.5">
                    <GroupSummaryChip summary={summary} />
                  </div>
                )}
                {detailStrip(stripShow, readOnly)}
              </>
            }
            // 二十八轮 DA41：头部卡右端动作槽（自「任务列表」行上移）。
            // 用户迭代 2026-09-11：**撤「编辑」钮**（下拉与修改整链下线）；
            // 主任务跑起来（start）时按钮变「暂停」（点击挂起在跑小任务 +
            // 容器），否则非终态且有小任务时渲染「开始」。
            // docs/panelTaskCommission：creating 容器不渲染开始钮（计划未定，
            // 与宿主 startGroupTask 同闸镜像），终态照旧收。
            actions={
              selected.status === 'start' && subs.length > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={startBusy === selected.taskId}
                  onClick={() => void submitPause(selected.taskId)}
                >
                  暂停
                </Button>
              ) : isGroupStartable(selected.status) && subs.length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={startBusy === selected.taskId}
                  onClick={() => void submitStart(selected.taskId)}
                >
                  开始
                </Button>
              ) : undefined
            }
          />
          {/* 二十四轮 DA37：指派提示块置头部卡下方（左小竖线；渲染判据与
            罗列条同源——存在 ready 小任务才渲染）。二十八轮 DA41：
            主任务开始的行内提示槽同步上移到头部卡之后、提示块之前（跳过的
            小任务按卡列原因；单小任务路径错误也走同槽，语义不变）。 */}
          {startError !== null && startError.taskId === selected.taskId && (
            <FormErrorNote>{startError.message}</FormErrorNote>
          )}
          {assignHintShow && <StripAssignHint />}
          {/* 二十轮 DA33：卡片下面加「任务列表」节标题（用户拍板「卡片下面
            加标题 任务列表」）——小任务编排区从此有标题。二十一轮 DA34
            修订（用户拍板「任务列表右侧是新增任务」）：标题行改 flex——
            标题居左（LIST_TITLE_CLASS 自带 flex-1 占满）、新增小任务钮
            靠右同排（列表页「任务 n 个」表头行同构）。二十八轮 DA41：
            「开始」钮自本行上移头部卡（opts.actions 槽，本行撤钮）、行距
            规整 mt-2.5；新增小任务钮与弹窗不动。 */}
          <div className="mt-2.5 flex items-center gap-3">
            <div className={LIST_TITLE_CLASS}>任务列表</div>
            {mutable && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => openEdit(selected, null)}
              >
                <Plus className="h-3.5 w-3.5" />
                新增小任务
              </Button>
            )}
          </div>
          {/* 三十一轮 DA44④：整块抽 taskSubtaskItem（SubtaskItem）。用户迭代
              2026-09-11：撤下拉与修改——展开态/就地编辑整链下线，小任务列表
              直接平铺（原 shadcn Accordion 多开受控随展开区一并撤除）。 */}
          {subs.map((t, subIndex) => {
            const subMutable = !readOnly && t.status === 'ready';
            return (
              <SubtaskItem
                key={t.taskId}
                task={t}
                subIndex={subIndex}
                members={team.members}
                subMutable={subMutable}
                readOnly={readOnly}
                assignBusy={assignBusy}
                assignError={assignError}
                reorderError={reorderError}
                startError={startError}
                onReorder={(from, to) => void submitReorder(from, to)}
                onDelete={() => setDeleteTarget(t)}
                onAssign={(chain) => void submitAssignChain(t.taskId, chain)}
                onRemoveStation={(index) =>
                  void submitAssignChain(t.taskId, chainAfterRemove(t, index))
                }
                onOpenEditDialog={() => openEdit(selected, t)}
              />
            );
          })}
          {/* docs/panelTaskCommission：0 条也显示（用户拍板「0条也要显示
            出来」）——非创建期子任务未落库时空态行兜底，任务列表区不空窗。 */}
          {subs.length === 0 && !readOnly && (
            <div className={cn(MUTED_CLASS, 'mt-2')}>暂无小任务</div>
          )}
          {/* 用户 2026-09-13「任务在创建中也能点进去看到子任务一个一个生成
              出来」：只读档在列表下方常驻「正在完善任务…」——小任务正随拆解
              逐个落库（快照 1s 轮询刷新），本行交代生成仍在进行。 */}
          {readOnly && (
            <div className="mt-2">
              <CreatingLoadingRow />
            </div>
          )}
          {dialogs}
        </div>
      </TaskDndProvider>
    );
  }

  // ---- 任务/小任务详情页（八轮 DA21）：头部卡 + 挂靠行 + 详情正文（合同/
  // 时间线）+ 卡槽（小任务可拖拽指派）+ 站点行 + 依赖 chips + 成员罗列条。
  // 用户迭代 2026-09-11：撤下拉与修改——头部卡「编辑」钮、展开区与就地编辑
  // 器整链下线，头部卡只留静态信息；开始/需要选择成员/删除/卡槽不动。
  const parent =
    selected.parentId !== null
      ? (team.tasks.find((t) => t.taskId === selected.parentId) ?? null)
      : null;
  // docs/panelTaskCommission：就地编辑入口判据（与 group 分支 mutable 及
  // 宿主 updateTask 白名单对齐）；用户迭代 2026-09-11：draft 并入 ready；
  // 2026-09-13：父仍为创建中时同走只读档（拆解期不给就地编排/删除/卡槽）。
  const readOnly = isDetailReadOnly(selected.status, parent?.status ?? null);
  const subMutable = !readOnly && selected.status === 'ready';
  return (
    <TaskDndProvider>
      <div>
        <TaskHeaderCard task={selected} />
        {parent !== null && (
          <div className={cn(MUTED_CLASS, 'mt-2')}>
            挂靠：#{parent.taskId} {parent.subject}
          </div>
        )}
        {parent !== null && subMutable && (
          /* 用户迭代 2026-09-11：小任务不再有「开始」钮（开始由主任务统一
          发起）；无链时保留「需要选择成员」数据提示，删除钮照旧。 */
          <div className="mt-1.5 flex items-center gap-1.5">
            {selected.status === 'ready' && selected.chain.length === 0 && (
              <span className={MUTED_CLASS}>需要选择成员</span>
            )}
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
        <TaskStations task={selected} members={team.members} />
        {selected.dependencies.length > 0 && (
          <div className="mt-1">
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
          <FormErrorNote>{assignError.message}</FormErrorNote>
        )}
        {startError !== null && startError.taskId === selected.taskId && (
          <FormErrorNote>{startError.message}</FormErrorNote>
        )}
        {detailStrip(parent !== null && subMutable, readOnly)}
        {parent !== null && subMutable && <StripAssignHint />}
        {dialogs}
      </div>
    </TaskDndProvider>
  );
}
