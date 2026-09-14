/**
 * 组详情页小任务卡条目（2026-09-05 三十一轮 DA44④ 自 tasksTab 纯移动抽离）：
 * SUBTASK_CARD_CLASS + SubtaskCard（私有——唯一消费方是本文件的 SubtaskItem）
 * + SubtaskItem，承载组页小任务卡整块（行头/钮簇/卡槽/TaskStations/错误行）。
 * 原 Accordion 根/展开态由消费页持有；用户迭代 2026-09-11 **撤下拉与修改**
 * ——展开箭头、展开区正文、行头「修改」钮与就地编辑器整条链一并撤除（用户
 * 原话「去掉主任务和子任务的下拉和修改按钮」），卡面只剩：状态 pill + 序号 +
 * 主题 + 指派人、开始/需要选择成员、删除、卡槽、执行链站点行。
 * 用户 2026-09-13「任务列表卡片暂时去掉拖拽」：小任务卡 grip 把手拖拽调序
 * 经 SUBTASK_REORDER_ENABLED 开关暂时停用（见常量注；成员拖拽指派不受影响）。
 *
 * @module dsh-eteams/client/pages/tasks/taskSubtaskItem
 */
import type { ReactNode } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import GripVertical from 'lucide-react/dist/esm/icons/grip-vertical.mjs';
import type { TaskSlotInput } from '../../lib/api';
import { cn } from '../../lib/cn';
import type { MemberView, TaskView } from '../../lib/monitor';
import {
  SUBTASK_DRAG_TYPE,
  TaskAssignDropBox,
  type SubtaskDragItem,
} from '../../features/tasks/taskAssign';
import { boxCoversChain } from '../../features/tasks/taskAssignCore';
import { DeleteButton } from '../../components/deleteButton';
import { TaskStations } from './taskDrawer';
import { FormErrorNote, TaskStatusPill } from '../shared/components';
import { MUTED_CLASS, TASK_CARD_CLASS } from '../shared/styles';

/** 瞬态错误槽（assignError/reorderError/startError 同构：taskId 定位 + 行内展示）。 */
interface TaskErrorSlot {
  taskId: number;
  message: string;
}

/** 七轮 DA20 + 十轮 DA23：小任务卡片——与组卡同观感的全边框卡，左上 grip
 * 把手 = 唯一拖拽源，卡身兼放置目标（拖 A 到 B = A 搬到 B 的执行位）。
 * 二十一轮 DA34：七轮的挂靠缩进 ml-4 撤除（用户拍板「下面的任务列表左边
 * 不留空隙」——卡片化后小任务卡已不在组卡内嵌套，缩进无嵌套语义）。二十五
 * 轮 DA38：卡身点击进小任务详情撤除（用户拍板「小任务不需要再点击进入任务
 * 详情了」）——cursor-pointer 与整卡 onClick 一并移除，卡身只承担放置
 * 目标。三十一轮 DA44⑤：isOver 高亮改 ring-inset（目标卡四边内缘高亮，免疫
 * 卡身滚动容器 overflow-x-hidden 的外缘裁剪）。 */
const SUBTASK_CARD_CLASS = `mt-1.5 ${TASK_CARD_CLASS}`;

/** 小任务卡 grip 拖拽调序开关（用户 2026-09-13「任务列表卡片暂时去掉拖拽」）：
 * 置 false = 左上把手不渲染、拖拽源（canDrag）与放置目标（canDrop）双关，
 * 小任务卡只读不可调序；恢复 = 置回 true（原拖拽链路原样，无需改其它代码）。
 * 显式标注 boolean——避免字面量 false 收窄成常量条件。 */
const SUBTASK_REORDER_ENABLED: boolean = false;

/** 小任务列表删除钮开关（用户 2026-09-14「子任务列表暂时隐藏删除按钮」）：
 * 置 false = 小任务卡不再渲染「删除」钮（subMutable 判据保留，其它编排面
 * 不动）；恢复 = 置回 true（原删除链路原样，无需改其它代码）。显式标注
 * boolean——避免字面量 false 收窄成常量条件。 */
const SUBTASK_DELETE_ENABLED: boolean = false;

/** 小任务卡片（七轮 DA20 调序 + 十轮 DA23 把手化）：**只有左上 grip 把手
 * 可拖**（'eteams-subtask'，ready 才可拖），卡身不可拖。二十五轮 DA38：
 * 整卡点击 = 进小任务详情页的口径撤除；卡身只作为放置目标（同父兄弟卡才亮；
 * drop 时 onReorder 以最新快照现算依赖改写补丁，非乐观更新）。拖拽中
 * 半透明、悬停 ring 高亮。2026-09-13：经 SUBTASK_REORDER_ENABLED 暂时停用
 * ——把手不渲染、drag/drop 双关（见常量注）。 */
