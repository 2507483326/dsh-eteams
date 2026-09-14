/**
 * 看板 tab：Token 消耗日历（置顶扁平区）+ 决策面板 + 任务动态 + 动态时间线。
 * 用户 2026-09-14「看板里面的动态改成和任务绑定……另加一个决策面板」：
 * - 原顶部两条 Alert 横幅（待决策/待问答）撤除，收编为 `DecisionPanel`
 *   （可点击跳转到作答会话）；
 * - 原「最近动态」内联事件流（最后 8 条、纯文本、无任务绑定）撤除，换成
 *   `ActivityTimeline`（任务绑定、带任务标签与语义色点）。
 * Token 消耗日历置顶定稿位不动；任务动态分区（TaskActivityCard）不动。
 * docs/35 §5#1：批准环节下线（staged 横幅与批准弹窗删除）。docs/47：任务动态
 * 分区插在日历与时间线之间。M5 结构性改造（docs/44 44.3）：空态脚注两态收编
 * EMPTY_FOOTNOTE_META。
 *
 * @module dsh-eteams/client/pages/board/boardPage
 */
import type { ReactNode } from 'react';
import type { TeamSnapshot } from '../../lib/monitor';
import { UsageCalendarCard } from './usageCalendar';
import { TaskActivityCard } from './taskActivity';
import { DecisionPanel } from './decisionPanel';
import { ActivityTimeline } from './activityTimeline';
import { EMPTY_CLASS, LINE_CLASS, MUTED_CLASS } from '../shared/styles';

/** ================================== 常量与映射表 ================================== */

/** 空态脚注两态查表（M5 三元收编，44.2.2）：team undefined 早退分支末行的
 * 状态行——尚未建团队整句 / 状态加载失败前缀。错误支的原始错误串是运行时
 * 值，表存字面量件、消费位拼接（条件式只选组装形态）；两支文案与收编前
 * 逐串一致。 */
const EMPTY_FOOTNOTE_META: Record<'error' | 'noTeam', string> = {
  error: '状态加载失败：',
  noTeam: '尚未创建团队',
};

/** ================================== 主组件 ================================== */

/**
 * 看板：Token 消耗日历（置顶扁平）+ 决策面板（待决策 + 待问答，可点跳转）+
 * 任务动态分区 + 动态时间线（用户 2026-09-14 改造）。空态早退分支沿用。
 */
export function BoardTab({
  team,
  now,
  fetchedAt,
  error,
}: {
  team: TeamSnapshot | undefined;
  now: number;
  fetchedAt: number;
  error: string | null;
}): ReactNode {
  if (team === undefined) {
    return (
      <div className={EMPTY_CLASS}>
        <p>还没有团队。</p>
        <p className={LINE_CLASS}>
          推荐流程：先到「角色」页新增角色，再到「团队」页创建团队并把角色拉进去。
        </p>
        <p className={LINE_CLASS}>
          也可以在对话中说「用 AgentTeams 做某事」或 <code>/agent-teams</code>
          ，领队会先问询、再拆解计划等你批准。
        </p>
        <p className={MUTED_CLASS}>
          {error !== null
            ? `${EMPTY_FOOTNOTE_META.error}${error}`
            : EMPTY_FOOTNOTE_META.noTeam}
        </p>
      </div>
    );
  }
  return (
    <div>
      {/* docs/28 看板 · 每日 Token 消耗日历（全年格子 + 悬浮明细；用户迭代
      2026-09-05 数据源改全应用口径——GET /usage/calendar，卡自取数不依赖
      teamId）。取数 hooks 都在子组件内部——子组件只在有团队时挂载，早退
      分支不会打断任何 hook 序（docs/30 28-M2 的「hooks 在早退前」约束等价
      成立）。 */}
      <UsageCalendarCard />
      {/* 决策面板（用户 2026-09-14）：原两条 Alert 横幅收编为可点击应用项——
      待决策/待问答各一行，带「去处理 / 去回答」跳转钮。2026-09-14 二次迭代
      「决策面板放 token 消耗下面来」：位置自日历上方下移到 Token 消耗卡之下。 */}
      <DecisionPanel team={team} now={now} />
      {/* docs/47 任务动态分区（board/taskActivity）：顶层任务平铺只读小卡 +
      主任务小任务窗口。 */}
      <TaskActivityCard team={team} />
      {/* 动态时间线（用户 2026-09-14）：任务绑定的事件流——行首语义色点 +
      任务标签（#id 主题，可点进详情）+ 事件文本；取代原「最近动态」内联块。 */}
      <ActivityTimeline team={team} now={now} fetchedAt={fetchedAt} />
    </div>
  );
}
