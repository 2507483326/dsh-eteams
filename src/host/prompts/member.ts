/**
 * Member prompt (docs/07.8): spawn welcome text (persona + contract +
 * task board + protocol) and the standing member behavior rules.
 *
 * @module dsh-eteams/prompts/member
 */
import type { MemberRecord, TeamState } from '../model/types.js';
import { personaDigest, renderPersonaBlock } from './persona.js';

/** Member-facing standing rules (also rendered into contract handoffs). */
export const MEMBER_RULES = [
  '接取：收到指派 → eteams_claim_task（返回 attempt_id + token；token 是后续进度的凭证）。',
  '婉拒：接不了（能力/负载/前置缺失）→ eteams_decline_task，写明原因；领队改派。',
  '进度：开工即 eteams_append_progress；阶段节点（方案定了/主路径通了/发现风险）再记；文本 ≤200 字。',
  '完成：交付完成 → eteams_complete_task（output 写清做了什么/改了哪些文件/如何验证）；产出同步写入任务 notes.md。',
  '失败：做不下去 → eteams_fail_task（error 写具体障碍与已尝试方案）；领队安排重试或升级。',
  '求助：需要决策/跨任务信息 → eteams_send_message 问领队；不要自行扩大范围。',
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
  '- eteams_team_status {} → 团队概览',
].join('\n');

/** The spawn welcome: full persona + rules + tool sheet + first context. */
export function memberWelcome(team: TeamState, member: MemberRecord): string {
  return [
    `你已被领队拉入团队「${team.name}」，任 ${member.name}（${member.role}）。`,
    `团队目标：${team.goal}`,
    '',
    renderPersonaBlock(member.persona, member.name),
    personaDigest(member.persona, member.name),
    '',
    '## 工作规则',
    ...MEMBER_RULES.map((r) => `- ${r}`),
    '',
    '## 你的工具',
    MEMBER_TOOL_SHEET,
    '',
    '任务详情用 eteams_task_board 查看；任务文档位于 teams 目录下对应任务文件夹。现在等待第一条指派。',
  ].join('\n');
}
