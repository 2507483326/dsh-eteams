/**
 * Session team binding (docs/26 对话调用团队执行任务): the composer's 团队
 * button selects a team for the conversation; the host records the binding
 * in-memory (mirror of sessionPersona — the client re-asserts on mount, so a
 * host restart self-heals) and the session agent's prompt gains a 团队绑定
 * band（每次组装时对照活团队现读）.
 *
 * 绑定即固定（用户迭代 2026-09-10「对话固定为团队对话」）：选中团队后绑定
 * **常驻**、不随发送消费——一个主对话只对应一个团队（换队在 webui POST
 * /session-team 守卫 409，旧队已死才放行重选）；输入栏徽章常显该团队且
 * 不能再打开 团队/角色 切换弹层（客户端锁定面）。替代 2026-09-07 的一次性
 * 消费语义（consumeSessionTeamBinding/本回合凭证已随锁定语义整体移除）。
 *
 * band 文本组装在 prompts/system/sessionTeam.ts（纯函数，判别联合入参）——
 * 本文件只留 bindings store 与薄壳：领队子代理注册表守卫、绑定查表、活团
 * 队快照解析、**锚定主任务判据**（anchoredMainTaskOf：本会话的主任务容器，
 * 删除/取消才释放）后，把判别联合传给纯函数。绑定即意图、转交分工等口径
 * 说明随 band 文本在 prompts 平面。
 *
 * The band is built per assembly against the LIVE team snapshot (readTeamSync
 * via the webui locateTeam helper) so 批准/阶段变化即时反映，无需重绑。
 *
 * @module dsh-eteams/host/runtime/sessionTeam
 */
import type { TaskRecord, TeamState } from '../model/types.js';
import { captainChildParentOf, captainChildTeamOf } from './captainAgent.js';
import { sessionTeamBand } from '../prompts/system/sessionTeam.js';

export { sessionIdOfScope } from './sessionPersona.js';

/** A bound team for one conversation session (the composer 团队 selection). */
export interface SessionTeamBinding {
  readonly teamId: string;
  /** Team name at bind time — display fallback when the team disappears. */
  readonly name: string;
  readonly boundAt: number;
}

const bindings = new Map<string, SessionTeamBinding>();

/** Bind (or re-bind) one session to a team. 换队守卫在 webui 路由层（需要
 * 活团队判定），store 本体只做覆盖写——同队重绑刷新名字/时间属正常路径。 */
export function setSessionTeam(sessionId: string, binding: SessionTeamBinding): void {
  if (sessionId === '') return;
  bindings.set(sessionId, binding);
}

/** Remove the binding (team deletion cleanup / API 兼容保留). */
export function clearSessionTeam(sessionId: string): void {
  bindings.delete(sessionId);
}

/** Drop every binding that points at one team（deleteTeam 提交后调用）：
 * 绑定的团队消失即解锁会话，徽章端经快照失联自动回到可选状态。 */
export function clearSessionTeamForTeam(teamId: string): void {
  for (const [sessionId, binding] of bindings) {
    if (binding.teamId === teamId) bindings.delete(sessionId);
  }
}

/** The session's full binding, if any（webui GET 对账 / 409 文案取队名）. */
export function getSessionTeamBinding(sessionId: string): SessionTeamBinding | undefined {
  return bindings.get(sessionId);
}

/** The session's bound teamId, if any (identity.ts 绑定优先 resolveCaller). */
export function getSessionTeamId(sessionId: string): string | undefined {
  return bindings.get(sessionId)?.teamId;
}

/**
 * 锚点释放状态集合（用户迭代 2026-09-12「每个会话只有一个主任务，完成只是
 * 暂时的，后面有新任务还是挂下面继续执行」）：只认 `cancelled`——`completed`
 * 是「当前小任务都完成」的可回退标识（追加小任务即自动回 ready），继续锚定、
 * 不再开新主任务；容器被删除时任务行消失、锚点自然释放。cancelled 是唯一
 * 例外：createTask 拒收已取消容器挂小任务，继续锚定只会把会话卡死，故释放
 * （容器本身不设 cancelled，此为存量/旁路数据的兜底）。
 */
