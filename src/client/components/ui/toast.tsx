/**
 * shadcn/ui Toast（new-york 风格，手动 vendoring — docs/43）。
 *
 * 源码基线：https://ui.shadcn.com/r/styles/new-york/toast.json
 * 本仓适配（与上游保持最小 diff，便于未来对照升级）：
 * - `cn` 改相对导入；"use client" 移除；类型规整；
 * - X 图标走深层 `.mjs` 导入（lucide 主入口会拖全量图标进包）；
 * - `border` 补 `border-solid`（preflight 关闭，border-width 缺线型）；
 * - `text-foreground/50` 改 color-mix 任意值（token 色禁 `/alpha`，值静默
 *   失效——button.tsx 先例）；
 * - Viewport 就地渲染（Radix Toast 无 portal）：**Toaster 必须挂在
 *   `.eteams-ui` 子树内**（挂载位 = 团队面板根，teamsView/index.tsx）；
 *   useToast store 是模块级单例，其它表面以后要发 toast 需自挂 Toaster。
 *
 * 消费：hooks/useToast.ts（toast()/useToast 全局单例 store）+ ui/toaster.tsx。
 *
 * @module dsh-eteams/client/components/ui/toast
 */
import * as React from 'react';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { cva, type VariantProps } from 'class-variance-authority';
import X from 'lucide-react/dist/esm/icons/x.mjs';

import { cn } from '../../lib/cn';
import { buttonVariants } from './button';

const toastVariants = cva(
  'data-[state=open]:animate-in data-[state=closed]:animate-out data-[swipe=end]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-right-full data-[state=open]:slide-in-from-top-full data-[state=open]:sm:slide-in-from-bottom-full mt-4 group pointer-events-auto relative flex w-full items-center justify-between space-x-2 overflow-hidden rounded-md border border-solid p-4 pr-6 shadow-lg transition-all',
  {
    variants: {
      variant: {
        default: 'border bg-background',
        destructive: 'group border-destructive bg-destructive text-destructive-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Root> & VariantProps<typeof toastVariants>
>(({ className, variant, ...props }, ref) => (
  <ToastPrimitive.Root ref={ref} className={cn(toastVariants({ variant }), className)} {...props} />
));
Toast.displayName = 'Toast';

const ToastAction = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Action>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Action> & VariantProps<typeof toastVariants>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Action
    ref={ref}
    asChild
    className={cn(buttonVariants(), className)}
    {...props}
  />
));
ToastAction.displayName = 'ToastAction';

const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Close
    ref={ref}
    className={cn(
      'absolute right-1 top-1 rounded-md p-1 text-[color:color-mix(in_srgb,var(--foreground)_50%,transparent)] opacity-0 transition-opacity hover:text-foreground focus:opacity-100 focus:outline-none group-hover:opacity-100',
      className,
    )}
    {...props}
  >
    <X className="h-4 w-4" />
    <span className="sr-only">关闭</span>
  </ToastPrimitive.Close>
));
ToastClose.displayName = 'ToastClose';

const ToastTitle = ToastPrimitive.Title;
const ToastDescription = ToastPrimitive.Description;

const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Viewport
    ref={ref}
    className={cn(
      'fixed top-0 z-[100] flex max-h-screen w-full flex-col-reverse p-4 sm:bottom-0 sm:right-0 sm:top-auto sm:flex-col md:max-w-[420px]',
      className,
    )}
    {...props}
  />
));
ToastViewport.displayName = 'ToastViewport';

const ToastProvider = ToastPrimitive.Provider;

export type ToastProps = React.ComponentPropsWithoutRef<typeof Toast>;
export type ToastActionElement = React.ReactElement<typeof ToastAction>;

export {
  Toast,
  ToastAction,
  toastVariants,
  ToastClose,
  ToastTitle,
  ToastDescription,
  ToastViewport,
  ToastProvider,
};