/**
 * shadcn/ui Skeleton（new-york 风格，手动 vendoring — docs/21-client-ui-stack.md D19d/D19g）。
 *
 * 源码基线：https://ui.shadcn.com/r/styles/new-york/skeleton.json（S4 抓取快照）。
 * 本仓适配（与上游保持最小 diff，便于未来对照升级）：
 * - `cn` 改相对导入 `../../cn`（D19d）；
 * - 类型按 verbatimModuleSyntax / strict 规整（`import type * as React`：
 *   本文件只用类型，registry 原文甚至不导入 React、靠 UMD 全局解析）；
 * - token 色禁用 /alpha 修饰（D19c）——上游 `bg-primary/10` 改写为
 *   `color-mix()` 任意值，类名保持完整字面量。
 *
 * S4 仅落库未接线：体积影响同 button.tsx 头注。
 *
 * @module dsh-eteams/client/components/ui/skeleton
 */
import type * as React from 'react';

import { cn } from '../../lib/cn';

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-md bg-[color:color-mix(in_srgb,var(--primary)_10%,transparent)]',
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
