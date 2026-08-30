/**
 * The 团队 activity panel (docs/13.3, M4.5 IA): left rail with 看板/团队/角色/
 * 任务/汇报, members-first flow (D16), team creation by name only.
 * Renders over host theme variables so light/dark follows the GUI.
 *
 * @module dsh-eteams/client/eteamsView
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import {
  Button,
  Input,
  IconCheckOutline16,
  IconPlusOutline16,
  IconSparkle16,
  MarkdownText,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { ADD_PEOPLE_TEMPLATE, prefillComposer, type PrefillOutcome } from './addPeople';
import { Avatar } from './avatar';
import {
  activateConversationTab,
  consumePendingGotoAdd,
  consumePendingGotoAddTeam,
  consumePendingGotoRoster,
  consumePendingSelectTeam,
  GOTO_ADD_EVENT,
  GOTO_ADD_TEAM_EVENT,
  GOTO_ROSTER_EVENT,
  SELECT_TEAM_EVENT,
} from './bridge';
import { ClientErrorBoundary } from './diagnostics';
import { MdEditor } from './mdEditor';
import {
  addTeamMember,
  cancelBuild,
  confirmBuild,
  createTeamViaPanel,
  deleteRosterMember,
  fetchAgentActivity,
  fetchBuildState,
  fetchRoster,
  removeTeamMember,
  resumeBuild,
  saveRosterMember,
  submitInterview,
  type BuildDraft,
  type BuildSession,
  type InterviewQuestion,
  type RosterMember,
} from './api';
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
export { PHASE_LABELS };

/** The leader is a member too — default-joined, undeletable (用户定稿模型). */
const LEADER_NAME = '项目牧羊人';
/** The role-builder persona is a system member as well: undeletable,
 * listed right under the leader (用户反馈：角色构建师不能删除). */
const ROLE_BUILDER_NAME = '角色构建师';
/** Members the panel never offers a delete button for (host enforces too). */
const PROTECTED_MEMBERS: readonly string[] = [LEADER_NAME, ROLE_BUILDER_NAME];

