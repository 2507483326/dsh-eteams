/**
 * 看板 · Token 消耗日历卡（docs/28）：每日聚合 + 全年格子 + 悬浮明细。
 * 符号自 eteamsView.tsx 原样搬出（docs/32 32.5.1 纯移动、零行为变更），
 * 供 board/boardPage 消费（依赖方向：boardPage → usageCalendar → shared）。
 * 用户迭代 2026-09-04：置看板顶部；样式回归 docs/28 28.5.2 卡片规格
 * （PANEL_CARD_CLASS 卡壳），日历与 meta 行居中显示；格子无装饰扁平化
 * （renderBlock 去包内 hairline 描边，见 usageFlatBlock）。
 * 用户迭代 2026-09-05：数据源改**全应用口径**（fetchAppUsageCalendar →
 * GET /usage/calendar，不按团队/归属过滤，workspace 桶一并计入，标题加
 * 「全应用」标注）；meta 行前置「今日 X tokens」——今天那格本就在全年
 * 零填充响应里（usageTodayKey 本地拼装），无需新接口。
 * 用户迭代 2026-09-05（二）：档位改固定「AI 代码工程师强度」标尺（0 空 +
 * 10 万/100 万/300 万三道台阶，见 USAGE_LEVEL_STEPS），不再按当年四分位
 * 相对划分；tooltip 行首带档位名（轻度/常规/高强度/满负荷）。
 * M5 结构性改造（docs/44 44.3，行为零变更）：44.3 横幅分区——档位表
 * （USAGE_LEVEL_STEPS/USAGE_LEVEL_NAMES）已表驱动，保持原样仅归组。
 *
 * @module dsh-eteams/client/pages/board/usageCalendar
 */
import { cloneElement, useEffect, useState, type ReactElement, type ReactNode } from 'react';
// docs/28 Token 消耗日历：react-activity-calendar（v3，devDep；React 18 peer
// 兼容）+ 其 tooltip 样式（tsdown 虚拟 CSS 插件以字符串载入，见
// usageCalendarCss.d.ts / tsdown.config.ts usageTooltipsCssInline）。
import { ActivityCalendar } from 'react-activity-calendar';
import type { Activity, BlockElement, Labels, ThemeInput } from 'react-activity-calendar';
import usageTooltipsCss from 'react-activity-calendar/tooltips.css';
import ChevronLeft from 'lucide-react/dist/esm/icons/chevron-left.mjs';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right.mjs';
import { fetchAppUsageCalendar, type AppUsageCalendar, type UsageDay } from '../../lib/api';
import { cn } from '../../lib/cn';
import { errorMessageOf } from '../../lib/errors';
import { useHostDark } from '../../hooks/useHostDark';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { FormErrorNote } from '../shared/components';
import { MUTED_CLASS, PANEL_CARD_CLASS, SECTION_TITLE_CLASS } from '../shared/styles';

/** ================================== 常量与映射表 ================================== */

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

/** 固定档位标尺（用户迭代 2026-09-05：按 AI 代码工程师的日强度划分，不再
 * 按当年四分位「自己和自己比」——相对划分下年初数据少时一天峰值日即爆表、
 * 平常日全灭，且档位随数据漂移）。四档（0 恒空档）：
 * 轻度 ≤10 万 → 常规 ≤100 万 → 高强度 ≤300 万 → 满负荷 >300 万（>500 万
 * 同样顶格满负荷色——日历只有 4 个活跃色档）。 */
const USAGE_LEVEL_STEPS = [100_000, 1_000_000, 3_000_000] as const;

/** 档位名（tooltip 行首标注，让「按强度划分」看得见；下标 = 档-1）。 */
const USAGE_LEVEL_NAMES = ['轻度', '常规', '高强度', '满负荷'] as const;

/** ================================== 工具函数 ================================== */

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

/** 当天本地 'yyyy-MM-dd'（与宿主 dayKeyOf 同构的本地字段拼装，绕开
 * toISOString 的 UTC 歧义——面板与宿主同机，本地时区一致）。 */
function usageTodayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** totalTokens → 0-4 档：0 恒空档，正数按固定标尺逐级抬升。 */
function usageLevelOf(totalTokens: number): number {
  if (totalTokens <= 0) return 0;
  let level = 1;
  for (const step of USAGE_LEVEL_STEPS) {
    if (totalTokens > step) level += 1;
  }
  return level;
}