function SubtaskCard({
  task,
  onReorder,
  children,
}: {
  task: TaskView;
  onReorder: (fromTaskId: number, toTaskId: number) => void;
  children: ReactNode;
}): ReactNode {
  const editable = task.status === 'ready';
  const [{ isDragging }, dragRef] = useDrag<SubtaskDragItem, unknown, { isDragging: boolean }>(
    () => ({
      type: SUBTASK_DRAG_TYPE,
      item: { taskId: task.taskId, parentId: task.parentId, editable },
      canDrag: () => SUBTASK_REORDER_ENABLED && editable,
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    }),
    [task.taskId, task.parentId, editable],
  );
  const [{ isOver }, dropRef] = useDrop<SubtaskDragItem, unknown, { isOver: boolean }>(
    () => ({
      accept: SUBTASK_DRAG_TYPE,
      canDrop: (item) =>
        SUBTASK_REORDER_ENABLED &&
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
        isOver && 'ring-1 ring-inset ring-primary',
      )}
    >
      <div className="flex items-start gap-1.5">
        {SUBTASK_REORDER_ENABLED && (
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
        )}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

/** 组详情页小任务卡条目：状态（assignBusy/error 瞬态）与提交回调
 * 由消费页持有（tasks/taskDetailPage），经 props 传入；suppressStations
 * （boxCoversChain）随块在组件内现算。2026-09-13：readOnly 档（创建中详情）
 * 不渲染成员卡槽——整页只读。 */
export function SubtaskItem({
  task,
  subIndex,
  members,
  subMutable,
  readOnly = false,
  assignBusy,
  assignError,
  reorderError,
  startError,
  onReorder,
  onDelete,
  onAssign,
  onRemoveStation,
  onOpenEditDialog,
}: {
  task: TaskView;
  subIndex: number;
  members: readonly MemberView[];
  subMutable: boolean;
  /** 只读档（2026-09-13 创建中详情）：不渲染成员卡槽（整页只读，无拖拽
   * 指派入口；执行链仍由 TaskStations 呈现）。 */
  readOnly?: boolean;
  assignBusy: number | null;
  assignError: TaskErrorSlot | null;
  reorderError: TaskErrorSlot | null;
  startError: TaskErrorSlot | null;
  onReorder: (fromTaskId: number, toTaskId: number) => void;
  onDelete: () => void;
  onAssign: (chain: TaskSlotInput[]) => void;
  onRemoveStation: (index: number) => void;
  /** 卡槽「修改」入口（六轮 DA19 起弹窗不再编排链，仅任务主题/说明）。 */
  onOpenEditDialog: () => void;
}): ReactNode {
  // docs/29 DA5/DA13：可编辑窗口内成员框承整链（boxCoversChain）
  // ——站点行与框内容重合，抑制 TaskStations。
  const suppressStations = boxCoversChain(task);
  return (
    <div>
      <SubtaskCard task={task} onReorder={onReorder}>
        <div className="flex items-center justify-between gap-2">
          {/* DA42：状态 pill 挪行头最前（用户拍板「把状态放到最前面……统一使用
          主任务页面的状态样式」）；左组改 flex min-w-0 flex-wrap items-center
          + gap 承担间距（修内联基线/行高错位，与 detailHeader 信息组同构）。 */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <TaskStatusPill
              status={task.status}
              retryCount={task.retryCount}
              className="shrink-0"
            />
            <span className={cn(MUTED_CLASS, 'shrink-0')}>{subIndex + 1}.</span>
            <span className="min-w-0">{task.subject}</span>
            {task.assignee !== null && (
              <span className={cn(MUTED_CLASS, 'shrink-0')}>· {task.assignee}</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* 用户迭代 2026-09-11：小任务不再有「开始」钮——开始由主任务的
                「开始」统一发起（宿主 startGroupTask 按执行序发棒，僵尸指派
                幂等重发由宿主兜底）。无链时仍给「需要选择成员」数据提示；
                「修改」钮与下拉箭头同样随撤下拉与修改下线。 */}
            {task.status === 'ready' && task.chain.length === 0 && (
              <span className={cn(MUTED_CLASS, 'shrink-0')}>需要选择成员</span>
            )}
            {SUBTASK_DELETE_ENABLED && subMutable && (
              <DeleteButton label="删除" destructive={false} onClick={onDelete} />
            )}
          </div>
        </div>
        {/* docs/29 A.8（四轮 DA17）：成员卡槽在任务卡下方独立一行
        （拖拽指派 drop target）。DA42：卡槽常显；onOpenEdit 在本卡
        编辑态哑化由消费页传入。2026-09-13 只读档：创建中详情不渲染卡槽
        （整页只读，无拖拽指派入口；执行链仍由 TaskStations 呈现）。 */}
        {!readOnly && (
          <div className="mt-1.5">
            <TaskAssignDropBox
              task={task}
              members={members}
              busy={assignBusy === task.taskId}
              onAssign={onAssign}
              onRemoveStation={onRemoveStation}
              onOpenEdit={onOpenEditDialog}
            />
          </div>
        )}
        {!suppressStations && <TaskStations task={task} members={members} />}
      </SubtaskCard>
      {assignError !== null && assignError.taskId === task.taskId && (
        <FormErrorNote>{assignError.message}</FormErrorNote>
      )}
      {reorderError !== null && reorderError.taskId === task.taskId && (
        <FormErrorNote>{reorderError.message}</FormErrorNote>
      )}
      {startError !== null && startError.taskId === task.taskId && (
        <FormErrorNote>{startError.message}</FormErrorNote>
      )}
    </div>
  );
}
