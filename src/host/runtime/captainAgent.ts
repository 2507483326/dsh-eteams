/**
 * 领队子代理（docs/26 用户迭代 2026-09-03「主窗口发问题不合适——由领队
 * 子代理完成主持」）：对话驱动团队时，主窗口会话只负责转交，领队工作
 * （提交任务单、问询弹窗、拆解、指派、汇报）由一次性「领队子代理」承担
 * （构建代理同款 one-shot 模式，builderPhases）。
 *
 * 本模块持有两样基础设施：
 * - 子代理标签（`eteams-captain:<teamId>`，镜像 members 的 label 模式）；
 * - 身份注册表：dispatch 派发的子代理会话 id → 团队 id，resolveCaller /
 *   envForAgent 据此把子代理的 eteams_* 调用按该团队领队解析（含跨工作区
 *   重指），band 组装据此对子代理静默（它自己就是领队，不能再看到
 *   「转交」指示）。
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
 * Live dispatch registry: child session id → teamId, written at spawn and
 * dropped when the run settles. One-shot children are dead after their turn,
 * so a leaked entry is inert; the explicit unregister keeps the map tight.
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
 * names aborts the spawn; the child is one-shot (run.result awaited to
 * completion), so it cannot nest workers anyway.
 */
export const CAPTAIN_CHILD_DENIED_TOOLS: readonly string[] = [
  'eteams_create_team',
  'eteams_archive_team',
  'eteams_delete_team',
  'eteams_dispatch_captain',
  'eteams_build_dispatch',
  'eteams_build_report',
  'eteams_interview_answer',
];
