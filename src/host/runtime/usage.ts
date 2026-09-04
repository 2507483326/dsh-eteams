/**
 * 每日 Token 消耗计量（docs/28）：看板「Token 消耗」日历的数据面。
 *
 * 采集（28.2.3 方案 A）：根作用域 `session/event` firehose 旁路观察——eteams
 * 插件 ctx 无 scope 标签（untagged listener），收到本进程所有会话（主会话 +
 * 成员/领队子代理）的每个已提交事件（E7/E8）。第一方同型先例：dsh-session-
 * persistence 在插件安装路径上做 `ctx.on("session/created")` + `ctx.on(
 * "session/event")` + `ctx.sessions.list()`（E18）。装机冒烟项见 docs/28.8-3：
 * E8 语义、归属矩阵（成员/领队子代理/领队主会话/面板绑定会话/构建子代理）
 * 与 `ctx.sessions.list()` 的覆盖面需真实宿主验证。
 *
 * 存储（28.3）：`<workspace>/.eteams/usage.jsonl` 事件粒度追加写（一次携带
 * usage 的 assistant/message 一行，模块级 Promise 链串行队列保证行序）；
 * `usage-checkpoint.json` 水位做重启对账（28.3.4），读侧按 (sessionId, seq)
 * 去重使重复折叠无害；`usage-archive.jsonl` 承接轮转出的老行（28.6.1）。
 *
 * 计量绝不影响会话：监听器同步段只做 Map 读写，append 异步；写路径失败
 * 吞错 + 1 分钟节流 warn（E7：dsh-session 本就逐监听者 contain）。
 *
 * @module dsh-eteams/runtime/usage
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { ETeamsResolvedConfig } from '../config.js';
import { atomicWriteText, listTeams } from '../state/store.js';
import { parseJsonl } from '../state/events.js';
import { captainChildTeamOf } from './captainAgent.js';
import { getSessionTeamId } from './sessionTeam.js';
import type { RuntimeLogger } from './base.js';

// ---------- 行模型（28.3.1） ----------

/** 五级归属角色（28.3.2 优先级表；与 docs/27 投影表口径对齐）。 */
export type UsageRoleKind = 'captain' | 'captain-child' | 'member' | 'conversation' | 'workspace';

/** usage.jsonl 一行：一次携带 usage 的 assistant/message（记录时打快照）。 */
export interface UsageRecord {
  /** event.time（Unix ms）。 */
  readonly at: number;
  /** 记录时按宿主本地时区折算的日界（28.6.4）。 */
  readonly day: string;
  readonly sessionId: string;
  /** event.seq —— 读侧去重键之一。 */
  readonly seq: number;
  /** 记录时快照；无法归属时 null（workspace 桶，不进团队日历）。 */
  readonly teamId: string | null;
  /** 记录时快照；非成员为 null。 */
  readonly memberName: string | null;
  readonly roleKind: UsageRoleKind;
  /** 记录时快照（request/header·context 按会话折叠，28.3.3/E4）。 */
  readonly provider: string | null;
  readonly model: string | null;
  /** 不含缓存的输入（E1：billed input = 三者之和）。 */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** adapter 未上报时为 null（未知 ≠ 0）。 */
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  /** 不计入 totalTokens（28.3.3：与 output 的重叠语义待装机实测）。 */
  readonly reasoningTokens: number | null;
}

// ---------- 文件位置与轮转阈值 ----------

/** usage 台账主文件（工作区级，非 per-team）。 */
export function usageFile(stateRoot: string): string {
  return join(stateRoot, 'usage.jsonl');
}

/** 轮转出的老行归档（聚合时与主文件合并读，28.6.2）。 */
export function usageArchiveFile(stateRoot: string): string {
  return join(stateRoot, 'usage-archive.jsonl');
}

/** 重启对账水位（28.3.4）。 */
export function usageCheckpointFile(stateRoot: string): string {
  return join(stateRoot, 'usage-checkpoint.json');
}

