/**
 * Web surface (docs/12, M4 subset — read-only): loopback HTTP routes under
 * `/eteams-api` served from the durable state files, for the client
 * panel to poll. Registration is lazy: the web server and workspace registry
 * are sibling services that headless profiles never mount and concurrent
 * activations may bind after this plugin, so we try now and retry on each
 * service binding event (`ctx.on('internal/service')`). In a webless profile
 * the plugin stays tool-only and never blocks boot (docs/12.5.1).
 *
 * @module dsh-eteams/host/webui
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ETeamsResolvedConfig } from '../config.js';
import type {
  EventRecord,
  MemberRecord,
  TaskRecord,
  TaskStatus,
  TeamState,
} from '../model/types.js';
import { readEventsSync, readMailboxSync } from '../state/events.js';
import { boardOverview } from '../state/queries.js';
import { listTeamIds, readTeamSync } from '../state/store.js';
import { joinPath, type RuntimeContext, type RuntimeEnv } from './base.js';
import { taskDirRel } from './docs.js';
import { composeCaptainPersona } from '../prompts/personas/captain.js';
import {
  avatarSeedFor,
  ensurePresetMembers,
  findRosterMember,
  formatEmployeeId,
  LEADER_NAME,
  readRoster,
  removeRosterMember,
  upsertRosterMember,
} from './roster.js';
import {
  addMember,
  createTeam,
  deleteTeam,
  removeMember,
  setLeaderRemoved,
  setMemberModel,
  syncMemberToRoster,
  updateMember,
} from './teamOps.js';
import { createTask, deleteTask, taskOutcome, updateTask } from './assignment.js';
import { leaderRowOf, latestInstanceRow, memberStatusOf } from './notifier.js';
import {
  answerBuildInterview,
  cancelBuildSession,
  confirmBuildSession,
  readBuildParentSession,
  readBuildSession,
  reportBuildProgress,
  resumeBuildSession,
  writeBuildPresence,
  type BuildDraft,
} from './roleBuilder.js';
import { spawnBuildPhase, spawnContinueAfterAnswers } from './builderPhases.js';
import { clearSessionPersona, setSessionPersona } from './sessionPersona.js';
import { clearSessionTeam, setSessionTeam } from './sessionTeam.js';
import { readUsageCalendar } from './usage.js';
import { locateTeamAcrossWorkspaces, workspaceRegistryOf } from './workspaces.js';

/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const;

/** Base URL prefix for every eteams route. */
export const ROUTE_PREFIX = '/eteams-api';

/** Minimal structural view of the host web server service. */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: unknown, res: unknown) => void | Promise<void>;
  }): () => void;
}

// ---------- snapshot builders (pure over disk state) ----------

/** One chain station as rendered by the panel. */
export interface StationView {
  member: string;
  stageBrief: string;
  stationStatus: 'done' | 'current' | 'pending';
}

/** 看板「进行中」五态（docs/27 §27.9#11 十态收敛；ready 是待派单列不算进行中）。 */
const ACTIVE_STATUSES: TaskStatus[] = ['wait', 'start', 'paused', 'wait_decision', 'wait_user'];

/** Station status for chain index `i` given the task state. */
function stationStatusOf(
  status: TaskStatus,
  chainLength: number,
  cursor: number,
  i: number,
): StationView['stationStatus'] {
  void chainLength;
  if (i <= cursor) return 'done';
  if (i === cursor + 1 && (ACTIVE_STATUSES.includes(status) || status === 'ready'))
    return 'current';
  return 'pending';
}

/** Per-member view row (docs/12.2; avatar/persona editors land in M6/M5).
 * 模板行承载人设/路线（docs/35 §3#5），状态与会话锚点按名聚合实例行
 * （§5#12：同一人每条大任务一行实例行，行数不当人数）。 */
function memberView(team: TeamState, m: MemberRecord) {
  const currentTask = team.tasks.find(
    (t) => t.assignee === m.name && ACTIVE_STATUSES.includes(t.status),
  );
  const row = latestInstanceRow(team, m.name);
  return {
    name: m.name,
    /** 工号 (docs/21)：格式化显示串（ET-0001）；null for legacy members. */
    employeeId: m.employeeId !== undefined ? formatEmployeeId(m.employeeId) : null,
    role: m.role,
    // 成员详情（用户迭代 2026-09 四）：成员自己的角色手册副本——加入团队时
    // 从角色库复制，之后与角色详情各自独立；/persona 改写、/sync-roster 同步
    // 回角色库。personaMd 为空（旧成员）时客户端按结构字段合成骨架。
    personaMd: m.persona.personaMd ?? null,
    duty: m.persona.duty,
    style: m.persona.style,
    skills: m.persona.skills,
    rules: m.persona.rules,
    executionPrompt: m.persona.executionPrompt,
    status: memberStatusOf(team, m.name),
    model: m.modelRoute.model,
    reasoningEffort: m.modelRoute.reasoningEffort ?? null,
    currentTaskId: currentTask?.id ?? null,
    childId: row?.childSessionId ? row.childSessionId : null,
    removed: false,
    avatar: m.avatar ?? null,
  };
}

/** Per-task view row with chain station marks and a compact attempt summary.
 * @param groupOutcomes 组容器的收口产出（docs/26）：组自身没有 attempts，
 * 产出由 completeGroupIfDoneInTx 聚合进 task.completed 事件
 * （payload.via='subtasks.completed'）——面板按事件反查，小任务仍走
 * attempts 反查（docs/35 §5#10 产出不落列）。 */
function taskView(t: TaskRecord, team: TeamState, groupOutcomes?: Map<number, string>) {
  // 末站完成即 completed（chainCursor 不再推进，docs/35 §5#10）——完成态
  // 按满进度口径显示站点。
  const stationStatus = (i: number): StationView['stationStatus'] =>
    t.status === 'completed'
      ? 'done'
      : stationStatusOf(t.status, t.chain.length, t.chainCursor, i);
  return {
    taskId: t.id,
    subject: t.subject,
    // 任务单（group 容器）判据：无父且有子任务（旧 kind 列已砍，docs/35 §3）。
    kind: t.parentId === null && team.tasks.some((x) => x.parentId === t.id) ? 'group' : 'task',
    parentId: t.parentId ?? null,
    folder: taskDirRel(team, t),
    description: t.description ?? null,
    // 合同四数组 + 幂等说明（docs/35 §3#7：任务补合同四数组）。
    acceptance: t.acceptance ?? [],
    inScope: t.inScope ?? [],
    outOfScope: t.outOfScope ?? [],
    deliverables: t.deliverables ?? [],
    idempotencyNote: t.idempotencyNote ?? null,
    // 阻塞徽标（docs/36 建议 1）：wait + blockedFrom 非空 = 物化阻塞。
    blocked: t.blockedFrom !== undefined,
    blockedFrom: t.blockedFrom ?? null,
    statusNote: t.statusNote ?? null,
    workDir: t.workDir ?? null,
    status: t.status,
    assignee: t.assignee ?? null,
    dependencies: t.dependencies,
    chain: t.chain.map((s, i): StationView => ({
      member: s.member,
      stageBrief: s.stageBrief,
      stationStatus: stationStatus(i),
    })),
    chainCursor: t.chainCursor,
    chainLength: t.chain.length,
    retryCount: t.retryCount,
    // 产出不落列（docs/35 §5#10）：反查 attempts 最新成功行。
    currentAttemptId: t.attempts.at(-1)?.id ?? null,
    outcome: taskOutcome(t) ?? groupOutcomes?.get(t.id) ?? null,
    attemptSummary: t.attempts.slice(-3).map((a) => ({
      id: a.id,
      member: a.member,
      kind: a.kind,
      status: a.status,
      startedAt: a.claimedAt ?? a.createdAt,
      endedAt: a.endedAt ?? null,
      lastEventText: a.progress.at(-1)?.text ?? a.error ?? a.result?.output ?? null,
      eventCount: a.progress.length,
    })),
    updatedAt: t.updatedAt,
  };
}

