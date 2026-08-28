/**
 * The 团队 activity panel (docs/13.3, M4.5 IA): left rail with 看板/团队/成员/
 * 任务/汇报, members-first flow (D16), team creation by name only.
 * Renders over host theme variables so light/dark follows the GUI.
 *
 * @module dsh-eteams/client/eteamsView
 */
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import {
  Button,
  Input,
  IconPlusOutline16,
  MarkdownText,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { Avatar } from './avatar';
import { ClientErrorBoundary } from './diagnostics';
import { addTeamMember, createTeamViaPanel, fetchRoster, type RosterMember } from './api';
import {
  relativeTime,
  useActivityMonitor,
  type CaptainView,
  type MemberView,
  type TaskView,
  type TeamSnapshot,
} from './monitor';

const PHASE_LABELS: Record<string, string> = {
  staged: '草案',
  running: '运行中',
  paused: '已暂停',
  halted: '已停止',
  completed: '已完成',
  archived: '已归档',
};

const STATUS_GROUPS: { id: string; label: string; statuses: string[]; tone: Tone }[] = [
  { id: 'active', label: '执行中', statuses: ['in_progress', 'retrying'], tone: 'info' },
  { id: 'assigned', label: '待接取', statuses: ['assigned'], tone: 'info' },
  { id: 'ready', label: '待指派', statuses: ['ready'], tone: 'muted' },
  {
    id: 'decision',
    label: '待决策',
    statuses: ['awaiting_decision', 'needs_user'],
    tone: 'warn',
  },
  { id: 'paused', label: '已挂起', statuses: ['paused', 'suspended'], tone: 'warn' },
  { id: 'blocked', label: '被阻断', statuses: ['blocked'], tone: 'err' },
  { id: 'completed', label: '已完成', statuses: ['completed'], tone: 'ok' },
  { id: 'failed', label: '失败', statuses: ['failed'], tone: 'err' },
  { id: 'cancelled', label: '已取消', statuses: ['cancelled'], tone: 'muted' },
  { id: 'draft', label: '草稿', statuses: ['draft'], tone: 'muted' },
];

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  ready: '待指派',
  assigned: '待接取',
  in_progress: '执行中',
  retrying: '重试中',
  paused: '已挂起',
  awaiting_decision: '待决策',
  needs_user: '待用户',
  suspended: '已暂停',
  blocked: '被阻断',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/**
 * Design tokens — UI-Designer pass (docs/13 13.x): host theme aliases first
 * with safe fallbacks, one source of truth for the whole panel. Light/dark
 * follows the GUI because every color resolves through --dsw-alias-*.
 */
const T = {
  bg: 'var(--dsw-alias-bg-base, #f6f7f9)',
  surface: 'var(--dsw-alias-bg-layer-1, #ffffff)',
  sunken: 'var(--dsw-alias-bg-layer-2, #edf0f4)',
  border: 'var(--dsw-alias-border-l1, rgba(100,116,139,0.14))',
  border2: 'var(--dsw-alias-border-l2, rgba(100,116,139,0.26))',
  text: 'var(--dsw-alias-label-primary, #1c2430)',
  text2: 'var(--dsw-alias-label-secondary, #47546c)',
  text3: 'var(--dsw-alias-label-tertiary, #808da4)',
  accent: 'var(--dsw-alias-brand-primary, #4b7bec)',
  accentSoft: 'var(--dsw-alias-interactive-bg-active, rgba(75,123,236,0.12))',
  onAccent: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
  hover: 'var(--dsw-alias-interactive-bg-hover, rgba(100,116,139,0.08))',
  ok: 'var(--dsw-alias-state-success-primary, #15803d)',
  okBg: 'var(--dsw-alias-state-success-secondary, rgba(21,128,61,0.1))',
  warn: 'var(--dsw-alias-state-warn-primary, #b45309)',
  warnBg: 'var(--dsw-alias-state-warn-secondary, rgba(180,83,9,0.1))',
  err: 'var(--dsw-alias-state-error-primary, #b91c1c)',
  errBg: 'var(--dsw-alias-state-error-secondary, rgba(185,28,28,0.1))',
  info: 'var(--dsw-alias-state-business-primary, #1d4ed8)',
  infoBg: 'rgba(29,78,216,0.1)',
  shadow: '0 1px 2px rgba(15,23,42,0.05), 0 6px 18px rgba(15,23,42,0.06)',
} as const;

/** Semantic tone — every status color flows through these five buckets. */
type Tone = 'info' | 'ok' | 'warn' | 'err' | 'muted';
const TONE_FG: Record<Tone, string> = {
  info: T.info,
  ok: T.ok,
  warn: T.warn,
  err: T.err,
  muted: T.text3,
};
const TONE_BG: Record<Tone, string> = {
  info: T.infoBg,
  ok: T.okBg,
  warn: T.warnBg,
  err: T.errBg,
  muted: T.sunken,
};

function taskTone(status: string): Tone {
  if (status === 'in_progress' || status === 'retrying' || status === 'assigned') return 'info';
  if (status === 'completed') return 'ok';
  if (
    status === 'awaiting_decision' ||
    status === 'needs_user' ||
    status === 'paused' ||
    status === 'suspended'
  )
    return 'warn';
  if (status === 'blocked' || status === 'failed') return 'err';
  return 'muted';
}

function memberTone(status: string): Tone {
  if (status === 'working' || status === 'busy') return 'info';
  if (status === 'ready' || status === 'idle' || status === 'done') return 'ok';
  if (status === 'paused') return 'warn';
  if (status === 'failed' || status === 'error') return 'err';
  return 'muted';
}

const styles: Record<string, CSSProperties> = {
  root: {
    height: '100%',
    display: 'flex',
    gap: 16,
    boxSizing: 'border-box',
    padding: '14px 18px',
    fontFamily: 'inherit',
    fontSize: 13,
    lineHeight: 1.55,
    color: T.text,
  },
  rail: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    width: 84,
    flexShrink: 0,
    borderRight: `1px solid ${T.border}`,
    paddingRight: 12,
    paddingTop: 2,
  },
  content: { flex: 1, minWidth: 0, overflowY: 'auto', paddingRight: 2 },
  topbar: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' },
  select: {
    padding: '5px 10px',
    borderRadius: 8,
    border: `1px solid ${T.border2}`,
    background: T.surface,
    color: T.text,
    fontSize: 12,
    fontWeight: 500,
  },
  title: { margin: 0, fontSize: 16, fontWeight: 700, letterSpacing: 0.2 },
  card: {
    border: `1px solid ${T.border}`,
    borderRadius: 12,
    padding: '14px 16px',
    marginBottom: 12,
    background: T.surface,
    boxShadow: '0 1px 2px rgba(15,23,42,0.03)',
  },
  sectionTitle: {
    margin: '0 0 8px',
    fontSize: 11,
    fontWeight: 600,
    color: T.text3,
    letterSpacing: 0.5,
  },
  line: { margin: '4px 0', fontSize: 13, lineHeight: 1.6, color: T.text2 },
  muted: { fontSize: 12, color: T.text3 },
  progressTrack: {
    height: 6,
    borderRadius: 999,
    background: T.sunken,
    overflow: 'hidden',
    margin: '10px 0 6px',
  },
  memberGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
    gap: 10,
  },
  memberCard: {
    border: `1px solid ${T.border}`,
    borderRadius: 12,
    padding: 12,
    background: T.surface,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  memberRow: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '9px 10px',
    borderRadius: 10,
    border: '1px solid transparent',
    background: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    color: T.text,
  },
  roleChip: {
    display: 'inline-block',
    padding: '2px 9px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 600,
    background: T.accentSoft,
    color: T.accent,
  },
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '2px 9px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 500,
    width: 'fit-content',
  },
  detailRow: {
    display: 'flex',
    gap: 10,
    padding: '7px 0',
    fontSize: 12,
    lineHeight: 1.55,
    borderBottom: `1px solid ${T.border}`,
  },
  detailLabel: {
    width: 64,
    flexShrink: 0,
    fontSize: 11,
    fontWeight: 600,
    color: T.text3,
    paddingTop: 1,
  },
  taskRow: {
    padding: '10px 8px',
    borderBottom: `1px solid ${T.border}`,
    borderRadius: 8,
    cursor: 'pointer',
  },
  chip: {
    display: 'inline-block',
    padding: '1px 7px',
    margin: '0 4px 2px 0',
    borderRadius: 6,
    fontSize: 11,
    background: T.sunken,
    color: T.text2,
  },
  station: { fontSize: 12, color: T.text3, marginRight: 6 },
  drawer: {
    background: T.sunken,
    border: `1px solid ${T.border}`,
    borderRadius: 10,
    padding: '12px 14px',
    margin: '8px 0 14px',
  },
  attempt: {
    borderLeft: `2px solid ${T.border2}`,
    padding: '2px 0 2px 12px',
    margin: '10px 0',
  },
  empty: {
    textAlign: 'center',
    padding: '36px 20px',
    color: T.text3,
    border: `1px dashed ${T.border2}`,
    borderRadius: 12,
    background: 'transparent',
  },
  btn: {
    padding: '5px 12px',
    fontSize: 12,
    borderRadius: 8,
    border: `1px solid ${T.border2}`,
    background: T.surface,
    color: T.text2,
    cursor: 'pointer',
    fontWeight: 500,
  },
  banner: {
    border: `1px solid ${T.warn}`,
    background: T.warnBg,
    borderRadius: 12,
    padding: '10px 14px',
    marginBottom: 12,
    fontSize: 13,
    color: T.text,
  },
  eventRow: {
    padding: '7px 0',
    borderBottom: `1px solid ${T.border}`,
    fontSize: 13,
    color: T.text2,
  },
  dialogItem: {
    padding: '7px 10px',
    borderRadius: 8,
    margin: '4px 0',
    fontSize: 12.5,
    background: T.surface,
    border: `1px solid ${T.border}`,
    color: T.text2,
  },
  formRow: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 10 },
  formLabel: { fontSize: 11, fontWeight: 600, color: T.text3, letterSpacing: 0.3 },
  textarea: {
    width: '100%',
    boxSizing: 'border-box',
    minHeight: 56,
    padding: '7px 10px',
    borderRadius: 8,
    border: `1px solid ${T.border2}`,
    background: T.surface,
    color: T.text,
    fontSize: 12.5,
    fontFamily: 'inherit',
    lineHeight: 1.5,
    resize: 'vertical',
  },
  formActions: { display: 'flex', gap: 8, justifyContent: 'flex-end' },
  formError: { fontSize: 12, color: T.err, margin: '4px 0 8px' },
  addRow: { display: 'flex', justifyContent: 'flex-end', marginBottom: 10 },
};

