/**
 * 输入栏团队徽章 hover 摘要（用户迭代 2026-09-12「团队徽章 hover 显示当前正在
 * 执行的任务和人员」）：锁定团队徽章悬浮时列出**执行中**的任务与执行人；没有
 * 执行中的任务时退化为当前阶段文案（创建中 / 正在调度成员 / 等待中…）。
 *
 * 独立成 lib 纯函数模块（subagentFace 同款纪律）：teamsButton 本体牵着一串 UI
 * 依赖（Radix、lucide、primitives barrel），node 单测拉不动；摘要语义放这里才
 * 能被 tests/teamsButton.test.ts 直接锁定。
 *
 * 口径（与宿主快照、用户原话对齐）：
 * - 「执行中」= task.status === 'start'（members 领取后 ready→start，派发本身
 *   不改状态，见 host/runtime/assignment.ts applyAssignment）；执行人取
 *   task.assignee（当前成员名）。容器（主任务）start 由子任务派生、无 assignee
 *   ——按 assignee 空值自然排除，不重复列。
 * - **领队不列入**（用户原话「注意领队不显示到这里面」）：assignee 命中领队名
 *   的行跳过（领队主持拆解/调度，不是执行人）。
 * - 没有执行中任务时给阶段文案（用户原话「就是创建中，或者等待中这些状态，
 *   分配成员改成正在调度成员吧，不然不清晰」）：创建中（容器拆解中）>
 *   「正在调度成员」（任务已派发但成员尚未领取 = ready + assignee）> 等待中 >
 *   已挂起 > 待领队 > 待用户 > 已完成。
 *
 * 用户 2026-09-14「已创建团队任务的 hover 弹层里放本会话锚定的主任务卡片 +
 * 会话成员」：hover 卡主体由本模块两份新派生供数——{@link anchoredMainTaskOf}
 * （本会话锚定的主任务，与宿主 `runtime/sessionTeam.ts` 的 `anchoredMainTaskOf`
 * 同口径，展示层只做镜像、宿主仍是锚点最终裁决）与 {@link sessionMembersOf}
 * （有子会话的成员，点击切换会话）。
 *
 * @module dsh-eteams/client/teamBadgeSummary
 */
import type { TaskView, TeamSnapshot } from './monitor';

/** 一条执行中任务与它的执行人。 */
export interface TeamBadgeExecuting {
  taskId: number;
  subject: string;
  member: string;
}

/** 徽章 hover 摘要：有执行中任务给列表，否则给一条阶段文案。 */
export interface TeamBadgeSummary {
  executing: TeamBadgeExecuting[];
  statusLine: string;
}

/** 阶段文案（用户点名口径；未开始三档集中在此常量面，便于措辞迭代）。 */
export const TEAM_BADGE_STAGE_LABELS = {
  creating: '创建中',
  dispatching: '正在调度成员',
  waiting: '等待中',
  paused: '已挂起',
  wait: '待领队',
  waitUser: '待用户',
  completed: '已完成',
} as const;

/** 任务已派发但成员尚未领取（状态仍 ready、assignee 已落成员名）。 */
function isDispatched(task: TaskView): boolean {
  return task.status === 'ready' && task.assignee !== null && task.assignee !== '';
}

/** 未执行阶段的文案（优先级：创建中 > 正在调度成员 > 等待中 > 其余状态）。 */
function stageLineOf(tasks: readonly TaskView[]): string {
  if (tasks.some((t) => t.status === 'creating')) return TEAM_BADGE_STAGE_LABELS.creating;
  if (tasks.some(isDispatched)) return TEAM_BADGE_STAGE_LABELS.dispatching;
  if (tasks.some((t) => t.status === 'ready')) return TEAM_BADGE_STAGE_LABELS.waiting;
  if (tasks.some((t) => t.status === 'paused')) return TEAM_BADGE_STAGE_LABELS.paused;
  if (tasks.some((t) => t.status === 'wait')) return TEAM_BADGE_STAGE_LABELS.wait;
  if (tasks.some((t) => t.status === 'wait_user')) return TEAM_BADGE_STAGE_LABELS.waitUser;
  // 无线索兜底：无任务（刚绑定、尚未开跑）与全部终态都收在「等待中」/「已完成」。
  if (tasks.length === 0) return TEAM_BADGE_STAGE_LABELS.waiting;
  return TEAM_BADGE_STAGE_LABELS.completed;
}

