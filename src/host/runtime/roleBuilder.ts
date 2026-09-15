/**
 * Build-session state (docs/19.6.2/19.9.1, D18-5): one workspace-level slot
 * in `<stateRoot>/rolebuilder.json` tracking a conversational member build.
 * The Role Builder reports steps via `eteams_build_report`; the panel polls
 * `GET /eteams-api/rolebuilder` and confirms via `POST .../confirm` (D18-6).
 * Pure Node — no cordis.
 *
 * @module dsh-eteams/runtime/roleBuilder
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripFrontmatter } from '../state/db.js';
import { atomicWriteText } from '../state/store.js';
import { avatarSeedFor, upsertRosterMember } from './roster.js';
import type { BuildPhaseKind } from '../prompts/spawn/builderPhases.js';

export type BuildStatus = 'active' | 'awaiting_confirmation' | 'confirmed' | 'cancelled';

/**
 * One persona draft — field names align 1:1 with `eteams_member_save`
 * params so the confirm path can persist it verbatim (docs/19.9.3).
 */
export interface BuildDraft {
  name: string;
  role: string;
  /** 一句话简介（列表卡片/详情头展示用）。 */
  profile?: string;
  duty?: string;
  style?: string;
  skills?: string;
  rules?: string[];
  executionPrompt?: string;
  personaMd?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  /**
   * Pre-assigned avatar pair (docs/14): generated once when the draft first
   * gets a name, so the face is stable from card/preview through confirm.
   */
  avatar?: { seed: number; salt: number };
}

/** One build session (docs/19.9.1). */
export interface BuildSession {
  schemaVersion: 1;
  /** Session identity — set once at creation, never merged over. */
  startedAt: number;
  status: BuildStatus;
  step: string;
  stepsDone: string[];
  request: string;
  draft: BuildDraft | null;
  note: string;
  updatedAt: number;
  /** Pending/answered intent interview (docs/19.16). */
  interview?: InterviewState;
  /**
   * 归属标识：发起本次构建的 /eteam 命令调用 id（每次构建唯一）。会话
   * 身份字段——创建时写入，合并永不覆盖（与 startedAt 同语义）。
   */
  commandId?: string;
  /**
   * 派发锁：本会话已派发的受理代理（start）与派发时刻（docs/19.16 持续
   * 构建子代理——重启/续聊走 followup 唤醒，不再占本锁；'restart' 值保留
   * 兼容旧会话数据，现无写入方）。60 秒内二次受理一律拒绝——受理路径
   * （/eteam 处理器 / build_dispatch 工具）竞态或重放时，不允许再起一个
   * 并行子代理。newBuild 新会话即新锁。
   */
  phaseSpawn?: 'start' | 'restart';
  phaseSpawnAt?: number;
  /**
   * 当前持有本构建的持续子代理 durable 会话 id（docs/19.16 持续构建子代理
   * 迭代）：受理时 `startContinuable` 建立后写入；后续环节（访谈答案中转/
   * 恢复/重启）宿主经 `followup` 送进同一子代理。宿主重启或会话记录被回收
   * 后 followup 失败 → 以快照提示词重建新子代理并**覆盖**旧值（重建 =
   * 新持有者接手同一构建；其余路径只读不写）。
   */
  builderChildId?: string;
  /**
   * 最近一次 followup 唤醒的去重键（如 `${startedAt}:${answeredAt}`）：面板
   * 路由与主对话工具两个入口竞态时第二个直接跳过。落盘（非模块变量）才
   * 跨构建互不踩、宿主重启后仍有效。
   */
  builderWakeKey?: string;
  /**
   * 最近一次派发/唤醒的回合种类（markBuilderTurn 写入）：eteams_build_guide
   * 据此返回 turn——可见提示词不带回合任务，模型领规程时取决策表分支。
   * 旧会话无此字段时工具回退 'start'（受理开局语义）。
   */
  wakeKind?: BuildPhaseKind;
}

interface BuildFile {
  schemaVersion: 1;
  session: BuildSession | null;
}

/**
 * Allowed transitions (docs/19.9.1): active → awaiting_confirmation →
 * confirmed | cancelled. Self-transitions carry step/draft updates;
 * confirmed/cancelled are terminal (a new build opens a new session).
 */
