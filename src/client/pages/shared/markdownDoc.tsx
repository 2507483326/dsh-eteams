/**
 * Markdown 只读渲染包装（docs/41）：宿主 MarkdownText（mdast→React 语义渲染，
 * GFM + KaTeX，raw HTML 关闭）外套 typeset 容器。
 *
 * typeset = shadcn 新排版系统（ui.shadcn.com/docs/components/base/typography，
 * 「One CSS file you own」）：容器类 `typeset` + 三控制预设（本仓 13px/1.7/
 * 1.25em，docs/41 §41.3.6），样式经 eteams.css 文末「Typeset 端口」段
 * （@layer components，(0,3,0) 特异性纪律 + md-code-block 逃生门 + 宿主中和）
 * 随 gen.css 注入，无独立 CSS 通道。容器必须挂**两个字面类**：
 * - `typeset`——端口选择器的系统类；
 * - `eteams-md`——特异性双类（与 .eteams-ui、.typeset 合成 (0,3,0)，压宿主面
 *   最强 (0,2,1) 且不依赖注入顺序，docs/41 §41.3.2）。
 *
 * 内部结构契约（docs/41 §41.3.3）：MarkdownText 恒渲染单根 div（宿主 CSS
 * Modules 哈希类，本文件不可寻址），端口靠 `> :first-child { font: inherit;
 * color: inherit }` 结构寻址复位其 font/color 复声明——若换宿主原语或根结构
 * 变化，先复核该规则。
 *
 * @module dsh-eteams/client/pages/shared/markdownDoc
 */
import type { ReactNode } from 'react';
import { MarkdownText, type MarkdownCodeLabels } from '@deepseek-ai/dsh-client-ui-primitives';

/** Markdown chrome 标签（围栏复制钮 + 脚注节标题，中文文案口径与全仓一致）。
 * 宿主 0.1.2 起渲染器对缺省**无兜底**——不传 labels 时文档一旦含代码围栏
 * （读 labels.code.copyLabel）或脚注（读 labels.footnotes）即整面崩溃
 * （角色详情手册含 ``` 围栏报 "Cannot read properties of undefined (reading
 * 'code')"，2026-09-10 复盘）。模块级常量保证引用稳定（渲染器按引用身份
 * 缓存，换引用即弃缓存）。 */
const MARKDOWN_LABELS = {
  code: { copyLabel: '复制', copiedLabel: '已复制' } satisfies MarkdownCodeLabels,
  footnotes: '脚注',
} as const;

/** 标签 prop 双名补发：本仓类型锁 0.1.0-rc.8（prop 名 `codeLabels`，缺省有
 * 兜底），运行时宿主包 0.1.2 起更名 `labels` 且无兜底。两个名字都喂——旧
 * 运行时吃 codeLabels，新运行时吃 labels（未知 prop 被忽略）。JSX 展开不做
 * 多余属性检查，`labels` 不在 rc.8 类型里也能过 typecheck。 */
const LABELS_PROP = { labels: MARKDOWN_LABELS } as const;

/** 只读 Markdown 渲染（手册卡 ×2 + 任务合同 ×2 消费）。 */
export function MarkdownDoc({ text }: { text: string }): ReactNode {
  return (
    <div className="typeset eteams-md">
      <MarkdownText text={text} codeLabels={MARKDOWN_LABELS.code} {...LABELS_PROP} />
    </div>
  );
}