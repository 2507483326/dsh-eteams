/**
 * One-shot builder-phase spawning (docs/19.16). The role builder no longer
 * uses a durable continuable child: `.eteams/rolebuilder.json` is the durable
 * state (docs/09 磁盘是唯一真相), so each build phase runs as a ONE-SHOT
 * subagent that ends its turn naturally — nothing hangs, nothing needs
 * interrupt/followup, and no resumable agent record is left behind.
 *
 * Phase prompt text lives in prompts/spawn/builderPhases (纯文本函数)——本
 * 文件只做派发编排：读会话快照 → 起子代理 → dispose，不拼提示词。
 *
 * @module dsh-eteams/runtime/builderPhases
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { RuntimeContext } from './base.js';
import type { ETeamsResolvedConfig } from '../config.js';
import { MEMBER_DENIED_TOOLS } from './members.js';
import {
  markPhaseSpawn,
  phaseSpawnLocked,
  readBuildSession,
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

/**
 * Spawn one one-shot builder phase (fire-and-forget): the child settles when
 * its turn ends. Also remembers the spawning main-session id so host routes
 * can attribute later phases to a live parent.
 *
 * Failure policy: this function never throws, but spawn failures are NOT
 * silently discarded — pass a `logger` so rejections surface in the host
 * log (a swallowed rejection here looked exactly like "/eteam 没有反应").
 */
export function spawnBuildPhase(args: {
  ctx: { subagents: RuntimeContext['subagents'] };
  config: ETeamsResolvedConfig;
  parent: Agent;
  stateRoot: string;
  kind: BuildPhaseKind;
  logger?: { warn(message: string): void };
  /**
   * Spawn-rejection hook（受理即写盘的配套）：调用方在派发前已把受理会话
   * 写上磁盘（active），start() 一旦被拒（NO_PROVIDER/能力缺失/创建窗口
   * 失败），必须把会话回滚成 cancelled——否则一个没有子代理的 active 会话
   * 会卡住 /eteam 门禁，用户只能手动去面板放弃。
   */
  onSpawnFailure?: (error: unknown) => void;
}): void {
  const { ctx, config, parent, stateRoot, kind, logger, onSpawnFailure } = args;
  const subagents = ctx.subagents;
  if (subagents?.start === undefined) {
    logger?.warn(`eteams: builder phase ${kind} NOT spawned — subagents service unavailable`);
    onSpawnFailure?.(new Error('subagents 服务不可用'));
    return;
  }
  // 派发锁（用户迭代：一次受理只起一个代理）：同一会话 60 秒内同阶段
  // 二次派发直接拒绝——受理路径竞态/重放时不再并行起第二个子代理。
  // 注意：拒绝 = 会话健康、由先行者负责，onSpawnFailure 绝不能触发
  // （否则回滚会把健康的构建取消掉）。
  if (kind === 'start' || kind === 'restart') {
    if (phaseSpawnLocked(stateRoot, kind)) {
      logger?.warn(
        `eteams: builder phase ${kind} NOT spawned — dispatch lock held for this session (second acceptance refused)`,
      );
      return;
    }
    void markPhaseSpawn(stateRoot, kind).catch((error) => {
      logger?.warn(
        `eteams: phase-spawn lock write failed (spawn proceeds): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
  const failMessage = (stage: string, error: unknown): string =>
    `eteams: builder phase ${kind} ${stage} — no card will appear: ${
      error instanceof Error ? error.message : String(error)
    }`;
  void setBuildParentSession(stateRoot, String(parent.id))
    .catch((error) => {
      logger?.warn(failMessage('parent-ref write failed', error));
    })
    .then(() => {
      // 快照在 prompt 构建时刻读盘（原 buildPhasePrompt 内读盘时机不变），
      // 投影成自含快照传给纯文本函数——runtime 不再持有提示词文本。
      const session = readBuildSession(stateRoot);
      const snapshot: BuilderPhaseSnapshot | null =
        session === null
          ? null
          : {
              request: session.request,
              stepsDone: session.stepsDone,
              draft: session.draft,
              interview: session.interview,
            };
      return subagents.start(config.memberProvider, {
        label: 'eteams-rolebuilder',
        prompt: [{ type: 'text', text: builderPhasePrompt(kind, snapshot) }],
        parent,
        signal: new AbortController().signal,
        persona: ROLE_BUILDER_CHILD_PERSONA,
        toolFilter: {
          deny: MEMBER_DENIED_TOOLS.filter((tool) => !BUILDER_TOOLS.includes(tool)),
        },
      });
    })
    .then((run) => {
      if (run === undefined) {
        logger?.warn(`eteams: builder phase ${kind} start returned no run`);
        onSpawnFailure?.(new Error('subagents.start 返回空 run'));
        return;
      }
      // 官方契约（docs/20.2.1）：消费方必须始终 dispose 一次性 run——自然
      // 完结后立即释放资源、到达静止，而不是把释放时机交给运行时。
      void run.result
        .catch((error) => {
          logger?.warn(failMessage('child turn failed', error));
        })
        .then(() => run.dispose())
        .catch((error) => {
          logger?.warn(failMessage('dispose failed', error));
        });
    })
    .catch((error) => {
      logger?.warn(failMessage('spawn FAILED', error));
      onSpawnFailure?.(error);
    });
}

let lastContinueKey = '';

/**
 * Spawn the drafting phase after interview answers land（面板路由与新
 * `eteams_interview_answer` 工具的共用出口）：同一轮答案（startedAt +
 * answeredAt 相同）只派一次——两个入口竞态时第二个直接跳过，避免两个
 * 起草代理同时写会话。
 */
export function spawnContinueAfterAnswers(args: {
  ctx: { subagents: RuntimeContext['subagents'] };
  config: ETeamsResolvedConfig;
  parent: Agent;
  stateRoot: string;
  logger?: { warn(message: string): void };
}): void {
  const session = readBuildSession(args.stateRoot);
  const key =
    session === null
      ? ''
      : `${session.startedAt}:${session.interview?.answeredAt ?? 'none'}`;
  if (key !== '' && key === lastContinueKey) {
    args.logger?.warn('eteams: continue phase already spawned for this answer round — skipped');
    return;
  }
  if (key !== '') lastContinueKey = key;
  spawnBuildPhase({ ...args, kind: 'continue' });
}