const TRANSITIONS: Record<BuildStatus, BuildStatus[]> = {
  active: ['active', 'awaiting_confirmation', 'cancelled'],
  awaiting_confirmation: ['awaiting_confirmation', 'confirmed', 'cancelled'],
  confirmed: [],
  cancelled: [],
};

/**
 * 构建时间线的规范步骤序（与客户端面板 buildDraft BUILD_STEPS 逐字对齐，
 * docs/19.6.2）：播报步骤名必须用这里的字面量，面板蓝点才点得亮。
 * stepsDone 由宿主按当前步骤推导——不信任模型自报的已完成列表（用户反馈
 * 2026-09-08：模型把 stepsDone 报成 ['意图访谈'] 整体替换，前两步蓝点丢失、
 * 时间线乱序）。
 */
export const BUILD_STEP_ORDER: readonly string[] = [
  '收到需求',
  '查重角色库',
  '意图访谈',
  '起草统一手册',
  '深化领域章节',
  '完成草稿',
];

/** 旧提示词/旧会话用过的步骤名 → 规范名（播报名漂移容忍）。 */
const STEP_ALIASES: Record<string, string> = {
  查重成员库: '查重角色库',
};

/**
 * 归一播报步骤名到规范名（别名映射，其余原样）——落盘会话统一用规范名，
 * 客户端时间线按字面匹配才能点亮。
 */
function canonicalStep(step: string): string {
  return STEP_ALIASES[step] ?? step;
}

/**
 * 按当前步骤推导已完成前缀：当前步之前的全部视为完成，「收到需求」随受理
 * 即时完成（受理即建会话，该步不存在中间态）；不在时间线上的步骤（重启
 * 核查/继续构建等）返回 null = 不推导、沿用原列表。
 */
function deriveStepsDone(step: string): string[] | null {
  const idx = BUILD_STEP_ORDER.indexOf(canonicalStep(step));
  if (idx < 0) return null;
  return BUILD_STEP_ORDER.slice(0, Math.max(idx, 1)) as string[];
}

/** Absolute build-session file path for a state root. */
export function roleBuilderFile(stateRoot: string): string {
  return join(stateRoot, 'rolebuilder.json');
}

/**
 * Side-car file remembering which main-session agent spawned the current
 * build (docs/19.16): host routes (interview answers / resume) need a live
 * parent Agent to attribute followup wakes to. Written on every spawn.
 * The BUILDER CHILD id lives in the session file (`builderChildId`) —
 * continuable children are interrupt/followup handles（确认不再代收，停驻
 * 子代理自行看到终态静默收束，docs/19.17.1）.
 */
function parentRefFile(stateRoot: string): string {
  return join(stateRoot, 'rolebuilder-parent.json');
}

/** Remember the spawning main-session id (followup-wake attribution). */
export async function setBuildParentSession(
  stateRoot: string,
  parentSessionId: string,
): Promise<void> {
  await atomicWriteText(parentRefFile(stateRoot), `${JSON.stringify({ parentSessionId }, null, 2)}\n`);
}

/** Read the remembered main-session id, if any. */
export function readBuildParentSession(stateRoot: string): string | null {
  const file = parentRefFile(stateRoot);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { parentSessionId?: unknown };
    return typeof parsed.parentSessionId === 'string' && parsed.parentSessionId !== ''
      ? parsed.parentSessionId
      : null;
  } catch {
    return null;
  }
}

/** Read the session; missing file yields null. Transient read/parse failures
 * (Windows rename-swap vs concurrent open) are retried before giving up —
 * a gate that mistakes 「读不准」 for 「没有构建」 would double-accept. */
export function readBuildSession(stateRoot: string): BuildSession | null {
  const file = roleBuilderFile(stateRoot);
  if (!existsSync(file)) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<BuildFile>;
      return parsed.session ?? null;
    } catch {
      if (attempt < 2 && existsSync(file)) {
        const dead = Date.now() + 30;
        while (Date.now() < dead) {
          /* busy-wait ~30ms then retry */
        }
        continue;
      }
      return null;
    }
  }
  return null;
}

/** Whether a session file exists on disk（门禁配套：存在但读不出 = 忙，不是空）。 */
export function hasBuildSessionFile(stateRoot: string): boolean {
  return existsSync(roleBuilderFile(stateRoot));
}

/** 客户端活跃会话心跳落盘（last-writer-wins）：兜底 steer 用它定位「用户
 * 正在看的对话」。会话槽同目录，随工作区走。 */
const presenceFile = (stateRoot: string): string => join(stateRoot, 'presence.json');

/** Record the client-reported active conversation id. */
export async function writeBuildPresence(
  stateRoot: string,
  sessionId: string,
): Promise<void> {
  await atomicWriteText(presenceFile(stateRoot), JSON.stringify({ sessionId, ts: Date.now() }));
}

/** Read the last reported active conversation (null when absent/stale/malformed). */
export function readBuildPresence(
  stateRoot: string,
  maxAgeMs = 60_000,
): { sessionId: string; ts: number } | null {
  const file = presenceFile(stateRoot);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      sessionId?: unknown;
      ts?: unknown;
    };
    if (typeof parsed.sessionId !== 'string' || parsed.sessionId === '') return null;
    const ts = typeof parsed.ts === 'number' ? parsed.ts : 0;
    if (Date.now() - ts > maxAgeMs) return null;
    return { sessionId: parsed.sessionId, ts };
  } catch {
    return null;
  }
}

/** One `eteams_build_report` payload (all fields optional). */
export interface BuildReport {
  status?: BuildStatus;
  step?: string;
  stepsDone?: string[];
  request?: string;
  draft?: BuildDraft;
  note?: string;
  /**
   * Publish an intent interview (2026-09-10 unified ask): the builder child
   * posts its questions here for the record, then pops them itself via
   * eteams_ask_user — answers land back by the host automatically.
   */
  interview?: { questions: InterviewQuestion[] };
  /**
   * Marks a deliberate brand-new build (the /eteam handler opening over a
   * terminal session). Ordinary builder reports never set this — so a
   * cancelled session cannot be resurrected by a late background report.
   */
  newBuild?: boolean;
  /**
   * 归属标识（用户迭代：每张卡片只跟自己的构建）：/eteam 命令处理器把
   * 本次调用的 commandId 写进新会话，对话内卡片按它匹配归属——非本构建
   * 的历史卡片显示「已结束」而不是跟着新构建的状态跑。
   */
  commandId?: string;
}

/** 草稿标量字段全集（sanitizeReportDraft 逐一验型；rules/avatar 另行处理）。 */
const DRAFT_STRING_KEYS = [
  'name',
  'role',
  'profile',
  'duty',
  'style',
  'skills',
  'executionPrompt',
  'personaMd',
  'provider',
  'model',
  'reasoningEffort',
] as const;

/**
 * 上报草稿归一（写路径纪律）：`eteams_build_report.draft` 是模型自由上报的
 * 浅合并对象，「字段渐次呈现」是设计行为——缺字段合法，但错类型/null 不许
 * 落盘。非字符串的标量字段与非法 rules 一律视同本轮未上报剔除（合并语义下
 * 缺失键保留旧值）；否则坏值会经 GET /rolebuilder 直达面板，DraftPreview /
 * 确认表单在 value.trim() 处崩掉整块（2026-09-10 实况：构建师漏报名字）。
 */
function sanitizeReportDraft(draft: BuildDraft): BuildDraft {
  const out = { ...draft } as Record<string, unknown>;
  for (const key of DRAFT_STRING_KEYS) {
    if (out[key] !== undefined && typeof out[key] !== 'string') delete out[key];
  }
  // frontmatter 不进 persona_md（与 personaToMd 写库口径一致）：上报边沿就把
  // 手册开头的 YAML 围栏剥掉，草稿/预览/确认页与落库内容一致，读路径按普通
  // Markdown 原样读出，两端都不必再判断「这段是不是 frontmatter」。
  if (typeof out.personaMd === 'string') {
    out.personaMd = stripFrontmatter(out.personaMd.trim()).trim();
  }
  if (out.rules !== undefined) {
    const rules = Array.isArray(out.rules)
      ? out.rules.filter((r): r is string => typeof r === 'string')
      : null;
    if (rules === null || rules.length === 0) delete out.rules;
    else out.rules = rules;
  }
  return out as unknown as BuildDraft;
}