/** 主文件轮转上限（28.6.1 双阈值之一）。 */
export const USAGE_ROTATE_MAX_BYTES = 2 * 1024 * 1024;
/** 老行搬出阈值（28.6.1：日历只查当前年 + 上一年）。 */
export const USAGE_ROTATE_MAX_AGE_DAYS = 730;
/** 轮转后主文件保留预算（尺寸触发的搬出量，留 25% 增长余量）。 */
export const USAGE_ROTATE_KEEP_BYTES = Math.floor((USAGE_ROTATE_MAX_BYTES * 3) / 4);
/** checkpoint 条目按会话最后活跃剪枝（28.3.4）。 */
export const USAGE_CHECKPOINT_TTL_DAYS = 30;

// ---------- 会话身份注册表（28.3.2） ----------

/** 解析后的会话身份（记录时写进行内，不引用活状态）。 */
export interface SessionIdentity {
  readonly teamId: string | null;
  readonly memberName: string | null;
  readonly roleKind: UsageRoleKind;
}

/**
 * 成员子代理注册表：childId → 团队/成员。由 installMemberRuntime 的 setup
 * hook 在每次 Activation（含 cold resume）登记（members.ts 先例：重启后
 * 重登记）。
 */
const memberSessions = new Map<string, { teamId: string; memberName: string }>();

/** Register one member child session (setup hook 调用，docs/28.7)。 */
export function registerMemberSession(
  childId: string,
  identity: { teamId: string; memberName: string },
): void {
  if (childId === '' || identity.teamId === '' || identity.memberName === '') return;
  memberSessions.set(childId, { teamId: identity.teamId, memberName: identity.memberName });
}

// ---------- 路线折叠缓存（28.3.3/E4） ----------

const routeCache = new Map<string, { provider: string; model: string }>();
/** 防御性上限：路线缓存按会话积累，超限整体清空（下个 request/header 重填）。 */
const ROUTE_CACHE_MAX = 10_000;

function rememberRoute(sessionId: string, provider: unknown, model: unknown): void {
  if (typeof provider !== 'string' || typeof model !== 'string') return;
  if (provider === '' || model === '') return;
  if (routeCache.size >= ROUTE_CACHE_MAX) routeCache.clear();
  routeCache.set(sessionId, { provider, model });
}

// ---------- 会话身份解析（28.3.2 优先级表） ----------

/**
 * 身份缓存（解析一次、缓存）：member/captain-child/binding 命中是内存注册表
 * 查询，captain 命中要读盘（listTeams）——全量短 TTL 缓存，避免活跃会话
 * 每事件读盘（28.3.2「解析失败短 TTL 缓存」同口径扩到正向命中；绑定可被
 * 用户随时解除，TTL 过期后按最新状态重解析）。
 */
const identityCache = new Map<string, { identity: SessionIdentity; at: number }>();
const IDENTITY_TTL_MS = 10_000;

/**
 * 归属优先级（28.3.2）：member → captain-child → captain → conversation →
 * workspace。与 tools/identity.ts resolveCaller（工具身份，绑定优先 +
 * 排除 completed）口径不同——usage 归属是历史记账：不过滤 completed
 * （已完成团队的历史消耗仍归该队），绑定排序按 docs/28 表格原文。
 */
