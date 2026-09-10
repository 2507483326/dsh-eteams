/**
 * 构建工作台的草稿数据层（docs/19.6.2 角色构建师）：构建步骤时间线、
 * 可编辑草稿表单态（DraftEdit/EMPTY_EDIT/fromBuildDraft）、预填命令芯片
 * 与手册骨架合成（handbookSeed/HandbookSource）。构建中草稿只读预览卡已撤
 * （用户迭代 2026-09-10——过程看步骤时间线，细节等确认表单直接改）。
 * 符号自 eteamsView.tsx 原样搬出（docs/32 32.5.1 纯移动、零行为变更），
 * 供 roster/rosterAddPage、roster/buildWorkbench、roster/rosterDetailPage
 * 与 team/memberDetailPage 消费（R1 类型边：HandbookSource/DraftEdit 一律
 * import type）。
 *
 * @module dsh-eteams/client/pages/roster/buildDraft
 */
import type { ReactNode } from 'react';
import type { BuildDraft } from '../../lib/api';
import { BORDER_L1_CLASS } from '../shared/styles';

/** 原 styles.cmdChip（预填命令芯片：等宽字体 + --border 边框 + --muted 底；
 * D22d mono 芯片 13px 档）。 */
const CMD_CHIP_CLASS = `mt-2 break-all rounded-md border border-solid bg-muted px-3 py-2.5 text-[13px] leading-[1.7] font-mono text-muted-foreground ${BORDER_L1_CLASS}`;

/** 构建步骤时间线（docs/19.6.2）——与角色构建师的 eteams_build_report 播报约定一致。 */
export const BUILD_STEPS = [
  '收到需求',
  '查重角色库',
  '意图访谈',
  '起草统一手册',
  '深化领域章节',
  '完成草稿',
] as const;

/** Editable draft form state (待确认态). */
export interface DraftEdit {
  name: string;
  role: string;
  profile: string;
  duty: string;
  style: string;
  skills: string;
  executionPrompt: string;
  personaMd: string;
  rulesText: string;
}

export const EMPTY_EDIT: DraftEdit = {
  name: '',
  role: '',
  profile: '',
  duty: '',
  style: '',
  skills: '',
  executionPrompt: '',
  personaMd: '',
  rulesText: '',
};

/**
 * 手册 frontmatter 的 description 一段话——构建师按 agency 规格自写的简介，
 * 确认表单在构建师漏报 profile 时拿它预填（docs/19.20，结构化提取而非合成）。
 * 规格：仅取文档开头围栏块（\r?\n CRLF 兼容，同 mdEditor 口径）内行首
 * description: 后的单行纯量，两侧成对引号剥除；块标量指示符（>/| 开头）
 * 视为缺失返回空串。
 */
const FRONTMATTER_FENCE_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const DESCRIPTION_LINE_RE = /^description:[ \t]+(.*)$/;

export function profileFromManual(personaMd: string | undefined): string {
  const fence = FRONTMATTER_FENCE_RE.exec(personaMd ?? '');
  if (fence === null) return '';
  for (const line of (fence[1] ?? '').split(/\r?\n/)) {
    const m = DESCRIPTION_LINE_RE.exec(line);
    if (m === null) continue;
    const raw = (m[1] ?? '').trim();
    if (/^[>|]/.test(raw)) return '';
    const quoted = raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));
    return (quoted ? raw.slice(1, -1) : raw).trim();
  }
  return '';
}

export function fromBuildDraft(d: BuildDraft): DraftEdit {
  return {
    // 草稿浅合并累积（docs/19.6.2），构建中 name/role 允许尚未上报——归一
    // 成空串，防 undefined 溢进表单态（受控 input 与下游 trim 链会崩）。
    name: d.name ?? '',
    role: d.role ?? '',
    // 简介预填（docs/19.20）：构建师漏报（null/undefined）时退回手册
    // frontmatter 的 description；空串= 显式留空，不预填。
    profile: d.profile ?? profileFromManual(d.personaMd),
    duty: d.duty ?? '',
    style: d.style ?? '',
    skills: d.skills ?? '',
    executionPrompt: d.executionPrompt ?? '',
    personaMd: d.personaMd ?? '',
    rulesText: (d.rules ?? []).join('\n'),
  };
}

/** 预填命令芯片：占位符以品牌色高亮，一眼看出要改哪里。 */
export function CommandChip({ text }: { text: string }): ReactNode {
  const parts = text.split(/(【成员名称】|【职责】)/g);
  return (
    <div className={CMD_CHIP_CLASS}>
      {parts.map((p, i) =>
        p === '【成员名称】' || p === '【职责】' ? (
          <span key={i} className="font-semibold text-primary">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </div>
  );
}

/** 预填引导三步（空闲态展示）。 */
export const PREFILL_STEPS = [
  '在对话输入框补全两个【】占位符——可顺手追加能力、风格等期望',
  '回车发送，角色构建师立刻接手（预填行直接回车同样生效）',
  '回到这里实时看构建；草稿就绪后可修改，点「确认入库」完成',
] as const;

/** 角色（用户反馈：成员更名角色，不再需要标签）：角色库全体条目（先有角色，再组建团队）——列表 / 构建工作台 / 详情。 */
/**
 * 手册骨架的结构来源（用户迭代 2026-09 四）：角色库条目与成员视图共用的
 * 最小字段面——成员视图缺手册（旧成员）时按结构字段合成骨架。
 */
export interface HandbookSource {
  name: string;
  role: string;
  personaMd?: string | null;
  duty?: string | null;
  style?: string | null;
  skills?: string | null;
  rules?: string[] | null;
  executionPrompt?: string | null;
}

/**
 * Synthesize a handbook skeleton from the legacy structured fields so nothing
 * is lost when the user first edits a member that predates personaMd (the
 * digest fields themselves are no longer shown — everything lives in the
 * handbook now, 用户反馈 2026-09).
 */
export function handbookSeed(member: HandbookSource): string {
  if (typeof member.personaMd === 'string' && member.personaMd.trim() !== '') {
    return member.personaMd;
  }
  const lines = [`# ${member.name}`, '', `- **角色**：${member.role}`];
  const fields: [string, string | null | undefined][] = [
    ['职责边界', member.duty],
    ['工作风格', member.style],
    ['能力', member.skills],
    ['执行提示', member.executionPrompt],
  ];
  for (const [label, value] of fields) {
    if (typeof value === 'string' && value.trim() !== '')
      lines.push(`- **${label}**：${value.trim()}`);
  }
  if (Array.isArray(member.rules) && member.rules.length > 0) {
    lines.push(
      '',
      '## 工作纪律',
      ...member.rules.filter((r) => r.trim() !== '').map((r) => `- ${r}`),
    );
  }
  lines.push('', '## 交付标准', '- （待补充）');
  return lines.join('\n');
}