/** Sort rank: leader first, role builder second, everyone else after. */
function memberRank(name: string): number {
  if (name === LEADER_NAME) return 0;
  if (name === ROLE_BUILDER_NAME) return 1;
  return 2;
}

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
export { T };

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
    /* 横向滚动条治理（用户反馈）：任何内部溢出都在这里截断，绝不外溢
    到宿主页面/整页团队页；滚动只发生在 content 列内。 */
    overflow: 'hidden',
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
  content: {
    flex: 1,
    minWidth: 0,
    overflowY: 'auto',
    /* 竖向滚动条出现会挤压可用宽度，宽子元素随之横向外溢——这里一并截断
    （用户反馈：内容变高后出现横向滚动条）。 */
    overflowX: 'hidden',
    paddingRight: 2,
  },
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
    minWidth: 0,
  },
  sectionTitle: {
    margin: '0 0 8px',
    fontSize: 11,
    fontWeight: 600,
    color: T.text3,
    letterSpacing: 0.5,
  },
  line: { margin: '4px 0', fontSize: 13, lineHeight: 1.6, color: T.text2 },
  muted: { fontSize: 12, color: T.text3, overflowWrap: 'anywhere' },
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
  buildStep: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '3px 0',
    fontSize: 12.5,
  },
  prefillBanner: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '10px 12px',
    borderRadius: 10,
    background: T.infoBg,
    border: `1px solid ${T.border}`,
    marginTop: 10,
  },
  cmdChip: {
    marginTop: 8,
    padding: '9px 11px',
    borderRadius: 8,
    background: T.sunken,
    border: `1px solid ${T.border}`,
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.7,
    color: T.text2,
    wordBreak: 'break-all',
  },
  stepRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 8,
    fontSize: 12.5,
    lineHeight: 1.55,
    color: T.text2,
  },
  stepNum: {
    flexShrink: 0,
    width: 18,
    height: 18,
    borderRadius: 999,
    background: T.accentSoft,
    color: T.accent,
    fontSize: 11,
    fontWeight: 600,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
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
  // 成员子代理活动点（docs/20.4 P4）：childId → running/inactive。旧运行时
  // 无 listChildren 时返回空表——面板不渲染点，不误导。
  const [agentActivity, setAgentActivity] = useState<Record<string, string>>({});
  // 创建卡片/弹层跳转信号（docs/19.9.5）：递增计数驱动 MembersTab 打开新增页。
  const [openAddTick, setOpenAddTick] = useState(0);
  useEffect(() => {
    const h = (): void => {
      // 已挂载路径由窗口事件处理；顺带消费 pending 标记，防止标记滞留到
      // 下一次挂载时把用户误拽回创建页（docs/19.16）。
      consumePendingGotoAdd();
      setTab('roster');
      setOpenAddTick((t) => t + 1);
    };
    // 「新增团队」信号：落到团队 tab（新建表单就在那里）。
    const hTeam = (): void => {
      consumePendingGotoAddTeam();
      setTab('team');
    };
    // 「成员 tab」信号（按钮成员选中直达，docs/13.8.2）：落成员页，不带新增表单。
    const hRoster = (): void => {
      consumePendingGotoRoster();
      setTab('roster');
    };
    // 选中某个团队（弹层团队行点击）：board 视图随选择联动。
    const hSelect = (event?: Event): void => {
      const id =
        event === undefined ? consumePendingSelectTeam() : (event as CustomEvent<string>).detail;
      if (typeof id === 'string' && id !== '') setActiveId(id);
    };
    window.addEventListener(GOTO_ADD_EVENT, h);
    window.addEventListener(GOTO_ADD_TEAM_EVENT, hTeam);
    window.addEventListener(GOTO_ROSTER_EVENT, hRoster);
    window.addEventListener(SELECT_TEAM_EVENT, hSelect);
    // 补消费挂载前的跳转信号：跳转方先点宿主 tab 再触发本面板
    // 挂载，窗口事件会错过——pending 标记在这里兜底（docs/19.16）。
    if (consumePendingGotoAdd()) h();
    if (consumePendingGotoAddTeam()) hTeam();
    if (consumePendingGotoRoster()) hRoster();
    hSelect();
    return () => {
      window.removeEventListener(GOTO_ADD_EVENT, h);
      window.removeEventListener(GOTO_ADD_TEAM_EVENT, hTeam);
      window.removeEventListener(GOTO_ROSTER_EVENT, hRoster);
      window.removeEventListener(SELECT_TEAM_EVENT, hSelect);
    };
  }, []);

  const myTeams = state.teams.filter((t) => t.captainSessionId === props.sessionId);
  const pool = myTeams.length > 0 ? myTeams : state.teams;
  // Derived (no effect): stale/null selection falls back to the first team.
  const team = pool.find((t) => t.teamId === activeId) ?? pool[0];
  const now = state.serverTime || state.fetchedAt;
  const tabs: { id: 'board' | 'team' | 'roster' | 'tasks' | 'reports'; label: string }[] = [
    { id: 'board', label: '看板' },
    { id: 'team', label: '团队' },
    { id: 'roster', label: '角色' },
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

  // 活动点轮询：跟随当前选中的团队，3s 节流（docs/20.4 P4）。
  useEffect(() => {
    if (team === undefined) return;
    let alive = true;
    const pull = (): void => {
      void fetchAgentActivity(team.teamId)
        .then((a) => {
          if (alive) setAgentActivity(a);
        })
        .catch(() => undefined);
    };
    pull();
    const h = setInterval(pull, 3000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [team]);

  // 一键预填（docs/19.7.1, D18-1）：共享 helper（addPeople.ts）把命令写入
  // 对话输入框并聚焦；inputActions 不可用时退化为剪贴板复制。不自动发送。
  const prefillAddPeople = useCallback((): PrefillOutcome => {
    const actions = (props as { inputActions?: { setDraft: (text: string) => void } })
      .inputActions;
    return prefillComposer(actions);
  }, [props]);

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
                : `更新于 ${state.fetchedAt === 0 ? '—' : relativeTime(state.fetchedAt, now)}`}
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
              agentActivity={agentActivity}
              onOpenReports={(name) => {
                setDialogMember(name);
                setTab('reports');
              }}
            />
          )}
          {activeTab === 'roster' && (
            <MembersTab
              members={roster}
              pool={pool}
              team={team}
              onDeleted={refreshRoster}
              onPrefillAddPeople={prefillAddPeople}
              openAddTick={openAddTick}
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
          推荐流程：先到「角色」页新增角色，再到「团队」页创建团队并把角色拉进去。
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

/** 团队：创建（仅名称）+ 组建团队（成员栅格 + 从角色列表拉人）。 */
function TeamTab({
  sessionId,
  team,
  roster,
  agentActivity,
  onOpenReports,
}: {
  /** Current session id; undefined on the overlay panel (no session yet). */
  sessionId: string | undefined;
  team: TeamSnapshot | undefined;
  roster: RosterMember[];
  /** Member subagent activity dots (docs/20.4 P4): childId → running/inactive. */
  agentActivity: Record<string, string>;
  onOpenReports: (name: string) => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 面板创建团队绑定当前会话（领队即该会话代理）；浮层/无会话时没有可绑定的
  // 会话，创建按钮禁用并给出指引，而不是提交后吃 400 错误。
  const canCreate = typeof sessionId === 'string' && sessionId !== '';

  const create = async (): Promise<void> => {
    if (busy || !canCreate || name.trim() === '') return;
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
            disabled={busy || !canCreate || name.trim() === ''}
            onClick={() => void create()}
          >
            创建
          </Button>
        </div>
        <div style={styles.muted}>
          {canCreate
            ? '只需名称即可创建（草案阶段）；目标可在看板中与领队继续完善。'
            : '当前还没有进行中的对话——开始对话后即可在这里创建团队。'}
        </div>
        {error !== null && <div style={styles.formError}>{error}</div>}
      </div>

      {team === undefined ? (
        <div style={styles.empty}>尚未选择团队。创建团队后在这里从「角色」列表拉人组队。</div>
      ) : (
        <>
          <div style={styles.card}>
            <div style={styles.sectionTitle}>
              团队成员（{team.members.length}）· 领队默认在团，不可移出
            </div>
            {roster.length > 0 && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                <select
                  style={styles.select}
                  value={pick}
                  onChange={(e) => setPick(e.target.value)}
                >
                  <option value="">— 从角色列表选择 —</option>
                  {roster
                    .filter(
                      (m) => m.name !== LEADER_NAME && !team.members.some((t) => t.name === m.name),
                    )
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
                <MemberCard
                  key={m.name}
                  member={m}
                  activity={m.childId !== null ? agentActivity[m.childId] : undefined}
                  onOpenReports={onOpenReports}
                  onRemove={(memberName) => {
                    void removeTeamMember(team.teamId, memberName).catch(() => undefined);
                  }}
                />
              ))}
              {team.members.length === 0 && (
                <div style={styles.muted}>
                  还没有角色——先到「角色」页新增，或从上方角色列表拉人。
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

/** One team-member card: seeded avatar + status pill + 移出团队（领队不可移出）. */
function MemberCard({
  member: m,
  activity,
  onOpenReports,
  onRemove,
}: {
  member: MemberView;
  /** Subagent activity (docs/20.4 P4): 'running' | 'inactive' | undefined. */
  activity?: string;
  onOpenReports?: (name: string) => void;
  onRemove?: (name: string) => void;
}): ReactNode {
  const tone = memberTone(m.status);
  return (
    <div style={styles.memberCard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontWeight: 600,
              fontSize: 13,
              color: T.text,
            }}
          >
            {activity !== undefined && (
              <span
                title={activity === 'running' ? '子代理运行中' : '子代理已完结'}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: activity === 'running' ? T.ok : T.text3,
                  boxShadow: activity === 'running' ? `0 0 0 3px ${T.okBg}` : 'none',
                }}
              />
            )}
            {m.name}
          </div>
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
      <div style={{ display: 'flex', gap: 6 }}>
        {onOpenReports !== undefined && (
          <button type="button" style={styles.btn} onClick={() => onOpenReports(m.name)}>
            汇报记录
          </button>
        )}
        {onRemove !== undefined && (
          <button
            type="button"
            style={{ ...styles.btn, color: T.err }}
            onClick={() => onRemove(m.name)}
          >
            移出团队
          </button>
        )}
      </div>
    </div>
  );
}

/** 构建步骤时间线（docs/19.6.2）——与角色构建师的 eteams_build_report 播报约定一致。 */
const BUILD_STEPS = [
  '收到需求',
  '查重角色库',
  '意图访谈',
  '起草统一手册',
  '深化领域章节',
  '完成草稿',
] as const;

/** Editable draft form state (待确认态). */
interface DraftEdit {
  name: string;
  role: string;
  duty: string;
  style: string;
  skills: string;
  executionPrompt: string;
  personaMd: string;
  rulesText: string;
}

const EMPTY_EDIT: DraftEdit = {
  name: '',
  role: '',
  duty: '',
  style: '',
  skills: '',
  executionPrompt: '',
  personaMd: '',
  rulesText: '',
};

function fromBuildDraft(d: BuildDraft): DraftEdit {
  return {
    name: d.name,
    role: d.role,
    duty: d.duty ?? '',
    style: d.style ?? '',
    skills: d.skills ?? '',
    executionPrompt: d.executionPrompt ?? '',
    personaMd: d.personaMd ?? '',
    rulesText: (d.rules ?? []).join('\n'),
  };
}

/** 预填命令芯片：占位符以品牌色高亮，一眼看出要改哪里。 */
function CommandChip({ text }: { text: string }): ReactNode {
  const parts = text.split(/(【成员名称】|【职责】)/g);
  return (
    <div style={styles.cmdChip}>
      {parts.map((p, i) =>
        p === '【成员名称】' || p === '【职责】' ? (
          <span key={i} style={{ color: T.accent, fontWeight: 600 }}>
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </div>
  );
}

/** 预填引导三步（空闲态展示）。 */
const PREFILL_STEPS = [
  '在对话输入框补全两个【】占位符——可顺手追加能力、风格等期望',
  '回车发送，角色构建师立刻接手（预填行直接回车同样生效）',
  '回到这里实时看构建；草稿就绪后可修改，点「确认入库」完成',
] as const;

/** 构建中草稿只读预览（docs/19.6.2）：字段渐次呈现，不可编辑。 */
function DraftPreview({ draft }: { draft: BuildDraft }): ReactNode {
  const rows: [string, string][] = [
    ['角色名', draft.name],
    ['角色', draft.role],
    ['职责边界', draft.duty ?? ''],
    ['工作风格', draft.style ?? ''],
    ['能力', draft.skills ?? ''],
    ['工作纪律', (draft.rules ?? []).join('；')],
    ['执行提示', draft.executionPrompt ?? ''],
  ];
  return (
    <div style={{ ...styles.card, marginTop: 8, padding: 10 }}>
      <div style={styles.sectionTitle}>草稿预览（构建中，待确认后可编辑）</div>
      {rows.map(([label, value]) => (
        <div key={label} style={styles.detailRow}>
          <span style={styles.detailLabel}>{label}</span>
          <span style={{ ...styles.muted, ...(value.trim() !== '' ? { color: T.text2 } : {}) }}>
            {value.trim() !== '' ? value : '…'}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 角色（用户反馈：成员更名角色，不再需要标签）：角色库全体条目（先有角色，再组建团队）——列表 / 构建工作台 / 详情。 */
/**
 * Synthesize a handbook skeleton from the legacy structured fields so nothing
 * is lost when the user first edits a member that predates personaMd (the
 * digest fields themselves are no longer shown — everything lives in the
 * handbook now, 用户反馈 2026-09).
 */
function handbookSeed(member: RosterMember): string {
  if (typeof member.personaMd === 'string' && member.personaMd.trim() !== '') {
    return member.personaMd;
  }
  const lines = [`# ${member.name}`, '', `- **角色**：${member.role}`];
  const fields: [string, string | undefined][] = [
    ['职责边界', member.duty],
    ['工作风格', member.style],
    ['能力', member.skills],
    ['执行提示', member.executionPrompt],
  ];
  for (const [label, value] of fields) {
    if (typeof value === 'string' && value.trim() !== '') lines.push(`- **${label}**：${value.trim()}`);
  }
  if (Array.isArray(member.rules) && member.rules.length > 0) {
    lines.push('', '## 工作纪律', ...member.rules.filter((r) => r.trim() !== '').map((r) => `- ${r}`));
  }
  lines.push('', '## 交付标准', '- （待补充）');
  return lines.join('\n');
}

/**
 * The role detail handbook (用户反馈：去掉人设摘要，全部提炼到角色手册；
 * 详情默认只读渲染，点「编辑」进编辑态，保存/取消收尾). Full member upsert
 * on save — the host replaces the whole entry, so every current field is
 * re-sent with the new handbook. Always read-only for the leader (host
 * rejects leader upserts, 保留名).
 */
function HandbookEditor({
  member,
  readOnly,
  onSaved,
}: {
  member: RosterMember;
  readOnly: boolean;
  onSaved: () => void;
}): ReactNode {
  // draft === null → read-only Markdown view; string → editing buffer.
  // Seeded from the CURRENT member on every edit entry, so a roster reload
  // (post-save) is always what a new edit starts from.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const display = handbookSeed(member);

  const save = (): void => {
    if (draft === null) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    saveRosterMember({
      name: member.name,
      role: member.role,
      ...(member.duty !== undefined ? { duty: member.duty } : {}),
      ...(member.style !== undefined ? { style: member.style } : {}),
      ...(member.skills !== undefined ? { skills: member.skills } : {}),
      ...(Array.isArray(member.rules) ? { rules: member.rules } : {}),
      ...(member.executionPrompt !== undefined ? { executionPrompt: member.executionPrompt } : {}),
      ...(member.provider !== undefined ? { provider: member.provider } : {}),
      ...(member.model !== undefined ? { model: member.model } : {}),
      ...(member.reasoningEffort !== undefined
        ? { reasoningEffort: member.reasoningEffort }
        : {}),
      ...(member.avatar !== undefined ? { avatar: member.avatar } : {}),
      personaMd: draft,
    })
      .then(() => {
        setSaved(true);
        setDraft(null);
        setTimeout(() => setSaved(false), 2500);
        onSaved();
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setSaving(false));
  };

  return (
    <div style={styles.card}>
      <div style={{ ...styles.sectionTitle, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1 }}>角色手册（Markdown）</span>
        {readOnly ? (
          <span style={styles.muted}>领队为保留角色，手册不可在此修改</span>
        ) : draft === null ? (
          <Button size="sm" variant="ghost" onClick={() => setDraft(display)}>
            编辑
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => setDraft(null)}
            >
              取消
            </Button>
            <Button size="sm" variant="primary" disabled={saving} onClick={save}>
              保存
            </Button>
          </>
        )}
      </div>
      {draft === null ? (
        <>
          <MarkdownText text={display} />
          {saved && <div style={{ ...styles.muted, marginTop: 4 }}>✓ 已保存</div>}
        </>
      ) : (
        <>
          <textarea
            style={{ ...styles.textarea, minHeight: 220, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
          />
          {error !== null && <div style={styles.formError}>保存失败：{error}</div>}
        </>
      )}
    </div>
  );
}

function MembersTab({
  members,
  pool,
  team,
  onDeleted,
  onPrefillAddPeople,
  openAddTick,
}: {
  members: RosterMember[];
  pool: TeamSnapshot[];
  team: TeamSnapshot | undefined;
  onDeleted: () => void;
  onPrefillAddPeople: () => 'set' | 'copied' | 'aborted';
  /** 创建卡片跳转信号：>0 时打开新增工作台（docs/19.9.5）。 */
  openAddTick: number;
}): ReactNode {
  const [view, setView] = useState<'list' | 'add' | 'detail'>('list');
  const [detailName, setDetailName] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [personaMd, setPersonaMd] = useState('');
  const [copied, setCopied] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  // 角色列表搜索 + 分页（用户反馈）：按名字/角色字段过滤，每页 8 条。
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const MEMBER_PAGE_SIZE = 8;
  const filtered = members.filter((m) => {
    const q = query.trim().toLowerCase();
    if (q === '') return true;
    return m.name.toLowerCase().includes(q) || m.role.toLowerCase().includes(q);
  });
  const sortedMembers = [...filtered].sort((a, b) => memberRank(a.name) - memberRank(b.name));
  const totalPages = Math.max(1, Math.ceil(sortedMembers.length / MEMBER_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = sortedMembers.slice(safePage * MEMBER_PAGE_SIZE, (safePage + 1) * MEMBER_PAGE_SIZE);

  // 构建会话（docs/19.6.2, D18-5）：轮询 /eteams-api/rolebuilder；以 startedAt
  // 为会话键去重自动跳转（用户手动离开后不反复强拉，状态再迁移才再次跳转）。
  const [build, setBuild] = useState<BuildSession | null>(null);
  const [justFilled, setJustFilled] = useState(false);
  const [draftEdit, setDraftEdit] = useState<DraftEdit>(EMPTY_EDIT);
  const [confirming, setConfirming] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const seenSessionRef = useRef(0);
  const seenReviewRef = useRef(0);
  const draftInitRef = useRef(0);

  const refreshBuild = useCallback((): void => {
    void fetchBuildState()
      .then((s) => {
        setBuild(s);
        if (s === null) return;
        if (s.startedAt !== seenSessionRef.current) {
          seenSessionRef.current = s.startedAt;
          // 新会话不再强制跳创建页（docs/19.16）：发送时刻由对话卡片负责
          // openMemberBuilder——这里强跳会把用户每次回面板都拽进 add 视图，
          // 导致「构建时进不去对话/看板」。
        }
        if (s.status === 'awaiting_confirmation' && seenReviewRef.current !== s.startedAt) {
          seenReviewRef.current = s.startedAt;
          setView('add');
        }
        // 待确认草稿到达/刷新时重置编辑表单（对话里继续调整 → 表单跟着刷新）。
        if (
          s.status === 'awaiting_confirmation' &&
          s.draft !== null &&
          s.updatedAt !== draftInitRef.current
        ) {
          draftInitRef.current = s.updatedAt;
          setDraftEdit(fromBuildDraft(s.draft));
        }
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refreshBuild();
    const h = setInterval(refreshBuild, 1500);
    return () => clearInterval(h);
  }, [refreshBuild]);

  // 创建卡片跳转（docs/19.9.5）：信号递增时打开新增工作台。
  const lastAddTickRef = useRef(0);
  useEffect(() => {
    if (openAddTick > 0 && openAddTick !== lastAddTickRef.current) {
      lastAddTickRef.current = openAddTick;
      setView('add');
    }
  }, [openAddTick]);

  // 删除角色（用户反馈）：先弹确认框；失败信息显式上报。领队与角色构建师
  // 为保留角色，面板不给删除按钮（宿主同样拒删）。
  const del = (memberName: string): void => {
    if (!window.confirm(`确定删除角色「${memberName}」？删除后不可恢复。`)) return;
    setListError(null);
    deleteRosterMember(memberName)
      .then(() => onDeleted())
      .catch((e: unknown) => {
        setListError(e instanceof Error ? e.message : String(e));
      });
  };

  // 确认入库（D18-6 主路径）：修改后的草稿经 POST /rolebuilder/confirm 由
  // 宿主落库 roster 并翻转会话状态；确认前零落库。
  const confirmDraft = async (): Promise<void> => {
    setConfirming(true);
    setFormError(null);
    try {
      await confirmBuild({
        name: draftEdit.name.trim(),
        role: draftEdit.role.trim(),
        duty: draftEdit.duty,
        style: draftEdit.style,
        skills: draftEdit.skills,
        rules: draftEdit.rulesText
          .split('\n')
          .map((r) => r.trim())
          .filter((r) => r !== ''),
        executionPrompt: draftEdit.executionPrompt,
        personaMd: draftEdit.personaMd,
        ...(build !== null && build.draft?.avatar !== undefined
          ? { avatar: build.draft.avatar }
          : {}),
      });
      onDeleted();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setConfirming(false);
      refreshBuild();
    }
  };

  const abandon = async (): Promise<void> => {
    setConfirming(true);
    await cancelBuild().catch(() => undefined);
    setConfirming(false);
    refreshBuild();
  };

  // 继续构建（docs/19.16）：会话文件保存完整上下文（步骤/草稿/需求），
  // 宿主恢复会话并唤醒后台构建代理，从中断处接着跑。
  const resume = async (): Promise<void> => {
    setConfirming(true);
    await resumeBuild().catch(() => undefined);
    setConfirming(false);
    refreshBuild();
  };

  // 意图访谈作答（docs/19.16）：后台构建代理把问题写进会话，工作台渲染为
  // 选项问卷；提交后宿主把答案经 followup 发回代理继续构建。
  const [interviewPick, setInterviewPick] = useState<Record<string, string[]>>({});
  const togglePick = (id: string, label: string, multi: boolean): void => {
    setInterviewPick((prev) => {
      const cur = prev[id] ?? [];
      if (cur.includes(label)) {
        return { ...prev, [id]: cur.filter((x) => x !== label) };
      }
      return { ...prev, [id]: multi ? [...cur, label] : [label] };
    });
  };
  const submitInterviewAnswers = async (questions: InterviewQuestion[]): Promise<void> => {
    const answers = questions
      .map((q) => ({ id: q.id, choice: (interviewPick[q.id] ?? []).join('、') }))
      .filter((a) => a.choice !== '');
    if (answers.length === 0) return;
    setConfirming(true);
    await submitInterview(answers).catch(() => undefined);
    setConfirming(false);
    refreshBuild();
  };

  // 通过对话创建（用户要求）：面板生成命令，用户粘贴到会话里由领队执行
  // eteams_member_save 入库——面板不直连写成员。personaMd（完整角色手册）
  // 以 Markdown 围栏附在命令尾部，由领队原样作为 personaMd 参数传入。
  // 手册原文自带 ``` 代码块时用更长的围栏包裹，避免嵌套断裂。
  const maxBacktickRun = personaMd.match(/`{3,}/g)?.reduce((m, f) => Math.max(m, f.length), 0) ?? 0;
  const mdFence = '`'.repeat(Math.max(3, maxBacktickRun + 1));
  // 全部提炼到角色手册（用户反馈）：结构化字段不再单独收集，人设内容只走
  // personaMd 全文。
  const command = [
    '用 eteams_member_save 创建角色：',
    `- 名字：${name.trim()}`,
    `- 角色：${role.trim()}`,
    ...(personaMd.trim() !== ''
      ? [
          '- 人设手册：把下面围栏内的 Markdown 原文作为 personaMd 参数传入',
          '',
          `${mdFence}eteams-persona-md`,
          personaMd.trim(),
          mdFence,
        ]
      : []),
  ].join('\n');

  const copyCommand = (): void => {
    void writeClipboard(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // 该角色已加入的团队（按当前可见团队池计算）。
  const teamsOf = (memberName: string): string[] =>
    pool.filter((t) => t.members.some((mm) => mm.name === memberName)).map((t) => t.name);

  const detail = members.find((m) => m.name === detailName) ?? null;
  const detailMemberView =
    detail === null ? null : (team?.members.find((m) => m.name === detail.name) ?? null);

  if (view === 'add') {
    // 闭包内无法从外层条件继承窄化，这里先固化已入库草稿。
    const confirmedDraft = build !== null && build.status === 'confirmed' ? build.draft : null;
    return (
      <div style={{ overflowX: 'hidden', minWidth: 0 }}>
        <style>{'@keyframes eteams-spin{to{transform:rotate(360deg)}}'}</style>
        <Button size="sm" onClick={() => setView('list')}>
          ← 返回角色列表
        </Button>
        <Button
          size="sm"
          style={{ marginLeft: 6 }}
          onClick={() => activateConversationTab()}
          title="切到会话的对话视图，看命令卡片与进度行"
        >
          💬 对话页看进度
        </Button>
        <div style={{ ...styles.card, marginTop: 8 }}>
          {build !== null && build.status === 'active' && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {build.draft?.avatar !== undefined ? (
                  <Avatar
                    name={build.draft.name}
                    seed={build.draft.avatar.seed}
                    salt={build.draft.avatar.salt}
                    size={30}
                  />
                ) : (
                  <span
                    style={{
                      color: T.accent,
                      display: 'inline-flex',
                      animation: 'eteams-spin 1s linear infinite',
                    }}
                  >
                    <IconSparkle16 />
                  </span>
                )}
                <div style={{ ...styles.line, fontWeight: 600, margin: 0 }}>
                  {build.draft?.name !== undefined && build.draft.name !== ''
                    ? `角色构建师工作中 · ${build.draft.name}…`
                    : '角色构建师工作中…'}
                </div>
                <span style={fns.pill('info')}>构建中</span>
                <span style={{ flex: 1 }} />
                {/* 构建中也能放弃（docs/19.16）：作废会话并中断后台构建代理。 */}
                <Button size="sm" disabled={confirming} onClick={() => void abandon()}>
                  放弃
                </Button>
              </div>
              {build.interview !== undefined && build.interview.answers === undefined && (
                // 意图访谈问卷（docs/19.16）：后台代理的问题在这里作答，
                // 提交后宿主把答案发回代理继续构建。
                <div
                  style={{
                    border: `1px solid ${T.accent}`,
                    borderRadius: 10,
                    padding: '10px 12px',
                    margin: '10px 0 4px',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13 }}>✍️ 意图访谈——请作答</div>
                  <div style={styles.muted}>后台构建代理在等你的答案，提交后它继续起草。</div>
                  {build.interview.questions.map((q) => {
                    const picked = interviewPick[q.id] ?? [];
                    const done = picked.length > 0;
                    return (
                      <div key={q.id} style={{ marginTop: 10 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                          {q.question}
                          {!done && <span style={{ color: T.accent }}> ·</span>}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 5 }}>
                          {q.options.map((o) => {
                            const active = picked.includes(o.label);
                            return (
                              <button
                                key={o.label}
                                type="button"
                                onClick={() => togglePick(q.id, o.label, q.multi === true)}
                                style={{
                                  textAlign: 'left',
                                  padding: '5px 9px',
                                  borderRadius: 8,
                                  border: `1px solid ${active ? T.accent : T.border}`,
                                  background: active
                                    ? 'var(--dsw-alias-interactive-bg-active, rgba(75,123,236,0.12))'
                                    : 'transparent',
                                  color: 'inherit',
                                  cursor: 'pointer',
                                  fontSize: 12,
                                  lineHeight: 1.5,
                                }}
                              >
                                <div style={{ fontWeight: active ? 600 : 400 }}>{o.label}</div>
                                {o.description !== undefined && o.description !== '' && (
                                  <div style={styles.muted}>{o.description}</div>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={
                        confirming ||
                        build.interview.questions.some(
                          (q) => (interviewPick[q.id] ?? []).length === 0,
                        )
                      }
                      onClick={() => void submitInterviewAnswers(build.interview?.questions ?? [])}
                    >
                      提交回答
                    </Button>
                    <span style={styles.muted}>提交后构建代理自动继续。</span>
                  </div>
                </div>
              )}
              <div style={{ margin: '10px 0 4px' }}>
                {BUILD_STEPS.map((s) => {
                  const done = build.stepsDone.includes(s);
                  const current = !done && build.step === s;
                  const tone: Tone = done ? 'ok' : current ? 'info' : 'muted';
                  return (
                    <div key={s} style={styles.buildStep}>
                      <span style={{ color: TONE_FG[tone], fontWeight: 600 }}>
                        {done ? '✔' : current ? '●' : '◌'}
                      </span>
                      <span style={{ color: done || current ? T.text2 : T.text3 }}>{s}</span>
                      {current && <span style={styles.muted}>进行中…</span>}
                    </div>
                  );
                })}
              </div>
              {build.note !== '' && <div style={styles.muted}>{build.note}</div>}
              {build.request !== '' && (
                <div style={{ ...styles.muted, marginTop: 4 }}>需求：{build.request}</div>
              )}
              {build.draft !== null && <DraftPreview draft={build.draft} />}
            </div>
          )}
          {build !== null &&
            build.status === 'awaiting_confirmation' &&
            build.draft !== null && (
              <div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    ...styles.line,
                    fontWeight: 600,
                  }}
                >
                  {build.draft.avatar !== undefined && (
                    <Avatar
                      name={draftEdit.name.trim() !== '' ? draftEdit.name.trim() : build.draft.name}
                      seed={build.draft.avatar.seed}
                      salt={build.draft.avatar.salt}
                      size={30}
                    />
                  )}
                  草稿已就绪——可直接修改，确认后入库
                </div>
                {formError !== null && <div style={styles.formError}>{formError}</div>}
                <div style={{ ...styles.formRow, marginTop: 8 }}>
                  <span style={styles.formLabel}>角色名</span>
                  <Input
                    value={draftEdit.name}
                    onChange={(e) => setDraftEdit({ ...draftEdit, name: e.target.value })}
                  />
                </div>
                <div style={styles.formRow}>
                  <span style={styles.formLabel}>角色</span>
                  <Input
                    value={draftEdit.role}
                    onChange={(e) => setDraftEdit({ ...draftEdit, role: e.target.value })}
                  />
                </div>
                <div style={styles.formRow}>
                  <span style={styles.formLabel}>
                    人设手册（统一 Markdown：frontmatter + 身份/使命/规则/领域专章/沟通风格）
                  </span>
                  <MdEditor
                    value={draftEdit.personaMd}
                    onChange={(next) => setDraftEdit({ ...draftEdit, personaMd: next })}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<IconPlusOutline16 />}
                    disabled={
                      confirming || draftEdit.name.trim() === '' || draftEdit.role.trim() === ''
                    }
                    onClick={() => void confirmDraft()}
                  >
                    确认入库
                  </Button>
                  <Button size="sm" disabled={confirming} onClick={() => void abandon()}>
                    放弃
                  </Button>
                  <span style={styles.muted}>也可以在对话里继续调整，这里会跟着刷新。</span>
                </div>
              </div>
            )}
          {confirmedDraft !== null && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: T.ok, display: 'inline-flex' }}>
                  <IconCheckOutline16 />
                </span>
                <div style={{ ...styles.line, fontWeight: 600, margin: 0 }}>已入库</div>
                <span style={fns.pill('ok')}>角色列表已更新</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <Avatar name={confirmedDraft.name} size={40} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: T.text }}>
                    {confirmedDraft.name}
                  </div>
                  <div style={styles.muted}>
                    {confirmedDraft.role} · 已加入角色列表，到「团队」页拉进团队即可使用。
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <Button
                  size="sm"
                  onClick={() => {
                    setDetailName(confirmedDraft.name);
                    setView('detail');
                  }}
                >
                  查看角色详情
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    if (onPrefillAddPeople() === 'set') setJustFilled(true);
                  }}
                >
                  再建一个
                </Button>
              </div>
            </div>
          )}
          {build !== null && build.status === 'cancelled' && (
            // 已放弃的构建：上下文（步骤/草稿/需求）都保存在会话里，
            // 「继续构建」唤醒后台代理从中断处接着跑（docs/19.16）。
            <div style={{ ...styles.card, marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ ...styles.line, fontWeight: 600, margin: 0 }}>已放弃本次构建</div>
                <span style={fns.pill('muted')}>已中断</span>
              </div>
              {build.note !== '' && <div style={styles.muted}>{build.note}</div>}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={confirming}
                  onClick={() => void resume()}
                >
                  继续构建
                </Button>
                <span style={styles.muted}>上下文已保存——从中断处接着跑，不用从头再来。</span>
              </div>
            </div>
          )}
          {(build === null || build.status === 'cancelled') && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: T.accent, display: 'inline-flex' }}>
                  <IconSparkle16 />
                </span>
                <div style={{ ...styles.line, fontWeight: 600 }}>新增角色 · 角色构建师</div>
                <span style={fns.pill('info')}>对话式构建</span>
              </div>
              {justFilled ? (
                <div>
                  <div style={styles.prefillBanner}>
                    <span style={{ color: T.info, fontWeight: 600, fontSize: 12.5 }}>
                      ✓ 已填充到对话输入框
                    </span>
                  </div>
                  <CommandChip text={ADD_PEOPLE_TEMPLATE} />
                  {PREFILL_STEPS.map((s, i) => (
                    <div key={s} style={styles.stepRow}>
                      <span style={styles.stepNum}>{i + 1}</span>
                      <span>{s}</span>
                    </div>
                  ))}
                  <div style={{ ...styles.muted, marginTop: 10, fontSize: 11.5 }}>
                    提示：已模拟「键入 /eteam + 空格」完成命令认领（claimed）——补全两个【】占位符后直接回车即可；编辑正文时命令高亮收起属正常行为。
                  </div>
                </div>
              ) : (
                <div style={{ ...styles.muted, marginTop: 4 }}>
                  点角色列表上方的「新增角色」：命令会填进对话输入框，在对话里补全信息后回车，这里实时看构建。
                </div>
              )}
              <details>
                <summary style={{ cursor: 'pointer', ...styles.muted, marginTop: 10 }}>
                  手动创建（不经过角色构建师）
                </summary>
                <div style={{ marginTop: 8 }}>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <Input
                      value={name}
                      placeholder="角色名，如：alice"
                      onChange={(e) => setName(e.target.value)}
                    />
                    <Input
                      value={role}
                      placeholder="角色：前端开发者 / 后端架构师 / UI 设计师 / 趣味注入师 / researcher / …"
                      onChange={(e) => setRole(e.target.value)}
                    />
                  </div>
                  <details>
                    <summary style={{ cursor: 'pointer', ...styles.muted, marginTop: 6 }}>
                      角色手册（可选，Markdown：使命/职责/规则/领域专章/沟通风格/交付标准）
                    </summary>
                    <div style={{ ...styles.formRow, marginTop: 8 }}>
                      <textarea
                        style={{ ...styles.textarea, minHeight: 220, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                        value={personaMd}
                        onChange={(e) => setPersonaMd(e.target.value)}
                        spellCheck={false}
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
                      粘贴到对话发送，主会话智能体执行 eteams_member_save 入库；成功后列表会出现。
                    </span>
                  </div>
                  {copied && (
                    <div style={{ ...styles.muted, marginTop: 6 }}>✓ 已复制——去对话里粘贴发送</div>
                  )}
                </div>
              </details>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (view === 'detail' && detail !== null) {
    const teamNames = teamsOf(detail.name);
    const isLeader = detail.name === LEADER_NAME;
    return (
      <div>
        <button type="button" style={styles.btn} onClick={() => setView('list')}>
          ← 返回角色列表
        </button>
        <div style={{ ...styles.card, marginTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Avatar
              name={detail.name}
              seed={detail.avatar?.seed}
              salt={detail.avatar?.salt}
              size={48}
            />
            {/* 角色（用户反馈）：不再需要标签——名字即身份，手册即人设。 */}
            <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{detail.name}</div>
          </div>
        </div>
        <HandbookEditor member={detail} readOnly={isLeader} onSaved={onDeleted} />
        {teamNames.length > 0 && (
          <div style={styles.card}>
            <div style={styles.sectionTitle}>所属团队（{teamNames.length}）</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {teamNames.map((n) => (
                <span key={n} style={styles.chip}>
                  {n}
                </span>
              ))}
            </div>
          </div>
        )}
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
          <div style={{ ...styles.sectionTitle, flex: 1, margin: 0 }}>角色（{members.length}）</div>
          {build !== null &&
          (build.status === 'active' || build.status === 'awaiting_confirmation') ? (
            // 有未入库的构建草稿：新增入口让位给「待加入角色」，防止误开新
            // 构建把旧草稿顶掉（docs/19.16）。
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setView('add');
              }}
            >
              待加入角色
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              icon={<IconPlusOutline16 />}
              onClick={() => {
                // 一键预填（D18-1）：命令进输入框 → 跳到构建工作台；不可用时
                // 退化为复制，提示去对话粘贴。
                const outcome = onPrefillAddPeople();
                if (outcome === 'set') {
                  setJustFilled(true);
                  setView('add');
                } else if (outcome === 'copied') {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }
              }}
            >
              新增角色
            </Button>
          )}
        </div>
        {listError !== null && <div style={styles.formError}>{listError}</div>}
        {members.length === 0 ? (
          <div style={styles.empty}>
            还没有角色。点「新增角色」，在对话里补全信息，角色构建师会帮你构建人设。
          </div>
        ) : (
          <>
            {/* 搜索 + 分页（用户反馈）：按名字/角色字段过滤，每页 8 条。 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Input
                  value={query}
                  placeholder="搜索角色名…"
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(0); // 新搜索从头翻页
                  }}
                />
              </div>
              {totalPages > 1 && (
                <span style={{ ...styles.muted, flexShrink: 0 }}>
                  {filtered.length} 个 · 第 {safePage + 1}/{totalPages} 页
                </span>
              )}
            </div>
            {pageRows.map((m) => {
              const teamNames = teamsOf(m.name);
              const isProtected = PROTECTED_MEMBERS.includes(m.name);
              return (
                <div
                  key={m.name}
                  style={styles.memberRow}
                  onClick={() => {
                    setDetailName(m.name);
                    setView('detail');
                  }}
                >
                  <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} size={32} />
                  {/* 角色（用户反馈）：不再需要标签——名字即身份。 */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{m.name}</span>
                    {teamNames.length > 0 && (
                      <div style={{ ...styles.muted, fontSize: 11, marginTop: 1 }}>
                        {teamNames.join('、')}
                      </div>
                    )}
                  </div>
                  {isProtected ? null : (
                    <button
                      type="button"
                      style={{ ...styles.btn, color: T.err }}
                      onClick={(e) => {
                        e.stopPropagation();
                        del(m.name);
                      }}
                    >
                      删除
                    </button>
                  )}
                </div>
              );
            })}
            {totalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <Button size="sm" variant="ghost" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
                  上一页
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={safePage >= totalPages - 1}
                  onClick={() => setPage(safePage + 1)}
                >
                  下一页
                </Button>
              </div>
            )}
          </>
        )}
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
