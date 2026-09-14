/**
 * 成员出生提示词（docs/07.8）：spawn welcome text (persona + contract +
 * task board + protocol) and the standing member behavior rules.
 *
 * @module dsh-eteams/prompts/spawn/member
 */
import type { MemberRecord, TeamState } from '../../model/types.js';
import { personaDigest, renderPersonaBlock } from '../personas/framework.js';

/** Member-facing standing rules (also rendered into contract handoffs). */
export const MEMBER_RULES = [
  '接取：收到指派 → eteams_claim_task（返回 attempt_id + token；token 是后续进度的凭证）。',
  '留言板（用户 2026-09-14）：**开工前先读队伍留言板**（主任务文件夹根下的 `留言板.md`，绝对路径见简报）——看别人做到哪、有什么交接与坑；**做完/交接时在末尾追加一行**「- [时间] 你的名字：做了什么（结论/交接物）」。只记要点，不要长篇复述。',
  '婉拒：接不了（能力/负载/前置缺失）→ eteams_decline_task，写明原因；领队改派。',
  '进度：开工即 eteams_append_progress；阶段节点（方案定了/主路径通了/发现风险）再记；文本 ≤200 字。',
  '自审：完工前对照合同「验收标准」逐条核对并给出证据（能跑通/有复现方式，不是「文件存在」；试边界与错误路径），结论写进 complete 的 output。',
  '完成：交付完成 → eteams_complete_task（output 写清做了什么/改了哪些文件/如何验证——即上条自审结论）；产出同步写入任务 notes.md。**不得在以下情况标完成**：测试在失败、实现只做一半、有未解错误、找不到必要依赖；做不下去用 eteams_fail_task 说明障碍，不要硬撑完成。',
  '失败：做不下去 → eteams_fail_task（error 写具体障碍与已尝试方案）；自动重试超限后落待领队，由领队分诊（重新指派 loop 或升级用户）。',
  '求助：需要决策/跨任务信息 → eteams_send_message 问领队；不要自行扩大范围。只有用户本人能定的问题（范围取舍、验收偏好、与既有决策冲突等）→ 视为**未决项**，用 eteams_ask_user 直接弹窗问用户，问清再继续。提问口径（用户 2026-09-14）：弹窗弹到主对话时用户只有问题本身——问题必须自包含（点名哪个任务/哪一步、为什么问）、说人话（无代号、缩写与行话，术语一句解释）、选项写清「选它会怎样」（禁止 A/B 式无信息量选项），推荐项放首位并标「（推荐）」。',
  '未决项：只有用户能定的问题不得自己填「推荐默认 / 待复核 / 推翻即改」硬推——那是把确认责任转嫁给后续；问询是迭代的，直到无未决项才完工。',
  '纪律：一个 attempt 一个 token；token 失效（被改派/取消）立即停止，重新等指派；空闲后等待领队调度。',
];

/** Member tool cheat sheet (injected once at spawn). */
export const MEMBER_TOOL_SHEET = [
  '- eteams_claim_task { task_id } → attempt_id + token + 合同',
  '- eteams_decline_task { task_id, reason }',
  '- eteams_append_progress { task_id, attempt_id, token, text }',
  '- eteams_complete_task { task_id, attempt_id, token, output, changed_paths? }',
  '- eteams_fail_task { task_id, attempt_id, token, error }',
  '- eteams_task_board {} → 我的任务与状态',
  '- eteams_send_message { to, content } → 领队/成员',
  '- eteams_ask_user { questions } → 弹窗直接问用户（只有用户能定的未决项，问清再继续）',
  '- eteams_team_status {} → 团队概览',
].join('\n');

/**
 * 通用成员简报（用户迭代 2026-09-11；2026-09-14 增「队伍留言板」）：每个任务
 * 成员的出生包与每次指派信都由本模板包住，固定写明四件事——①工作目录（绝对
 * 路径）②队伍留言板（绝对路径 + 读/写纪律）③领队（无领队=主会话）④三节点
 * 实时汇报（开工/遇问题/完成）。抽成纯文本函数供两路复用，避免字面值双轨
 * （runtime 侧组装好值后传参，本函数不读盘）。
 */
export function memberBriefing(opts: {
  teamName: string;
  /** 汇报对象名：有领队 = 领队名；无领队 = 「主会话（用户对话窗口）」。 */
  leaderName: string;
  /** 任务文件夹绝对路径（taskDirAbs）。 */
  workDir: string;
  /** 队伍留言板绝对路径（boardFileAbs：主任务文件夹根下的 留言板.md）。 */
  boardFile: string;
}): string {
  return [
    '## 你的工作目录',
    `- ${opts.workDir}`,
    '- 产出（代码 / 文档 / notes.md）都写在这里；会话当前目录 = 工作区根。',
    '',
    '## 队伍留言板（领队与全员共用）',
    `- ${opts.boardFile}`,
    '- **开工前先读一遍**（看别人做到哪、有什么交接与坑）；**做完/交接时在末尾追加一行**「- [时间] 你的名字：做了什么（结论/交接物）」。只记要点，不要长篇复述。',
    '',
    '## 你的领队',
    `- 领队：${opts.leaderName}。汇报、求助、决策请求都发给他。`,
    '',
    '## 实时汇报（必须发给领队）',
    '1. 开工即报：接取后 eteams_append_progress 记计划，并 eteams_send_message to="captain" 报「已开工 + 计划」。',
    '2. 遇问题即报：障碍 / 需决策 / 发现风险，立即 eteams_send_message to="captain"，不要静默硬扛；其中只有用户本人能定的问题用 eteams_ask_user 直接问用户——别自己填默认值、也别当成「待后续复核」带过。',
    '3. 完成 / 失败必报：eteams_complete_task（产出/改动/验证）、eteams_fail_task（障碍），自动送达领队。',
  ].join('\n');
}

/**
 * The spawn welcome: full persona + rules + tool sheet + first context.
 * `template` 是同名班底模板行（docs/35 §5#12 成员=纯模板），人设从它读；
 * 缺省（无模板行）给极简开场。目标行随 docs/35 §3#1 砍掉——目标不再入库。
 * `briefing` 是通用成员简报（工作目录/领队/三节点汇报，用户迭代
 * 2026-09-11）——出生即有，缺省不注入（旧调用兼容）。
 */
export function memberWelcome(
  team: TeamState,
  name: string,
  template?: MemberRecord,
  briefing?: string,
): string {
  const persona = template?.persona;
  const role = template?.role ?? '成员';
  return [
    `你已被领队拉入团队「${team.name}」，任 ${name}（${role}）。`,
    '',
    ...(briefing !== undefined && briefing.trim() !== '' ? [briefing, ''] : []),
    ...(persona !== undefined
      ? [renderPersonaBlock(persona, name), personaDigest(persona, name)]
      : [`# 人设 · ${name}`]),
    '',
    '## 工作规则',
    ...MEMBER_RULES.map((r) => `- ${r}`),
    '',
    '## 你的工具',
    MEMBER_TOOL_SHEET,
    '',
    '任务详情用 eteams_task_board 查看；任务文档在团队工作目录下对应任务文件夹。现在等待第一条指派。',
  ].join('\n');
}