/**
 * 待确认守卫（docs/19.17.2 + 19.19）：报告把会话置为 awaiting_confirmation
 * 时，解析后的草稿必须带非空 personaMd（人设手册全文）、非空 name（角色名
 * ——确认页与入库都以它为键，缺名会让确认表单/列表卡片拿 undefined 去
 * trim）与非空 profile（一句话简介）——确认页直接渲染这三个字段，空值=
 * 用户看到「显示完成但没有内容」（用户迭代 2026-09-06：profile 漏报曾静默
 * 进待确认，确认页简介列空）。顺序钉死 personaMd 先查、profile 后查
 * （19.17.2 既有用例按 /personaMd/ 断言，profile 先查会错配）。start/
 * continue/restart 各回合提示词已要求完整草稿一次报全，本守卫是最后一道
 * 硬闸。
 */
function requireAwaitingDraft(draft: BuildDraft | null): void {
  if (draft === null || (draft.personaMd ?? '').trim() === '') {
    throw new Error('人设手册（personaMd）不能为空——请把完整手册全文随草稿一并上报后再置待确认');
  }
  if ((draft.name ?? '').trim() === '') {
    throw new Error('角色名（name）不能为空——请把定下的名字随草稿一并上报后再置待确认');
  }
  if ((draft.profile ?? '').trim() === '') {
    throw new Error('简介（profile）不能为空——请从手册提炼一句话随草稿一并上报后再置待确认');
  }
}

/**
 * Merge one report into the session slot. A terminal session accepts only
 * an explicit `newBuild: true` (which opens a NEW session, 覆盖); anything
 * else on a terminal session is rejected. `draft` merges shallowly so
 * partial field reports accumulate (docs/19.6.2).
 */
export async function reportBuildProgress(
  stateRoot: string,
  report: BuildReport,
): Promise<BuildSession> {
  const now = Date.now();
  // 草稿写路径先归一（null = 本轮未上报草稿，合并语义下保旧值）。
  const sanitizedDraft = report.draft !== undefined ? sanitizeReportDraft(report.draft) : null;
  // 播报步骤名归一 + 按规范时间线推导已完成前缀（canonical 步骤命中时推导
  // 压过模型自报的 stepsDone——蓝点只由宿主判定，模型报错名也不再乱序）。
  const step = report.step !== undefined ? canonicalStep(report.step) : undefined;
  const derived = step !== undefined ? deriveStepsDone(step) : null;
  // 显式 newBuild = 开一个全新构建：无条件覆盖任何现有会话（含待确认——
  // 新请求让位旧草稿，与 /eteam 处理器语义一致）。后台构建代理被纪律禁止
  // 传该标记，其迟到播报仍走下方终态守卫（docs/19.16）。
  if (report.newBuild === true) {
    if (report.status === 'awaiting_confirmation') requireAwaitingDraft(sanitizedDraft);
    const fresh: BuildSession = {
      schemaVersion: 1,
      startedAt: now,
      status: 'active',
      step: step ?? '收到需求',
      stepsDone: derived ?? report.stepsDone ?? [],
      request: report.request ?? '',
      draft: ensureDraftAvatar(sanitizedDraft),
      note: report.note ?? '',
      ...(report.interview !== undefined ? { interview: interviewOf(report) } : {}),
      ...(report.commandId !== undefined ? { commandId: report.commandId } : {}),
      updatedAt: now,
    };
    await writeSession(stateRoot, fresh);
    return fresh;
  }
  const current = readBuildSession(stateRoot);
  const requested = report.status ?? current?.status ?? 'active';
  const terminal =
    current !== null && (current.status === 'confirmed' || current.status === 'cancelled');
  // Non-terminal sessions follow the transition table; terminal sessions are
  // only ever replaced by a brand-new build (status 'active', docs/19.9.1).
  if (current !== null && !terminal && !TRANSITIONS[current.status].includes(requested)) {
    throw new Error(`非法状态迁移：${current.status} → ${requested}`);
  }
  if (terminal) {
    // 已结束的会话只允许显式 newBuild 开新局——防止后台构建代理的迟到播报
    // 把用户已放弃/已入库的构建复活（docs/19.16）。
    throw new Error(`构建会话已结束（${current?.status}），普通播报不再写入`);
  }
  if (current === null) {
    if (requested !== 'active') {
      throw new Error(`无法以 ${requested} 开启构建会话（首轮状态必须为 active）`);
    }
    const fresh: BuildSession = {
      schemaVersion: 1,
      startedAt: now,
      status: 'active',
      step: step ?? '收到需求',
      stepsDone: derived ?? report.stepsDone ?? [],
      request: report.request ?? '',
      draft: ensureDraftAvatar(sanitizedDraft),
      note: report.note ?? '',
      ...(report.interview !== undefined ? { interview: interviewOf(report) } : {}),
      updatedAt: now,
    };
    await writeSession(stateRoot, fresh);
    return fresh;
  }
  const draft = ensureDraftAvatar(
    sanitizedDraft === null
      ? current.draft
      : current.draft === null
        ? sanitizedDraft
        : { ...current.draft, ...sanitizedDraft },
  );
  if (requested === 'awaiting_confirmation') requireAwaitingDraft(draft);
  const next: BuildSession = {
    ...current,
    status: requested,
    step: step ?? current.step,
    stepsDone: derived ?? report.stepsDone ?? current.stepsDone,
    request: report.request ?? current.request,
    draft,
    note: report.note ?? current.note,
    interview:
      report.interview !== undefined ? interviewOf(report) : current.interview,
    updatedAt: now,
  };
  await writeSession(stateRoot, next);
  return next;
}

/** Project a report's interview payload onto the session shape (questions
 * only — answers live exclusively in the answer paths). 多选字段别名容错
 * （2026-09-11 实况）：模型会漂移到 multi_select/multiSelect，落盘前统一归
 * 一为规范字段 multi（问题项 schema 已在 captainTools 放宽）。 */
function interviewOf(report: BuildReport): { questions: InterviewQuestion[] } {
  return {
    questions: report.interview!.questions.map((q) => {
      const o = q as unknown as Record<string, unknown>;
      return o['multi'] === true || o['multi_select'] === true || o['multiSelect'] === true
        ? { ...q, multi: true }
        : q;
    }),
  };
}

/**
 * Mark that the builder child was dispatched (start acceptance) for this
 * session — the durable 60s dispatch lock. Merge-write keeps every other
 * field intact; a fresh newBuild session resets the lock (new build = new
 * lock). ('restart' remains a legal persisted value for old sessions but
 * has no writer anymore — restarts are followup wakes, docs/19.16.)
 */
export async function markPhaseSpawn(
  stateRoot: string,
  kind: 'start' | 'restart',
): Promise<void> {
  const current = readBuildSession(stateRoot);
  if (current === null) return;
  await writeSession(stateRoot, {
    ...current,
    phaseSpawn: kind,
    phaseSpawnAt: Date.now(),
    updatedAt: current.updatedAt,
  });
}

/**
 * Record the continuable builder child's durable session id（docs/19.16
 * 持续构建子代理迭代）：受理（startContinuable）与冷恢复重建各写一次——
 * 重建覆盖旧值 = 新持有者接手。其余合并（reportBuildProgress 等）原样
 * 保留该字段。
 */
export async function markBuilderChild(
  stateRoot: string,
  childId: string,
): Promise<void> {
  const current = readBuildSession(stateRoot);
  if (current === null) return;
  await writeSession(stateRoot, {
    ...current,
    builderChildId: childId,
    updatedAt: current.updatedAt,
  });
}

/**
 * Record the latest followup-wake dedup key（面板路由与主对话工具双入口
 * 竞态去重）：落盘进会话——跨构建互不踩、宿主重启后仍有效。
 */
export async function markBuilderWake(
  stateRoot: string,
  wakeKey: string,
): Promise<void> {
  const current = readBuildSession(stateRoot);
  if (current === null) return;
  await writeSession(stateRoot, {
    ...current,
    builderWakeKey: wakeKey,
    updatedAt: current.updatedAt,
  });
}

/**
 * 记录最近一次派发/唤醒的回合种类（用户迭代 2026-09-10：可见提示词不再带
 * 回合任务——eteams_build_guide 以本字段决定返回的 turn，模型领规程时取
 * 决策表分支）。受理（startBuilderChild）与每次唤醒（wakeBuilderChild）各
 * 写一次，都在派发动作之前——子代理首个工具调用时凭据已在盘上。合并写不
 * 动 updatedAt（与 markBuilderWake 同口径，不驱动面板表单重置）。
 */
export async function markBuilderTurn(
  stateRoot: string,
  kind: BuildPhaseKind,
): Promise<void> {
  const current = readBuildSession(stateRoot);
  if (current === null) return;
  await writeSession(stateRoot, { ...current, wakeKind: kind, updatedAt: current.updatedAt });
}

/**
 * Whether an acceptance spawn is already locked for this session（60 秒窗）。
 * True = 已有受理派发在跑或刚派出，调用方必须放弃本次派发。
 */
export function phaseSpawnLocked(
  stateRoot: string,
  kind: 'start' | 'restart',
  windowMs = 60_000,
): boolean {
  const session = readBuildSession(stateRoot);
  if (session === null) return false;
  return (
    session.phaseSpawn === kind &&
    typeof session.phaseSpawnAt === 'number' &&
    Date.now() - session.phaseSpawnAt < windowMs
  );
}

/**
 * Store the user's interview answers (2026-09-10 unified ask: the host calls
 * this automatically when the builder child's eteams_ask_user returns; the
 * panel route and build_report(answers) remain as bypass entries). Idempotent
 * re-answers overwrite (the panel allows correcting before the child resumes).
 */
export async function answerBuildInterview(
  stateRoot: string,
  answers: { id: string; choice: string }[],
): Promise<BuildSession> {
  const current = readBuildSession(stateRoot);
  if (current === null || current.interview === undefined) {
    throw new Error('没有待回答的意图访谈');
  }
  if (current.status !== 'active') {
    throw new Error(`构建已结束（${current.status}），访谈答案不再接收`);
  }
  const next: BuildSession = {
    ...current,
    interview: { ...current.interview, answers, answeredAt: Date.now() },
    note: '意图访谈已作答',
    updatedAt: Date.now(),
  };
  await writeSession(stateRoot, next);
  return next;
}

/** One selectable option in an intent-interview question. */
export interface InterviewOption {
  label: string;
  description?: string;
}

/** One intent-interview question rendered as an option list in the workbench. */
export interface InterviewQuestion {
  id: string;
  question: string;
  /** Optional group heading: models often carry ask_user_question's header habit — render it above the question. */
  header?: string;
  options: InterviewOption[];
  /** Allow multiple selections (answers joined with 「、」). */
  multi?: boolean;
}

/**
 * Intent-interview state carried on the session (docs/19.16): the builder
 * child publishes questions here; answers land via the unified ask (host
 * auto-persist), the panel route, or build_report(answers).
 */
export interface InterviewState {
  questions: InterviewQuestion[];
  answers?: { id: string; choice: string }[];
  answeredAt?: number;
}

/** One-time avatar assignment: stable face from first preview through confirm. */
function ensureDraftAvatar(draft: BuildDraft | null): BuildDraft | null {
  // 还没起名的草稿（docs/19.17.2 允许 awaiting 报告先到、名字后补）不预分配
  // 头像——undefined 不等于 ''，放过它会在 avatarSeedFor 里炸。
  if (
    draft === null ||
    draft.avatar !== undefined ||
    draft.name === undefined ||
    draft.name === ''
  ) {
    return draft;
  }
  return {
    ...draft,
    avatar: { seed: avatarSeedFor(draft.name), salt: Math.floor(Math.random() * 1000) },
  };
}

/**
 * Confirm the pending draft (docs/19.6.3, D18-6): only valid from
 * `awaiting_confirmation`. Persists the member via `upsertRosterMember`
 * and flips the session to confirmed in one operation — the one place the
 * conversational flow ever writes the roster.
 */
export async function confirmBuildSession(
  stateRoot: string,
  draft: BuildDraft,
): Promise<{ session: BuildSession; memberName: string }> {
  const current = readBuildSession(stateRoot);
  if (current === null || current.status !== 'awaiting_confirmation') {
    throw new Error('没有待确认的构建草稿（状态非 awaiting_confirmation）');
  }
  const stored = await upsertRosterMember(stateRoot, {
    name: draft.name,
    role: draft.role,
    ...(draft.profile !== undefined ? { profile: draft.profile } : {}),
    ...(draft.duty !== undefined ? { duty: draft.duty } : {}),
    ...(draft.style !== undefined ? { style: draft.style } : {}),
    ...(draft.skills !== undefined ? { skills: draft.skills } : {}),
    ...(draft.rules !== undefined ? { rules: draft.rules } : {}),
    ...(draft.executionPrompt !== undefined ? { executionPrompt: draft.executionPrompt } : {}),
    ...(draft.personaMd !== undefined ? { personaMd: draft.personaMd } : {}),
    ...(draft.avatar !== undefined ? { avatar: draft.avatar } : {}),
    ...(draft.provider !== undefined ? { provider: draft.provider } : {}),
    ...(draft.model !== undefined ? { model: draft.model } : {}),
    ...(draft.reasoningEffort !== undefined ? { reasoningEffort: draft.reasoningEffort } : {}),
  });
  const next: BuildSession = {
    ...current,
    status: 'confirmed',
    step: '已入库',
    stepsDone: [...current.stepsDone, '确认入库'],
    draft: { ...(current.draft ?? {}), ...draft },
    note: `已入库 ${stored.name}（${stored.role}）`,
    updatedAt: Date.now(),
  };
  await writeSession(stateRoot, next);
  return { session: next, memberName: stored.name };
}

/**
 * Cancel the session; only active/awaiting sessions can be cancelled.
 * `note` lets callers distinguish user abandonment from dispatch-failure
 * rollback（派发失败的会话必须标回 cancelled，否则无子代理的 active 会话
 * 会卡住 /eteam 的门禁）.
 */
export async function cancelBuildSession(
  stateRoot: string,
  note = '已放弃本次构建',
): Promise<BuildSession> {
  const current = readBuildSession(stateRoot);
  if (current === null) throw new Error('没有进行中的构建会话');
  if (!TRANSITIONS[current.status].includes('cancelled')) {
    throw new Error(`非法状态迁移：${current.status} → cancelled`);
  }
  const next: BuildSession = {
    ...current,
    status: 'cancelled',
    note,
    updatedAt: Date.now(),
  };
  await writeSession(stateRoot, next);
  return next;
}

/**
 * Resume a cancelled build (docs/19.16): the session file keeps the full
 * context (stepsDone/draft/request), and the panel wakes the durable builder
 * child via followup — the child continues from where it was interrupted.
 * Only cancelled sessions resume; a confirmed build already landed in the
 * roster and starts a fresh build via /eteam instead.
 */
export async function resumeBuildSession(stateRoot: string): Promise<BuildSession> {
  const current = readBuildSession(stateRoot);
  if (current === null) throw new Error('没有可恢复的构建会话');
  if (current.status !== 'cancelled') {
    throw new Error(`仅已放弃的构建可恢复（当前状态：${current.status}）`);
  }
  const next: BuildSession = {
    ...current,
    status: 'active',
    step: current.step === '已入库' ? '继续构建' : current.step,
    note: '已恢复——从中断处继续',
    updatedAt: Date.now(),
  };
  await writeSession(stateRoot, next);
  return next;
}

async function writeSession(stateRoot: string, session: BuildSession): Promise<void> {
  const file: BuildFile = { schemaVersion: 1, session };
  await atomicWriteText(roleBuilderFile(stateRoot), `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * 诊断用：往当前构建会话的 note 追加一段文字（不改状态机；会话不存在则
 * 忽略）。桌面宿主的 logger.warn 不落盘——engage 投递结果经它落到
 * rolebuilder.json,面板卡片可见（2026-09-08 排查「对话视图不出现」）。
 */
export function annotateBuildSession(stateRoot: string, text: string): void {
  const session = readBuildSession(stateRoot);
  if (session === null) return;
  const note = `${session.note ?? ''} | ${text}`;
  void writeSession(stateRoot, { ...session, note, updatedAt: Date.now() }).catch(() => undefined);
}

/**
 * engage 投递诊断（独立追加日志,无读改写竞态）:<stateRoot>/logs/engage-diag.log
 * JSON lines。桌面宿主的 logger.warn 不落盘、构建 note 有覆盖竞态——本文件
 * 是 engage 投递问题的权威证据通道（2026-09-08 排查「对话视图不出现」）。
 */
export function appendEngageDiag(stateRoot: string, entry: Record<string, unknown>): void {
  try {
    const dir = join(stateRoot, 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'engage-diag.log'), `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
  } catch {
    // 诊断绝不影响主流程
  }
}
