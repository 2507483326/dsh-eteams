/**
 * 背景板引擎单测（docs/22 S22-3 / D20d）：纯逻辑层确定性验证——高度场、
 * 渐隐、调色板采样、静层指令、坦克步进与「不喧宾夺主」硬指标（D20e/f/g）。
 * node 环境无 DOM：被测模块零 DOM 依赖（设计约束本身）。
 */
import { describe, expect, it } from 'vitest';
import {
  COMPOSITE_ALPHA_CAP,
  TANK_SPRITE,
  clamp01,
  createHeightField,
  createTanks,
  fadeAlpha,
  mulberry32,
  planStaticLayer,
  planTankOps,
  rotateSprite,
  sampleBackdropPalette,
  smoothstep,
  stepTank,
  withAlpha,
  type StaticOp,
  type Tank,
} from '../src/client/backdropEngine';

/** 常规画布尺寸（逻辑 px）与格子，测试共用。 */
const W = 1200;
const H = 800;
const CELL = 30;

/** 从 rgba() 字符串里抠 alpha（断言「不喧宾夺主」上限用）。 */
function alphaOf(color: string): number {
  const m = /rgba\([^)]*,([0-9.]+)\)/.exec(color);
  expect(m, `not an rgba color: ${color}`).not.toBeNull();
  return Number.parseFloat(m?.[1] ?? '0');
}

describe('mulberry32', () => {
  it('same seed replays the same sequence within [0,1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('different seeds diverge', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe('smoothstep / fadeAlpha (D20g)', () => {
  it('smoothstep clamps and transitions 0→1', () => {
    expect(smoothstep(0.2, 0.8, 0.1)).toBe(0);
    expect(smoothstep(0.2, 0.8, 0.9)).toBe(1);
    expect(smoothstep(0.2, 0.8, 0.5)).toBeGreaterThan(0);
    expect(smoothstep(0.2, 0.8, 0.5)).toBeLessThan(1);
  });

  it('full alpha at top-right corner, zero at bottom-left corner', () => {
    expect(fadeAlpha(W, 0, W, H)).toBe(1);
    expect(fadeAlpha(0, H, W, H)).toBe(0);
  });

  it('monotonically fades along the TR→BL diagonal', () => {
    let prev = Number.POSITIVE_INFINITY;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const a = fadeAlpha(W * (1 - t), H * t, W, H);
      expect(a).toBeLessThanOrEqual(prev + 1e-9);
      expect(a).toBeGreaterThanOrEqual(0);
      prev = a;
    }
  });
});

describe('withAlpha', () => {
  it('bakes alpha into hex colors', () => {
    expect(withAlpha('#0ea5e9', 0.05)).toBe('rgba(14,165,233,0.05)');
  });

  it('multiplies alpha for pre-blended rgba colors', () => {
    expect(withAlpha('rgba(14,165,233,0.5)', 0.4)).toBe('rgba(14,165,233,0.2)');
  });

  it('clamps and passes unknown formats through untouched', () => {
    expect(withAlpha('#ffffff', 2)).toBe('rgba(255,255,255,1)');
    expect(withAlpha('#ffffff', -1)).toBe('rgba(255,255,255,0)');
    expect(withAlpha('not-a-color', 0.5)).toBe('not-a-color');
  });
});

describe('sampleBackdropPalette (D20h/D21e)', () => {
  it('falls back to the DSW-blue literal palette when host vars are absent', () => {
    const p = sampleBackdropPalette(() => null);
    // 网格线 = label 兜底 #475569 at 0.05
    expect(p.gridLine).toBe('rgba(71,85,105,0.05)');
    // 品牌点缀兜底 = deepseek-500 #4176e6（docs/23 D21e）
    expect(p.terrainPeak).toBe('rgba(65,118,230,0.07)');
    expect(p.tankAccent).toBe('rgba(65,118,230,0.4)');
    expect(p.compositeAlpha).toBe(COMPOSITE_ALPHA_CAP);
  });

  it('respects host-provided colors and alpha caps (D20e/D21e)', () => {
    const p = sampleBackdropPalette((name) =>
      name === '--dsw-alias-label-secondary'
        ? '#94a3b8'
        : name === '--dsw-alias-button-info-fill'
          ? '#679efe'
          : 'rgba(0,0,0,0)',
    );
    expect(p.gridLine.startsWith('rgba(148,163,184,')).toBe(true);
    expect(p.tankAccent.startsWith('rgba(103,158,254,')).toBe(true);
    for (const color of [p.gridLine, p.terrainShade, p.terrainPeak]) {
      expect(alphaOf(color)).toBeLessThanOrEqual(0.07 + 1e-9);
    }
    for (const color of [p.tankBody, p.tankDark, p.tankAccent]) {
      expect(alphaOf(color)).toBeLessThanOrEqual(0.4 + 1e-9);
    }
  });
});

describe('createHeightField', () => {
  it('is deterministic per seed, within [0,1], and locally smooth', () => {
    const cols = 41;
    const rows = 28;
    const a = createHeightField(cols, rows, 7);
    const b = createHeightField(cols, rows, 7);
    const c = createHeightField(cols, rows, 8);
    expect([...a]).toEqual([...b]);
    expect([...a]).not.toEqual([...c]);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 1; cx < cols; cx++) {
        const v = a[cy * cols + cx] ?? 0;
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        const left = a[cy * cols + cx - 1] ?? 0;
        expect(Math.abs(v - left)).toBeLessThan(0.5); // 值噪声平滑性
      }
    }
  });
});

describe('planStaticLayer', () => {
  const palette = sampleBackdropPalette(() => null);
  const heights = createHeightField(Math.ceil(W / CELL) + 1, Math.ceil(H / CELL) + 1, 11);
  const ops = planStaticLayer(W, H, CELL, palette, heights);

  it('produces ops strictly inside the canvas', () => {
    expect(ops.length).toBeGreaterThan(100);
    for (const op of ops) {
      expect(op.x).toBeGreaterThanOrEqual(0);
      expect(op.y).toBeGreaterThanOrEqual(0);
      expect(op.x + op.w).toBeLessThanOrEqual(W);
      expect(op.y + op.h).toBeLessThanOrEqual(H);
    }
  });

  it('never exceeds the subtlety caps (D20e)', () => {
    for (const op of ops) {
      expect(alphaOf(op.color)).toBeLessThanOrEqual(0.07 + 1e-9);
    }
  });

  it('skips fully faded cells (bottom-left stays silent)', () => {
    // 左下角 60%×60% 区块内不允许出现 fade≈0 的实体指令——所有落在这块的
    // 指令 alpha 必须接近 0（<0.005）。
    for (const op of ops) {
      if (op.x < W * 0.2 && op.y > H * 0.8) {
        expect(alphaOf(op.color)).toBeLessThan(0.005);
      }
    }
  });
});

describe('rotateSprite / planTankOps (D20f)', () => {
  const pixelCount = (sprite: readonly (readonly number[])[]): number =>
    sprite.flat().filter((p) => p !== 0).length;

  it('conserves pixels across rotations and swaps dims', () => {
    const base = pixelCount(TANK_SPRITE);
    const rows = TANK_SPRITE.length;
    const cols = TANK_SPRITE[0]?.length ?? 0;
    for (const dir of [0, 1, 2, 3] as const) {
      const s = rotateSprite(TANK_SPRITE, dir);
      expect(pixelCount(s)).toBe(base);
      if (dir === 1 || dir === 3) {
        expect(s.length).toBe(cols);
        expect(s[0]?.length).toBe(rows);
      } else {
        expect(s.length).toBe(rows);
        expect(s[0]?.length).toBe(cols);
      }
    }
  });

  it('mirrors horizontally for dir 2', () => {
    const mirrored = rotateSprite(TANK_SPRITE, 2);
    const lastRow = TANK_SPRITE[TANK_SPRITE.length - 1] ?? [];
    expect(mirrored[mirrored.length - 1]?.join('')).toBe([...lastRow].reverse().join(''));
  });

  const palette = sampleBackdropPalette(() => null);
  const tank: Tank = {
    x: 900,
    y: 120,
    dir: 0,
    speed: 12,
    age: 0,
    nextTurnAt: 5,
    rand: mulberry32(3),
  };

  it('emits one rect per sprite pixel with palette colors and pixel size 2-3', () => {
    const ops: StaticOp[] = planTankOps(tank, CELL, palette);
    const expected = TANK_SPRITE.flat().filter((p) => p !== 0).length;
    expect(ops.length).toBe(expected);
    for (const op of ops) {
      expect(op.w).toBeGreaterThanOrEqual(2);
      expect(op.w).toBeLessThanOrEqual(3);
      expect(alphaOf(op.color)).toBeLessThanOrEqual(0.4 + 1e-9);
    }
    // 居中：车体包围盒罩住锚点。
    const minX = Math.min(...ops.map((o) => o.x));
    const maxX = Math.max(...ops.map((o) => o.x + o.w));
    expect(tank.x).toBeGreaterThan(minX);
    expect(tank.x).toBeLessThan(maxX);
  });
});

