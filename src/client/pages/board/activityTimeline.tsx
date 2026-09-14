/**
 * 看板「动态」时间线卡（用户 2026-09-14「看板里面的动态改成和任务绑定，每个
 * 任务的进度都在这里进行报告」）：单一时间线（新→旧），每条行首按语义色点
 * 分档，任务相关事件带**任务标签**（#id 主题，可点进任务详情）——取代原
 * 「最近动态」内联块（只有最后 8 条、纯文本、任务无绑定）。数据由
 * features/activity 的 `activityRowsOf` 投影（补主题与色调）。
 *
 * @module dsh-eteams/client/pages/board/activityTimeline
 */
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { activityRowsOf } from '../../features/activity/activityView';
import { DOT_BASE_CLASS, DOT_TONE_CLASS } from '../../features/tasks/taskDisplayStatus';
import { cn } from '../../lib/cn';
import { relativeTime, type TeamSnapshot } from '../../lib/monitor';
import { Card } from '../../components/ui/card';
import { MUTED_CLASS, PANEL_CARD_CLASS, SECTION_TITLE_CLASS } from '../shared/styles';

/** 时间线可视高度（约 12 行，超出滚动；快照窗口 30 条不撑爆看板）。 */
const TIMELINE_BODY_CLASS = 'max-h-[360px] space-y-0.5 overflow-y-auto';

/** 任务标签 chip（有主题时可点进详情）。 */
const TASK_TAG_CLASS =
  'inline rounded bg-muted px-1.5 py-px text-xs text-foreground underline-offset-2 hover:underline';

/** 数据更新行空档占位（fetchedAt=0 尚未拉到快照）。 */
const FETCH_AT_EMPTY = '—';

export function ActivityTimeline({
  team,
  now,
  fetchedAt,
}: {
  team: TeamSnapshot;
  now: number;
  fetchedAt: number;
}): ReactNode {
  const navigate = useNavigate();
  const rows = activityRowsOf(team);
  return (
    <Card className={PANEL_CARD_CLASS}>
      <div className={SECTION_TITLE_CLASS}>动态</div>
      <div className={TIMELINE_BODY_CLASS}>
        {rows.map((r) => (
          <div
            key={r.key}
            className="flex items-start gap-2 py-1.5 text-sm leading-6 text-foreground"
          >
            <span
              className={cn(DOT_BASE_CLASS, DOT_TONE_CLASS[r.tone], 'mt-2.5')}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              <span className={MUTED_CLASS}>
                {relativeTime(r.at, now)} · {r.actor}
              </span>{' '}
              {r.taskId !== null &&
                (r.taskSubject !== null ? (
                  <button
                    type="button"
                    className={TASK_TAG_CLASS}
                    title={r.taskSubject}
                    onClick={() => navigate(`/tasks/${r.taskId}`)}
                  >
                    #{r.taskId} {r.taskSubject}
                  </button>
                ) : (
                  <span className={MUTED_CLASS}>#{r.taskId}</span>
                ))}{' '}
              {r.text}
            </span>
          </div>
        ))}
        {rows.length === 0 && <div className={MUTED_CLASS}>暂无动态</div>}
      </div>
      <div className={MUTED_CLASS}>
        数据更新于 {fetchedAt === 0 ? FETCH_AT_EMPTY : relativeTime(fetchedAt, now)}
      </div>
    </Card>
  );
}
