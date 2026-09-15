/**
 * Team work documents（用户 2026-09-15 扁平化）：
 * `<workspace>/teams/<主任务号>-slug>/` —— **一个主任务一个目录**，主任务与其
 * 全部小任务共用这个根（团队名不进路径：一块留言板 / 一个计划夹 / 一个文档夹
 * 是「一个主任务」的治理面）。目录下固定四样：
 *
 * - `留言板.md`：create-only，领队与全员共用一块板；
 * - `<任务号>-slug.纪要.md`：每个任务一份（含主任务自己）——上半段是宿主幂等
 *   渲染的合同视图（替代原 contract.md），下半段「纪要正文」由模型写（替代原
 *   各任务目录的 notes.md）；
 * - `计划/`、`文档/`：宿主只建目录，里面文件名与份数完全自由（各 agent 自己
 *   新建，宿主不去重、不落模板）。
 *
 * Docs are NOT state truth — render failures warn but never block (docs/07.2).
 *
 * 存量旧布局（`teams/<团队>/tasks/<任务>/sub/<小任务>/` + contract.md + notes.md）
 * **不迁移、不兼容**（用户 2026-09-15「完全不管旧任务，也不兼容旧任务」）：物化
 * 只认 work_dir 与当前规则相符的主任务，旧目录冻结不动。
 *
 * @module dsh-eteams/runtime/docs
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stationProgress, taskSlug } from '../model/taskMachine.js';
import type { TaskRecord, TeamState } from '../model/types.js';
import { renderContract, stationLabel } from '../prompts/handoff/mails.js';

/** 工作区下的任务工作根（与既有硬编码一致，`config.workRoot` 未接）。 */
const WORK_ROOT = 'teams';

/** 队伍留言板文件名：主任务目录根下、领队与全员共用的一块板。 */
export const BOARD_FILE_NAME = '留言板.md';

/** 计划目录名（只建目录，文件名/份数自由）。 */
export const PLAN_DIR_NAME = '计划';

/** 文档目录名（文档类产出的统一落点，扁平）。 */
export const DOC_DIR_NAME = '文档';

/** 纪要文件名后缀：`<任务号>-<slug>.纪要.md`（号在前，天然唯一）。 */
export const MINUTES_SUFFIX = '.纪要.md';

/** 纪要正文分界标记：上半段宿主幂等渲染，下半段模型书写。 */
export const MINUTES_BODY_MARKER = '## 纪要正文';

/** 正文段空模板（新建纪要文件时的下半段）。 */
const MINUTES_BODY_TEMPLATE = [
  '（开工前先读留言板；完工/交接时在此写：做了什么 / 改了哪些文件 / 如何验证 / 遗留）',
  '',
].join('\n');

/** 大任务根（parentId 为空的容器）；传入的已是根则原样返回。 */
function rootTaskOf(team: TeamState, task: TaskRecord): TaskRecord {
  if (task.parentId === null) return task;
  return team.tasks.find((t) => t.id === task.parentId) ?? task;
}

/**
 * 主任务目录（workspace-relative，新规则纯派生）：`teams/<主任务号>-<slug>`。
 * 小任务不再有自己的目录——主任务与小任务同根（用户 2026-09-15
 * 「不需要这么细」）。
 */
export function taskRootDirRel(team: TeamState, task: TaskRecord): string {
  return `${WORK_ROOT}/${taskSlug(rootTaskOf(team, task))}`;
}

/** Absolute 主任务目录（新规则）。 */
export function taskRootDirAbs(workspace: string, team: TeamState, task: TaskRecord): string {
  return join(workspace, taskRootDirRel(team, task));
}

/**
 * 任务目录（面板显示 / 工具输出 / 打开文件夹）：已分配 work_dir 的按字面返回
 * （存量任务仍指向它自己的旧目录，面板照旧可打开），其余派生到主任务根。
 */
export function taskDirRel(team: TeamState, task: TaskRecord): string {
  return task.workDir ?? taskRootDirRel(team, task);
}

/** Absolute task folder for one task. */
export function taskDirAbs(workspace: string, team: TeamState, task: TaskRecord): string {
  return join(workspace, taskDirRel(team, task));
}

/**
 * 组目录（主任务目录）绝对路径——留言板 / 纪要 / 计划 / 文档都挂在这里。新任务
 * 按新规则；存量任务落到它已物化的旧目录（对在跑的旧任务零行为变化）。
 */
export function groupDirAbs(workspace: string, team: TeamState, task: TaskRecord): string {
  return taskDirAbs(workspace, team, rootTaskOf(team, task));
}

/**
 * 该任务是否参与物化：只有「主任务 + work_dir 与当前规则相符（或未分配）」才算。
 * 存量旧布局（`…/tasks/…`、`…/sub/…`）为 false —— 不建目录、不写文件、不迁移。
 */
export function isCurrentLayout(team: TeamState, task: TaskRecord): boolean {
  if (task.parentId !== null) return false;
  return task.workDir === undefined || task.workDir === taskRootDirRel(team, task);
}

/** 纪要文件名：`<任务号>-<slug>.纪要.md`。 */
export function minutesFileName(task: TaskRecord): string {
  return `${taskSlug(task)}${MINUTES_SUFFIX}`;
}