const ANCHOR_RELEASING_TASK_STATUSES: ReadonlySet<TaskRecord['status']> = new Set(['cancelled']);

/**
 * 锚定主任务判据（用户迭代 2026-09-10「已创建任务走增补子任务」；2026-09-12
 * 「每个会话只有一个主任务」）：本会话建过的最新**主任务容器**（parentId 空
 * + chain 空——createTask 校验容器不带执行链，面板单杆任务有链不会误锚；
 * mainSessionId 是建任务时登记的调用方会话快照——对话工具与面板 commission
 * 同源）。**不按状态过滤**：容器完成（completed）只是可回退标识，仍锚定
 * ——新工作一律增补小任务进入它（追加即自动回 ready）；仅容器删除（行消失）
 * 或 cancelled（安全阀）释放锚点。返回 undefined = 本对话尚无主任务
 * （band 走两步走、submit_task 放行）。
 */
export function anchoredMainTaskOf(team: TeamState, sessionId: string): TaskRecord | undefined {
  if (sessionId === '') return undefined;
  let latest: TaskRecord | undefined;
  for (const task of team.tasks) {
    if (task.parentId !== null) continue;
    if (task.chain.length > 0) continue;
    if (task.mainSessionId !== sessionId) continue;
    if (ANCHOR_RELEASING_TASK_STATUSES.has(task.status)) continue;
    if (latest === undefined || task.id > latest.id) latest = task;
  }
  return latest;
}

/**
 * 调用会话视角的「本对话锚定主任务」：与 {@link anchoredMainTaskOf} 同判据，
 * 但先把**领队子代理会话**换回它发起的主会话。领队子代理建的小任务行
 * `main_session_id` 快照记的是领队子会话 id（既有口径，见 createTask），与
 * 主任务容器登记的发起会话不同——直接按调用会话比对永远找不到主任务。
 *
 * 两条线索：领队副本行（持久，`isLeader && session_id = 本子会话`，其
 * mainTaskId 即主持的大任务）优先，注册表（进程内，重启后丢失）兜底。
 * 主会话/无领队会话没有这两条线索，按自身会话判定（原判据不变）。
 */
export function anchoredMainTaskOfCaller(
  team: TeamState,
  sessionId: string,
): TaskRecord | undefined {
  if (sessionId === '') return undefined;
  const replica = team.taskMembers.find((r) => r.isLeader === true && r.sessionId === sessionId);
  if (replica !== undefined) {
    const anchored = team.tasks.find(
      (t) =>
        t.id === replica.mainTaskId &&
        t.parentId === null &&
        t.chain.length === 0 &&
        !ANCHOR_RELEASING_TASK_STATUSES.has(t.status),
    );
    if (anchored !== undefined) return anchored;
  }
  return anchoredMainTaskOf(team, captainChildParentOf(sessionId) ?? sessionId);
}

/**
 * The 团队绑定 band for one assembly. `''` contributes nothing — only a
 * session with an active binding sees it. `liveTeam` resolves the current
 * on-disk snapshot (undefined = team deleted/archived → 失效提示).
 */
export function sessionTeamSection(
  sessionId: string | undefined,
  liveTeam: (teamId: string) => TeamState | undefined,
): string {
  if (sessionId === undefined) return '';
  // 领队子代理：band 对其静默（它是领队本人，不该再看到「转交」指示）。
  if (captainChildTeamOf(sessionId) !== undefined) return '';
  const binding = bindings.get(sessionId);
  if (binding === undefined) return '';
  const team = liveTeam(binding.teamId);
  // 失效分支的名字取绑定时记录的团队名（团队已删，磁盘无名可读）。
  return sessionTeamBand(
    team === undefined
      ? { kind: 'dead', name: binding.name }
      : {
          kind: 'live',
          name: team.name,
          taskCount: team.tasks.length,
          // 分工口径随 hasLeader 分支：无领队团队由主会话直接主持（面板
          // 手动建任务的完善路径同语义，docs/panelTaskCommission）。
          hasLeader: team.hasLeader,
          // 锚定主任务：非空 = 本对话已有主任务（completed 也算），band 切
          // 增补子任务分工（不再两步走建任务）。
          mainTaskId: anchoredMainTaskOf(team, sessionId)?.id,
        },
  );
}
