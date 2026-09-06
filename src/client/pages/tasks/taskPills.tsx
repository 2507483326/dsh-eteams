/**
 * 任务展示态徽标族（2026-09-05 三十一轮 DA44⑥ 自 tasksTab 纯移动抽离）：
 * 展示态 pill（DisplayStatusPill，私有）、阻塞徽标 BlockedPill、组卡汇总 chip
 * GroupSummaryChip，原注释逐字随迁（纯移动、零行为变更）；并新增 TaskStatusPill
 * 统一封装——三处状态 pill（主任务卡底栏/小任务行头/详情页头部）共用
 * DisplayStatusPill + STATUS_PILL_CLASS（DA28 底栏描边口径），调用位不再各自
 * 传 pillClassName。
 *
 * @module dsh-eteams/client/pages/tasks/taskPills
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { displayStatusOf, type GroupSummary } from '../../features/tasks/taskDisplayStatus';
import { Pill } from '../shared/components';
import { MUTED_CLASS, STATUS_PILL_CLASS } from '../shared/styles';

/** 展示态徽标（docs/29 B.3 渲染位）：中性 pill（Badge secondary + 6px dot，
 * tone 按展示态逐格对表——29-M3 同桶异色）+ 重试计数 detail 小字。八轮 DA21
 * 页面化后列表行/组卡/详情页头部统一走展示态（原 TaskDrawer Dialog 的任务态
 * 精确文案随页面化撤除）。十四轮 DA27：新增 pillClassName 直通内层 Pill——
 * 任务列表卡底栏的状态 pill 用 rounded-[2px]（用户拍板「圆角改成 2px」），
 * pill 挪到卡底栏左侧（「状态挪到卡片的左边下面」——十二轮「下面放删除
 * 按钮」同词汇，「下面」= 卡底栏）；十五轮 DA28 底栏位再叠 border-[--border]
 * 描边 + 同色 hover 压平 Badge 淡底（用户「去掉放上去变淡，加上边框」）；
 * 其余调用位不传保持原观感。 */
function DisplayStatusPill({
  status,
  retryCount = 0,
  className,
  pillClassName,
}: {
  status: string;
  retryCount?: number;
  className?: string;
  /** 直通内层 Pill 的类（tailwind-merge 压过基础圆角）。 */
  pillClassName?: string;
}): ReactNode {
  const d = displayStatusOf(status, retryCount);
  return (
    <span className={cn('inline-flex items-baseline gap-1.5 whitespace-nowrap', className)}>
      <Pill tone={d.tone} className={pillClassName}>
        {d.label}
      </Pill>
      {d.detail !== '' && <span className={MUTED_CLASS}>{d.detail}</span>}
    </span>
  );
}

/** DA44⑥：三处统一状态 pill——DisplayStatusPill + STATUS_PILL_CLASS 封装
 * （DA28/DA42 口径），调用位不再各自传 pillClassName。 */
export function TaskStatusPill({
  status,
  retryCount = 0,
  className,
}: {
  status: string;
  retryCount?: number;
  className?: string;
}): ReactNode {
  return (
    <DisplayStatusPill
      status={status}
      retryCount={retryCount}
      className={className}
      pillClassName={STATUS_PILL_CLASS}
    />
  );
}

/** 阻塞徽标（docs/36 建议 1）：wait + blockedFrom 非空的物化阻塞行内标记。
 * 十三轮 DA26：ml-1 不再内建——行内文字流场景（详情页）由调用位补 ml-1，
 * 列表卡独立行场景顶格与其它行对齐。 */
export function BlockedPill({
  blockedFrom,
  className,
}: {
  blockedFrom: number | null;
  className?: string;
}): ReactNode {
  return (
    <span className={cn('inline-flex items-baseline whitespace-nowrap', className)}>
      <Pill tone="warn">阻塞中{blockedFrom !== null ? ` · 前置 #${blockedFrom}` : ''}</Pill>
    </span>
  );
}

/** 组卡汇总 chip（B.2 规则 2）：异常 chip 带前缀 ✕（「✕ n 项异常」，err 红
 * ——与行内 awaiting/needs_user pill 的 warning 黄同桶异色）+ 首个异常
 * detail 小字；执行中/等待执行/待指派按优先级降档。 */
export function GroupSummaryChip({ summary }: { summary: GroupSummary }): ReactNode {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <Pill tone={summary.tone}>
        {summary.icon !== '' ? `${summary.icon} ${summary.label}` : summary.label}
      </Pill>
      {summary.detail !== '' && <span className={MUTED_CLASS}>{summary.detail}</span>}
    </span>
  );
}
