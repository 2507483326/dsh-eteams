/**
 * 任务列表页（docs/44 M3 自 tasksTab 拆出，行为零变更）：路由 /tasks——
 * 平铺小卡栅格（Card 面板 + 任务小卡，一卡一顶层任务，整卡点击进详情，
 * 无拖拽；不列小任务明细——九轮 DA22 口径）+ 空态行。整卡/详情钮点击经
 * navigate('/tasks/:taskId') 进详情页（ui model drawerTaskId 语义不变：
 * routes.tsx 的 location sync 回写，M1 注记的「ui/setDrawerTask 回写随
 * M3」就此落地）；删除确认弹窗就地（TaskDialogs——编辑/新增弹窗入口都在
 * 详情页，本页 editTarget 恒 null、编辑弹窗不渲染，props 以惰性值占位）。
 * 列表本地态：folderBusy/folderError（文件夹打开）、startBusy/startError
 * （组卡开始）、deleteTarget/deleteBusy/deleteError（删除确认）。导航状态
 * 不在本页：详情选中的任务 id 走 :taskId 路由参数（与拆页前 ui model
 * drawerTaskId 驱动的「返回任务页恢复详情」重挂口径一致，见 routes.tsx
 * initialEntries）。依赖 features/tasks（拖拽指派——TaskDndProvider 随页
 * 包裹，现状本就按分支分别包裹）与 shared、taskListCard、taskDialogs。
 * 面板手动建任务（docs/panelTaskCommission）：头部行「＋ 添加任务」按钮 +
 * addTaskDialog 弹窗（描述 + 选团队）——提交走宿主 commission 路由建
 * 「创建中」容器交完善者；props 增 pool/sessionId/onSelectTeam（routes.tsx
 * 透传，跨队提交后切选中团队即落该队任务页）。
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

/** 路由页入参（壳状态经 routes.tsx 传入，数据流与拆分前逐位一致）。 */
export interface TasksPageProps {
  /** 当前团队快照（任务列表取数上下文；routes.tsx 保留 team undefined 守卫）。 */
  team: TeamSnapshot;
  /** 全部团队池（添加任务弹窗的团队选项——docs/panelTaskCommission §4.2）。 */
  pool: TeamSnapshot[];
  /** 当前宿主会话 id（整页覆盖层 undefined）——commission 路由按它找主会话锚。 */
  sessionId: string | undefined;
  /** 选中团队回写（ui/setSelectedTeam）：跨队提交后切选中团队，留在 /tasks。 */
  onSelectTeam: (teamId: string) => void;
}

/** ================================== 主组件 ================================== */

/**
 * 任务列表页：与团队列表同款 Card 面板 + **平铺任务小卡栅格**（不分「对话
 * 任务」/状态分区——用户十一轮拍板「任务主列表不分对话任务、待指派这种，
 * 做成团队那种小卡片」；一卡一顶层任务，整卡点击进详情；**不列小任务明细**
 * ——用户九轮拍板「任务卡片不展示任务详情和整个任务列表，需要点击进去再
 * 看到整个任务列表」；无编排 UI、无拖拽——卡槽/罗列条/改删按钮全迁详情页）。
 * 编辑/删除弹窗为组件内瞬态 useState（编辑弹窗入口在详情页，本页仅删除确
 * 认可达），删除成功后 refreshActivitySoon 回拉快照；folderError/startError
 * 瞬态错误行内就地显示（槽在 TaskListCard）。添加任务弹窗（docs/panelTask
 * Commission）同为瞬态 useState：open/description/teamId/busy/error，头部行
 * 按钮打开、跨队提交后 onSelectTeam 切选中团队。
 */
