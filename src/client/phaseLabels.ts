/**
 * 团队阶段 → 中文标签（单一事实源）。
 *
 * S14（docs/21-client-ui-stack.md 21.6 死代码清理项）：card.tsx 与
 * eteamsView.tsx 各持有一份逐字相同的 PHASE_LABELS，teamsButton.tsx 又从
 * eteamsView 转口消费——三处收敛到这里。eteamsView 保留 re-export 兼容既有
 * 导入面（teamsButton.tsx 不在本步 inScope，不动）。
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
