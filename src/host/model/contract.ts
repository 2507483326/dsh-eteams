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

/**
 * 合同是否含非空「验收标准」段（收口闸判据，docs/taskOrchestrationRefinement）：
 * 精确匹配二级标题行 `## 验收标准`——行首 `##` 后须跟空白，标题文字 trim 后
 * 精确等于「验收标准」；`###`/加粗/变体一律不认。段内容 = 该标题行到下一个
 * `# ` / `## ` 标题（或文末）之间的文本，去空白后非空才算有效（`### 子标题`
 * 及正文仍算段内）。
 */
export function hasAcceptanceCriteria(md: string | undefined): boolean {
  if (md === undefined) return false;
  let inSection = false;
  for (const line of md.split(/\r?\n/)) {
    const heading = /^(#{1,2})\s+(.*)$/.exec(line);
    if (heading !== null) {
      // 遇到下一个同级或更高级标题：段已结束——此前若无内容即为空段。
      if (inSection) return false;
      if (heading[1] === '##' && heading[2]!.trim() === '验收标准') inSection = true;
      continue;
    }
    if (inSection && line.trim() !== '') return true;
  }
  return false;
}