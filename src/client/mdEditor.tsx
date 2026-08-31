/**
 * 统一人设 Markdown 编辑器（docs/19.7.2）—— @mdxeditor/editor 所见即所得
 * 实现（替换原 textarea + 编辑/预览切换方案）。
 *
 * 参考文档（后续有关操作一律以官方文档为准）：
 * - 入门   https://mdxeditor.dev/
 * - 代码块 https://mdxeditor.dev/editor/docs/code-blocks
 * - 主题   https://mdxeditor.dev/editor/docs/theming
 *
 * 宿主约束与适配（scripts/wrapClient.mjs）：client 以单个 CJS envelope 被
 * ModuleLoader 加载，require 仅注入 react/react-dom/@deepseek-ai 系列，
 * 且没有独立 CSS 通道。因此：
 *
 * 1. 样式内联 —— `@mdxeditor/editor/style.css` 经 tsdown
 *    `moduleTypes: { '.css': 'text' }` 以字符串进包，首次挂载注入
 *    `<style data-dsh-eteams-mdx>`（幂等）。
 * 2. 主题双桥（见 theming 文档「Customizing the editor colors」）——
 *    a) 语义 token 桥：mdxeditor 的 --base* 与 --accent* 变量绑定宿主
 *       --dsw-* 别名（radix 色阶兜底）；宿主把主题 token 写在 body.style，
 *       亮暗切换自动跟随，无需 JS。
 *    b) 暗色类桥：宿主暗色标记是 body[data-ds-dark-theme]
 *       （dsh-client-ui-layout ThemePresenter），radix 色阶不认识它——
 *       MutationObserver 同步到编辑器根的 `dark-theme` 类（文档官方机制）。
 * 3. 代码块（见 code-blocks 文档）—— codeBlockPlugin + codeMirrorPlugin
 *    组合，`autoLoadLanguageSupport: false` + 静态预载 8 种人设文档高频
 *    语言，杜绝动态 import 产生的代码分块（会破坏单文件 envelope）。
 * 4. 受控模式 —— markdown prop 仅挂载时读取（入门文档明确），编辑经
 *    onChange 上抛；外部 value 与最近一次发出的值不同（面板换成员、构建
 *    刷新草稿）时用 MDXEditorMethods.setMarkdown 整体同步，避免打字回环。
 *
 * @module dsh-eteams/client/mdEditor
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  ChangeCodeMirrorLanguage,
  CodeToggle,
  ConditionalContents,
  CreateLink,
  InsertCodeBlock,
  InsertTable,
  InsertThematicBreak,
  linkDialogPlugin,
  linkPlugin,
  MDXEditor,
  type MDXEditorMethods,
  markdownShortcutPlugin,
  frontmatterPlugin,
  headingsPlugin,
  listsPlugin,
  ListsToggle,
  codeBlockPlugin,
  codeMirrorPlugin,
  quotePlugin,
  Separator,
  StrikeThroughSupSubToggles,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  UndoRedo,
} from '@mdxeditor/editor';
import { css as langCss } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import mdxEditorCss from '@mdxeditor/editor/style.css';
import { recordClientDiag } from './diagnostics';

const T = {
  sunken: 'var(--dsw-alias-bg-layer-2, #edf0f4)',
  surface: 'var(--dsw-alias-bg-layer-1, #fff)',
  border: 'var(--dsw-alias-border-l1, rgba(100,116,139,0.14))',
  border2: 'var(--dsw-alias-border-l2, rgba(100,116,139,0.26))',
  text2: 'var(--dsw-alias-label-secondary, #47546c)',
  text3: 'var(--dsw-alias-label-tertiary, #8a94a6)',
  accent: 'var(--dsw-alias-brand-primary, #4b7bec)',
  accentSoft: 'var(--dsw-alias-interactive-bg-active, rgba(75,123,236,0.12))',
} as const;

/**
 * 主题桥（mdxeditor 语义 token → 宿主 --dsw-* 别名）。挂在编辑器根
 * （className 组合 `mdxeditor eteams-mdx`），特异性 (0,2,0) 压过包内
 * `_editorRoot_*` (0,1,0) 的默认定义；radix 色阶作为缺级兜底。
 */