/** Build the full panel snapshot for one team (docs/12.2 TeamSnapshot). */
export function teamSnapshot(
  team: TeamState,
  workspacePath: string,
  config: ETeamsResolvedConfig,
): Record<string, unknown> {
  // The captain (项目牧羊人) is rendered as the leader card on the 团队 page;
  // it is not a roster member, so it travels with the snapshot instead. Its
  // 工号 comes from the roster leader entry (backfilled on first /roster
  // read); 'ET-0001' covers workspaces whose roster was never listed yet.
  const captainPersona = composeCaptainPersona(workspacePath, config.stateDir);
  const rosterLeader = readRoster(joinPath(workspacePath, config.stateDir)).find(
    (m) => m.name === LEADER_NAME,
  );
  const leader = leaderRowOf(team);
  // 组收口产出（docs/26）：task.completed 事件 payload.via='subtasks.completed'
  // 的聚合文本按 taskId 收敛，同任务多次收口取最新一条（Map 覆盖写）。
  const events = readEventsSync(joinPath(workspacePath, config.stateDir), team.id);
  const groupOutcomes = new Map<number, string>();
  for (const e of events) {
    if (e.type !== 'task.completed' || e.taskId === undefined) continue;
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    if (payload.via !== 'subtasks.completed' || typeof payload.outcome !== 'string') continue;
    groupOutcomes.set(e.taskId, payload.outcome);
  }
  return {
    teamId: team.id,
    name: team.name,
    // 领队锚点（docs/35 §3）：领队行 main_session_id；移出/回团即行 status。
    leaderRemoved: leader?.status === 'removed',
    // docs/27 §27.9#4：goal / phase / planReviewState / version / workDir /
    // leaderModelRoute 已随审批重构与成员模型收敛砍掉——面板不再消费。
    // docs/26：任务单（group 容器）不计入进度——进度只反映真实小任务。
    progress: (() => {
      const real = team.tasks.filter((t) => !team.tasks.some((x) => x.parentId === t.id));
      return {
        completed: real.filter((t) => t.status === 'completed').length,
        total: real.length,
        cancelled: real.filter((t) => t.status === 'cancelled').length,
        active: real.filter((t) => ACTIVE_STATUSES.includes(t.status)).length,
      };
    })(),
    captain: {
      name: '项目牧羊人',
      // 工号格式化显示串（ET-0001；roster 未读时按 1 号兜底）。
      employeeId: formatEmployeeId(rosterLeader?.employeeId ?? 1),
      role: captainPersona.role,
      duty: captainPersona.duty,
      style: captainPersona.style,
      skills: captainPersona.skills,
      personaMd: captainPersona.personaMd ?? null,
      // 头像（用户迭代 2026-09-03）：优先名册领队条目——面板「随机头像」
      // 换脸后团队页领队卡同步；缺省回落固定 (hashName, 7)。
      avatar: rosterLeader?.avatar ?? { seed: avatarSeedFor('项目牧羊人'), salt: 7 },
    },
    // 成员 = 班底模板行（实例行全部 removed 的成员不再展示，docs/35 §5#12）。
    members: team.members
      .filter((m) => {
        const rows = team.taskMembers.filter((r) => r.name === m.name);
        return rows.length === 0 || rows.some((r) => r.status !== 'removed');
      })
      .map((m) => memberView(team, m)),
    tasks: team.tasks.map((t) => taskView(t, team, groupOutcomes)),
    pendingDecisions: team.pendingDecisions
      .filter((d) => d.status === 'open')
      .map((d) => ({
        id: d.id,
        taskId: d.taskId,
        error: d.error,
        retryCount: d.retryCount,
        createdAt: d.createdAt,
      })),
    latestEvents: events
      .slice(-30)
      .map((e) => ({
        seq: e.seq,
        at: e.at,
        actor: e.actor.name ?? e.actor.kind,
        actorKind: e.actor.kind,
        type: e.type,
        taskId: e.taskId ?? null,
        text: summarizeEvent(e),
      })),
  };
}

/** One-line human summary of an event for the 动态 view. */
export function summarizeEvent(e: EventRecord): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const task = e.taskId !== undefined ? `#${e.taskId}` : '';
  switch (e.type) {
    case 'team.created':
      return `创建团队「${String(p.name ?? '')}」`;
    case 'plan.questionnaire':
      return `问询完成（${String(p.count ?? '?')} 问）`;
    case 'member.added':
      return `成员「${String(p.name ?? '')}」加入`;
    case 'member.removed':
      return `成员「${String(p.name ?? '')}」移除`;
    case 'leader.removed':
      return '领队已移出团队';
    case 'leader.restored':
      return '领队回到团队';
    case 'task.created':
      return `新建任务 ${task}`;
    case 'task.assigned':
      return `${task} 指派给 ${String(p.member ?? '')}`;
    case 'task.claimed':
      return `${String(p.member ?? '')} 接取 ${task}`;
    case 'task.progress':
      return `${task} 进度：${String(p.text ?? '')}`;
    case 'task.stage_completed':
      return `${task} 站点完成，下一站 ${String(p.next ?? '?')}`;
    case 'task.completed':
      return `${task} 已完成`;
    case 'task.failed':
      return `${task} 失败：${String(p.error ?? '')}`;
    case 'task.retried':
      return `${task} 第 ${String(p.retry ?? '?')} 次重试`;
    case 'chain.deviated':
      return `${task} 偏离执行链：${String(p.note ?? '')}`;
    case 'task.suspended':
      return `${task} 已挂起`;
    case 'task.resumed':
      return `${task} 已恢复`;
    case 'task.cancelled':
      return `${task} 已取消`;
    case 'decision.requested':
      return `${task} 需决策：${String(p.error ?? '')}`;
    case 'task.blocked':
      return `${task} 被上游阻断`;
    case 'task.unblocked':
      return `${task} 解除阻断`;
    case 'mail.queued':
      return `邮件入箱 → ${String(p.to ?? '')}`;
    default:
      return e.type;
  }
}

/** Read every unarchived team across all registered workspaces. */
async function collectTeams(
  ctx: Context,
  config: ETeamsResolvedConfig,
): Promise<Record<string, unknown>[]> {
  const registry = workspaceRegistryOf(ctx);
  if (!registry) return [];
  const snapshots: Record<string, unknown>[] = [];
  for (const workspace of registry.list()) {
    const root = joinPath(workspace.path, config.stateDir);
    for (const teamId of await listTeamIds(root)) {
      const team = readTeamSync(root, teamId);
      if (team) snapshots.push(teamSnapshot(team, workspace.path, config));
    }
  }
  return snapshots;
}

// ---------- lazy route installation ----------

function webServerOf(ctx: Context): WebServerLike | undefined {
  const get = (ctx as unknown as { get?: (key: string) => unknown }).get;
  if (typeof get !== 'function') return undefined;
  return (get.call(ctx, WEB_SERVER_KEYS[0]) ?? get.call(ctx, WEB_SERVER_KEYS[1])) as
    WebServerLike | undefined;
}