/**
 * 汇总一支团队供徽章 hover 展示：执行中任务 + 执行人（排除领队）；无执行中
 * 任务时给阶段文案。team 为 undefined（快照未落地/队伍已删）按空队处理。
 */
export function teamBadgeSummary(
  team: TeamSnapshot | undefined,
  captainName?: string,
): TeamBadgeSummary {
  if (team === undefined) return { executing: [], statusLine: TEAM_BADGE_STAGE_LABELS.waiting };
  const executing: TeamBadgeExecuting[] = [];
  for (const task of team.tasks) {
    if (task.status !== 'start') continue;
    const member = task.assignee;
    if (member === null || member === '') continue;
    // 领队不列入（用户原话）：它是主持者，不是任务执行人。
    if (captainName !== undefined && member === captainName) continue;
    executing.push({ taskId: task.taskId, subject: task.subject, member });
  }
  if (executing.length > 0) return { executing, statusLine: '' };
  return { executing: [], statusLine: stageLineOf(team.tasks) };
}

/**
 * 本会话锚定的主任务（用户 2026-09-14 hover 卡主体）：与宿主
 * `runtime/sessionTeam.ts` 的 `anchoredMainTaskOf` 同口径——无父
 * （parentId===null）、无执行链（chain.length===0，排除面板派发时补章了
 * mainSessionId 的单杆任务）、`mainSessionId` 命中本会话、排除 cancelled，
 * 取 taskId 最大者；无命中返回 undefined。
 *
 * 展示层只做镜像（宿主是锚点的最终裁决，建任务守卫/band 分支都读它）；
 * sessionId 传会话树根（子代理会话先经 `rootSessionIdOf` 上溯到主对话），
 * 任务行 `main_session_id` 登记的就是主对话快照。
 */
export function anchoredMainTaskOf(
  team: TeamSnapshot | undefined,
  sessionId: string | undefined,
): TaskView | undefined {
  if (team === undefined || sessionId === undefined || sessionId === '') return undefined;
  let best: TaskView | undefined;
  for (const task of team.tasks) {
    if (task.parentId !== null) continue;
    if (task.chain.length !== 0) continue;
    if ((task.sessionId ?? null) !== sessionId) continue;
    if (task.status === 'cancelled') continue;
    if (best === undefined || task.taskId > best.taskId) best = task;
  }
  return best;
}

/** 一条「会话成员」：有子会话的成员（名 + 头像 + 该子会话 id）。 */
export interface SessionMemberEntry {
  name: string;
  avatar: { seed: number; salt: number } | null;
  sessionId: string;
}

/**
 * 本任务的会话成员（用户 2026-09-14「点击进入已经有会话的成员会话中」）：取该
 * 任务的 `memberSessions`（宿主按大任务粒度下发的副本行）里子会话已起的成员
 * ——**按任务口径**，不能取成员全局最近一行（`MemberView.childId` 是
 * latestInstanceRow 口径），否则从 A 任务会跳到 B 任务的会话；本任务尚未建
 * 会话的成员不列（点不进去）。主会话由任务锚 `sessionId` 另行承担，不在本表。
 * 顺序随宿主副本行（建行序）。task 缺省/旧快照 → 空表。
 */
export function sessionMembersOf(task: TaskView | undefined): SessionMemberEntry[] {
  if (task === undefined) return [];
  const entries: SessionMemberEntry[] = [];
  for (const member of task.memberSessions ?? []) {
    if (member.sessionId === '') continue;
    entries.push({ name: member.name, avatar: member.avatar, sessionId: member.sessionId });
  }
  return entries;
}
