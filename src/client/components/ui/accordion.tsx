/**
 * shadcn/ui Accordion（new-york 风格，手动 vendoring — docs/43）。
 *
 * 源码基线：https://ui.shadcn.com/r/styles/new-york/accordion.json
 * （2026-09 抓取快照，与库内 dialog/select 同代基线；registry dependencies
 * 声明 @radix-ui/react-accordion，随件安装）。
 * 本仓适配（与上游保持最小 diff，便于未来对照升级）：
 * - `cn` 改相对导入 `../../cn`（D19d）；
 * - "use client" 移除；类型按 verbatimModuleSyntax / strict 规整；
 * - AccordionTrigger 去上游内嵌 ChevronDown：本仓触发位自带图标钮（asChild
 *   包 Button），内嵌图标会以兄弟节点挤进 Slot（asChild 要求单子元素）；
 *   开合旋转由上游保留的 `[&[aria-expanded=true]>svg]:rotate-180` 承载，
 *   消费位图标自动跟随，无需手写状态类；
 * - Header 补 `m-0`：preflight 已关（D19b），Radix Header 渲染 h3，UA 的
 *   h3 外边距会顶乱紧凑行布局（R1-F3 同款理由的 preflight 缺位补偿）。
 * - 上游展开动画类 animate-accordion-down/up 需 tailwind.config.ts 的
 *   accordion keyframes/animation（shadcn v3 手动安装的标准一步，随件补上）。
 *
 * @module dsh-eteams/client/components/ui/accordion
 */
import * as React from 'react';
import * as AccordionPrimitive from '@radix-ui/react-accordion';

import { cn } from '../../lib/cn';

const Accordion = AccordionPrimitive.Root;

const AccordionItem = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>
>(({ className, ...props }, ref) => (
  <AccordionPrimitive.Item ref={ref} className={cn('border-b', className)} {...props} />
));
AccordionItem.displayName = 'AccordionItem';

const AccordionTrigger = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Header className="flex m-0">
    <AccordionPrimitive.Trigger
      ref={ref}
      className={cn(
        'flex flex-1 items-center justify-between gap-4 py-4 text-left text-sm font-medium transition-all hover:underline [&[aria-expanded=true]>svg]:rotate-180',
        className,
      )}
      {...props}
    >
      {children}
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
));
AccordionTrigger.displayName = 'AccordionTrigger';

const AccordionContent = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Content
    ref={ref}
    className="overflow-hidden text-sm data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down"
    {...props}
  >
    <div className={cn('pb-4 pt-0', className)}>{children}</div>
  </AccordionPrimitive.Content>
));
AccordionContent.displayName = 'AccordionContent';

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };