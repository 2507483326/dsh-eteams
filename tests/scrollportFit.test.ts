/**
 * 面板高度锚的纯算术层（features/layout/scrollportFit 的 `availableHeightOf`）：
 * 面板根可用可见高 = 宿主滚动视口可见高 − 顶部偏移 − 下方流内内容（输入框座位），
 * 非正回落 null（保持 `height:100%`，不把面板压没）。用户 2026-09-16「三个面板应该
 * 是占满整屏的……不能超过屏幕出现外部滚动条」。
 *
 * @module dsh-eteams/tests/scrollportFit
 */
import { describe, expect, it } from 'vitest';
import { availableHeightOf } from '../src/client/features/layout/scrollportFit';

describe('availableHeightOf', () => {
  it('视口可见高扣掉顶部偏移与下方占位', () => {
    // 宿主实测档（client.log：视口 1081，输入框座位 96，面板顶在视口顶部）。
    expect(availableHeightOf(1081, 0, 96)).toBe(985);
    expect(availableHeightOf(900, 40, 120)).toBe(740);
  });

  it('顶部偏移为负（视口已滚动）按 0 计，不把高度放大', () => {
    expect(availableHeightOf(600, -80, 0)).toBe(600);
  });

  it('占位为负（量到脏值）按 0 计', () => {
    expect(availableHeightOf(600, 0, -20)).toBe(600);
  });

  it('结果非正回落 null（面板已被挤出视口，交给 100% 兜底）', () => {
    expect(availableHeightOf(100, 40, 80)).toBeNull();
    expect(availableHeightOf(100, 100, 0)).toBeNull();
    expect(availableHeightOf(0, 0, 0)).toBeNull();
  });

  it('取整到整数像素（避免半像素抖动反复写样式）', () => {
    expect(availableHeightOf(700.6, 0.6, 0.6)).toBe(699);
  });
});
