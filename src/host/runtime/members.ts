/**
 * Member lifecycle (docs/07.2, FR-14/FR-15): continuable spawning, persona
 * injection, and interruption. This is the only module that starts subagents.
 * docs/35 §5#12 之后成员是纯模板行（无状态无会话）：起会话只读模板行，状态
 * 与 session_id 的回填由调用方（首派路径，assignment.ts）随事务写回
 * task_members 实例行。harness 0.1.2 起 registerContinuableSetup 被宿主移除
 * ——成员工具改随根作用域注册（index.ts），归属登记点前移到 spawn 与唤醒
 * （声明路线登记已随子会话徽章改读客户端会话投影退役，2026-09-09）。
 *
 * @module dsh-eteams/runtime/members
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { MemberRecord, TaskMemberRecord, TaskRecord, TeamState } from '../model/types.js';
import { insertMailInTx } from '../state/events.js';
import type { TeamTx } from '../state/store.js';
import { sessionDefaultRouteOf, type RuntimeEnv } from './base.js';
import { makeMail, memberBoxOf, memberRefId, type Wake, wakeMember } from './notifier.js';
import { assignmentMail } from '../prompts/handoff/mails.js';
import { fallbackTeamMemberPersona } from '../prompts/personas/framework.js';
import { memberBriefing, memberWelcome } from '../prompts/spawn/member.js';
import { neutralizeInterpolation } from './sessionPersona.js';
import { registerMemberSession } from './usage.js';
import { boardFileAbs, docDirAbs, groupDirAbs, minutesFileAbs } from './docs.js';
import { taskMemberBadge } from './roster.js';

/** Label prefix identifying eteams member children. */
export const MEMBER_LABEL_PREFIX = 'eteams-member:';

/**
 * `eteams-member:<名字>（T<mainTaskId>-ET<工号>）`：子代理 label 是宿主会话头部
 * 面包屑的显示名（dsh-client-runtime projectList：`displayTitle = child.label
 * ?? childId`），故必须以人名开头——v7 的纯数字尾串
 * `<teamId>:<mainTaskId>:<employeeId>` 在头部读起来像时间（用户迭代
 * 2026-09-12「子代理上面的名字没有了都是时间显示了」）。工牌后缀沿用 v7 的
 * (任务, 工号) 作用域：同名成员、同一成员跨任务各是一行，显示上仍可区分。
 */
export function buildMemberLabel(mainTaskId: number, employeeId: number, name: string): string {
  return `${MEMBER_LABEL_PREFIX}${name}（${taskMemberBadge(mainTaskId, employeeId)}）`;
}

/**
 * Member tool names（createMemberTools 的注册面）。harness 0.1.2 起成员工具
 * 随根作用域注册（宿主移除了 registerContinuableSetup，per-child 装配只剩
 * persona/toolFilter）——领队子代理的拒见清单（CAPTAIN_CHILD_DENIED_TOOLS）
 * 与构建器子代理的过滤（builderToolFilter）按本表派生。task_board/
 * team_status/send_message 的成员视角已并入 captainTools 同名工具（身份分
 * 支），不在本表。与 tools/memberTools 保持同步（tests 有断言）。
 */
export const MEMBER_TOOL_NAMES: readonly string[] = [
  'eteams_claim_task',
  'eteams_decline_task',
  'eteams_append_progress',
  'eteams_complete_task',
  'eteams_fail_task',
];

/**
 * Captain tool names denied to members (one visibility, loud deny).
 * Every entry MUST be a registered tool name: spawn applies the list via
 * `tools.restrict({ deny })`, which fails loudly on unknown names inside
 * the child creation window. `eteams_approve_plan` deliberately is NOT
 * here — approval is panel-driven and the tool is never registered
 * (lifecycle.test.ts asserts its absence), so denying it would abort
 * every member/builder spawn with `tools.restrict() names unknown
 * global tool "eteams_approve_plan"`.
 */
export const MEMBER_DENIED_TOOLS: readonly string[] = [
  'eteams_create_team',
  'eteams_add_member',
  'eteams_member_save',
  'eteams_member_list',
  'eteams_build_report',
  'eteams_build_guide',
  'eteams_build_wait',
  'eteams_remove_member',
  'eteams_update_member',
  'eteams_create_task',
  'eteams_update_task',
  'eteams_delete_task',
  'eteams_assign_task',
  'eteams_advance_task',
  'eteams_reassign_task',
  'eteams_escalate_task',
  'eteams_suspend_task',
  'eteams_resume_task',
  'eteams_cancel_task',
  'eteams_delete_team',
  'eteams_dispatch_captain',
  'eteams_captain_guide',
];

