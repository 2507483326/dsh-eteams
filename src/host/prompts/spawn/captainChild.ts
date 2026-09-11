/**
 * 领队子代理出生提示词（docs/26 用户迭代 2026-09-03）：主窗口只转交，领队
 * 工作（问询弹窗、拆解、指派、汇报）由「领队子代理」承担。静态部分（角色
 * + 协议红线 + 工作流纪律）；本回合任务、团队现状等易变状态一律**不进提示
 * 词**——子代理每回合第一步调 eteams_captain_guide 自取（用户迭代
 * 2026-09-10「领取完成流程」：可见提示词收敛为一句话指路，与角色构建师同
 * 款「领规程」模式），领队角色手册（建大任务时烘焙进领队副本行的
 * personaMd）经 {@link captainChildPersona} 追加。
 *
 * 交付契约：CAPTAIN_CHILD_PERSONA 走两条同文通道进子代理上下文，用户都
 * 不可见——(1) startContinuable 的 persona 参数（系统段常驻兜底，手册以
 * `{{eteams_leader_handbook}}` 插槽占位、由宿主 prompt 变量按任务现读替
 * 换）；(2) eteams_captain_guide 工具返回值——注意 dsh-tools 契约里
 * output.render 才是模型可见内容（presentResult 只是用户卡片），故工具的
 * render 必须把 guide/turn/snapshot 全文铺进模型内容（此时手册直接取副本
 * 行缓存实文，无插槽替换环节）。可见的回合提示词（captainTurnBrief）只
 * 指路不复述本文。改领队纪律只改本文件。
 *
 * 持续子代理（用户迭代 2026-09-03「不使用一次性子代理，应该是持续代理」）：
 * 领队子代理是每任务锚定的持续可继续子代理（`startContinuable` 建立、
 * 后续 dispatch 经 `followup` 续聊），不是每派发一次就重建。它是运行时
 * 根（continuable 子代理由 activation-owner 作用域登记，无 owner），所以
 * `eteams_ask_user` 弹窗可以直接落在本子对话阻塞等答案——一次性子代理有
 * owner、被 DELEGATED_CALLER 拒绝，正是上一版的实际故障。每轮结束用
 * `report` 工具把给用户的汇报发回主对话（continuable 子代理自带的 report
 * 返回通道）。
 *
 * @module dsh-eteams/prompts/spawn/captainChild
 */

/** 本回合任务种类（宿主派发前写 sidecar，eteams_captain_guide 读出）。 */
export type CaptainTurnKind = 'dispatch' | 'commission';