const THEME_BRIDGE_CSS = `
.mdxeditor.eteams-mdx {
  --basePageBg: transparent;
  --baseBase: var(--dsw-alias-bg-layer-1, var(--slate-1, #fdfdfe));
  --baseBgSubtle: var(--dsw-alias-bg-layer-2, var(--slate-2, #f6f6f9));
  --baseBg: var(--dsw-alias-bg-layer-2, var(--slate-3, #eef0f3));
  --baseBgHover: var(--dsw-alias-interactive-bg-hover, var(--slate-4, #e4e6eb));
  --baseBgActive: var(--dsw-alias-interactive-bg-active, var(--slate-5, #d9dce2));
  --baseLine: var(--dsw-alias-border-l1, var(--slate-6, #c8cdd4));
  --baseBorder: var(--dsw-alias-border-l2, var(--slate-7, #b9bfca));
  --baseBorderHover: var(--dsw-alias-border-l2, var(--slate-8, #a5adba));
  --baseSolid: var(--dsw-alias-brand-primary, var(--slate-9, #696f7c));
  --baseSolidHover: var(--dsw-alias-button-primary-hover, var(--slate-10, #5a606c));
  --baseText: var(--dsw-alias-label-secondary, var(--slate-11, #404855));
  --baseTextContrast: var(--dsw-alias-label-primary, var(--slate-12, #1c2430));
  --accentText: var(--dsw-alias-brand-primary, var(--blue-11, #0d74ce));
  --accentBg: var(--dsw-alias-interactive-bg-active, var(--blue-3, #e6f4fe));
  --accentBgHover: var(--dsw-alias-interactive-bg-hover, var(--blue-4, #d5efff));
  --accentBgActive: var(--dsw-alias-interactive-bg-hover, var(--blue-5, #c2e5ff));
  --accentLine: var(--dsw-alias-brand-primary, var(--blue-6, #acd8fc));
  --accentBorder: var(--dsw-alias-brand-primary, var(--blue-7, #8ec8f6));
  --accentSolid: var(--dsw-alias-brand-primary, var(--blue-9, #0090ff));
  --accentSolidHover: var(--dsw-alias-button-primary-hover, var(--blue-10, #0588f0));
  --error-color: var(--dsw-alias-state-error-primary, var(--red-10, #e5484d));
  --font-body: var(--dsw-font-markdown-base-font-family, inherit);
  --font-mono: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
}
/* 正文排版：绑定宿主 Markdown 排版 token，字号对齐面板密度 */
.mdxeditor .eteams-mdx-content {
  font-family: var(--dsw-font-markdown-base-font-family, inherit);
  font-size: 13px;
  line-height: var(--dsw-font-markdown-base-line-height, 1.7);
  padding: 12px 14px;
}
`;

let stylesInjected = false;

/** 首次调用时把 mdxeditor 样式 + 主题桥注入 <head>（幂等）。 */
function ensureMdxStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  try {
    const style = document.createElement('style');
    style.setAttribute('data-source', 'dsh-eteams-mdxeditor');
    style.textContent = mdxEditorCss + THEME_BRIDGE_CSS;
    document.head.appendChild(style);
  } catch (error) {
    recordClientDiag('mdx-editor', error instanceof Error ? error.message : String(error));
  }
}

