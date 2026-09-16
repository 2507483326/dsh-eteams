/**
 * 角色构建回合提示词（docs/19.16 持续构建子代理迭代）。持续构建子代理
 * （每构建一个，startContinuable 建立后由宿主 followup 续聊）各回合共用
 * 的提示词——纯文本函数，不触盘、不依赖 runtime 类型（依赖方向 prompts ←
 * runtime，见 prompts/README.md）。
 *
 * 全相位同一文本（用户迭代 2026-09-10 第三步收敛：对话里只保留一句——
 * 身份 + 调 eteams_build_guide 领规程并严格执行；播报纪律、回合任务、
 * 会话快照、父会话等所需内容全部经规程/工具面获取，提示词一律不带。
 * 2026-09-16 例外：工作目录 / 构建状态目录随提示词写明——那是按会话冻结的
 * 稳定值，不是每回合变化的现状，见 {@link builderPhasePrompt}）。
 * 规程全文（含按 turn 的回合决策表与可用接口清单）= personas/builder.ts
 * 的 ROLE_BUILDER_CHILD_PERSONA（persona 系统段常驻 + 工具返回同文）。
 * 改纪律或决策表只改 personas/builder.ts 一处。
 *
 * @module dsh-eteams/prompts/spawn/builderPhases
 */

export type BuildPhaseKind = 'start' | 'continue' | 'resume' | 'restart';

/** 全相位共用的一句话提示词：身份 + 第一步领规程（其余全部经规程/工具获取）。 */
const TURN_BRIEF =
  '你是「角色构建师」（后台持续构建子代理），使用eteams_build_guide 领取完整构建规程，请严格按规程执行。';

/**
 * Compose the turn prompt: one-line identity + fetch-first pointer + 工作目录块。
 *
 * 工作目录（用户 2026-09-16「所有的子agent提示词里面写清楚工作目录和团队目录」）：
 * 构建子代理不绑任务，故没有任务目录——改给「工作目录（发起构建的对话所在
 * 目录）」与「构建状态目录（rolebuilder.json 所在）」，两者都是稳定值，不会
 * 随回合变化（不会破坏「现状一律经工具自取」的口径）。
 */
export function builderPhasePrompt(dirs: { workDir: string; stateDir: string }): string {
  return [
    TURN_BRIEF,
    '',
    '## 你的工作目录',
    `- 工作目录（发起构建的对话所在目录，**以这个路径为准**）：${dirs.workDir}`,
    `- 构建状态目录（构建会话与访谈状态 rolebuilder.json 所在，由宿主管）：${dirs.stateDir}`,
  ].join('\n');
}