export function TasksPage({ team, pool, sessionId, onSelectTeam }: TasksPageProps): ReactNode {
  const navigate = useNavigate();
  // 十二轮 DA25 文件夹打开瞬态（对齐 assignError 模式）：error 按卡定位行内
  // 展示（宿主 404/400/500 原样透出——文件夹缺失等）。
  const [folderBusy, setFolderBusy] = useState<number | null>(null);
  const [folderError, setFolderError] = useState<{ taskId: number; message: string } | null>(null);
  // 二十四轮 DA37 面板开始任务瞬态（对齐 assignError 模式）：busy 按小任务
  // taskId 定位，error 单槽记录受影响小任务（行内展示——host 400 原文透出，
  // 含「需要选择成员」兜底）。
  const [startBusy, setStartBusy] = useState<number | null>(null);
  const [startError, setStartError] = useState<{ taskId: number; message: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskView | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // 添加任务弹窗（docs/panelTaskCommission）：open/description/teamId/busy/
  // error 瞬态组——teamId 默认当前团队（open 即回填，池变化不残留悬空 id）；
  // busy/error 壳走 runWithBusy（失败弹窗内就地显示、不关弹窗）。
  const [addOpen, setAddOpen] = useState(false);
  const [addDesc, setAddDesc] = useState('');
  const [addTeamId, setAddTeamId] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  /* —— 事件处理 —— */

  // 打开弹窗：描述清空、目标团队回填当前团队（每次打开重置，防上一次
  // 草稿/悬空团队 id 残留——切换团队后重开即跟随新选中）。
  const openAddDialog = (): void => {
    setAddDesc('');
    setAddTeamId(team.teamId);
    setAddError(null);
    setAddOpen(true);
  };

  // 提交手动建任务（docs/panelTaskCommission §4.2）：宿主建「创建中」容器
  // 并交完善者（有领队 = 领队子代理；无领队 = 主会话唤醒）。成功关弹窗 +
  // 回拉快照；跨队提交 onSelectTeam 切选中团队（不导航——留在 /tasks 落
  // 该队任务页）。dispatched:false = 任务仍创建成功、完善者未送达（无锚/
  // 绑定他队）——toast 提示原因，卡片保留创建中可删（逃生门）。失败吃 400
  // 原文就地显示在弹窗内。
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
        if (addTeamId !== team.teamId) onSelectTeam(addTeamId);
        refreshActivitySoon();
      },
      setAddBusy,
      setAddError,
    );
  };

  // 二十四轮 DA37 面板开始任务（用户拍板「卡片加上开始按钮」）：派发给执行
  // 链下一站（host /task/<id>/start 复用 assignTask 派发核——起子会话 +
  // 投递指派信，ready→wait 待接取）；空链卡不渲染按钮（行内「需要选择
  // 成员」提示），失败行内就地显示。非乐观更新，成功 refreshActivitySoon。
  // 二十五轮 DA38：同一路由开始主任务 = 逐个派发 ready 小任务（host 分支，
  // 响应带 started/skipped）——有跳过时行内就地提示（全跳过列首个原因、
  // 部分成功带计数；单任务路径跳过恒空，行为不变）。（M3 拆页注记：列表
  // 卡开始无就地编辑槽可清——原 tasksTab 的 inlineEdit 清理行属详情页。）
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
      // 错误规范化收口 errorMessageOf（M7-5；错误槽是对象——不套 runWithBusy）。
      setStartError({ taskId, message: errorMessageOf(e) });
    } finally {
      setStartBusy(null);
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
      // 错误规范化收口 errorMessageOf（M7-5；错误槽是对象——不套 runWithBusy）。
      setFolderError({ taskId, message: errorMessageOf(e) });
    } finally {
      setFolderBusy(null);
    }
  };

  // 删除确认（列表卡删除钮）：host 仍是最终裁决，拒绝原因就地显示。
  // （M3 拆页注记：列表页无就地编辑槽——原 tasksTab 的 inlineEdit 清理行
  // 属详情页；被删任务正处详情页就地编辑时，详情页卸载即弃，无陈旧草稿
  // 复活路径。）
  const confirmDelete = async (): Promise<void> => {
    const target = deleteTarget;
    if (target === null) return;
    // M7-5 busy/error 壳收口 runWithBusy（守卫留在调用点）。
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
  // 卸载销毁；1s 轮询只换数据不重挂 Provider）。原 tasksTab 三分支各自包裹，
  // 拆页后列表页/详情页各包各的（现状口径不变）。
  return (
    <TaskDndProvider>
      {/* 列表卡满高（用户迭代 2026-09-07）：页根占内容列剩余空间，卡 flex-1
      拉满、栅格 min-h-0 内部滚动（卡满高、页头常驻可视）。 */}
      <div className="flex min-h-0 flex-1 flex-col">
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
          // 面板手动建任务（docs/panelTaskCommission）：Card 与头部行常驻
          // （空态也在卡内——「添加任务」钮常驻右上角，首任务从这进）；
          // 空态文案补「点右上角添加任务」指路。
          return (
            <Card className={cn(PANEL_CARD_CLASS, 'pb-3 flex min-h-0 flex-1 flex-col')}>
              <div className="mb-2.5 flex items-center gap-2">
                <h3 className={LIST_TITLE_CLASS}>任务</h3>
                <span className={LIST_COUNT_CLASS}>{mainTasks.length} 个</span>
                <Button type="button" size="sm" className="ml-auto" onClick={openAddDialog}>
                  <Plus className="h-3.5 w-3.5" />
                  添加任务
                </Button>
              </div>
              {mainTasks.length === 0 ? (
                <div className={EMPTY_CLASS}>
                  还没有任务。在对话中把任务交给团队，或计划批准后任务会出现在这里；也可以点右上角「添加任务」手动创建。
                </div>
              ) : (
                <div className={cn(TASK_GRID_CLASS, 'min-h-0 flex-1 content-start overflow-y-auto')}>
                  {mainTasks.map((t) => (
                    // 三十一轮 DA44④：列表卡身抽 taskListCard（TaskListCard）——
                    // subs 统计/deletable 判据随迁卡内现算（task/allTasks 进 props）。
                    <TaskListCard
                      key={t.taskId}
                      task={t}
                      allTasks={team.tasks}
                      folderBusy={folderBusy}
                      folderError={folderError}
                      startError={startError}
                      startBusy={startBusy}
                      // M3 拆页：原 setSelectedTaskId(t.taskId) 改导航——
                      // drawerTaskId 由 routes.tsx 的 location sync 回写。
                      onOpen={() => navigate(`/tasks/${t.taskId}`)}
                      onOpenFolder={(taskId) => void openFolder(taskId)}
                      onDelete={() => setDeleteTarget(t)}
                      onStart={() => void submitStart(t.taskId)}
                    />
                  ))}
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