/** Parameterized style factories (tone-mapped, token-driven). */
const fns = {
  railBtn: (active: boolean): CSSProperties => ({
    display: 'block',
    width: '100%',
    padding: '7px 10px',
    fontSize: 12,
    textAlign: 'left',
    cursor: 'pointer',
    border: 'none',
    borderRadius: 8,
    background: active ? T.accentSoft : 'transparent',
    color: active ? T.accent : T.text2,
    fontWeight: active ? 600 : 500,
    letterSpacing: 0.2,
  }),
  progressFill: (pct: number): CSSProperties => ({
    height: '100%',
    width: `${pct}%`,
    background: `linear-gradient(90deg, ${T.accent}, ${T.info})`,
    borderRadius: 999,
  }),
  pill: (tone: Tone): CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '2px 9px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 500,
    width: 'fit-content',
    color: TONE_FG[tone],
    background: TONE_BG[tone],
  }),
  dot: (tone: Tone): CSSProperties => ({
    display: 'inline-block',
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: TONE_FG[tone],
    flexShrink: 0,
  }),
};

function TaskStations({ task }: { task: TaskView }): ReactNode {
  if (task.chainLength === 0) return null;
  return (
    <div style={{ marginTop: 3 }}>
      {task.chain.map((s, i) => (
        <span key={i} style={styles.station}>
          {s.stationStatus === 'done' ? '✔' : s.stationStatus === 'current' ? '●' : '◌'} {s.member}
          {i < task.chain.length - 1 ? ' →' : ''}
        </span>
      ))}
      <span style={styles.muted}>
        {' '}
        站点 {Math.min(task.chainCursor + 1, task.chainLength)}/{task.chainLength}
      </span>
    </div>
  );
}

