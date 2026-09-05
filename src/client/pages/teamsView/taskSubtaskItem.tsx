/**
 * 组详情页小任务卡条目（2026-09-05 三十一轮 DA44④ 自 tasksTab 纯移动抽离）：
 * SUBTASK_CARD_CLASS + SubtaskCard（私有——唯一消费方是本文件的 SubtaskItem）
 * + SubtaskItem，承载组页 AccordionItem 整块（行头/钮簇/卡槽/TaskStations/
 * 展开区/错误行）。Accordion 根（type/value/onValueChange）、编辑态与
 * inlineEdit 哑化判据仍由 tasksTab 持有，状态经 props 传入；原注释逐字随迁
 * （纯移动、零行为变更）。
 *
 * @module dsh-eteams/client/pages/teamsView/taskSubtaskItem
 */
import type { ReactNode } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down.mjs';
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
import { AccordionContent, AccordionItem, AccordionTrigger } from '../../components/ui/accordion';
import { Button } from '../../components/ui/button';
import { TaskStations } from './taskDrawer';
import { MarkdownDoc } from './markdownDoc';
import { BORDER_L1_CLASS, FormErrorNote, LINE_CLASS, MUTED_CLASS } from './shared';
import { BlockedPill, TaskStatusPill } from './taskPills';

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
 * 目标；小任务详情页仍服务于顶层普通任务（组卡不再有入口，见组详情分支）。
 * 三十一轮 DA44⑤：isOver 高亮改 ring-inset（目标卡四边内缘高亮，免疫卡身
 * 滚动容器 overflow-x-hidden 的外缘裁剪——DA36 chip 同款先例）。 */
const SUBTASK_CARD_CLASS = `mt-1.5 rounded-[8px] border border-solid bg-background px-3 py-2.5 ${BORDER_L1_CLASS}`;

/** 小任务卡片（七轮 DA20 调序 + 十轮 DA23 把手化）：**只有左上 grip 把手
 * 可拖**（'eteams-subtask'，draft/ready 才可拖，不可编辑态把手淡化），
 * 卡身不可拖。二十五轮 DA38：整卡点击 = 进小任务详情页的口径撤除（用户
 * 拍板「小任务不需要再点击进入任务详情了」）——卡身只作为放置目标（同父
 * 兄弟卡才亮；drop 时 onReorder 以最新快照现算依赖改写补丁，非乐观更新）。
 * 拖拽中半透明、悬停 ring 高亮；执行序号徽标由调用方渲染。 */
