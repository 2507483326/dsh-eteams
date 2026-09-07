/**
 * Member lifecycle (docs/07.2, FR-14/FR-15): continuable spawning, persona
 * injection, per-child tool installation, and interruption. This is the only
 * module that starts subagents. docs/35 §5#12 之后成员是纯模板行（无状态无
 * 会话）：起会话只读模板行，状态与 session_id 的回填由调用方（首派路径，
 * assignment.ts）随事务写回 task_members 实例行。
 *
 * @module dsh-eteams/runtime/members
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent';
import { recordSessionRoute } from './sessionRoutes.js';
import type { ETeamsResolvedConfig } from '../config.js';
import type { MemberRecord, TaskMemberRecord, TaskRecord, TeamState } from '../model/types.js';
import { insertMailInTx } from '../state/events.js';
import { readTeamSync, type TeamTx } from '../state/store.js';
import {
  sessionDefaultRouteOf,
  stateRootOf,
  type RuntimeContext,
  type RuntimeEnv,
} from './base.js';
import { makeMail, memberBoxOf, memberRefId, type Wake, wakeMember } from './notifier.js';
import { readBuildPresence } from './roleBuilder.js';
import { assignmentMail } from '../prompts/handoff/mails.js';
import { memberWelcome } from '../prompts/spawn/member.js';
import { neutralizeInterpolation } from './sessionPersona.js';
import { registerMemberSession } from './usage.js';

/** Label prefix identifying eteams member children. */
export const MEMBER_LABEL_PREFIX = 'eteams-member:';

/**
 * `eteams-member:<teamId>:<mainTaskId>:<employeeId>`（v7：标签带任务作用域
 * ——同一成员每个大任务各一套副本行/子会话，setup hook 按 (mainTaskId,
 * employeeId) 定位到精确副本行）。
 */
export function buildMemberLabel(teamId: string, mainTaskId: number, employeeId: number): string {
  return `${MEMBER_LABEL_PREFIX}${teamId}:${mainTaskId}:${employeeId}`;
}

/**
 * Inverse of {@link buildMemberLabel}：新格式解析出 (teamId, mainTaskId,
 * employeeId)；旧格式（`…:<memberName>`，升级前的存量子会话）退 memberName。
 */
export function parseMemberLabel(
  label: string | undefined,
): { teamId: string; mainTaskId: number; employeeId: number; memberName?: string } | undefined {
  if (!label || !label.startsWith(MEMBER_LABEL_PREFIX)) return undefined;
  const rest = label.slice(MEMBER_LABEL_PREFIX.length);
  const parts = rest.split(':');
  if (parts.length === 3) {
    const [teamId, mainTaskId, employeeId] = parts as [string, string, string];
    const taskNum = Number.parseInt(mainTaskId, 10);
    const empNum = Number.parseInt(employeeId, 10);
    if (teamId === '' || !Number.isFinite(taskNum) || !Number.isFinite(empNum)) return undefined;
    return { teamId, mainTaskId: taskNum, employeeId: empNum };
  }
  if (parts.length === 2) {
    const [teamId, memberName] = parts as [string, string];
    if (teamId === '' || memberName === '') return undefined;
    return { teamId, mainTaskId: -1, employeeId: -1, memberName };
  }
  return undefined;
}

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
  'eteams_build_wait',
  'eteams_remove_member',
  'eteams_update_member',
  'eteams_create_task',
  'eteams_update_task',
  'eteams_delete_task',
  'eteams_assign_task',
  'eteams_advance_task',
  'eteams_reassign_task',
  'eteams_suspend_task',
  'eteams_resume_task',
  'eteams_cancel_task',
  'eteams_delete_team',
  'eteams_dispatch_captain',
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
 * Spawn one member child as a durable continuable child of the captain（首派
 * 按链起人路径调用，docs/35 §5#3）。原子性：start 失败直接抛，调用方尚未
 * 改任何状态；成功返回 childId，由调用方在事务内回填实例行。
 * 模型路线（用户迭代 2026-09-04「会话默认」）：模板行 model 为空 = 固定用
 * 宿主会话默认模型（sessionDefaultRouteOf，settings agent-default-model），
 * 不再继承领队会话模型；有值 = override（provider 固定用
 * config.memberProvider，路由只挑模型——docs/35 §3#5 既有口径）。
 */