async function resolveIdentity(sessionId: string, root: string): Promise<SessionIdentity> {
  const now = Date.now();
  const cached = identityCache.get(sessionId);
  if (cached !== undefined && now - cached.at < IDENTITY_TTL_MS) return cached.identity;
  let identity: SessionIdentity;
  // 1. 成员子代理注册表（setup hook 登记）
  const member = memberSessions.get(sessionId);
  if (member !== undefined) {
    identity = { teamId: member.teamId, memberName: member.memberName, roleKind: 'member' };
  } else {
    // 2. 领队子代理注册表（captainAgent.ts 现成可查）
    const childTeam = captainChildTeamOf(sessionId);
    if (childTeam !== undefined) {
      identity = { teamId: childTeam, memberName: null, roleKind: 'captain-child' };
    } else {
      // 3. 领队主会话：本工作区 team.json 比对 captainSessionId（读盘面）
      let captainTeamId: string | undefined;
      try {
        const teams = await listTeams(root);
        captainTeamId = teams.find((t) => t.captainSessionId === sessionId)?.id;
      } catch {
        // 读盘失败不归属（落 workspace 桶）；下次 TTL 过期重试
      }
      if (captainTeamId !== undefined) {
        identity = { teamId: captainTeamId, memberName: null, roleKind: 'captain' };
      } else {
        // 4. 面板团队绑定（sessionTeam.ts 现成可查）
        const bound = getSessionTeamId(sessionId);
        if (bound !== undefined) {
          identity = { teamId: bound, memberName: null, roleKind: 'conversation' };
        } else {
          // 5. 其余（未绑定对话/eteams-rolebuilder 一次性构建子代理/普通会话）
          identity = { teamId: null, memberName: null, roleKind: 'workspace' };
        }
      }
    }
  }
  if (identityCache.size >= ROUTE_CACHE_MAX) identityCache.clear();
  identityCache.set(sessionId, { identity, at: now });
  return identity;
}

/** Tests-only：清空模块级注册表与缓存（vitest 隔离）。 */
export function resetUsageMeterForTests(): void {
  memberSessions.clear();
  routeCache.clear();
  identityCache.clear();
  checkpoints.clear();
  checkpointLoaders.clear();
  for (const timer of checkpointTimers.values()) clearTimeout(timer);
  checkpointTimers.clear();
  rowsCache.clear();
  lastRotateCheck.clear();
}

// ---------- 串行追加队列（28.3.1 写入纪律） ----------

let queueTail: Promise<void> = Promise.resolve();
/** 模块级 logger（installUsageMeter 注入；写失败节流 warn 用）。 */
let meterLog: RuntimeLogger | undefined;
/** 写失败 1 分钟节流（28.3.1 写入纪律）。 */
let lastWriteWarnAt = 0;

function warnThrottled(message: string): void {
  const now = Date.now();
  if (now - lastWriteWarnAt < 60_000) return;
  lastWriteWarnAt = now;
  try {
    meterLog?.warn(message);
  } catch {
    // logger 自身失败也吞掉——计量绝不影响会话
  }
}

/**
 * Enqueue one write task; failures are swallowed + throttled-warned（返回
 * 任务自身的 Promise 供 reconcileAll 显式等待——失败的告警仍由链尾兜）。
 */
function enqueueWrite(task: () => Promise<void>): Promise<void> {
  const run = queueTail.then(task, task);
  queueTail = run.then(
    () => undefined,
    (error) => {
      warnThrottled(`eteams usage: 写入失败（降级继续）：${String(error)}`);
    },
  );
  return run;
}

/** Await the serial write queue（tests / 显式冲刷）。 */
export function usageWritesIdle(): Promise<void> {
  return queueTail;
}

// ---------- 日界与工作区解析 ----------

