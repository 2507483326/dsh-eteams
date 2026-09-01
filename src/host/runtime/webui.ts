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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ETeamsResolvedConfig } from '../config.js';
import type {
  EventRecord,
  MemberRecord,
  MemberStatus,
  TaskRecord,
  TaskStatus,
  TeamState,
} from '../model/types.js';
import { archiveRoot, readEventsSync, readMailboxSync } from '../state/events.js';
import { listTeamIds, readTeamSync } from '../state/store.js';
import { joinPath, type RuntimeContext, type RuntimeEnv } from './base.js';
import { teamWorkDirRel } from './docs.js';
import { composeCaptainPersona } from '../prompts/persona.js';
import {
  avatarSeedFor,
  ensurePresetMembers,
  findRosterMember,
  LEADER_NAME,
  readRoster,
  removeRosterMember,
  upsertRosterMember,
} from './roster.js';
import { addMember, createTeam, removeMember } from './teamOps.js';
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


/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const;
/** Workspace registry service key candidates, newest first. */
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'] as const;

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

/** Minimal structural view of the workspace registry service. */
interface WorkspaceRegistryLike {
  list(): { path: string; title: string }[];
}

// ---------- snapshot builders (pure over disk state) ----------

/** One chain station as rendered by the panel. */
export interface StationView {
  member: string;
  stageBrief: string;
  stationStatus: 'done' | 'current' | 'pending';
}

/** Terminal + in-flight statuses that count a task as "busy" for progress. */
const ACTIVE_STATUSES: TaskStatus[] = [
  'assigned',
  'in_progress',
  'retrying',
  'paused',
  'awaiting_decision',
  'needs_user',
];

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

/** Per-member view row (docs/12.2; avatar/persona editors land in M6/M5). */
function memberView(team: TeamState, m: MemberRecord) {
  const currentTask = team.tasks.find(
    (t) => t.assignee === m.name && ACTIVE_STATUSES.includes(t.status),
  );
  return {
    name: m.name,
    /** 工号 (docs/21); null for legacy members created before the field. */
    employeeId: m.employeeId ?? null,
    role: m.role,
    status: m.status as MemberStatus,
    provider: m.modelRoute.provider,
    model: m.modelRoute.model,
    reasoningEffort: m.modelRoute.reasoningEffort ?? null,
    currentTaskId: currentTask?.id ?? null,
    currentAttemptId: m.currentAttemptId ?? null,
    childId: m.id || null,
    removed: m.status === 'removed',
    avatar: m.avatar ?? null,
  };
}

