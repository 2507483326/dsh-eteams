/**
 * 列表分页条（2026-09-06 用户迭代「分页照官方 base/pagination 样式还原、
 * 各列表页统一」）：shadcn ui/pagination 骨架上的唯一组装位——上一页/下一页
 * （内嵌箭头 + 文字）+ 页码窗口（首尾页恒在 + 当前页 ±1，跨档省略号），页
 * 码钮激活 = outline 档。各列表页分页一律走本组件，不再各自拼
 * PaginationContent/Item（角色列表页为首位消费方）。
 *
 * 交互口径：page/totalPages 0 基；onChange 收目标页；totalPages ≤ 1 不渲染
 * （单页无翻页可言，调用方免自守卫）。尺寸取 sm 档（与卡面按钮同档，窄面
 * 板收得住）；PaginationLink asChild 模式下 Button 的 variant/size 需与
 * isActive 口径一致——见 ui/pagination.tsx 注记。
 *
 * @module dsh-eteams/client/components/listPagination
 */
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Button } from './ui/button';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from './ui/pagination';

/** ================================== 窗口函数 ================================== */

/**
 * 页码窗口（0 基）：总页数 ≤ 7 全列；否则首尾页恒在 + 当前页 ±1 三页窗，
 * 窗口贴边时向内收缩，跨档出省略号。恒 ≤ 7 项（官方 demo 同构）。
 */
const pageItemsOf = (page: number, totalPages: number): Array<number | 'ellipsis'> => {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i);
  const end = Math.min(totalPages - 2, Math.max(3, page + 1));
  const start = Math.max(1, Math.min(page - 1, end - 2));
  return [0, 'ellipsis', start, start + 1, start + 2, 'ellipsis', totalPages - 1];
};

/** ================================== 主组件 ================================== */

/** 列表分页条：上一页/下一页（内嵌箭头 + 文字）+ 页码窗口（outline 激活档）。 */
export function ListPagination({
  page,
  totalPages,
  onChange,
  className,
}: {
  /** 当前页（0 基；越界页由调用方收敛，组件按原值渲染窗口）。 */
  page: number;
  /** 总页数（≥1）；≤ 1 整条不渲染（单页无翻页可言）。 */
  totalPages: number;
  /** 翻页回调（0 基目标页）。 */
  onChange: (page: number) => void;
  /** 追加类（间距档）；默认自带 mt-2.5（卡底呼吸感）。 */
  className?: string;
}): ReactNode {
  if (totalPages <= 1) return null;
  return (
    <Pagination className={cn('mt-2.5', className)}>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious asChild size="sm">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={page <= 0}
              onClick={() => onChange(page - 1)}
            />
          </PaginationPrevious>
        </PaginationItem>
        {pageItemsOf(page, totalPages).map((item, index) =>
          item === 'ellipsis' ? (
            <PaginationItem key={`ellipsis-${index}`}>
              <PaginationEllipsis className="size-8" />
            </PaginationItem>
          ) : (
            <PaginationItem key={item}>
              <PaginationLink
                asChild
                isActive={item === page}
                size="icon"
                aria-label={`第 ${item + 1} 页`}
              >
                <Button
                  type="button"
                  variant={item === page ? 'outline' : 'ghost'}
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => onChange(item)}
                >
                  {item + 1}
                </Button>
              </PaginationLink>
            </PaginationItem>
          ),
        )}
        <PaginationItem>
          <PaginationNext asChild size="sm">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => onChange(page + 1)}
            />
          </PaginationNext>
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
