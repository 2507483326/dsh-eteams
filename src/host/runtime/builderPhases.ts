/**
 * One-shot builder-phase spawning (docs/19.16). The role builder no longer
 * uses a durable continuable child: `.eteams/rolebuilder.json` is the durable
 * state (docs/09 磁盘是唯一真相), so each build phase runs as a ONE-SHOT
 * subagent that ends its turn naturally — nothing hangs, nothing needs
 * interrupt/followup, and no resumable agent record is left behind.
 *
 * Phase A `start`    — activation: open session → dedup → publish interview.
 * Phase B `continue` — after panel answers: draft → deepen → awaiting.
 * Phase C `resume`   — after 放弃→继续: finish from the stored context.
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
import {
  ROLE_BUILDER_CHILD_PERSONA,
  ROLE_BUILDER_SPEC_TAIL,
} from '../prompts/roleBuilder.js';

export type BuildPhaseKind = 'start' | 'continue' | 'resume' | 'restart';

const BUILDER_TOOLS = ['eteams_build_report', 'eteams_member_list', 'eteams_member_save', 'ask_user_question'];

/** Compose the phase prompt: shared persona discipline + phase instructions. */
export function buildPhasePrompt(kind: BuildPhaseKind, stateRoot: string): string {
  const session = readBuildSession(stateRoot);
  const snapshot = [
    `【原需求】${session?.request ?? '（缺失）'}`,
    `【已完成步骤】${(session?.stepsDone ?? []).join(' → ') || '无'}`,
    `【当前草稿】${session?.draft ? JSON.stringify(session.draft) : '无'}`,
  ];
  if (kind === 'start') {
    return [
      ROLE_BUILDER_CHILD_PERSONA,
      '',
      '【本阶段任务】（完成即结束回合，不等待任何后续消息）',
      '会话已由宿主开启（status=active，request=激活原文）。直接开始：eteams_member_list 查重（重名要向用户点明是更新）→ eteams_build_report(status=active, step=查重成员库, note=查重结果) → 意图访谈：eteams_build_report(status=active, step=意图访谈, interview={questions:[…]}) 一次问全 ≤5 问，每问 2-4 个 options，推荐项放首位加「（推荐）」。',
      '访谈发布后立即用 ask_user_question 把问题原样弹给用户（每问映射 { id, question, header, options:[{label, description?}], multi_select: q.multi===true }，选项文案逐字保留；多选题等它返回）。拿到答案后：eteams_build_report(step=意图访谈, answers=[{id, choice}]，choice=所选项 label，多选以「、」连接）提交后立即结束回合。若 ask_user_question 不可用或报错：不要再尝试，直接结束回合（面板问卷与宿主兜底提醒会接管），不要在聊天文本里复述问题。',
      '本阶段不起草。禁止传 newBuild（会话已开启，覆写会重置会话身份、让卡片重复跳转）；若播报报「会话已结束/已取消」类错误，立即结束回合。',
      '',
      '【激活原文】',
      session?.request ?? '',
    ].join('\n');
  }
  const interview = session?.interview;
  const transcript = (interview?.questions ?? [])
    .map((q) => {
      const hit = interview?.answers?.find((a) => a.id === q.id);
      return `- ${q.question}\n  → ${hit?.choice ?? '（未答）'}`;
    })
    .join('\n');
  if (kind === 'continue') {
    return [
      ROLE_BUILDER_CHILD_PERSONA,
      '',
      '【本阶段任务】（完成即结束回合，不等待任何后续消息）',
      '用户已在面板完成意图访谈。按答案继续：eteams_build_report(status=active, step=起草统一手册) 起草 → step=深化领域章节 深化 → 完整草稿 + status=awaiting_confirmation + step=完成草稿 → 结束回合。草稿必须包含全部字段（name/role/duty/style/skills/rules/executionPrompt/personaMd），一次报告给全，不做浅合并增量。',
      ROLE_BUILDER_SPEC_TAIL,
      '',
      ...snapshot,
      '',
      '【意图访谈逐题作答】',
      transcript,
    ].join('\n');
  }
  if (kind === 'restart') {
    return [
      ROLE_BUILDER_CHILD_PERSONA,
      '',
      '【本阶段任务】（完成即结束回合，不等待任何后续消息）',
      '构建代理被用户手动重启（阶段代理是一次性的：前任已收工，你就是新任）。先 eteams_build_report(status=active, step=重启核查) 同步进度（沿用原步骤与草稿）。然后判断：若意图访谈尚无答案——重新发布访谈（eteams_build_report(status=active, step=意图访谈, interview={questions:[…]})，问题可按已有草稿调整，一次问全 ≤5 问，每问 2-4 个 options），随后立即用 ask_user_question 原样弹给用户（映射与选项保留规则同上），拿到答案后 eteams_build_report(answers=[{id, choice}]) 提交并结束回合；若 ask_user_question 不可用或报错：直接结束回合（面板与宿主兜底会接管）。否则直接续完：起草统一手册 → 深化领域章节 → 完整草稿 + status=awaiting_confirmation + step=完成草稿 → 结束回合。',
      ROLE_BUILDER_SPEC_TAIL,
      '',
      ...snapshot,
      ...(transcript !== '' ? ['', '【意图访谈逐题作答】', transcript] : []),
    ].join('\n');
  }
  return [
    ROLE_BUILDER_CHILD_PERSONA,
    '',
    '【本阶段任务】（完成即结束回合，不等待任何后续消息）',
    '构建曾被用户放弃，现已恢复。先 eteams_build_report(status=active) 同步恢复进度（沿用原步骤与草稿）。然后判断：若意图访谈尚无答案——重新发布访谈（eteams_build_report(step=意图访谈, interview={questions})，问题按已有草稿调整），随后立即用 ask_user_question 原样弹给用户，拿到答案后 eteams_build_report(answers=[{id, choice}]) 提交并结束回合；若 ask_user_question 不可用：直接结束回合。否则直接续完：起草统一手册 → 深化领域章节 → 完整草稿 + status=awaiting_confirmation + step=完成草稿 → 结束回合。',
    ROLE_BUILDER_SPEC_TAIL,
    '',
    ...snapshot,
    ...(transcript !== '' ? ['', '【意图访谈逐题作答】', transcript] : []),
  ].join('\n');
}

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
    .then(() =>
      subagents.start(config.memberProvider, {
        label: 'eteams-rolebuilder',
        prompt: [{ type: 'text', text: buildPhasePrompt(kind, stateRoot) }],
        parent,
        signal: new AbortController().signal,
        persona: ROLE_BUILDER_CHILD_PERSONA,
        toolFilter: {
          deny: MEMBER_DENIED_TOOLS.filter((tool) => !BUILDER_TOOLS.includes(tool)),
        },
      }),
    )
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
