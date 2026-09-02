/**
 * shadcn/ui Button（new-york 风格，手动 vendoring — docs/21-client-ui-stack.md D19d/D19g）。
 *
 * 源码基线：https://ui.shadcn.com/r/styles/new-york/button.json（S4 抓取快照）。
 * 本仓适配（与上游保持最小 diff，便于未来对照升级）：
 * - `cn` 改相对导入 `../../cn`（rootDir=src/client，无 paths 别名，D19d）；
 * - 类型按 verbatimModuleSyntax / strict 规整；
 * - token 色禁用 /alpha 修饰（宿主变量是完整色值，实测静默不生成 CSS，D19c）
 *   ——上游 hover 的 `bg-primary/90` 等透明度改写为 `color-mix()` 任意值
 *   （D19c 认可的半透明替代路径）；类名保持完整字面量，content 扫描可检出；
 * - 保留 @radix-ui/react-slot 的 asChild；不引 lucide（首个真实需要时再装，21.3）。
 *
 * S4 仅落库未接线：本模块暂无消费方，tsdown 按 entry 可达性排除，envelope
 * 体积增量只来自 content 扫描出的 CSS 字符串（见 lib/tailwind.gen.css）。
 *
 * @module dsh-eteams/client/components/ui/button
 */
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow hover:bg-[color:color-mix(in_srgb,var(--primary)_90%,transparent)]',
        destructive:
          'bg-destructive text-destructive-foreground shadow-sm hover:bg-[color:color-mix(in_srgb,var(--destructive)_90%,transparent)]',
        outline:
          'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground',
        secondary:
          'bg-secondary text-secondary-foreground shadow-sm hover:bg-[color:color-mix(in_srgb,var(--secondary)_80%,transparent)]',
        ghost: 'border-none hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