function sendJson(res: unknown, status: number, body: unknown): void {
  const r = res as {
    writeHead: (code: number, headers: Record<string, string>) => void;
    end: (data?: string) => void;
  };
  r.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  r.end(JSON.stringify(body));
}

function sendError(res: unknown, status: number, error: string, hint?: string): void {
  sendJson(res, status, { error, ...(hint ? { hint } : {}) });
}

async function readBody(req: unknown): Promise<string> {
  const r = req as { on: (event: string, cb: (chunk?: Buffer) => void) => void };
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    r.on('data', (chunk) => {
      if (chunk)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as string));
    });
    r.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    r.on('error', reject);
  });
}

/** Ring cap for the persisted client log (lines). */
const CLIENT_LOG_MAX_LINES = 400;

/**
 * Persist renderer-reported diagnostics to `<stateDir>/logs/client.log`
 * (JSON lines, head-truncated ring). Prefers a workspace that already has
 * eteams state; never throws — a broken log sink must not break the route.
 */
function appendClientLog(ctx: Context, config: ETeamsResolvedConfig, raw: string): number {
  const registry = workspaceRegistryOf(ctx);
  if (!registry) return 0;
  const list = registry.list();
  if (list.length === 0) return 0;
  let root = joinPath(list[0]!.path, config.stateDir);
  for (const ws of list) {
    const candidate = joinPath(ws.path, config.stateDir);
    if (existsSync(candidate)) {
      root = candidate;
      break;
    }
  }
  let parsed: { version?: unknown; entries?: unknown };
  try {
    parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
  } catch {
    return 0;
  }
  const batch = Array.isArray(parsed.entries) ? parsed.entries : [];
  let written = 0;
  try {
    const dir = joinPath(root, 'logs');
    mkdirSync(dir, { recursive: true });
    const file = joinPath(dir, 'client.log');
    const prev = existsSync(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .filter((l) => l !== '')
      : [];
    const lines: string[] = [...prev];
    for (const item of batch) {
      lines.push(
        JSON.stringify({
          at: Date.now(),
          version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
          entry: item,
        }),
      );
      written += 1;
    }
    while (lines.length > CLIENT_LOG_MAX_LINES) lines.shift();
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    if (written > 0) {
      const logger = (ctx as unknown as { logger?: { warn?: (msg: string) => void } }).logger;
      if (typeof logger?.warn === 'function')
        logger.warn(`eteams: client diagnostics +${written} → ${file}`);
    }
  } catch {
    // sink failure is swallowed by design
  }
  return written;
}

/**
 * host.log 诊断（用户迭代 2026-09-03 排障）：client.log 全部来自渲染端上报，
 * 宿主自身无痕——「改完代码重启后行为没变」只能靠猜。这里补两条宿主侧
 * 留痕（`<stateDir>/logs/host.log`，JSON lines 环形上限，写失败静默）：
 * 1. Web 面装载即写 host-boot 一行，module/builtAt 取宿主 bundle 自身路径
 *    与 mtime——运行中的代码到底是哪个构建，磁盘可查；
 * 2. POST /roster 保存时写 roster-save 一行，含是否收到 avatar——「随机
 *    头像保存无效」一眼定位：客户端发没发（client 端 fetch 打桩复现）/
 *    宿主有没有透传（本行）。
 */
const HOST_LOG_MAX_LINES = 100;

/** Boot marker is per-process: dedupe across installWebSurface retries. */
let hostBootLogged = false;

function appendHostLog(
  ctx: Context,
  config: ETeamsResolvedConfig,
  entry: Record<string, unknown>,
): void {
  try {
    const registry = workspaceRegistryOf(ctx);
    if (registry === undefined) return;
    const list = registry.list();
    if (list.length === 0) return;
    let root = joinPath(list[0]!.path, config.stateDir);
    for (const ws of list) {
      const candidate = joinPath(ws.path, config.stateDir);
      if (existsSync(candidate)) {
        root = candidate;
        break;
      }
    }
    const dir = joinPath(root, 'logs');
    mkdirSync(dir, { recursive: true });
    const file = joinPath(dir, 'host.log');
    const prev = existsSync(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .filter((l) => l !== '')
      : [];
    const lines: string[] = [...prev, JSON.stringify({ at: Date.now(), ...entry })];
    while (lines.length > HOST_LOG_MAX_LINES) lines.shift();
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    // sink failure is swallowed by design
  }
}

/**
 * One-time host-boot marker: records the running module's own path and
 * mtime — i.e. which build is actually executing. Answers「磁盘上明明是新
 * 构建、行为却是旧的」这类排障（用户迭代 2026-09-03）：宿主 bundle 由
 * 应用启动时加载一次，重建不热生效。
 */
function logHostBoot(ctx: Context, config: ETeamsResolvedConfig): void {
  if (hostBootLogged) return;
  hostBootLogged = true;
  let builtAt = '';
  let module = '';
  try {
    module = fileURLToPath(import.meta.url);
    builtAt = statSync(module).mtime.toISOString();
  } catch {
    // bundler without import.meta.url / stat failure — marker still written
  }
  appendHostLog(ctx, config, { kind: 'host-boot', module, builtAt });
}

/**
 * Install the eteams web surface (idempotent): registers one prefix route
 * covering every read endpoint and returns whether it bound this call.
 */
export function installWebSurface(ctx: Context, config: ETeamsResolvedConfig): boolean {
  const webServer = webServerOf(ctx);
  const workspaceRegistry = workspaceRegistryOf(ctx);
  if (webServer === undefined || workspaceRegistry === undefined) return false;
  logHostBoot(ctx, config);

  ctx.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (rawReq, rawRes) => {
          const req = rawReq as { method?: string; url?: string | undefined };
          const res = rawRes;
          try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const path = url.pathname.slice(ROUTE_PREFIX.length) || '/';
            // Decode once here: pathname arrives percent-encoded for non-ASCII
            // team ids / member names (CJK slugs are the norm, docs/09).
            const segments = path
              .split('/')
              .filter((s) => s !== '')
              .map((s) => {
                try {
                  return decodeURIComponent(s);
                } catch {
                  return s;
                }
              });
            if (req.method === 'POST' && segments[0] === 'client-log' && segments.length === 1) {
              const raw = await readBody(req);
              const written = appendClientLog(ctx, config, raw);
              sendJson(res, 200, { ok: true, written });
              return;
            }
            // ---------- panel writes (M5 first slice) ----------
            // POST /session-persona — the panel's member selection (docs/13.8.2):
            // the session agent's system prompt gains a persona band evaluated per
            // assembly (sessionPersona.ts). No conversation message is involved.
            if (
              req.method === 'POST' &&
              segments[0] === 'session-persona' &&
              segments.length === 1
            ) {
              const body = parseJsonObject(await readBody(req));
              const sessionId = str(body.sessionId, '');
              const name = str(body.name, '');
              if (sessionId === '' || name === '') {
                sendError(res, 400, 'sessionId / name 均不能为空');
                return;
              }
              setSessionPersona(sessionId, {
                name,
                ...(body.role !== undefined ? { role: str(body.role) } : {}),
                ...(body.duty !== undefined ? { duty: str(body.duty) } : {}),
                ...(body.personaMd !== undefined ? { personaMd: str(body.personaMd) } : {}),
              });
              sendJson(res, 200, { ok: true });
              return;
            }
            // POST /session-persona/clear — deselect (back to the default agent voice).
            if (
              req.method === 'POST' &&
              segments[0] === 'session-persona' &&
              segments[1] === 'clear' &&
              segments.length === 2
            ) {
              const body = parseJsonObject(await readBody(req));
              const sessionId = str(body.sessionId, '');
              if (sessionId === '') {
                sendError(res, 400, 'sessionId 不能为空');
                return;
              }
              clearSessionPersona(sessionId);
              sendJson(res, 200, { ok: true });
              return;
            }
            // POST /session-team — the composer's 团队 selection (docs/26):
            // binds the conversation to a team; the session agent's prompt
            // gains a 团队绑定 band (sessionTeam.ts) with the conversation
            // task workflow and the leadership branch (领队 / 主窗口充当
            // 领队 / 团队建在他会话的可行动提示).
            if (req.method === 'POST' && segments[0] === 'session-team' && segments.length === 1) {
              const body = parseJsonObject(await readBody(req));
              const sessionId = str(body.sessionId, '');
              const teamId = str(body.teamId, '');
              if (sessionId === '' || teamId === '') {
                sendError(res, 400, 'sessionId / teamId 均不能为空');
                return;
              }
              const located = locateTeam(ctx, config, teamId);
              if (located === undefined) {
                sendError(res, 404, `团队「${teamId}」不存在`);
                return;
              }
              setSessionTeam(sessionId, { teamId, name: located.team.name, boundAt: Date.now() });
              sendJson(res, 200, { ok: true });
              return;
            }
            // POST /session-team/clear — deselect (plain conversation again).
            if (
              req.method === 'POST' &&
              segments[0] === 'session-team' &&
              segments[1] === 'clear' &&
              segments.length === 2
            ) {
              const body = parseJsonObject(await readBody(req));
              const sessionId = str(body.sessionId, '');
              if (sessionId === '') {
                sendError(res, 400, 'sessionId 不能为空');
                return;
              }
              clearSessionTeam(sessionId);
              sendJson(res, 200, { ok: true });
              return;
            }
            if (req.method === 'POST' && segments[0] === 'roster' && segments.length === 1) {
              const body = parseJsonObject(await readBody(req));
              // 用户迭代 2026-09-03：面板显式保存（名称/头像/手册一体）——
              // allowLeader 放行领队编辑；avatar 从详情页「随机头像」透传
              // （此前该路由丢弃 avatar，落库永远沿用旧头像）。
              const bodyAvatar = readAvatarPair(body.avatar);
              // 排障留痕：收到保存请求即记一行（客户端发没发 avatar、宿主
              // 收没收到，两端证据各占一边）。
              appendHostLog(ctx, config, {
                kind: 'roster-save',
                name: str(body.name, ''),
                hasAvatar: bodyAvatar !== undefined,
                avatar: bodyAvatar ?? null,
              });
              const stored = await upsertRosterMember(
                rootForWrites(ctx, config),
                {
                  name: str(body.name, ''),
                  role: str(body.role, ''),
                  ...(body.duty !== undefined ? { duty: str(body.duty) } : {}),
                  ...(body.style !== undefined ? { style: str(body.style) } : {}),
                  ...(body.skills !== undefined ? { skills: str(body.skills) } : {}),
                  ...(Array.isArray(body.rules) ? { rules: body.rules.map((r) => str(r)) } : {}),
                  ...(body.executionPrompt !== undefined
                    ? { executionPrompt: str(body.executionPrompt) }
                    : {}),
                  ...(body.personaMd !== undefined ? { personaMd: str(body.personaMd) } : {}),
                  ...(body.model !== undefined ? { model: str(body.model) } : {}),
                  ...(body.reasoningEffort !== undefined
                    ? { reasoningEffort: str(body.reasoningEffort) }
                    : {}),
                  ...(bodyAvatar !== undefined ? { avatar: bodyAvatar } : {}),
                },
                { allowLeader: true },
              );
              sendJson(res, 200, { ok: true, member: stored });
              return;
            }
            if (req.method === 'POST' && segments[0] === 'team' && segments.length === 1) {
              const body = parseJsonObject(await readBody(req));
              const name = str(body.name, '');
              const sessionId = str(body.sessionId, '');
              if (name === '' || sessionId === '') {
                sendError(res, 400, 'name / sessionId 均不能为空');
                return;
              }
              // 建队即生效（docs/35 §5#1：审批环节下线，目标在对话中确认）。
              const workspace = writeWorkspacePath(ctx, config);
              const team = await createTeam(envFor(ctx, config, workspace), agentFor(sessionId), {
                name,
                via: 'panel',
              });
              sendJson(res, 200, { ok: true, teamId: team.id, name: team.name });
              return;
            }
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 3 &&
              segments[2] === 'member'
            ) {
              const body = parseJsonObject(await readBody(req));
              const name = str(body.name, '');
              if (name === '') {
                sendError(res, 400, 'name 不能为空');
                return;
              }
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, `团队 ${segments[1]} 不存在`);
                return;
              }
              const { team, workspacePath } = located;
              const root = joinPath(workspacePath, config.stateDir);
              // sourceName: add a copy of a roster role under a new name
              // (user iteration 2026-09: multiple same roles per team).
              const entry = findRosterMember(root, str(body.sourceName, '') || name);
              if (body.fromRoster === true && !entry) {
                sendError(res, 404, `成员库中没有「${name}」`);
                return;
              }
              let result;
              try {
                result = await addMember(
                  envFor(ctx, config, workspacePath),
                  captainAgentOf(team),
                  {
                    name,
                    role: str(body.role, entry?.role ?? 'member'),
                    ...(body.executionPrompt !== undefined
                      ? { executionPrompt: str(body.executionPrompt) }
                      : entry?.executionPrompt !== undefined
                        ? { executionPrompt: entry.executionPrompt }
                        : {}),
                    ...(body.duty !== undefined
                      ? { duty: str(body.duty) }
                      : entry?.duty !== undefined
                        ? { duty: entry.duty }
                        : {}),
                    ...(body.style !== undefined
                      ? { style: str(body.style) }
                      : entry?.style !== undefined
                        ? { style: entry.style }
                        : {}),
                    ...(body.skills !== undefined
                      ? { skills: str(body.skills) }
                      : entry?.skills !== undefined
                        ? { skills: entry.skills }
                        : {}),
                    ...(Array.isArray(body.rules)
                      ? { rules: body.rules.map((r) => str(r)) }
                      : entry?.rules !== undefined
                        ? { rules: entry.rules }
                        : {}),
                    ...(body.personaMd !== undefined
                      ? { personaMd: str(body.personaMd) }
                      : entry?.personaMd !== undefined
                        ? { personaMd: entry.personaMd }
                        : {}),
                    ...(str(body.employeeId, '') !== ''
                      ? { employeeId: str(body.employeeId) }
                      : entry?.employeeId !== undefined
                        ? { employeeId: String(entry.employeeId) }
                        : {}),
                    ...(entry?.avatar !== undefined ? { avatar: entry.avatar } : {}),
                    ...(str(body.model, '') !== ''
                      ? { model: str(body.model) }
                      : entry?.model !== undefined
                        ? { model: entry.model }
                        : {}),
                    ...(body.reasoningEffort !== undefined
                      ? { reasoningEffort: str(body.reasoningEffort) }
                      : entry?.reasoningEffort !== undefined
                        ? { reasoningEffort: entry.reasoningEffort }
                        : {}),
                    via: 'panel',
                  },
                );
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, {
                ok: true,
                teamId: team.id,
                member: {
                  name: result.member.name,
                  role: result.member.role,
                  employeeId: result.member.employeeId ?? null,
                },
              });
              return;
            }
            // POST /roster/<name>/remove — delete a roster member (领队除外).
            if (
              req.method === 'POST' &&
              segments[0] === 'roster' &&
              segments.length === 3 &&
              segments[2] === 'remove'
            ) {
              if (segments[1] === LEADER_NAME) {
                sendError(res, 400, '领队成员不可删除');
                return;
              }
              try {
                await removeRosterMember(rootForWrites(ctx, config), segments[1]!);
              } catch (e) {
                sendError(res, 404, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, { ok: true, removed: segments[1] });
              return;
            }
            // POST /team/<id>/member/<name>/remove — move a member out of a team.
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 5 &&
              segments[2] === 'member' &&
              segments[4] === 'remove'
            ) {
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, `团队 ${segments[1]} 不存在`);
                return;
              }
              const { team, workspacePath } = located;
              try {
                await removeMember(
                  envFor(ctx, config, workspacePath),
                  captainAgentOf(team),
                  segments[3]!,
                  team.id,
                );
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, { ok: true, removed: segments[3] });
              return;
            }
            // POST /team/<id>/member/<name>/model - set the member's model
            // route (user iteration 2026-09: model select on the member
            // card). Empty body resets to inherited.
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 5 &&
              segments[2] === 'member' &&
              segments[4] === 'model'
            ) {
              const body = parseJsonObject(await readBody(req));
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, '团队 ' + segments[1] + ' 不存在');
                return;
              }
              const { team, workspacePath } = located;
              try {
                await setMemberModel(
                  envFor(ctx, config, workspacePath),
                  captainAgentOf(team),
                  {
                    teamId: team.id,
                    name: decodeURIComponent(segments[3]!),
                    ...(str(body.model, '') !== '' ? { model: str(body.model) } : {}),
                    ...(str(body.reasoningEffort, '') !== ''
                      ? { reasoningEffort: str(body.reasoningEffort) }
                      : {}),
                  },
                );
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, { ok: true });
              return;
            }
            // POST /team/<id>/member/<name>/persona - save the member's own
            // handbook copy (用户迭代 2026-09 四: member detail is separate
            // from the role detail; only the member record is written).
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 5 &&
              segments[2] === 'member' &&
              segments[4] === 'persona'
            ) {
              const body = parseJsonObject(await readBody(req));
              const personaMd = str(body.personaMd, '');
              if (personaMd.trim() === '') {
                sendError(res, 400, 'personaMd 不能为空');
                return;
              }
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, '团队 ' + segments[1] + ' 不存在');
                return;
              }
              const { team, workspacePath } = located;
              try {
                await updateMember(
                  envFor(ctx, config, workspacePath),
                  captainAgentOf(team),
                  { teamId: team.id, name: decodeURIComponent(segments[3]!), personaMd },
                );
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, { ok: true });
              return;
            }
            // POST /team/<id>/member/<name>/sync-roster - push the member's
            // handbook copy back to its roster role (用户迭代 2026-09 四:
            // 同步到该角色; creates the roster entry for copy members).
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 5 &&
              segments[2] === 'member' &&
              segments[4] === 'sync-roster'
            ) {
              const body = parseJsonObject(await readBody(req));
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, '团队 ' + segments[1] + ' 不存在');
                return;
              }
              const { team, workspacePath } = located;
              try {
                await syncMemberToRoster(
                  envFor(ctx, config, workspacePath),
                  captainAgentOf(team),
                  {
                    teamId: team.id,
                    name: decodeURIComponent(segments[3]!),
                    ...(str(body.personaMd, '') !== '' ? { personaMd: str(body.personaMd) } : {}),
                  },
                );
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, { ok: true });
              return;
            }
            // POST /team/<id>/leader/<remove|restore> - move the leader out
            // of / back into the team member roster (user iteration 2026-09:
            // the leader is deletable and re-addable).
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 4 &&
              segments[2] === 'leader' &&
              (segments[3] === 'remove' || segments[3] === 'restore')
            ) {
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, '团队 ' + segments[1] + ' 不存在');
                return;
              }
              const { team, workspacePath } = located;
              try {
                await setLeaderRemoved(
                  envFor(ctx, config, workspacePath),
                  captainAgentOf(team),
                  {
                    teamId: team.id,
                    removed: segments[3] === 'remove',
                  },
                );
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, { ok: true });
              return;
            }
            // docs/36 建议 5：领队模型路线（/team/<id>/leader/model）随审批
            // 重构下线——成员「跟随」在派发时解析到领队会话路线，无团队级
            // 覆盖项可设。
            // POST /team/<id>/delete — permanently remove a team directory
            // (deleteTeam rejects teams with active tasks; cancel or finish
            // them first). 团队列表小卡片「删除」按钮（用户迭代 2026-09 七）。
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 3 &&
              segments[2] === 'delete'
            ) {
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, `团队 ${segments[1]} 不存在`);
                return;
              }
              const { team, workspacePath } = located;
              try {
                await deleteTeam(
                  envFor(ctx, config, workspacePath),
                  captainAgentOf(team),
                  team.id,
                );
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, { ok: true });
              return;
            }
            // ---------- conversation task workflow (docs/26) ----------
            // POST /team/<id>/task — panel 小任务 CRUD（docs/26 审阅步骤）：
            // 用户在任务页修改/删除拆解出的小任务、新增小任务；任务一经领取
            // （updateTask/deleteTask 校验 draft/ready）即冻结。
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 3 &&
              segments[2] === 'task'
            ) {
              const body = parseJsonObject(await readBody(req));
              const subject = str(body.subject, '');
              if (subject === '') {
                sendError(res, 400, 'subject 不能为空');
                return;
              }
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, `团队 ${segments[1]} 不存在`);
                return;
              }
              const { team, workspacePath } = located;
              const chain = readChainParam(body.chain);
              const parentTaskIdRaw = str(body.parentTaskId, '');
              const parentTaskId =
                parentTaskIdRaw !== '' && Number.isFinite(Number(parentTaskIdRaw))
                  ? Number(parentTaskIdRaw)
                  : undefined;
              try {
                const task = await createTask(
                  envFor(ctx, config, workspacePath),
                  { teamId: team.id, actor: { kind: 'user', name: '用户' } },
                  {
                    subject,
                    ...(body.description !== undefined
                      ? { description: str(body.description) }
                      : {}),
                    ...(parentTaskId !== undefined ? { parentTaskId } : {}),
                    ...(chain !== undefined ? { chain } : {}),
                  },
                );
                sendJson(res, 200, { ok: true, taskId: task.id, status: task.status });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
              }
              return;
            }
            // POST /team/<id>/task/<taskId>/update — 修改未领取小任务（主题/
            // 说明/成员槽）。
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 5 &&
              segments[2] === 'task' &&
              segments[4] === 'update'
            ) {
              const body = parseJsonObject(await readBody(req));
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, `团队 ${segments[1]} 不存在`);
                return;
              }
              const { team, workspacePath } = located;
              const chain = readChainParam(body.chain);
              const taskId = Number.parseInt(segments[3] ?? '', 10);
              try {
                const task = await updateTask(
                  envFor(ctx, config, workspacePath),
                  { teamId: team.id, actor: { kind: 'user', name: '用户' } },
                  {
                    taskId,
                    ...(str(body.subject, '') !== '' ? { subject: str(body.subject) } : {}),
                    ...(body.description !== undefined
                      ? { description: str(body.description) }
                      : {}),
                    ...(chain !== undefined ? { chain } : {}),
                  },
                );
                sendJson(res, 200, { ok: true, taskId: task.id });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
              }
              return;
            }
            // POST /team/<id>/task/<taskId>/delete — 删除未领取任务（主任务
            // 级联删除全部小任务并清任务文件夹）。
            if (
              req.method === 'POST' &&
              segments[0] === 'team' &&
              segments.length === 5 &&
              segments[2] === 'task' &&
              segments[4] === 'delete'
            ) {
              const located = locateTeam(ctx, config, segments[1]!);
              if (!located) {
                sendError(res, 404, `团队 ${segments[1]} 不存在`);
                return;
              }
              const { team, workspacePath } = located;
              const deleteTaskId = Number.parseInt(segments[3] ?? '', 10);
              if (!Number.isFinite(deleteTaskId)) {
                sendError(res, 400, `任务号无效：${segments[3]}`);
                return;
              }
              try {
                await deleteTask(
                  envFor(ctx, config, workspacePath),
                  { teamId: team.id, actor: { kind: 'user', name: '用户' } },
                  deleteTaskId,
                );
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
                return;
              }
              sendJson(res, 200, { ok: true });
              return;
            }
            // docs/35 §5#1：批准环节下线（POST /team/<id>/approve 路由与
            // 'plan.approved' 事件分支随之删除）——计划在对话内确认，任务
            // 就绪后由领队直接指派执行。
            // ---------- role-builder build session (docs/19.6, D18) ----------
            // GET /rolebuilder — the single build-session slot; {empty:true}
            // when no session exists yet.
            if (req.method === 'GET' && segments[0] === 'rolebuilder' && segments.length === 1) {
              const session = readBuildSession(rootForWrites(ctx, config));
              sendJson(res, 200, session === null ? { empty: true } : { empty: false, session });
              return;
            }
            // POST /rolebuilder/confirm — the user-confirmed draft lands in
            // the roster and the session flips to confirmed in one host-side
            // operation (D18-6, 确认前零落库的唯一写点).
            if (
              req.method === 'POST' &&
              segments[0] === 'rolebuilder' &&
              segments.length === 2 &&
              segments[1] === 'confirm'
            ) {
              const current = readBuildSession(rootForWrites(ctx, config));
              if (current === null || current.status !== 'awaiting_confirmation') {
                sendError(res, 409, '没有待确认的构建草稿（状态非 awaiting_confirmation）');
                return;
              }
              const body = parseJsonObject(await readBody(req));
              const draft: BuildDraft = {
                name: str(body.name, ''),
                role: str(body.role, ''),
                ...(body.duty !== undefined ? { duty: str(body.duty) } : {}),
                ...(body.style !== undefined ? { style: str(body.style) } : {}),
                ...(body.skills !== undefined ? { skills: str(body.skills) } : {}),
                ...(Array.isArray(body.rules) ? { rules: body.rules.map((r) => str(r)) } : {}),
                ...(body.executionPrompt !== undefined
                  ? { executionPrompt: str(body.executionPrompt) }
                  : {}),
                ...(body.personaMd !== undefined ? { personaMd: str(body.personaMd) } : {}),
                ...(isAvatarPair(body.avatar) ? { avatar: body.avatar } : {}),
                ...(body.model !== undefined ? { model: str(body.model) } : {}),
                ...(body.reasoningEffort !== undefined
                  ? { reasoningEffort: str(body.reasoningEffort) }
                  : {}),
              };
              if (draft.name === '' || draft.role === '') {
                sendError(res, 400, 'name / role 均不能为空');
                return;
              }
              try {
                const { session, memberName } = await confirmBuildSession(
                  rootForWrites(ctx, config),
                  draft,
                );
                sendJson(res, 200, {
                  ok: true,
                  status: session.status,
                  name: memberName,
                  role: draft.role,
                });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
              }
              return;
            }
            // POST /rolebuilder/cancel — abandon the current build session.
            // Phase children are one-shot: they end naturally; nothing to
            // interrupt, nothing resumable left behind (docs/19.16).
            if (
              req.method === 'POST' &&
              segments[0] === 'rolebuilder' &&
              segments.length === 2 &&
              segments[1] === 'cancel'
            ) {
              try {
                const root = rootForWrites(ctx, config);
                const session = await cancelBuildSession(root);
                sendJson(res, 200, { ok: true, status: session.status });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
              }
              return;
            }
            // POST /rolebuilder/resume — continue a cancelled build (docs/19.16).
            // Context lives in the session file; a fresh ONE-SHOT phase child
            // finishes the build from that context — nothing resumable hangs.
            if (
              req.method === 'POST' &&
              segments[0] === 'rolebuilder' &&
              segments.length === 2 &&
              segments[1] === 'resume'
            ) {
              try {
                const root = rootForWrites(ctx, config);
                // 父会话在线性前置校验（先于恢复）：不在线就不改状态、诚实
                // 报错——否则恢复成 active 后没有代理续跑，面板再次假卡死。
                const parentSessionId = readBuildParentSession(root);
                const parent =
                  parentSessionId !== null
                    ? (ctx as unknown as RuntimeContext).agents?.get(parentSessionId)
                    : undefined;
                if (parent === undefined) {
                  sendError(
                    res,
                    409,
                    `父会话（${parentSessionId ?? '未知'}）当前不在线——构建未恢复。请先打开发起 /eteam 的对话，再点「继续构建」。`,
                  );
                  return;
                }
                const session = await resumeBuildSession(root);
                spawnBuildPhase({
                  ctx: { subagents: (ctx as unknown as RuntimeContext).subagents },
                  config,
                  parent,
                  stateRoot: root,
                  kind: 'resume',
                  logger: (ctx as unknown as RuntimeContext).logger,
                });
                sendJson(res, 200, { ok: true, status: session.status });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
              }
              return;
            }
            // POST /rolebuilder/restart — 手动重启构建代理（用户迭代）：阶段
            // 代理是一次性的，「等答案」期间本就没有活着的代理；重启 = 立即
            // 派一个新代理重新核查进度、按需重新出题。前置校验 + 10s 防抖
            // （updatedAt 被写走即天然占用），避免与提交答案/重复点击竞态。
            if (
              req.method === 'POST' &&
              segments[0] === 'rolebuilder' &&
              segments.length === 2 &&
              segments[1] === 'restart'
            ) {
              try {
                const root = rootForWrites(ctx, config);
                const current = readBuildSession(root);
                if (current === null) {
                  sendError(res, 400, '没有进行中的构建会话');
                  return;
                }
                if (current.status !== 'active') {
                  sendError(res, 409, `仅进行中的构建可重启（当前：${current.status}）`);
                  return;
                }
                if (current.interview === undefined || current.interview.answers !== undefined) {
                  sendError(
                    res,
                    409,
                    '当前没有待回答的意图访谈——代理可能正在工作中，请等其收工（草稿就绪/再次出题）后再试',
                  );
                  return;
                }
                if (Date.now() - current.updatedAt < 10_000) {
                  sendError(res, 429, '刚有阶段代理更新过会话——请等 10 秒后再重启');
                  return;
                }
                const parentSessionId = readBuildParentSession(root);
                const parent =
                  parentSessionId !== null
                    ? (ctx as unknown as RuntimeContext).agents?.get(parentSessionId)
                    : undefined;
                if (parent === undefined) {
                  sendError(
                    res,
                    409,
                    `父会话（${parentSessionId ?? '未知'}）当前不在线——请先打开发起 /eteam 的对话，再重启。`,
                  );
                  return;
                }
                await reportBuildProgress(root, {
                  status: 'active',
                  step: '重启核查',
                  note: '已手动重启构建代理——重新核查进度与访谈',
                });
                spawnBuildPhase({
                  ctx: { subagents: (ctx as unknown as RuntimeContext).subagents },
                  config,
                  parent,
                  stateRoot: root,
                  kind: 'restart',
                  logger: (ctx as unknown as RuntimeContext).logger,
                });
                sendJson(res, 200, { ok: true, status: 'active' });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
              }
              return;
            }
            // POST /rolebuilder/interview — user answered the intent interview
            // in the workbench (docs/19.16): store the answers, then spawn the
            // drafting ONE-SHOT phase child with the full session snapshot.
            if (
              req.method === 'POST' &&
              segments[0] === 'rolebuilder' &&
              segments.length === 2 &&
              segments[1] === 'interview'
            ) {
              try {
                const root = rootForWrites(ctx, config);
                const body = parseJsonObject(await readBody(req));
                const rawAnswers = Array.isArray(body.answers) ? body.answers : [];
                const answers = rawAnswers
                  .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
                  .map((a) => ({ id: str(a.id), choice: str(a.choice) }))
                  .filter((a) => a.id !== '' && a.choice !== '');
                if (answers.length === 0) {
                  sendError(res, 400, 'answers 不能为空');
                  return;
                }
                // 父会话在线性前置校验（先于落盘）：父不在线时 spawn continue
                // 必然失败——诚实报错并保留原访谈，而不是存了答案后静默卡死。
                const parentSessionId = readBuildParentSession(root);
                const parent =
                  parentSessionId !== null
                    ? (ctx as unknown as RuntimeContext).agents?.get(parentSessionId)
                    : undefined;
                if (parent === undefined) {
                  sendError(
                    res,
                    409,
                    `父会话（${parentSessionId ?? '未知'}）当前不在线——答案未保存。请切到发起 /eteam 的对话（打开即可）后重新提交；或先放弃本次构建再重新发起。`,
                  );
                  return;
                }
                const session = await answerBuildInterview(root, answers);
                // 共用出口（去重）：同一轮答案只派一次起草代理——面板与主
                // 对话 eteams_interview_answer 两个入口竞态时后者跳过。
                spawnContinueAfterAnswers({
                  ctx: { subagents: (ctx as unknown as RuntimeContext).subagents },
                  config,
                  parent,
                  stateRoot: root,
                  logger: (ctx as unknown as RuntimeContext).logger,
                });
                sendJson(res, 200, { ok: true, status: session.status });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
              }
              return;
            }
            // POST /presence — 活跃会话心跳（用户迭代：兜底弹窗 steer 到用户
            // 正在看的对话）：客户端从活跃对话的输入栏按钮上报 sessionId，
            // 宿主记 last-writer-wins，兜底 steer 前读取定位。fire-and-forget
            // 信号——坏了不影响主流程（退回父会话路径）。
            if (req.method === 'POST' && segments[0] === 'presence' && segments.length === 1) {
              try {
                const root = rootForWrites(ctx, config);
                const body = parseJsonObject(await readBody(req));
                const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
                if (sessionId === '') {
                  sendError(res, 400, 'sessionId 不能为空');
                  return;
                }
                await writeBuildPresence(root, sessionId);
                sendJson(res, 200, { ok: true });
              } catch (e) {
                sendError(res, 400, e instanceof Error ? e.message : String(e));
              }
              return;
            }
            if (req.method !== 'GET') {
              sendError(res, 405, 'M4 只读面板：仅支持 GET（写路由除外）');
              return;
            }
            if (segments[0] === 'roster' && segments.length === 1) {
              // Preset members (agency-agents-zh) appear on first access.
              await ensurePresetMembers(rootForWrites(ctx, config));
              sendJson(res, 200, { members: readRoster(rootForWrites(ctx, config)) });
              return;
            }
            if (segments[0] === 'board' && segments.length === 1) {
              // 跨团队聚合面板（docs/35 §6：Q1/Q3/Q4/Q5/Q9，纯只读 SQL）。
              const registry = workspaceRegistryOf(ctx);
              const teams: unknown[] = [];
              if (registry) {
                for (const workspace of registry.list()) {
                  try {
                    teams.push(...boardOverview(joinPath(workspace.path, config.stateDir)));
                  } catch (e) {
                    const logger = (ctx as unknown as { logger?: { warn?: (m: string) => void } })
                      .logger;
                    if (typeof logger?.warn === 'function')
                      logger.warn(`eteams: board aggregation skipped a workspace: ${String(e)}`);
                  }
                }
              }
              sendJson(res, 200, { teams, serverTime: Date.now() });
              return;
            }
            if (segments[0] === 'state' && segments.length === 1) {
              sendJson(res, 200, {
                teams: await collectTeams(ctx, config),
                maxMembers: config.maxMembers,
                serverTime: Date.now(),
              });
              return;
            }
            // /team/<id>/... scoped reads resolve the team on any workspace.
            if (segments[0] === 'team' && segments.length >= 2) {
              const teamId = segments[1]!;
              const located = locateTeam(ctx, config, teamId);
              if (!located) {
                sendError(res, 404, `团队 ${teamId} 不存在`);
                return;
              }
              const { team, root, workspacePath } = located;
              if (segments.length === 2) {
                sendJson(res, 200, teamSnapshot(team, workspacePath, config));
                return;
              }
              if (segments[2] === 'events') {
                const afterSeq = Number(url.searchParams.get('afterSeq') ?? '0') || 0;
                const events = readEventsSync(root, team.id).filter((e) => e.seq > afterSeq);
                sendJson(res, 200, { events, serverTime: Date.now() });
                return;
              }
              // GET /team/<id>/agentactivity — member subagent activity dots
              // (docs/20.4 P4): feature-detected listChildren; empty on older
              // runtimes (panel renders no dots then). 锚点是领队行
              // main_session_id（docs/35 §3）——领队不在线时无活动可报。
              if (segments[2] === 'agentactivity') {
                const list = (ctx as unknown as RuntimeContext).subagents?.listChildren;
                const leaderSessionId = leaderRowOf(team)?.mainSessionId ?? '';
                if (list === undefined || leaderSessionId === '') {
                  sendJson(res, 200, { activity: {} });
                  return;
                }
                const entries = await list.call(
                  (ctx as unknown as RuntimeContext).subagents,
                  leaderSessionId as never,
                );
                const activity: Record<string, string> = {};
                for (const entry of entries) {
                  if (entry.kind === 'child' && entry.activity !== undefined) {
                    activity[entry.id] = entry.activity;
                  }
                }
                sendJson(res, 200, { activity });
                return;
              }
              if (segments[2] === 'task' && segments[4] === 'track') {
                const taskId = Number.parseInt(segments[3] ?? '', 10);
                const task = Number.isFinite(taskId)
                  ? team.tasks.find((t) => t.id === taskId)
                  : undefined;
                if (!task) {
                  sendError(res, 404, `任务 #${segments[3]} 不存在`);
                  return;
                }
                const decision =
                  team.pendingDecisions.filter((d) => d.taskId === task.id).at(-1) ?? null;
                sendJson(res, 200, {
                  taskId: task.id,
                  attempts: task.attempts,
                  decision,
                  // 产出不落列（docs/35 §5#10）：反查 attempts 最新成功行。
                  outcome: taskOutcome(task) ?? null,
                  contract: {
                    subject: task.subject,
                    description: task.description ?? null,
                    acceptance: task.acceptance ?? [],
                    inScope: task.inScope ?? [],
                    outOfScope: task.outOfScope ?? [],
                    deliverables: task.deliverables ?? [],
                    idempotencyNote: task.idempotencyNote ?? null,
                    chain: task.chain,
                  },
                });
                return;
              }
              if (segments[2] === 'member' && segments[4] === 'dialog') {
                const name = segments[3]!;
                const known =
                  team.members.some((m) => m.name === name) ||
                  team.taskMembers.some((r) => r.name === name && r.status !== 'removed');
                if (!known) {
                  sendError(res, 404, `成员 ${name} 不存在`);
                  return;
                }
                const after = Number(url.searchParams.get('after') ?? '0') || 0;
                sendJson(res, 200, memberDialog(root, team, name, after));
                return;
              }
              // GET /team/<id>/usage/calendar?year=<y> — 每日 Token 消耗日历
              // （docs/28.4）：读取时聚合 usage.jsonl + 归档，全年零填充日格
              // （未来年同构返回零格，不 404）。year 缺省当年；非法值 400。
              if (segments[2] === 'usage' && segments[3] === 'calendar' && segments.length === 4) {
                const yearParam = url.searchParams.get('year');
                const year =
                  yearParam === null || yearParam === ''
                    ? new Date().getFullYear()
                    : Number(yearParam);
                if (!Number.isInteger(year) || year < 2000 || year > 2999) {
                  sendError(res, 400, `year 参数无效（需 2000-2999 的整数）：${String(yearParam)}`);
                  return;
                }
                const calendar = readUsageCalendar(root, String(team.id), year);
                sendJson(res, 200, {
                  teamId: team.id,
                  year,
                  serverTime: Date.now(),
                  days: calendar.days,
                  totals: calendar.totals,
                });
                return;
              }
            }
            sendError(res, 404, `未知路由：${path}`);
          } catch (error) {
            sendError(res, 500, `面板路由内部错误：${String(error)}`);
          }
        },
      }),
    'eteams: web routes',
  );
  return true;
}

