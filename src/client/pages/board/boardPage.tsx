/**
 * 看板 tab：Token 消耗日历（置顶扁平区）+ 最近动态（docs/13.3 看板）。
 * 符号自 eteamsView.tsx 原样搬出（docs/32 32.5.1 纯移动、零行为变更），
 * 依赖 usageCalendar（Token 消耗区）与 shared（页内跨 tab 共享层）。
 * 用户迭代 2026-09-04：目标卡（目标/进度/阶段徽标）整卡撤销；Token 消耗
 * 日历置顶（扁平渲染见 usageCalendar）。
 * docs/35 §5#1：批准环节下线——建队即生效，staged 横幅与批准弹窗随之删除
 * （面板只剩待决策横幅 + 日历 + 最近动态）。
 * M5 结构性改造（docs/44 44.3，行为零变更）：44.3 横幅分区；页内三元查表化
 * ——空态脚注两态收编 EMPTY_FOOTNOTE_META，数据更新行空档占位收编
 * FETCH_AT_EMPTY（另一支为运行时 relativeTime 计算，条件式保留，见常量区
 * 注记）。
 *
 * @module dsh-eteams/client/pages/board/boardPage
 */
import type { ReactNode } from 'react';
import { relativeTime, type TeamSnapshot } from '../../lib/monitor';
import { Alert } from '../../components/ui/alert';
import { Card } from '../../components/ui/card';
import { UsageCalendarCard } from './usageCalendar';
import {
  EMPTY_CLASS,
  LINE_CLASS,
  MUTED_CLASS,
  PANEL_CARD_CLASS,
  SECTION_TITLE_CLASS,
} from '../shared/styles'; /* docs/23 S23-3：原 styles.banner（BANNER_CLASS）迁移 shadcn Alert warning
   变体（amber 淡底以 className 覆盖保留），使用位内联；原
   PROGRESS_TRACK/FILL_CLASS 迁移 shadcn Progress（transform 技法，轨道
   bg-secondary 即原 layer-2 档），一并删除手写常量。 */

/** ================================== 样式类 ================================== */

/** 原 styles.eventRow（D22f：去满宽下边线的表格观感，改留白分组——行
 * py-1.5 + 列表容器 space-y-1；正文 14px/24，meta 12px muted 见使用位）。 */
const EVENT_ROW_CLASS = 'py-1.5 text-sm leading-6 text-foreground';

/** ================================== 常量与映射表 ================================== */

/** 空态脚注两态查表（M5 三元收编，44.2.2）：team undefined 早退分支末行的
 * 状态行——尚未建团队整句 / 状态加载失败前缀。错误支的原始错误串是运行时
 * 值，表存字面量件、消费位拼接（条件式只选组装形态）；两支文案与收编前
 * 逐串一致。 */
const EMPTY_FOOTNOTE_META: Record<'error' | 'noTeam', string> = {
  error: '状态加载失败：',
  noTeam: '尚未创建团队',
};

/** 数据更新行空档占位（M5 收编字面量）：fetchedAt=0 尚未拉到快照——另一
 * 支为运行时 relativeTime 计算，条件式保留（查表只收字面量件）。 */
const FETCH_AT_EMPTY = '—';

/** ================================== 主组件 ================================== */

/**
 * 看板：待决策横幅 + Token 消耗日历（置顶扁平）+ 最近动态（原「概览」；
 * 用户迭代 2026-09-04 去目标卡，docs/35 §5#1 去批准横幅）。S12 迁移面：
 * 横幅/卡片/空态/事件行全部 Tailwind 化；卡片容器用 shadcn Card（底色/
 * 边框/阴影按原 styles.card 覆盖，见 PANEL_CARD_CLASS）。
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
      {team.pendingDecisions.length > 0 && (
        /* docs/23 S23-3：原 BANNER_CLASS → shadcn Alert warning 变体（amber
           淡底 + foreground 正文以 className 覆盖保留）。D22f：去三角字符
           前缀、官网呼吸感 px-4 py-3、正文随基线 14px。 */
        <Alert
          variant="warning"
          className="mb-3 rounded-xl bg-[color:var(--dsw-static-amber-100,#fef5e7)] px-4 py-3 text-sm leading-6 text-foreground"
        >
          {team.pendingDecisions.length} 项待决策：
          {team.pendingDecisions.map((d) => `#${d.taskId}（${d.error.slice(0, 40)}）`).join('；')} ——
          到对话里让领队处理，或等待 M5 的代答操作。
        </Alert>
      )}
      {/* docs/28 看板 · 每日 Token 消耗日历（全年格子 + 悬浮明细；用户迭代
      2026-09-05 数据源改全应用口径——GET /usage/calendar，卡自取数不依赖
      teamId）。取数 hooks 都在子组件内部——子组件只在有团队时挂载，早退
      分支不会打断任何 hook 序（docs/30 28-M2 的「hooks 在早退前」约束等价
      成立）。 */}
      <UsageCalendarCard />
      <Card className={PANEL_CARD_CLASS}>
        <div className={SECTION_TITLE_CLASS}>最近动态</div>
        {/* D22f：事件流去满宽下边线，改留白分组（列表 space-y-1 + 行 py-1.5）。 */}
        <div className="space-y-1">
          {team.latestEvents
            .slice(-8)
            .reverse()
            .map((e) => (
              <div key={e.seq} className={EVENT_ROW_CLASS}>
                <span className={MUTED_CLASS}>
                  {relativeTime(e.at, now)} · {e.actor}
                </span>{' '}
                {e.text}
              </div>
            ))}
          {team.latestEvents.length === 0 && <div className={MUTED_CLASS}>暂无事件</div>}
        </div>
        <div className={MUTED_CLASS}>
          数据更新于 {fetchedAt === 0 ? FETCH_AT_EMPTY : relativeTime(fetchedAt, now)}
        </div>
      </Card>
    </div>
  );
}