function TaskDrawer({
  team,
  task,
  now,
}: {
  team: TeamSnapshot;
  task: TaskView;
  now: number;
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
    <div style={styles.drawer}>
      {task.outcome !== null && <div style={styles.line}>产出：{task.outcome}</div>}
      {(track?.attempts ?? [])
        .slice()
        .reverse()
        .map((a) => (
          <div key={a.id} style={styles.attempt}>
            <div style={styles.line}>
              <strong>{a.id}</strong> · {a.kind} · {a.member} ·{' '}
              {STATUS_LABELS[a.status] ?? a.status}
              <span style={styles.muted}>
                {' '}
                {a.claimedAt ? relativeTime(a.claimedAt, now) : ''}
                {a.endedAt ? `–${relativeTime(a.endedAt, now)}` : ''}
              </span>
            </div>
            {(a.progress ?? []).map((p, i) => (
              <div key={i} style={{ ...styles.line, ...styles.muted }}>
                {relativeTime(p.at, now)} {p.text}
              </div>
            ))}
            {a.error !== undefined && (
              <div style={{ ...styles.line, color: T.err }}>✘ {a.error}</div>
            )}
            {a.result?.output !== undefined && <div style={styles.muted}>✔ {a.result.output}</div>}
          </div>
        ))}
      {track === null && <div style={styles.muted}>执行线路加载中…</div>}
    </div>
  );
}