/**
 * 班底行（team.members）：起会话的人设/模型路线都从这里读。v7 按工号定位
 * （同名成员共享同一角色行、各拿各的班底行），名字串退按名（旧口径）。
 */
export function memberTemplateOf(team: TeamState, ref: string | number): MemberRecord | undefined {
  const key = memberRefId(ref);
  return team.members.find((m) =>
    key.employeeId !== undefined ? m.employeeId === key.employeeId : m.name === key.name,
  );
}

/**
 * 通用成员简报组装（用户迭代 2026-09-11；2026-09-14 增队伍留言板；2026-09-15
 * 扁平化）：runtime 侧现读五个绝对路径——工程根（工作区根，代码产出写这里）、
 * 任务目录（groupDirAbs，一个主任务一个目录）、队伍留言板（boardFileAbs）、
 * 本任务纪要（minutesFileAbs）、文档目录（docDirAbs）——连同领队名（班底
 * is_leader 行，无领队时是主会话）交给纯文本 memberBriefing。出生包与每次指派
 * 信共用，保证「工作目录 / 留言板 / 纪要 / 文档 / 领队 / 三节点汇报」始终在成员
 * 上下文里，且路径全部由宿主算好（模型照抄、不自己拼名字、不新建重复文件）。
 */
export function taskBriefing(env: RuntimeEnv, team: TeamState, task: TaskRecord): string {
  const leader = team.hasLeader
    ? (team.members.find((m) => m.isLeader === true)?.name ?? '领队')
    : '主会话（用户对话窗口）';
  return memberBriefing({
    teamName: team.name,
    leaderName: leader,
    projectRoot: env.workspace,
    taskDir: groupDirAbs(env.workspace, team, task),
    boardFile: boardFileAbs(env.workspace, team, task),
    minutesFile: minutesFileAbs(env.workspace, team, task),
    docDir: docDirAbs(env.workspace, team, task),
  });
}

/**
 * Spawn one member child as a durable continuable child of the captain（首派
 * 按链起人路径调用，docs/35 §5#3）。原子性：start 失败直接抛，调用方尚未
 * 改任何状态；成功返回 childId，由调用方在事务内回填实例行。
 * 模型路线（用户迭代 2026-09-04「会话默认」）：模板行 model 为空 = 固定用
 * 宿主会话默认模型（sessionDefaultRouteOf，settings agent-default-model），
 * 不再继承领队会话模型；有值 = override（provider 固定用
 * config.memberProvider，路由只挑模型——docs/35 §3#5 既有口径）。
 * `task` 用于组装通用简报（工作目录/领队，用户迭代 2026-09-11）。
 */
