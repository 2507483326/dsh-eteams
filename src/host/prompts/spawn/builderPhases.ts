/**
 * 角色构建回合提示词（docs/19.16 持续构建子代理迭代）。持续构建子代理
 * （每构建一个，startContinuable 建立后由宿主 followup 续聊）各回合共用
 * 的提示词——纯文本函数，不触盘、不依赖 runtime 类型（依赖方向 prompts ←
 * runtime，见 prompts/README.md）。
 *
 * 全相位同一文本（用户迭代 2026-09-10 第二步收敛：提示词里不再有「激活
 * 原文 / 本回合任务 / 会话快照」——这些一律让模型下一步自己获取）：可见
 * 提示词只剩「身份 + 第一步调 eteams_build_guide」；工具返回 turn（宿主在
 * 派发/唤醒时经 markBuilderTurn 写进会话的 wakeKind）+ snapshot（原需求/
 * 步骤/草稿/访谈），规程全文（含按 turn 的回合决策表）= personas/
 * builder.ts 的 ROLE_BUILDER_CHILD_PERSONA（persona 系统段常驻 + 工具返回
 * 同文）。改纪律或决策表只改 personas/builder.ts 一处。
 *
 * @module dsh-eteams/prompts/spawn/builderPhases
 */

export type BuildPhaseKind = 'start' | 'continue' | 'resume' | 'restart';

/**
 * 全相位共用的简短提示词：身份一句 + 第一步领规程/任务/快照（模型自取）+
 * 播报推进——用户在构建对话里读到的就这一段，其余全部经工具获取。
 */
const TURN_BRIEF =
  '你是「角色构建师」（后台持续构建子代理）。本回合第一步：调 eteams_build_guide 领取完整构建规程、本回合任务（turn）与会话快照（snapshot），再严格按规程执行；每一步用 eteams_build_report 播报推进。';

/** Compose the turn prompt: identity + fetch-first step (task/snapshot via tool). */
export function builderPhasePrompt(): string {
  return TURN_BRIEF;
}