describe('tank lifecycle (D20f lane-locked, zone-constrained)', () => {
  const tanks = createTanks(3, W, H, CELL, 12345);

  it('spawns the requested count on grid intersections inside the zone', () => {
    expect(tanks.length).toBe(3);
    for (const t of tanks) {
      expect(t.x % CELL).toBe(0);
      expect(t.y % CELL).toBe(0);
      expect(fadeAlpha(t.x, t.y, W, H)).toBeGreaterThanOrEqual(0.3);
      expect(t.speed).toBeGreaterThanOrEqual(10);
      expect(t.speed).toBeLessThanOrEqual(16);
    }
  });

  it('replays identical trajectories for identical seeds', () => {
    const a = createTanks(3, W, H, CELL, 777);
    const b = createTanks(3, W, H, CELL, 777);
    for (let i = 0; i < 500; i++) {
      for (const t of a) stepTank(t, 0.016, W, H, CELL);
      for (const t of b) stepTank(t, 0.016, W, H, CELL);
    }
    expect(a.map((t) => `${Math.round(t.x)},${Math.round(t.y)},${t.dir}`)).toEqual(
      b.map((t) => `${Math.round(t.x)},${Math.round(t.y)},${t.dir}`),
    );
  });

  it('keeps every tank on lanes, in bounds and inside the zone over 120s', () => {
    for (let i = 0; i < 2400; i++) {
      for (const t of tanks) stepTank(t, 0.05, W, H, CELL);
      for (const t of tanks) {
        expect(t.x).toBeGreaterThanOrEqual(0);
        expect(t.x).toBeLessThanOrEqual(W);
        expect(t.y).toBeGreaterThanOrEqual(0);
        expect(t.y).toBeLessThanOrEqual(H);
        // 车道不变式：横纵至少有一轴精确落在网格线上。
        expect(t.x % CELL === 0 || t.y % CELL === 0).toBe(true);
        // 活动区不变式（每步末校正，允许浮点极小越界）。
        expect(fadeAlpha(t.x, t.y, W, H)).toBeGreaterThanOrEqual(0.3 - 1e-9);
      }
    }
  });

  it('moves at its own constant speed per axis-aligned step', () => {
    const t = createTanks(1, W, H, CELL, 5)[0];
    if (t === undefined) throw new Error('expected a tank');
    t.dir = 0; // 强制向右，关闭转向干扰
    t.nextTurnAt = Number.POSITIVE_INFINITY;
    const startX = t.x;
    const startY = t.y;
    stepTank(t, 0.1, W, H, CELL);
    expect(t.x - startX).toBeCloseTo(t.speed * 0.1, 6);
    expect(t.y).toBe(startY); // 车道锁死
  });

  it('clamps pathological dt spikes (tab resume) without teleporting', () => {
    const t = createTanks(1, W, H, CELL, 9)[0];
    if (t === undefined) throw new Error('expected a tank');
    const startX = t.x;
    t.dir = 0;
    t.nextTurnAt = Number.POSITIVE_INFINITY;
    stepTank(t, 5, W, H, CELL); // 5s 跳帧 → clamp 到 0.1s
    expect(t.x - startX).toBeCloseTo(t.speed * 0.1, 6);
  });
});

describe('clamp01', () => {
  it('clamps to [0,1]', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1.5)).toBe(1);
  });
});