function MemberDialog({ team, member }: { team: TeamSnapshot; member: MemberView }): ReactNode {
  const [items, setItems] = useState<{ at: number; kind: string; text: string; from?: string }[]>(
    [],
  );
  useEffect(() => {
    let alive = true;
    void fetch(
      `/eteams-api/team/${encodeURIComponent(team.teamId)}/member/${encodeURIComponent(member.name)}/dialog`,
      { cache: 'no-store' },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (alive && body !== null) setItems(body.items ?? []);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [team.teamId, team.version, member.name]);
  const kindLabel: Record<string, string> = {
    assignment: '指派',
    report: '汇报',
    question: '提问',
    notice: '通知',
    user_message: '用户',
    progress: '进度',
  };
  return (
    <div style={styles.drawer}>
      <div style={{ ...styles.sectionTitle, fontSize: 12, color: T.text2 }}>
        汇报记录 · {member.name}
        <span style={styles.muted}>（只读；直发消息在 M5 开放）</span>
      </div>
      {items.length === 0 && <div style={styles.muted}>暂无消息记录</div>}
      {items.map((it, i) => (
        <div key={i} style={styles.dialogItem}>
          <span style={{ ...styles.muted, color: T.text3 }}>
            [{kindLabel[it.kind] ?? it.kind}] {it.from ?? ''} ·{' '}
          </span>
          {it.text.length > 160 ? `${it.text.slice(0, 160)}…` : it.text}
        </div>
      ))}
    </div>
  );
}

/** The eteams conversation view entry — the M4.5 activity panel. */
export function ETeamsView(props: ConvViewProps): ReactNode {
  const state = useActivityMonitor();
  const [tab, setTab] = useState<'board' | 'team' | 'roster' | 'tasks' | 'reports'>('board');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [dialogMember, setDialogMember] = useState<string | null>(null);
  const [roster, setRoster] = useState<RosterMember[]>([]);

  const myTeams = state.teams.filter((t) => t.captainSessionId === props.sessionId);
  const pool = myTeams.length > 0 ? myTeams : state.teams;
  // Derived (no effect): stale/null selection falls back to the first team.
  const team = pool.find((t) => t.teamId === activeId) ?? pool[0];
  const now = state.serverTime || state.fetchedAt;
  const tabs: { id: 'board' | 'team' | 'roster' | 'tasks' | 'reports'; label: string }[] = [
    { id: 'board', label: '看板' },
    { id: 'team', label: '团队' },
    { id: 'roster', label: '成员' },
    { id: 'tasks', label: '任务' },
    { id: 'reports', label: '汇报' },
  ];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : 'board';
  // Dialog target resolved defensively: a vanished member must not crash render.
  const dialogMemberView =
    dialogMember === null || team === undefined
      ? null
      : (team.members.find((m) => m.name === dialogMember) ?? null);

  const refreshRoster = useCallback((): void => {
    void fetchRoster()
      .then(setRoster)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (activeTab === 'roster' || activeTab === 'team') refreshRoster();
  }, [activeTab, refreshRoster]);

  return (
    <ClientErrorBoundary label="团队面板">
      <div style={styles.root} data-eteams="view">
        <div style={styles.rail}>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              style={fns.railBtn(activeTab === t.id)}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={styles.content}>
          <div style={styles.topbar}>
            {pool.length > 0 ? (
              <select
                style={styles.select}
                value={team?.teamId ?? ''}
                onChange={(e) => setActiveId(e.target.value)}
              >
                {pool.map((t) => (
                  <option key={t.teamId} value={t.teamId}>
                    {t.name}（{PHASE_LABELS[t.phase] ?? t.phase} {t.progress.completed}/
                    {t.progress.total}）
                  </option>
                ))}
              </select>
            ) : (
              <span style={styles.title}>团队</span>
            )}
            <span style={{ ...styles.muted, marginLeft: 'auto' }}>
              {state.error !== null
                ? `状态加载失败：${state.error}`
                : `自动刷新（1s）· 更新于 ${
                    state.fetchedAt === 0 ? '—' : relativeTime(state.fetchedAt, now)
                  }`}
            </span>
          </div>

          {activeTab === 'board' && (
            <BoardTab team={team} now={now} fetchedAt={state.fetchedAt} error={state.error} />
          )}
          {activeTab === 'team' && (
            <TeamTab
              sessionId={props.sessionId}
              team={team}
              roster={roster}
              onOpenReports={(name) => {
                setDialogMember(name);
                setTab('reports');
              }}
            />
          )}
          {activeTab === 'roster' && <MembersTab members={roster} pool={pool} team={team} />}
          {activeTab === 'tasks' && team !== undefined && (
            <TasksTab
              team={team}
              now={now}
              expandedTask={expandedTask}
              setExpandedTask={setExpandedTask}
            />
          )}
          {activeTab === 'reports' && team !== undefined && (
            <ReportsTab
              team={team}
              dialogMember={dialogMember}
              setDialogMember={setDialogMember}
              member={dialogMemberView}
            />
          )}
        </div>
      </div>
    </ClientErrorBoundary>
  );
}

/** 看板：目标、进度与最近动态（原「概览」）。 */
function BoardTab({
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
      <div style={styles.empty}>
        <p>还没有团队。</p>
        <p style={styles.line}>
          推荐流程：先到「成员」页新增成员，再到「团队」页创建团队并把成员拉进去。
        </p>
        <p style={styles.line}>
          也可以在对话中说「用 AgentTeams 做某事」或 <code>/agent-teams</code>
          ，领队会先问询、再拆解计划等你批准。
        </p>
        <p style={styles.muted}>{error !== null ? `状态加载失败：${error}` : '尚未创建团队'}</p>
      </div>
    );
  }
  return (
    <div>
      {team.pendingDecisions.length > 0 && (
        <div style={styles.banner}>
          △ {team.pendingDecisions.length} 项待决策：
          {team.pendingDecisions.map((d) => `${d.taskId}（${d.error.slice(0, 40)}）`).join('；')} ——
          到对话里让领队处理，或等待 M5 的代答操作。
        </div>
      )}
      <div style={styles.card}>
        <div style={styles.sectionTitle}>目标</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.text, lineHeight: 1.5 }}>
          {team.goal}
        </div>
        <div style={{ ...styles.progressTrack }}>
          <div
            style={fns.progressFill(
              team.progress.total === 0 ? 0 : (team.progress.completed / team.progress.total) * 100,
            )}
          />
        </div>
        <div style={styles.muted}>
          {team.progress.completed}/{team.progress.total} 完成 · {team.progress.active} 执行中 ·{' '}
          {team.members.length} 成员 · {PHASE_LABELS[team.phase] ?? team.phase}
          {team.planReviewState !== null && team.phase === 'staged'
            ? ` · 计划${team.planReviewState === 'awaiting_review' ? '待批准' : team.planReviewState}`
            : ''}
        </div>
        {team.workDir !== null && <div style={styles.muted}>任务文档：{team.workDir}/</div>}
      </div>
      <div style={styles.card}>
        <div style={styles.sectionTitle}>最近动态</div>
        {team.latestEvents
          .slice(-8)
          .reverse()
          .map((e) => (
            <div key={e.seq} style={styles.eventRow}>
              <span style={styles.muted}>
                {relativeTime(e.at, now)} · {e.actor}
              </span>{' '}
              {e.text}
            </div>
          ))}
        {team.latestEvents.length === 0 && <div style={styles.muted}>暂无事件</div>}
        <div style={styles.muted}>
          数据更新于 {fetchedAt === 0 ? '—' : relativeTime(fetchedAt, now)}
        </div>
      </div>
    </div>
  );
}

