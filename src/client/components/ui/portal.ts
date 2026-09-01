/**
 * Radix 浮层自管 portal 容器（docs/21-client-ui-stack.md D19b / S13）。
 *
 * Radix Portal 默认把浮层挂到 document.body——宿主页面 body 下没有
 * `.eteams-ui` 祖先，工具类（important: '.eteams-ui' → `.eteams-ui .xxx`
 * 后代选择器）与 eteams.css 的 token 桥全部失效（D19b「portal 逃出作用域」）。
 * 改挂自管容器：body 下惰性创建 `<div class="eteams-ui-portal eteams-ui">`
 * ——类名带 `eteams-ui` 字面量，容器自身即作用域根（token 桥生效、后代工具
 * 类可命中）；components/ui/dialog.tsx 的 DialogPortal 统一经本模块取容器。
 *
 * 惰性创建 + 模块级缓存（幂等：重复调用不会叠出第二个容器）；容器被宿主
 * 清出 DOM（isConnected=false，整页视图重建等）时重建，保证返回的引用永远
 * 指向在册节点。
 *
 * @module dsh-eteams/client/components/ui/portal
 */

let container: HTMLElement | null = null;

/** 取（必要时惰性创建）`.eteams-ui-portal.eteams-ui` portal 容器元素。 */
export function getPortalContainer(): HTMLElement {
  if (container === null || !container.isConnected) {
    const el = document.createElement('div');
    el.className = 'eteams-ui-portal eteams-ui';
    // 作用域根自身不承后代工具类（D19b 机制），字体栈（docs/22 D20b）以
    // inline 落在容器上：portal 进来的浮层文字与面板同字体（浮层内后代
    // 继承 inline 值；token 定义在 .eteams-ui 即本容器，var 可解析）。
    el.style.fontFamily = 'var(--eteams-font-sans)';
    document.body.appendChild(el);
    container = el;
  }
  return container;
}
