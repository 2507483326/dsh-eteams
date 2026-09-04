/**
 * 看板 · Token 消耗日历卡（docs/28）：每日聚合 + 全年格子 + 悬浮明细。
 * 符号自 eteamsView.tsx 原样搬出（docs/32 32.5.1 纯移动、零行为变更），
 * 供 boardTab 消费（依赖方向：boardTab → usageCalendar → shared）。
 *
 * @module dsh-eteams/client/pages/teamsView/usageCalendar
 */
import { useEffect, useState, type ReactNode } from 'react';
// docs/28 Token 消耗日历：react-activity-calendar（v3，devDep；React 18 peer
// 兼容）+ 其 tooltip 样式（tsdown 虚拟 CSS 插件以字符串载入，见
// usageCalendarCss.d.ts / tsdown.config.ts usageTooltipsCssInline）。
import { ActivityCalendar } from 'react-activity-calendar';
import type { Activity, Labels, ThemeInput } from 'react-activity-calendar';
import usageTooltipsCss from 'react-activity-calendar/tooltips.css';
import ChevronLeft from 'lucide-react/dist/esm/icons/chevron-left.mjs';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right.mjs';
import { fetchUsageCalendar, type UsageCalendar, type UsageDay } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useHostDark } from '../../hooks/useHostDark';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { FormErrorNote, MUTED_CLASS, PANEL_CARD_CLASS, SECTION_TITLE_CLASS } from './shared';
// ---------- docs/28 看板 · Token 消耗日历（每日聚合 + 全年格子） ----------

/** 日历主题（28.5.2 定稿色板）：亮/暗两档各 5 级（0 空档 + 4 活跃档）。 */
const USAGE_CALENDAR_THEME: ThemeInput = {
  light: ['#f1f5f9', '#bae6fd', '#7dd3fc', '#38bdf8', '#0ea5e9'],
  dark: ['#1e293b', '#0c4a6e', '#0369a1', '#0284c7', '#38bdf8'],
};

/** 中文标签（28.5.2）：weekdays 下标 0=周日（组件按 getDay() 索引，实测
 * node_modules build chunks index-B3Gga1-_.js renderWeekdayLabels）。 */
const USAGE_CALENDAR_LABELS: Labels = {
  months: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
  weekdays: ['日', '一', '二', '三', '四', '五', '六'],
  totalCount: '{{year}} 年共 {{count}} tokens',
  legend: { less: '少', more: '多' },
};

let usageStylesInjected = false;

/**
 * 注入 tooltip 样式（幂等，mdEditor ensureMdxStyles 同型）：包内
 * tooltips.css + 两处覆盖。docs/30 28-M3：tooltip 经 FloatingPortal 挂在
 * document.body 根（不在 .eteams-ui 子树内），选择器必须放 body 层全局
 * 生效——样式标签挂 <head>，用包自带的 react-activity-calendar__tooltip
 * 类定位，不依赖 .eteams-ui 祖先。
 */
function ensureUsageCalendarStyles(): void {
  if (usageStylesInjected) return;
  usageStylesInjected = true;
  try {
    const style = document.createElement('style');
    style.setAttribute('data-source', 'dsh-eteams-usage-calendar');
    style.textContent =
      usageTooltipsCss +
      // 覆盖一：明细按 \n 折行（tooltips.activity.text 只回字符串，多行
      // 全靠这里）。
      '.react-activity-calendar__tooltip{white-space:pre-line;}' +
      // 覆盖二：暗色 tooltip 反转为深底浅字，与面板暗色一致（包默认暗档
      // 是浅底深字，浮在暗面板上刺眼）。同标签源序在后，同特异性覆盖生效。
      ".react-activity-calendar__tooltip[data-color-scheme='dark']{background-color:hsl(0 0% 10%);color:hsl(0 0% 94%);}" +
      ".react-activity-calendar__tooltip[data-color-scheme='dark'] .react-activity-calendar__tooltip-arrow{fill:hsl(0 0% 10%);}";
    document.head.appendChild(style);
  } catch {
    // 样式注入失败只影响观感（tooltip 退浏览器默认样式），不炸卡片。
  }
}

/** 千分位（tooltip/合计行）：固定 en-US 分组，不随宿主 locale 漂移。 */
function usageNum(n: number): string {
  return n.toLocaleString('en-US');
}

/** 'yyyy-MM-dd' → 'M月d日'（字符串切片取数，绕开 Date 的时区歧义）。 */
function usageDateLabel(date: string): string {
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  if (!Number.isFinite(month) || !Number.isFinite(day)) return date;
  return `${month}月${day}日`;
}

/** 线性插值百分位（28.5.2 四分位档：P25/P50/P75 定 1-4 级）。 */
function usagePercentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const pos = p * (sorted.length - 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower] ?? 0;
  return (sorted[lower] ?? 0) + ((sorted[upper] ?? 0) - (sorted[lower] ?? 0)) * (pos - lower);
}

/** 日期 → 0-4 级映射：0 恒空档；正数日按 P25/P50/P75 分四档（28.5.2）。 */
function usageLevelsOf(days: readonly UsageDay[]): Map<string, number> {
  const positive = days
    .map((d) => d.totalTokens)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const p25 = usagePercentile(positive, 0.25);
  const p50 = usagePercentile(positive, 0.5);
  const p75 = usagePercentile(positive, 0.75);
  const levels = new Map<string, number>();
  for (const day of days) {
    const v = day.totalTokens;
    levels.set(day.date, v <= 0 ? 0 : v <= p25 ? 1 : v <= p50 ? 2 : v <= p75 ? 3 : 4);
  }
  return levels;
}

