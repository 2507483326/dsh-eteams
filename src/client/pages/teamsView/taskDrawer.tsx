/**
 * 任务详情抽屉（docs/13.3 任务）：执行链站点行 + 产出/尝试时间线 Dialog。
 * 符号自 eteamsView.tsx 原样搬出（docs/32 32.5.1 纯移动、零行为变更），
 * 供 tasksTab 消费（依赖方向：tasksTab → taskDrawer → shared）。
 *
 * @module dsh-eteams/client/pages/teamsView/taskDrawer
 */
import { useEffect, useState, type ReactNode } from 'react';
import { STATUS_LABELS } from '../../features/tasks/taskDisplayStatus';
import { cn } from '../../lib/cn';
import { relativeTime, type TaskView, type TeamSnapshot } from '../../lib/monitor';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { GLYPH_TONE_CLASS, LINE_CLASS, MUTED_CLASS } from './shared';

/** 原 styles.attempt（执行线路尝试条目：--border 左描边）。 */
const ATTEMPT_CLASS = 'my-2.5 border-l-2 border-solid border-border py-0.5 pl-3';
/** 任务详情 Dialog 的调用面覆盖：限宽收高可滚动 + 面板文字基准（portal
 * 容器挂在 body 下，不继承 SHELL 的 14px/前景色，这里显式补齐——D22d 官网
 * prose-sm 档 text-sm leading-6；max-w-xl 压过上游 max-w-lg，rounded-xl 与
 * 上游 sm:rounded-lg 同为 12px）。 */
const DRAWER_DIALOG_CLASS =
  'max-h-[70vh] max-w-xl overflow-y-auto rounded-xl text-sm leading-6 text-foreground';

/** S13：执行链站点行——✔/●/◌ 结构原样保留，仅样式改 Tailwind 类。D22f：
 * 字形三态调色查表（GLYPH_TONE_CLASS），站点名/meta 走 12px/20 小字档。 */
export function TaskStations({ task }: { task: TaskView }): ReactNode {
  if (task.chainLength === 0) return null;
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
        站点 {Math.min(task.chainCursor + 1, task.chainLength)}/{task.chainLength}
      </span>
    </div>
  );
}

/**
 * S13：任务详情抽屉 → shadcn Dialog。开合状态仍走 ui model：expandedTask
 * === task.taskId 时由 TasksTab 挂载本组件（track 拉取随挂载触发，与迁移前
 * 一致），挂载即 open；Esc/遮罩/关闭钮统一走 onOpenChange → onClose，由
 * 调用点 dispatch ui/setDrawerTask(null) 收起（S9 的显式 null 语义）。
 * 内容结构原样保留（产出 + 尝试时间线），仅样式改 Tailwind 类。
 */
export function TaskDrawer({
  team,
  task,
  now,
  onClose,
}: {
  team: TeamSnapshot;
  task: TaskView;
  now: number;
  onClose: () => void;
}): ReactNode {
  const [track, setTrack] = useState<{
    attempts?: {
      id: string;
      member: string;
      kind: string;
      status: string;
      claimedAt?: number;
      endedAt?: number;
      progress?: { at: number; text: string }[];
      error?: string;
      result?: { output: string };
    }[];
  } | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch(
      `/eteams-api/team/${encodeURIComponent(team.teamId)}/task/${encodeURIComponent(task.taskId)}/track`,
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
  }, [team.teamId, team.version, task.taskId]);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className={DRAWER_DIALOG_CLASS}>
        <DialogHeader className="space-y-1 text-left">
          <DialogTitle>
            {task.taskId} · {task.subject}
          </DialogTitle>
          <DialogDescription className={MUTED_CLASS}>
            {STATUS_LABELS[task.status] ?? task.status}
            {task.assignee !== null ? ` · ${task.assignee}` : ''}
          </DialogDescription>
        </DialogHeader>
        {task.outcome !== null && <div className={LINE_CLASS}>产出：{task.outcome}</div>}
        {(track?.attempts ?? [])
          .slice()
          .reverse()
          .map((a) => (
            <div key={a.id} className={ATTEMPT_CLASS}>
              <div className={LINE_CLASS}>
                <strong>{a.id}</strong> · {a.kind} · {a.member} ·{' '}
                {STATUS_LABELS[a.status] ?? a.status}
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
      </DialogContent>
    </Dialog>
  );
}
