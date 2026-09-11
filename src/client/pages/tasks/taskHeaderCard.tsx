/**
 * 任务详情页头部卡（2026-09-05 三十一轮 DA44④ 自 tasksTab 纯移动抽离）：
 * 原 tasksTab 内联函数 detailHeader 改具名导出组件 TaskHeaderCard，options
 * 三元改 props（undefined 判断，语义等价），主任务/任务详情页两处调用共用。
 * 原注释逐字随迁（纯移动、零行为变更）。2026-09-06 三十四轮 DA47：展开区
 * 只读正文改说明+合同并读单 MD 文档（readBodyOf，与编辑器 mergedBodyOf
 * 同源——「说明：」标签行随并读撤除）。
 *
 * @module dsh-eteams/client/pages/tasks/taskHeaderCard
 */
import type { ReactNode } from 'react';
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down.mjs';
import { cn } from '../../lib/cn';
import { Button } from '../../components/ui/button';
import type { TaskView } from '../../lib/monitor';
import { MUTED_CLASS, TASK_CARD_CLASS } from '../shared/styles';
import { MarkdownDoc } from '../shared/markdownDoc';
import { TaskStatusPill } from '../shared/components';
import { readBodyOf } from './taskBody';

/** 详情页头部卡（主任务/任务共用：#id 主题 + 展示态 pill + assignee）。
 * 二十轮 DA33：主任务详情页增 extra 槽——进度三计数/汇总 chip 收进卡内
 * （用户拍板「把团队成员放到上面去和任务标题放一起」）；成员罗列条曾随
 * extra 入卡，二十三轮 DA36 移出卡置卡下方（左竖线提示块）；任务详情页
 * 不传保持原观感。二十八轮 DA41：签名改 options 对象——actions 槽承载
 * 组详情页头部「开始」钮（自「任务列表」行上移）与任务详情页头部「编辑」
 * 钮，editor 槽承载头部卡就地编辑器（编辑时静态主题隐藏，Input 承担标题
 * 展示）；标题行原内联 ml-1 间距改 flex gap 承载。三十轮 DA43：编辑块
 * 撤标题 Input，主题展示改 subjectEditor 槽原位切换（编辑态行头 Input
 * 承担标题；不传时静态主题 span 照旧——组详情页零变化）。三十三轮
 * DA46：①撤 #id 前缀（用户拍板「把 #1 去掉」——列表卡 DA25/小任务行头
 * DA44 之后头部卡对齐，挂靠行的父任务 # 引用不动）；②编辑态信息组
 * flex-1——标题 Input 拉长自适应占满标题行剩余宽度；③增展开钮/展开区
 * （与小任务卡同款：expandable || editing 门、DA32 箭头最右 + DA41 剥
 * 焦点环/渗漏类同口径、展开区只读正文/编辑器二选一、「编辑」先展开——
 * DA42 语义同构，expandable 判据组件内自足）。 */
export function TaskHeaderCard({
  task,
  extra,
  actions,
  editor,
  subjectEditor,
  editing,
  expanded,
  onToggleExpanded,
}: {
  task: TaskView;
  extra?: ReactNode;
  actions?: ReactNode;
  editor?: ReactNode;
  subjectEditor?: ReactNode;
  /** 三十三轮 DA46：本卡正处头部卡就地编辑（判据在 taskDetailPage——编辑器
   * 入展开区，与小任务卡 DA42 同构；不传 = 未接线调用位零变化）。 */
  editing?: boolean;
  /** 三十三轮 DA46：展开态（单槽 id 由消费页持有，切换任务即视为收起；
   * 不传 = 未接线调用位零变化）。 */
  expanded?: boolean;
  /** 三十三轮 DA46：箭头开合回调（不传 = 无箭头，未接线调用位零变化）。 */
  onToggleExpanded?: () => void;
}): ReactNode {
  // 三十三轮 DA46：expandable 组件内自足（与小任务卡 SubtaskItem 判据同款
  // ——说明/合同 trim 判据，DA41 口径）；arrowShow = 接线了开合回调且
  // 有正文可看或正编辑（编辑器在展开区，与 DA42 节点级门同款——无内容且
  // 非编辑不挂箭头/不挂展开区）。
  const expandable =
    (task.description !== null && task.description.trim() !== '') ||
    (task.contractMd !== null && task.contractMd.trim() !== '');
  const arrowShow = onToggleExpanded !== undefined && (expandable || editing === true);
  // 卡面收编 shared/TASK_CARD_CLASS（M7-11：与 taskSubtaskItem
  // SUBTASK_CARD_CLASS 的逐字重复合一）。
  return (
    <div className={TASK_CARD_CLASS}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* 三十三轮 DA46：①撤 #id 前缀（用户拍板「把 #1 去掉」——列表卡
            DA25/小任务行头 DA44 之后头部卡对齐；挂靠行的父任务 # 引用不动）；
            ②编辑态信息组 flex-1——标题 Input 拉长自适应占满标题行剩余宽度
            （非编辑态零变化）。 */}
        <div
          className={cn(
            'flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5',
            subjectEditor !== undefined && 'flex-1',
          )}
        >
          {subjectEditor !== undefined ? (
            subjectEditor
          ) : (
            <span className="min-w-0">{task.subject}</span>
          )}
          <TaskStatusPill status={task.status} retryCount={task.retryCount} />
          {task.assignee !== null && <span className={MUTED_CLASS}>· {task.assignee}</span>}
        </div>
        {(actions !== undefined || arrowShow) && (
          <div className="flex shrink-0 items-center gap-1.5">
            {actions}
            {/* 三十三轮 DA46：展开钮挪簇内最右（与小任务卡同款：DA32 挪最右
            + DA41 剥 Button 基类渗漏的焦点环/Trigger 渗漏的 py/flex/下划线
            同口径；头部卡无卡身点击，无需 stopPropagation；图标随开合自
            转）。 */}
            {arrowShow && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title={expanded ? '收起' : '展开'}
                aria-expanded={expanded}
                className="h-6 w-6 flex-none py-0 justify-center text-muted-foreground hover:bg-transparent hover:no-underline hover:text-foreground focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-transparent"
                onClick={onToggleExpanded}
              >
                <ChevronDown
                  className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')}
                />
              </Button>
            )}
          </div>
        )}
      </div>
      {task.folder !== null && (
        <div className={cn(MUTED_CLASS, 'mt-1.5')}>文件夹：{task.folder}/</div>
      )}
      {extra}
      {/* 三十三轮 DA46：展开区 = 只读正文（说明 + 合同 MD）/ 就地编辑器二
      选一（与小任务卡 DA42 同款）；节点级门 arrowShow && expanded——原
      editor 无条件槽位随编辑器迁入展开区撤除（编辑器改 editing && expanded
      时渲染）。DA47：只读正文改说明+合同并读单 MD 文档（readBodyOf，与
      编辑器 mergedBodyOf 同源；说明段独换行升格硬断行——「说明：」标签行
      随并读撤除）。 */}
      {arrowShow && expanded && (
        <div className="mt-1.5 border-t border-solid pt-2">
          {editing === true && editor !== undefined ? (
            editor
          ) : (
            <MarkdownDoc text={readBodyOf(task)} />
          )}
        </div>
      )}
    </div>
  );
}
