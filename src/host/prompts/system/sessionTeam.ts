/**
 * 团队绑定 band 文本组装（docs/26 对话调用团队执行任务）：the composer's
 * 团队 button binds the conversation to a team; the session agent's prompt
 * gains a 团队绑定 band（每次组装时对照活团队现读）。纯文本函数：绑定查表
 * 、活团队快照解析、领队子代理注册表守卫、锚定主任务判据都由 runtime 薄壳
 * （runtime/sessionTeam.ts）完成后传参（依赖方向 prompts ← runtime）。
 *
 * 绑定即固定（用户迭代 2026-09-10「对话固定为团队对话」）：一个对话只对应
 * 一个团队，徽章常显、不可换队/换角色——band 显式声明固定语义，模型不再
 * 建议用户取消选择或换团队。
 *
 * 生效分支按「是否已有进行中的锚定主任务」再分：
 * - 无锚定主任务 → 原两步走（先建任务、再转交/直接主持）；
 * - 有锚定主任务（用户迭代 2026-09-10「已创建任务走增补子任务」）→ 新的
 *   工作（含全新事项）一律以**增补小任务**进入既有主任务：有领队经
 *   eteams_dispatch_captain 转交（领队挂 parentTaskId 增补），无领队本会
 *   话直接 eteams_create_task 挂 parentTaskId 增补——都不再 eteams_submit_task
 *   另建主任务。
 * - 团队已不存在（被删除或归档）→ 失效提示（宿主删队已清绑定，此支只剩
 *   竞态窗兜底），引导用户在输入栏团队按钮重新选择。
 *
 * @module dsh-eteams/prompts/system/sessionTeam
 */
import { neutralizeInterpolation } from './sessionPersona.js';

/**
 * band 组装入参（判别联合）：runtime 薄壳查到绑定后、按活团队快照是否
 * 存在给出分支——失效分支的 `name` 取绑定时记录的团队名（团队已删，磁盘
 * 无名可读），生效分支的 `name`/`taskCount` 取现读快照，`mainTaskId` 取
 * anchoredMainTaskOf 的锚定判据（undefined = 无进行中主任务）。
 */
export type SessionTeamBandInput =
  | { kind: 'dead'; name: string }
  | { kind: 'live'; name: string; taskCount: number; hasLeader: boolean; mainTaskId?: number };

/** 生效分支共用头（固定语义 + 绑定即意图，两个分工形态逐字同文）。 */
function liveHeader(name: string, taskCount: number): string[] {
  return [
    '【eteams 团队绑定·生效中】',
    `本会话绑定团队「${neutralizeInterpolation(name)}」（${taskCount} 个任务在案）。`,
    // 用户迭代 2026-09-10「对话固定为团队对话」：绑定常驻、不可换队/换角色。
    '本对话已固定为团队对话：一个对话只对应一个团队，不能更换——不要建议用户取消选择或换团队。',
    // 用户迭代 2026-09-03「选择团队然后使用团队开始任务，主对话直接开始完成
    // 任务」：实测模型看到 band 仍以「消息没点名团队」为由自己动手（把触发
    // 条件当成显式短语匹配）。改为绑定即意图：选中团队 = 本对话的任务都
    // 交给团队，是否点名团队无关；只有纯问答/闲聊本会话直答。
    '绑定即用户意图：在弹层选中团队 = 用户把本对话的任务交给该团队——与消息里是否点名团队无关，也不要揣测用户是否真想用团队。',
    // 2026-09-10 统一问答：子代理问答弹 DeepSeek 原生弹窗、直接落在本对话
    // （用户正在的窗口）——主对话零动作，无须代弹代答或转交。
    '团队成员/领队的问询会以原生问答弹窗直接弹在本对话（输入区被问题接管）：用户直接作答即可，答案自动回到提问的子代理、它会同回合继续——本会话无须代答、转交或额外说明，也不要替子代理补充或回答。',
  ];
}

/**
 * The 团队绑定 band text for one bound session. `''` contributes nothing —
 * the unbound / captain-child / dead-lookup 空段语义在 runtime 薄壳里。
 */