/** Resolve one team across all workspaces; returns it with its root paths. */
export function locateTeam(
  ctx: Context,
  config: ETeamsResolvedConfig,
  teamId: string,
): { team: TeamState; root: string; workspacePath: string } | undefined {
  return locateTeamAcrossWorkspaces(ctx, config, teamId);
}

// ---------- panel-write helpers (M5 first slice) ----------

/** The workspace panel writes target: prefer one with existing eteams state. */
function writeWorkspacePath(ctx: Context, config: ETeamsResolvedConfig): string {
  const registry = workspaceRegistryOf(ctx);
  const list = registry?.list() ?? [];
  if (list.length === 0) throw new Error('没有可用工作区（workspaceRegistry 未就绪）');
  for (const workspace of list) {
    if (existsSync(joinPath(workspace.path, config.stateDir))) return workspace.path;
  }
  return list[0]!.path;
}

/** State root for roster reads/writes (same resolution as writeWorkspacePath). */
export function rootForWrites(ctx: Context, config: ETeamsResolvedConfig): string {
  return joinPath(writeWorkspacePath(ctx, config), config.stateDir);
}

/** Runtime env for a panel-driven mutation in one workspace. */
function envFor(ctx: Context, config: ETeamsResolvedConfig, workspace: string): RuntimeEnv {
  return { ctx: ctx as unknown as RuntimeContext, config, workspace };
}

