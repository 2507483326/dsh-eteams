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
 * 存储（docs/40，2026-09-05 用户迭代简化版）：SQLite 两表即唯一存储——
 * usage_detail（明细，一次带 usage 的模型回复步一行）+ usage_daily_total
 * （总和，一天一行，增量 upsert）。无文件台账、无水位对账、无轮转：监听
 * 器看到的每个事件实时入库（失败节流 warn 降级继续）；重启前的历史不回
 * 补，存量 usage.jsonl 等文件保留在盘但不再读写。
 *
 * 计量绝不影响会话：监听器同步段只做 Map 读写，入库走串行队列；写路径失败
 * 吞错 + 1 分钟节流 warn（E7：dsh-session 本就逐监听者 contain）。
 *
 * @module dsh-eteams/runtime/usage
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { ETeamsResolvedConfig } from '../config.js';
import { getDb } from '../state/db.js';
import {
  mergeUsageCalendars,
  readUsageDays,
  recordUsage,
  type UsageDayAgg,
  type UsageRecord,
  type UsageRoleKind,
  type UsageTotals,
} from '../state/usageStore.js';
import { listTeams } from '../state/store.js';
import { captainChildTeamOf } from './captainAgent.js';
import { getSessionTeamId } from './sessionTeam.js';
import { leaderRowOf } from './notifier.js';
import { stateRootFor, type RuntimeLogger } from './base.js';

// ---------- 行模型（docs/40；类型本体在 state/usageStore，此处转出兼容） ----------

export type {
  UsageRoleKind,
  UsageRecord,
  UsageDayAgg,
  UsageTotals,
} from '../state/usageStore.js';

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
      // 3. 领队主会话：本工作区团队快照比对领队行 main_session_id（领队锚点
      //    docs/36 建议 3；team.captainSessionId 字段已随锚点迁入领队行）
      let captainTeamId: string | undefined;
      try {
        const teams = await listTeams(root);
        const hit = teams.find((t) => {
          const leader = leaderRowOf(t);
          return leader !== undefined && leader.mainSessionId === sessionId;
        });
        if (hit !== undefined) captainTeamId = String(hit.id);
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
          // 5. 其余（未绑定对话/eteams-rolebuilder 持续构建子代理/普通会话）
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
 * 任务自身的 Promise 供测试显式等待——失败的告警仍由链尾兜）。
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
    meterLog?.warn(
      'eteams usage: 会话 header.cwd 缺省，usage 归属回退 process.cwd()（1 分钟节流）',
    );
  } catch {
    // swallow
  }
}

// ---------- 记账（SQLite 两表入库，docs/40） ----------

/** Persist one usage row（明细 INSERT + 当日总和增量 upsert，单事务）。 */
function persistUsageRow(root: string, row: UsageRecord): void {
  recordUsage(getDb(root), row);
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
  const root = stateRootFor(config, workspace);
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
    persistUsageRow(root, row);
  });
}

/** Optional count → null（未知）或非负整数。 */
function toNullableCount(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

// ---------- 读取与聚合（docs/40：SQLite 直查） ----------

/** 团队口径：usage_detail 按 team_key 聚合（全年零填充日格，docs/40）。 */
export function readUsageCalendar(
  stateRoot: string,
  teamId: string,
  year: number,
): { days: UsageDayAgg[]; totals: UsageTotals } {
  return readUsageDays(getDb(stateRoot), year, { teamId });
}

/**
 * 全应用口径（2026-09-05 用户迭代：看板「Token 消耗」卡展示整体应用每天
 * 的消耗）：usage_daily_total 直读（行即全应用日总和），多根合并。
 */
export function readAppUsageCalendar(
  roots: readonly string[],
  year: number,
): { days: UsageDayAgg[]; totals: UsageTotals } {
  const parts = roots.map((root) => readUsageDays(getDb(root), year));
  if (parts.length === 1) return parts[0]!;
  return mergeUsageCalendars(parts);
}

// ---------- 安装（docs/28.7：src/host/index.ts apply() 调用） ----------

/**
 * Root-scope firehose listener（docs/28.2.3 方案 A；E18 同型先例）：非
 * assistant/message·request/* 事件第一行早退。失败一律不外抛——计量绝不
 * 影响会话与装机。无对账/无 flush（docs/40：重启前历史不回补，写经串行
 * 队列实时入库，测试用 usageWritesIdle 等排空）。
 */
export function installUsageMeter(ctx: Context, config: ETeamsResolvedConfig): void {
  meterLog = (ctx as unknown as { logger: RuntimeLogger }).logger;
  ctx.on('session/event', (session, event) => {
    try {
      onSessionEvent(session as Session, event as SessionEvent, config);
    } catch (error) {
      warnThrottled(`eteams usage: 监听器异常（不影响会话）：${String(error)}`);
    }
  });
}
