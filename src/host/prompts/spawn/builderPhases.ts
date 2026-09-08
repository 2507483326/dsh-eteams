/**
 * 角色构建阶段提示词（docs/19.16 持续构建子代理迭代）。持续构建子代理
 * （每构建一个，startContinuable 建立后由宿主 followup 续聊）的各回合任务
 * 提示词——纯文本函数：会话快照由 runtime 读盘后传入，这里不触盘、不依赖
 * runtime 类型（依赖方向 prompts ← runtime，见 prompts/README.md）。
 *
 * start    — 初始回合（startContinuable 的 prompt）：受理 → 查重 → 发布访谈
 *            → 按 popSelf 弹窗或停驻（19.18）→ 同回合起草到 awaiting。
 * continue — followup（面板/父代理中转的访谈答案）：按答案起草到 awaiting。
 * resume   — followup（放弃后继续）：从快照继续（未答则重新出题弹窗）。
 * restart  — followup（重启指令）：核查进度 → 未答重新出题 / 已答续完。
 *
 * 回合收尾分两类（docs/19.17.1）：等访谈答案落盘时调 eteams_build_wait
 * 停驻保持回合开启（零播报，返回后按 persona 决策表去留）；报完待确认草稿
 * （awaiting_confirmation）则直接收束回合——确认入库由宿主直接落库，无须
 * 子代理在场，收尾只写一句「草稿已就绪——请到面板确认入库」。
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
      '【本回合任务】',
      '会话已由宿主开启（status=active，request=激活原文）。直接开始：eteams_member_list 查重（重名要向用户点明是更新）→ eteams_build_report(status=active, step=查重角色库, note=查重结果) → 意图访谈：eteams_build_report(status=active, step=意图访谈, interview={questions:[…]}) 一次问全 ≤5 问，每问 2-4 个 options，推荐项放首位加「（推荐）」。',
      '访谈发布后看播报返回的 popSelf：true → 立即用 ask_user_question 把问题逐题弹给用户（每问映射 { id, question, header, options:[{label, description?}], multi_select: q.multi===true }，选项文案逐字保留；多选题等它返回），拿到答案后：eteams_build_report(answers=[{id, choice}]，choice=所选项 label，多选以「、」连接) → 同回合继续起草，不要提前收束：eteams_build_report(status=active, step=起草统一手册) → step=深化领域章节 → 完整草稿 + status=awaiting_confirmation + step=完成草稿，然后收尾只写一句「草稿已就绪——请到面板确认入库」并直接结束回合（不停驻：确认入库由宿主直接落库，无须你在场）。false → 用户正在别的对话，宿主已把问题中转过去，直接调 eteams_build_wait 停驻等答案落盘（本回合不起草、不追问）。',
      '完整草稿一次报告给全（不做浅合并增量）：全部字段（name/role/profile/duty/style/skills/rules/executionPrompt/personaMd）必须随同一条播报给齐——尤其 personaMd 人设手册全文，缺了宿主会拒绝置待确认（确认页直接渲染它）。',
      '弹窗被拒/报错：不重试——eteams_build_report(interview={questions, popFailed=true}, note=弹窗不可用) 上报后 eteams_build_wait 停驻（宿主会把问题中转到用户所在对话，答案落盘即唤醒你）；弹窗被用户关闭/未答也照样停驻。',
      '本回合不重复发布访谈、不传 newBuild（会话已由宿主开启，覆写会重置会话身份、让卡片重复跳转）；若播报报「会话已结束/已取消」类错误，立即静默结束回合。',
      ROLE_BUILDER_SPEC_TAIL,
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
      '【本回合任务】',
      '宿主把用户作答后的访谈答案（主对话工具中转或面板提交）转交给你。按答案继续：eteams_build_report(status=active, step=起草统一手册) 起草 → step=深化领域章节 深化 → 完整草稿 + status=awaiting_confirmation + step=完成草稿，然后收尾只写一句「草稿已就绪——请到面板确认入库」并直接结束回合（不停驻：确认入库由宿主直接落库，无须你在场）。草稿必须包含全部字段（name/role/profile/duty/style/skills/rules/executionPrompt/personaMd），一次报告给全，不做浅合并增量。',
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
      '【本回合任务】',
      '构建代理被用户手动重启（你是同一持续代理，宿主唤醒你重新核查）。先 eteams_build_report(status=active, step=重启核查) 同步进度（沿用原步骤与草稿）。然后判断：若意图访谈尚无答案——重新发布访谈（eteams_build_report(status=active, step=意图访谈, interview={questions:[…]})，问题可按已有草稿调整，一次问全 ≤5 问，每问 2-4 个 options），随后看播报返回的 popSelf：true → 立即用 ask_user_question 原样弹给用户（映射与选项保留规则同上），拿到答案后 eteams_build_report(answers=[{id, choice}]) 内联落盘并继续起草到 awaiting_confirmation；false → 直接 eteams_build_wait 停驻等答案落盘（本回合不起草，宿主已把问题中转到用户所在对话）；若弹窗被拒/报错：eteams_build_report(interview={questions, popFailed=true}, note=弹窗不可用) 上报后 eteams_build_wait 停驻（宿主中转兜底，答案落盘即唤醒）；弹窗被关闭/未答也照样停驻。否则直接续完：起草统一手册 → 深化领域章节 → 完整草稿 + status=awaiting_confirmation + step=完成草稿，然后收尾只写一句「草稿已就绪——请到面板确认入库」并直接结束回合（不停驻：确认入库由宿主直接落库，无须你在场）。',
      ROLE_BUILDER_SPEC_TAIL,
      '',
      ...snapshot,
      ...(transcript !== '' ? ['', '【意图访谈逐题作答】', transcript] : []),
    ].join('\n');
  }
  return [
    ROLE_BUILDER_CHILD_PERSONA,
    '',
    '【本回合任务】',
    '构建曾被用户放弃，宿主已恢复本次构建并唤醒你（你是同一持续代理，或经冷恢复重建的新持有者）。先 eteams_build_report(status=active) 同步恢复进度（沿用原步骤与草稿）。然后判断：若意图访谈尚无答案——重新发布访谈（eteams_build_report(step=意图访谈, interview={questions})，问题按已有草稿调整），随后看播报返回的 popSelf：true → 立即用 ask_user_question 原样弹给用户，拿到答案后 eteams_build_report(answers=[{id, choice}]) 内联落盘并继续起草到 awaiting_confirmation；false → 直接 eteams_build_wait 停驻等答案落盘（本回合不起草，宿主已把问题中转到用户所在对话）；若弹窗被拒/报错：eteams_build_report(interview={questions, popFailed=true}) 上报后 eteams_build_wait 停驻（宿主中转兜底，答案落盘即唤醒）；弹窗被关闭/未答也照样停驻。否则直接续完：起草统一手册 → 深化领域章节 → 完整草稿 + status=awaiting_confirmation + step=完成草稿，然后收尾只写一句「草稿已就绪——请到面板确认入库」并直接结束回合（不停驻：确认入库由宿主直接落库，无须你在场）。',
    ROLE_BUILDER_SPEC_TAIL,
    '',
    ...snapshot,
    ...(transcript !== '' ? ['', '【意图访谈逐题作答】', transcript] : []),
  ].join('\n');
}