export function sessionTeamBand(team: SessionTeamBandInput): string {
  if (team.kind === 'dead') {
    return [
      '【eteams 团队绑定·失效】',
      `本会话绑定的团队「${neutralizeInterpolation(team.name)}」已不存在（被删除或归档）。`,
      '告诉用户该团队已删除；用户可在输入栏「团队」按钮重新选择其他团队。不要对已删除的团队调用任何 eteams_* 工具。',
    ].join('\n');
  }
  // 已有进行中的锚定主任务：新工作一律增补小任务，不再两步走建任务
  // （用户迭代 2026-09-10「已创建任务走增补子任务的逻辑」）。
  if (team.mainTaskId !== undefined) {
    const taskId = team.mainTaskId;
    if (!team.hasLeader) {
      return [
        ...liveHeader(team.name, team.taskCount),
        '',
        `分工（本对话已有进行中的主任务 #${taskId}，团队未设领队——由本会话直接主持）：`,
        `1. 用户提出任何新的任务/工作请求（含全新事项）→ 需要澄清就先 ask_user_question 问询，结论用 eteams_update_task 写回主任务 #${taskId}，然后 eteams_create_task（parentTaskId=${taskId}）在主任务下增补小任务（chain 站点即成员卡槽，拆解时按工号为卡槽填人）；`,
        `2. 不要再 eteams_submit_task 新建主任务——本对话同时只有一个进行中的主任务，新工作一律以增补小任务进入 #${taskId}；`,
        `3. 红线：只做计划与拆解，不自批开跑——指派（eteams_assign_task）等用户批准后再做；不要直接调用 eteams_submit_task 与 eteams_dispatch_captain；写代码/改文件/跑命令等执行动作由小任务派发给成员，本会话不动手执行。`,
      ].join('\n');
    }
    return [
      ...liveHeader(team.name, team.taskCount),
      '',
      `分工（本对话已有进行中的主任务 #${taskId}，工作流由领队子代理主持）：`,
      `1. 用户提出任何新的任务/工作请求（含全新事项）→ 直接 eteams_dispatch_captain（taskId=${taskId}，message=用户原话）转交持续领队子代理（以领队的名字命名）——领队按需问询（ask_user_question 弹窗），并在现有主任务下增补小任务（eteams_create_task 挂 parentTaskId=${taskId}，chain 站点按工号填人）；`,
      `2. 不要再 eteams_submit_task 新建主任务——本对话同时只有一个进行中的主任务，新工作一律以增补小任务进入 #${taskId}；`,
      '3. dispatch 立即返回受理确认；领队的问询与汇报（「Background subagent … reported:」子代理消息）随后直接到达本对话——原样展示给用户即可（或一句简短确认），不要复述全文、不要替领队补充或回答；',
      `4. 红线：只调用 eteams_dispatch_captain，不要调用其它 eteams_* 工具、不要自己动手执行；纯问答、闲聊由本会话直接回应，不要为它们建任务。`,
    ].join('\n');
  }
  // 无锚定主任务：两步走（先建任务、再转交/直接主持）。
  if (!team.hasLeader) {
    return [
      ...liveHeader(team.name, team.taskCount),
      '',
      '分工：本团队未设领队——团队工作流（提交任务单、问询、拆解、汇报）由本会话直接主持：',
      '1. 用户提出任何任务/工作请求 → 直接 eteams_submit_task 建主任务（任务单：subject 把用户原话简化成一句话标题），再问询明确目标（结论 eteams_update_task 写回）、eteams_create_task（带 parentTaskId）拆解小任务；',
      '2. 问询用 ask_user_question 弹窗直接弹给用户；每轮进展简短汇报给用户；',
      '3. 红线：只做计划与拆解，不自批开跑——指派（eteams_assign_task）等用户批准后再做；写代码/改文件/跑命令等执行动作由小任务派发给成员，本会话不动手执行。',
    ].join('\n');
  }
  return [
    ...liveHeader(team.name, team.taskCount),
    '',
    // 用户迭代 2026-09-07 两步走：第一步主会话先建主任务（标题由模型简化，
    // 成员随建任务落位），第二步判断领队并转交持续领队子代理分解分配。
    '分工（对话任务工作流两步走）：',
    '1. 第一步·建任务：用户提出新的任务/工作请求 → 立即 eteams_submit_task 建主任务（任务单）：subject 把用户原话简化成一句话任务标题（不要照抄原话），description 记录用户原话与背景；团队成员已随主任务自动落位，不要重复拉人；',
    '2. 第二步·转交：建好主任务后立即 eteams_dispatch_captain（taskId=主任务号，message=用户原话）转交持续领队子代理（以领队的名字命名）——问询、拆解（eteams_create_task 挂主任务，chain 站点即成员卡槽，拆解时按工号为卡槽填人）与指派（eteams_assign_task，等你批准开跑后才做）全部由领队子代理主持，本会话不自己动手执行；',
    '3. 领队的后续互动照旧经本对话转交：用户答复领队的问询、或收到团队邮件/面板通知 → 同样 eteams_dispatch_captain（taskId=对应主任务号，message=答复原文或通知要点），不要再建新任务；',
    '4. dispatch 立即返回受理确认；领队的问询（原生弹窗直接弹在本对话）与汇报（「Background subagent … reported:」子代理消息）随后直接到达本对话——原样展示给用户即可（或一句简短确认），不要复述全文、不要替领队补充或回答；',
    '5. 红线：除 eteams_submit_task 与 eteams_dispatch_captain 外，不要直接调用其它 eteams_* 工具；纯问答、闲聊由本会话直接回应，不要为它们建任务。',
  ].join('\n');
}
