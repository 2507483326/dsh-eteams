/**
 * 角色构建回合提示词（docs/19.16 持续构建子代理迭代）。持续构建子代理
 * （每构建一个，startContinuable 建立后由宿主 followup 续聊）各回合共用
 * 的提示词——纯文本函数，不触盘、不依赖 runtime 类型（依赖方向 prompts ←
 * runtime，见 prompts/README.md）。
 *
 * 全相位同一文本（用户迭代 2026-09-10 第三步收敛：对话里只保留一句——
 * 身份 + 调 eteams_build_guide 领规程并严格执行；播报纪律、回合任务、
 * 会话快照、父会话等所需内容全部经规程/工具面获取，提示词一律不带）。
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

/** Compose the turn prompt: one-line identity + fetch-first pointer. */
export function builderPhasePrompt(): string {
  return TURN_BRIEF;
}