function SubtaskCard({
  task,
  onReorder,
  children,
  editing = false,
}: {
  task: TaskView;
  onReorder: (fromTaskId: number, toTaskId: number) => void;
  children: ReactNode;
  /** DA41：就地编辑中禁拖（把手锁死，编辑器不与拖拽状态互扰）。 */
  editing?: boolean;
}): ReactNode {
  const editable = task.status === 'draft' || task.status === 'ready';
  const [{ isDragging }, dragRef] = useDrag<SubtaskDragItem, unknown, { isDragging: boolean }>(
    () => ({
      type: SUBTASK_DRAG_TYPE,
      item: { taskId: task.taskId, parentId: task.parentId, editable },
      canDrag: () => editable && !editing,
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    }),
    [task.taskId, task.parentId, editable, editing],
  );
  const [{ isOver }, dropRef] = useDrop<SubtaskDragItem, unknown, { isOver: boolean }>(
    () => ({
      accept: SUBTASK_DRAG_TYPE,
      canDrop: (item) =>
        item.editable && item.taskId !== task.taskId && item.parentId === task.parentId && editable,
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

/** 组详情页小任务卡条目（DA44④ 自 tasksTab AccordionItem 整块抽离）：状态
 * （expandedSubIds/inlineEdit/busy/error 瞬态）与提交回调留在 tasksTab，经
 * props 传入；suppressStations（boxCoversChain）与 expandable（说明/合同
 * trim 判据）随块迁入本组件现算。subjectEditor/editor 节点由调用方按 editing
 * 生成传入（行头原位 Input / 展开区 MdEditor），组件内 editing 三元二选一。 */
export function SubtaskItem({
  task,
  subIndex,
  members,
  editing,
  subMutable,
  expanded,
  startBusy,
  assignBusy,
  assignError,
  reorderError,
  startError,
  subjectEditor,
  editor,
  onReorder,
  onStart,
  onInlineEdit,
  onDelete,
  onAssign,
  onRemoveStation,
  onOpenEditDialog,
}: {
  task: TaskView;
  subIndex: number;
  members: readonly MemberView[];
  /** DA42：本卡正处小任务卡编辑（可编辑 + 本卡 + scope 对上，判据在 tasksTab）。 */
  editing: boolean;
  subMutable: boolean;
  expanded: boolean;
  startBusy: number | null;
  assignBusy: number | null;
  assignError: TaskErrorSlot | null;
  reorderError: TaskErrorSlot | null;
  startError: TaskErrorSlot | null;
  /** 行头原位编辑 Input（调用方生成；editing 时承担标题展示，DA43）。 */
  subjectEditor?: ReactNode;
  /** 展开区就地编辑器（调用方生成；editing 时与只读正文二选一，DA42/43）。 */
  editor?: ReactNode;
  onReorder: (fromTaskId: number, toTaskId: number) => void;
  onStart: (taskId: number) => void;
  onInlineEdit: () => void;
  onDelete: () => void;
  onAssign: (chain: TaskSlotInput[]) => void;
  onRemoveStation: (index: number) => void;
  /** 卡槽「修改」入口（inlineEdit 哑化判断留 tasksTab，回调传入）。 */
  onOpenEditDialog: () => void;
}): ReactNode {
  // docs/29 DA5/DA13：可编辑窗口内成员框承整链（boxCoversChain）
  // ——站点行与框内容重合，抑制 TaskStations。
  const suppressStations = boxCoversChain(task);
  // 十七轮 DA30：有说明或合同 MD 的卡才可展开，展开就地看正文。
  // DA41：说明加 trim 判据——快照空串落库后不再显示空「说明：」行。
  const expandable =
    (task.description !== null && task.description.trim() !== '') ||
    (task.contractMd !== null && task.contractMd.trim() !== '');
  return (
    <AccordionItem value={String(task.taskId)} className="border-b-0">
      <SubtaskCard task={task} editing={editing} onReorder={onReorder}>
        <div className="flex items-center justify-between gap-2">
          {/* DA42：状态 pill 挪行头最前（用户拍板「把状态放到最前面……统一使用
          主任务页面的状态样式」），BlockedPill 随簇连排；左组改 flex min-w-0
          flex-wrap items-center + gap 承担间距（修内联基线/行高错位，与
          detailHeader 信息组同构）。 */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <TaskStatusPill
              status={task.status}
              retryCount={task.retryCount}
              className="shrink-0"
            />
            {task.blocked && <BlockedPill blockedFrom={task.blockedFrom} className="shrink-0" />}
            <span className={cn(MUTED_CLASS, 'shrink-0')}>{subIndex + 1}.</span>
            {/* DA43：主题原位编辑（编辑态行头 span↔Input 切换） */}
            {editing ? subjectEditor : <span className="min-w-0">{task.subject}</span>}
            {task.assignee !== null && (
              <span className={cn(MUTED_CLASS, 'shrink-0')}>· {task.assignee}</span>
            )}
          </div>
          {/* DA42：行头右侧钮簇（开始/需要选择成员/修改/删除/箭头）
          恢复常显（DA41「编辑态整簇隐去」口径作废——编辑器迁入
          展开区，行头原布局不变）；簇内 subMutable/ready 判据全
          不动。 */}
          <div className="flex shrink-0 items-center gap-1.5">
            {/* 二十四轮 DA37：开始按钮（用户拍板「卡片加上开始
                按钮」）——ready 且有链才渲染（点击派发执行链下一
                站）；ready 无链改渲染「需要选择成员」行内提示
                （用户拍板「如果有任务没有成员，则提示需要选择
                成员就行」，不设按钮）。draft（拆解中）与已入执行
                不渲染。二十五轮 DA38：防冒泡包装层撤除（卡身点击
                进详情口径已废，包装层随之无用；点击恢复原生冒泡
                ——多选面板的外出点击关闭不再被拦断）。 */}
            {task.status === 'ready' && task.chain.length > 0 && (
              <Button
                type="button"
                size="sm"
                disabled={startBusy === task.taskId}
                onClick={() => onStart(task.taskId)}
              >
                开始
              </Button>
            )}
            {task.status === 'ready' && task.chain.length === 0 && (
              <span className={cn(MUTED_CLASS, 'shrink-0')}>需要选择成员</span>
            )}
            {subMutable && (
              <div className="flex shrink-0 gap-1.5">
                <Button type="button" variant="outline" size="sm" onClick={onInlineEdit}>
                  修改
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={onDelete}>
                  删除
                </Button>
              </div>
            )}
            {(expandable || editing) && (
              /* 十九轮 DA32：展开钮挪到按钮组**最右侧**（用户拍板
                「放到最右侧」——修改/删除之后），hover 底色压平
                （用户拍板「不要这个背景色」——ghost 变体的
                hover:bg-accent 被 hover:bg-transparent 覆盖）。
                aria-expanded 驱动上游 rotate-180，图标随开合自转；
                点击不冒泡到卡。二十八轮 DA41：剥 Button 基类渗漏
                的品牌色 focus 描边（focus-visible:ring-1 ring-ring）
                与 Trigger 渗漏的 py-4/flex-1/justify-between/
                hover:underline——flex-none/py-0/justify-center
                归位小方钮，focus-visible:ring-transparent 补杀
                ring 色组（twMerge 尾部胜出已实测）。aria-expanded
                旋转与 asChild 不变，不改 accordion.tsx。 */
              <AccordionTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  title={expanded ? '收起' : '展开'}
                  className="h-6 w-6 flex-none py-0 justify-center text-muted-foreground hover:bg-transparent hover:no-underline hover:text-foreground focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-transparent"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ChevronDown className="h-4 w-4 transition-transform" />
                </Button>
              </AccordionTrigger>
            )}
          </div>
        </div>
        {/* docs/29 A.8（四轮 DA17）：成员卡槽在任务卡下方独立一行
        （拖拽指派 drop target）。二十五轮 DA38：防冒泡包装层
        撤除（卡身点击进详情口径已废）——卡槽内点击恢复原生
        冒泡，多选面板的外出点击关闭不再被拦断。DA42：卡槽恢复
        常显（DA41「编辑态整槽隐去」口径作废）；onOpenEdit 在本卡
        编辑态哑化（防老弹窗覆盖本卡草稿，与详情页防御同构）。 */}
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
        {!suppressStations && <TaskStations task={task} />}
        {/* DA42：展开内容区 = 只读正文 / 就地编辑器二选一；节点级门
        (expandable || editing)——无内容卡仅在编辑中挂载（防「取消」
        后残留空分隔线且无箭头可收）；Radix 关闭即卸载，内部无需
        再挂 expanded 门。 */}
        {(expandable || editing) && (
          <AccordionContent className="mt-1.5 border-t border-solid pt-2">
            {editing ? (
              editor
            ) : (
              <>
                {task.description !== null && task.description.trim() !== '' && (
                  <div className={LINE_CLASS}>说明：{task.description}</div>
                )}
                {task.contractMd !== null && <MarkdownDoc text={task.contractMd} />}
              </>
            )}
          </AccordionContent>
        )}
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
    </AccordionItem>
  );
}
