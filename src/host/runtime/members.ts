/**
 * Member lifecycle (docs/07.2, FR-14/FR-15): continuable spawning, persona
 * injection, model-route snapshots, per-child tool installation, and
 * interruption. This is the only module that starts subagents.
 *
 * @module dsh-eteams/runtime/members
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent';
import type { ETeamsResolvedConfig } from '../config.js';
import type { MemberRecord, TaskRecord, TeamState } from '../model/types.js';
import { readTeamSync } from '../state/store.js';
import { ETeamsError, stateRootOf, type RuntimeContext, type RuntimeEnv } from './base.js';
import { deliverAssignment, queueNotice } from './notifier.js';
import { assignmentMail } from '../prompts/handoff.js';
import { memberWelcome } from '../prompts/member.js';

/** Label prefix identifying eteams member children. */
export const MEMBER_LABEL_PREFIX = 'eteams-member:';

/** `eteams-member:<teamId>:<memberName>` — parsed by the setup hook. */
export function buildMemberLabel(teamId: string, memberName: string): string {
  return `${MEMBER_LABEL_PREFIX}${teamId}:${memberName}`;
}

/** Inverse of {@link buildMemberLabel}. */
export function parseMemberLabel(
  label: string | undefined,
): { teamId: string; memberName: string } | undefined {
  if (!label || !label.startsWith(MEMBER_LABEL_PREFIX)) return undefined;
  const rest = label.slice(MEMBER_LABEL_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep < 1 || sep === rest.length - 1) return undefined;
  return { teamId: rest.slice(0, sep), memberName: rest.slice(sep + 1) };
}

/** Captain tool names denied to members (one visibility, loud deny). */
export const MEMBER_DENIED_TOOLS: readonly string[] = [
  'eteams_create_team',
  'eteams_add_member',
  'eteams_member_save',
  'eteams_member_list',
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
  'eteams_approve_plan',
  'eteams_archive_team',
  'eteams_delete_team',
];

/**
 * Spawn one staged member as a durable continuable child of the captain.
 * Atomic per member: throws before mutating team state if start fails.
 */
export async function spawnMember(
  env: RuntimeEnv,
  team: TeamState,
  member: MemberRecord,
  captain: Agent,
): Promise<string> {
  const route = member.modelRoute;
  const start = await env.ctx.subagents.startContinuable({
    provider: env.config.memberProvider,
    label: buildMemberLabel(team.id, member.name),
    request: {
      prompt: [{ type: 'text', text: memberWelcome(team, member) }],
      parent: captain,
      persona: member.persona.executionPrompt,
      toolFilter: { deny: [...MEMBER_DENIED_TOOLS] },
      ...(route.source === 'override'
        ? {
            agentOptions: {
              provider: route.provider,
              model: route.model,
              ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
            },
          }
        : {}),
    },
    signal: env.signal,
  });
  return String(start.childId);
}

/**
 * Spawn every staged member atomically (docs/07.2): the first failure
 * interrupts the already-started children and rethrows, leaving all
 * members staged.
 */
export async function spawnTeamMembers(
  env: RuntimeEnv,
  team: TeamState,
  captain: Agent,
): Promise<string[]> {
  const staged = team.members.filter((m) => m.status === 'staged');
  const started: string[] = [];
  for (const member of staged) {
    try {
      const childId = await spawnMember(env, team, member, captain);
      started.push(childId);
      member.id = childId;
      member.status = 'ready';
    } catch (error) {
      for (const childId of started) {
        try {
          env.ctx.subagents.interrupt(childId as SessionId, { kind: 'ancestor', agent: captain });
        } catch {
          // best-effort rollback; the cold child stays inert without a team
        }
      }
      throw new ETeamsError(
        `成员「${member.name}」启动失败：${String(error)}`,
        '已回滚本次全部启动；请检查子代理提供方配置后重试批准',
      );
    }
  }
  return started;
}

/** Interrupt one live member's current turn (activation retained). */
export function interruptMember(env: RuntimeEnv, member: MemberRecord, captain: Agent): void {
  if (!member.id) return;
  try {
    env.ctx.subagents.interrupt(member.id as SessionId, { kind: 'ancestor', agent: captain });
  } catch {
    // absent target is an accepted no-op
  }
}

/**
 * Deliver the first assignment mail right after spawn (used by
 * assignTask against a freshly ready member). Kept here so assignment.ts
 * stays free of spawn concerns.
 */
export async function sendAssignment(
  env: RuntimeEnv,
  team: TeamState,
  member: MemberRecord,
  task: TaskRecord,
  attemptId: string,
  opts: { stageBrief?: string; handoff?: string } = {},
): Promise<void> {
  const isStation = task.chain.length > 0;
  const content = assignmentMail(task, { teamName: team.name, attemptId, isStation, ...opts });
  await deliverAssignment(env, team, member, content, { taskId: task.id, attemptId });
}

/** Queue a notice for a not-yet-spawned member (staged roster additions). */
export async function queueStagedNotice(
  env: RuntimeEnv,
  team: TeamState,
  member: MemberRecord,
  content: string,
): Promise<void> {
  await queueNotice(env, team, member.name, content);
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
    const identity = parseMemberLabel(descriptor.label);
    if (!identity) return () => undefined;
    const workspace = child.session?.header?.cwd ?? process.cwd();
    const stateRoot = stateRootOf({ ctx: hostCtx as unknown as RuntimeContext, config, workspace });
    const team = readTeamSync(stateRoot, identity.teamId);
    if (!team || team.captainSessionId !== String(child.session?.header?.parentSession ?? ''))
      return () => undefined;
    const member = team.members.find(
      (m) => m.name === identity.memberName && m.status !== 'removed',
    );
    if (!member) return () => undefined;
    const env: RuntimeEnv = { ctx: hostCtx as unknown as RuntimeContext, config, workspace };
    registerMemberTools(childCtx, env);
    return () => undefined;
  });
}

type RuntimeLogger2 = { info(message: string): void; warn(message: string): void };
interface SubagentInstallFace {
  registerContinuableSetup(contribution: (childCtx: Context) => () => void): () => void;
}
