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
    // 层级：压过整页团队页（teamsPanel.tsx，z-[500]）与宿主模态层
    // （dsh-client-ui-primitives Modal.module.css `.root` z-index:1000，宿主
    // 设置弹窗此档）——eteams 弹窗要开在两者之上。整页团队页也是 fixed 层，
    // 页内打开的 Dialog/Popover/Select 全 portal 到本容器——容器若仍是静态
    // 定位（z 无效、浮层按 z-50 参与根层叠），会被 z-[500] 的页面整个盖住：
    // 弹窗隐身（用户反馈 2026-09「变暗了但没弹窗框」）。relative + zIndex 让
    // 容器整体成为 z-1100 层叠上下文（子浮层的 z-50 在其内部比较）；relative
    // 不产生 fixed 包含块，子浮层定位不受影响。团队弹层卡（teamsButton）
    // z-[1000]，1100 一并压过。宿主层级台账：内容 z-auto < 浮层 100 < 模态
    // 1000 < toast/onboarding 1100。
    el.style.position = 'relative';
    el.style.zIndex = '1100';
    document.body.appendChild(el);
    container = el;
  }
  return container;
}
