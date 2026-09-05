/**
 * Continuable builder-child dispatch（docs/19.16 持续构建子代理迭代，取代
 * 一次性阶段制）：每构建一个持久可继续子代理——受理时 `startContinuable`
 * 建立（builderChildId 落盘 rolebuilder.json），后续环节（访谈答案中转/
 * 恢复/重启）宿主经 `followup` 送进同一子代理；放弃时 `interrupt` 中断
 * （durable 会话保留，恢复经 followup 或冷恢复重建续聊）；入库时
 * `drainContinuableChildren` 释放驻留。followup 失败（lineage 不符/会话
 * 记录被回收）→ 以快照提示词重建并覆盖落盘 childId（captainDispatch 同款
 * 先续聊后重建）。机制镜像 captainDispatch.ts（docs/26）与 members.ts。
 *
 * Phase prompt text lives in prompts/spawn/builderPhases (纯文本函数)——本
 * 文件只做派发编排：读会话快照 → startContinuable/followup → 落盘 childId。
 *
 * @module dsh-eteams/runtime/builderPhases
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { RuntimeContext } from './base.js';
import type { ETeamsResolvedConfig } from '../config.js';
import { locks } from '../state/lock.js';
import { MEMBER_DENIED_TOOLS } from './members.js';
import {
  markBuilderChild,
  markBuilderWake,
  markPhaseSpawn,
  phaseSpawnLocked,
  readBuildParentSession,
  readBuildSession,
  resumeBuildSession,
  setBuildParentSession,
} from './roleBuilder.js';
import { ROLE_BUILDER_CHILD_PERSONA } from '../prompts/personas/builder.js';
import {
  builderPhasePrompt,
  type BuilderPhaseSnapshot,
  type BuildPhaseKind,
} from '../prompts/spawn/builderPhases.js';

export type { BuildPhaseKind } from '../prompts/spawn/builderPhases.js';

const BUILDER_TOOLS = ['eteams_build_report', 'eteams_member_list', 'eteams_member_save', 'ask_user_question'];

/** followup/interrupt 消息来源（与 notifier/captainDispatch 保持一致）。 */
const BUILDER_SOURCE = { kind: 'plugin' as const, plugin: 'dsh-eteams' };

/** 单构建串行锁 key：resume/restart/访谈唤醒的读改写临界区互斥。 */
const builderLockKey = (stateRoot: string): string => `rolebuilder:${stateRoot}`;

/** Narrow text blocks for subagent payloads (harness turns are text-only). */
const textTurn = (value: string): { type: 'text'; text: string }[] => [
  { type: 'text', text: value },
];

/** Shared dispatch args（调用方：/eteam 处理器、build_dispatch 工具、面板路由）。 */
interface BuilderDispatchArgs {
  ctx: { subagents: RuntimeContext['subagents'] };
  config: ETeamsResolvedConfig;
  parent: Agent;
  stateRoot: string;
  logger?: { warn(message: string): void };
  /**
   * Spawn-rejection hook（受理即写盘的配套）：调用方在派发前已把受理会话
   * 写上磁盘（active），子代理一旦建不起来（NO_PROVIDER/能力缺失/续聊与
   * 重建都失败），必须把会话回滚成 cancelled——否则一个没有子代理的
   * active 会话会卡住 /eteam 门禁，用户只能手动去面板放弃。
   */
  onSpawnFailure?: (error: unknown) => void;
}

const BUILDER_LABEL = 'eteams-rolebuilder';

const failMessage = (stage: string, error: unknown): string =>
  `eteams: builder child ${stage} — ${
    error instanceof Error ? error.message : String(error)
  }`;

/** 子代理 toolFilter（与一次性时代一致：成员禁刀里留出构建四件套）。 */
const builderToolFilter = (): { deny: string[] } => ({
  deny: MEMBER_DENIED_TOOLS.filter((tool) => !BUILDER_TOOLS.includes(tool)),
});

/** 会话快照投影（读盘 → prompts 平面自含快照）。 */
function snapshotOf(stateRoot: string): BuilderPhaseSnapshot | null {
  const session = readBuildSession(stateRoot);
  return session === null
    ? null
    : {
        request: session.request,
        stepsDone: session.stepsDone,
        draft: session.draft,
        interview: session.interview,
      };
}

/** subagents 服务能力探测：continuable 派发需要 startContinuable + followup。 */
function subagentsReady(ctx: BuilderDispatchArgs['ctx']): boolean {
  const subagents = ctx.subagents;
  return subagents?.startContinuable !== undefined && subagents?.followup !== undefined;
}

/**
 * 受理即建立持续构建子代理（fire-and-forget）：`startContinuable` 建立并把
 * durable childId 落盘（builderChildId）。60 秒 start 派发锁保留，且检查与
 * 落位走单构建文件锁（check+mark 原子化——两个真正并发的受理源只有一个
 * 起代理）。失败策略与一次性时代一致：本函数不抛，但失败必经 logger/
 * onSpawnFailure 显式上浮——吞掉的 spawn 失败看起来就像「/eteam 没有反
 * 应」。注意：60 秒锁拒绝 = 会话健康、由先行者负责，onSpawnFailure 绝不
 * 触发（否则回滚会把健康的构建取消掉）。
 */
export function startBuilderChild(args: BuilderDispatchArgs): void {
  const { ctx, config, parent, stateRoot, logger, onSpawnFailure } = args;
  void locks
    .withLock(builderLockKey(stateRoot), async () => {
      if (!subagentsReady(ctx)) {
        throw new Error('subagents 服务不可用');
      }
      const subagents = ctx.subagents;
      if (phaseSpawnLocked(stateRoot, 'start')) {
        logger?.warn(
          'eteams: builder child NOT started — dispatch lock held for this session (second acceptance refused)',
        );
        return;
      }
      await markPhaseSpawn(stateRoot, 'start').catch((error) => {
        logger?.warn(
          `eteams: phase-spawn lock write failed (spawn proceeds): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      // 父会话归属落盘（面板路由的 followup 唤醒需要按它找活父）。
      await setBuildParentSession(stateRoot, String(parent.id)).catch((error) => {
        logger?.warn(failMessage('parent-ref write failed', error));
      });
      const start = await subagents.startContinuable!({
        provider: config.memberProvider,
        label: BUILDER_LABEL,
        request: {
          prompt: textTurn(builderPhasePrompt('start', snapshotOf(stateRoot))),
          parent,
          persona: ROLE_BUILDER_CHILD_PERSONA,
          toolFilter: builderToolFilter(),
        },
        signal: new AbortController().signal,
      });
      await markBuilderChild(stateRoot, String(start.childId));
    })
    .catch((error) => {
      logger?.warn(failMessage('start FAILED', error));
      onSpawnFailure?.(error);
    });
}

/**
 * Wake the continuable builder child with a followup turn（面板路由与主
 * 对话工具的共用出口）：优先 `followup` 续聊同一子代理；失败（宿主重启后
 * 冷恢复失败/lineage 不符/会话记录被回收）→ `startContinuable` 以快照
 * 提示词重建并覆盖落盘 childId。continue 的唤醒去重键（startedAt:
 * answeredAt）落盘会话——面板路由与 eteams_interview_answer 工具双入口
 * 竞态时第二个直接跳过。resume/restart 的互斥与读改写串行走单构建文件锁。
 */
export function wakeBuilderChild(args: {
  ctx: BuilderDispatchArgs['ctx'];
  config: ETeamsResolvedConfig;
  parent: Agent;
  stateRoot: string;
  kind: Exclude<BuildPhaseKind, 'start'>;
  logger?: { warn(message: string): void };
  onSpawnFailure?: (error: unknown) => void;
}): Promise<void> {
  const { ctx, config, parent, stateRoot, kind, logger, onSpawnFailure } = args;
  // 返回链上的 Promise（不抛——catch 内消化）：面板路由 await 它再响应，
  // 200 即「唤醒已落定」；工具/命令面调用方仍可 void 掉 fire-and-forget。
  return locks
    .withLock(builderLockKey(stateRoot), async () => {
      if (!subagentsReady(ctx)) {
        throw new Error('subagents 服务不可用');
      }
      const subagents = ctx.subagents;
      const session = readBuildSession(stateRoot);
      // resume 的互斥翻转（双入口竞态根除）：权威状态检查 + 翻转都在单构建
      // 锁内——两个并发「继续构建」只有第一个看见 cancelled 并翻转，第二个
      // 在锁内看到 active 直接跳过（路由侧的前置校验只负责诚实的 409 文案）。
      if (kind === 'resume') {
        if (session === null || session.status !== 'cancelled') {
          logger?.warn('eteams: resume wake skipped — session no longer cancelled');
          return;
        }
        await resumeBuildSession(stateRoot);
      }
      const snapshot = snapshotOf(stateRoot);
      // 唤醒去重（continue）：同一轮答案只续聊一次——两个入口竞态时第二个
      // 在锁内看到相同键，直接跳过（避免两次 followup 两次起草）。
      if (kind === 'continue' && session !== null) {
        const key = `${session.startedAt}:${session.interview?.answeredAt ?? 'none'}`;
        if (session.builderWakeKey === key) {
          logger?.warn('eteams: builder wake already dispatched for this answer round — skipped');
          return;
        }
        await markBuilderWake(stateRoot, key);
      }
      const prompt = textTurn(builderPhasePrompt(kind, snapshot));
      const childId = session?.builderChildId ?? '';
      if (childId !== '') {
        try {
          await subagents.followup!(
            parent,
            childId as unknown as SessionId,
            prompt,
            { source: { ...BUILDER_SOURCE }, signal: new AbortController().signal },
          );
          return;
        } catch (error) {
          logger?.warn(failMessage(`followup(${kind}) failed — cold-recovery rebuild`, error));
        }
      }
      // 冷恢复重建：新持有者接手同一构建，覆盖落盘 childId。
      const start = await subagents.startContinuable!({
        provider: config.memberProvider,
        label: BUILDER_LABEL,
        request: {
          prompt,
          parent,
          persona: ROLE_BUILDER_CHILD_PERSONA,
          toolFilter: builderToolFilter(),
        },
        signal: new AbortController().signal,
      });
      await markBuilderChild(stateRoot, String(start.childId));
    })
    .catch((error) => {
      logger?.warn(failMessage(`wake(${kind}) FAILED`, error));
      onSpawnFailure?.(error);
    });
}

/**
 * Release/stop the continuable builder child（cancel → interrupt，confirm →
 * drain）：interrupt 只停当前回合、durable 会话保留（恢复经 followup 或
 * 冷恢复重建续聊）；drain 是新运行时的版本门控回收 API（feature-detect，
 * 老运行时静默退化——驻留会话随后续父会话回收）。两类目标缺失/竞态都是
 * 可接受的 no-op，绝不抛错外溢。
 */
export async function stopBuilderChild(args: {
  ctx: { subagents: RuntimeContext['subagents'] };
  parent?: Agent;
  stateRoot: string;
  mode: 'interrupt' | 'drain';
  logger?: { warn(message: string): void };
}): Promise<void> {
  const { ctx, parent, stateRoot, mode, logger } = args;
  const subagents = ctx.subagents;
  const childId = readBuildSession(stateRoot)?.builderChildId ?? '';
  if (childId === '') return;
  if (mode === 'interrupt') {
    if (subagents?.interrupt === undefined) return;
    // authority：活父在 → ancestor（members.ts 同款）；父离线退回 user
    // 权限（父会话 id 从 parent-ref 侧车读取）；两者都拿不到就放弃中断
    // ——终态守卫会挡住子代理的迟到播报，安全网不缺。
    const parentSessionId = readBuildParentSession(stateRoot);
    const authority =
      parent !== undefined
        ? ({ kind: 'ancestor', agent: parent } as const)
        : parentSessionId !== null
          ? ({ kind: 'user', parentSessionId: parentSessionId as unknown as SessionId } as const)
          : undefined;
    if (authority === undefined) return;
    try {
      subagents.interrupt(childId as unknown as SessionId, authority);
    } catch {
      // absent target is an accepted no-op
    }
    return;
  }
  if (subagents?.drainContinuableChildren === undefined || parent === undefined) return;
  try {
    await subagents.drainContinuableChildren(parent, [
      childId as unknown as SessionId,
    ] as unknown as readonly SessionId[]);
  } catch (error) {
    logger?.warn(failMessage('drain failed (kept resident)', error));
  }
}
