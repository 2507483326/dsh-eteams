/**
 * 任务工作文档扁平化单测（用户 2026-09-15）：`teams/<主任务号>-slug>/` 一个主任务
 * 一个目录 —— 留言板一块、每任务一份 `<任务号>-slug.纪要.md`（上半段宿主幂等
 * 渲染、下半段纪要正文）、`计划/` 与 `文档/` 只建目录；存量旧布局（tasks/ 与
 * sub/）不迁移、不兼容。覆盖点：路径规则、幂等、create-only、改名不重复、旧
 * work_dir 跳过。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOARD_FILE_NAME,
  DOC_DIR_NAME,
  MINUTES_BODY_MARKER,
  MINUTES_SUFFIX,
  PLAN_DIR_NAME,
  isCurrentLayout,
  minutesFileName,
  renderTeamDocs,
  taskDirRel,
  taskRootDirRel,
} from '../src/host/runtime/docs';
import type { TaskRecord, TeamState } from '../src/host/model/types';

const T0 = 1_000;

function taskOf(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 3,
    subject: '登录服务',
    parentId: null,
    dependencies: [],
    chain: [],
    chainCursor: -1,
    status: 'ready',
    attempts: [],
    retryCount: 0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/** 一个主任务 + 一个小任务的最小团队（不带成员，文档渲染不需要）。 */
function teamOf(group: TaskRecord, subs: TaskRecord[] = []): TeamState {
  return {
    id: 1,
    name: '甲队',
    hasLeader: false,
    createdAt: T0,
    updatedAt: T0,
    members: [],
    taskMembers: [],
    pendingDecisions: [],
    tasks: [group, ...subs],
  } as unknown as TeamState;
}

function workspaceOf(): string {
  return mkdtempSync(join(tmpdir(), 'eteams-taskdocs-'));
}

describe('路径规则（一个主任务一个目录，主任务与小任务共用）', () => {
  it('主任务目录 = teams/<主任务号>-slug；小任务与其同根', () => {
    const group = taskOf({ id: 3, subject: '登录服务', workDir: 'teams/3-登录服务' });
    const sub = taskOf({ id: 4, parentId: 3, subject: '接口鉴权' });
    const team = teamOf(group, [sub]);
    expect(taskRootDirRel(team, group)).toBe('teams/3-登录服务');
    expect(taskRootDirRel(team, sub)).toBe('teams/3-登录服务');
    expect(taskDirRel(team, sub)).toBe('teams/3-登录服务');
    // 纪要按任务命名、落同一个主任务目录。
    expect(minutesFileName(sub)).toBe(`4-接口鉴权${MINUTES_SUFFIX}`);
  });

  it('物化只认新布局：旧 work_dir（tasks/ 或 sub/）一律不算', () => {
    const legacy = taskOf({ id: 3, workDir: 'teams/甲队/tasks/t3-登录服务' });
    const legacySub = taskOf({ id: 4, parentId: 3, workDir: 'teams/甲队/tasks/t3-登录服务/sub/t4-接口鉴权' });
    expect(isCurrentLayout(teamOf(legacy), legacy)).toBe(false);
    // 小任务永不参与物化（没有自己的目录）。
    expect(isCurrentLayout(teamOf(legacy, [legacySub]), legacySub)).toBe(false);
  });
});