/** 纪要文件绝对路径（落主任务目录根、扁平）。 */
export function minutesFileAbs(workspace: string, team: TeamState, task: TaskRecord): string {
  return join(groupDirAbs(workspace, team, task), minutesFileName(task));
}

/** 计划目录绝对路径（主任务目录下，内容自由）。 */
export function planDirAbs(workspace: string, team: TeamState, task: TaskRecord): string {
  return join(groupDirAbs(workspace, team, task), PLAN_DIR_NAME);
}

/** 文档目录绝对路径（主任务目录下，文档类产出扁平放）。 */
export function docDirAbs(workspace: string, team: TeamState, task: TaskRecord): string {
  return join(groupDirAbs(workspace, team, task), DOC_DIR_NAME);
}

/**
 * 留言板绝对路径：挂在**主任务目录根**下——同一主任务的领队与全部小任务共用一块
 * 板（小任务成员经它知道别人做到哪、有什么交接与坑）。
 */
export function boardFileAbs(workspace: string, team: TeamState, task: TaskRecord): string {
  return join(groupDirAbs(workspace, team, task), BOARD_FILE_NAME);
}

/** 留言板初始内容（create-only）：标题 + 用法；条目由领队/成员自行追加。 */
export function renderBoardFile(root: TaskRecord): string {
  return [
    `# 留言板 · ${root.id} ${root.subject}`,
    '',
    '> 领队与成员**派发/开工前先读本文件**（看别人做到哪、有什么交接与坑），',
    '> **每做完一步在下方追加一行**「- [时间] 名字：做了什么（结论/交接物）」。只记要点，别长篇复述。',
    '',
  ].join('\n');
}

/**
 * Render one task's 纪要.md：上半段合同视图（幂等重写）+ 下半段纪要正文标记。
 */
export function renderTaskMinutes(team: TeamState, task: TaskRecord): string {
  const station = stationProgress(task);
  const lines: string[] = [
    `# ${task.id} ${task.subject}`,
    '',
    '> 上半段由 eteams 自动渲染（幂等视图，请勿手工编辑）；下半段「纪要正文」由领队/成员书写。',
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
    // docs/26: 大任务容器渲染小任务清单（成员槽接力见各小任务自己的纪要）。
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
  lines.push('', '---', '', MINUTES_BODY_MARKER, '', MINUTES_BODY_TEMPLATE.trimEnd(), '');
  return lines.join('\n');
}

/** 上半段（到正文标记为止，不含标记）。 */
function headOf(minutes: string): string {
  const idx = minutes.indexOf(MINUTES_BODY_MARKER);
  return idx < 0 ? minutes : minutes.slice(0, idx);
}

/** 正文段：取已有文件标记之后的全部内容；无标记（整篇被改写）时整篇当正文，不丢内容。 */
function bodyOf(minutes: string): string {
  const idx = minutes.indexOf(MINUTES_BODY_MARKER);
  return idx < 0 ? minutes : minutes.slice(idx);
}

/**
 * 纪要落盘：先把同号的旧名文件改名到当前名（主题改写后不留重复纪要），再只重写
 * 上半段、原样保住正文段（create-only 语义落在正文上）。
 */
function writeMinutesFile(dir: string, task: TaskRecord, rendered: string): void {
  const name = minutesFileName(task);
  const target = join(dir, name);
  const prefix = `${task.id}-`;
  for (const other of readdirSync(dir)) {
    if (other === name || !other.startsWith(prefix) || !other.endsWith(MINUTES_SUFFIX)) continue;
    if (existsSync(target)) continue;
    try {
      renameSync(join(dir, other), target);
    } catch {
      // 改名失败按新建处理：文档不阻塞状态，下一次物化再补。
    }
  }
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  const next = existing === undefined ? rendered : headOf(rendered) + bodyOf(existing);
  writeFileSync(target, next, 'utf8');
}

/**
 * Materialize the doc tree idempotently for every **新布局**主任务：主任务目录 +
 * `计划/` + `文档/` + create-only 留言板 + 各任务纪要。Never throws to the caller
 * (warn only) per docs/07.2: docs are rendered views of the durable state.
 * @returns warnings collected during rendering.
 */
export function renderTeamDocs(
  workspace: string,
  team: TeamState,
  log?: (msg: string) => void,
): string[] {
  // 存量旧任务（work_dir 与当前规则不符）整块跳过：不建目录、不写文件、不迁移。
  const roots = team.tasks.filter((t) => isCurrentLayout(team, t));
  if (roots.length === 0) return [];
  const warnings: string[] = [];
  const warn = log ?? (() => undefined);
  try {
    for (const root of roots) {
      const dir = taskRootDirAbs(workspace, team, root);
      mkdirSync(join(dir, PLAN_DIR_NAME), { recursive: true });
      mkdirSync(join(dir, DOC_DIR_NAME), { recursive: true });
      const board = join(dir, BOARD_FILE_NAME);
      if (!existsSync(board)) writeFileSync(board, renderBoardFile(root), 'utf8');
      for (const task of [root, ...team.tasks.filter((t) => t.parentId === root.id)]) {
        writeMinutesFile(dir, task, renderTaskMinutes(team, task));
      }
    }
  } catch (error) {
    const msg = `eteams: 任务文档渲染失败（不阻塞状态）：${String(error)}`;
    warnings.push(msg);
    warn(msg);
  }
  return warnings;
}