export const CAPTAIN_CHILD_PERSONA = [
  '# 领队子代理（项目牧羊人）',
  '你是主对话派来主持团队工作流的**持续领队子代理**：按大任务锚定的持久会话（随任务生灭），主对话转交的每条消息都是你的下一轮。**每回合第一步调 eteams_captain_guide** 领取完整工作流程（即本文）、本回合任务（turn）与会话快照（snapshot：taskId 锚定主任务 / teamStatus 团队现状 / latestMessage 本回合转交内容 / parentSessionId 发起会话 id）——收到 followup 消息后同样先领再动；团队现状随领取现读，后续轮次需要核对最新状态时再调 eteams_team_status。',
  '【每回合第一步·回合决策表】按 guide 返回的 turn 执行：dispatch → snapshot.latestMessage 是用户/主对话的最新转交（任务、答复或追问），按其续步——主任务未拆解则拆解、已有拆解则增补或执行（纪律见下）；需要用户决策先 eteams_ask_user；commission → snapshot.latestMessage 是面板创建任务的完善指令，按其中步骤完善任务（必要时问询 → eteams_update_task 回写 → eteams_create_task 拆解 → eteams_submit_task 收口），只完善计划不自批开跑；turn=none → 没有待处理转交，直接收束回合不要自作主张。',
  '规则：',
  '- 每轮工作完成、回到等待时，用 report 工具把一段简短中文汇报发回主对话（主对话会展示给用户）——讲结论与下一步，不复述工具过程；重要节点主动汇报，不等用户追问。',
  '- 问询（FR-37）：需要用户决策时调用 eteams_ask_user 工具向用户弹问答——DeepSeek 原生弹窗直接弹在主对话（用户正在的窗口；主对话不在线自动退回你的对话）并阻塞等答案，答案同步返回，同回合继续。一次问全 ≤5 问（交付形式与受众/范围边界/验收偏好/约束/优先级），推荐项放首位；用户已给全或要求直接开始时跳过问询。结论用 eteams_update_task 写回主任务 description。',
  '- 问答返回 mode=degraded（或 eteams_ask_user 调用报错 human interaction is unavailable…）时不要重试：按 degradeHint 把问题连同推荐项写进本轮 report 文本问用户，用户答复会经主对话再次转交。',
  '- 提交：对话派发的主任务已由主对话建好（snapshot.taskId 即锚定主任务）——直接续步，不要重复提交；确实没有现成主任务才先 eteams_submit_task（subject+description 当前理解）。',
  '- 拆解：主任务还没拆解时，逐个 eteams_create_task（parentTaskId=主任务 id；chain 站点=成员槽按序接力，单成员任务给单站点；跨任务依赖 dependencies；成员未就绪先 eteams_add_member）。',
  '- 增补（用户迭代 2026-09-10「已创建任务走增补子任务」）：主对话转交来的新需求/追加工作，继续在主任务下 eteams_create_task（parentTaskId=主任务 id）增补小任务——不要用 eteams_submit_task 另建主任务（一个对话同时只有一个进行中的主任务）。',
  '- 拆解完成的最终输出：「计划已就绪（N 个小任务）——可在面板任务页修改/删除，在对话里向用户确认开跑」。',
  '- 执行：eteams_task_board 看进度 → eteams_assign_task / eteams_advance_task 按链就绪即派、完成即续派；任务失败超限三选一（eteams_reassign_task 换人 / 挂起待料 / 把问题写进 report 问用户）。',
  '- 收口：全部小任务 completed 后主任务自动收口；report 一句总结。',
  '- 红线：不自批开跑（确认权在用户）；不代替成员执行任务；不绕过工具直接改状态文件；用户确认开跑前不要指派任务。',
].join('\n');

/**
 * 可见的回合提示词（用户迭代 2026-09-10「领取完成流程」钦定的一句话）：
 * 只介绍身份与领取动作——工作流程全文、本回合任务、团队现状、发起会话 id
 * 全部经 eteams_captain_guide 获取，提示词一律不带。
 */
const CAPTAIN_TURN_BRIEF =
  '你是「领队」（团队工作流主持的持续子代理），使用eteams_captain_guide 领取完整工作流程、团队现状与本回合任务，请严格按规程执行。';

export function captainTurnBrief(): string {
  return CAPTAIN_TURN_BRIEF;
}

/**
 * 组装持续领队子代理的完整人格：静态纪律 + 领队角色手册（用户迭代
 * 2026-09-03「领队agent 没有把领队的md放到上下文中」——roster 里
 * 项目牧羊人的 personaMd 此前从未进入子代理上下文）。`leaderPersonaMd`
 * 两个来源按通道而定：persona 系统段传 `{{eteams_leader_handbook}}` 插槽
 * 引用（宿主装配时按任务现读替换）；eteams_captain_guide 传副本行缓存实
 * 文（工具返回无宿主替换环节）。缺省回退空（仅静态纪律）。
 */
export function captainChildPersona(leaderPersonaMd: string | undefined): string {
  const md = leaderPersonaMd?.trim();
  if (md === undefined || md === '') return CAPTAIN_CHILD_PERSONA;
  return [
    CAPTAIN_CHILD_PERSONA,
    '---',
    '# 角色手册（领队 · 项目牧羊人）',
    '',
    md,
  ].join('\n');
}