/** Synthesize the captain Agent identity from a session id (staged ops only need id). */
function agentFor(sessionId: string): Agent {
  return { id: sessionId } as unknown as Agent;
}

/** 领队身份锚点（docs/35 §3）：面板写操作统一以领队行 main_session_id 充当队长代理。 */
function captainAgentOf(team: TeamState): Agent {
  return agentFor(leaderRowOf(team)?.mainSessionId ?? '');
}

/**
 * Tighten a client-supplied chain (成员槽) param into station pairs — panel
 * payloads are untrusted, so every entry is coerced field-by-field (same
 * treatment as the tool layer's chain mapping). Non-array = undefined
 * (caller omits the field); a present-but-empty array clears the chain.
 */
function readChainParam(value: unknown): { member: string; stageBrief: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => {
    const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    return { member: str(record.member, ''), stageBrief: str(record.stageBrief, '') };
  });
}

/** Parse a JSON object body; throws on non-object payloads. */
/** Type-guard for a client-supplied avatar pair (docs/14). */
function isAvatarPair(value: unknown): value is { seed: number; salt: number } {
  if (typeof value !== 'object' || value === null) return false;
  const pair = value as Record<string, unknown>;
  return (
    typeof pair.seed === 'number' &&
    Number.isFinite(pair.seed) &&
    typeof pair.salt === 'number' &&
    Number.isFinite(pair.salt)
  );
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

/** Coerce one JSON value to a trimmed string with a fallback. */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

/**
 * 用户迭代 2026-09-03「随机头像」：校验请求体里的 avatar 对（seed/salt 必须都是
 * 有限数）。非法/缺失一律 undefined——upsert 落库时自然回落到旧头像，畸形
 * 请求不产生半写。
 */
function readAvatarPair(value: unknown): { seed: number; salt: number } | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const seed = (value as { seed?: unknown }).seed;
  const salt = (value as { salt?: unknown }).salt;
  if (typeof seed !== 'number' || !Number.isFinite(seed)) return undefined;
  if (typeof salt !== 'number' || !Number.isFinite(salt)) return undefined;
  return { seed, salt };
}

