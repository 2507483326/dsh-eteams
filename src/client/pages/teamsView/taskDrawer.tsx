/**
 * 任务详情内容（docs/13.3 任务）：合同四数组 + 产出/尝试时间线 + 执行链
 * 站点行。符号自 eteamsView.tsx 原样搬出（docs/32 32.5.1 纯移动）。
 * 2026-09-05 八轮（DA21 任务页拆列表页 + 详情页）：原 S13 shadcn Dialog
 * 抽屉**页面化**——详情内容改为内联组件 TaskDetailContent 由任务详情页
 * 消费（标题/状态头由详情页渲染，本组件只承正文）；TaskStations 导出不变。
 * docs/35 §3#7：合同四数组（验收标准/范围内/范围外/交付物）+ 幂等说明 +
 * 物理阻塞来源进详情；任务号全库自增（docs/27），显示口径 #N。
 *
 * @module dsh-eteams/client/pages/teamsView/taskDrawer
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ATTEMPT_STATUS_LABELS } from '../../features/tasks/taskDisplayStatus';
import { cn } from '../../lib/cn';
import { relativeTime, type TaskView, type TeamSnapshot } from '../../lib/monitor';
import { GLYPH_TONE_CLASS, LINE_CLASS, MUTED_CLASS } from './shared';

/** 原 styles.attempt（执行线路尝试条目：--border 左描边）。 */
const ATTEMPT_CLASS = 'my-2.5 border-l-2 border-solid border-border py-0.5 pl-3';

/** GET /team/<id>/task/<taskId>/track 响应（webui track 路由）：attempts 全量
 * + 合同全文（contract 渲染串）——本抽屉只消费 attempts；任务态/合同字段
 * 已在快照 TaskView 上。 */
interface TrackBody {
  attempts?: {
    id: number;
    member: string;
    kind: string;
    status: string;
    claimedAt?: number;
    endedAt?: number;
    progress?: { at: number; text: string }[];
    error?: string;
    result?: { output: string };
  }[];
}

/** 合同区的一组条目（四数组共用渲染；空数组整组不渲染）。 */
function ContractList({ title, items }: { title: string; items: string[] }): ReactNode {
  if (items.length === 0) return null;
  return (
    <div className="my-1">
      <span className="text-xs font-semibold text-muted-foreground">{title}：</span>
      {items.map((item, i) => (
        <div key={i} className="pl-2 text-muted-foreground">
          · {item}
        </div>
      ))}
    </div>
  );
}

/** S13：执行链站点行——✔/●/◌ 结构原样保留，仅样式改 Tailwind 类。D22f：
 * 字形三态调色查表（GLYPH_TONE_CLASS），站点名/meta 走 12px/20 小字档。
 * 末站完成即 completed（chainCursor 不再推进，docs/35 §5#10）——完成态按
 * 满进度口径显示站点计数。 */
export function TaskStations({ task }: { task: TaskView }): ReactNode {
  if (task.chainLength === 0) return null;
  const doneCursor = task.status === 'completed' ? task.chainLength : task.chainCursor + 1;
  return (
    <div className="mt-[3px]">
      {task.chain.map((s, i) => (
        <span key={i} className="mr-1.5 text-xs leading-5 text-muted-foreground">
          <span
            className={cn(
              GLYPH_TONE_CLASS[s.stationStatus] ?? GLYPH_TONE_CLASS.pending,
              'font-semibold',
            )}
          >
            {s.stationStatus === 'done' ? '✔' : s.stationStatus === 'current' ? '●' : '◌'}
          </span>{' '}
          {s.member}
          {i < task.chain.length - 1 ? ' →' : ''}
        </span>
      ))}
      <span className={MUTED_CLASS}>
        {' '}
        站点 {Math.min(Math.max(doneCursor, 0), task.chainLength)}/{task.chainLength}
      </span>
    </div>
  );
}

/**
 * 任务详情正文（八轮 DA21 页面化）：合同四数组 + 状态说明/阻塞 + 产出 +
 * 尝试时间线。标题/状态头由任务详情页渲染（tasksTab），本组件只承正文；
 * 挂载即拉取 track（attempts 全量），随快照水位（最新事件 seq）回拉。
 * 原 S13 shadcn Dialog 抽屉随页面化撤除（零残留）。
 */
export function TaskDetailContent({
  team,
  task,
  now,
}: {
  team: TeamSnapshot;
  task: TaskView;
  now: number;
}): ReactNode {
  const [track, setTrack] = useState<TrackBody | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch(
      `/eteams-api/team/${encodeURIComponent(team.teamId)}/task/${task.taskId}/track`,
      { cache: 'no-store' },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (alive && body !== null) setTrack(body);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // 回拉锚点：快照版本号已砍（docs/27），最新事件的 seq 即团队变更水位。
  }, [team.teamId, team.latestEvents.at(-1)?.seq, task.taskId]);
  return (
    <div className="text-sm leading-6 text-foreground">
      {task.blocked && task.blockedFrom !== null && (
        <div className="text-warning">阻塞中：前置任务 #{task.blockedFrom} 未完成。</div>
      )}
      {task.statusNote !== null && <div className={LINE_CLASS}>状态说明：{task.statusNote}</div>}
        {task.acceptance.length > 0 && (
          <ContractList title="验收标准" items={task.acceptance} />
        )}
        <ContractList title="范围内" items={task.inScope} />
        <ContractList title="范围外" items={task.outOfScope} />
        <ContractList title="交付物" items={task.deliverables} />
        {task.idempotencyNote !== null && (
          <div className={MUTED_CLASS}>幂等说明：{task.idempotencyNote}</div>
        )}
        {task.outcome !== null && <div className={LINE_CLASS}>产出：{task.outcome}</div>}
        {(track?.attempts ?? [])
          .slice()
          .reverse()
          .map((a) => (
            <div key={a.id} className={ATTEMPT_CLASS}>
              <div className={LINE_CLASS}>
                <strong>{a.id}</strong> · {a.kind} · {a.member} ·{' '}
                {ATTEMPT_STATUS_LABELS[a.status] ?? a.status}
                <span className={MUTED_CLASS}>
                  {' '}
                  {a.claimedAt ? relativeTime(a.claimedAt, now) : ''}
                  {a.endedAt ? `–${relativeTime(a.endedAt, now)}` : ''}
                </span>
              </div>
              {(a.progress ?? []).map((p, i) => (
                <div key={i} className={cn(MUTED_CLASS, 'my-1')}>
                  {relativeTime(p.at, now)} {p.text}
                </div>
              ))}
              {a.error !== undefined && (
                <div className="my-1 text-sm leading-6 text-destructive">✘ {a.error}</div>
              )}
              {a.result?.output !== undefined && (
                <div className={MUTED_CLASS}>✔ {a.result.output}</div>
              )}
            </div>
          ))}
        {track === null && <div className={MUTED_CLASS}>执行线路加载中…</div>}
    </div>
  );
}