/** tooltip 文案（28.5.2 格式）：标题行 + 四分项 + 可选推理行 + 调用次数。 */
function usageTooltipText(day: UsageDay | undefined, activity: Activity): string {
  const lines = [
    `${usageDateLabel(day?.date ?? activity.date)} · ${usageNum(day?.totalTokens ?? 0)} tokens`,
    `输入 ${usageNum(day?.inputTokens ?? 0)} / 输出 ${usageNum(day?.outputTokens ?? 0)} / 缓存读 ${usageNum(
      day?.cacheReadTokens ?? 0,
    )} / 缓存写 ${usageNum(day?.cacheWriteTokens ?? 0)}`,
  ];
  if ((day?.reasoningTokens ?? 0) > 0) {
    lines.push(`推理 ${usageNum(day?.reasoningTokens ?? 0)}（可能与输出重叠）`);
  }
  lines.push(`调用 ${usageNum(day?.calls ?? 0)} 次`);
  return lines.join('\n');
}

/**
 * Token 消耗卡（docs/28.5.2）：全年 365/366 格日历、年份切换（未来年禁用）、
 * 悬浮明细、合计行；60s 低频轮询（面板可见且文档未隐藏才发请求）。取数
 * hooks 全在本组件内部——本组件只在有团队时挂载，BoardTab 早退分支不会
 * 打断任何 hook 序（docs/30 28-M2 约束等价成立）。
 */
export function UsageCalendarCard({ teamId }: { teamId: string }): ReactNode {
  ensureUsageCalendarStyles();
  const dark = useHostDark();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [calendar, setCalendar] = useState<UsageCalendar | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  // 取数 + 低频轮询（28.5.2）：teamId/year/retry 变化即重拉；60s 间隔仅在
  // document 可见时触发；卸载后丢弃迟到响应。loading 不落 state（effect 里
  // 同步 setState 会级联渲染，react-hooks/set-state-in-effect）——首拉 =
  // calendar 仍为 null 即加载中。
  useEffect(() => {
    if (teamId === '') return;
    let alive = true;
    const fetchOne = (): void => {
      fetchUsageCalendar(teamId, year)
        .then((body) => {
          if (!alive) return;
          setCalendar(body);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setError(e instanceof Error ? e.message : String(e));
        });
    };
    fetchOne();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      fetchOne();
    }, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [teamId, year, retry]);

  const days = calendar?.days ?? [];
  const totals = calendar?.totals;
  // 日期 → 明细查表（tooltip 用；Activity.count 只是视觉计数，真值在这里）。
  const dayByDate = new Map(days.map((d) => [d.date, d]));
  const levelByDate = usageLevelsOf(days);
  const activities: Activity[] = days.map((d) => ({
    date: d.date,
    count: d.totalTokens,
    level: levelByDate.get(d.date) ?? 0,
  }));
  // 无数据（totals 全 0）也整年零档渲染（28.5.2），仅补一行说明。
  const hasData = totals !== undefined && totals.totalTokens > 0;
  const firstLoad = calendar === null && error === null;

  return (
    <Card className={PANEL_CARD_CLASS}>
      <div className="flex items-center justify-between">
        <div className={cn(SECTION_TITLE_CLASS, 'mb-0')}>Token 消耗</div>
        {/* 年份切换：右箭头到未来年禁用（28.5.2——未来年无数据可看）。 */}
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label="上一年"
            onClick={() => setYear((y) => y - 1)}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="text-sm font-medium leading-6 text-foreground">{year}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label="下一年"
            disabled={year >= currentYear}
            onClick={() => setYear((y) => y + 1)}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="mt-3 min-w-0">
        {error !== null && calendar === null ? (
          <div>
            <FormErrorNote>消耗数据加载失败：{error}</FormErrorNote>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRetry((n) => n + 1)}
            >
              重试
            </Button>
          </div>
        ) : firstLoad || activities.length > 0 ? (
          <ActivityCalendar
            data={activities}
            loading={firstLoad}
            theme={USAGE_CALENDAR_THEME}
            colorScheme={dark ? 'dark' : 'light'}
            blockSize={11}
            blockMargin={3}
            blockRadius={2}
            fontSize={12}
            weekStart={1}
            showWeekdayLabels={['sun', 'wed']}
            showColorLegend
            labels={USAGE_CALENDAR_LABELS}
            tooltips={{
              activity: {
                text: (activity) => usageTooltipText(dayByDate.get(activity.date), activity),
              },
            }}
          />
        ) : (
          <div className={MUTED_CLASS}>暂无日历数据</div>
        )}
        <div className={cn(MUTED_CLASS, 'mt-2')}>
          {error !== null && calendar !== null
            ? `上次刷新失败：${error}`
            : hasData && totals !== undefined
              ? `全年合计 ${usageNum(totals.totalTokens)} tokens · ${usageNum(totals.calls)} 次调用`
              : calendar !== null
                ? '今年还没有记录到消耗——成员执行任务后这里会逐日亮起。'
                : ''}
        </div>
      </div>
    </Card>
  );
}
