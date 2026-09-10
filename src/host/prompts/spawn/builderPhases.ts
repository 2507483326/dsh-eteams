/**
 * 角色构建阶段提示词（docs/19.16 持续构建子代理迭代）。持续构建子代理
 * （每构建一个，startContinuable 建立后由宿主 followup 续聊）的各回合任务
 * 提示词——纯文本函数：会话快照由 runtime 读盘后传入，这里不触盘、不依赖
 * runtime 类型（依赖方向 prompts ← runtime，见 prompts/README.md）。
 *
 * start    — 初始回合（startContinuable 的 prompt）：受理 → 查重 → 发布访谈
 *            → 按 popSelf 弹窗起草或静默收束 → 本回合/唤醒后起草到 awaiting。
 * continue — followup（面板/父代理中转的访谈答案）：按答案起草到 awaiting。
 * resume   — followup（放弃后继续）：从快照继续（未答则重新出题）。
 * restart  — followup（重启指令）：核查进度 → 未答重新出题 / 已答续完。
 *
 * 分层契约（用户迭代 2026-09-10：构建对话视图里不再出现整墙操作规程）：
 * 全部构建纪律由 persona 系统段承载（ROLE_BUILDER_CHILD_PERSONA，runtime
 * 经 startContinuable 的 persona 参数注入，用户不可见）；可见的回合提示词
 * 只带「任务一行 + 数据快照」，且把「调 eteams_build_guide 领取规程」定为
 * 每回合第一步——模型自己取纪律，而不是指望它在长上下文里回看系统段。
 * 这里不复述规程，改纪律只改 personas/builder.ts 一处。
 *
 * 回合收束纪律（docs/19.17.1，persona 全文承载）：访谈发布/弹窗不可用后
 * 一律立即静默收束回合等宿主唤醒（绝不 eteams_build_wait 停驻）；报完待
 * 确认草稿（awaiting_confirmation）同样直接收束——确认入库由宿主直接落库，
 * 无须子代理在场，收尾只写一句「草稿已就绪——请到面板确认入库」。
 *
 * @module dsh-eteams/prompts/spawn/builderPhases
 */

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

/**
 * 相位共用开场（简短说明）：身份一句 + 第一步领规程（模型自取纪律）+
 * 播报推进——用户在构建对话里读到的就是这一行加任务行，规程全文经
 * eteams_build_guide 返回（persona 系统段同文常驻兜底）。
 */
const BRIEF_HEAD =
  '你是「角色构建师」（后台持续构建子代理）。本回合第一步：先调 eteams_build_guide 领取完整构建规程，再严格按规程执行下面的任务；每一步用 eteams_build_report 播报推进。';

/** Compose the phase prompt: one-line brief + data snapshot (discipline in persona). */
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
      BRIEF_HEAD,
      '【本回合任务】会话已由宿主开启（status=active，request=文末激活原文）：查重角色库 → 发布意图访谈（一次问全）→ 看播报返回的 popSelf——就地弹窗作答并继续起草，或静默收束回合等唤醒 → 起草完整草稿置待确认，收尾一句「草稿已就绪——请到面板确认入库」。',
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
      BRIEF_HEAD,
      '【本回合任务】用户访谈答案已送达（见文末逐题作答）：起草统一手册 → 深化领域章节 → 完整草稿（全部字段一次报全）置待确认，收尾一句「草稿已就绪——请到面板确认入库」。',
      '',
      ...snapshot,
      '',
      '【意图访谈逐题作答】',
      transcript,
    ].join('\n');
  }
  if (kind === 'restart') {
    return [
      BRIEF_HEAD,
      '【本回合任务】构建代理被用户手动重启（你是同一持续代理，宿主唤醒你核查）：先 eteams_build_report(step=重启核查) 同步进度（沿用原步骤与草稿）；访谈尚无答案 → 重新发布访谈（问题可按已有草稿调整）并按 popSelf 路由收束回合；已有答案 → 直接续完到待确认，收尾一句话。',
      '',
      ...snapshot,
      ...(transcript !== '' ? ['', '【意图访谈逐题作答】', transcript] : []),
    ].join('\n');
  }
  return [
    BRIEF_HEAD,
    '【本回合任务】构建曾被放弃，宿主已恢复并唤醒你（同一持续代理或冷恢复的新持有者）：先 eteams_build_report(status=active) 同步恢复进度（沿用原步骤与草稿）；访谈尚无答案 → 重新发布访谈并按 popSelf 路由收束回合；已有答案 → 直接续完到待确认，收尾一句话。',
    '',
    ...snapshot,
    ...(transcript !== '' ? ['', '【意图访谈逐题作答】', transcript] : []),
  ].join('\n');
}
