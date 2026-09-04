/**
 * shadcn/ui Alert（new-york 风格，手动 vendoring — docs/21 D19d / docs/23 D21c/S23-2）。
 *
 * 源码基线：https://ui.shadcn.com/r/styles/new-york/alert.json（S23 抓取快照，
 * 与库内 button/dialog 同代基线）。
 * 本仓适配（与上游保持最小 diff）：
 * - `cn` 改相对导入 `../../cn`（D19d）；cva 与 button.tsx 同源；
 * - preflight 已关（D19b）：上游 `border` 类只产 border-width，基类显式补
 *   `border-solid`（R1-F3 同款）；
 * - 本仓扩展 `warning` 变体（上游仅 default/destructive）：docs/23 S23-3 的
 *   面板横幅（BANNER，amber 语义）需要——边框/文字走 --warning token，与
 *   destructive 变体同构，扩展已在变体表内注释标记；
 * - 类型按 verbatimModuleSyntax / strict 规整；"use client" 移除。
 *
 * @module dsh-eteams/client/components/ui/alert
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/cn';

const alertVariants = cva(
  'relative w-full rounded-lg border border-solid p-4 [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground',
  {
    variants: {
      variant: {
        default: 'bg-background text-foreground',
        destructive: 'border-destructive text-destructive [&>svg]:text-destructive',
        // 本仓扩展（S23-3）：amber 警示横幅变体，结构同 destructive。
        warning: 'border-warning text-warning [&>svg]:text-warning',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
));
Alert.displayName = 'Alert';

const AlertTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5
      ref={ref}
      className={cn('mb-1 font-medium leading-none tracking-tight', className)}
      {...props}
    />
  ),
);
AlertTitle.displayName = 'AlertTitle';

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('text-sm text-muted-foreground [&_p]:leading-relaxed', className)}
    {...props}
  />
));
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription };
