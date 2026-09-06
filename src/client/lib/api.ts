/**
 * Panel write API (D16 + M5 first slice): fetch helpers for the member
 * roster and the panel-driven create-team / add-member flows. All calls go
 * to the plugin's own `/eteams-api` namespace (docs/12, docs/18 §7.1 —
 * never under `/plugins`).
 *
 * @module dsh-eteams/client/api
 */

/** Base URL prefix for every eteams route. */
const API_BASE = '/eteams-api';

/** One reusable member definition in the workspace roster (D16, v3 角色库). */
export interface RosterMember {
  name: string;
  /** 工号 (docs/21): host 发整数工号（显示补零走 host 快照的格式化串）。 */
  employeeId?: number;
  role: string;
  /** 一句话简介（列表卡片/详情头展示；空/缺省=不展示）。 */
  profile?: string;
  duty?: string;
  style?: string;
  skills?: string;
  rules?: string[];
  executionPrompt?: string;
  /** Pre-generated avatar pair (docs/14); host assigns one when absent. */
  avatar?: { seed: number; salt: number };
  /** Full Markdown role playbook (agency-agents-zh style). */
  personaMd?: string;
  updatedAt: number;
}

/** New-member form payload (fields beyond name/role optional). */
export interface NewMemberInput {
  name: string;
  role: string;
  /** 一句话简介（列表卡片/详情头展示）。 */
  profile?: string;
  duty?: string;
  style?: string;
  skills?: string;
  rules?: string[];
  executionPrompt?: string;
  /** Full Markdown role playbook (all persona content lives here now). */
  personaMd?: string;
  /** Pre-generated avatar pair（详情页「随机头像」透传，用户迭代 2026-09-03）. */
  avatar?: { seed: number; salt: number };
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON error bodies fall through to the status check
  }
  if (!res.ok) {
    const message =
      body !== null && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body;
}

/** List the workspace roster (D16). */
export async function fetchRoster(): Promise<RosterMember[]> {
  const body = (await requestJson(`${API_BASE}/roster`)) as { members?: unknown };
  return Array.isArray(body.members) ? (body.members as RosterMember[]) : [];
}

/** Save (insert or update) one roster entry. */
export async function saveRosterMember(member: NewMemberInput): Promise<void> {
  await requestJson(`${API_BASE}/roster`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(member),
  });
}

/**
 * Create a team bound to the current session (panel flow). Returns the
 * created teamId so the panel can select the new team immediately.
 * docs/35 §5#1：审批环节下线——建队即生效，不再有 goal 字段。
 */
export async function createTeamViaPanel(
  sessionId: string,
  name: string,
): Promise<{ teamId: string; name: string }> {
  const body = (await requestJson(`${API_BASE}/team`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, sessionId }),
  })) as { teamId?: unknown };
  return {
    teamId: typeof body.teamId === 'number' ? String(body.teamId) : String(body.teamId ?? ''),
    name,
  };
}

/**
 * Add a member to a team, adopting a roster entry. `sourceName` copies a
 * roster role under a different name（同一角色可重复加入，名册默认值照抄）；
 * `employeeId` 显式指定工号（缺省沿用角色库同号，再缺省由 host 分配）。
 */
export async function addTeamMember(
  teamId: string,
  payload: { name: string; sourceName?: string; employeeId?: string },
): Promise<void> {
  await requestJson(`${API_BASE}/team/${encodeURIComponent(teamId)}/member`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: payload.name,
      fromRoster: true,
      ...(payload.sourceName !== undefined && payload.sourceName !== payload.name
        ? { sourceName: payload.sourceName }
        : {}),
      ...(payload.employeeId !== undefined && payload.employeeId.trim() !== ''
        ? { employeeId: payload.employeeId.trim() }
        : {}),
    }),
  });
}

/**
 * Set one member's model route（成员卡右侧模型选择）：model 为空 = 重置为
 * 会话默认（settings agent-default-model，用户迭代 2026-09-04）。运行中的
 * 成员在下次启动时生效（staged 成员启动即生效）。docs/35 §3#5：body 只收
 * {model, reasoningEffort}，provider 由 host 按配置解析。
 */
export async function setMemberModel(
  teamId: string,
  name: string,
  model: { model?: string; reasoningEffort?: string },
): Promise<void> {
  await requestJson(
    `${API_BASE}/team/${encodeURIComponent(teamId)}/member/${encodeURIComponent(name)}/model`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(model),
    },
  );
}

/**
 * Set the leader's model route（领队卡模型二级菜单，用户迭代 2026-09-04
 * 恢复领队模型选择）：model 为空 = 重置为会话默认；有值 = 团队默认路线，
 * 领队子代理派发按它解析。
 */
export async function setLeaderModel(
  teamId: string,
  model: { model?: string; reasoningEffort?: string },
): Promise<void> {
  await requestJson(`${API_BASE}/team/${encodeURIComponent(teamId)}/leader/model`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(model),
  });
}

/**
 * Save one member's own handbook copy（成员详情独立于角色详情，用户迭代
 * 2026-09 四）：只写成员记录，角色库不受影响。运行中的成员下次启动时生效。
 */
export async function updateMemberPersona(
  teamId: string,
  name: string,
  personaMd: string,
): Promise<void> {
  await requestJson(
    `${API_BASE}/team/${encodeURIComponent(teamId)}/member/${encodeURIComponent(name)}/persona`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personaMd }),
    },
  );
}

/**
 * 把成员当前的手册副本同步回角色库同名角色（用户迭代 2026-09 四「同步到该
 * 角色」）：同名角色只覆盖手册；成员无角色库条目（-2 副本等）时按成员记录
 * 新建。
 */
export async function syncMemberToRoster(
  teamId: string,
  name: string,
  personaMd: string,
): Promise<void> {
  await requestJson(
    `${API_BASE}/team/${encodeURIComponent(teamId)}/member/${encodeURIComponent(name)}/sync-roster`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personaMd }),
    },
  );
}

/** Move the leader out of / back into the team's member roster. */
export async function setTeamLeaderRemoved(teamId: string, removed: boolean): Promise<void> {
  await requestJson(
    `${API_BASE}/team/${encodeURIComponent(teamId)}/leader/${removed ? 'remove' : 'restore'}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
}

/** Delete one roster member. The leader (项目牧羊人) is rejected by the host. */
export async function deleteRosterMember(name: string): Promise<void> {
  await requestJson(`${API_BASE}/roster/${encodeURIComponent(name)}/remove`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** Move a team member out of a team (领队不属于团队成员记录，无需删除). */
export async function removeTeamMember(teamId: string, name: string): Promise<void> {
  await requestJson(
    `${API_BASE}/team/${encodeURIComponent(teamId)}/member/${encodeURIComponent(name)}/remove`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
}

/**
 * Delete one team permanently（团队列表小卡片「删除」按钮，用户迭代 2026-09
 * 七）：staged/completed/halted 可删，running 需先取消任务（host 校验）。
 */
export async function deleteTeam(teamId: string): Promise<void> {
  await requestJson(`${API_BASE}/team/${encodeURIComponent(teamId)}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

// ---------- session persona takeover (docs/13.8.2) ----------

/**
 * Assert the persona band for one session: the session agent's system prompt
 * gains a per-assembly persona section (runtime/sessionPersona.ts), so the
 * conversation speaks as the selected member — no draft text involved.
 */
export async function setSessionPersona(
  sessionId: string,
  member: { name: string; role?: string; duty?: string; personaMd?: string },
): Promise<void> {
  await requestJson(`${API_BASE}/session-persona`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      name: member.name,
      ...(member.role !== undefined ? { role: member.role } : {}),
      ...(member.duty !== undefined ? { duty: member.duty } : {}),
      ...(member.personaMd !== undefined ? { personaMd: member.personaMd } : {}),
    }),
  });
}

/** Clear the persona band (deselect — back to the default agent voice). */
export async function clearSessionPersona(sessionId: string): Promise<void> {
  await requestJson(`${API_BASE}/session-persona/clear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
}

// ---------- session team binding (docs/26 对话调用团队执行任务) ----------

/**
 * Bind the conversation to a team (composer 团队 selection): the session
 * agent's prompt gains the 团队绑定 band — conversation task workflow plus
 * the leadership branch (领队 / 主窗口充当领队 / 团队建在他会话的提示).
 */
export async function setSessionTeam(sessionId: string, teamId: string): Promise<void> {
  await requestJson(`${API_BASE}/session-team`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, teamId }),
  });
}

/** Clear the team binding (deselect in the 团队 popup). */
export async function clearSessionTeam(sessionId: string): Promise<void> {
  await requestJson(`${API_BASE}/session-team/clear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
}

// ---------- conversation task workflow (docs/26 面板审阅/批准) ----------

/** One member slot (execution-chain station) as edited on the panel. */
export interface TaskSlotInput {
  member: string;
  stageBrief: string;
}

/** Create a task (小任务 or 顶层任务) from the panel's task page. */
export async function createTeamTask(
  teamId: string,
  payload: {
    subject: string;
    description?: string;
    parentTaskId?: number;
    chain?: TaskSlotInput[];
  },
): Promise<{ taskId: number }> {
  const body = (await requestJson(`${API_BASE}/team/${encodeURIComponent(teamId)}/task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subject: payload.subject,
      ...(payload.description !== undefined ? { description: payload.description } : {}),
      ...(payload.parentTaskId !== undefined ? { parentTaskId: payload.parentTaskId } : {}),
      ...(payload.chain !== undefined ? { chain: payload.chain } : {}),
    }),
  })) as { taskId?: unknown };
  return { taskId: typeof body.taskId === 'number' ? body.taskId : Number(body.taskId ?? 0) };
}

/** Update an unclaimed task (subject/description/成员槽/依赖 = 执行顺序, 七轮 DA20). */
export async function updateTeamTask(
  teamId: string,
  taskId: number,
  payload: {
    subject?: string;
    description?: string;
    /** 合同 MD 全文（二十八轮 DA41 就地编辑：说明 + 合同并读后的整篇正文）。 */
    contractMd?: string;
    chain?: TaskSlotInput[];
    dependencies?: number[];
  },
): Promise<void> {
  await requestJson(
    `${API_BASE}/team/${encodeURIComponent(teamId)}/task/${taskId}/update`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(payload.subject !== undefined ? { subject: payload.subject } : {}),
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        ...(payload.contractMd !== undefined ? { contractMd: payload.contractMd } : {}),
        ...(payload.chain !== undefined ? { chain: payload.chain } : {}),
        ...(payload.dependencies !== undefined ? { dependencies: payload.dependencies } : {}),
      }),
    },
  );
}

/** Delete an unclaimed task (主任务级联删除全部小任务). */
export async function deleteTeamTask(teamId: string, taskId: number): Promise<void> {
  await requestJson(
    `${API_BASE}/team/${encodeURIComponent(teamId)}/task/${taskId}/delete`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
  );
}

/** Open a task folder in the system file manager（十二轮 DA25：列表卡文件夹
 * 路径可点击；宿主以 workspacePath + 任务 work_dir 定位后拉起文件管理器）. */
export async function openTaskFolder(teamId: string, taskId: number): Promise<void> {
  await requestJson(
    `${API_BASE}/team/${encodeURIComponent(teamId)}/task/${taskId}/folder/open`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
  );
}

/** 主任务开始响应的跳过卡（二十五轮 DA38）：无链/依赖未满/占用等逐卡原因，
 * 面板行内就地提示。 */
export interface GroupStartSkipped {
  taskId: number;
  subject: string;
  reason: string;
}

/** Start (dispatch) a ready task from the panel（二十四轮 DA37 面板开始）：
 * 宿主把任务派发给执行链下一站（复用 assignTask 派发核）；空链 400
 * 「需要选择成员」——客户端对空链卡不渲染按钮，此处为兜底。二十五轮
 * DA38：同一路由开始主任务 = 逐个派发 ready 小任务，响应带 started/
 * skipped（跳过卡列原因，面板行内提示）；单任务路径两字段无跳过。 */
export async function startTeamTask(
  teamId: string,
  taskId: number,
): Promise<{ started: number; skipped: GroupStartSkipped[] }> {
  const body = (await requestJson(
    `${API_BASE}/team/${encodeURIComponent(teamId)}/task/${taskId}/start`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
  )) as { started?: unknown; skipped?: unknown };
  return {
    started: typeof body.started === 'number' ? body.started : 0,
    skipped: Array.isArray(body.skipped) ? (body.skipped as GroupStartSkipped[]) : [],
  };
}

// ---------- role-builder build session (docs/19.6, D18) ----------

/** One persona draft — field names align with eteams_member_save params. */
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
  /** Pre-assigned avatar pair — stable face from first preview through confirm. */
  avatar?: { seed: number; salt: number };
}

/** One selectable option in an intent-interview question (docs/19.16). */
export interface InterviewOption {
  label: string;
  description?: string;
}

/** One intent-interview question rendered as an option list in the workbench. */
export interface InterviewQuestion {
  id: string;
  question: string;
  /** Optional group heading (rendered small above the question). */
  header?: string;
  options: InterviewOption[];
  multi?: boolean;
}

/** Intent-interview state carried on the build session (docs/19.16). */
export interface InterviewState {
  questions: InterviewQuestion[];
  answers?: { id: string; choice: string }[];
  answeredAt?: number;
}

/** One build session (docs/19.9.1). */
export interface BuildSession {
  schemaVersion: number;
  startedAt: number;
  status: 'active' | 'awaiting_confirmation' | 'confirmed' | 'cancelled';
  step: string;
  stepsDone: string[];
  request: string;
  draft: BuildDraft | null;
  note: string;
  updatedAt: number;
  /** Pending/answered intent interview (docs/19.16). */
  interview?: InterviewState;
  /** Owning /eteam invocation id — cards match it to their own build. */
  commandId?: string;
  /**
   * 宿主 GET /rolebuilder 附挂（不落盘，用户反馈 2026-09-05 第二批）：发起
   * 构建的 /eteam 父会话是否在线。false → 面板不渲染「已放弃本次构建」卡
   * （继续构建无从派发，避免死按钮）；旧响应无此字段 → 照旧渲染（防御）。
   */
  parentOnline?: boolean;
}

/** Poll the single build-session slot (null when no session exists). */
export async function fetchBuildState(): Promise<BuildSession | null> {
  const body = (await requestJson(`${API_BASE}/rolebuilder`)) as {
    empty?: boolean;
    session?: BuildSession;
    parentOnline?: boolean;
  };
  if (body.empty === true || body.session === undefined) return null;
  return { ...body.session, parentOnline: body.parentOnline === true };
}

/** Resume a cancelled build — host followup-wakes the continuable builder child. */
export async function resumeBuild(): Promise<void> {
  await requestJson(`${API_BASE}/rolebuilder/resume`, { method: 'POST' });
}

/**
 * 活跃会话心跳（用户迭代：兜底弹窗 steer 到用户正在看的对话）：输入栏按钮
 * 只在当前打开的对话里挂载，定期上报它所在的 sessionId；宿主记 last-writer-
 * wins，兜底 steer 前读取定位。fire-and-forget——失败静默，心跳断了就退回
 * 父会话路径。
 */
export async function reportPresence(sessionId: string): Promise<void> {
  await requestJson(`${API_BASE}/presence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, ts: Date.now() }),
  });
}

/** Submit intent-interview answers — host relays them to the builder child. */
export async function submitInterview(answers: { id: string; choice: string }[]): Promise<void> {
  await requestJson(`${API_BASE}/rolebuilder/interview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers }),
  });
}

/**
 * Manually restart the builder agent — followup-wakes the SAME continuable
 * builder child to re-check progress and re-publish the interview if
 * unanswered (cold-recovery rebuild only if the followup fails).
 */
export async function restartBuild(): Promise<void> {
  await requestJson(`${API_BASE}/rolebuilder/restart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** Confirm the pending draft — host persists to the roster atomically. */
export async function confirmBuild(draft: BuildDraft): Promise<void> {
  await requestJson(`${API_BASE}/rolebuilder/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  });
}

/** Abandon the current build session. */
export async function cancelBuild(): Promise<void> {
  await requestJson(`${API_BASE}/rolebuilder/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/**
 * Member subagent activity dots (docs/20.4 P4): childId → 'running' |
 * 'inactive'. Empty map on older runtimes without listChildren (no dots).
 */
export async function fetchAgentActivity(teamId: string): Promise<Record<string, string>> {
  const body = (await requestJson(
    `${API_BASE}/team/${encodeURIComponent(teamId)}/agentactivity`,
  )) as { activity?: unknown };
  return body.activity !== null && typeof body.activity === 'object'
    ? (body.activity as Record<string, string>)
    : {};
}

// ---------- usage calendar (docs/28 每日 Token 消耗日历) ----------

/** One calendar day (docs/28.4): zero-filled for the whole year. */
export interface UsageDay {
  date: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** 记账行数（usage-bearing assistant/message 条数）。 */
  calls: number;
}

/** Year totals (docs/28.4): firstDay/lastDay 为有数据首末日（无数据 null）。 */
export interface UsageTotals {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  calls: number;
  firstDay: string | null;
  lastDay: string | null;
}

/** GET /team/<id>/usage/calendar response (docs/28.4). */
export interface UsageCalendar {
  teamId: string;
  year: number;
  serverTime: number;
  days: UsageDay[];
  totals: UsageTotals;
}

/** GET /usage/calendar response — 全应用口径，无 teamId。 */
export interface AppUsageCalendar {
  teamId: null;
  year: number;
  serverTime: number;
  days: UsageDay[];
  totals: UsageTotals;
}

/** Fetch one team's daily token-usage calendar (year defaults to current). */
export async function fetchUsageCalendar(teamId: string, year?: number): Promise<UsageCalendar> {
  const params = year === undefined ? '' : `?year=${year}`;
  return (await requestJson(
    `${API_BASE}/team/${encodeURIComponent(teamId)}/usage/calendar${params}`,
  )) as UsageCalendar;
}

/** Fetch the whole app's daily token-usage calendar (year defaults to current). */
export async function fetchAppUsageCalendar(year?: number): Promise<AppUsageCalendar> {
  const params = year === undefined ? '' : `?year=${year}`;
  return (await requestJson(`${API_BASE}/usage/calendar${params}`)) as AppUsageCalendar;
}
