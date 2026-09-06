/**
 * shadcn/ui Pagination（new-york 骨架，手动 vendoring — docs/43）。
 *
 * 源码基线：https://ui.shadcn.com/r/styles/new-york/pagination.json；
 * 观感对齐 = 官方 base/pagination 文档页（2026-09 用户拍板「分页照官方样式
 * 还原」）：页码钮激活 = **outline** 档（原 ghost 自绘 pill 撤销）、Previous/
 * Next 默认档内嵌 ChevronLeft/Right 箭头 + 文字（原「去箭头文字钮」适配撤销）。
 * 对齐源：shadcn-ui/ui `apps/v4/registry/new-york-v4/ui/pagination.tsx`（与
 * bases/base 版观感同构——base 源把该样式挂 cn-* 主题钩子）。
 *
 * 本仓适配（与上游保持最小 diff，便于未来对照升级）：
 * - `cn` 改相对导入；"use client" 移除；类型自足（size 内联联合，不引
 *   Button 类型）；
 * - lucide 图标走深层 `.mjs` 导入（lucide-icon.d.ts 已有声明）；
 * - PaginationLink 用 Slot 承 `asChild`（上游 new-york 是 `<a>` 链接语义；
 *   本仓无路由面板——消费位 asChild 包 `<Button>`，`<a href>` 语义不适用；
 *   非 asChild 仍渲染 `<a>`（上游语义保留）。Previous/Next 内嵌箭头/文字在
 *   asChild 下经 `Slottable` 落位进消费位 Button（消费位只传 variant/size/
 *   disabled/onClick）；asChild 时 Button 的 variant/size 需与 isActive
 *   口径一致——buttonVariants 注入层与 Button 自身层同串重叠，由
 *   tailwind-merge 去重）；
 * - 文案/aria 本地化（分页/上一页/下一页/更多页），Previous/Next 文案内联
 *   中文 span（上游 `hidden sm:block` 原样保留——宿主桌面视口恒宽，文案常显，
 *   面板/整页两表面观感一致）。
 *
 * @module dsh-eteams/client/components/ui/pagination
 */
import * as React from 'react';
import { Slot, Slottable } from '@radix-ui/react-slot';
import ChevronLeft from 'lucide-react/dist/esm/icons/chevron-left.mjs';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right.mjs';
import MoreHorizontal from 'lucide-react/dist/esm/icons/more-horizontal.mjs';

import { cn } from '../../lib/cn';
import { buttonVariants } from './button';

const Pagination = ({ className, ...props }: React.ComponentProps<'nav'>) => (
  <nav
    role="navigation"
    aria-label="分页"
    className={cn('mx-auto flex w-full justify-center', className)}
    {...props}
  />
);
Pagination.displayName = 'Pagination';

const PaginationContent = React.forwardRef<HTMLUListElement, React.ComponentPropsWithoutRef<'ul'>>(
  ({ className, ...props }, ref) => (
    // list-none/m-0/p-0：本仓 mini-preflight 刻意不复位 ul（eteams.css D22c
    // —markdown 列表标记依赖 UA 默认），自有 <ul> 表面按约用工具类显式表达，
    // 否则分页条带 disc 标记 + 40px 缩进（预览实测）。
    <ul
      ref={ref}
      className={cn('m-0 flex flex-row items-center gap-1 list-none p-0', className)}
      {...props}
    />
  ),
);
PaginationContent.displayName = 'PaginationContent';

const PaginationItem = React.forwardRef<HTMLLIElement, React.ComponentPropsWithoutRef<'li'>>(
  ({ className, ...props }, ref) => <li ref={ref} className={cn('', className)} {...props} />,
);
PaginationItem.displayName = 'PaginationItem';

type PaginationLinkProps = React.ComponentPropsWithoutRef<'a'> & {
  asChild?: boolean;
  isActive?: boolean;
  size?: 'default' | 'sm' | 'icon';
};

const PaginationLink = ({
  className,
  asChild = false,
  isActive,
  size = 'icon',
  ...props
}: PaginationLinkProps) => {
  // asChild 走 Slot（button.tsx Comp 同款模式）：消费位包 <Button>——无路由
  // 面板，上游 <a href> 链接语义不适用；非 asChild 仍渲染 <a>（上游语义保留）。
  // 激活档 outline / 非激活 ghost（官方 base/pagination 口径，2026-09 还原）。
  const Comp: React.ElementType = asChild ? Slot : 'a';
  return (
    <Comp
      aria-current={isActive ? 'page' : undefined}
      data-active={isActive}
      className={cn(buttonVariants({ variant: isActive ? 'outline' : 'ghost', size }), className)}
      {...props}
    />
  );
};

const PaginationPrevious = ({ className, children, ...props }: PaginationLinkProps) => (
  <PaginationLink
    aria-label="上一页"
    size="default"
    className={cn('gap-1 px-2.5 sm:pl-2.5', className)}
    {...props}
  >
    <ChevronLeft className="h-4 w-4" />
    {/* asChild 时消费位 <Button>（空 props 位）经 Slottable 落位——箭头/文字
    作为常驻兄弟注入 Button 子级（消费位只管 variant/size/disabled/onClick）；
    非 asChild 走 <a>（不经 Slot，Slottable 透传为空），纯上游观感。 */}
    <Slottable>{children}</Slottable>
    <span className="hidden sm:block">上一页</span>
  </PaginationLink>
);

const PaginationNext = ({ className, children, ...props }: PaginationLinkProps) => (
  <PaginationLink
    aria-label="下一页"
    size="default"
    className={cn('gap-1 px-2.5 sm:pr-2.5', className)}
    {...props}
  >
    <span className="hidden sm:block">下一页</span>
    <Slottable>{children}</Slottable>
    <ChevronRight className="h-4 w-4" />
  </PaginationLink>
);

const PaginationEllipsis = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span
    aria-hidden={true}
    className={cn('flex size-9 items-center justify-center', className)}
    {...props}
  >
    <MoreHorizontal className="h-4 w-4" />
    <span className="sr-only">更多页</span>
  </span>
);

export {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationPrevious,
  PaginationNext,
  PaginationEllipsis,
};
