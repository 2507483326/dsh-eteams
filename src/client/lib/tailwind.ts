/**
 * Tailwind 产物运行时注入（docs/21-client-ui-stack.md D19a / 21.5.2）。
 *
 * 构建期：`pnpm build` 串步 `scripts/buildTailwind.mjs` —— tailwind CLI 以
 * tailwind.config.ts（preflight 关闭、`important: '.eteams-ui'`、content 只扫
 * src/client）把 src/client/styles/eteams.css 编译成 lib/tailwind.gen.css
 * （gitignored）；tsdown 的 tailwindCssInline 虚拟模块（id 不以 .css 结尾，
 * 规避 css-guard）把该产物以字符串内联进单文件 CJS envelope，类型由
 * eteamsCss.d.ts 的 `*.gen.css` 通配声明供给。
 *
 * 运行期：`ensureEteamsStyles()` 把这段 CSS 幂等注入 document.head 的
 * `<style data-dsh-eteams-tw>`。幂等键用 head 上的属性查重而非模块级布尔——
 * 即便 bundle 被重复求值 / apply 被重复调用，也只会有一份节点。与 mdxeditor
 * 的 `<style data-dsh-eteams-mdx>` 互不干扰（preflight 已关、无全局 reset）；
 * 主题跟随零 JS（宿主 --dsw-alias-* 变量换值即可，见 D19c）。
 *
 * @module dsh-eteams/client/tailwind
 */
import twCss from './tailwind.gen.css';

/** 注入节点的身份属性：幂等查重键，也是 envelope 冒烟断言的锚点。 */
const STYLE_ATTRIBUTE = 'data-dsh-eteams-tw';

/**
 * 幂等注入 Tailwind 产物样式。
 *
 * - `typeof document` 守卫：webless / node 测试等非 DOM 环境直接跳过；
 * - 按 `style[data-dsh-eteams-tw]` 查重：已存在即跳过（幂等）；
 * - 失败向上抛出：调用方（index.tsx apply 的 guard）记录诊断、不致命。
 */
export function ensureEteamsStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.head.querySelector(`style[${STYLE_ATTRIBUTE}]`) !== null) return;
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTRIBUTE, '');
  style.textContent = twCss;
  document.head.appendChild(style);
}
