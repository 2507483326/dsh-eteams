/**
 * persona_md 的 frontmatter 剥除（用户迭代 2026-09-15）：frontmatter
 * （name/description/emoji/color）不进 persona_md——写库边沿由 personaToMd
 * 剥、上报边沿由 roleBuilder sanitizeReportDraft 剥；读路径按普通 Markdown
 * 原样读出，两端都不再判断「这段是不是 frontmatter」。只识别文档首块的成对
 * `---` 围栏（中段/未闭合一律原样返回）。
 *
 * @module dsh-eteams/tests/personaFrontmatter
 */
import { describe, expect, it } from 'vitest';
import type { PersonaRecord } from '../src/host/model/types';
import { personaFromMd, personaToMd, stripFrontmatter } from '../src/host/state/db';

const FRONT = '---\nname: 测试大师\ndescription: 一段话简介\nemoji: 🧪\ncolor: green\n---\n';

describe('stripFrontmatter（仅剥文档首块围栏）', () => {
  it('剥首块 frontmatter，正文原样保留', () => {
    expect(stripFrontmatter(`${FRONT}\n## 身份与记忆\n正文`)).toBe('\n## 身份与记忆\n正文');
  });

  it('CRLF 兼容', () => {
    expect(stripFrontmatter('---\r\nname: x\r\n---\r\n正文')).toBe('正文');
  });

  it('无围栏 / 未闭合 / 中段围栏一律原样返回', () => {
    expect(stripFrontmatter('# 手册\n正文')).toBe('# 手册\n正文');
    expect(stripFrontmatter('---\nname: x\n正文')).toBe('---\nname: x\n正文');
    expect(stripFrontmatter('# 角色手册\n\n---\nname: x\n---\n正文')).toBe(
      '# 角色手册\n\n---\nname: x\n---\n正文',
    );
  });
});

describe('personaToMd 不落 frontmatter', () => {
  const persona = (personaMd?: string): PersonaRecord => ({
    frameworkVersion: 1,
    role: 'reviewer',
    duty: '',
    style: '',
    skills: '',
    rules: [],
    executionPrompt: '你是「测试大师」，以 reviewer 的身份为团队交付。',
    ...(personaMd !== undefined ? { personaMd } : {}),
  });

  it('烘出的 persona_md = 结构摘要 + 剥过 frontmatter 的正文', () => {
    const md = personaToMd(persona(`${FRONT}\n## 身份与记忆\n正文`), '测试大师');
    expect(md).toContain('# 人设 · 测试大师');
    expect(md).toContain('# 角色手册\n\n## 身份与记忆\n正文');
    expect(md).not.toContain('emoji:');
    expect(md).not.toContain('name: 测试大师');
  });

  it('解析回读同样不含 frontmatter（读路径不再判断）', () => {
    const md = personaToMd(persona(`${FRONT}\n## 身份与记忆\n正文`), '测试大师');
    expect(personaFromMd(md, '测试大师', 'reviewer').personaMd ?? '').not.toContain('emoji:');
  });

  it('手册只有 frontmatter → 退化为纯结构摘要，不留空手册段', () => {
    const md = personaToMd(persona(FRONT), '测试大师');
    expect(md).toContain('# 人设 · 测试大师');
    expect(md).not.toContain('# 角色手册');
  });
});
