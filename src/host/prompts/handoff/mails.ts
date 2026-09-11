/**
 * Handoff templates (docs/04 prompts/handoff, 07.3): assignment mail,
 * stage handoff pack, completion/failure report bodies, decline/suspend/
 * cancel notices. Pure string assembly — the runtime fills the blanks.
 *
 * @module dsh-eteams/prompts/handoff/mails
 */
import type { TaskRecord } from '../../model/types.js';
import { stationProgress } from '../../model/taskMachine.js';

/** Render the contract section of a task (docs/07.3.1；十六轮 DA29：合同为
 * 一篇 Markdown 全文（task.contractMd），邮件/工具透传原文——旧四数组
 * （验收标准/范围内/范围外/交付物）已合并，段落结构由写合同的一方组织）。 */
export function renderContract(task: TaskRecord): string {
  const lines: string[] = [];
  if (task.description) lines.push(`任务说明：${task.description}`);
  if (task.contractMd !== undefined && task.contractMd.trim() !== '') {
    lines.push('任务合同：', '', task.contractMd.trim());
  }
  if (task.idempotencyNote) lines.push(`幂等说明：${task.idempotencyNote}`);
  if (task.dependencies.length > 0)
    lines.push(`前置依赖：${task.dependencies.join('、')}（产物见对应任务文件夹）`);
  return lines.join('\n');
}

/** v7 站点/成员引用显示：工号（数字/数字串）→ ET-xxxx；名字串原样（旧链
 * 站点兼容——解析不到的旧行保留名字展示）。 */
export function stationLabel(ref: string | number): string {
  if (typeof ref === 'number') return `ET-${String(Math.max(0, ref)).padStart(4, '0')}`;
  const numeric = Number.parseInt(ref.trim(), 10);
  return Number.isFinite(numeric) && numeric > 0 && String(numeric) === ref.trim()
    ? `ET-${String(numeric).padStart(4, '0')}`
    : ref;
}

/** Assignment / stage-handoff mail body (docs/07.3.1 模板；attempt_id 整数号). */
export function assignmentMail(
  task: TaskRecord,
  opts: {
    teamName: string;
    stageBrief?: string;
    handoff?: string;
    attemptId: number;
    isStation: boolean;
    stationIndex?: number;
  },
): string {
  const station = stationProgress(task);
  const header = opts.isStation
    ? `【指派·执行链】任务 ${task.id} ${task.subject} · 第 ${(opts.stationIndex ?? task.chainCursor + 1) + 1}/${station?.total ?? task.chain.length} 站`
    : `【指派】任务 ${task.id} ${task.subject}`;
  return [
    header,
    renderContract(task),
    opts.isStation && opts.stageBrief ? `本站简报：${opts.stageBrief}` : undefined,
    opts.handoff ? `上一站交接：\n${opts.handoff}` : undefined,
    '',
    '执行要求：',
    '1. eteams_claim_task 接取（获得 attempt_id 与 token）；接不了就 eteams_decline_task 并说明原因。',
    '2. 开工与阶段节点用 eteams_append_progress 记录。',
    '3. 完成 eteams_complete_task（output + changed_paths）；失败 eteams_fail_task 写明障碍。',
    '4. 结论同步写入任务 notes.md（teams 目录）。',
    '',
    `attempt_id：${opts.attemptId}`,
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}

/** Successful report body → captain (docs/07.3.4). */
export function reportCompletedMail(
  task: TaskRecord,
  opts: {
    member: string;
    attemptId: number;
    isFinalStation: boolean;
    output: string;
    changedPaths?: string[];
    nextStation?: string | number;
    nextStageBrief?: string;
  },
): string {
  const lines = [
    `【完成】${opts.member} · 任务 ${task.id} ${task.subject}`,
    `产出：${opts.output}`,
    opts.changedPaths && opts.changedPaths.length > 0
      ? `改动：${opts.changedPaths.join('、')}`
      : undefined,
  ];
  if (opts.isFinalStation) {
    lines.push('任务已全部完成。空闲成员可接新任务，建议你当轮续派（完成即续派）。');
  } else if (opts.nextStation !== undefined) {
    lines.push(
      `下一站：${stationLabel(opts.nextStation)}${
        opts.nextStageBrief ? ` — ${opts.nextStageBrief}` : ''
      }。请用 eteams_advance_task 推进（完成即续派）。`,
    );
  }
  lines.push(`（attempt ${opts.attemptId}）`);
  return lines.filter((l) => l !== undefined).join('\n');
}

/** Failure report body → captain. */
export function reportFailedMail(
  task: TaskRecord,
  opts: {
    member: string;
    attemptId: number;
    error: string;
    willRetry: boolean;
    retryCount: number;
    maxRetries: number;
  },
): string {
  if (opts.willRetry) {
    return `【失败·将重试】${opts.member} · 任务 ${task.id} ${task.subject}\n障碍：${opts.error}\n重试 ${opts.retryCount}/${opts.maxRetries}：已安排同成员立即重试。`;
  }
  return [
    `【失败·待用户】${opts.member} · 任务 ${task.id} ${task.subject}`,
    `障碍：${opts.error}`,
    `重试已达上限（${opts.retryCount}/${opts.maxRetries}）。任务进入 wait_user（待用户）：请 eteams_reassign_task 换人、挂起待料，或向用户说明。`,
    `（attempt ${opts.attemptId}）`,
  ].join('\n');
}

/** Decline notice body → captain. */
export function declineMail(task: TaskRecord, member: string, reason: string): string {
  return `【婉拒】${member} 无法接取任务 ${task.id} ${task.subject}：${reason}\n任务已回到就绪池，请改派或调整合同。`;
}

/** 挂起通知正文 → 成员（原 runtime/assignment.ts 内联文本迁入）。 */
export function suspendedNotice(task: TaskRecord, note?: string): string {
  return `【挂起】任务 ${task.id} ${task.subject} 已被领队挂起${
    note !== undefined ? `：${note}` : ''
  }。停止工作，等待恢复指派。`;
}

/** 取消通知正文 → 成员（原 runtime/assignment.ts 内联文本迁入）。 */
export function cancelledNotice(task: TaskRecord, reason?: string): string {
  return `【取消】任务 ${task.id} ${task.subject} 已被取消${
    reason !== undefined ? `：${reason}` : ''
  }。停止相关工作，保持空闲。`;
}
