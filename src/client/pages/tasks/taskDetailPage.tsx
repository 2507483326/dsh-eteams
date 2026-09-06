/**
 * 任务详情页（docs/44 M3 自 tasksTab 拆出，行为零变更）：路由 /tasks/:taskId
 * ——返回条 + 头部卡（taskHeaderCard）+ 编排。:taskId 路由参数即选中的任务
 * id（语义 = 原 ui model drawerTaskId「详情页选中的任务 id」，八轮 DA21
 * 用户拍板「将任务做成任务详情页面和任务列表页面，点击到详情再编排整个
 * 任务」；store 持久层回写由 routes.tsx 的 location sync 承担——ui model
 * 语义不变）；选中任务被删（快照里已无此 id）自动回落列表页（原 tasksTab
 * 分支注记口径，navigate('/tasks') 落地）。
 * 主任务（group）详情 = **整个任务的编排面**：新增小任务 + 小任务卡片全套
 * （taskSubtaskItem：执行序号/卡槽/把手拖拽调序——十轮 DA23 把手化/改删/
 * 展开/就地编辑）+ 成员罗列条；任务/小任务：详情正文（taskDrawer 的
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
  startTeamTask,
  updateTeamTask,
  type TaskSlotInput,
} from '../../lib/api';
import { cn } from '../../lib/cn';
import { errorMessageOf, runWithBusy } from '../../lib/errors';
import { refreshActivitySoon, type TaskView, type TeamSnapshot } from '../../lib/monitor';
import { MdEditor } from '../../features/mdEditor/mdEditor';
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
import { groupDisplayOf, isStartable, isTerminal } from '../../features/tasks/taskDisplayStatus';
import { BackBar } from '../../components/backBar';
import { FormFooterActions } from '../../components/formDialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Accordion } from '../../components/ui/accordion';
import { mergedBodyOf } from './taskBody';
import { TaskDetailContent, TaskStations } from './taskDrawer';
import { FormErrorNote, GroupSummaryChip } from '../shared/components';
import {
  CHIP_CLASS,
  INLINE_SUBJECT_INPUT_CLASS,
  LIST_TITLE_CLASS,
  MUTED_CLASS,
} from '../shared/styles';
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
 * - 主任务（group）详情 = **整个任务的编排面**：返回条 + 头部卡 + 新增小
 *   任务 + 小任务卡片全套（执行序号/卡槽 TaskAssignDropBox/拖拽调执行顺序/
 *   修改删除）+ 成员罗列条（单条）；
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
  const taskFound = selected !== null;
  useEffect(() => {
    if (!taskFound) navigate('/tasks');
  }, [taskFound, navigate]);
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
  // 十八轮 DA31 小任务展开瞬态：展开态的小任务 id 列表（多开互不影响）。
  // 开合交互由 shadcn Accordion（Radix，type="multiple" 受控多开）承载。
  // DA42：展开内容 = 只读正文（说明 + 合同 MD，MarkdownDoc 只读渲染，docs/41）
  // / 就地编辑器二选一；「修改」未展开先展开——编辑器在展开区渲染。
  const [expandedSubIds, setExpandedSubIds] = useState<number[]>([]);
  // 三十三轮 DA46 头部卡展开瞬态：单槽 id——详情页一次只有一张头部卡，
  // 切换任务即视为收起（陈旧 id 无副作用）；「编辑」未展开先展开、编辑中
  // 收起仅隐藏草稿保留（DA42 语义同构——只读正文/编辑器二选一在展开区）。
  const [headerExpandedId, setHeaderExpandedId] = useState<number | null>(null);
  // DA41 就地编辑瞬态（与弹窗态 editTarget/editSubject/editDesc 完全分离）：
  // scope='sub' = 主任务详情页小任务卡内编辑；scope='header' = 任务详情页头部
  // 卡编辑。说明 + 合同并读为一个 MD 文本（mergedBodyOf），保存整篇回写
  // contractMd、description 落严格空串；DA42：打开小任务卡编辑先展开该卡
  // （编辑器在展开区渲染），不再收起。
  const [inlineEdit, setInlineEdit] = useState<{
    taskId: number;
    scope: 'sub' | 'header';
  } | null>(null);
  const [inlineSubject, setInlineSubject] = useState('');
  const [inlineBody, setInlineBody] = useState('');
  const [inlineBusy, setInlineBusy] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

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
  // DA42 就地编辑：打开（草稿 = 当前主题 + 说明/合同并读文本）。已在本卡
  // 编辑 = 只确保展开（幂等），草稿保留——收起后再点「修改」回到编辑态，
  // 表单不重置（重拉会静默丢弃未保存草稿）。
  const openInlineEdit = (t: TaskView, scope: 'sub' | 'header'): void => {
    if (inlineEdit !== null && inlineEdit.taskId === t.taskId && inlineEdit.scope === scope) {
      if (scope === 'sub') {
        setExpandedSubIds((ids) => (ids.includes(t.taskId) ? ids : [...ids, t.taskId]));
      } else {
        // DA46 头部卡同语义：同卡同 scope 重开 = 幂等确保展开（草稿保留）。
        setHeaderExpandedId(t.taskId);
      }
      return;
    }
    setInlineEdit({ taskId: t.taskId, scope });
    setInlineSubject(t.subject);
    setInlineBody(mergedBodyOf(t));
    setInlineError(null);
    // DA42：原「打开编辑收起该卡」撤除——点「修改」未展开先展开、已展开保持。
    if (scope === 'sub') {
      setExpandedSubIds((ids) => (ids.includes(t.taskId) ? ids : [...ids, t.taskId]));
    } else {
      // DA46 头部卡同语义：「编辑」未展开先展开（编辑器在展开区渲染）。
      setHeaderExpandedId(t.taskId);
    }
  };
  const closeInlineEdit = (): void => {
    setInlineEdit(null);
    setInlineError(null);
  };
  // 保存 = updateTeamTask：主题 + 并读正文（contractMd 整篇替换）+ description
  // 落严格空串——host 端 contractMd raw 透传保真。非乐观更新，成功回拉快照。
  const saveInlineEdit = async (): Promise<void> => {
    const target = inlineEdit;
    if (target === null) return;
    // M7-5 busy/error 壳收口 runWithBusy。
    await runWithBusy(
      async () => {
        await updateTeamTask(team.teamId, target.taskId, {
          subject: inlineSubject.trim(),
          contractMd: inlineBody,
          description: '',
        });
        closeInlineEdit();
        refreshActivitySoon();
      },
      setInlineBusy,
      setInlineError,
    );
  };
  const confirmDelete = async (): Promise<void> => {
    const target = deleteTarget;
    if (target === null) return;
    // M7-5 busy/error 壳收口 runWithBusy。
    await runWithBusy(
      async () => {
        await deleteTeamTask(team.teamId, target.taskId);
        setDeleteTarget(null);
        // DA42：被删任务正处就地编辑则清编辑槽（防陈旧草稿复活）。
        if (inlineEdit?.taskId === target.taskId) closeInlineEdit();
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
  // draft/ready 的卡，按序逐发 updateTeamTask({dependencies})——非乐观更新；
  // 部分失败也回拉快照对齐。
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
      // DA42：开始成功即清本卡编辑槽（ready→wait 后草稿已陈旧，防复活）。
      // 小任务卡与任务详情页头部卡共用此入口，两种 scope 一并清。
      if (inlineEdit?.taskId === taskId) closeInlineEdit();
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

  if (selected === null) {
    // 防御位：:taskId 在快照里查无此任务（被删/非法段）——回列表导航已在
    // 上方 effect 落地，本帧渲染空（roster/rosterDetailPage 同款先例，
    // 名册回拉/导航到位即恢复）。
    return null;
  }

  // 返回列表条（详情页顶部；ArrowLeft + 可点击文字）。M3 拆页：原
  // setSelectedTaskId(null) 改导航——drawerTaskId 由 routes.tsx 的
  // location sync 回写（持久层终态与拆页前逐位一致）。（M7-3 收口
  // components/backBar 文字钮档——裸 button + 大一号图标原样。）
  const backBar = <BackBar variant="text" label="返回列表" onClick={() => navigate('/tasks')} />;
  // 详情页成员罗列条（八轮 DA21：编排收进详情，罗列条随编排走——仅
  // 存在可放置任务（draft/ready）时渲染，作为卡槽的拖拽源）。二十四轮
  // DA37：指派提示拆出 StripAssignHint（与罗列条同判据另行渲染）。
  const detailStrip = (show: boolean): ReactNode => (show ? <TeamMemberStrip team={team} /> : null);

  // DA41 就地编辑器（小任务卡 scope='sub' 与头部卡 scope='header' 共用一
  // 节点，各自条件渲染）：说明/合同并读 MD 编辑器 + 取消/保存行 + 错误行。
  // 保存 disabled = busy 或主题空白；主题空白不可保存（与弹窗口径一致）。
  // 三十轮 DA43：标题撤出编辑器块（主题 Input 移行头/头部卡原位切换），
  // 正文换角色手册同款 MdEditor（minHeight 220 + 任务占位/头部文案，
  // readOnly={inlineBusy} 锁保存飞行中编辑）。
  const inlineEditor = (
    <div className="mt-1.5 space-y-1.5">
      <MdEditor
        value={inlineBody}
        onChange={setInlineBody}
        minHeight={220}
        placeholder="说明 / 合同（Markdown）"
        headerNote="说明 + 合同 · 所见即所得"
        readOnly={inlineBusy}
      />
      {inlineError !== null && <FormErrorNote>{inlineError}</FormErrorNote>}
      {/* 尾行（M7-1 收口 FormFooterActions）。 */}
      <FormFooterActions
        cancelDisabled={inlineBusy}
        confirmDisabled={inlineBusy || inlineSubject.trim() === ''}
        confirmLabel="保存"
        onCancel={closeInlineEdit}
        onConfirm={() => void saveInlineEdit()}
      />
    </div>
  );

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

  // ---- 主任务（group）详情页 = 整个任务的编排面（八轮 DA21）：返回条 +
  // 头部卡 + 新增小任务 + 小任务卡片全套（执行序号/卡槽/把手拖拽调序（十轮
  // DA23）/改删）+ 成员罗列条。二十五轮 DA38：小任务卡点击 → 小任务详情页
  // 的口径撤除（用户拍板「小任务不需要再点击进入任务详情了」）；主任务卡
  // 加整体「开始」按钮（见下任务列表标题行）。
  if (selected.kind === 'group') {
    // 七轮 DA20：小任务按执行序展示（兄弟依赖拓扑序，创建序平局）。
    const subs = executionOrderOf(team.tasks.filter((t) => t.parentId === selected.taskId));
    const done = subs.filter((t) => t.status === 'completed').length;
    const mutable = selected.status === 'draft' || selected.status === 'ready';
    // 三十一轮 DA44⑥：头部卡主题原位编辑态（与任务详情页头部卡同构——本任务
    // + scope='header' 才开编辑器）。
    const headerEditing =
      inlineEdit !== null && inlineEdit.taskId === selected.taskId && inlineEdit.scope === 'header';
    // docs/29 B.2 组卡汇总：ready 且有小任务时叠加汇总 chip。
    const summary = selected.status === 'ready' && subs.length > 0 ? groupDisplayOf(subs) : null;
    // 罗列条/指派提示块渲染判据（八轮 DA21 口径）：存在可放置任务
    // （draft/ready）才渲染，仍是卡槽拖拽源。
    const stripShow = subs.some((t) => t.status === 'draft' || t.status === 'ready');
    return (
      <TaskDndProvider>
        <div>
          {backBar}
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
                {detailStrip(stripShow)}
              </>
            }
            // 二十八轮 DA41：头部卡「开始」钮入卡右端（自「任务列表」行
            // 上移，opts.actions 槽）——非终态且有小任务才渲染（DA40 判据
            // 不变；点击逐个派发 ready 小任务，跳过原因行内就地提示）。
            // 三十一轮 DA44⑥：「编辑」钮加在开始钮之前（开始保持最右）。
            // M3：状态窗口收拢 isTerminal 谓词（判定逐位等价）。
            actions={
              <>
                {mutable && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => openInlineEdit(selected, 'header')}
                  >
                    编辑
                  </Button>
                )}
                {!isTerminal(selected.status) && subs.length > 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={startBusy === selected.taskId}
                    onClick={() => void submitStart(selected.taskId)}
                  >
                    开始
                  </Button>
                ) : undefined}
              </>
            }
            // 三十一轮 DA44⑥：主题原位编辑 + 编辑器槽（与任务详情页头部卡
            // 同构——headerEditing 时 Input 承担标题展示，编辑器入卡尾）。
            subjectEditor={
              headerEditing ? (
                <Input
                  autoFocus
                  value={inlineSubject}
                  disabled={inlineBusy}
                  className={INLINE_SUBJECT_INPUT_CLASS}
                  placeholder="任务主题"
                  onChange={(e) => setInlineSubject(e.target.value)}
                />
              ) : undefined
            }
            editor={headerEditing ? inlineEditor : undefined}
            // 三十三轮 DA46：头部卡展开接线——编辑器入展开区（「编辑」先
            // 展开，编辑中可收起隐藏草稿保留；单槽 id 切换任务即收起）。
            editing={headerEditing}
            expanded={headerExpandedId === selected.taskId}
            onToggleExpanded={() =>
              setHeaderExpandedId((cur) => (cur === selected.taskId ? null : selected.taskId))
            }
          />
          {/* 二十四轮 DA37：指派提示块置头部卡下方（左小竖线；渲染判据与
            罗列条同源——存在 draft/ready 小任务才渲染）。二十八轮 DA41：
            主任务开始的行内提示槽同步上移到头部卡之后、提示块之前（跳过的
            小任务按卡列原因；单小任务路径错误也走同槽，语义不变）。 */}
          {startError !== null && startError.taskId === selected.taskId && (
            <FormErrorNote>{startError.message}</FormErrorNote>
          )}
          {stripShow && <StripAssignHint />}
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
          {/* 十八轮 DA31：小任务列表展开升级 **shadcn Accordion**（Radix
            多开受控——type="multiple" + value=expandedSubIds，多开互不影响
            由组件承载；原逐卡 Collapsible + 手写开合状态机撤除）。触发钮/
            展开位/拖拽结构不变：AccordionItem 替代原包装 div（键与改删错误
            行原位保留），上游默认 border-b 以 border-b-0 压平（卡片自带
            mt 间距）；不展开位（卡槽/站点行）仍在 Item 内、内容区外。 */}
          {/* 三十一轮 DA44④：AccordionItem 整块抽 taskSubtaskItem（SubtaskItem）
              ——suppressStations/expandable 判据随迁组件内现算，状态/回调经
              props 传入。 */}
          <Accordion
            type="multiple"
            value={expandedSubIds.map(String)}
            onValueChange={(v) => setExpandedSubIds(v.map(Number))}
          >
            {subs.map((t, subIndex) => {
              const subMutable = t.status === 'draft' || t.status === 'ready';
              // DA42：本卡正处小任务卡编辑（可编辑 + 本卡 + scope 对上）——
              // 展开区换编辑器，行头钮簇/卡槽保持常显。
              const editing =
                inlineEdit !== null &&
                inlineEdit.taskId === t.taskId &&
                inlineEdit.scope === 'sub' &&
                subMutable;
              return (
                <SubtaskItem
                  key={t.taskId}
                  task={t}
                  subIndex={subIndex}
                  members={team.members}
                  editing={editing}
                  subMutable={subMutable}
                  expanded={expandedSubIds.includes(t.taskId)}
                  startBusy={startBusy}
                  assignBusy={assignBusy}
                  assignError={assignError}
                  reorderError={reorderError}
                  startError={startError}
                  subjectEditor={
                    editing ? (
                      <Input
                        autoFocus
                        value={inlineSubject}
                        disabled={inlineBusy}
                        className={INLINE_SUBJECT_INPUT_CLASS}
                        placeholder="小任务主题"
                        onChange={(e) => setInlineSubject(e.target.value)}
                      />
                    ) : undefined
                  }
                  editor={editing ? inlineEditor : undefined}
                  onReorder={(from, to) => void submitReorder(from, to)}
                  onStart={(taskId) => void submitStart(taskId)}
                  onInlineEdit={() => openInlineEdit(t, 'sub')}
                  onDelete={() => setDeleteTarget(t)}
                  onAssign={(chain) => void submitAssignChain(t.taskId, chain)}
                  onRemoveStation={(index) =>
                    void submitAssignChain(t.taskId, chainAfterRemove(t, index))
                  }
                  onOpenEditDialog={
                    inlineEdit !== null &&
                    inlineEdit.taskId === t.taskId &&
                    inlineEdit.scope === 'sub'
                      ? () => undefined
                      : () => openEdit(selected, t)
                  }
                />
              );
            })}
          </Accordion>
          {dialogs}
        </div>
      </TaskDndProvider>
    );
  }

  // ---- 任务/小任务详情页（八轮 DA21）：返回条 + 头部卡（小任务含修改/
  // 删除）+ 挂靠行 + 详情正文（合同/时间线）+ 卡槽（小任务可拖拽指派）+
  // 站点行 + 依赖 chips + 成员罗列条。二十八轮 DA41：头部卡右端加「编辑」
  // 钮 + 就地编辑器（editor 槽，编辑时静态主题隐藏由 Input 承担）；按钮行
  // 撤「修改」钮（就地编辑接管）；卡槽 onOpenEdit 在编辑态防御性哑化。
  // 三十轮 DA43：编辑器撤标题 Input，主题原位编辑走 subjectEditor 槽
  // （编辑态行头 span↔Input 切换）。
  const parent =
    selected.parentId !== null
      ? (team.tasks.find((t) => t.taskId === selected.parentId) ?? null)
      : null;
  const subMutable = selected.status === 'draft' || selected.status === 'ready';
  // DA41 头部卡就地编辑态：本任务 + scope='header' 才开编辑器。
  const headerEditing =
    inlineEdit !== null && inlineEdit.taskId === selected.taskId && inlineEdit.scope === 'header';
  return (
    <TaskDndProvider>
      <div>
        {backBar}
        <TaskHeaderCard
          task={selected}
          actions={
            subMutable ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => openInlineEdit(selected, 'header')}
              >
                编辑
              </Button>
            ) : undefined
          }
          // 三十轮 DA43：主题原位编辑（编辑态行头 span↔Input 切换，行头
          // 编辑器块不再承担标题展示）。
          subjectEditor={
            headerEditing ? (
              <Input
                autoFocus
                value={inlineSubject}
                disabled={inlineBusy}
                className={INLINE_SUBJECT_INPUT_CLASS}
                placeholder="任务主题"
                onChange={(e) => setInlineSubject(e.target.value)}
              />
            ) : undefined
          }
          editor={headerEditing ? inlineEditor : undefined}
          // 三十三轮 DA46：头部卡展开接线（同组页——编辑器入展开区，
          // 「编辑」先展开，编辑中可收起隐藏草稿保留）。
          editing={headerEditing}
          expanded={headerExpandedId === selected.taskId}
          onToggleExpanded={() =>
            setHeaderExpandedId((cur) => (cur === selected.taskId ? null : selected.taskId))
          }
        />
        {parent !== null && (
          <div className={cn(MUTED_CLASS, 'mt-2')}>
            挂靠：#{parent.taskId} {parent.subject}
          </div>
        )}
        {parent !== null && subMutable && (
          /* 二十四轮 DA37：行首加开始按钮（与组详情页小任务卡同判据——
          ready 且有链渲染、ready 无链渲染「需要选择成员」提示）。二十八轮
          DA41：「修改」钮撤除——头部卡「编辑」钮就地编辑接管。M3：状态
          窗口收拢 isStartable 谓词（判定逐位等价）。 */
          <div className="mt-1.5 flex items-center gap-1.5">
            {isStartable(selected.status) && selected.chain.length > 0 && (
              <Button
                type="button"
                size="sm"
                disabled={startBusy === selected.taskId}
                onClick={() => void submitStart(selected.taskId)}
              >
                开始
              </Button>
            )}
            {isStartable(selected.status) && selected.chain.length === 0 && (
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
        <TaskStations task={selected} />
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
              onOpenEdit={
                inlineEdit !== null && inlineEdit.taskId === selected.taskId
                  ? () => undefined
                  : () => openEdit(parent, selected)
              }
            />
          </div>
        )}
        {assignError !== null && assignError.taskId === selected.taskId && (
          <FormErrorNote>{assignError.message}</FormErrorNote>
        )}
        {startError !== null && startError.taskId === selected.taskId && (
          <FormErrorNote>{startError.message}</FormErrorNote>
        )}
        {detailStrip(parent !== null && subMutable)}
        {parent !== null && subMutable && <StripAssignHint />}
        {dialogs}
      </div>
    </TaskDndProvider>
  );
}