/** Per-task view row with chain station marks and a compact attempt summary. */
function taskView(t: TaskRecord) {
  return {
    taskId: t.id,
    subject: t.subject,
    status: t.status,
    assignee: t.assignee ?? null,
    dependencies: t.dependencies,
    chain: t.chain.map((s, i): StationView => ({
      member: s.member,
      stageBrief: s.stageBrief,
      stationStatus: stationStatusOf(t.status, t.chain.length, t.chainCursor, i),
    })),
    chainCursor: t.chainCursor,
    chainLength: t.chain.length,
    retryCount: t.retryCount,
    currentAttemptId: t.currentAttemptId ?? null,
    outcome: t.status === 'completed' ? (t.outcome ?? null) : null,
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
    updatedAt: t.attempts.at(-1)?.endedAt ?? t.attempts.at(-1)?.createdAt ?? t.createdAt,
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
  return {
    teamId: team.id,
    name: team.name,
    goal: team.goal,
    phase: team.phase,
    planReviewState: team.planReviewState ?? null,
    captainSessionId: team.captainSessionId,
    version: team.version,
    workDir: team.phase === 'staged' ? null : teamWorkDirRel(team),
    progress: {
      completed: team.tasks.filter((t) => t.status === 'completed').length,
      total: team.tasks.length,
      cancelled: team.tasks.filter((t) => t.status === 'cancelled').length,
      active: team.tasks.filter((t) => ACTIVE_STATUSES.includes(t.status)).length,
    },
    captain: {
      name: '项目牧羊人',
      employeeId: rosterLeader?.employeeId ?? 'ET-0001',
      role: captainPersona.role,
      duty: captainPersona.duty,
      style: captainPersona.style,
      skills: captainPersona.skills,
      personaMd: captainPersona.personaMd ?? null,
      avatar: { seed: avatarSeedFor('项目牧羊人'), salt: 7 },
    },
    members: team.members.filter((m) => m.status !== 'removed').map((m) => memberView(team, m)),
    tasks: team.tasks.map(taskView),
    pendingDecisions: team.pendingDecisions
      .filter((d) => d.status === 'open')
      .map((d) => ({
        id: d.id,
        taskId: d.taskId,
        error: d.error,
        retryCount: d.retryCount,
        createdAt: d.createdAt,
      })),
    latestEvents: readEventsSync(joinPath(workspacePath, config.stateDir), team.id)
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
  const task = typeof p.taskId === 'string' ? p.taskId : (e.taskId ?? '');
  switch (e.type) {
    case 'team.created':
      return `创建团队「${String(p.name ?? '')}」`;
    case 'plan.questionnaire':
      return `问询完成（${String(p.count ?? '?')} 问）`;
    case 'plan.approved':
      return '计划已批准，团队启动';
    case 'member.added':
      return `成员「${String(p.name ?? '')}」加入`;
    case 'member.removed':
      return `成员「${String(p.name ?? '')}」移除`;
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

/** Archived team summaries (post-delete review, read-only). */
function collectArchivedTeams(
  ctx: Context,
  config: ETeamsResolvedConfig,
): Record<string, unknown>[] {
  const registry = workspaceRegistryOf(ctx);
  if (!registry) return [];
  const summaries: Record<string, unknown>[] = [];
  for (const workspace of registry.list()) {
    const root = joinPath(workspace.path, config.stateDir);
    const archive = archiveRoot(root);
    let ids: string[];
    try {
      ids = readdirSync(archive);
    } catch {
      continue;
    }
    for (const teamId of ids) {
      const team = readTeamSync(archive, teamId);
      if (!team) continue;
      summaries.push({
        teamId: team.id,
        name: team.name,
        goal: team.goal,
        phase: team.phase,
        workDir: team.workDir ?? null,
      });
    }
  }
  return summaries;
}

// ---------- lazy route installation ----------

function webServerOf(ctx: Context): WebServerLike | undefined {
  const get = (ctx as unknown as { get?: (key: string) => unknown }).get;
  if (typeof get !== 'function') return undefined;
  return (get.call(ctx, WEB_SERVER_KEYS[0]) ?? get.call(ctx, WEB_SERVER_KEYS[1])) as
    WebServerLike | undefined;
}

function workspaceRegistryOf(ctx: Context): WorkspaceRegistryLike | undefined {
  const get = (ctx as unknown as { get?: (key: string) => unknown }).get;
  if (typeof get !== 'function') return undefined;
  return (get.call(ctx, WORKSPACE_KEYS[0]) ?? get.call(ctx, WORKSPACE_KEYS[1])) as
    WorkspaceRegistryLike | undefined;
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
 * Install the eteams web surface (idempotent): registers one prefix route
 * covering every read endpoint and returns whether it bound this call.
 */
export function installWebSurface(ctx: Context, config: ETeamsResolvedConfig): boolean {
  const webServer = webServerOf(ctx);
  const workspaceRegistry = workspaceRegistryOf(ctx);
  if (webServer === undefined || workspaceRegistry === undefined) return false;

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
            if (req.method === 'POST' && segments[0] === 'session-persona' && segments.length === 1) {
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
            if (req.method === 'POST' && segments[0] === 'roster' && segments.length === 1) {
              const body = parseJsonObject(await readBody(req));
              const stored = await upsertRosterMember(rootForWrites(ctx, config), {
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
                ...(body.provider !== undefined ? { provider: str(body.provider) } : {}),
                ...(body.model !== undefined ? { model: str(body.model) } : {}),
                ...(body.reasoningEffort !== undefined
                  ? { reasoningEffort: str(body.reasoningEffort) }
                  : {}),
              });
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
              // Panel-created teams may omit the goal (name-only creation);
              // the captain refines it in conversation afterwards.
              const goal = str(body.goal, '') || '（待完善：与领队在对话中确认目标）';
              const workspace = writeWorkspacePath(ctx, config);
              const team = await createTeam(envFor(ctx, config, workspace), agentFor(sessionId), {
                name,
                goal,
                approval: 'required',
                via: 'panel',
              });
              sendJson(res, 200, { ok: true, teamId: team.id, name: team.name, phase: team.phase });
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
              const entry = findRosterMember(root, name);
              if (body.fromRoster === true && !entry) {
                sendError(res, 404, `成员库中没有「${name}」`);
                return;
              }
              const result = await addMember(
                envFor(ctx, config, workspacePath),
                agentFor(team.captainSessionId),
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
                  ...(entry?.employeeId !== undefined ? { employeeId: entry.employeeId } : {}),
                  ...(entry?.avatar !== undefined ? { avatar: entry.avatar } : {}),
                  ...(body.provider !== undefined && body.model !== undefined
                    ? { provider: str(body.provider), model: str(body.model) }
                    : entry?.provider !== undefined && entry.model !== undefined
                      ? { provider: entry.provider, model: entry.model }
                      : {}),
                  ...(body.reasoningEffort !== undefined
                    ? { reasoningEffort: str(body.reasoningEffort) }
                    : entry?.reasoningEffort !== undefined
                      ? { reasoningEffort: entry.reasoningEffort }
                      : {}),
                  via: 'panel',
                },
              );
              sendJson(res, 200, {
                ok: true,
                teamId: team.id,
                member: {
                  name: result.member.name,
                  role: result.member.role,
                  status: result.member.status,
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
                  agentFor(team.captainSessionId),
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
            // ---------- role-builder build session (docs/19.6, D18) ----------
            // GET /rolebuilder — the single build-session slot; {empty:true}
            // when no session exists yet.
            if (
              req.method === 'GET' &&
              segments[0] === 'rolebuilder' &&
              segments.length === 1
            ) {
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
                ...(body.provider !== undefined ? { provider: str(body.provider) } : {}),
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
            if (segments[0] === 'state' && segments.length === 1) {
              sendJson(res, 200, {
                teams: await collectTeams(ctx, config),
                archivedTeams: collectArchivedTeams(ctx, config),
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
              // runtimes (panel renders no dots then).
              if (segments[2] === 'agentactivity') {
                const list = (ctx as unknown as RuntimeContext).subagents?.listChildren;
                if (list === undefined) {
                  sendJson(res, 200, { activity: {} });
                  return;
                }
                const entries = await list.call(
                  (ctx as unknown as RuntimeContext).subagents,
                  team.captainSessionId as never,
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
                const task = team.tasks.find((t) => t.id === segments[3]);
                if (!task) {
                  sendError(res, 404, `任务 ${segments[3]} 不存在`);
                  return;
                }
                const decision =
                  team.pendingDecisions.filter((d) => d.taskId === task.id).at(-1) ?? null;
                sendJson(res, 200, {
                  taskId: task.id,
                  attempts: task.attempts,
                  decision,
                  contract: {
                    subject: task.subject,
                    description: task.description ?? null,
                    acceptance: task.acceptance ?? [],
                    chain: task.chain,
                  },
                });
                return;
              }
              if (segments[2] === 'member' && segments[4] === 'dialog') {
                const name = segments[3]!;
                const member = team.members.find((m) => m.name === name);
                if (!member) {
                  sendError(res, 404, `成员 ${name} 不存在`);
                  return;
                }
                const after = Number(url.searchParams.get('after') ?? '0') || 0;
                sendJson(res, 200, memberDialog(root, team, member, after));
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
function locateTeam(
  ctx: Context,
  config: ETeamsResolvedConfig,
  teamId: string,
): { team: TeamState; root: string; workspacePath: string } | undefined {
  const registry = workspaceRegistryOf(ctx);
  if (!registry) return undefined;
  for (const workspace of registry.list()) {
    const root = joinPath(workspace.path, config.stateDir);
    const team = readTeamSync(root, teamId);
    if (team) return { team, root, workspacePath: workspace.path };
  }
  return undefined;
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

/** Parse a JSON object body; throws on non-object payloads. */
/** Type-guard for a client-supplied avatar pair (docs/14). */
function isAvatarPair(value: unknown): value is { seed: number; salt: number } {
  if (typeof value !== 'object' || value === null) return false;
  const pair = value as Record<string, unknown>;
  return (
    typeof pair.seed === 'number' && Number.isFinite(pair.seed) &&
    typeof pair.salt === 'number' && Number.isFinite(pair.salt)
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

/** Member dialog timeline (D15 read-only): mailbox rows + member events merged. */
function memberDialog(
  root: string,
  team: TeamState,
  member: MemberRecord,
  after: number,
): Record<string, unknown> {
  type Item = { at: number; kind: string; text: string; taskId?: string; from?: string };
  const items: Item[] = [];
  for (const m of readMailboxSync(root, team.id, member.name)) {
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
      if (attempt.member !== member.name) continue;
      for (const note of attempt.progress) {
        if (note.at <= after) continue;
        items.push({
          at: note.at,
          kind: 'progress',
          text: note.text,
          taskId: task.id,
          from: member.name,
        });
      }
    }
  }
  items.sort((a, b) => a.at - b.at);
  const currentTask = team.tasks.find(
    (t) => t.assignee === member.name && ACTIVE_STATUSES.includes(t.status),
  );
  return {
    memberStatus: member.status,
    currentTaskId: currentTask?.id ?? null,
    items,
    serverTime: Date.now(),
  };
}
