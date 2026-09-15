/**
 * 看板 tab：Token 消耗日历（置顶扁平区）+ 决策面板 + 动态时间线。
 * 用户 2026-09-14「看板里面的动态改成和任务绑定……另加一个决策面板」：
 * - 原顶部两条 Alert 横幅（待决策/待问答）撤除，收编为 `DecisionPanel`
 *   （可点击跳转到作答会话）；
 * - 原「最近动态」内联事件流（最后 8 条、纯文本、无任务绑定）撤除，换成
 *   `ActivityTimeline`（任务绑定、带任务标签与语义色点）。
 * Token 消耗日历置顶定稿位不动。docs/35 §5#1：批准环节下线（staged 横幅与
 * 批准弹窗删除）。用户 2026-09-15「面板去掉 任务动态 卡片」：docs/47 的
 * TaskActivityCard 分区整链撤除（module + 单测一并删除）。
 * 用户 2026-09-15「决策面板和动态分别占 1/2 高度，这个页面不想出现外部滚动
 * 条」：看板根改定高弹性列（flex-1 min-h-0），日历卡 shrink-0 固定，决策面板
 * 与动态各 flex-1 等分余高并改为卡内滚动——看板页不再出外层滚动条。
 * 用户 2026-09-15「看板，团队为空时，还是显示原来的东西，不需要还没有团队
 * 提示」：空态早退分支（还没有团队 + 推荐流程 + error 脚注）整链撤除——看板
 * 无论有无团队都渲染同一套内容（日历走全应用口径、自取数不依赖 teamId；
 * 决策面板/动态无团队时由 activityView 选择器返回空列表、各自给空态行）；
 * 快照加载失败仍由壳的 FormErrorNote 就地提示，故 error 透传链一并撤除。
 *
 * @module dsh-eteams/client/pages/board/boardPage
 */
import type { ReactNode } from 'react';
import type { TeamSnapshot } from '../../lib/monitor';
import { UsageCalendarCard } from './usageCalendar';
import { DecisionPanel } from './decisionPanel';
import { ActivityTimeline } from './activityTimeline';

/** ================================== 主组件 ================================== */

/**
 * 看板：Token 消耗日历（置顶扁平）+ 决策面板（待决策 + 待问答，可点跳转）+
 * 动态时间线（用户 2026-09-14 改造）。团队可缺省（尚未建队）——三个子卡都
 * 照常渲染，团队相关的两个由选择器兜成空态。
 */
export function BoardTab({
  team,
  now,
  fetchedAt,
}: {
  team: TeamSnapshot | undefined;
  now: number;
  fetchedAt: number;
}): ReactNode {
  return (
    // 用户 2026-09-15「决策面板和动态分别占 1/2 高度，这个页面不想出现外部
    // 滚动条」：看板根吃满内容列余高（flex-1 min-h-0）——壳内容列整列
    // overflow-y-auto（CONTENT_CLASS），此前子卡内容随意撑高整列即出外部
    // 滚动条。根变定高弹性列后，日历卡固定不缩（shrink-0，见 usageCalendar），
    // 决策面板与动态各 flex-1 等分余高、各自内部滚动；只收编看板页，其余
    // 页签（roster/tasks/team）整列滚动口径不动。
    <div className="flex min-h-0 flex-1 flex-col">
      {/* docs/28 看板 · 每日 Token 消耗日历（全年格子 + 悬浮明细；用户迭代
      2026-09-05 数据源改全应用口径——GET /usage/calendar，卡自取数不依赖
      teamId）。取数 hooks 都在子组件内部；无团队时也照常挂载取数。 */}
      <UsageCalendarCard />
      {/* 决策面板（用户 2026-09-14）：原两条 Alert 横幅收编为可点击应用项——
      待决策/待问答各一行，带「去处理 / 去回答」跳转钮。2026-09-14 二次迭代
      「决策面板放 token 消耗下面来」：位置自日历上方下移到 Token 消耗卡之下。 */}
      <DecisionPanel team={team} now={now} />
      {/* 动态时间线（用户 2026-09-14）：任务绑定的事件流——行首语义色点 +
      任务标签（#id 主题，可点进详情）+ 事件文本；取代原「最近动态」内联块。 */}
      <ActivityTimeline team={team} now={now} fetchedAt={fetchedAt} />
    </div>
  );
}