describe('物化（留言板 + 每任务纪要 + 计划/文档夹）', () => {
  it('落盘形态正确，且不再有 README / contract.md / notes.md', () => {
    const workspace = workspaceOf();
    const group = taskOf({ id: 3, subject: '登录服务', workDir: 'teams/3-登录服务' });
    const sub = taskOf({ id: 4, parentId: 3, subject: '接口鉴权' });
    const team = teamOf(group, [sub]);
    expect(renderTeamDocs(workspace, team)).toEqual([]);

    const dir = join(workspace, 'teams', '3-登录服务');
    expect(existsSync(join(dir, BOARD_FILE_NAME))).toBe(true);
    expect(existsSync(join(dir, PLAN_DIR_NAME))).toBe(true);
    expect(existsSync(join(dir, DOC_DIR_NAME))).toBe(true);
    expect(existsSync(join(dir, minutesFileName(group)))).toBe(true);
    expect(existsSync(join(dir, minutesFileName(sub)))).toBe(true);
    // 旧物一律不再生成；计划/文档夹里宿主不落任何文件。
    for (const gone of ['README.md', 'contract.md', 'notes.md']) {
      expect(existsSync(join(dir, gone))).toBe(false);
    }
    expect(readdirSync(join(dir, PLAN_DIR_NAME))).toEqual([]);
    expect(readdirSync(join(dir, DOC_DIR_NAME))).toEqual([]);
  });

  it('上半段幂等重渲染、下半段纪要正文字字不动（create-only）', () => {
    const workspace = workspaceOf();
    const group = taskOf({ id: 3, subject: '登录服务', workDir: 'teams/3-登录服务' });
    const team = teamOf(group);
    renderTeamDocs(workspace, team);
    const file = join(workspace, 'teams', '3-登录服务', minutesFileName(group));

    // 成员在正文段落下写结论。
    const first = readFileSync(file, 'utf8');
    expect(first).toContain(MINUTES_BODY_MARKER);
    writeFileSync(file, `${first}### 完工\n- 已交付\n`, 'utf8');

    // 状态变化触发重渲染：正文保住，上半段照常刷新。
    team.tasks[0] = { ...group, status: 'running' };
    renderTeamDocs(workspace, team);
    const second = readFileSync(file, 'utf8');
    expect(second).toContain('- 状态：running');
    expect(second).toContain('### 完工');
    expect(second).toContain('- 已交付');
    expect(second.split(MINUTES_BODY_MARKER)).toHaveLength(2);
  });

  it('留言板 create-only：已存在的内容不被覆盖', () => {
    const workspace = workspaceOf();
    const group = taskOf({ id: 3, subject: '登录服务', workDir: 'teams/3-登录服务' });
    const team = teamOf(group);
    renderTeamDocs(workspace, team);
    const board = join(workspace, 'teams', '3-登录服务', BOARD_FILE_NAME);
    writeFileSync(board, '# 留言板 · 手写一行\n', 'utf8');
    renderTeamDocs(workspace, team);
    expect(readFileSync(board, 'utf8')).toBe('# 留言板 · 手写一行\n');
  });

  it('存量旧任务整块跳过：不建目录、不写文件', () => {
    const workspace = workspaceOf();
    const legacy = taskOf({ id: 3, subject: '登录服务', workDir: 'teams/甲队/tasks/t3-登录服务' });
    const first = renderTeamDocs(workspace, teamOf(legacy));
    expect(first).toEqual([]);
    expect(existsSync(join(workspace, 'teams'))).toBe(false);
  });
});

describe('主题改写（纪要改名不产生重复文件）', () => {
  it('改主题后只剩新名纪要，且正文不丢', () => {
    const workspace = workspaceOf();
    const group = taskOf({ id: 3, subject: '登录服务', workDir: 'teams/3-登录服务' });
    const team = teamOf(group);
    renderTeamDocs(workspace, team);
    const dir = join(workspace, 'teams', '3-登录服务');
    const oldName = minutesFileName(group);
    writeFileSync(join(dir, oldName), `${readFileSync(join(dir, oldName), 'utf8')}### 结论\nok\n`, 'utf8');

    // 收口回写主题：宿主先把目录改名（assignment.renameTaskFolder），物化再把
    // 纪要改成新名——旧名不留。
    const renamed = { ...group, subject: '登录服务（收口）', workDir: 'teams/3-登录服务-收口' };
    renameSync(dir, join(workspace, 'teams', '3-登录服务-收口'));
    renderTeamDocs(workspace, teamOf(renamed));
    const newDir = join(workspace, 'teams', '3-登录服务-收口');
    const names = readdirSync(newDir).filter((n) => n.endsWith(MINUTES_SUFFIX));
    expect(names).toEqual([minutesFileName(renamed)]);
    expect(readFileSync(join(newDir, minutesFileName(renamed)), 'utf8')).toContain('### 结论');
  });

  it('小任务改主题：同目录内旧名纪要改名，不新增第二份', () => {
    const workspace = workspaceOf();
    const group = taskOf({ id: 3, subject: '登录服务', workDir: 'teams/3-登录服务' });
    const sub = taskOf({ id: 4, parentId: 3, subject: '接口鉴权' });
    renderTeamDocs(workspace, teamOf(group, [sub]));
    const dir = join(workspace, 'teams', '3-登录服务');

    const renamedSub = { ...sub, subject: '接口鉴权与限流' };
    renderTeamDocs(workspace, teamOf(group, [renamedSub]));
    const names = readdirSync(dir).filter((n) => n.endsWith(MINUTES_SUFFIX));
    expect(names).toContain(minutesFileName(renamedSub));
    expect(names).not.toContain(minutesFileName(sub));
    expect(names).toHaveLength(2);
  });
});
