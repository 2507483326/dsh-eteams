/**
 * 背景板引擎单测（docs/22 S22-3 / D20d；docs/23 D21g R2 重定标）：纯逻辑
 * 层确定性验证——高度场、渐隐、调色板采样（实色基底）、静层指令（单次
 * 烘焙有效 alpha + 可见性回归锁）、坦克步进与「不喧宾夺主」上限
 * （D20e/f/g 语义经 D21g 重定标）。node 环境无 DOM：被测模块零 DOM
 * 依赖（设计约束本身）。
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

describe('sampleBackdropPalette (D20h/D21e/D21g)', () => {
  it('falls back to solid DSW-blue/slate literal bases when host vars are absent', () => {
    const p = sampleBackdropPalette(() => null);
    // D21g：调色板只带实色基底（alpha 在使用位单次烘焙）。
    expect(p.label).toBe('#475569');
    expect(p.brand).toBe('#4176e6');
    expect(p.compositeAlpha).toBe(COMPOSITE_ALPHA_CAP);
    expect(COMPOSITE_ALPHA_CAP).toBe(1); // D21g：全局减半层废除
  });

  it('passes host-provided solid bases through (D21e var names)', () => {
    const p = sampleBackdropPalette((name) =>
      name === '--dsw-alias-label-secondary'
        ? '#94a3b8'
        : name === '--dsw-alias-button-info-fill'
          ? '#679efe'
          : 'rgba(0,0,0,0)',
    );
    expect(p.label).toBe('#94a3b8');
    expect(p.brand).toBe('#679efe');
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

  it('never exceeds the D21g subtlety caps (grid 0.07 / terrain 0.11 / peak 0.13)', () => {
    for (const op of ops) {
      expect(alphaOf(op.color)).toBeLessThanOrEqual(0.13 + 1e-9);
    }
  });

  it('keeps the grid VISIBLE in the top-right zone (D21g R2 regression lock)', () => {
    // R2 缺陷回归锁：一期三重叠乘后网格有效 alpha ~0.001（用户「看不到
    // 格子」）。定标后右上核心区（x>0.8W、y<0.2H，fade≥0.93）网格段
    // alpha 必须 ≥ 0.06——可见下限之上（1px 段指令：w===1 或 h===1）。
    const gridOps = ops.filter((op) => (op.w === 1 || op.h === 1) && op.x > W * 0.8 && op.y < H * 0.2);
    expect(gridOps.length).toBeGreaterThan(20);
    for (const op of gridOps) {
      expect(alphaOf(op.color)).toBeGreaterThanOrEqual(0.06 - 1e-9);
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

  it('emits one rect per sprite pixel with baked palette colors and pixel size 2-3', () => {
    const ops: StaticOp[] = planTankOps(tank, CELL, palette);
    const expected = TANK_SPRITE.flat().filter((p) => p !== 0).length;
    expect(ops.length).toBe(expected);
    for (const op of ops) {
      expect(op.w).toBeGreaterThanOrEqual(2);
      expect(op.w).toBeLessThanOrEqual(3);
      // D21g 上限：DSW 蓝点缀 0.62（车身 0.45 / 深档 0.55）。
      expect(alphaOf(op.color)).toBeLessThanOrEqual(0.62 + 1e-9);
    }
    // 居中：车体包围盒罩住锚点。
    const minX = Math.min(...ops.map((o) => o.x));
    const maxX = Math.max(...ops.map((o) => o.x + o.w));
    expect(tank.x).toBeGreaterThan(minX);
    expect(tank.x).toBeLessThan(maxX);
  });

  it('renders tanks as recognizable pixel sprites (D21g R2 regression lock)', () => {
    // R2 缺陷回归锁：一期车身有效 alpha ~0.16 且 sprite 过疏——用户看到
    // 「三个点」。定标后：≥25 实体像素（7×5 经典轮廓）、车身/深档/点缀
    // 三档 alpha 均在可辨识带（0.45 / 0.55 / 0.62），像素尺寸 3px（cell
    // =30 → 全车 21×15px）。
    expect(TANK_SPRITE.flat().filter((p) => p !== 0).length).toBeGreaterThanOrEqual(25);
    expect(TANK_SPRITE.flat().filter((p) => p === 3).length).toBeGreaterThanOrEqual(1);
    const ops: StaticOp[] = planTankOps(tank, CELL, palette);
    const body = ops.find((o) => alphaOf(o.color) > 0.4 && alphaOf(o.color) < 0.5);
    const dark = ops.find((o) => alphaOf(o.color) > 0.5 && alphaOf(o.color) < 0.58);
    const accent = ops.find((o) => alphaOf(o.color) >= 0.62 - 1e-9);
    expect(body).toBeDefined();
    expect(dark).toBeDefined();
    expect(accent).toBeDefined();
    expect(ops[0]?.w).toBe(3); // cell/10 = 3px/像素
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
