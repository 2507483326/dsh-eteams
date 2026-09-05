/**
 * shadcn/ui Tooltip（new-york 风格，手动 vendoring — docs/43）。
 *
 * 源码基线：https://ui.shadcn.com/r/styles/new-york/tooltip.json
 * 本仓适配（与上游保持最小 diff，便于未来对照升级）：
 * - `cn` 改相对导入（D19d）；"use client" 移除；类型规整；
 * - Tooltip 内置 TooltipProvider：本仓每个表面各自成 React 树（index.tsx 按
 *   槽位注册多个独立表面，无全局根可挂 Provider；Radix Root 缺 Provider 会
 *   直接抛错），内嵌让调用位自足。代价是跨提示的 skip-delay 协调不保留
 *   （原生 title= 同样无协调，观感等价）；
 * - Content 强制挂自管 portal 容器（getPortalContainer，dialog.tsx 同款）：
 *   Radix 默认 portal 到 body 会逃出 `.eteams-ui` 作用域（D19b）——浮层
 *   样式全靠 `.eteams-ui` 祖先后代选择器，逃出即裸奔。
 *
 * 预留件（docs/43 二十轮，2026-09-05）：悬浮提示按用户拍板回归原生 `title=`
 * 属性，原消费位 hint.tsx 组合件已删除——本件保留 vendor，出现样式化提示
 * 需求时直接启用（Radix 依赖已在 package.json）。
 *
 * @module dsh-eteams/client/components/ui/tooltip
 */
import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

import { cn } from '../../lib/cn';
import { getPortalContainer } from './portal';

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = ({
  delayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) => (
  <TooltipProvider delayDuration={delayDuration}>
    <TooltipPrimitive.Root {...props} />
  </TooltipProvider>
);
Tooltip.displayName = 'Tooltip';

const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal container={getPortalContainer()}>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = 'TooltipContent';

export { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent };