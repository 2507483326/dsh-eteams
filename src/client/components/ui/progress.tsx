/**
 * shadcn/ui Progress（new-york 风格，手动 vendoring — docs/21 D19d / docs/23 D21c/S23-2）。
 *
 * 源码基线：https://ui.shadcn.com/r/styles/new-york/progress.json（S23 抓取快照，
 * 与库内 button/dialog 同代基线）。
 * 本仓适配（与上游保持最小 diff）：
 * - `cn` 改相对导入 `../../cn`（D19d）；
 * - 无 lucide / 无 Radix Portal（原位渲染，天然在 `.eteams-ui` 作用域内）；
 * - 类型按 verbatimModuleSyntax / strict 规整；"use client" 移除。
 * - 上游 Indicator 用 `translateX(-${100 - value}%)` transform 技法（脱离文档
 *   流不触发 layout，且不与 width 百分比语义打架）——原样保留。
 *
 * @module dsh-eteams/client/components/ui/progress
 */
import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';

import { cn } from '../../lib/cn';

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn('relative h-4 w-full overflow-hidden rounded-full bg-secondary', className)}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className="h-full w-full flex-1 bg-primary transition-all"
      style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
