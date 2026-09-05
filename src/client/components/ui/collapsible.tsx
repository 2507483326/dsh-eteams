/**
 * shadcn/ui Collapsible（new-york 风格，手动 vendoring — dialog.tsx /
 * popover.tsx 同款先例）。
 *
 * 用途（用户迭代 2026-09 十七轮 DA30「展开功能用 shadcn 组件」）：任务详情页
 * 小任务卡的展开/收起——触发钮在卡头行、展开内容渲染在成员卡槽下方；
 * Radix Collapsible 自带受控开合与无障碍语义（aria-expanded 等）。
 *
 * 本仓适配（与上游保持最小 diff，便于未来对照升级）：
 * - 上游 new-york 版 Collapsible 本就无 cn 导入（Root/Trigger/Content 均无
 *   样式类），此处保持原样——如后续加样式类再按惯例改相对导入 `../../cn`；
 * - 类型按 verbatimModuleSyntax / strict 规整；"use client" 指令移除。
 *
 * @module dsh-eteams/client/components/ui/collapsible
 */
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';

const Collapsible = CollapsiblePrimitive.Root;

const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger;

const CollapsibleContent = CollapsiblePrimitive.CollapsibleContent;

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
