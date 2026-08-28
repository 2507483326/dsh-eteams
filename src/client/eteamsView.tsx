/**
 * The 团队 activity panel (docs/13.3, M4 read-only subset): team switcher +
 * four views (概览/成员/任务/动态) + task detail drawer (track route lazy
 * load) + member dialog timeline (dialog route). Read-only — writes land in
 * M5. Renders over host theme variables so light/dark follows the GUI.
 *
 * @module dsh-eteams/client/eteamsView
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { Avatar } from './avatar';
import { PLUGIN_VERSION_LABEL } from './versionLabel';
import {
  relativeTime,
  useActivityMonitor,
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

const STATUS_GROUPS: { id: string; label: string; statuses: string[]; tone: string }[] = [
  { id: 'active', label: '● 执行中', statuses: ['in_progress', 'retrying'], tone: '#2f6fed' },
  { id: 'assigned', label: '◐ 待接取', statuses: ['assigned'], tone: '#2f6fed' },
  { id: 'ready', label: '○ 待指派', statuses: ['ready'], tone: '#8a8f98' },
  {
    id: 'decision',
    label: '△ 待决策',
    statuses: ['awaiting_decision', 'needs_user'],
    tone: '#c78a1d',
  },
  { id: 'paused', label: '◌ 已挂起', statuses: ['paused', 'suspended'], tone: '#c78a1d' },
  { id: 'blocked', label: '⊘ 被阻断', statuses: ['blocked'], tone: '#b3562d' },
  { id: 'completed', label: '✔ 已完成', statuses: ['completed'], tone: '#2e8b57' },
  { id: 'failed', label: '✘ 失败', statuses: ['failed'], tone: '#c04545' },
  { id: 'cancelled', label: '⊘ 已取消', statuses: ['cancelled'], tone: '#8a8f98' },
  { id: 'draft', label: '✎ 草稿', statuses: ['draft'], tone: '#8a8f98' },
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

const styles: Record<string, CSSProperties> = {
  root: {
    height: '100%',
    overflow: 'auto',
    padding: '20px 28px',
    boxSizing: 'border-box',
    fontFamily: 'inherit',
    color: 'var(--dsw-alias-text-primary, inherit)',
  },
  header: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 },
  title: { margin: 0, fontSize: 17, fontWeight: 600 },
  select: {
    padding: '4px 8px',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))',
    background: 'var(--dsw-alias-bg-base, transparent)',
    color: 'inherit',
    fontSize: 13,
  },
  tabs: {
    display: 'flex',
    gap: 2,
    borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))',
    marginBottom: 14,
  },
  card: {
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
    borderRadius: 10,
    padding: '14px 16px',
    marginBottom: 12,
    background: 'var(--dsw-alias-bg-base, transparent)',
  },
  line: { margin: '5px 0', fontSize: 13, lineHeight: 1.6 },
  muted: { opacity: 0.6, fontSize: 12 },
  progressTrack: {
    height: 6,
    borderRadius: 999,
    background: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
    overflow: 'hidden',
    margin: '8px 0',
  },
  memberGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: 10,
  },
  memberCard: {
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
    borderRadius: 10,
    padding: '12px 14px',
  },
  taskRow: {
    padding: '9px 4px',
    borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15))',
    cursor: 'pointer',
  },
  chip: {
    display: 'inline-block',
    padding: '0 7px',
    margin: '0 4px 2px 0',
    borderRadius: 6,
    fontSize: 11,
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
    opacity: 0.85,
  },
  station: { fontSize: 12, opacity: 0.85, marginRight: 6 },
  drawer: {
    background: 'var(--dsw-alias-bg-subtle, rgba(128,128,128,0.06))',
    borderRadius: 8,
    padding: '10px 14px',
    margin: '6px 0 14px',
  },
  attempt: {
    borderLeft: '2px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
    padding: '2px 0 2px 12px',
    margin: '8px 0',
  },
  empty: { textAlign: 'center', padding: '48px 20px', opacity: 0.7 },
  btn: {
    padding: '4px 12px',
    fontSize: 12,
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
    background: 'none',
    color: 'inherit',
    cursor: 'pointer',
  },
  banner: {
    border: '1px solid #c78a1d66',
    background: 'rgba(199,138,29,0.08)',
    borderRadius: 10,
    padding: '10px 14px',
    marginBottom: 12,
    fontSize: 13,
  },
  eventRow: {
    padding: '5px 0',
    borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.12))',
    fontSize: 13,
  },
  dialogItem: {
    padding: '6px 10px',
    borderRadius: 8,
    margin: '4px 0',
    fontSize: 13,
    background: 'var(--dsw-alias-bg-subtle, rgba(128,128,128,0.08))',
  },
};

/** Parameterized style factories (state/phase-toned inline styles). */
const fns = {
  badge: (phase: string): CSSProperties => ({
    display: 'inline-block',
    padding: '1px 9px',
    borderRadius: 999,
    fontSize: 11,
    border: '1px solid',
    borderColor:
      phase === 'running' ? '#2f6fed66' : 'var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
    color: phase === 'running' ? '#2f6fed' : 'inherit',
  }),
  tab: (active: boolean): CSSProperties => ({
    padding: '7px 14px',
    fontSize: 13,
    cursor: 'pointer',
    border: 'none',
    background: 'none',
    color: 'inherit',
    borderBottom: active ? '2px solid var(--dsw-alias-accent, #4b7bec)' : '2px solid transparent',
    opacity: active ? 1 : 0.65,
  }),
  progressFill: (pct: number): CSSProperties => ({
    height: '100%',
    width: `${pct}%`,
    background: 'var(--dsw-alias-accent, #4b7bec)',
    borderRadius: 999,
  }),
  dot: (tone: string): CSSProperties => ({
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: tone,
    marginRight: 6,
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
      `/plugins/dsh-eteams/team/${encodeURIComponent(team.teamId)}/task/${encodeURIComponent(task.taskId)}/track`,
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
              <div style={{ ...styles.line, color: '#c04545' }}>✘ {a.error}</div>
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
      `/plugins/dsh-eteams/team/${encodeURIComponent(team.teamId)}/member/${encodeURIComponent(member.name)}/dialog`,
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
      <div style={{ ...styles.line, fontWeight: 600 }}>
        对话框 · {member.name} <span style={styles.muted}>（只读时间线；发送在 M5 开放）</span>
      </div>
      {items.length === 0 && <div style={styles.muted}>暂无消息记录</div>}
      {items.map((it, i) => (
        <div key={i} style={styles.dialogItem}>
          <span style={styles.muted}>
            [{kindLabel[it.kind] ?? it.kind}] {it.from ?? ''} ·{' '}
          </span>
          {it.text.length > 160 ? `${it.text.slice(0, 160)}…` : it.text}
        </div>
      ))}
    </div>
  );
}

/** The eteams conversation view entry — the M4 activity panel. */
export function ETeamsView(props: ConvViewProps): ReactNode {
  const state = useActivityMonitor();
  const [tab, setTab] = useState<'overview' | 'members' | 'tasks' | 'events'>('overview');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [dialogMember, setDialogMember] = useState<string | null>(null);

  const myTeams = state.teams.filter((t) => t.captainSessionId === props.sessionId);
  const pool = myTeams.length > 0 ? myTeams : state.teams;
  // Derived (no effect): stale/null selection falls back to the first team.
  const team = pool.find((t) => t.teamId === activeId) ?? pool[0];
  const now = state.serverTime || state.fetchedAt;

  return (
    <div style={styles.root} data-eteams="view">
      <div style={styles.header}>
        <h2 style={styles.title}>团队</h2>
        {pool.length > 0 && (
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
        )}
        <span style={styles.muted}>{PLUGIN_VERSION_LABEL}</span>
      </div>

      {team === undefined ? (
        <div style={styles.empty}>
          <p>本会话还没有团队。</p>
          <p style={styles.line}>
            在对话中说「用 AgentTeams 做某事」或 <code>/agent-teams</code>
            ，领队会先问询、再拆解计划等你批准。
          </p>
          <p style={styles.muted}>
            {state.error !== null ? `状态加载失败：${state.error}` : '轮询中…'}
          </p>
        </div>
      ) : (
        <>
          {team.pendingDecisions.length > 0 && (
            <div style={styles.banner}>
              △ {team.pendingDecisions.length} 项待决策：
              {team.pendingDecisions
                .map((d) => `${d.taskId}（${d.error.slice(0, 40)}）`)
                .join('；')}{' '}
              —— 到对话里让领队处理，或等待 M5 的代答操作。
            </div>
          )}
          <div style={styles.tabs}>
            {(
              [
                ['overview', '概览'],
                ['members', '成员'],
                ['tasks', '任务'],
                ['events', '动态'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" style={fns.tab(tab === id)} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>

          {tab === 'overview' && (
            <div>
              <div style={styles.card}>
                <div style={styles.line}>
                  <strong>目标</strong>
                  {team.goal}
                </div>
                <div style={{ ...styles.progressTrack }}>
                  <div
                    style={fns.progressFill(
                      team.progress.total === 0
                        ? 0
                        : (team.progress.completed / team.progress.total) * 100,
                    )}
                  />
                </div>
                <div style={styles.muted}>
                  {team.progress.completed}/{team.progress.total} 完成 · {team.progress.active}{' '}
                  执行中 · {team.members.length} 成员 · {PHASE_LABELS[team.phase] ?? team.phase}
                  {team.planReviewState !== null && team.phase === 'staged'
                    ? ` · 计划${team.planReviewState === 'awaiting_review' ? '待批准' : team.planReviewState}`
                    : ''}
                </div>
                {team.workDir !== null && <div style={styles.muted}>任务文档：{team.workDir}/</div>}
              </div>
              <div style={styles.card}>
                <div style={{ ...styles.line, fontWeight: 600 }}>最近动态</div>
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
              </div>
            </div>
          )}

          {tab === 'members' && (
            <div>
              {dialogMember !== null && (
                <MemberDialog
                  team={team}
                  member={team.members.find((m) => m.name === dialogMember)!}
                />
              )}
              <div style={styles.memberGrid}>
                {team.members.map((m) => {
                  const tone =
                    m.status === 'working' || m.status === 'busy'
                      ? '#2f6fed'
                      : m.status === 'ready' || m.status === 'idle'
                        ? '#2e8b57'
                        : m.status === 'paused'
                          ? '#c78a1d'
                          : '#8a8f98';
                  return (
                    <div key={m.name} style={styles.memberCard}>
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <Avatar name={m.name} />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{m.name}</div>
                          <div style={styles.muted}>
                            {m.role} · {m.model}
                          </div>
                        </div>
                      </div>
                      <div style={{ ...styles.line, fontSize: 12 }}>
                        <span style={fns.dot(tone)} />
                        {m.status}
                        {m.currentTaskId !== null && <span> · {m.currentTaskId} 执行中</span>}
                      </div>
                      <button
                        type="button"
                        style={styles.btn}
                        onClick={() => setDialogMember(dialogMember === m.name ? null : m.name)}
                      >
                        {dialogMember === m.name ? '收起对话框' : '对话记录'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === 'tasks' && (
            <div>
              {STATUS_GROUPS.map((group) => {
                const rows = team.tasks.filter((t) => group.statuses.includes(t.status));
                if (rows.length === 0) return null;
                return (
                  <div key={group.id} style={{ marginBottom: 14 }}>
                    <div style={{ ...styles.line, fontWeight: 600, color: group.tone }}>
                      {group.label}（{rows.length}）
                    </div>
                    {rows.map((t) => (
                      <div key={t.taskId}>
                        <div
                          style={styles.taskRow}
                          onClick={() =>
                            setExpandedTask(expandedTask === t.taskId ? null : t.taskId)
                          }
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
          )}

          {tab === 'events' && (
            <div style={styles.card}>
              {team.latestEvents
                .slice()
                .reverse()
                .map((e) => (
                  <div key={e.seq} style={styles.eventRow}>
                    <span style={styles.muted}>
                      {relativeTime(e.at, now)} · {e.actor} · #{e.seq}
                    </span>
                    <div>{e.text}</div>
                  </div>
                ))}
              {team.latestEvents.length === 0 && <div style={styles.muted}>暂无事件</div>}
            </div>
          )}
        </>
      )}

      <div style={{ ...styles.muted, marginTop: 16 }}>
        {state.error !== null
          ? `状态加载失败：${state.error}`
          : `自动刷新（1s）· 更新于 ${state.fetchedAt === 0 ? '—' : relativeTime(state.fetchedAt, now)}`}
      </div>
    </div>
  );
}
