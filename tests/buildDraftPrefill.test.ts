/**
 * fromBuildDraft 简介预填单测（docs/19.20）：构建师漏报 profile（null/
 * undefined）时退回手册 frontmatter 的 description——构建师自写的一段话，
 * 结构化提取而非启发式合成；空串= 显式留空不预填；提取规格（CRLF/引号/
 * 块标量指示符）按设计钉死。镜像 host §19.19 双字段硬闸口径（构建师上报
 * 边沿 profile 必非空）——面板预填只兜旧草稿与边沿外形态。
 *
 * @module dsh-eteams/tests/buildDraftPrefill
 */
import { describe, expect, it } from 'vitest';
import { fromBuildDraft, profileFromManual } from '../src/client/pages/roster/buildDraft';

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

describe('profileFromManual frontmatter description 提取（docs/19.20）', () => {
  it('取围栏块内行首 description: 单行纯量，trim', () => {
    expect(
      profileFromManual('---\nname: x\ndescription: 负责后端接口与调优\nemoji: 🗄️\ncolor: blue\n---\n\n正文'),
    ).toBe('负责后端接口与调优');
  });

  it('CRLF 兼容（\r\n 文档同样命中）', () => {
    expect(
      profileFromManual('---\r\nname: x\r\ndescription: 管道一句话简介\r\ncolor: blue\r\n---\r\n正文'),
    ).toBe('管道一句话简介');
  });

  it('两侧成对引号剥除（单/双引号）', () => {
    expect(profileFromManual('---\ndescription: "带引号简介"\n---\n正文')).toBe('带引号简介');
    expect(profileFromManual('---\ndescription: \'单引号简介\'\n---\n正文')).toBe('单引号简介');
  });

  it('围栏缺失 / 字段缺失 / 块标量指示符 → 空串', () => {
    expect(profileFromManual(undefined)).toBe('');
    expect(profileFromManual('no fence at all')).toBe('');
    expect(profileFromManual('---\nname: x\n---\n正文')).toBe('');
    expect(profileFromManual('---\ndescription: >-\n  折行简介\n---\n正文')).toBe('');
    expect(profileFromManual('---\ndescription: |  \n  块标量\n---\n正文')).toBe('');
  });

  it('description 行后无空格不是合法纯量（缺字段处理），正文里的同名行不命中', () => {
    expect(profileFromManual('---\ndescription:无空格\n---\n正文')).toBe('');
    expect(
      profileFromManual('---\nname: x\n---\n\n## description: 正文里的同名行不算\n'),
    ).toBe('');
  });
});

describe('fromBuildDraft 简介预填（docs/19.20）', () => {
  const MANUAL = '---\nname: x\ndescription: 一段话简介\n---\n\n正文';

  it('profile 漏报（null）→ 预填 frontmatter description', () => {
    expect(fromBuildDraft(draftOf({ profile: null, personaMd: MANUAL })).profile).toBe('一段话简介');
  });

  it('profile 未带（undefined）→ 同样预填', () => {
    expect(fromBuildDraft(draftOf({ personaMd: MANUAL })).profile).toBe('一段话简介');
  });

  it('profile 显式空串 → 显式留空语义，不预填', () => {
    expect(fromBuildDraft(draftOf({ profile: '', personaMd: MANUAL })).profile).toBe('');
  });

  it('profile 有值 → 显示上报值，frontmatter 不参与', () => {
    expect(
      fromBuildDraft(draftOf({ profile: '上报的简介', personaMd: MANUAL })).profile,
    ).toBe('上报的简介');
  });

  it('漏报且手册无 description → 输入框留空', () => {
    expect(fromBuildDraft(draftOf({ profile: null, personaMd: '---\nname: x\n---\n正文' })).profile).toBe('');
    expect(fromBuildDraft(draftOf({ profile: null, personaMd: undefined })).profile).toBe('');
  });
});