/** 宿主暗色（body[data-ds-dark-theme]）→ 编辑器根 `dark-theme` 类。 */
function useHostDark(): boolean {
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.body.hasAttribute('data-ds-dark-theme'),
  );
  useEffect(() => {
    const sync = (): void => setDark(document.body.hasAttribute('data-ds-dark-theme'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/**
 * 代码块语言表（code-blocks 文档「Pre-loaded language support」格式）：
 * 静态预载 + 关闭动态加载，保证单文件 bundle；未列出的语言退化为纯文本
 * 编辑（语言选择器显示临时项，可随时切换到已配置语言）。
 */
const CODE_BLOCK_LANGUAGES = [
  { name: 'TypeScript', alias: ['ts', 'tsx', 'typescript'], support: javascript({ typescript: true, jsx: true }) },
  { name: 'JavaScript', alias: ['js', 'jsx', 'javascript'], support: javascript({ jsx: true }) },
  { name: 'Python', alias: ['py', 'python'], support: python() },
  { name: 'YAML', alias: ['yaml', 'yml'], support: yaml() },
  { name: 'JSON', alias: ['json'], support: json() },
  { name: 'Markdown', alias: ['markdown', 'md'], support: markdown() },
  { name: 'CSS', alias: ['css'], support: langCss() },
  { name: 'HTML', alias: ['html'], support: html() },
];

/**
 * 人设 Markdown 编辑器（所见即所得）。frontmatter + 正文一站编辑：
 * 标题/列表/引用/表格/链接/代码块（CodeMirror 高亮）/分隔线，工具栏随
 * 焦点出现；不再需要编辑 ↔ 预览切换（入门文档："No more need for
 * edit ↔ preview"）。预览语义由 MarkdownText 保留给只读场景。
 */
export function MdEditor({
  value,
  onChange,
  minHeight = 320,
}: {
  value: string;
  onChange: (next: string) => void;
  minHeight?: number;
}): ReactNode {
  ensureMdxStyles();

  const methodsRef = useRef<MDXEditorMethods | null>(null);
  const lastEmittedRef = useRef<string | null>(null);
  const dark = useHostDark();

  // 受控同步：仅当外部 value ≠ 最近一次发出的值（面板换成员/构建刷新）
  // 时整体重置；用户打字产生的回环（value === lastEmitted）不动编辑器。
  useEffect(() => {
    if (lastEmittedRef.current !== null && value !== lastEmittedRef.current) {
      lastEmittedRef.current = value;
      methodsRef.current?.setMarkdown(value);
    }
  }, [value]);

  const plugins = useMemo(
    () => [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      thematicBreakPlugin(),
      markdownShortcutPlugin(),
      frontmatterPlugin(),
      codeBlockPlugin({ defaultCodeBlockLanguage: 'ts' }),
      codeMirrorPlugin({
        codeBlockLanguages: CODE_BLOCK_LANGUAGES,
        autoLoadLanguageSupport: false,
      }),
      linkPlugin(),
      linkDialogPlugin(),
      tablePlugin(),
      toolbarPlugin({
        toolbarContents: () => (
          <>
            <UndoRedo />
            <Separator />
            <BlockTypeSelect />
            <Separator />
            <BoldItalicUnderlineToggles />
            <CodeToggle />
            <StrikeThroughSupSubToggles />
            <Separator />
            <ListsToggle />
            <Separator />
            <CreateLink />
            <Separator />
            {/* code-blocks 文档：聚焦代码块时换语言选择器，否则给插入按钮 */}
            <ConditionalContents
              options={[
                {
                  when: (editor) => editor?.editorType === 'codeblock',
                  contents: () => <ChangeCodeMirrorLanguage />,
                },
                { fallback: () => <InsertCodeBlock /> },
              ]}
            />
            <InsertTable />
            <InsertThematicBreak />
          </>
        ),
      }),
    ],
    [],
  );

  return (
    <div
      style={{
        border: `1px solid ${T.border2}`,
        borderRadius: 10,
        background: T.surface,
        overflow: 'hidden',
      }}
    >
      {/* 编辑器头部：Markdown 标识 + 说明（WYSIWYG 后编辑/预览切换退役） */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderBottom: `1px solid ${T.border}`,
          background: T.sunken,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: T.text3, letterSpacing: 0.4 }}>
          Markdown
        </span>
        <span style={{ fontSize: 10.5, color: T.text3 }}>frontmatter + 正文 · 所见即所得</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: T.text3 }}>格式工具栏随焦点出现</span>
      </div>
      <div style={{ minHeight }}>
        <MDXEditor
          ref={methodsRef}
          markdown={value}
          onChange={(md) => {
            lastEmittedRef.current = md;
            onChange(md);
          }}
          onError={({ error }) => recordClientDiag('mdx-editor', `markdown 处理失败: ${error}`)}
          plugins={plugins}
          className={`eteams-mdx${dark ? ' dark-theme' : ''}`}
          contentEditableClassName="eteams-mdx-content"
          placeholder={'开始撰写角色手册：frontmatter + 身份 / 使命 / 规则 / 领域专章…'}
          spellCheck={false}
        />
      </div>
    </div>
  );
}