export async function spawnMember(
  env: RuntimeEnv,
  team: TeamState,
  row: TaskMemberRecord,
  captain: Agent,
  task: TaskRecord,
): Promise<string> {
  const template = memberTemplateOf(team, row.employeeId ?? row.name);
  const persona = template?.persona;
  // 人设手册全文（docs/36 建议 4）：personaMd 有烘全文时用它，结构字段不
  // 再渲染进 persona；无手册（旧数据）退回 executionPrompt，再缺则用
  // prompts/personas 的兜底人设（文本原样，2026-09-12 归位人设平面）。进
  // persona 前经 neutralizeInterpolation 转义——宿主对系统提示段做严格
  // {{变量}} 插值，用户 md 里的花括号引用会让整段装配抛错（sessionPersona
  // band 同口径）。
  const personaText = neutralizeInterpolation(
    persona?.personaMd !== undefined && persona.personaMd.trim() !== ''
      ? persona.personaMd
      : (persona?.executionPrompt ?? fallbackTeamMemberPersona(row.name)),
  );
  const route = template?.modelRoute;
  // 路线解析（模板覆盖 / 会话默认）提取成变量供 request 使用；spawn 成功后
  // 随归属注册表落账（harness 0.1.2 起 continuable setup hook 被宿主移除，
  // 归属登记点前移到 spawn；冷恢复会话的归属随唤醒补齐）。模型显示不再
  // 依赖声明路线登记——子会话徽章 2026-09-09 起改读客户端会话持久投影。
  const agentOptions =
    route !== undefined && route.model !== ''
      ? {
          // v9 provider 回归：覆盖路线带目录 provider（同 id 模型跨提供方
          // 消歧）；旧数据未记录时省略——运行时按会话默认解析（此前填
          // config.memberProvider 是 'spawn'/'fork' 传输名，不是 LLM
          // provider，实测 2026-09-08 修复）。
          ...(route.provider !== undefined && route.provider !== ''
            ? { provider: route.provider }
            : {}),
          model: route.model,
          ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
        }
      : sessionDefaultRouteOf(env.ctx);
  const start = await env.ctx.subagents.startContinuable({
    provider: env.config.memberProvider,
    // 标签 = 显示名（宿主会话头部读 label）：名字在前，工牌后缀带 (任务, 工号)
    // 作用域——副本行 = (工号, 大任务)，同名成员各是各的子会话。
    label: buildMemberLabel(row.mainTaskId ?? 0, row.employeeId ?? 0, row.name),
    request: {
      prompt: [{ type: 'text', text: memberWelcome(team, row.name, template, taskBriefing(env, team, task)) }],
      parent: captain,
      persona: personaText,
      toolFilter: { deny: [...MEMBER_DENIED_TOOLS] },
      ...(agentOptions !== undefined ? { agentOptions } : {}),
    },
    // 0.1.2 的入口对 signal 无保护调用 throwIfAborted()——env 缺 signal
    // （面板路径）时兜底成永不中止的信号。
    signal: env.signal ?? new AbortController().signal,
  });
  registerMemberSession(String(start.childId), {
    teamId: String(team.id),
    memberName: row.name,
    employeeId: row.employeeId,
    parentSessionId: String(captain.id),
  });
  return String(start.childId);
}

/** Interrupt one live member's current turn (activation retained). */
export function interruptMember(env: RuntimeEnv, row: TaskMemberRecord, captain: Agent): void {
  if (row.sessionId === '') return;
  try {
    env.ctx.subagents.interrupt(row.sessionId as unknown as SessionId, {
      kind: 'ancestor',
      agent: captain,
    });
  } catch {
    // absent target is an accepted no-op
  }
}

/**
 * Release selected members' resident activations (docs/20.4 P2): newer
 * runtimes expose `drainContinuableChildren` — the live registry drops them
 * immediately and they can no longer be woken; the durable session record
 * remains and is reclaimed with the parent conversation. Older runtimes lack
 * the API (feature-detected): degrade to interrupt-only semantics.
 */
export async function drainMembers(
  env: RuntimeEnv,
  captain: Agent,
  childIds: (string | undefined)[],
): Promise<void> {
  const ids = childIds.filter((id): id is string => typeof id === 'string' && id !== '');
  if (ids.length === 0) return;
  const subagents = env.ctx.subagents;
  if (subagents?.drainContinuableChildren === undefined) return;
  try {
    await subagents.drainContinuableChildren(captain, ids as unknown as readonly SessionId[]);
  } catch {
    // absent/settled targets and authority races are acceptable no-ops
  }
}

/**
 * 派发邮件（事务内落库 + 返回提交后的唤醒动作）：首派与链推进共用；邮件
 * 随团队快照同一事务落库（docs/35 §3#14），唤醒在 COMMIT 之后。
 */
export function sendAssignmentInTx(
  env: RuntimeEnv,
  tx: TeamTx,
  team: TeamState,
  row: TaskMemberRecord,
  task: TaskRecord,
  attemptId: number,
  opts: { stageBrief?: string; handoff?: string; stationIndex?: number } = {},
): Wake {
  const isStation = task.chain.length > 0;
  const content = assignmentMail(task, {
    attemptId,
    isStation,
    briefing: taskBriefing(env, team, task),
    ...opts,
  });
  const box = memberBoxOf(row);
  insertMailInTx(
    tx,
    team.id,
    box.box,
    makeMail(
      { kind: 'captain', name: '领队' },
      { kind: 'member', name: row.name },
      'assignment',
      content,
      { taskId: task.id, attemptId },
    ),
    box.employeeId,
  );
  return () => wakeMember(env, team, row, content);
}
