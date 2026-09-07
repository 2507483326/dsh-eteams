/**
 * 裸尖括号构造中和单测（用户反馈 2026-09-07「角色构建师 点编辑后 md 编辑器
 * 是空的」）：mdxeditor 的 markdown 导入走严格 MDX 解析，正文裸 `<X>`/`</X>`
 * 抛 MarkdownParseError 使编辑器整体空白——neutralizeJsxLikeTags 在入口把裸
 * `<…>` 构造转义为字面文本（`\<X>`）。覆盖：占位符标签（含 CJK/闭合/自闭合/
 * 带属性）转义、autolink 同样字面化（MDX 下同为非法 JSX 名）、已转义幂等、
 * 代码围栏与行内 code span 保留、无闭合尖括号的比较运算不误伤、角色构建师
 * 预置手册的触发行逐字回归。
 */
import { describe, expect, it } from 'vitest';
import { neutralizeJsxLikeTags } from '../src/client/features/mdEditor/jsxLikeTags';

describe('neutralizeJsxLikeTags（裸尖括号构造转义）', () => {
  it('占位符标签转义为字面文本（开/闭/自闭合/带空格变体）', () => {
    expect(neutralizeJsxLikeTags('负责 <X> 的成员')).toBe('负责 \\<X> 的成员');
    expect(neutralizeJsxLikeTags('名字 <Y>，对吗？')).toBe('名字 \\<Y>，对吗？');
    expect(neutralizeJsxLikeTags('尾部 </X> 孤立闭合')).toBe('尾部 \\</X> 孤立闭合');
    expect(neutralizeJsxLikeTags('自闭合 <X /> 形式')).toBe('自闭合 \\<X /> 形式');
    expect(neutralizeJsxLikeTags('紧贴 <br/> 换行占位')).toBe('紧贴 \\<br/> 换行占位');
    expect(neutralizeJsxLikeTags('尾部空格 <X > 形式')).toBe('尾部空格 \\<X > 形式');
  });

  it('非 ASCII 标签名同样命中（MDX 允许 unicode 标签名，同样致命）', () => {
    expect(neutralizeJsxLikeTags('向 <成员> 汇报')).toBe('向 \\<成员> 汇报');
  });

  it('autolink/邮箱字面化（MDX 严格解析下同为致命非法名），带属性标签一并覆盖', () => {
    expect(neutralizeJsxLikeTags('文档见 <https://example.com/a>')).toBe('文档见 \\<https://example.com/a>');
    expect(neutralizeJsxLikeTags('邮箱 <a@b.example>')).toBe('邮箱 \\<a@b.example>');
    expect(neutralizeJsxLikeTags('带属性 <X class="a"> 一并字面化')).toBe('带属性 \\<X class="a"> 一并字面化');
  });

  it('一行多个构造全部转义（含相邻无间隔）', () => {
    expect(neutralizeJsxLikeTags('<X><Y>')).toBe('\\<X>\\<Y>');
    expect(neutralizeJsxLikeTags('从 <A> 到 <B> 再回 <A>')).toBe('从 \\<A> 到 \\<B> 再回 \\<A>');
  });

  it('幂等：已转义的 \\<X> 与重复处理不叠加反斜杠', () => {
    const once = neutralizeJsxLikeTags('负责 <X> 的成员');
    expect(once).toBe('负责 \\<X> 的成员');
    expect(neutralizeJsxLikeTags(once)).toBe(once);
    expect(neutralizeJsxLikeTags('已转义 \\<X> 原样')).toBe('已转义 \\<X> 原样');
  });

  it('代码围栏内不转义（含语言标注行与成对围栏），围栏外照常', () => {
    const md = ['正文 <X> 先转义', '', '```tsx', 'const el = <X />; // 围栏内不动', '```', '', '尾行 <Y> 转义'].join('\n');
    expect(neutralizeJsxLikeTags(md)).toBe(
      ['正文 \\<X> 先转义', '', '```tsx', 'const el = <X />; // 围栏内不动', '```', '', '尾行 \\<Y> 转义'].join('\n'),
    );
  });

  it('行内 code span 内不转义（characterEscape 在 span 内不生效），span 外照常', () => {
    expect(neutralizeJsxLikeTags('模板 `<X>` 占位与裸 <X> 并存')).toBe('模板 `<X>` 占位与裸 \\<X> 并存');
  });

  it('不误伤：无闭合尖括号的比较运算保持原样', () => {
    expect(neutralizeJsxLikeTags('比较 a < b 与 c > d')).toBe('比较 a < b 与 c > d');
    expect(neutralizeJsxLikeTags('表达式 a <b 时不抛')).toBe('表达式 a <b 时不抛');
  });

  it('回归：角色构建师预置手册「访谈开场」行逐字转义', () => {
    const line =
      '- **访谈开场**：直接确认理解——"你要的是一个负责 <X> 的成员，名字 <Y>，对吗？"';
    expect(neutralizeJsxLikeTags(line)).toBe(
      '- **访谈开场**：直接确认理解——"你要的是一个负责 \\<X> 的成员，名字 \\<Y>，对吗？"',
    );
  });

  it('空串与无标签文本原样通过', () => {
    expect(neutralizeJsxLikeTags('')).toBe('');
    expect(neutralizeJsxLikeTags('# 标题\n\n普通段落')).toBe('# 标题\n\n普通段落');
  });
});
