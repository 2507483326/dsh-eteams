/**
 * 草稿归一单测：构建中草稿 name/role/profile 允许尚未上报——一律归空串
 * （受控 input 与下游 trim 链对 undefined 会崩）。简介（profile）只取构建师
 * 上报值：persona_md 不再带 frontmatter（写库边沿 personaToMd、上报边沿
 * roleBuilder sanitizeReportDraft 都已剥除），也不再从手册里猜 description
 * ——那种解析口径随手册形态漂移、误差大（用户迭代 2026-09-15）。
 *
 * @module dsh-eteams/tests/buildDraft
 */
import { describe, expect, it } from 'vitest';
import type { BuildDraft } from '../src/client/lib/api';
import { fromBuildDraft } from '../src/client/pages/roster/buildDraft';

/** 最小 BuildDraft（fromBuildDraft 只消费这几列，其余缺省）。 */
const draftOf = (overrides: { profile?: string | null; personaMd?: string }): {
  name: string;
  role: string;
  personaMd?: string;
  profile?: string | null;
} => ({
  name: 'data-eng',
  role: '数据工程师',
  ...overrides,
});

describe('fromBuildDraft 简介（profile）', () => {
  it('构建师上报值 → 原样带出', () => {
    expect(fromBuildDraft(draftOf({ profile: '上报的简介', personaMd: '# 手册' })).profile).toBe(
      '上报的简介',
    );
  });

  it('漏报（null/undefined）→ 空串，不从手册 frontmatter 推断', () => {
    const withFrontmatter = draftOf({
      profile: null,
      personaMd: '---\ndescription: 一段话简介\n---\n正文',
    });
    expect(fromBuildDraft(withFrontmatter).profile).toBe('');
    expect(fromBuildDraft(draftOf({ profile: undefined, personaMd: '# 手册' })).profile).toBe('');
  });
});

describe('fromBuildDraft 缺字段归一（2026-09-10 面板 trim 崩溃）', () => {
  it('构建中草稿 name/role 尚未上报（undefined）→ 归一空串，不溢 undefined 进表单态', () => {
    // 浅合并累积（docs/19.6.2）：构建师可以只先报手册/职责，name/role 缺省
    // 合法——表单态拿到 undefined 会在 trim / 受控 input 处崩掉整块面板。
    const edit = fromBuildDraft({} as BuildDraft);
    expect(edit.name).toBe('');
    expect(edit.role).toBe('');
    expect(edit.profile).toBe('');
  });
});
