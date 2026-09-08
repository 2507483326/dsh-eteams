/**
 * 面板页内跨 tab 共享层 · 小组件（docs/44 M8 自 shared.tsx 拆分，46 清单）：
 * Pill/FormErrorNote/PageHeader 三个跨 tab 小组件——符号自 shared.tsx 原样
 * 搬出（纯移动、零行为变更）。类名常量与 tone 族拆居同目录 styles.ts
 * （pillClass/dotClass 经 import 消费）；各引用方按需改导入。
 * docs/47 DB10：任务展示态 pill 族（DisplayStatusPill/TaskStatusPill/
 * BlockedPill/GroupSummaryChip）自 pages/tasks/taskPills 纯移动入本文件——
 * 看板「任务动态」分区成为第二个消费域，跨域复用落点规则归 shared/
 * （44.2.3），tasks 域四个消费位改导入、零行为变更（原注释逐字随迁）。
 *
 * @module dsh-eteams/client/pages/shared/components
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import {
  displayStatusOf,
  type GroupSummary,
  type Tone,
} from '../../features/tasks/taskDisplayStatus';
import { BackButton } from '../../components/backButton';
import { Alert } from '../../components/ui/alert';
import { Badge } from '../../components/ui/badge';
import { dotClass, MUTED_CLASS, pillClass, STATUS_PILL_CLASS } from './styles';

/** ================================== 主组件 ================================== */

/** 状态徽标（docs/23 S23-3）：shadcn Badge 承底座（边框/过渡/焦点环），
 * 本仓 pill 视觉口径（官网圆 pill / 12px / medium / 内嵌状态点）以
 * className 覆盖层保留——tone 底色表（PILL_TONE_CLASS）经 tailwind-merge
 * 压过 Badge 变体底色。D22e：dot 由组件统一内嵌（中性 pill + 彩点签名），
 * 调用位不再自插 dot span。十四轮 DA27：className 透传（tailwind-merge
 * 压过基础圆角/底色）——任务列表卡底栏的状态 pill 以 rounded-[2px] 覆盖
 * 圆角（用户拍板「圆角改成 2px」），其余调用位不传保持原观感。 */
export function Pill({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <Badge variant="secondary" className={cn(pillClass(tone), className)}>
      <span className={dotClass(tone)} />
      {children}
    </Badge>
  );
}

/** 表单/列表错误提示（docs/23 S23-3）：shadcn Alert destructive 的紧凑档
 * （原 styles.formError 的 12px/20 + 上 4 下 8 边距口径）。 */
export function FormErrorNote({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <Alert
      variant="destructive"
      className={cn('mt-1 mb-2 rounded-md px-3 py-2 text-xs leading-5', className)}
    >
      {children}
    </Alert>
  );
}

/** 页签标题（S24-2 新增，官网 h2 签名）：五 tab 内容区顶部的页头行——
 * 20px bold tracking-tight + mb-4；页头行最右端返回钮（用户迭代 2026-09-08：
 * 页面返回统一收口 components/backButton 图标钮——原 BackBar 文案钮各页
 * 漂移撤除，详情/新增页经 onBack 传入、压轴渲染 + 内建 ml-auto 贴行最右，
 * 列表页不传不渲染）；右侧动作位（团队页放「＋ 新增团队」主按钮 → 创建
 * 弹窗）。标题字即 tab 名，不发明副标题。 */
export function PageHeader({
  label,
  onBack,
  children,
}: {
  label: string;
  /** 页头行最右端返回钮（components/backButton 唯一样式）：详情/新增页传
   * 导航回调，列表页省略。 */
  onBack?: () => void;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="mb-4 flex items-center gap-3">
      <h2 className="m-0 text-xl font-bold tracking-tight text-foreground">{label}</h2>
      {children !== undefined && <span className="flex-1" />}
      {children}
      {/* 返回钮压轴 + BackButton 内建 ml-auto：无动作位的页也贴行最右。 */}
      {onBack !== undefined && <BackButton onClick={onBack} />}
    </div>
  );
}
/** ================================== 任务展示态 pill 族（docs/47 DB10 自 pages/tasks/taskPills 纯移动入本文件，跨域复用归 shared/——44.2.3 落点规则；tasks 域四个消费位改导入、零行为变更，原注释逐字随迁） ================================== */

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
