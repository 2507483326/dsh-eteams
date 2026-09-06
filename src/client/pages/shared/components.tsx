/**
 * 面板页内跨 tab 共享层 · 小组件（docs/44 M8 自 shared.tsx 拆分，46 清单）：
 * Pill/FormErrorNote/PageHeader 三个跨 tab 小组件——符号自 shared.tsx 原样
 * 搬出（纯移动、零行为变更）。类名常量与 tone 族拆居同目录 styles.ts
 * （pillClass/dotClass 经 import 消费）；各引用方按需改导入。
 *
 * @module dsh-eteams/client/pages/shared/components
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { Tone } from '../../features/tasks/taskDisplayStatus';
import { Alert } from '../../components/ui/alert';
import { Badge } from '../../components/ui/badge';
import { dotClass, pillClass } from './styles';

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
 * 20px bold tracking-tight + mb-4；右侧动作位（团队页放「＋ 新增团队」
 * 主按钮 → 创建弹窗）。标题字即 tab 名，不发明副标题。 */
export function PageHeader({
  label,
  children,
}: {
  label: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="mb-4 flex items-center gap-3">
      <h2 className="m-0 text-xl font-bold tracking-tight text-foreground">{label}</h2>
      {children !== undefined && <span className="flex-1" />}
      {children}
    </div>
  );
}