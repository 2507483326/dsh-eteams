/**
 * 统一人设 Markdown 编辑器（docs/19.7.2，用户迭代 ⑤-3）：工具栏插入常用
 * Markdown 语法 + 等宽编辑区 + 编辑/预览切换（MarkdownText 渲染）。轻量
 * 实现，不引入第三方编辑器依赖；预览与 DSH 渲染保持同一组件。
 *
 * @module dsh-eteams/client/mdEditor
 */
import { type ReactNode, useRef, useState } from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';

const T = {
  sunken: 'var(--dsw-alias-bg-layer-2, #edf0f4)',
  border: 'var(--dsw-alias-border-l1, rgba(100,116,139,0.14))',
  border2: 'var(--dsw-alias-border-l2, rgba(100,116,139,0.26))',
  text2: 'var(--dsw-alias-label-secondary, #47546c)',
  accent: 'var(--dsw-alias-brand-primary, #4b7bec)',
  accentSoft: 'var(--dsw-alias-interactive-bg-active, rgba(75,123,236,0.12))',
} as const;

/** One toolbar action: the text to wrap around the selection (before, after). */
const TOOLS: [string, string, string][] = [
  ['H2', '## ', ''],
  ['B', '**', '**'],
  ['`', '`', '`'],
  ['• 列表', '- ', ''],
  ['1. 列表', '1. ', ''],
  ['引用', '> ', ''],
  ['代码块', '```bash\n', '\n```'],
  ['表格', '| 列 A | 列 B |\n|---|---|\n|  |  |\n', ''],
];

export function MdEditor({
  value,
  onChange,
  minHeight = 260,
}: {
  value: string;
  onChange: (next: string) => void;
  minHeight?: number;
}): ReactNode {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');

  const wrap = (before: string, after: string): void => {
    const el = ref.current;
    if (el === null) {
      onChange(value + before + after);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}${before}${value.slice(start, end) || '文本'}${after}${value.slice(end)}`;
    onChange(next);
    // 恢复焦点并让光标落回插入区域附近（异步等 React 受控更新落地）。
    window.setTimeout(() => {
      el.focus();
      const caret = start + before.length + (value.slice(start, end) === '' ? 2 : end - start);
      el.setSelectionRange(caret, caret);
    }, 0);
  };

  const toolStyle: React.CSSProperties = {
    padding: '2px 8px',
    fontSize: 11.5,
    borderRadius: 6,
    border: `1px solid ${T.border}`,
    background: 'transparent',
    color: T.text2,
    cursor: 'pointer',
  };

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          flexWrap: 'wrap',
          marginBottom: 6,
        }}
      >
        {TOOLS.map(([label, before, after]) => (
          <button key={label} type="button" style={toolStyle} onClick={() => wrap(before, after)}>
            {label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={{
            ...toolStyle,
            ...(mode === 'preview' ? { background: T.accentSoft, color: T.accent } : {}),
          }}
          onClick={() => setMode(mode === 'edit' ? 'preview' : 'edit')}
        >
          {mode === 'edit' ? '预览' : '编辑'}
        </button>
      </div>
      {mode === 'edit' ? (
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            minHeight,
            padding: '8px 10px',
            borderRadius: 8,
            border: `1px solid ${T.border2}`,
            background: T.sunken,
            color: 'inherit',
            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
            fontSize: 12,
            lineHeight: 1.6,
            resize: 'vertical',
          }}
        />
      ) : (
        <div
          style={{
            minHeight,
            maxHeight: 460,
            overflow: 'auto',
            padding: '8px 10px',
            borderRadius: 8,
            border: `1px solid ${T.border2}`,
            background: T.sunken,
            fontSize: 12.5,
          }}
        >
          {value.trim() === '' ? (
            <span style={{ color: T.text2 }}>（暂无内容）</span>
          ) : (
            <MarkdownText text={value} />
          )}
        </div>
      )}
    </div>
  );
}