/** Member dialog timeline (D15 read-only): mailbox rows + member events merged.
 * 成员是模板行（docs/35 §3#5）：状态按实例行聚合（memberStatusOf），当前
 * 任务按 assignee 查活跃五态；聚合不按实例行行数当人数（§5#12）。 */
function memberDialog(
  root: string,
  team: TeamState,
  memberName: string,
  after: number,
): Record<string, unknown> {
  type Item = { at: number; kind: string; text: string; taskId?: number; from?: string };
  const items: Item[] = [];
  for (const m of readMailboxSync(root, team.id, memberName)) {
    if (m.seq <= after) continue;
    items.push({
      at: m.at,
      kind: m.kind,
      text: m.content,
      taskId: m.taskId,
      from: m.from.name ?? m.from.kind,
    });
  }
  for (const task of team.tasks) {
    for (const attempt of task.attempts) {
      if (attempt.member !== memberName) continue;
      for (const note of attempt.progress) {
        if (note.at <= after) continue;
        items.push({
          at: note.at,
          kind: 'progress',
          text: note.text,
          taskId: task.id,
          from: memberName,
        });
      }
    }
  }
  items.sort((a, b) => a.at - b.at);
  const currentTask = team.tasks.find(
    (t) => t.assignee === memberName && ACTIVE_STATUSES.includes(t.status),
  );
  return {
    memberStatus: memberStatusOf(team, memberName),
    currentTaskId: currentTask?.id ?? null,
    items,
    serverTime: Date.now(),
  };
}
