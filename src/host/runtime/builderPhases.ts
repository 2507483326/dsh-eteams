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
  readBuildSession,
  setBuildParentSession,
} from './roleBuilder.js';
import {
  ROLE_BUILDER_CHILD_PERSONA,
  ROLE_BUILDER_SPEC_TAIL,
} from '../prompts/roleBuilder.js';

export type BuildPhaseKind = 'start' | 'continue' | 'resume';

const BUILDER_TOOLS = ['eteams_build_report', 'eteams_member_list', 'eteams_member_save'];

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
      '第一条播报必须 eteams_build_report(status=active, newBuild=true, step=收到需求, stepsDone=[收到需求], request=激活原文, note=新构建请求受理——<成员名>) → eteams_member_list 查重（结果并入 note，重名要向用户点明是更新）→ 意图访谈：eteams_build_report(status=active, step=意图访谈, interview={questions:[…]}) 一次问全 ≤5 问，每问 2-4 个 options，推荐项放首位加「（推荐）」→ 立即结束回合（用户在面板作答后宿主会派下一阶段代理）。本阶段不起草。',
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
  return [
    ROLE_BUILDER_CHILD_PERSONA,
    '',
    '【本阶段任务】（完成即结束回合，不等待任何后续消息）',
    '构建曾被用户放弃，现已恢复。先 eteams_build_report(status=active) 同步恢复进度（沿用原步骤与草稿）。然后判断：若意图访谈尚无答案——重新发布访谈（eteams_build_report(step=意图访谈, interview={questions})，问题按已有草稿调整）并结束回合；否则直接续完：起草统一手册 → 深化领域章节 → 完整草稿 + status=awaiting_confirmation + step=完成草稿 → 结束回合。',
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
 */
export function spawnBuildPhase(args: {
  ctx: { subagents: RuntimeContext['subagents'] };
  config: ETeamsResolvedConfig;
  parent: Agent;
  stateRoot: string;
  kind: BuildPhaseKind;
}): void {
  const { ctx, config, parent, stateRoot, kind } = args;
  const subagents = ctx.subagents;
  if (subagents?.start === undefined) return;
  void setBuildParentSession(stateRoot, String(parent.id))
    .catch(() => undefined)
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
      if (run === undefined) return;
      // 官方契约（docs/20.2.1）：消费方必须始终 dispose 一次性 run——自然
      // 完结后立即释放资源、到达静止，而不是把释放时机交给运行时。
      void run.result
        .catch(() => undefined)
        .then(() => run.dispose())
        .catch(() => undefined);
    })
    .catch(() => undefined);
}
