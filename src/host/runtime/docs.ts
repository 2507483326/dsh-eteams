/**
 * Team work documents (docs/09.1 file layout, D12): `<workspace>/<workRoot>/<team-slug>/`
 * with an idempotent README.md, per-task `tasks/tN-slug/contract.md` views,
 * and create-only `notes.md` scratch files. Docs are NOT state truth —
 * render failures warn but never block (docs/07.2 note).
 *
 * @module dsh-eteams/runtime/docs
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeKey, stationProgress, taskSlug } from '../model/taskMachine.js';
import type { MemberRecord, TaskRecord, TeamState } from '../model/types.js';
import { renderContract } from '../prompts/handoff.js';

/** Relative work dir for one team (recorded into TeamState at approval). */
export function teamWorkDirRel(team: TeamState): string {
  return `teams/${sanitizeKey(team.name)}`;
}

/** Absolute work dir given the workspace. */
export function teamWorkDirAbs(workspace: string, team: TeamState): string {
  return join(workspace, team.workDir ?? teamWorkDirRel(team));
}

/** Absolute task folder for one task. */
export function taskDirAbs(workspace: string, team: TeamState, task: TaskRecord): string {
  return join(teamWorkDirAbs(workspace, team), 'tasks', taskSlug(task));
}

/** Render the idempotent team README (overview view). */
export function renderTeamReadme(team: TeamState): string {
  const lines: string[] = [
    `# ${team.name}`,
    '',
    `- 团队 id：${team.id}`,
    `- 目标：${team.goal}`,
    `- 状态：${team.phase}${team.planReviewState ? ` · 计划${planReviewLabel(team.planReviewState)}` : ''}`,
    `- 领队会话：${team.captainSessionId}`,
    '',
    '## 成员',
  ];
  const active = team.members.filter((m) => m.status !== 'removed');
  if (active.length === 0) lines.push('（暂无成员）');
  for (const m of active)
    lines.push(`- **${m.name}**（${m.role}）· ${m.status} · 路线 ${routeLabel(m)}`);
  lines.push('', '## 任务');
  if (team.tasks.length === 0) lines.push('（暂无任务）');
  for (const t of team.tasks) {
    const station = stationProgress(t);
    const chainTxt = station !== undefined ? ` · 链 ${station.done}/${station.total}` : '';
    const assignee = t.assignee ? ` · ${t.assignee}` : '';
    lines.push(`- ${t.id} ${t.subject} — ${t.status}${assignee}${chainTxt}`);
  }
  lines.push(
    '',
    '> 本文件由 eteams 自动渲染（幂等视图）；请勿手工编辑，任务笔记写在对应 tasks/tN-*/notes.md。',
    '',
  );
  return lines.join('\n');
}

function planReviewLabel(state: string): string {
  if (state === 'awaiting_review') return '待批准';
  if (state === 'returned') return '已退回';
  return '已批准';
}

function routeLabel(m: MemberRecord): string {
  const r = m.modelRoute;
  return `${r.provider}/${r.model}${r.reasoningEffort ? `@${r.reasoningEffort}` : ''}（${r.source === 'inherited' ? '继承' : '覆盖'}）`;
}

/** Render the idempotent contract view for one task. */
export function renderTaskContract(team: TeamState, task: TaskRecord): string {
  const station = stationProgress(task);
  const lines: string[] = [
    `# ${task.id} ${task.subject}`,
    '',
    `- 状态：${task.status}${task.assignee ? ` · 当前执行：${task.assignee}` : ''}`,
    `- 依赖：${task.dependencies.length > 0 ? task.dependencies.join('、') : '无'}`,
    station !== undefined
      ? `- 执行链（D11）：${task.chain.map((s, i) => `${i + 1}. ${s.member}`).join(' → ')} · 进度 ${station.done}/${station.total}`
      : '- 执行链：单站点（无链）',
    '',
    '## 合同',
    renderContract(task),
  ];
  if (task.chain.length > 0) {
    lines.push('', '## 站点简报');
    for (const [i, s] of task.chain.entries()) {
      const mark = i <= task.chainCursor ? '✅' : i === task.chainCursor + 1 ? '▶️' : '⬜';
      lines.push(`${mark} ${i + 1}. **${s.member}**：${s.stageBrief}`);
    }
  }
  if (task.attempts.length > 0) {
    lines.push('', '## 执行记录');
    for (const a of task.attempts) {
      lines.push(`- ${a.id} · ${a.kind} · ${a.member} · ${a.status}`);
      for (const p of a.progress) lines.push(`  - progress：${p.text}`);
      if (a.result?.output) lines.push(`  - 产出：${a.result.output}`);
      if (a.error) lines.push(`  - 失败：${a.error}`);
    }
  }
  lines.push(
    '',
    '> 本合同由 eteams 自动渲染（幂等视图）；请勿手工编辑，笔记写在同目录 notes.md。',
    '',
  );
  return lines.join('\n');
}

/**
 * Materialize the full doc tree idempotently: README, per-task contract
 * views, and empty notes.md files. Never throws to the caller (warn only)
 * per docs/07.2: docs are rendered views of the durable state.
 * @returns warnings collected during rendering.
 */
export function renderTeamDocs(
  workspace: string,
  team: TeamState,
  log?: (msg: string) => void,
): string[] {
  if (team.phase === 'staged') return []; // workDir is allocated + materialized at approval (D12)
  const warnings: string[] = [];
  const warn = log ?? (() => undefined);
  try {
    const dir = teamWorkDirAbs(workspace, team);
    mkdirSync(join(dir, 'tasks'), { recursive: true });
    writeFileSync(join(dir, 'README.md'), renderTeamReadme(team), 'utf8');
    for (const task of team.tasks) {
      const tDir = taskDirAbs(workspace, team, task);
      mkdirSync(tDir, { recursive: true });
      writeFileSync(join(tDir, 'contract.md'), renderTaskContract(team, task), 'utf8');
      const notes = join(tDir, 'notes.md');
      if (!existsSync(notes))
        writeFileSync(notes, `# ${task.id} ${task.subject} · 任务笔记\n\n`, 'utf8');
    }
  } catch (error) {
    const msg = `eteams: 任务文档渲染失败（不阻塞状态）：${String(error)}`;
    warnings.push(msg);
    warn(msg);
  }
  return warnings;
}
