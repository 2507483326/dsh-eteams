/**
 * 删除钮（docs/44 M7-4，46 清单）：六处 outline sm 删除钮原是逐字重复——
 * 成员卡两处「移出团队」、团队页「删除」、任务卡「删除」都是
 * text-destructive 前景，角色列表「删除」另有悬停红描边/底色（className
 * 透传），任务子项「删除」**不带** destructive 前景（原位漂移，46 清单明示
 * 保留原样不并口径）——收口到这里，漂移以 destructive={false} 表达。
 *
 * @module dsh-eteams/client/deleteButton
 */
import type { MouseEventHandler } from 'react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Button } from './ui/button';

/** destructive 档前景（原四处逐字值；角色列表的悬停描边/底色差异由
 * className 透传叠加，不在此复刻）。 */
const DESTRUCTIVE_CLASS = 'text-destructive hover:text-destructive';

/** ================================== 主组件 ================================== */

/**
 * 删除钮：固定 outline sm + type="button"；destructive 默认 true（吃红字
 * 档），任务子项传 false 还原无红字原位；onClick 透传 MouseEvent（角色列表
 * 要 stopPropagation）；className 透传（角色列表悬停三连）。
 */
export function DeleteButton({
  label,
  onClick,
  destructive = true,
  disabled = false,
  className,
}: {
  label: ReactNode;
  onClick: MouseEventHandler<HTMLButtonElement>;
  destructive?: boolean;
  disabled?: boolean;
  className?: string;
}): ReactNode {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      className={cn(destructive ? DESTRUCTIVE_CLASS : null, className)}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}
