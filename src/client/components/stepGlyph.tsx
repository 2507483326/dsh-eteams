/**
 * 步骤字形（docs/44 M7-6，46 清单）：✔●◌ 三态字形 + 调色原是两份同款——
 * 构建台的构建步骤链（buildWorkbench）与任务抽屉的工位链（taskDrawer）——
 * 连同三态调色表 GLYPH_TONE_CLASS（原 pages/shared 定义）收口
 * 到这里。观感零变更：字符本体是产品语义（✔ 完成 / ● 进行 / ◌ 未到），
 * 只换前景色；未知状态回落 pending 档（原 taskDrawer 逐字口径）。
 *
 * 注记：46 清单原写「GLYPH_TONE_CLASS 归位 features/tasks/taskDisplayStatus.ts」
 * ——但本组件落在 components 层，依赖方向禁止 components 上引 features
 * （45 依赖方向），故表随组件落位（见 46 M7 验收注记）。
 *
 * @module dsh-eteams/client/stepGlyph
 */
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

/** 三态调色表（原 shared.tsx 逐字迁入）：done muted / current 主色 /
 * pending pill 墨色。键为宽松 string——两处消费位的状态值（'done' |
 * 'current' | 'pending'）由各自类型约束，表内回落 pending。 */
export const GLYPH_TONE_CLASS: Record<string, string> = {
  done: 'text-muted-foreground',
  current: 'text-primary',
  pending: 'text-[color:var(--eteams-pill-ink)]',
};

/** ================================== 主组件 ================================== */

/**
 * 步骤字形：state 传 'done' | 'current' | 'pending'（未知值回落 pending
 * 调色并渲染 ◌）；className 透传（两处消费位都带 font-semibold）。
 */
export function StepGlyph({ state, className }: { state: string; className?: string }): ReactNode {
  return (
    <span className={cn(GLYPH_TONE_CLASS[state] ?? GLYPH_TONE_CLASS.pending, className)}>
      {state === 'done' ? '✔' : state === 'current' ? '●' : '◌'}
    </span>
  );
}

/** ================================== 圆点字形（构建工作台专用） ================================== */

/**
 * 三态圆点调色表（用户迭代 2026-09-10）：构建工作台的步骤时间线从 ✔●◌
 * 字形换成统一圆点——完成 business 蓝点（灰勾撤除）、进行中 warning 橙黄
 * 转圈（border-t-transparent 缺口环 + eteams-spin 自转）、未到灰色空心环。
 * 完整字面量映射表（21.5.1）；eteams-spin keyframes 由消费页（rosterAddPage）
 * 注入，与构建台原 sparkle 转圈同一动画源——他处复用须先带上这段注入。
 */
export const STEP_DOT_STATE_CLASS: Record<string, string> = {
  done: 'bg-business',
  current:
    'border-2 border-warning border-t-transparent [animation:eteams-spin_1s_linear_infinite]',
  pending: 'border border-muted-foreground',
};

/**
 * 步骤圆点：三态统一 10px 圆元素（原字形档大一号——用户「圆点变大一些」）。
 * state 未知值回落 pending 空心环（同 StepGlyph 口径）；className 透传给
 * tailwind-merge——构建台头部的进行中档传 h-3.5 w-3.5 覆盖尺寸。
 */
export function StepDot({ state, className }: { state: string; className?: string }): ReactNode {
  return (
    <span
      className={cn(
        'inline-block h-2.5 w-2.5 shrink-0 rounded-full border-solid',
        STEP_DOT_STATE_CLASS[state] ?? STEP_DOT_STATE_CLASS.pending,
        className,
      )}
    />
  );
}