/** 记录时按宿主本地时区折算的日界（28.6.4）。 */
export function dayKeyOf(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 工作区解析回退（28-M1）：header.cwd 缺省回退 process.cwd()（members.ts:237
 * 同款），回退生效时 1 分钟节流 warn——防错桶静默。
 */
function workspaceOf(session: Session): string {
  const cwd = session.header?.cwd;
  if (typeof cwd === 'string' && cwd !== '') return cwd;
  warnCwdFallback();
  return process.cwd();
}

let lastCwdWarnAt = 0;

function warnCwdFallback(): void {
  const now = Date.now();
  if (now - lastCwdWarnAt < 60_000) return;
  lastCwdWarnAt = now;
  try {
    meterLog?.warn('eteams usage: 会话 header.cwd 缺省，usage 归属回退 process.cwd()（1 分钟节流）');
  } catch {
    // swallow
  }
}

// ---------- 水位（usage-checkpoint.json，28.3.4） ----------

/** 一条水位：会话已折叠到的 seq + 最后活跃时刻（剪枝依据）。 */
interface CheckpointEntry {
  lastSeq: number;
  lastActive: number;
}

/** root → (sessionId → entry)；惰性从盘加载（loaders 去重并发加载）。 */
const checkpoints = new Map<string, Map<string, CheckpointEntry>>();
const checkpointLoaders = new Map<string, Promise<void>>();
const checkpointTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** 水位文件写盘去抖：live 行逐行写盘太重，读侧去重使 5s 窗口无害。 */
const CHECKPOINT_DEBOUNCE_MS = 5000;

/** Load (and prune) one workspace's checkpoint map once. */
function ensureCheckpoints(root: string): Promise<void> {
  let loader = checkpointLoaders.get(root);
  if (loader === undefined) {
    loader = loadCheckpoints(root).catch(() => undefined);
    checkpointLoaders.set(root, loader);
  }
  return loader;
}

async function loadCheckpoints(root: string): Promise<void> {
  const map = new Map<string, CheckpointEntry>();
  try {
    const raw = await readFile(usageCheckpointFile(root), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, { lastSeq?: unknown; lastActive?: unknown }>;
    for (const [sessionId, entry] of Object.entries(parsed)) {
      const lastSeq = typeof entry?.lastSeq === 'number' ? entry.lastSeq : 0;
      const lastActive = typeof entry?.lastActive === 'number' ? entry.lastActive : 0;
      map.set(sessionId, { lastSeq, lastActive });
    }
  } catch {
    // 缺文件 / 撕裂 JSON：空表起家（对账从 0 折算，读侧去重兜底）
  }
  pruneCheckpoints(map);
  checkpoints.set(root, map);
}

/** 条目按会话最后活跃剪枝（保留 30 天，28.3.4）。 */
function pruneCheckpoints(map: Map<string, CheckpointEntry>): void {
  const cutoff = Date.now() - USAGE_CHECKPOINT_TTL_DAYS * 86_400_000;
  for (const [sessionId, entry] of map) {
    if (entry.lastActive < cutoff) map.delete(sessionId);
  }
}

/**
 * Advance one session's in-memory watermark（live 行与补折共用，单调 max）。
 * 持久化去抖 5s：宕机窗口内「行已写、水位未及写」由读侧 (sessionId, seq)
 * 去重兜住（28.3.4）。
 */
function advanceCheckpoint(root: string, sessionId: string, seq: number, at: number): void {
  const map = checkpoints.get(root);
  if (map === undefined) return; // loader 未完成：下一个事件再推进
  const prev = map.get(sessionId);
  const lastSeq = Math.max(prev?.lastSeq ?? 0, seq);
  const lastActive = Math.max(prev?.lastActive ?? 0, at);
  map.set(sessionId, { lastSeq, lastActive });
  scheduleCheckpointWrite(root);
}

/**
 * 水位写盘去抖（5s trailing）。unref 定时器不阻塞宿主退出；flush() 会绕过
 * 去抖直接冲刷（测试与关停面）。
 */
function scheduleCheckpointWrite(root: string): void {
  if (checkpointTimers.has(root)) return;
  const timer = setTimeout(() => {
    checkpointTimers.delete(root);
    void writeCheckpoints(root);
  }, CHECKPOINT_DEBOUNCE_MS);
  timer.unref?.();
  checkpointTimers.set(root, timer);
}

/** Serialize one checkpoint map (prune-then-write, atomic whole-file). */
function serializeCheckpoints(map: Map<string, CheckpointEntry>): string {
  pruneCheckpoints(map);
  const out: Record<string, CheckpointEntry> = {};
  for (const [sessionId, entry] of map) out[sessionId] = entry;
  return `${JSON.stringify(out)}\n`;
}

/** Write one workspace's checkpoint file atomically（28.3.4 整写小文件）。 */
async function writeCheckpoints(root: string): Promise<void> {
  const map = checkpoints.get(root);
  if (map === undefined) return;
  try {
    await mkdir(root, { recursive: true });
    await atomicWriteText(usageCheckpointFile(root), serializeCheckpoints(map));
  } catch (error) {
    warnThrottled(`eteams usage: 水位写盘失败（对账读侧去重兜底）：${String(error)}`);
  }
}

// ---------- 记账（usage.jsonl 追加 + 归属快照） ----------

/** Append one usage row (JSONL, tolerant read on the other side). */
async function appendUsageRow(root: string, row: UsageRecord): Promise<void> {
  await mkdir(root, { recursive: true });
  await appendFile(usageFile(root), `${JSON.stringify(row)}\n`, 'utf8');
}

/**
 * The firehose listener core (E7/E8/E18)：非 assistant/message·request/* 的
 * 事件第一行早退（28.6.6 热路径预算）。
 */
function onSessionEvent(session: Session, event: SessionEvent, config: ETeamsResolvedConfig): void {
  const type = event.type;
  if (type !== 'assistant/message' && type !== 'request/header' && type !== 'request/context') {
    return;
  }
  const sessionId = String(session.id);
  if (type === 'request/header') {
    // EpochHeader.config → provider/model（E4；按会话折叠）
    rememberRoute(sessionId, event.data.header?.config?.provider, event.data.header?.config?.model);
    return;
  }
  if (type === 'request/context') {
    // RequestContext：仅路线变化时记（E4），同样折叠
    rememberRoute(sessionId, event.data.provider, event.data.model);
    return;
  }
  // assistant/message：usage 缺失的 step 不记行（28.3.3，E2）
  const usage = event.data.usage;
  if (!usage) return;
  const workspace = workspaceOf(session);
  const root = join(workspace, config.stateDir);
  const route = routeCache.get(sessionId) ?? null;
  const at = event.time;
  const seq = event.seq;
  enqueueWrite(async () => {
    const identity = await resolveIdentity(sessionId, root);
    const row: UsageRecord = {
      at,
      day: dayKeyOf(at),
      sessionId,
      seq,
      teamId: identity.teamId,
      memberName: identity.memberName,
      roleKind: identity.roleKind,
      provider: route?.provider ?? null,
      model: route?.model ?? null,
      inputTokens: Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0,
      outputTokens: Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0,
      cacheReadTokens: toNullableCount(usage.cacheReadTokens),
      cacheWriteTokens: toNullableCount(usage.cacheWriteTokens),
      reasoningTokens: toNullableCount(usage.reasoningTokens),
    };
    await appendUsageRow(root, row);
    advanceCheckpoint(root, sessionId, seq, at);
    void maybeRotate(root);
  });
}

/** Optional count → null（未知）或非负整数。 */
function toNullableCount(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * 重启对账补折（28.3.4）：session/created（E10）+ 装机 ctx.sessions.list()
 * （E10/E18）。折算「先查水位」，seq > lastSeq 的 assistant/message 才记行；
 * 折算完推进水位到已检查的最大 seq。构造种子不重发（E9）→ 重启天然不双计。
 */
function enqueueReconcile(session: Session, config: ETeamsResolvedConfig): void {
  enqueueWrite(async () => {
    await foldSession(session, config);
  });
}

/** Fold one session's log beyond the watermark (usage rows + checkpoint). */
async function foldSession(session: Session, config: ETeamsResolvedConfig): Promise<void> {
  const workspace = workspaceOf(session);
  const root = join(workspace, config.stateDir);
  await ensureCheckpoints(root);
  const sessionId = String(session.id);
  const last = checkpoints.get(root)?.get(sessionId)?.lastSeq ?? 0;
  const pendingRows: Omit<UsageRecord, 'teamId' | 'memberName' | 'roleKind'>[] = [];
  let maxSeq = last;
  for (const event of session.events) {
    if (event.seq <= last) continue;
    if (event.seq > maxSeq) maxSeq = event.seq;
    if (event.type !== 'assistant/message') continue;
    const usage = event.data.usage;
    if (!usage) continue;
    const route = routeCache.get(sessionId) ?? null;
    pendingRows.push({
      at: event.time,
      day: dayKeyOf(event.time),
      sessionId,
      seq: event.seq,
      provider: route?.provider ?? null,
      model: route?.model ?? null,
      inputTokens: Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0,
      outputTokens: Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0,
      cacheReadTokens: toNullableCount(usage.cacheReadTokens),
      cacheWriteTokens: toNullableCount(usage.cacheWriteTokens),
      reasoningTokens: toNullableCount(usage.reasoningTokens),
    });
  }
  if (pendingRows.length > 0) {
    // 归属解析一次一批（同会话同身份），写死进行内（28.3.2 快照不引用）：
    // 占位行补上身份三元组后即为完整 UsageRecord
    const identity = await resolveIdentity(sessionId, root);
    const completeRows: UsageRecord[] = pendingRows.map((row) => ({
      ...row,
      teamId: identity.teamId,
      memberName: identity.memberName,
      roleKind: identity.roleKind,
    }));
    for (const row of completeRows) await appendUsageRow(root, row);
  }
  // 无 pending 也推进水位（避免每次对账重扫全量日志）
  advanceCheckpoint(root, sessionId, maxSeq, maxSeq > last ? lastEventTime(session) : Date.now());
}

/** The session's last event time (checkpoint lastActive source). */
function lastEventTime(session: Session): number {
  const events = session.events;
  return events.length > 0 ? (events[events.length - 1]?.time ?? 0) : 0;
}

// ---------- 轮转（28.6.1 双阈值） ----------

const lastRotateCheck = new Map<string, number>();

/** 尺寸检查节流（60s 一次 stat），到点才入队轮转任务。 */
function maybeRotate(root: string): void {
  const now = Date.now();
  if (now - (lastRotateCheck.get(root) ?? 0) < 60_000) return;
  lastRotateCheck.set(root, now);
  enqueueWrite(async () => {
    try {
      if (await rotateUsage(root)) {
        try {
          meterLog?.info?.(`eteams usage: usage.jsonl 轮转完成 → usage-archive.jsonl`);
        } catch {
          // swallow
        }
      }
    } catch (error) {
      warnThrottled(`eteams usage: 轮转失败（下次再试）：${String(error)}`);
    }
  });
}

/**
 * 双阈值轮转（28.6.1）：主文件超 2MB 或含 >730 天前的行时，把老行搬入
 * usage-archive.jsonl（atomicWriteText 整写 + 原子交接；轮转间隔内的崩溃
 * 重复搬入由读侧 (sessionId, seq) 去重兜住）。测试可注入小阈值。
 */
export async function rotateUsage(
  root: string,
  opts?: { maxBytes?: number; maxAgeDays?: number },
): Promise<boolean> {
  const maxBytes = opts?.maxBytes ?? USAGE_ROTATE_MAX_BYTES;
  const maxAgeDays = opts?.maxAgeDays ?? USAGE_ROTATE_MAX_AGE_DAYS;
  const mainFile = usageFile(root);
  if (!existsSync(mainFile)) return false;
  const stats = statSync(mainFile);
  if (stats.size <= 0) return false;
  const rows = parseJsonl<UsageRecord>(readFileSync(mainFile, 'utf8'));
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const overSize = stats.size > maxBytes;
  // 行序即时间序（追加写）。自尾向前扫描决定保留段：老行触界即停（该行及
  // 更早全搬出）；尺寸触界时保留最新 KEEP_BYTES 内的行。
  let keepFrom = rows.length;
  let keptBytes = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (row.at < cutoff) break;
    if (overSize && keptBytes + size > USAGE_ROTATE_KEEP_BYTES) break;
    keptBytes += size;
    keepFrom = i;
  }
  if (keepFrom <= 0) return false; // 无老行可搬（含空文件）：纯 no-op
  const moved = rows.slice(0, keepFrom);
  const kept = rows.slice(keepFrom);
  // 归档 = 既有归档行 + 本次搬出行（整写；崩溃在两写之间 → 主文件仍含老行，
  // 下次轮转重搬，读侧去重无害）
  const archiveRows = readUsageRows(usageArchiveFile(root), false);
  archiveRows.push(...moved);
  await mkdir(root, { recursive: true });
  await atomicWriteText(usageArchiveFile(root), serializeRows(archiveRows));
  await atomicWriteText(mainFile, serializeRows(kept));
  return true;
}

/** Serialize rows back to JSONL（空表 → 空文件）。 */
function serializeRows(rows: readonly UsageRecord[]): string {
  return rows.length === 0 ? '' : `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

// ---------- 读取与聚合（28.4） ----------

/** mtime+size 未变则复用上次解析结果（28.4 进程内缓存兜底高频请求）。 */
const rowsCache = new Map<string, { mtimeMs: number; size: number; rows: UsageRecord[] }>();

/** Tolerantly read one usage file（撕裂尾行丢弃）；cache=true 走 mtime/size 缓存。 */
function readUsageRows(file: string, cache: boolean): UsageRecord[] {
  if (!existsSync(file)) return [];
  if (cache) {
    try {
      const stats = statSync(file);
      const hit = rowsCache.get(file);
      if (hit !== undefined && hit.mtimeMs === stats.mtimeMs && hit.size === stats.size) {
        return hit.rows;
      }
      const rows = parseJsonl<UsageRecord>(readFileSync(file, 'utf8'));
      rowsCache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, rows });
      return rows;
    } catch {
      return [];
    }
  }
  try {
    return parseJsonl<UsageRecord>(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/** One aggregated calendar day（28.4 响应模型；calls = 记账行数）。 */
export interface UsageDayAgg {
  readonly date: string;
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly calls: number;
}

/** 聚合期间的累加单元（只读输出经 freeze-free 浅拷贝产出）。 */
interface MutableUsageDay {
  date: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  calls: number;
}

/** Year totals（28.4；firstDay/lastDay 为有数据首末日，无数据 null）。 */
export interface UsageTotals {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly calls: number;
  readonly firstDay: string | null;
  readonly lastDay: string | null;
}

/** One workspace's calendar aggregate（读取时聚合，不落盘日汇总，28.4）。 */
export function readUsageCalendar(
  stateRoot: string,
  teamId: string,
  year: number,
): { days: UsageDayAgg[]; totals: UsageTotals } {
  // 全年格子先建齐（无数据日 totalTokens:0，1/1 起至 12/31；未来年同构）
  const acc = new Map<string, MutableUsageDay>();
  for (let month = 0; month < 12; month += 1) {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${year}-${pad2(month + 1)}-${pad2(day)}`;
      acc.set(date, {
        date,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        calls: 0,
      });
    }
  }
  // 读主文件 + 归档（28.6.2：上一年数据可能已轮转出主文件），全局 (sessionId,seq)
  // 去重后过滤 teamId/year
  const seen = new Set<string>();
  const rows = [...readUsageRows(usageFile(stateRoot), true), ...readUsageRows(usageArchiveFile(stateRoot), true)];
  for (const row of rows) {
    const dedupKey = `${row.sessionId}#${row.seq}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    if (row.teamId !== teamId) continue;
    if (!row.day.startsWith(`${year}-`)) continue;
    const cell = acc.get(row.day);
    if (cell === undefined) continue; // 防御：越界/畸形 day 丢弃
    cell.totalTokens += row.inputTokens + row.outputTokens + (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0);
    cell.inputTokens += row.inputTokens;
    cell.outputTokens += row.outputTokens;
    cell.cacheReadTokens += row.cacheReadTokens ?? 0;
    cell.cacheWriteTokens += row.cacheWriteTokens ?? 0;
    cell.reasoningTokens += row.reasoningTokens ?? 0;
    cell.calls += 1;
  }
  const days = [...acc.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const totals = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    calls: 0,
    firstDay: null as string | null,
    lastDay: null as string | null,
  };
  for (const day of days) {
    totals.totalTokens += day.totalTokens;
    totals.inputTokens += day.inputTokens;
    totals.outputTokens += day.outputTokens;
    totals.cacheReadTokens += day.cacheReadTokens;
    totals.cacheWriteTokens += day.cacheWriteTokens;
    totals.reasoningTokens += day.reasoningTokens;
    totals.calls += day.calls;
    if (day.totalTokens > 0) {
      if (totals.firstDay === null) totals.firstDay = day.date;
      totals.lastDay = day.date;
    }
  }
  return { days, totals };
}

// ---------- 安装（docs/28.7：src/host/index.ts apply() 调用） ----------

/** Meter handle: serial-queue flush + explicit reconcile（tests / 关停面）。 */
export interface UsageMeterHandle {
  /** Await pending writes; flush debounced checkpoints immediately. */
  flush(): Promise<void>;
  /** Fold all live sessions now（装机对账的显式入口）。 */
  reconcileAll(): Promise<void>;
}

/**
 * Root-scope firehose listener + watermark reconciliation (docs/28.2.3 方案
 * A; E18 dsh-session-persistence 同型先例). 失败一律不外抛：计量绝不影响
 * 会话与装机。
 */
export function installUsageMeter(ctx: Context, config: ETeamsResolvedConfig): UsageMeterHandle {
  meterLog = (ctx as unknown as { logger: RuntimeLogger }).logger;
  // 1) 全进程事件 firehose（untagged listener，E7/E8）
  ctx.on('session/event', (session, event) => {
    try {
      onSessionEvent(session as Session, event as SessionEvent, config);
    } catch (error) {
      warnThrottled(`eteams usage: 监听器异常（不影响会话）：${String(error)}`);
    }
  });
  // 2) 冷恢复会话的种子补折（E9 种子不重发；E10 session/created）
  ctx.on('session/created', (session) => {
    try {
      enqueueReconcile(session as Session, config);
    } catch (error) {
      warnThrottled(`eteams usage: session/created 对账失败：${String(error)}`);
    }
  });
  const sessionsOf = (): Session[] => {
    try {
      const list = (ctx as unknown as { sessions?: { list(): Session[] } }).sessions?.list();
      return Array.isArray(list) ? list : [];
    } catch {
      return []; // sessions 服务缺失（headless 等）：装机对账跳过
    }
  };
  // 3) 装机对账（E10/E18）：ctx.sessions.list() 的活会话补折——走同一串行
  //    队列，与 live 行互不乱序。
  void enqueueWrite(() => reconcileSessions(sessionsOf(), config));
  return {
    flush: async () => {
      await usageWritesIdle();
      // 绕过去抖直接冲刷水位写盘
      for (const root of [...checkpointTimers.keys()]) {
        const timer = checkpointTimers.get(root);
        if (timer !== undefined) clearTimeout(timer);
        checkpointTimers.delete(root);
        await writeCheckpoints(root);
      }
    },
    reconcileAll: async () => {
      // 与 live 行同串行队列：直接跑会与队列里的 foldSession 并发读同一水位
      // → 双倍追加（读侧去重能兜，但文件会重复行）。
      await enqueueWrite(async () => {
        await ensureCheckpointsAcross(sessionsOf(), config);
        await reconcileSessions(sessionsOf(), config);
      });
    },
  };
}

/** Eager-load checkpoint maps for every live session's workspace. */
async function ensureCheckpointsAcross(sessions: Session[], config: ETeamsResolvedConfig): Promise<void> {
  await Promise.all(
    sessions.map((session) => ensureCheckpoints(join(workspaceOf(session), config.stateDir))),
  );
}

/** Fold every live session through the watermark（装机对账）。 */
async function reconcileSessions(
  sessions: Session[],
  config: ETeamsResolvedConfig,
): Promise<void> {
  for (const session of sessions) {
    try {
      await foldSession(session, config);
    } catch (error) {
      warnThrottled(`eteams usage: 对账失败（session ${String(session.id)}）：${String(error)}`);
    }
  }
}