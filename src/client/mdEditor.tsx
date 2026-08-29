/**
 * 统一人设 Markdown 编辑器（docs/19.7.2，用户迭代 ⑤-3/后续反馈）：编辑器
 * 质感的纯文本区 + 编辑/预览切换（MarkdownText 渲染）。用户反馈后精简：
 * 不再提供语法工具栏，只保留预览切换；预览不设内滚（页面级滚动，避免双
 * 滚动条）。轻量实现，不引入第三方编辑器依赖。
 *
 * @module dsh-eteams/client/mdEditor
 */
import { type ReactNode, useState } from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';

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

export function MdEditor({
  value,
  onChange,
  minHeight = 320,
}: {
  value: string;
  onChange: (next: string) => void;
  minHeight?: number;
}): ReactNode {
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');

  const seg = (active: boolean): React.CSSProperties => ({
    padding: '2px 10px',
    fontSize: 11.5,
    fontWeight: active ? 600 : 400,
    border: 'none',
    borderRadius: 6,
    background: active ? T.accentSoft : 'transparent',
    color: active ? T.accent : T.text2,
    cursor: 'pointer',
  });

  return (
    <div
      style={{
        border: `1px solid ${T.border2}`,
        borderRadius: 10,
        background: T.surface,
        overflow: 'hidden',
      }}
    >
      {/* 编辑器头部：左侧「Markdown」标识 + 右侧 编辑/预览 分段切换 */}
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
        <span style={{ fontSize: 10.5, color: T.text3 }}>frontmatter + 正文</span>
        <span style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', gap: 2 }}>
          <button type="button" style={seg(mode === 'edit')} onClick={() => setMode('edit')}>
            编辑
          </button>
          <button
            type="button"
            style={seg(mode === 'preview')}
            onClick={() => setMode('preview')}
          >
            预览
          </button>
        </span>
      </div>
      {mode === 'edit' ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          placeholder={'---\nname: …\ndescription: …\nemoji: …\ncolor: …\n---\n\n# 成员名\n\n…'}
          style={{
            display: 'block',
            width: '100%',
            boxSizing: 'border-box',
            minHeight,
            padding: '10px 12px',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'inherit',
            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
            fontSize: 12,
            lineHeight: 1.65,
            resize: 'vertical',
          }}
        />
      ) : (
        <div
          style={{
            minHeight,
            padding: '10px 12px',
            background: 'transparent',
            fontSize: 12.5,
            lineHeight: 1.65,
          }}
        >
          {value.trim() === '' ? (
            <span style={{ color: T.text3 }}>（暂无内容）</span>
          ) : (
            <MarkdownText text={value} />
          )}
        </div>
      )}
    </div>
  );
}
