/**
 * Handoff templates (docs/04 prompts/handoff, 07.3): assignment mail,
 * stage handoff pack, completion/failure report bodies. Pure string
 * assembly — the runtime fills the blanks.
 *
 * @module dsh-eteams/prompts/handoff
 */
import type { TaskRecord } from '../model/types.js';
import { stationProgress } from '../model/taskMachine.js';

/** Render the contract section of a task (docs/07.3.1). */
export function renderContract(task: TaskRecord): string {
  const lines: string[] = [];
  if (task.description) lines.push(`任务说明：${task.description}`);
  if (task.acceptance && task.acceptance.length > 0) {
    lines.push('验收标准：', ...task.acceptance.map((a, i) => `  ${i + 1}. ${a}`));
  }
  if (task.inScope && task.inScope.length > 0) lines.push(`允许改动：${task.inScope.join('、')}`);
  if (task.outOfScope && task.outOfScope.length > 0)
    lines.push(`禁止改动：${task.outOfScope.join('、')}`);
  if (task.deliverables && task.deliverables.length > 0)
    lines.push(`交付物：${task.deliverables.join('、')}`);
  if (task.idempotencyNote) lines.push(`幂等说明：${task.idempotencyNote}`);
  if (task.dependencies.length > 0)
    lines.push(`前置依赖：${task.dependencies.join('、')}（产物见对应任务文件夹）`);
  return lines.join('\n');
}

/** Assignment / stage-handoff mail body (docs/07.3.1 模板). */
export function assignmentMail(
  task: TaskRecord,
  opts: {
    teamName: string;
    stageBrief?: string;
    handoff?: string;
    attemptId: string;
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
    attemptId: string;
    isFinalStation: boolean;
    output: string;
    changedPaths?: string[];
    nextStation?: string;
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
  } else if (opts.nextStation) {
    lines.push(
      `下一站：${opts.nextStation}${opts.nextStageBrief ? ` — ${opts.nextStageBrief}` : ''}。请用 eteams_advance_task 推进（完成即续派）。`,
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
    attemptId: string;
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
    `【失败·需决策】${opts.member} · 任务 ${task.id} ${task.subject}`,
    `障碍：${opts.error}`,
    `重试已达上限（${opts.retryCount}/${opts.maxRetries}）。任务进入 awaiting_decision：请 eteams_reassign_task 换人、挂起待料，或向用户说明。`,
    `（attempt ${opts.attemptId}）`,
  ].join('\n');
}

/** Decline notice body → captain. */
export function declineMail(task: TaskRecord, member: string, reason: string): string {
  return `【婉拒】${member} 无法接取任务 ${task.id} ${task.subject}：${reason}\n任务已回到就绪池，请改派或调整合同。`;
}

/** Generic notice body (state changes, plan readiness, suspension…). */
export function noticeMail(content: string): string {
  return `【通知】${content}`;
}
