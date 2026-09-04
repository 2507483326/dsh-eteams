/**
 * shadcn/ui Popover（new-york 风格，手动 vendoring — dialog.tsx 先例）。
 *
 * 用途（用户迭代 2026-09「模型选择与对话一致」）：成员/领队卡的模型二级
 * 菜单（对话 ModelSelect 同款 root→模型/推理等级 钻入式面板）。Radix
 * Popover 自带定位/翻转/外出点击/Esc 关闭——卡片栅格在滚动容器内，自绘
 * absolute 浮层会被 overflow 裁剪，必须 portal。
 *
 * 本仓适配（与上游保持最小 diff，便于未来对照升级）：
 * - `cn` 改相对导入 `../../cn`；
 * - PopoverPortal 改挂自管 portal 容器（D19b，dialog.tsx 同款）：Radix
 *   默认 portal 到 document.body 会逃出 `.eteams-ui` 作用域——统一经
 *   getPortalContainer() 挂 body 下 `.eteams-ui-portal.eteams-ui` 容器；
 * - 类型按 verbatimModuleSyntax / strict 规整；"use client" 指令移除；
 * - preflight 已关（D19b）：上游 `border` 类只产 border-width——Content
 *   基类显式补 `border-solid`（R1-F3）。
 *
 * @module dsh-eteams/client/components/ui/popover
 */
import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';

import { cn } from '../../lib/cn';
import { getPortalContainer } from './portal';

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverAnchor = PopoverPrimitive.Anchor;

/**
 * D19b：强制走自管 portal 容器（调用方传不进 container——spread 在前，
 * container 恒为 getPortalContainer()，保证浮层永不逃出 `.eteams-ui`）。
 */
const PopoverPortal = ({
  children,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Portal>) => (
  <PopoverPrimitive.Portal {...props} container={getPortalContainer()}>
    {children}
  </PopoverPrimitive.Portal>
);
PopoverPortal.displayName = PopoverPrimitive.Portal.displayName;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'center', sideOffset = 4, ...props }, ref) => (
  <PopoverPortal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'z-50 w-72 rounded-md border border-solid bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        className,
      )}
      {...props}
    />
  </PopoverPortal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent };
