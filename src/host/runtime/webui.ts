/**
 * Web surface (docs/12, M4 subset — read-only): loopback HTTP routes under
 * `/plugins/dsh-eteams` served from the durable state files, for the client
 * panel to poll. Registration is lazy: the web server and workspace registry
 * are sibling services that headless profiles never mount and concurrent
 * activations may bind after this plugin, so we try now and retry on each
 * service binding event (`ctx.on('internal/service')`). In a webless profile
 * the plugin stays tool-only and never blocks boot (docs/12.5.1).
 *
 * @module dsh-eteams/host/webui
 */
import type { Context } from '@deepseek-ai/cordis';
import { readdirSync } from 'node:fs';
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
import { joinPath } from './base.js';
import { teamWorkDirRel } from './docs.js';

/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const;
/** Workspace registry service key candidates, newest first. */
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'] as const;

/** Base URL prefix for every eteams route. */
export const ROUTE_PREFIX = '/plugins/dsh-eteams';

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
    role: m.role,
    status: m.status as MemberStatus,
    provider: m.modelRoute.provider,
    model: m.modelRoute.model,
    reasoningEffort: m.modelRoute.reasoningEffort ?? null,
    currentTaskId: currentTask?.id ?? null,
    currentAttemptId: m.currentAttemptId ?? null,
    childId: m.id || null,
    removed: m.status === 'removed',
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
void readBody; // reserved for M5 write routes

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
            const segments = path.split('/').filter((s) => s !== '');
            if (req.method !== 'GET') {
              sendError(res, 405, 'M4 只读面板：仅支持 GET');
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
                const name = decodeURIComponent(segments[3]!);
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
