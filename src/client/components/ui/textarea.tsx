/**
 * shadcn/ui Textarea（new-york 风格，手动 vendoring — docs/21-client-ui-stack.md D19d/D19g）。
 *
 * 源码基线：https://ui.shadcn.com/r/styles/new-york/textarea.json（S4 抓取快照）。
 * 本仓适配（与上游保持最小 diff，便于未来对照升级）：
 * - `cn` 改相对导入 `../../cn`（D19d）；
 * - 类型按 verbatimModuleSyntax / strict 规整。
 * 上游源码不含 /alpha 修饰（bg-transparent 与 token 无关），无需 color-mix 改写。
 * - preflight 已关（D19b）：上游 `border border-input` 需配 `border-solid`
 *   才渲染边框（R1-F3，UA 默认 border-style:none）。
 *
 * S4 仅落库未接线：体积影响同 button.tsx 头注。
 *
 * @module dsh-eteams/client/components/ui/textarea
 */
import * as React from 'react';

import { cn } from '../../cn';

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          'flex min-h-[60px] w-full rounded-md border border-solid border-input bg-transparent px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';

export { Textarea };
