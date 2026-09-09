/**
 * 返回钮（用户迭代 2026-09-08：页面返回统一收口为单组件）：原 BackBar 四档
 * variant（outline/secondary/ghost/text）+ 逐处漂移的文案标签撤除——改纯图标
 * 钮（lucide ArrowLeft，ghost Button 图标档），无文案、无档位，唯一样式。
 * 位置统一在页头行最右端：面板页经 PageHeader 的 onBack 槽渲染（ml-auto
 * 内建推右），整页覆盖层 teamsPanel 顶栏直接消费本组件。
 *
 * @module dsh-eteams/client/backButton
 */
import type { ReactNode } from 'react';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left.mjs';
import { cn } from '../lib/cn';
import { Button } from './ui/button';

/** ================================== 主组件 ================================== */

/**
 * 返回钮：白底描边图标钮（用户迭代 2026-09-08：背景改白、边框加深）——
 * outline Button 图标档，size=icon 的 h-9 w-9 以 h-8 w-8 压低（贴 20px 页头
 * 标题行）；覆盖层显式 border-solid + slate-300 深档边框 + bg-white 面
 * （outline hover 的 bg-accent 压回白底，悬停反馈走文字提亮），阴影撤平。
 * 图标尺寸走 Button 基座 [&_svg]:size-4，不再逐处传。ml-auto 内建——
 * flex 行内自动推到最右（与 PageHeader 的 flex-1 动作位共存时为无操作）。
 */
export function BackButton({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}): ReactNode {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className={cn(
        'ml-auto h-8 w-8 border border-solid border-slate-300 bg-white text-muted-foreground shadow-none hover:bg-white hover:text-foreground',
        className,
      )}
      aria-label="返回"
      title="返回"
      onClick={onClick}
    >
      <ArrowLeft />
    </Button>
  );
}
