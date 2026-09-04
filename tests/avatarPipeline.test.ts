/**
 * Avatar pipeline unit tests (docs/14.8): seeded determinism, option
 * coverage (mandatory widgets present, none-ness where required), SVG
 * composition contract (paint order, fill substitution, skin inheritance,
 * id namespacing), and forward compatibility (unknown shape ids are
 * skipped, not fatal).
 */
import { describe, expect, it } from 'vitest';

import { AVATAR_LAYER, generateAvatarOption } from '../src/client/features/avatar/avatarOption';
import { AVATAR_WIDGETS_FINGERPRINT, AVATAR_WIDGET_SVGS } from '../src/client/features/avatar/avatarWidgets';
import { composeAvatarSvg } from '../src/client/features/avatar/avatarSvg';

describe('generateAvatarOption（种子确定性）', () => {
  it('同 (seed, salt) 两次生成完全一致', () => {
    const a = generateAvatarOption(12345, 678);
    const b = generateAvatarOption(12345, 678);
    expect(a).toEqual(b);
  });

  it('不同 salt 产出不同头像（可重摇契约）', () => {
    const options = new Set(
      Array.from({ length: 24 }, (_, i) => JSON.stringify(generateAvatarOption(42, i))),
    );
    // 24 摇全同的概率近似 0；阈值放宽到 20 仍能抓住 PRNG 失效回归。
    expect(options.size).toBeGreaterThanOrEqual(20);
  });

  it('必选部件齐全且无 none', () => {
    for (let seed = 0; seed < 30; seed++) {
      const option = generateAvatarOption(seed, seed * 7);
      for (const [type, widget] of Object.entries(option.widgets)) {
        expect(widget.shape, `${type} @ ${seed}`).not.toBe('');
        expect(widget.shape, `${type} @ ${seed}`).toBeTruthy();
      }
      // earrings/glasses/beard 允许 none（上游语义），其余类别不允许。
      const optionalTypes = ['earrings', 'glasses', 'beard'];
      for (const [type, widget] of Object.entries(option.widgets)) {
        if (!optionalTypes.includes(type)) {
          expect(widget.shape, `${type} @ ${seed}`).not.toBe('none');
        }
      }
      // beard 非 none 即 scruff（male 池唯一形状）。
      if (option.widgets.beard!.shape !== 'none') {
        expect(option.widgets.beard!.shape).toBe('scruff');
      }
    }
  });

  it('punk/fonze 发型不撞同色背景（上游特例）', () => {
    for (let seed = 0; seed < 400; seed++) {
      const option = generateAvatarOption(seed, seed);
      const hair = option.widgets.tops!;
      if (hair.shape === 'punk' || hair.shape === 'fonze') {
        expect(option.background.color).not.toBe(hair.fillColor);
      }
    }
  });

  it('scruff 胡须带 z 序覆盖（压在嘴下）', () => {
    for (let seed = 0; seed < 400; seed++) {
      const option = generateAvatarOption(seed, seed);
      const beard = option.widgets.beard!;
      if (beard.shape === 'scruff') {
        expect(beard.zIndex).toBe(AVATAR_LAYER.mouth - 1);
      }
    }
  });
});