/** 团队：创建（仅名称）+ 组建团队（成员栅格 + 从成员列表拉人）。 */
function TeamTab({
  sessionId,
  team,
  roster,
  onOpenReports,
}: {
  sessionId: string;
  team: TeamSnapshot | undefined;
  roster: RosterMember[];
  onOpenReports: (name: string) => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (): Promise<void> => {
    if (busy || name.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await createTeamViaPanel(sessionId, name.trim());
      setName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addFromRoster = async (): Promise<void> => {
    if (busy || team === undefined || pick === '') return;
    setBusy(true);
    setError(null);
    try {
      await addTeamMember(team.teamId, { name: pick, fromRoster: true });
      setPick('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={styles.card}>
        <div style={styles.sectionTitle}>新建团队</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Input
            value={name}
            placeholder="团队名称，如：文档迁移小组"
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            size="sm"
            variant="primary"
            icon={<IconPlusOutline16 />}
            disabled={busy || name.trim() === ''}
            onClick={() => void create()}
          >
            创建
          </Button>
        </div>
        <div style={styles.muted}>只需名称即可创建（草案阶段）；目标可在看板中与领队继续完善。</div>
        {error !== null && <div style={styles.formError}>{error}</div>}
      </div>

      {team === undefined ? (
        <div style={styles.empty}>尚未选择团队。创建团队后在这里从「成员」列表拉人组队。</div>
      ) : (
        <>
          <div style={styles.card}>
            <div style={styles.sectionTitle}>团队成员（{team.members.length}）</div>
            {roster.length > 0 && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                <select
                  style={styles.select}
                  value={pick}
                  onChange={(e) => setPick(e.target.value)}
                >
                  <option value="">— 从成员列表选择 —</option>
                  {roster
                    .filter((m) => !team.members.some((t) => t.name === m.name))
                    .map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}（{m.role}）
                      </option>
                    ))}
                </select>
                <Button
                  size="sm"
                  disabled={busy || pick === ''}
                  onClick={() => void addFromRoster()}
                >
                  拉进团队
                </Button>
              </div>
            )}
            <div style={styles.memberGrid}>
              <LeaderCard captain={team.captain} />
              {team.members.map((m) => (
                <MemberCard key={m.name} member={m} onOpenReports={onOpenReports} />
              ))}
              {team.members.length === 0 && (
                <div style={styles.muted}>
                  还没有成员——先到「成员」页新增，或从上方成员列表拉人。
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** The 领队（项目牧羊人）leader card — expands into its Markdown 手册. */
function LeaderCard({ captain }: { captain: CaptainView }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ ...styles.memberCard, gridColumn: '1 / -1' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Avatar name={captain.name} seed={captain.avatar.seed} salt={captain.avatar.salt} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 13, color: T.text }}>{captain.name}</span>
            <span style={styles.roleChip}>领队</span>
          </div>
          <div style={{ ...styles.muted, marginTop: 1 }}>
            {captain.role} · 不接任务：负责拆解、指派与调度
          </div>
        </div>
        {captain.personaMd !== null && (
          <button type="button" style={styles.btn} onClick={() => setOpen(!open)}>
            {open ? '收起手册' : '查看手册'}
          </button>
        )}
      </div>
      {open && captain.personaMd !== null && (
        <div style={{ marginTop: 10, borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
          <MarkdownText text={captain.personaMd} />
        </div>
      )}
    </div>
  );
}

/** One team-member card: seeded avatar + status pill + optional 汇报入口. */
function MemberCard({
  member: m,
  onOpenReports,
}: {
  member: MemberView;
  onOpenReports?: (name: string) => void;
}): ReactNode {
  const tone = memberTone(m.status);
  return (
    <div style={styles.memberCard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: T.text }}>{m.name}</div>
          <div style={{ ...styles.muted, marginTop: 1 }}>
            {m.role} · {m.model}
          </div>
        </div>
      </div>
      <div style={fns.pill(tone)}>
        <span style={fns.dot(tone)} />
        {STATUS_LABELS[m.status] ?? m.status}
        {m.currentTaskId !== null && <span style={{ fontWeight: 400 }}>· {m.currentTaskId}</span>}
      </div>
      {onOpenReports !== undefined && (
        <button type="button" style={styles.btn} onClick={() => onOpenReports(m.name)}>
          汇报记录
        </button>
      )}
    </div>
  );
}

/** 成员：全体成员（先有员工，再组建团队）——列表 / 新增 / 详情。 */
function MembersTab({
  members,
  pool,
  team,
}: {
  members: RosterMember[];
  pool: TeamSnapshot[];
  team: TeamSnapshot | undefined;
}): ReactNode {
  const [view, setView] = useState<'list' | 'add' | 'detail'>('list');
  const [detailName, setDetailName] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [duty, setDuty] = useState('');
  const [style, setStyle] = useState('');
  const [skills, setSkills] = useState('');
  const [executionPrompt, setExecutionPrompt] = useState('');
  const [personaMd, setPersonaMd] = useState('');
  const [copied, setCopied] = useState(false);

  // 通过对话创建（用户要求）：面板生成命令，用户粘贴到会话里由领队执行
  // eteams_member_save 入库——面板不直连写成员。personaMd（完整角色手册）
  // 以 Markdown 围栏附在命令尾部，由领队原样作为 personaMd 参数传入。
  const command = [
    '用 eteams_member_save 创建成员：',
    `- 名字：${name.trim()}`,
    `- 角色：${role.trim()}`,
    ...(duty.trim() !== '' ? [`- 职责边界：${duty.trim()}`] : []),
    ...(style.trim() !== '' ? [`- 工作风格：${style.trim()}`] : []),
    ...(skills.trim() !== '' ? [`- 能力：${skills.trim()}`] : []),
    ...(executionPrompt.trim() !== '' ? [`- 执行提示：${executionPrompt.trim()}`] : []),
    ...(personaMd.trim() !== ''
      ? [
          '- 人设手册：把下面围栏内的 Markdown 原文作为 personaMd 参数传入',
          '',
          '```eteams-persona-md',
          personaMd.trim(),
          '```',
        ]
      : []),
  ].join('\n');

  const copyCommand = (): void => {
    void writeClipboard(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // 该成员已加入的团队（按当前可见团队池计算）。
  const teamsOf = (memberName: string): string[] =>
    pool.filter((t) => t.members.some((mm) => mm.name === memberName)).map((t) => t.name);

  const detail = members.find((m) => m.name === detailName) ?? null;
  const detailMemberView =
    detail === null ? null : (team?.members.find((m) => m.name === detail.name) ?? null);

  if (view === 'add') {
    return (
      <div>
        <Button size="sm" onClick={() => setView('list')}>
          ← 返回成员列表
        </Button>
        <div style={{ ...styles.card, marginTop: 8 }}>
          <div style={{ ...styles.line, fontWeight: 600 }}>新增成员</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <Input
              value={name}
              placeholder="成员名，如：alice"
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              value={role}
              placeholder="角色：前端开发者 / 后端架构师 / UI 设计师 / 趣味注入师 / researcher / …"
              onChange={(e) => setRole(e.target.value)}
            />
          </div>
          <details>
            <summary style={{ cursor: 'pointer', ...styles.muted }}>可选：人设细节</summary>
            <div style={{ ...styles.formRow, marginTop: 8 }}>
              <span style={styles.formLabel}>职责边界</span>
              <textarea
                style={styles.textarea}
                value={duty}
                onChange={(e) => setDuty(e.target.value)}
              />
            </div>
            <div style={styles.formRow}>
              <span style={styles.formLabel}>工作风格</span>
              <textarea
                style={styles.textarea}
                value={style}
                onChange={(e) => setStyle(e.target.value)}
              />
            </div>
            <div style={styles.formRow}>
              <span style={styles.formLabel}>能力</span>
              <textarea
                style={styles.textarea}
                value={skills}
                onChange={(e) => setSkills(e.target.value)}
              />
            </div>
            <div style={styles.formRow}>
              <span style={styles.formLabel}>执行提示</span>
              <textarea
                style={styles.textarea}
                value={executionPrompt}
                onChange={(e) => setExecutionPrompt(e.target.value)}
              />
            </div>
            <div style={styles.formRow}>
              <span style={styles.formLabel}>
                角色手册（可选，Markdown：使命/职责/规则/交付标准）
              </span>
              <textarea
                style={{ ...styles.textarea, minHeight: 90 }}
                value={personaMd}
                onChange={(e) => setPersonaMd(e.target.value)}
              />
            </div>
          </details>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
            <Button
              size="sm"
              variant="primary"
              icon={<IconPlusOutline16 />}
              disabled={name.trim() === '' || role.trim() === ''}
              onClick={copyCommand}
            >
              复制对话命令
            </Button>
            <span style={styles.muted}>粘贴到对话发送，领队即创建成员；成功后列表会出现。</span>
          </div>
          {copied && (
            <div style={{ ...styles.muted, marginTop: 6 }}>✓ 已复制——去对话里粘贴发送</div>
          )}
        </div>
      </div>
    );
  }

  if (view === 'detail' && detail !== null) {
    const teamNames = teamsOf(detail.name);
    return (
      <div>
        <button type="button" style={styles.btn} onClick={() => setView('list')}>
          ← 返回成员列表
        </button>
        <div style={{ ...styles.card, marginTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Avatar
              name={detail.name}
              seed={detail.avatar?.seed}
              salt={detail.avatar?.salt}
              size={48}
            />
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{detail.name}</div>
              <div style={{ marginTop: 4 }}>
                <span style={styles.roleChip}>{detail.role}</span>
              </div>
            </div>
          </div>
        </div>
        <div style={styles.card}>
          <div style={styles.sectionTitle}>人设摘要（D13）</div>
          {(
            [
              ['职责边界', detail.duty],
              ['工作风格', detail.style],
              ['能力', detail.skills],
              ['执行提示', detail.executionPrompt],
            ] as const
          ).map(([label, value]) => (
            <div key={label} style={styles.detailRow}>
              <span style={styles.detailLabel}>{label}</span>
              <span style={{ ...styles.muted, ...(value?.trim() ? { color: T.text2 } : {}) }}>
                {value?.trim() || '未填写'}
              </span>
            </div>
          ))}
        </div>
        {detail.personaMd !== undefined && detail.personaMd.trim() !== '' && (
          <div style={styles.card}>
            <div style={styles.sectionTitle}>角色手册（Markdown）</div>
            <MarkdownText text={detail.personaMd} />
          </div>
        )}
        <div style={styles.card}>
          <div style={styles.sectionTitle}>所属团队（{teamNames.length}）</div>
          {teamNames.length === 0 ? (
            <div style={styles.muted}>尚未加入任何团队——到「团队」页创建团队后从成员列表拉人。</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {teamNames.map((n) => (
                <span key={n} style={styles.chip}>
                  {n}
                </span>
              ))}
            </div>
          )}
        </div>
        {team !== undefined && detailMemberView !== null && (
          <MemberDialog team={team} member={detailMemberView} />
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={styles.card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div style={{ ...styles.sectionTitle, flex: 1, margin: 0 }}>成员（{members.length}）</div>
          <Button
            size="sm"
            variant="primary"
            icon={<IconPlusOutline16 />}
            onClick={() => setView('add')}
          >
            新增成员
          </Button>
        </div>
        {members.length === 0 && (
          <div style={styles.empty}>
            还没有成员。先「新增成员」（生成对话命令由领队创建），再到「团队」页组建团队。
          </div>
        )}
        {members.map((m) => {
          const teamNames = teamsOf(m.name);
          return (
            <button
              key={m.name}
              type="button"
              style={styles.memberRow}
              onClick={() => {
                setDetailName(m.name);
                setView('detail');
              }}
            >
              <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} size={32} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>
                  {m.name}
                  <span style={{ ...styles.muted, fontWeight: 400 }}> · {m.role}</span>
                </div>
                <div style={{ ...styles.muted, fontSize: 11, marginTop: 1 }}>
                  {teamNames.length === 0 ? '尚未加入团队' : `加入团队：${teamNames.join('、')}`}
                </div>
              </div>
              <span style={{ color: T.text3, fontSize: 14 }}>›</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 任务：按状态分组的任务清单（原「任务」）。 */
function TasksTab({
  team,
  now,
  expandedTask,
  setExpandedTask,
}: {
  team: TeamSnapshot;
  now: number;
  expandedTask: string | null;
  setExpandedTask: (id: string | null) => void;
}): ReactNode {
  return (
    <div>
      {STATUS_GROUPS.map((group) => {
        const rows = team.tasks.filter((t) => group.statuses.includes(t.status));
        if (rows.length === 0) return null;
        return (
          <div key={group.id} style={{ marginBottom: 14 }}>
            <div style={{ ...styles.sectionTitle, marginBottom: 4 }}>
              <span style={fns.pill(group.tone)}>
                <span style={fns.dot(group.tone)} />
                {group.label} · {rows.length}
              </span>
            </div>
            {rows.map((t) => (
              <div key={t.taskId}>
                <div
                  style={styles.taskRow}
                  onClick={() => setExpandedTask(expandedTask === t.taskId ? null : t.taskId)}
                >
                  <div>
                    <strong>{t.taskId}</strong> {t.subject}
                    <span style={styles.muted}>
                      {' '}
                      {STATUS_LABELS[t.status] ?? t.status}
                      {t.retryCount > 0 ? ` · ⟳${t.retryCount}` : ''}
                      {t.assignee !== null ? ` · ${t.assignee}` : ''}
                    </span>
                  </div>
                  <TaskStations task={t} />
                  {t.dependencies.length > 0 && (
                    <div style={{ marginTop: 3 }}>
                      {t.dependencies.map((d) => (
                        <span key={d} style={styles.chip}>
                          依赖 {d}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {expandedTask === t.taskId && <TaskDrawer team={team} task={t} now={now} />}
              </div>
            ))}
          </div>
        );
      })}
      {team.tasks.length === 0 && (
        <div style={styles.empty}>还没有任务。计划批准后任务会出现在这里。</div>
      )}
    </div>
  );
}

/** 汇报：成员选择 + 汇报时间线（原「对话」，D15 只读）。 */
function ReportsTab({
  team,
  dialogMember,
  setDialogMember,
  member,
}: {
  team: TeamSnapshot;
  dialogMember: string | null;
  setDialogMember: (name: string | null) => void;
  member: MemberView | null;
}): ReactNode {
  return (
    <div>
      <div style={{ ...styles.formRow, maxWidth: 320 }}>
        <span style={styles.formLabel}>选择成员</span>
        <select
          style={styles.select}
          value={dialogMember ?? ''}
          onChange={(e) => setDialogMember(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">— 选择 —</option>
          {team.members.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}（{m.role}）
            </option>
          ))}
        </select>
      </div>
      {member === null ? (
        <div style={styles.muted}>选择一个成员查看对话时间线。</div>
      ) : (
        <MemberDialog team={team} member={member} />
      )}
    </div>
  );
}