export async function spawnMember(
  env: RuntimeEnv,
  team: TeamState,
  row: TaskMemberRecord,
  captain: Agent,
): Promise<string> {
  const template = memberTemplateOf(team, row.employeeId ?? row.name);
  const persona = template?.persona;
  // 人设手册全文（docs/36 建议 4）：personaMd 有烘全文时用它，结构字段不
  // 再渲染进 persona；无手册（旧数据）退回 executionPrompt。进 persona 前
  // 经 neutralizeInterpolation 转义——宿主对系统提示段做严格 {{变量}} 插值，
  // 用户 md 里的花括号引用会让整段装配抛错（sessionPersona band 同口径）。
  const personaText = neutralizeInterpolation(
    persona?.personaMd !== undefined && persona.personaMd.trim() !== ''
      ? persona.personaMd
      : (persona?.executionPrompt ?? `你是「${row.name}」，以团队成员身份为团队交付。`),
  );
  const route = template?.modelRoute;
  const start = await env.ctx.subagents.startContinuable({
    provider: env.config.memberProvider,
    // v7 标签带任务作用域：副本行 = (工号, 大任务)，setup hook 据此精确定位。
    label: buildMemberLabel(String(team.id), row.mainTaskId ?? 0, row.employeeId ?? 0),
    request: {
      prompt: [{ type: 'text', text: memberWelcome(team, row.name, template) }],
      parent: captain,
      persona: personaText,
      toolFilter: { deny: [...MEMBER_DENIED_TOOLS] },
      ...(route !== undefined && route.model !== ''
        ? {
            agentOptions: {
              // v9 provider 回归：覆盖路线带目录 provider（同 id 模型跨提供方
              // 消歧）；旧数据未记录时省略 provider——运行时按会话默认解析
              // （此前填 config.memberProvider 是 'spawn'/'fork' 传输名，不是
              // LLM provider，实测 2026-09-08 修复）。
              ...(route.provider !== undefined && route.provider !== ''
                ? { provider: route.provider }
                : {}),
              model: route.model,
              ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
            },
          }
        : sessionDefaultRouteOf(env.ctx) !== undefined
          ? {
              // 会话默认（用户迭代 2026-09-04）：宿主 agent-default-model
              // 即时快照——provider/model/reasoningEffort 都是真实路线值。
              agentOptions: sessionDefaultRouteOf(env.ctx),
            }
          : {}),
    },
    signal: env.signal,
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
  opts: { stageBrief?: string; handoff?: string } = {},
): Wake {
  const isStation = task.chain.length > 0;
  const content = assignmentMail(task, { teamName: team.name, attemptId, isStation, ...opts });
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

/**
 * Install the per-child member runtime: identifies eteams member children
 * by their descriptor label, verifies the durable team record, and registers
 * the member tool face into the child scope (captain tools stay denied via
 * the spawn toolFilter). Safe on non-member children (no-op contribution).
 */
export function installMemberRuntime(
  hostCtx: { logger: RuntimeLogger2; subagents?: SubagentInstallFace },
  config: ETeamsResolvedConfig,
  registerMemberTools: (childCtx: Context, env: RuntimeEnv) => void,
): void {
  const subagents = hostCtx.subagents;
  if (!subagents?.registerContinuableSetup) {
    hostCtx.logger.warn(
      'eteams: subagents service unavailable; member tools will not be installed',
    );
    return;
  }
  subagents.registerContinuableSetup((childCtx: Context) => {
    const child = (childCtx as unknown as { agent?: Agent }).agent;
    if (!child) return () => undefined;
    const seedLength =
      (child.session?.header as { seedLength?: number } | undefined)?.seedLength ?? 0;
    const suffix = child.session?.events?.slice(seedLength) ?? [];
    const descriptor = foldSubagentDescriptor(suffix);
    if (descriptor?.mode !== 'continuable') return () => undefined;
    // 声明路线登记（用户迭代 2026-09-07）：所有 continuable 子代理（成员/
    // 领队/构建师）一律记——观测路线的 model 是解析后的上游限定 id，面板
    // 显示以声明的目录级 id 为准（见 runtime/sessionRoutes 模块头）。
    recordSessionRoute(String(child.id), {
      provider: descriptor.agentProvider ?? '',
      model: descriptor.agentModel ?? '',
    });
    const identity = parseMemberLabel(descriptor.label);
    if (!identity) return () => undefined;
    const workspace = child.session?.header?.cwd ?? process.cwd();
    const stateRoot = stateRootOf({ ctx: hostCtx as unknown as RuntimeContext, config, workspace });
    const team = readTeamSync(stateRoot, identity.teamId);
    if (!team) return () => undefined;
    // 父会话校验（docs/36 建议 3；v6 派生判据 docs/51）：子代理的父会话必须
    // 登记在本队任务的 main_session_id 快照里，或正是心跳锚定的主会话（DA38
    // 派发可能用心跳锚起人；任务快照首派补章未提交时由它兜）。
    const parents = new Set(
      team.tasks
        .map((t) => t.mainSessionId)
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    );
    const presence = readBuildPresence(stateRoot);
    if (presence !== null) parents.add(presence.sessionId);
    if (!parents.has(String(child.session?.header?.parentSession ?? ''))) {
      return () => undefined;
    }
    // v7 副本行定位：新标签按 (mainTaskId, employeeId) 精确到任务副本行
    // （同名成员各是各的会话）；旧标签（升级前存量）退按名选行。
    const row = team.taskMembers.find((r) => {
      if (identity.memberName !== undefined) {
        return r.name === identity.memberName && r.status !== 'removed';
      }
      return r.employeeId === identity.employeeId && r.mainTaskId === identity.mainTaskId;
    });
    if (!row) return () => undefined;
    const env: RuntimeEnv = { ctx: hostCtx as unknown as RuntimeContext, config, workspace };
    registerMemberTools(childCtx, env);
    // docs/28 归属注册表：成员子代理会话 → 团队/成员（usage 计量按此解析
    // roleKind='member'；每次 Activation 重跑，冷恢复的会话身份随之重建）。
    registerMemberSession(String(child.id), {
      teamId: String(team.id),
      memberName: row.name,
      employeeId: row.employeeId,
      // 19.18：直接父随登记落表（v6 记子代理头里的真实父会话 id）——访谈
      // 投递冷恢复按它定位领队代理（运行时按 lineage 授权，parent 必须是
      // 真实直接父）。
      parentSessionId: String(child.session?.header?.parentSession ?? ''),
    });
    return () => undefined;
  });
}

type RuntimeLogger2 = { info(message: string): void; warn(message: string): void };
interface SubagentInstallFace {
  registerContinuableSetup(contribution: (childCtx: Context) => () => void): () => void;
}
