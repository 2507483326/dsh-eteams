/**
 * 步骤圆点（2026-09-10 出生；2026-09-11 起本模块唯一导出）：构建工作台的步骤
 * 时间线用统一圆点——完成 business 蓝点、进行中 warning 橙黄转圈、未到灰色
 * 空心环。原 ✔●◌ 字形（StepGlyph）在执行链改成员卡（taskDrawer.TaskStations）
 * 后已无消费方，随「执行链改卡片」整链撤除。
 *
 * 为什么是 SVG：首版用 border/rounded 工具类实现，宿主（DeepSeek Harness）
 * 侧样式压过圆角与边框属性，圆点渲染成方角——`<circle>` 是矢量形状，不经过
 * CSS border-radius 通道，宿主样式无从干扰；转圈动画用 SVG 内建的
 * `<animateTransform>`，也不再依赖消费页注入的 eteams-spin keyframes。
 * 填色走内联 style 的 CSS 变量（亮暗主题照常跟随），内联样式再挡一层。
 *
 * 尺寸基线 10px（原字形档大一号——用户「圆点变大一些」）；className 透传给
 * tailwind-merge——构建台头部的进行中档传 h-3.5 w-3.5 覆盖尺寸。
 *
 * @module dsh-eteams/client/stepGlyph
 */
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

/** ================================== 圆点字形（构建工作台专用） ================================== */

/**
 * 步骤圆点（用户迭代 2026-09-10）：构建工作台的步骤时间线从 ✔●◌ 字形换成
 * 统一圆点——完成 business 蓝点（灰勾撤除）、进行中 warning 橙黄转圈、
 * 未到灰色空心环。
 *
 * 为什么是 SVG：首版用 border/rounded 工具类实现，宿主（DeepSeek Harness）
 * 侧样式压过圆角与边框属性，圆点渲染成方角——`<circle>` 是矢量形状，不经过
 * CSS border-radius 通道，宿主样式无从干扰；转圈动画用 SVG 内建的
 * `<animateTransform>`，也不再依赖消费页注入的 eteams-spin keyframes。
 * 填色走内联 style 的 CSS 变量（亮暗主题照常跟随），内联样式再挡一层。
 *
 * 尺寸基线 10px（原字形档大一号——用户「圆点变大一些」）；className 透传给
 * tailwind-merge——构建台头部的进行中档传 h-3.5 w-3.5 覆盖尺寸。
 */
export function StepDot({ state, className }: { state: string; className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 10 10" className={cn('h-2.5 w-2.5 shrink-0', className)} aria-hidden>
      {state === 'done' ? (
        <circle cx="5" cy="5" r="4.5" style={{ fill: 'var(--business)' }} />
      ) : state === 'current' ? (
        // 缺口环（周长 ≈ 23.6，dash 15.5 + gap 8）+ 圆头线帽，自转一圈 1s。
        <circle
          cx="5"
          cy="5"
          r="3.75"
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="15.5 8"
          style={{ stroke: 'var(--warning)' }}
        >
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 5 5"
            to="360 5 5"
            dur="1s"
            repeatCount="indefinite"
          />
        </circle>
      ) : (
        <circle
          cx="5"
          cy="5"
          r="4"
          fill="none"
          strokeWidth="1.5"
          style={{ stroke: 'var(--muted-foreground)' }}
        />
      )}
    </svg>
  );
}
