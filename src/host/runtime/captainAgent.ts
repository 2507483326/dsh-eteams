/**
 * 领队子代理（docs/26 用户迭代 2026-09-03「主窗口发问题不合适——由领队
 * 子代理完成主持」+「不使用一次性子代理，应该是持续代理」）：对话驱动
 * 团队时，主窗口会话只负责转交，领队工作（提交任务单、问询弹窗、拆解、
 * 指派、汇报）由**持续领队子代理**承担（每团队一个 continuable 子代理，
 * 首次 dispatch 建立、后续 followup 续聊）。
 *
 * 本模块持有两样基础设施：
 * - 子代理标签（`eteams-captain:<teamId>`，镜像 members 的 label 模式）；
 * - 身份注册表：dispatch 建立的子代理会话 id → 团队 id，resolveCaller /
 *   envForAgent 据此把子代理的 eteams_* 调用按该团队领队解析（含跨工作区
 *   重指），band 组装据此对子代理静默（它自己就是领队，不能再看到
 *   「转交」指示）。
 *
 * 子代理是持续会话，注册表条目在其生命周期内常驻：写入发生在建立与每次
 * 续聊（重启后重登记），撤除只在同队重建（旧会话换新）或派发失败——
 * 与一次性时代「轮次结算即撤」不同。
 *
 * @module dsh-eteams/host/runtime/captainAgent
 */

/** Label prefix identifying eteams captain children. */
export const CAPTAIN_LABEL_PREFIX = 'eteams-captain:';

/** `eteams-captain:<teamId>` — the child's display label. */
export function buildCaptainLabel(teamId: string): string {
  return `${CAPTAIN_LABEL_PREFIX}${teamId}`;
}

/** Inverse of {@link buildCaptainLabel}. */
export function parseCaptainLabel(label: string | undefined): { teamId: string } | undefined {
  if (!label || !label.startsWith(CAPTAIN_LABEL_PREFIX)) return undefined;
  const teamId = label.slice(CAPTAIN_LABEL_PREFIX.length);
  return teamId === '' ? undefined : { teamId };
}

/**
 * Live dispatch registry: child session id → teamId, written at spawn and on
 * every followup re-registration (persisted child id survives host restarts,
 * so the map must be re-populated). Dropped only when the same team rebuilds
 * its child (stale lineage) — the child is persistent, not turn-scoped.
 */
const captainChildren = new Map<string, string>();

/** Register a freshly spawned captain child (identity.ts 领队解析依据). */
export function registerCaptainChild(childId: string, teamId: string): void {
  if (childId === '' || teamId === '') return;
  captainChildren.set(childId, teamId);
}

/** The team a captain child serves (undefined for non-captain sessions). */
export function captainChildTeamOf(childId: string): string | undefined {
  return captainChildren.get(childId);
}

/** Drop the registry entry after the run settles (or on spawn failure). */
export function unregisterCaptainChild(childId: string): void {
  captainChildren.delete(childId);
}

/**
 * Captain tool names denied to the 领队子代理 (one visibility, loud deny).
 * Every entry MUST be a registered tool name — spawn applies the list via
 * `tools.restrict({ deny })`, which fails loudly on unknown names inside
 * the child creation window (same footgun note as MEMBER_DENIED_TOOLS;
 * e.g. `eteams_approve_plan` is never registered, so it must NOT appear
 * here). The child must not create/delete teams, open builds, answer
 * interviews, or re-dispatch captains (recursion guard). Subagent spawn
 * tools ('subagent', 'subagent_fork') are intentionally absent — no such
 * registered names were found in the harness, and denying unregistered
 * names aborts the spawn; the child is a continuable runtime ROOT, and
 * while it may report back to its parent, it must not delegate captains
 * (the deny list is the hard guard).
 */
export const CAPTAIN_CHILD_DENIED_TOOLS: readonly string[] = [
  'eteams_create_team',
  'eteams_delete_team',
  'eteams_dispatch_captain',
  'eteams_build_dispatch',
  'eteams_build_report',
  'eteams_interview_answer',
];
