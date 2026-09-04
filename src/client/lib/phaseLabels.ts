/**
 * 团队阶段 → 中文标签（单一事实源）。
 *
 * S14（docs/21-client-ui-stack.md 21.6 死代码清理项）：card.tsx 与
 * 原 eteamsView.tsx（已拆分至 pages/teamsView/）各持有一份逐字相同的
 * PHASE_LABELS，teamsButton.tsx 又从 eteamsView 转口消费——三处收敛到这里。
 * S15 收尾：eteamsView 的兼容 re-export 已撤，三个消费方均直连本模块。
 *
 * @module dsh-eteams/client/phaseLabels
 */

/** Team phase → display label (staged/running/paused/halted/completed/archived). */
export const PHASE_LABELS: Record<string, string> = {
  staged: '草案',
  running: '运行中',
  paused: '已暂停',
  halted: '已停止',
  completed: '已完成',
  archived: '已归档',
};
