/**
 * 面板「随宿主滚动视口定高」钩子（用户 2026-09-16「三个面板应该是占满整屏的，
 * 和团队这种应该是一样的啊，使用flex布局，限制最小高度」+「不能超过屏幕出现
 * 外部滚动条」）。
 *
 * 为什么要量（实测根因，不是猜）：宿主把「会话视图区」在 active 相位设成按内容
 * 增高、不许压缩（`@deepseek-ai/dsh-client-ui-conversation` 的 ConversationRoot
 * 样式 `.viewArea{flex:1 0 auto;min-height:auto}`）——视图区因此没有确定高度，
 * 面板根的 `height:100%` 会解析回「内容高」。面板于是整体随内容一起长：client.log
 * 的 backdrop-geom 实测 `root=1714x1871 scroll=1714x1081`（面板根 1871px，宿主滚动
 * 区可见高只有 1081px），宿主那一列必然出外部滚动条；而页内所有 `flex-1` 等分、
 * `min-h-0` 压缩与卡内 `overflow-y-auto` 都因为「容器没有确定高度」而失效——这
 * 正是「改了卡内高度还是不行」的原因。
 *
 * 口径：把面板根钉在「宿主最近滚动视口的可见高度」上（写 px，等价于整页覆盖层
 * measurePane 量出 pane 矩形写 inline 高度的先例）：
 *   可用高 = 视口可见高 − 我们顶部在视口内的偏移 − 我们下方仍在流内的宿主内容高
 * 最后一项是对话输入框座位（sticky 占位；绝对/固定定位时不占位），不减它面板会
 * 顶到输入框底下、视口照样出滚动条。钉住后面板恰好占满可见区且不外溢，页内 flex
 * 布局拿到确定高度：三个卡按 flex 分配、长内容在卡内自滚。
 * 整页覆盖层（父级已定高 + overflow-hidden）量出来与本来的 `height:100%` 等价，
 * 无行为变化。视口尺寸变化（窗口缩放、输入框长高、宿主 chrome 变化）由
 * ResizeObserver 重算，不轮询。
 *
 * @module dsh-eteams/client/features/layout/scrollportFit
 */
import { useEffect, useState, type RefObject } from 'react';

/** 承载「视口」语义的 overflow-y 档：auto/scroll/hidden 三种都会裁剪内容。 */
const SCROLLPORT_OVERFLOW_Y = new Set(['auto', 'scroll', 'hidden']);

/** 输入框座位的标记（宿主 composer 的稳定属性，见 lib/bridge 同款探测）。 */
const COMPOSER_INPUT_SELECTOR = '[data-composer-input]';

/**
 * 最近的滚动/裁剪祖先（宿主会话滚动区 scrollBody、整页覆盖层的裁剪层）；一路
 * 找不到返回 null（调用方各自兜底：本模块的钩子回落文档视口，背景板回落文档
 * 可视高——EteamsBackdrop 共用本函数，此前那里是逐字同逻辑的局部实现）。
 */
export function findScrollport(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur !== null) {
    if (SCROLLPORT_OVERFLOW_Y.has(getComputedStyle(cur).overflowY)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

/**
 * 输入框座位：视口内包含宿主 composer 输入框、且是视口**直接子元素**的那个块
 * （宿主结构为 `scrollBody > [session] > viewArea` + `scrollBody > composerSeat`）。
 * 不在视口子树里、或不在面板下方时返回 null（不做扣减）。
 */
function composerSeatOf(host: HTMLElement, root: HTMLElement): HTMLElement | null {
  const marker = host.querySelector(COMPOSER_INPUT_SELECTOR);
  if (!(marker instanceof HTMLElement)) return null;
  let seat: HTMLElement = marker;
  let parent: HTMLElement | null = seat.parentElement;
  while (parent !== null && parent !== host) {
    seat = parent;
    parent = seat.parentElement;
  }
  if (parent !== host) return null;
  if (seat.getBoundingClientRect().top < root.getBoundingClientRect().top) return null;
  return seat;
}

/** 座位在流内占的高度：sticky/relative 占位，absolute/fixed 不占位。 */
function seatFlowHeightOf(seat: HTMLElement): number {
  const position = getComputedStyle(seat).position;
  return position === 'absolute' || position === 'fixed' ? 0 : seat.offsetHeight;
}

/**
 * 面板根可用的可见高度（纯函数，见 tests/scrollportFit.test.ts）：视口可见高减去
 * 顶部偏移与我们下方的流内内容；非正（面板已被完全挤出视口）返回 null = 调用方
 * 保持原 `height:100%` 不动，不写 0 把面板压没。
 */
export function availableHeightOf(
  hostHeight: number,
  rootTopInHost: number,
  belowHeight: number,
): number | null {
  const available = Math.floor(hostHeight - Math.max(0, rootTopInHost) - Math.max(0, belowHeight));
  return available > 0 ? available : null;
}

/**
 * 把面板根钉到宿主滚动视口的可见高度（详见模块头）。返回值给调用方写进根元素
 * 的 `height`（数值为 px；null = 未量到，用 `100%` 兜底）。挂载与视口尺寸变化
 * 时重算，另在挂载后补一次迟到布局（输入框座位后挂）的测量。
 */
export function useScrollportFit(ref: RefObject<HTMLElement | null>): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const root = ref.current;
    if (root === null) return;
    const observed = new Set<Element>();
    let ro: ResizeObserver | null = null;
    const watch = (el: Element | null): void => {
      if (el === null || ro === null || observed.has(el)) return;
      observed.add(el);
      ro.observe(el);
    };
    const measure = (): void => {
      // 找不到滚动/裁剪祖先（如宿主结构变化）时回落文档视口：可见高 = 窗口可见高。
      const host = findScrollport(root) ?? root.ownerDocument.documentElement;
      watch(host);
      const seat = composerSeatOf(host, root);
      watch(seat);
      const next = availableHeightOf(
        host.clientHeight,
        root.getBoundingClientRect().top - host.getBoundingClientRect().top,
        seat === null ? 0 : seatFlowHeightOf(seat),
      );
      setHeight((prev) => (prev === next ? prev : next));
    };
    if (typeof ResizeObserver === 'function') ro = new ResizeObserver(() => measure());
    measure();
    // 迟到布局补测一次（输入框座位可能晚于本组件挂载；RO 只能盯到已存在的元素）。
    const timer = window.setTimeout(measure, 400);
    return () => {
      window.clearTimeout(timer);
      ro?.disconnect();
    };
  }, [ref]);
  return height;
}
