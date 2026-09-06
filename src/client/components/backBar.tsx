/**
 * 返回条（docs/44 M7-3，46 清单）：六处返回钮原是逐字重复的
 * 「ArrowLeft + 文案」按钮——角色添加页（secondary）、角色详情页（outline）、
 * 成员详情页两处（outline，未找到页多 mt-2）、团队详情页（outline）、
 * 面板浮层（ghost + text-sm 拉正字号）、任务详情页（裸 button 文字钮，
 * 图标大一档 h-4 w-4）——收口到这里。观感零变更：变体经 variant 档位，
 * 文字钮档不落 Button 组件（原位就是原生 button + muted 前景色）。
 *
 * @module dsh-eteams/client/backBar
 */
import type { ReactNode } from 'react';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left.mjs';
import { Button } from './ui/button';

/** 文字钮档（任务详情页原位样式，逐字迁入）：裸 button、muted 前景、
 * 悬停提亮、大一号图标随行。 */
const TEXT_BUTTON_CLASS =
  'mb-2.5 inline-flex cursor-pointer items-center gap-1 text-sm leading-6 text-muted-foreground hover:text-foreground';

/** ================================== 主组件 ================================== */

/**
 * 返回条：variant 档位 outline（默认）/ secondary / ghost 走 sm Button
 * （图标固定 h-3.5 w-3.5），'text' 档走裸 button（图标 h-4 w-4）；className
 * 透传（未找到页 mt-2、面板 text-sm 等原位差异）。
 */
export function BackBar({
  variant = 'outline',
  label,
  onClick,
  className,
}: {
  variant?: 'outline' | 'secondary' | 'ghost' | 'text';
  label: string;
  onClick: () => void;
  className?: string;
}): ReactNode {
  if (variant === 'text') {
    return (
      <button type="button" className={TEXT_BUTTON_CLASS} onClick={onClick}>
        <ArrowLeft className="h-4 w-4" />
        {label}
      </button>
    );
  }
  return (
    <Button type="button" variant={variant} size="sm" className={className} onClick={onClick}>
      <ArrowLeft className="h-3.5 w-3.5" />
      {label}
    </Button>
  );
}
