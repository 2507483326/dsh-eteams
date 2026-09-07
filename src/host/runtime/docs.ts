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
import type { MemberRecord, ModelRouteSnapshot, TaskRecord, TeamState } from '../model/types.js';
import { renderContract, stationLabel } from '../prompts/handoff/mails.js';
import { formatEmployeeId } from './roster.js';
import { memberStatusOf } from './notifier.js';

/** 团队工作目录基准段（相对工作区；任务 work_dir 在它之下分配）。 */
export function teamWorkDirRel(team: TeamState): string {
  return `teams/${sanitizeKey(team.name)}`;
}

/** Absolute team work dir given the workspace. */
export function teamWorkDirAbs(workspace: string, team: TeamState): string {
  return join(workspace, teamWorkDirRel(team));
}

/**
 * Workspace-relative task folder (tool output / panel display, docs/26).
 * work_dir 归任务（docs/35 §3#8）：已分配按任务字面路径原样返回；未分配
 * （新建前的预览路径）按当前命名规则推算，不落库。
 */
export function taskDirRel(team: TeamState, task: TaskRecord): string {
  if (task.workDir) return task.workDir;
  if (task.parentId !== null) {
    const parent = team.tasks.find((t) => t.id === task.parentId);
    if (parent?.workDir) return `${parent.workDir}/sub/${taskSlug(task)}`;
  }
  return `${teamWorkDirRel(team)}/tasks/${taskSlug(task)}`;
}

/**
 * Absolute task folder for one task. docs/26: a group's subtasks nest under
 * the parent folder (`sub/<taskId>-<slug>`), so renaming/removing the parent
 * folder takes the whole subtree with it.
 */
export function taskDirAbs(workspace: string, team: TeamState, task: TaskRecord): string {
  return join(workspace, taskDirRel(team, task));
}

/** Render the idempotent team README (overview view). */
export function renderTeamReadme(team: TeamState): string {
  // 领队就位判据（v8+ 主持行取消）：班底有 is_leader 行即配置了领队。
  const leaderInRoster = team.members.some((m) => m.isLeader === true);
  const lines: string[] = [
    `# ${team.name}`,
    '',
    `- 团队 id：${team.id}`,
    `- 领队：${leaderInRoster ? '项目牧羊人（在册）' : '（未设领队）'}`,
    '',
    '## 成员',
  ];
  // 成员列表按班底行（v7：班底是成员全集中营，领队也是一行；工号挂班底
  // 行——「同名按号找人」，README 即按 ET-xxxx 展示）。状态按工号聚合到
  // 该成员全部任务副本行。
  if (team.members.length === 0) lines.push('（暂无成员）');
  for (const m of team.members) {
    const badge = m.employeeId !== undefined ? ` · ${formatEmployeeId(m.employeeId)}` : '';
    lines.push(
      `- **${m.name}**（${m.role}）${badge} · ${memberStatusOf(team, m.employeeId ?? m.name)} · 路线 ${routeLabel(m)}`,
    );
  }
  lines.push('', '## 任务');
  if (team.tasks.length === 0) lines.push('（暂无任务）');
  const taskLine = (t: TaskRecord, indent = ''): string => {
    const station = stationProgress(t);
    const chainTxt = station !== undefined ? ` · 链 ${station.done}/${station.total}` : '';
    const assignee = t.assignee ? ` · ${t.assignee}` : '';
    const groupTxt =
      t.parentId === null && team.tasks.some((x) => x.parentId === t.id) ? '（任务单）' : '';
    return `${indent}- ${t.id} ${t.subject}${groupTxt} — ${t.status}${assignee}${chainTxt}`;
  };
  for (const t of team.tasks.filter((x) => !x.parentId)) {
    lines.push(taskLine(t));
    for (const sub of team.tasks.filter((x) => x.parentId === t.id))
      lines.push(taskLine(sub, '  '));
  }
  lines.push(
    '',
    '> 本文件由 eteams 自动渲染（幂等视图）；请勿手工编辑，任务笔记写在对应 tasks/<任务号>-<slug>/notes.md。',
    '',
  );
  return lines.join('\n');
}

function routeLabel(m: MemberRecord | undefined): string {
  const r: ModelRouteSnapshot = m?.modelRoute ?? { model: '', reasoningEffort: undefined };
  return r.model === '' ? '跟随' : `${r.model}${r.reasoningEffort ? `@${r.reasoningEffort}` : ''}`;
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
      ? `- 执行链（D11）：${task.chain.map((s, i) => `${i + 1}. ${stationLabel(s.member)}`).join(' → ')} · 进度 ${station.done}/${station.total}`
      : '- 执行链：单站点（无链）',
    '',
    '## 合同',
    renderContract(task),
  ];
  if (task.chain.length > 0) {
    lines.push('', '## 站点简报');
    for (const [i, s] of task.chain.entries()) {
      const mark = i <= task.chainCursor ? '✅' : i === task.chainCursor + 1 ? '▶️' : '⬜';
      lines.push(`${mark} ${i + 1}. **${stationLabel(s.member)}**：${s.stageBrief}`);
    }
  }
  if (task.parentId === null) {
    // docs/26: 大任务容器渲染小任务清单（成员槽接力见各小任务自己的合同）。
    const subs = team.tasks.filter((t) => t.parentId === task.id);
    lines.push('', '## 小任务');
    if (subs.length === 0) lines.push('（尚未拆解）');
    for (const s of subs) {
      const st = stationProgress(s);
      lines.push(
        `- ${s.id} ${s.subject} — ${s.status}${s.assignee ? ` · ${s.assignee}` : ''}${
          st ? ` · 链 ${st.done}/${st.total}` : ''
        }`,
      );
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
  // docs/35 §3#8：work_dir 归任务——任何任务已分配目录即物化文档树；
  // 全无任务时不落（README 也等首个任务）。
  if (!team.tasks.some((t) => t.workDir !== undefined)) return [];
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
