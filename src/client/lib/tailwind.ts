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
 * 团队页签挂载期间隐藏宿主对话区两侧的拖宽手柄（用户迭代 2026-09-10）。
 *
 * 手柄是宿主 ConversationRoot 对每个 active 视图无条件渲染的 chrome（元素带
 * `data-width-handle` 属性，0.1.2 起存在）：拖动写 `--dsh-chat-user-width`，
 * 只影响聊天内容列宽。轨迹视图不吃该变量、手柄悬停区落在其内容之外所以
 * 察觉不到；本面板满幅布局，两条悬停带正好落在面板内容上——悬停出现
 * col-resize 光标与辉光纯属干扰。conversation.view 注册项没有任何关闭
 * 手柄的参数（0.1.2 合同只有 id/order/label/priority，已核对运行时
 * .d.ts），故按宿主自己的遮蔽手法办：宿主用
 * `.root:has([data-conversation-composer-overlay])` 隐藏手柄，这里双触发键
 * 同法炮制——
 * - `html[data-eteams-view-active]`：面板挂载 effect 在文档根挂/摘的标记
 *   （teamsView/index.tsx），不依赖 :has()，卸载即恢复；
 * - `body:has([data-eteams='view'])`：以视图根标记为键的纯 CSS 兜底，覆盖
 *   effect 未及运行的瞬间。
 * 切回对话/轨迹页签时两个键都消失，手柄自动恢复，无需任何额外 JS 联动。
 */
const HIDE_WIDTH_HANDLE_CSS = `
html[data-eteams-view-active] [data-width-handle],
body:has([data-eteams='view']) [data-width-handle] { display: none; }
`;

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
  // Tailwind 产物之外追加非工具类规则（HIDE_WIDTH_HANDLE_CSS）：同一节点
  // 保证注入顺序与幂等键单一，省一个 head 上的 style 元素。
  style.textContent = twCss + HIDE_WIDTH_HANDLE_CSS;
  document.head.appendChild(style);
}
