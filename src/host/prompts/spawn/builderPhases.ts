/**
 * 角色构建阶段提示词（docs/19.16）。角色构建师各阶段（start/continue/
 * restart/resume）发给一次性阶段子代理的任务提示词——纯文本函数：会话
 * 快照由 runtime 读盘后传入，这里不触盘、不依赖 runtime 类型（依赖方向
 * prompts ← runtime，见 prompts/README.md）。
 *
 * Phase A `start`    — activation: open session → dedup → publish interview.
 * Phase B `continue` — after panel answers: draft → deepen → awaiting.
 * Phase C `resume`   — after 放弃→继续: finish from the stored context.
 *
 * @module dsh-eteams/prompts/spawn/builderPhases
 */
import {
  ROLE_BUILDER_CHILD_PERSONA,
  ROLE_BUILDER_SPEC_TAIL,
} from '../personas/builder.js';

export type BuildPhaseKind = 'start' | 'continue' | 'resume' | 'restart';

/**
 * 自含会话快照：runtime/roleBuilder 的 BuildSession 读盘后的结构投影
 * （不 import runtime 类型，保持 prompts 平面单向依赖）。快照整体为
 * null/undefined（会话不存在）与字段缺失的回退语义保持原样——快照行
 * 用「（缺失）」，start 分支激活原文用空串，两处缺省含义不同，不可合并。
 */
export interface BuilderPhaseSnapshot {
  request?: string;
  stepsDone?: string[];
  draft?: unknown;
  interview?: {
    questions?: { id: string; question: string }[];
    answers?: { id: string; choice: string }[];
  } | null;
}

/** Compose the phase prompt: shared persona discipline + phase instructions. */
export function builderPhasePrompt(
  kind: BuildPhaseKind,
  session?: BuilderPhaseSnapshot | null,
): string {
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