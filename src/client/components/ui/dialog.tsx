/**
 * shadcn/ui Dialog（new-york 风格，手动 vendoring — docs/21-client-ui-stack.md D19d/D19g/S13）。
 *
 * 源码基线：https://ui.shadcn.com/r/styles/new-york/dialog.json（S13 抓取快照）。
 * 本仓适配（与上游保持最小 diff，便于未来对照升级）：
 * - `cn` 改相对导入 `../../cn`（D19d）；
 * - lucide 的 X 关闭图标改深层导入 `lucide-react/dist/esm/icons/x.mjs`：
 *   主入口的 icons 命名空间再导出（`export { index as icons }`）使 rolldown
 *   无法 tree-shake 未用图标（实测全量 ~1500 个图标 ≈ +850KB 进包），深层
 *   导入只进 X 一个图标——对齐 21.3「仅 X 图标增量极小」口径；类型垫片见
 *   lucide-icon.d.ts（上游无逐图标 .d.mts）；
 * - DialogPortal 改挂自管 portal 容器（D19b）：Radix 默认 portal 到
 *   document.body，会逃出 `.eteams-ui` 作用域（工具类是 `.eteams-ui .xxx`
 *   后代选择器）——统一经 getPortalContainer() 挂到 body 下的
 *   `<div class="eteams-ui-portal eteams-ui">`（components/ui/portal.ts），
 *   容器即作用域根，浮层样式/主题 token 在宿主页内照常生效；
 * - 类型按 verbatimModuleSyntax / strict 规整；"use client" 指令移除
 *   （非 Next.js 环境）。
 *
 * 动画类（data-[state=open]:animate-in 等）依赖 tailwindcss-animate 插件
 * （tailwind.config.ts 已挂）；bg-black/80 / z-50 等为 Tailwind 默认色阶
 * （非宿主变量 token，D19c 的 /alpha 禁令仅约束 token 色）。
 *
 * @module dsh-eteams/client/components/ui/dialog
 */
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
// 深层图标导入（见 lucide-icon.d.ts 头注）：主入口的 icons 命名空间再导出
// 会让 rolldown 把全量图标拖进 envelope，深层路径只进 X 一个图标。带 .mjs
// 扩展名——上游无 exports 字段，oxc-resolver 不会为无扩展名 id 试 .mjs。
import X from 'lucide-react/dist/esm/icons/x.mjs';

import { cn } from '../../cn';
import { getPortalContainer } from './portal';

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

/**
 * D19b：强制走自管 portal 容器（调用方传不进 container——spread 在前，
 * container 恒为 getPortalContainer()，保证浮层永不逃出 `.eteams-ui`）。
 */
const DialogPortal = ({
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) => (
  <DialogPrimitive.Portal {...props} container={getPortalContainer()}>
    {children}
  </DialogPrimitive.Portal>
);
DialogPortal.displayName = DialogPrimitive.Portal.displayName;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg',
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)} {...props} />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-none tracking-tight', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