/** tooltip 文案（28.5.2 格式）：行首档位名 + 四分项 + 可选推理行 + 调用次数。 */
function usageTooltipText(day: UsageDay | undefined, activity: Activity): string {
  const band = activity.level > 0 ? ` · ${USAGE_LEVEL_NAMES[activity.level - 1] ?? ''}` : '';
  const lines = [
    `${usageDateLabel(day?.date ?? activity.date)} · ${usageNum(day?.totalTokens ?? 0)} tokens${band}`,
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

/** 无装饰扁平格子（用户迭代 2026-09-04）：包 v3 给每个方块硬编码 hairline
 * 描边（light `rgba(0,0,0,0.08)` / dark `rgba(255,255,255,0.04)`，视觉即格内
 * 阴影/高光边），经 `renderBlock` + cloneElement 以 `stroke:'none'` 覆写——
 * 数据格与图例色块都只留纯色方块（圆角 blockRadius=2 属几何规格保留，见
 * docs/28.5.2 几何行）。 */
function usageFlatBlock(block: BlockElement): ReactElement {
  return cloneElement(block, { style: { ...block.props.style, stroke: 'none' } });
}

/** 图例色块扁平：renderColorLegend 拿到的是包着色块的 svg wrapper（描边在
 * 内层 rect 的 style 上），拆开取内层 rect 交 usageFlatBlock 同款覆写。 */
function usageFlatLegendBlock(block: BlockElement): ReactElement {
  return cloneElement(block, {
    children: usageFlatBlock(block.props.children as BlockElement),
  });
}

/** ================================== 主组件 ================================== */

/**
 * Token 消耗卡（docs/28.5.2）：全年 365/366 格日历、年份切换（未来年禁用）、
 * 悬浮明细、合计行；60s 低频轮询（面板可见且文档未隐藏才发请求）。取数
 * hooks 全在本组件内部——本组件只在有团队时挂载，BoardTab 早退分支不会
 * 打断任何 hook 序（docs/30 28-M2 约束等价成立）。
 */
export function UsageCalendarCard(): ReactNode {
  ensureUsageCalendarStyles();
  const dark = useHostDark();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [calendar, setCalendar] = useState<AppUsageCalendar | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  // 取数 + 低频轮询（28.5.2）：year/retry 变化即重拉；60s 间隔仅在
  // document 可见时触发；卸载后丢弃迟到响应。loading 不落 state（effect 里
  // 同步 setState 会级联渲染，react-hooks/set-state-in-effect）——首拉 =
  // calendar 仍为 null 即加载中。
  useEffect(() => {
    let alive = true;
    const fetchOne = (): void => {
      fetchAppUsageCalendar(year)
        .then((body) => {
          if (!alive) return;
          setCalendar(body);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setError(errorMessageOf(e));
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
  }, [year, retry]);

  const days = calendar?.days ?? [];
  const totals = calendar?.totals;
  // 日期 → 明细查表（tooltip 用；Activity.count 只是视觉计数，真值在这里）。
  const dayByDate = new Map(days.map((d) => [d.date, d]));
  // 今天那格直接来自同一份全年零填充响应——无需新接口；无数据日为 0。
  const todayTotal = dayByDate.get(usageTodayKey())?.totalTokens ?? 0;
  const activities: Activity[] = days.map((d) => ({
    date: d.date,
    count: d.totalTokens,
    level: usageLevelOf(d.totalTokens),
  }));
  // 无数据（totals 全 0）也整年零档渲染（28.5.2），仅补一行说明。
  const hasData = totals !== undefined && totals.totalTokens > 0;
  const firstLoad = calendar === null && error === null;

  return (
    <Card className={PANEL_CARD_CLASS}>
      <div className="flex items-center justify-between">
        <div className={cn(SECTION_TITLE_CLASS, 'mb-0 flex items-center gap-2')}>
          Token 消耗
          {/* 口径标注（2026-09-05 用户迭代：数据源全应用——含普通对话与各
          团队，非单团队视图）。 */}
          <span className={cn(MUTED_CLASS, 'text-xs font-normal')}>全应用</span>
        </div>
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
      {/* 日历居中（用户迭代 2026-09-04）：SVG 固定宽度，flex justify-center
      在容器更窄时两侧等量溢出裁切，宽面板即正居中；flex 只包日历本体，
      meta 行留居中层外整行居中。 */}
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
          <div className="flex justify-center">
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
              renderBlock={usageFlatBlock}
              renderColorLegend={usageFlatLegendBlock}
              tooltips={{
                activity: {
                  text: (activity) => usageTooltipText(dayByDate.get(activity.date), activity),
                },
              }}
            />
          </div>
        ) : (
          <div className={cn(MUTED_CLASS, 'text-center')}>暂无日历数据</div>
        )}
        <div className={cn(MUTED_CLASS, 'mt-2 text-center')}>
          {error !== null && calendar !== null
            ? `上次刷新失败：${error}`
            : hasData && totals !== undefined
              ? `今日 ${usageNum(todayTotal)} tokens · 全年合计 ${usageNum(totals.totalTokens)} tokens · ${usageNum(totals.calls)} 次调用`
              : calendar !== null
                ? `今日 ${usageNum(todayTotal)} tokens · 应用今年还没有消耗——发起对话或成员执行任务后这里会逐日亮起。`
                : ''}
        </div>
      </div>
    </Card>
  );
}
