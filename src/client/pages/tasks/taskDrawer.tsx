/**
 * 任务详情内容（docs/13.3 任务）：合同 MD + 产出/尝试时间线 + 执行链
 * 站点行。符号自 eteamsView.tsx 原样搬出（docs/32 32.5.1 纯移动）。
 * 2026-09-05 八轮（DA21 任务页拆列表页 + 详情页）：原 S13 shadcn Dialog
 * 抽屉**页面化**——详情内容改为内联组件 TaskDetailContent 由任务详情页
 * 消费（标题/状态头由详情页渲染，本组件只承正文）；TaskStations 导出不变。
 * docs/35 §3#7：合同 + 幂等说明 + 物理阻塞来源进详情；任务号全库自增
 * （docs/27），显示口径 #N。十六轮 DA29：合同四数组（验收标准/范围内/
 * 范围外/交付物）合并为一篇 Markdown（task.contractMd），详情区改
 * MarkdownText 只读渲染（MarkdownDoc typeset 包装，docs/41；成员手册同款原语）。
 * 2026-09-06 三十三轮 DA46：合同区自本组件撤除（合同/说明的展示与编辑归
 * 详情页头部卡展开区，与小任务卡展开区同款）——本组件只承阻塞/状态说明/
 * 幂等说明/产出/尝试时间线。
 *
 * @module dsh-eteams/client/pages/tasks/taskDrawer
 */
import { useEffect, useState, type ReactNode } from 'react';
import LoaderCircle from 'lucide-react/dist/esm/icons/loader-circle.mjs';
import { ATTEMPT_STATUS_LABELS } from '../../features/tasks/taskDisplayStatus';
import { cn } from '../../lib/cn';
import { employeeIdNumberOf, relativeTime, type MemberView, type TaskView, type TeamSnapshot } from '../../lib/monitor';
import { Avatar } from '../../features/avatar/avatar';
import { BORDER_L1_CLASS, LINE_CLASS, MUTED_CLASS } from '../shared/styles';

/** 原 styles.attempt（执行线路尝试条目：--border 左描边）。M7-11 统一
 * token 口径：border-border 即 border-[color:var(--border)]（tailwind.config
 * borderColor.border 同值），改引 BORDER_L1_CLASS 同值异名归一。 */
const ATTEMPT_CLASS = `my-2.5 border-l-2 border-solid py-0.5 pl-3 ${BORDER_L1_CLASS}`;

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

/* 执行链站点卡片（用户迭代 2026-09-11「执行链还是和之前一样的卡片，正在执行
   的蓝色框，卡片里面的前面加一个小的蓝色转圈圈」）：每个站点一张成员卡
   （头像 + 名字），正在执行的那张加业务蓝描边 + 蓝转圈；完成/未到用透明度
   区分。完整字面量映射（21.5.1 禁拼接纪律）。
   用户迭代 2026-09-12「小任务里面的成员卡片有些大有些小，都统一一下」：
   尺寸口径对齐任务内既有成员卡（taskAssign 的 BOX_CHIP/STRIP_CHIP/
   CAPTAIN_CHIP 一族：h-32px / min-w-96px / rounded-4px / 头像 26），原
   30px + 头像 20 + 圆角 6px 是唯一出格档。 */
const STATION_CARD_CLASS =
  'inline-flex h-[32px] min-w-[96px] shrink-0 items-center gap-1.5 rounded-[4px] border border-solid border-[color:var(--border)] bg-[color:var(--eteams-pill-bg)] px-2 text-xs font-medium text-[color:var(--eteams-pill-ink)]';
const STATION_CARD_ACTIVE_CLASS = 'border-business';
const STATION_CARD_DONE_CLASS = 'opacity-70';
const STATION_CARD_PENDING_CLASS = 'opacity-50';

/** 站点引用 → 成员行（v7 反查：工号数字串按工号找，旧名字串按名找）。 */
function stationMemberOf(members: readonly MemberView[], ref: string): MemberView | undefined {
  const trimmed = ref.trim();
  const numeric = Number.parseInt(trimmed, 10);
  if (Number.isFinite(numeric) && String(numeric) === trimmed) {
    return members.find((m) => employeeIdNumberOf(m.employeeId) === numeric);
  }
  return members.find((m) => m.name === trimmed);
}

/** 执行链（用户迭代 2026-09-11 由字形文本行改回卡片行）：每站一张成员卡，
 * 正在执行（任务 start 且本站为当前站）的那张带蓝色描边 + 蓝转圈。末站完成
 * 即 completed（chainCursor 不再推进，docs/35 §5#10）——完成态站点走 done
 * 档透明度。 */
export function TaskStations({
  task,
  members = [],
}: {
  task: TaskView;
  members?: readonly MemberView[];
}): ReactNode {
  if (task.chainLength === 0) return null;
  const executing = task.status === 'start';
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {task.chain.map((s, i) => {
        const record = stationMemberOf(members, s.member);
        const display = record?.name ?? s.memberLabel ?? s.member;
        const active = executing && s.stationStatus === 'current';
        return (
          <div
            key={i}
            title={`站点 ${i + 1}：${s.memberLabel ?? s.member}${
              s.stageBrief ? ` — ${s.stageBrief}` : ''
            }`}
            className={cn(
              STATION_CARD_CLASS,
              active && STATION_CARD_ACTIVE_CLASS,
              s.stationStatus === 'done' && STATION_CARD_DONE_CLASS,
              s.stationStatus === 'pending' && STATION_CARD_PENDING_CLASS,
            )}
          >
            {active && (
              <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-business" />
            )}
            <Avatar
              name={display}
              seed={record?.avatar?.seed}
              salt={record?.avatar?.salt}
              size={26}
            />
            <span>{display}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 任务详情正文（八轮 DA21 页面化）：合同 MD（十六轮 DA29 由四数组改一篇
 * Markdown）+ 状态说明/阻塞 + 产出 + 尝试时间线。标题/状态头由任务详情页
 * 渲染（tasksTab），本组件只承正文；挂载即拉取 track（attempts 全量），
 * 随快照水位（最新事件 seq）回拉。原 S13 shadcn Dialog 抽屉随页面化撤除
 * （零残留）。
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
    void fetch(`/eteams-api/team/${encodeURIComponent(team.teamId)}/task/${task.taskId}/track`, {
      cache: 'no-store',
    })
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
      {task.statusNote !== null && <div className={LINE_CLASS}>状态说明：{task.statusNote}</div>}
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
