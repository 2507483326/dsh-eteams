/**
 * Separator（分割线）——D19g 零 Radix 基础件。
 *
 * shadcn 上游（https://ui.shadcn.com/r/styles/new-york/separator.json）基于
 * @radix-ui/react-separator；按 docs/21-client-ui-stack.md D19g（S4 只落
 * 零 Radix 基础件），这里自写 div 等价实现：role="separator" +
 * aria-orientation，视觉契约与上游一致（bg-border 细线，orientation 定向）。
 *
 * 适配同族约定：`cn` 相对导入 `../../cn`；类型按 verbatimModuleSyntax / strict
 * 规整。上游源码不含 /alpha 修饰，无需 color-mix 改写。
 *
 * S4 仅落库未接线：体积影响同 button.tsx 头注。
 *
 * @module dsh-eteams/client/components/ui/separator
 */
import * as React from 'react';

import { cn } from '../../lib/cn';

type SeparatorOrientation = 'horizontal' | 'vertical';

export interface SeparatorProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: SeparatorOrientation;
}

const Separator = React.forwardRef<HTMLDivElement, SeparatorProps>(
  ({ className, orientation = 'horizontal', ...props }, ref) => (
    <div
      ref={ref}
      role="separator"
      aria-orientation={orientation}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-[1px] w-full' : 'h-full w-[1px]',
        className,
      )}
      {...props}
    />
  ),
);
Separator.displayName = 'Separator';

export { Separator };
