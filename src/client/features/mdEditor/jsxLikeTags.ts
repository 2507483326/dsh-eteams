/**
 * 裸尖括号构造中和（用户反馈 2026-09-07「角色构建师 点编辑后 md 编辑器是
 * 空的」）：mdxeditor 的 markdown 导入走严格 MDX 解析（core 常驻
 * micromark-extension-mdx-jsx），正文里裸的 `<X>` / `<Y>` / `</X>` 会被当作
 * JSX 元素——未闭合（自闭合须写 `<X />`）直接抛 MarkdownParseError，编辑器
 * 整体导入失败渲染空白；即使解析通过，未注册 jsxPlugin 时非 u/code 的 JSX
 * 节点也没有导入 visitor（同为空白）。autolink（`<https://…>`、`<a@b>`）在
 * MDX 语法下同样是非法 JSX 名，一样致命。角色构建师的预置手册「访谈开场」
 * 行正含 `<X>`/`<Y>` 占位符，其它角色手册无。
 *
 * 策略：手册/任务正文是纯 Markdown 写作面，正文里的裸 `<…>` 尖括号构造
 * 一概视作字面文本——导入前把 `<` 转义为 `\<`（micromark characterEscape，
 * mdxMd 已启用），解析为普通文本节点、所见即所得显示原文；用户再编辑导出
 * 时 mdast-util-to-markdown 输出同款转义（幂等，已转义的 `\<` 不二次处理）。
 * 对普通文本这是可见结果不变的重写（`<` 本就按字面渲染），只改解析语义。
 * 转义只发生在编辑器入口（挂载 prop / 受控同步 / 粘贴），onChange 上抛与
 * 落库的内容由编辑器导出管线决定，原手册不经手不重写。
 *
 * 范围：行内裸 `<…>`（`<` 后首字符非空白、内部不含换行/尖括号，允许 CJK 与
 * 空格）——占位符标签、带属性标签、autolink 在 MDX 语法下全部致命，一并列
 * 入；`<` 后跟空格的散文比较（`a < b`）不构成合法 JSX/autolink 起点，不命中。
 * 代码围栏与行内 code span 内不转义（characterEscape 在 code span 内不生效，
 * 转义会露出反斜杠）。行内 HTML 格式化（`<u>x</u>` 等）由此一并字面化——
 * 本编辑器不支持行内 HTML，格式走 Markdown 语法。
 *
 * @module dsh-eteams/client/features/mdEditor/jsxLikeTags
 */

/**
 * 行级清洗正则（交替式，行内 code span 分支在前）：`` `…` `` 成对反引号原样
 * 保留；其余裸 `<…>` 构造（`<` 后首字符非空白、内部无尖括号/换行）命中转义
 * 分支。负向后行 `(?<!\\)` 排除已转义的 `\<`（幂等）。
 */
const LINE_SANITIZE_RE = /`[^`]*`|(?<!\\)<[^\s<>][^<>]*>/g;

/** 围栏行（``` 或 ~~~，允许 ≤3 空格缩进）；成对出现，行级翻转围栏态。 */
const FENCE_RE = /^\s{0,3}(?:```|~~~)/;

/**
 * 把 markdown 源文中裸的尖括号构造转义为字面文本（`<X>` → `\<X>`）：
 * 逐行扫描（围栏态行级翻转，围栏内整行跳过），行内 code span 原样保留，
 * 其余裸 `<…>` 加反斜杠转义。幂等——已转义的 `\<X>` 与普通文本原样通过。
 */
export function neutralizeJsxLikeTags(md: string): string {
  const lines = md.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    lines[i] = line.replace(
      LINE_SANITIZE_RE,
      (m) => (m.startsWith('`') ? m : `\\${m}`),
    );
  }
  return lines.join('\n');
}
