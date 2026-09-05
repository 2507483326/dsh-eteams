/**
 * shadcn/ui Pagination（new-york 风格，手动 vendoring — docs/43）。
 *
 * 源码基线：https://ui.shadcn.com/r/styles/new-york/pagination.json
 * 本仓适配（与上游保持最小 diff，便于未来对照升级）：
 * - `cn` 改相对导入；"use client" 移除；类型自足（size 内联联合，不引
 *   Button 类型）；
 * - lucide 图标走深层 `.mjs` 导入；
 * - PaginationLink 用 Slot 承 `asChild`（上游 new-york 是 `<a>` 链接语义；
 *   本仓无路由面板——消费位 asChild 包 `<Button>`，`<a href>` 语义不适用；
 *   上游 v4 亦同改 Slot）；
 * - Previous/Next 去上游内嵌箭头图标（消费位是中文文字钮，观感与现实现
 *   一致——accordion.tsx 去内嵌 ChevronDown 同款先例）；
 * - aria-label 本地化（分页/上一页/下一页/更多页）。
 *
 * @module dsh-eteams/client/components/ui/pagination
 */
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
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

const PaginationContent = React.forwardRef<
  HTMLUListElement,
  React.ComponentPropsWithoutRef<'ul'>
>(({ className, ...props }, ref) => (
  <ul ref={ref} className={cn('flex flex-row items-center gap-1', className)} {...props} />
));
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
  const Comp: React.ElementType = asChild ? Slot : 'a';
  return (
    <Comp
      aria-current={isActive ? 'page' : undefined}
      data-active={isActive}
      className={cn(buttonVariants({ variant: 'ghost', size }), className)}
      {...props}
    />
  );
};

const PaginationPrevious = ({ className, ...props }: PaginationLinkProps) => (
  <PaginationLink aria-label="上一页" size="sm" className={className} {...props} />
);

const PaginationNext = ({ className, ...props }: PaginationLinkProps) => (
  <PaginationLink aria-label="下一页" size="sm" className={className} {...props} />
);

const PaginationEllipsis = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span
    aria-hidden={true}
    className={cn('flex h-9 w-9 items-center justify-center', className)}
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