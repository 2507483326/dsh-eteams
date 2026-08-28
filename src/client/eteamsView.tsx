/**
 * The 团队 activity panel (docs/13.3, M4.5 IA): left rail with 看板/团队/成员/
 * 任务/汇报, member-library-first flow (D16), team creation by name only.
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
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { Avatar } from './avatar';
import { ClientErrorBoundary } from './diagnostics';
import { addTeamMember, createTeamViaPanel, fetchRoster, type RosterMember } from './api';
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
    display: 'flex',
    gap: 14,
    boxSizing: 'border-box',
    padding: '16px 20px',
    fontFamily: 'inherit',
    color: 'var(--dsw-alias-text-primary, inherit)',
  },
  rail: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    width: 76,
    flexShrink: 0,
    borderRight: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))',
    paddingRight: 10,
  },
  content: { flex: 1, minWidth: 0, overflow: 'auto' },
  topbar: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' },
  select: {
    padding: '4px 8px',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))',
    background: 'var(--dsw-alias-bg-base, transparent)',
    color: 'inherit',
    fontSize: 13,
  },
  title: { margin: 0, fontSize: 17, fontWeight: 600 },
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
  formRow: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 },
  formLabel: { fontSize: 12, opacity: 0.7 },
  textarea: {
    width: '100%',
    boxSizing: 'border-box',
    minHeight: 56,
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
    background: 'var(--dsw-alias-bg-base, transparent)',
    color: 'inherit',
    fontSize: 13,
    fontFamily: 'inherit',
    resize: 'vertical',
  },
  formActions: { display: 'flex', gap: 8, justifyContent: 'flex-end' },
  formError: { fontSize: 12, color: '#c04545', margin: '4px 0 8px' },
  addRow: { display: 'flex', justifyContent: 'flex-end', marginBottom: 10 },
};

/** Parameterized style factories (state/phase-toned inline styles). */
const fns = {
  railBtn: (active: boolean): CSSProperties => ({
    display: 'block',
    width: '100%',
    padding: '8px 10px',
    fontSize: 13,
    textAlign: 'left',
    cursor: 'pointer',
    border: 'none',
    borderRadius: 8,
    background: active ? 'var(--dsw-alias-bg-subtle, rgba(128,128,128,0.1))' : 'none',
    color: 'inherit',
    fontWeight: active ? 600 : 400,
    opacity: active ? 1 : 0.7,
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
      <div style={{ ...styles.line, fontWeight: 600 }}>
        汇报记录 · {member.name} <span style={styles.muted}>（只读；直发消息在 M5 开放）</span>
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
          {activeTab === 'roster' && (
            <RosterTab
              team={team}
              roster={roster}
              pool={pool}
              activeTeamId={team?.teamId ?? null}
              onOpenReports={(name) => {
                setDialogMember(name);
                setTab('reports');
              }}
            />
          )}
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
          推荐流程：先到「成员」页把成员加入成员库，再到「团队」页创建团队并把成员拉进去。
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
        <div style={styles.line}>
          <strong>目标</strong>
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
        <div style={styles.muted}>
          数据更新于 {fetchedAt === 0 ? '—' : relativeTime(fetchedAt, now)}
        </div>
      </div>
    </div>
  );
}

/** 团队：创建（仅名称）+ 成员栅格 + 从成员库拉人。 */
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
        <div style={{ ...styles.line, fontWeight: 600 }}>新建团队</div>
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
        <div style={styles.empty}>尚未选择团队。创建后在这里把成员库中的成员拉进团队。</div>
      ) : (
        <>
          <div style={styles.card}>
            <div style={{ ...styles.line, fontWeight: 600 }}>团队成员（{team.members.length}）</div>
            {roster.length > 0 && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                <select
                  style={styles.select}
                  value={pick}
                  onChange={(e) => setPick(e.target.value)}
                >
                  <option value="">— 从成员库选择 —</option>
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
              {team.members.map((m) => (
                <MemberCard key={m.name} member={m} onOpenReports={onOpenReports} />
              ))}
              {team.members.length === 0 && (
                <div style={styles.muted}>还没有成员——先到「成员」页入库，或从上方成员库拉人。</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** One team-member card: seeded avatar + status + optional 汇报入口. */
function MemberCard({
  member: m,
  onOpenReports,
}: {
  member: MemberView;
  onOpenReports?: (name: string) => void;
}): ReactNode {
  const tone =
    m.status === 'working' || m.status === 'busy'
      ? '#2f6fed'
      : m.status === 'ready' || m.status === 'idle'
        ? '#2e8b57'
        : m.status === 'paused'
          ? '#c78a1d'
          : '#8a8f98';
  return (
    <div style={styles.memberCard}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} />
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
      {onOpenReports !== undefined && (
        <button type="button" style={styles.btn} onClick={() => onOpenReports(m.name)}>
          汇报记录
        </button>
      )}
    </div>
  );
}

/** 成员：团队成员一览 + 成员库（对话命令创建 + 加入团队）。 */
function RosterTab({
  team,
  roster,
  pool,
  activeTeamId,
  onOpenReports,
}: {
  team: TeamSnapshot | undefined;
  roster: RosterMember[];
  pool: TeamSnapshot[];
  activeTeamId: string | null;
  onOpenReports: (name: string) => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [duty, setDuty] = useState('');
  const [style, setStyle] = useState('');
  const [skills, setSkills] = useState('');
  const [executionPrompt, setExecutionPrompt] = useState('');
  const [copied, setCopied] = useState(false);

  // 通过对话创建（用户要求）：面板生成命令，用户粘贴到会话里由领队执行
  // eteams_member_save 入库——面板不再直连写成员库。
  const command = [
    '用 eteams_member_save 创建成员库成员：',
    `- 名字：${name.trim()}`,
    `- 角色：${role.trim()}`,
    ...(duty.trim() !== '' ? [`- 职责边界：${duty.trim()}`] : []),
    ...(style.trim() !== '' ? [`- 工作风格：${style.trim()}`] : []),
    ...(skills.trim() !== '' ? [`- 能力：${skills.trim()}`] : []),
    ...(executionPrompt.trim() !== '' ? [`- 执行提示：${executionPrompt.trim()}`] : []),
  ].join('\n');

  const copyCommand = (): void => {
    void writeClipboard(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div>
      <div style={styles.card}>
        <div style={{ ...styles.line, fontWeight: 600 }}>新建成员（存入成员库，D16）</div>
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
          <span style={styles.muted}>
            粘贴到对话发送，领队即创建成员入库；成功后这里会出现新条目。
          </span>
        </div>
        {copied && <div style={{ ...styles.muted, marginTop: 6 }}>✓ 已复制——去对话里粘贴发送</div>}
      </div>

      <div style={styles.card}>
        <div style={{ ...styles.line, fontWeight: 600 }}>
          团队成员（{team?.members.length ?? 0}）
          {team !== undefined && <span style={styles.muted}> · {team.name}</span>}
        </div>
        {team === undefined ? (
          <div style={styles.muted}>尚未选择团队。</div>
        ) : team.members.length === 0 ? (
          <div style={styles.muted}>该团队还没有成员——从下方成员库「加入团队」。</div>
        ) : (
          <div style={styles.memberGrid}>
            {team.members.map((m) => (
              <MemberCard key={m.name} member={m} onOpenReports={onOpenReports} />
            ))}
          </div>
        )}
      </div>

      <div style={styles.card}>
        <div style={{ ...styles.line, fontWeight: 600 }}>成员库（{roster.length}）</div>
        {roster.length === 0 && (
          <div style={styles.muted}>
            成员库为空。先在这里生成命令创建成员，再到「团队」页把它们拉进团队。
          </div>
        )}
        {roster.map((m) => (
          <RosterRow key={m.name} member={m} pool={pool} activeTeamId={activeTeamId} />
        ))}
      </div>
    </div>
  );
}

/** One roster entry with a per-row 加入团队 control. */
function RosterRow({
  member,
  pool,
  activeTeamId,
}: {
  member: RosterMember;
  pool: TeamSnapshot[];
  activeTeamId: string | null;
}): ReactNode {
  const [teamId, setTeamId] = useState<string>(activeTeamId ?? pool[0]?.teamId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (): Promise<void> => {
    if (busy || teamId === '') return;
    setBusy(true);
    setError(null);
    try {
      await addTeamMember(teamId, { name: member.name, fromRoster: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...styles.eventRow, display: 'flex', alignItems: 'center', gap: 8 }}>
      <Avatar name={member.name} seed={member.avatar?.seed} salt={member.avatar?.salt} size={30} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>{member.name}</strong>
        <span style={styles.muted}> · {member.role}</span>
        {member.skills !== undefined && member.skills !== '' && (
          <div style={{ ...styles.muted, fontSize: 11 }}>{member.skills.slice(0, 60)}</div>
        )}
        {error !== null && <div style={styles.formError}>{error}</div>}
      </div>
      <select style={styles.select} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
        <option value="">— 选择团队 —</option>
        {pool.map((t) => (
          <option key={t.teamId} value={t.teamId}>
            {t.name}
          </option>
        ))}
      </select>
      <Button size="sm" disabled={busy || teamId === ''} onClick={() => void add()}>
        加入团队
      </Button>
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
            <div style={{ ...styles.line, fontWeight: 600, color: group.tone }}>
              {group.label}（{rows.length}）
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
