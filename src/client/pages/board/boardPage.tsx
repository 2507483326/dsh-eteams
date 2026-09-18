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
 * 与动态改为卡内滚动——看板页不再出外层滚动条。2026-09-18「看板的动态掉下去
 * 了，小于最大高度需要出现外部滚动条」修订：装得下时仍不出滚动条（余高充裕、
 * 三卡 flex 吃满、卡内自滚），余高装不下三卡下限之和时改由看板根 overflow-y-auto
 * 出滚动条（原 overflow-hidden 会把最末的动态卡裁掉且外面滚不动）。
 * 用户 2026-09-16「看板 决策面板和 动态怎么这么高了，给一个最小高度，然后不能
 * 超过屏幕出现外部滚动条」→「决策面板和 动态 应该出现内部滚动条，避免超出出现
 * 外部滚动条」→「三个面板应该是占满整屏的，和团队这种应该是一样的啊，使用flex
 * 布局，限制最小高度」：三个面板（日历定高 + 决策/动态各 flex 吃余高）合起来
 * 占满整屏，两张卡带同一个 300px 下限（BOARD_PANEL_CARD_CLASS——用户同日追加
 * 「决策面板 没有最小高度了」→「最小高度太小了，至少300px 然后待决策中没有数据
 * 时，没有待决策的提示也没有看见了」：下限要留得下卡身固定件与空态行），长内容在
 * 卡内自滚。真正卡住这档的是「面板根没有确定高度」——宿主会话视图区在 active
 * 相位按内容增高，根上的 height:100% 解析成内容高，页内 flex 与卡内滚动全部失效
 * （详见 features/layout/scrollportFit，那里量出宿主滚动视口可见高写回根元素）。
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
}: {
  team: TeamSnapshot | undefined;
  now: number;
}): ReactNode {
  return (
    // 用户 2026-09-15「决策面板和动态分别占 1/2 高度，这个页面不想出现外部
    // 滚动条」+ 2026-09-16「三个面板应该是占满整屏的，和团队这种应该是一样的
    // 啊，使用flex布局，限制最小高度」：看板根吃满内容列余高（flex-1 min-h-0）
    // ——日历卡固定不缩（shrink-0，见 usageCalendar），决策面板与动态各 flex 吃
    // 余高、带 300px 下限（见 BOARD_PANEL_CARD_CLASS），三者合起来占满整屏、
    // 长内容在卡内自滚。本档只在「面板根有确定高度」时成立——由
    // features/layout/scrollportFit 量出宿主滚动视口可见高钉住根元素。
    // 用户 2026-09-18「看板的动态掉下去了，小于最大高度需要出现外部滚动条」：
    // 推翻此前 overflow-hidden 的「裁在页内」兜底——余高装不下三卡下限之和时，
    // 原做法把最末的动态卡裁掉（看着像掉下去了）且外面滚不动。改为本根
    // overflow-y-auto：余高充裕时照旧 flex 吃满、无滚动条；余高不足（面板根被
    // 钉住的可见高小于三卡下限之和）时由本根出滚动条，能滚到动态卡。水平仍裁
    // （overflow-x-hidden，日历 SVG 超宽时不冒横向条）。overflow-x 显式给值也
    // 防止 overflow-y 非 visible 时 overflow-x:visible 被算成 auto。
    // 只收编看板页，其余页签（roster/tasks/team）整列滚动口径不动。
    <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
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
      <ActivityTimeline team={team} now={now} />
    </div>
  );
}
