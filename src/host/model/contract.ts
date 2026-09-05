/**
 * 任务合同（十六轮 DA29，2026-09-05）：合同四数组（验收标准/范围内/范围外/
 * 交付物）合并为一篇 Markdown 全文（task.contract_md），面板 MD 渲染、工具
 * 与文档透传原文。本模块只承 legacy 数组 → MD 的合成（旧库迁移回填与旧
 * team.json 导入共用），新写入一律直接落 contract_md。
 *
 * @module dsh-eteams/model/contract
 */

/** 旧合同四数组的形状（store 迁移回填 / import.ts 旧 team.json 共用）。 */
export interface LegacyContractArrays {
  acceptance?: string[];
  inScope?: string[];
  outOfScope?: string[];
  deliverables?: string[];
}

/**
 * 由旧四数组合成一篇合同 MD（空缺段整段不渲染；四段全空 = undefined）。
 * 段落结构与 mails.renderContract 的旧平文版一致（验收标准编号列表 / 允许
 * 改动 / 禁止改动 / 交付物清单），合成结果即新字段的标准写法。
 */
export function contractMdFromLegacyArrays(
  arrays: LegacyContractArrays,
): string | undefined {
  const sections: string[] = [];
  if (arrays.acceptance !== undefined && arrays.acceptance.length > 0) {
    sections.push(
      '## 验收标准',
      '',
      ...arrays.acceptance.map((a, i) => `${i + 1}. ${a}`),
    );
  }
  if (arrays.inScope !== undefined && arrays.inScope.length > 0) {
    sections.push('## 允许改动', '', ...arrays.inScope.map((s) => `- ${s}`));
  }
  if (arrays.outOfScope !== undefined && arrays.outOfScope.length > 0) {
    sections.push('## 禁止改动', '', ...arrays.outOfScope.map((s) => `- ${s}`));
  }
  if (arrays.deliverables !== undefined && arrays.deliverables.length > 0) {
    sections.push('## 交付物', '', ...arrays.deliverables.map((s) => `- ${s}`));
  }
  if (sections.length === 0) return undefined;
  return sections.join('\n');
}