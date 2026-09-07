/**
 * 团队绑定 band 文本组装（docs/26 对话调用团队执行任务）：the composer's
 * 团队 button binds the conversation to a team; the session agent's prompt
 * gains a 团队绑定 band（每次组装时对照活团队现读）。纯文本函数：绑定查表
 * 、活团队快照解析、领队子代理注册表守卫都由 runtime 薄壳
 * （runtime/sessionTeam.ts）完成后传参（依赖方向 prompts ← runtime）。
 *
 * 两个分支：
 * - 团队已不存在（被删除或归档）→ 失效提示，请用户在弹层取消选择；
 * - 团队健在 → 生效中，分工再按 hasLeader 分支：
 *   - 有领队：**持续领队子代理主持**。主会话不再自己扮演领队，只把任务经
 *     `eteams_dispatch_captain` 转交持续领队子代理；问询由子代理的
 *     `ask_user_question` 弹窗直接弹给用户，汇报经 report 通道送达主对话。
 *   - 无领队：**本会话直接主持**——直接调用领队工具完善与推进任务
 *     （提交/问询/拆解/汇报），不自批开跑（面板手动建任务的完善路径同一
 *     口径，docs/panelTaskCommission）。
 *
 * 绑定即意图：band 不要求用户消息点名团队——选中团队 = 本对话的任务都
 * 交给该团队；只有纯问答/闲聊本会话直答。常驻领队段同步声明绑定会话以
 * 本 band 为准，压掉「只在用户明确要求多代理协作时进入领队流程」的旧口径。
 *
 * @module dsh-eteams/prompts/system/sessionTeam
 */
import { neutralizeInterpolation } from './sessionPersona.js';

/**
 * band 组装入参（判别联合）：runtime 薄壳查到绑定后、按活团队快照是否
 * 存在给出分支——失效分支的 `name` 取绑定时记录的团队名（团队已删，磁盘
 * 无名可读），生效分支的 `name`/`taskCount` 取现读快照。
 */
export type SessionTeamBandInput =
  | { kind: 'dead'; name: string }
  | { kind: 'live'; name: string; taskCount: number; hasLeader: boolean };

/**
 * The 团队绑定 band text for one bound session. `''` contributes nothing —
 * the unbound / captain-child / dead-lookup 空段语义在 runtime 薄壳里。
 */
export function sessionTeamBand(team: SessionTeamBandInput): string {
  if (team.kind === 'dead') {
    return [
      '【eteams 团队绑定·失效】',
      `本会话绑定的团队「${neutralizeInterpolation(team.name)}」已不存在（被删除或归档）。`,
      '告诉用户在输入栏「团队」弹层取消选择或换一个团队；不要对已删除的团队调用任何 eteams_* 工具。',
    ].join('\n');
  }
  // 无领队团队：分工段改为本会话直接主持（hasLeader 分支，docs/panelTaskCommission）。
  if (!team.hasLeader) {
    return [
      '【eteams 团队绑定·生效中】',
      `本会话绑定团队「${neutralizeInterpolation(team.name)}」（${team.taskCount} 个任务在案）。`,
      // 用户迭代 2026-09-03「选择团队然后使用团队开始任务，主对话直接开始完成
      // 任务」：实测模型看到 band 仍以「消息没点名团队」为由自己动手（把触发
      // 条件当成显式短语匹配）。改为绑定即意图：选中团队 = 本对话的任务都
      // 交给团队，是否点名团队无关；只有纯问答/闲聊本会话直答。
      '绑定即用户意图：在弹层选中团队 = 用户把本对话的任务交给该团队——与消息里是否点名团队无关，也不要揣测用户是否真想用团队。',
      '',
      '分工：本团队未设领队——团队工作流（提交任务单、问询、拆解、汇报）由本会话直接主持：',
      '1. 用户提出任何任务/工作请求 → 直接 eteams_submit_task 建主任务（任务单），再问询明确目标（结论 eteams_update_task 写回）、eteams_create_task（带 parentTaskId）拆解小任务；',
      '2. 问询用 ask_user_question 弹窗直接弹给用户；每轮进展简短汇报给用户；',
      '3. 红线：只做计划与拆解，不自批开跑——指派（eteams_assign_task）等用户批准后再做；写代码/改文件/跑命令等执行动作由小任务派发给成员，本会话不动手执行。',
    ].join('\n');
  }
  return [
    '【eteams 团队绑定·生效中】',
    `本会话绑定团队「${neutralizeInterpolation(team.name)}」（${team.taskCount} 个任务在案）。`,
    // 用户迭代 2026-09-03「选择团队然后使用团队开始任务，主对话直接开始完成
    // 任务」：实测模型看到 band 仍以「消息没点名团队」为由自己动手（把触发
    // 条件当成显式短语匹配）。改为绑定即意图：选中团队 = 本对话的任务都
    // 交给团队，是否点名团队无关；只有纯问答/闲聊本会话直答。
    '绑定即用户意图：在弹层选中团队 = 用户把本对话的任务交给该团队——与消息里是否点名团队无关，也不要揣测用户是否真想用团队。',
    '',
    '分工：团队工作流（提交任务单、问询、拆解、指派、汇报）由持续领队子代理主持——本会话只负责转交与展示：',
    '1. 用户提出任何任务/工作请求 → 立即 eteams_dispatch_captain（message=用户原话）转交，本会话不自己动手执行；用户答复领队的问询、或收到团队邮件/面板通知 → 同样转交（message=答复原文或通知要点）；',
    '2. dispatch 立即返回受理确认；领队的问询（ask_user_question 弹窗）与汇报（「Background subagent … reported:」子代理消息）随后直接到达本对话——原样展示给用户即可（或一句简短确认），不要复述全文、不要替领队补充或回答；',
    '3. 只有不需要动手产出任何东西的纯问答、闲聊才由本会话直接回应；写代码/改文件/跑命令等一切执行类请求都必须转交——不要直接调用其它 eteams_* 工具，也不要自己动手执行。',
  ].join('\n');
}