describe('composeAvatarSvg（合成契约）', () => {
  const option = generateAvatarOption(2026, 9);
  const svg = composeAvatarSvg({ option, size: 40, idNamespace: 't0' });

  it('同输入同输出（快照确定性契约）', () => {
    const again = composeAvatarSvg({ option, size: 40, idNamespace: 't0' });
    expect(again).toBe(svg);
  });

  it('顶层结构与画板尺寸（固定 400 板，translate(100, 65)）', () => {
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg).toContain('viewBox="0 0 400 400"');
    expect(svg).toContain('<g transform="translate(100, 65)">');
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  it('按 AVATAR_LAYER 排序：脸先于五官、衣服最后', () => {
    const face = svg.indexOf('eteams-av-t0-face');
    const clothes = svg.indexOf('eteams-av-t0-clothes');
    const eyes = svg.indexOf('eteams-av-t0-eyes');
    const tops = svg.indexOf('eteams-av-t0-tops');
    expect(face).toBeGreaterThan(0);
    // face(z=10) 最先绘制；eyes(50) 在其后；tops(80) 再后；clothes(110) 最后。
    expect(eyes).toBeGreaterThan(face);
    expect(tops).toBeGreaterThan(eyes);
    expect(clothes).toBeGreaterThan(tops);
    // 第一个绘制层就是 face（所有必选部件里 z 最小）。
    expect(svg.indexOf('<g id="')).toBeLessThan(face + 8 + 1);
    expect(svg.slice(0, face)).not.toMatch(/<g id="eteams-av-t0-(?!face)/);
  });

  it('$fillColor 全部替换为具体色值', () => {
    expect(svg).not.toContain('$fillColor');
    expect(svg).toContain(`fill="${option.widgets.face!.fillColor}"`);
  });

  it('ear 继承肤色（上游规则）', () => {
    const skin = option.widgets.face!.fillColor!;
    const ear = option.widgets.ear!;
    if (ear.shape !== 'none') {
      const earLayer = svg.slice(
        svg.indexOf(`eteams-av-t0-ear"`) - 60,
        svg.indexOf(`eteams-av-t0-earrings`),
      );
      expect(earLayer).toContain(`fill="${skin}"`);
    }
  });

  it('mask/clipPath id 带命名空间前缀（多头像同页隔离）', () => {
    // 上游 face base.svg 定义 mask0 与 path-4-inside-1；合成后必须带 ns。
    const hasMask = option.widgets.mouth!.shape === 'laughing';
    void hasMask;
    if (svg.includes('<mask')) {
      expect(svg).toMatch(/id="eteams-av-t0[\w-]*mask0"/);
      expect(svg).not.toMatch(/[\s"]id="mask0"/);
      expect(svg).toContain('url(#eteams-av-t0');
      expect(svg).not.toContain('url(#mask0)');
    }
    if (svg.includes('<clipPath')) {
      expect(svg).not.toContain('url(#clip0)');
    }
  });

  it('不同命名空间产出不同 id（React useId 隔离两个头像）', () => {
    const other = composeAvatarSvg({ option, size: 40, idNamespace: 't1' });
    expect(other).not.toBe(svg);
    expect(other).toContain('eteams-av-t1-');
    expect(other).not.toContain('eteams-av-t0-');
  });

  it('前向兼容：未知形状 id 被跳过，其余照常渲染', () => {
    const mutated = {
      ...option,
      widgets: {
        ...option.widgets,
        nose: { shape: 'wedge-from-a-future-version' },
        eyes: option.widgets.eyes!,
      },
    };
    const tolerant = composeAvatarSvg({ option: mutated, size: 40, idNamespace: 't2' });
    expect(tolerant).not.toContain('eteams-av-t2-nose');
    expect(tolerant).toContain('eteams-av-t2-eyes');
    expect(tolerant).toContain('eteams-av-t2-clothes');
  });

  it('部件表完整：39 个上游形状全量入库', () => {
    const counts = Object.entries(AVATAR_WIDGET_SVGS).map(
      ([c, s]) => `${c}:${Object.keys(s).length}`,
    );
    const total = Object.values(AVATAR_WIDGET_SVGS).reduce((n, s) => n + Object.keys(s).length, 0);
    expect(counts).toContain('face:1');
    expect(counts).toContain('tops:9');
    expect(counts).toContain('mouth:8');
    expect(total).toBe(39);
    expect(AVATAR_WIDGETS_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/);
    // 每个 SVG 都是完整文档且带可剥开的 <svg> 包装。
    for (const shapes of Object.values(AVATAR_WIDGET_SVGS)) {
      for (const doc of Object.values(shapes)) {
        expect(doc.startsWith('<svg')).toBe(true);
        expect(doc).toContain('</svg>');
      }
    }
  });
});
