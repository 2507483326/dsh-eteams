/**
 * shadcn/ui Badge（new-york 风格，手动 vendoring — docs/21-client-ui-stack.md D19d/D19g）。
 *
 * 源码基线：https://ui.shadcn.com/r/styles/new-york/badge.json（S4 抓取快照）。
 * 本仓适配（与上游保持最小 diff，便于未来对照升级）：
 * - `cn` 改相对导入 `../../cn`（D19d）；
 * - 类型按 verbatimModuleSyntax / strict 规整（`import type * as React`：
 *   本文件只用类型；registry 的 `interface … extends … {}` 空接口改 type
 *   交叉别名，语义等价且不触 no-empty-interface）；
 * - token 色禁用 /alpha 修饰（D19c）——上游 hover 的 `bg-primary/80` 等
 *   透明度改写为 `color-mix()` 任意值，类名保持完整字面量；
 * - 追加 success / warning / business 三个变体：附录 A 扩展 token 服务既有
 *   Tone 徽标语义（「badge 变体直接消费」），纯色底 + on-saturated 前景
 *   token（与 default 变体同款模式，状态色不随亮暗换文字色）。
 *
 * S4 仅落库未接线：体积影响同 button.tsx 头注。
 *
 * @module dsh-eteams/client/components/ui/badge
 */
import type * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../cn';

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-primary text-primary-foreground shadow hover:bg-[color:color-mix(in_srgb,var(--primary)_80%,transparent)]',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground hover:bg-[color:color-mix(in_srgb,var(--secondary)_80%,transparent)]',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground shadow hover:bg-[color:color-mix(in_srgb,var(--destructive)_80%,transparent)]',
        outline: 'text-foreground',
        success: 'border-transparent bg-success text-primary-foreground',
        warning: 'border-transparent bg-warning text-primary-foreground',
        business: 'border-transparent bg-business text-primary-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export type BadgeProps = React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
