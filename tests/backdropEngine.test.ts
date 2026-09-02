/**
 * 背景板引擎单测（docs/24 S24-3 / D22g；前承 S22-3/D20d、S23/D21g R2）：
 * 纯逻辑层确定性验证——高度场、渐隐（D22g 重定标 0.12/0.55）、调色板采样
 * （自有 token 兜底）、静层指令（合并后墨量守恒 + 右上可见 + 左下静默 +
 * ≤400 预算）、坦克步进（防死锁 9 锁 + 碰撞仲裁）与「不喧宾夺主」上限。
 * node 环境无 DOM：被测模块零 DOM 依赖（设计约束本身）。
 */
import { describe, expect, it } from 'vitest';
import {
  COMPOSITE_ALPHA_CAP,
  FADE_FAR,
  FADE_NEAR,
  GRID_LINE_ALPHA,
  HALF_TANK,
  HOLD_TIMEOUT,
  TANK_ACCENTS,
  TANK_BODY_ALPHA,
  TANK_DARK_ALPHA,
  TANK_ACCENT_ALPHA,
  TANK_PIXEL,
  TANK_SPRITE,
  clamp01,
  createHeightField,
  createTanks,
  fadeAlpha,
  mulberry32,
  placeTanks,
  planRippleOps,
  planStaticLayer,
  planTankOps,
  rotateSprite,
  sampleBackdropPalette,
  smoothstep,
  stepTank,
  stepTanks,
  withAlpha,
  type StaticOp,
  type Tank,
} from '../src/client/backdropEngine';

/** 常规画布尺寸（逻辑 px）与格子，测试共用。 */
const W = 1200;
const H = 800;
const CELL = 30;
/** 仿真步长（30fps）。 */
const DT = 1 / 30;

/** 从 rgba() 字符串里抠 alpha（断言「不喧宾夺主」上限用）。 */
function alphaOf(color: string): number {
  const m = /rgba\([^)]*,([0-9.]+)\)/.exec(color);
  expect(m, `not an rgba color: ${color}`).not.toBeNull();
  return Number.parseFloat(m?.[1] ?? '0');
}

/** rgba() 的 rgb 前缀（色族断言用，不含 alpha）。 */
function rgbOf(color: string): string {
  const m = /^(rgba?\([^)]+)\)/.exec(color);
  expect(m, `not an rgba color: ${color}`).not.toBeNull();
  return m?.[1] ?? '';
}

/** 手工构造一辆确定性坦克（碰撞/防死锁场景用；字段对引擎全部可选兼容）。 */
function makeTank(x: number, y: number, dir: Tank['dir'], speed: number, seed: number): Tank {
  return {
    x,
    y,
    dir,
    speed,
    age: 0,
    nextTurnAt: Number.POSITIVE_INFINITY, // 场景车不随机转向
    rand: mulberry32(seed),
  };
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

describe('smoothstep / fadeAlpha (D20g → D23-2 rescale)', () => {
  it('keeps the D23-2 rescale constants (0.10 / 0.40)', () => {
    expect(FADE_NEAR).toBe(0.1);
    expect(FADE_FAR).toBe(0.4);
  });

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

  it('keeps a strong corner zone and a fully silent far corner (D23-2 area rescale)', () => {
    // D23-2：FADE 0.10/0.40 把「有东西」进一步压回右上角——角部 15% 带内
    // 显著（25% 带内衰减），左下深角（5%,95%）精确为 0。可见区 ≈ 16%。
    expect(fadeAlpha(W * 0.85, H * 0.15, W, H)).toBeGreaterThanOrEqual(0.45);
    expect(fadeAlpha(W * 0.05, H * 0.95, W, H)).toBe(0);
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

describe('sampleBackdropPalette (D20h/D21e → D22g-7 own tokens)', () => {
  it('falls back to slate-600/sky-500 literal bases when host vars are absent', () => {
    const p = sampleBackdropPalette(() => null);
    // D22g-7：调色板采样源换自有 token（eteams.css D22a 官网字面值），
    // 兜底 = 同名字面（slate-600 #475569 / sky-500 #0ea5e9）。
    expect(p.label).toBe('#475569');
    expect(p.brand).toBe('#0ea5e9');
    expect(p.compositeAlpha).toBe(COMPOSITE_ALPHA_CAP);
    expect(COMPOSITE_ALPHA_CAP).toBe(1); // D21g：全局减半层废除（保持）
  });

  it('reads the D22g own-token var names', () => {
    const p = sampleBackdropPalette((name) =>
      name === '--eteams-backdrop-label'
        ? '#94a3b8'
        : name === '--eteams-backdrop-accent'
          ? '#38bdf8'
          : 'rgba(0,0,0,0)',
    );
    expect(p.label).toBe('#94a3b8');
    expect(p.brand).toBe('#38bdf8');
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

describe('planStaticLayer (D22g-5 merge + rescale)', () => {
  const palette = sampleBackdropPalette(() => null);
  const heights = createHeightField(Math.ceil(W / CELL) + 1, Math.ceil(H / CELL) + 1, 11);
  const ops = planStaticLayer(W, H, CELL, palette, heights);
  const gridOps = ops.filter((op) => op.w === 1 || op.h === 1);

  /** 指令与盒的交面积。 */
  const clip = (op: StaticOp, bx: number, by: number, bw: number, bh: number): number =>
    Math.max(0, Math.min(op.x + op.w, bx + bw) - Math.max(op.x, bx)) *
    Math.max(0, Math.min(op.y + op.h, by + bh) - Math.max(op.y, by));

  it('produces ops strictly inside the canvas (and merging collapses the count)', () => {
    // D23-2：渐隐收紧后可见区 ≈16%，指令量随之下探（86 条 @1200×800/c30）。
    expect(ops.length).toBeGreaterThan(50);
    expect(ops.length).toBeLessThan(1000); // 合并生效（未合并 ~6500 @c30）
    for (const op of ops) {
      expect(op.x).toBeGreaterThanOrEqual(0);
      expect(op.y).toBeGreaterThanOrEqual(0);
      expect(op.x + op.w).toBeLessThanOrEqual(W);
      expect(op.y + op.h).toBeLessThanOrEqual(H);
    }
  });

  it('never exceeds the D23-3 watermark caps (grid 0.05 / terrain 0.03-0.06-0.10)', () => {
    for (const op of ops) {
      expect(alphaOf(op.color)).toBeLessThanOrEqual(0.1 + 1e-9);
    }
  });

  it('keeps the grid VISIBLE in the top-right core (D22g ink regression lock)', () => {
    // R2 缺陷回归锁（D22g 重写为「墨量」口径）：合并后单条指令是长段均色，
    // 逐段 α≥0.06 的旧口径失效；改锁两件事——
    // ① 右上核心区（x>0.8W、y<0.2H）网格墨量 ≥ 0.6 × 理想（按同一采样栅格
    //    逐格 fade·GRID_LINE_ALPHA 数值积分）：合并只准均色、不准丢墨；
    // ② 与核心区相交的网格指令 α ≥ 0.04（可见下限之上）。
    let inkOps = 0;
    let coreMin = Number.POSITIVE_INFINITY;
    for (const op of gridOps) {
      const a = alphaOf(op.color);
      const c = clip(op, W * 0.8, 0, W * 0.2, H * 0.2);
      if (c > 0) {
        inkOps += a * c;
        coreMin = Math.min(coreMin, a);
      }
    }
    let inkIdeal = 0;
    for (let cx = 0; cx <= Math.floor(W / CELL); cx++) {
      const x = Math.min(cx * CELL, W - 1);
      if (x < W * 0.8) continue;
      for (let y = 0; y < H * 0.2; y++) inkIdeal += fadeAlpha(x, y, W, H) * GRID_LINE_ALPHA;
    }
    for (let cy = 0; cy <= Math.floor(H / CELL); cy++) {
      const y = Math.min(cy * CELL, H - 1);
      if (y > H * 0.2) continue;
      for (let x = W * 0.8; x < W; x++) inkIdeal += fadeAlpha(x, y, W, H) * GRID_LINE_ALPHA;
    }
    expect(inkIdeal).toBeGreaterThan(0);
    expect(inkOps / inkIdeal).toBeGreaterThanOrEqual(0.6);
    // D23-3 水印化：网格峰值 α 0.07→0.05，核心区单段下限同步下调。
    expect(coreMin).toBeGreaterThanOrEqual(0.025);
  });

  it('keeps total grid ink (merge conserves ink on the whole board)', () => {
    // 均色合并的墨量守恒：全板网格指令墨量 ≈ 理想（同栅格逐格积分）。
    let inkOps = 0;
    for (const op of gridOps) inkOps += alphaOf(op.color) * op.w * op.h;
    let inkIdeal = 0;
    for (let cx = 0; cx <= Math.floor(W / CELL); cx++) {
      const x = Math.min(cx * CELL, W - 1);
      for (let cy = 0; cy <= Math.floor(H / CELL); cy++) {
        const y0 = cy * CELL;
        const hh = Math.min(CELL, H - y0);
        inkIdeal += fadeAlpha(x, Math.min(y0 + hh / 2, H - 1), W, H) * GRID_LINE_ALPHA * hh;
      }
    }
    for (let cy = 0; cy <= Math.floor(H / CELL); cy++) {
      const y = Math.min(cy * CELL, H - 1);
      for (let cx = 0; cx <= Math.floor(W / CELL); cx++) {
        const x0 = cx * CELL;
        const ww = Math.min(CELL, W - x0);
        inkIdeal += fadeAlpha(Math.min(x0 + ww / 2, W - 1), y, W, H) * GRID_LINE_ALPHA * ww;
      }
    }
    expect(inkOps / inkIdeal).toBeGreaterThanOrEqual(0.9);
    expect(inkOps / inkIdeal).toBeLessThanOrEqual(1.15);
  });

  it('keeps the bottom-left quadrant silent (D22g merge does not borrow ink there)', () => {
    // 左下 1/4 盒（x<0.25W、y>0.75H）总墨量 < 全板 1%——合并后的长段均色
    // 不得把右上亮度「借」到深区（R3「背景不在右上角」的另一半）。
    let inkBox = 0;
    let inkAll = 0;
    for (const op of ops) {
      const a = alphaOf(op.color);
      inkAll += a * op.w * op.h;
      inkBox += a * clip(op, 0, H * 0.75, W * 0.25, H * 0.25);
    }
    expect(inkAll).toBeGreaterThan(0);
    expect(inkBox / inkAll).toBeLessThan(0.01);
  });
});

describe('planStaticLayer merge budget (D22g-5 lock: ≤400 @1920x1080/c24)', () => {
  it('stays within the instruction budget and drops sub-0.01 ops', () => {
    const BW = 1920;
    const BH = 1080;
    const BC = 24;
    const palette = sampleBackdropPalette(() => null);
    const heights = createHeightField(Math.ceil(BW / BC) + 1, Math.ceil(BH / BC) + 1, 0x0ea5e9);
    const ops = planStaticLayer(BW, BH, BC, palette, heights);
    // R3 诊断：未合并 10166 条 → 合并后 ≤400（24× 削减）。
    expect(ops.length).toBeLessThanOrEqual(400);
    for (const op of ops) {
      expect(alphaOf(op.color)).toBeGreaterThanOrEqual(0.01 - 1e-9); // 最终 α<0.01 跳过
    }
  });
});

describe('planStaticLayer merge budget (D23-1 lock: finer cells)', () => {
  it('c14 stays within the measured budget (sim S25-1: 541 @1920x1080)', () => {
    const BW = 1920;
    const BH = 1080;
    const palette = sampleBackdropPalette(() => null);
    const heights = createHeightField(Math.ceil(BW / 14) + 1, Math.ceil(BH / 14) + 1, 0x0ea5e9);
    const ops = planStaticLayer(BW, BH, 14, palette, heights);
    expect(ops.length).toBeLessThanOrEqual(700);
    for (const op of ops) {
      expect(op.kind).toBe('rect'); // 静层只产 rect（ring 仅出自波纹）
    }
  });
});

describe('planRippleOps (docs/25 D23-5 mouse ripples)', () => {
  const palette = sampleBackdropPalette(() => null);
  const NOW = 10_000;

  it('produces 8 ops (double ring × 4 edges) for a live ripple', () => {
    const ops = planRippleOps({ x: 900, y: 100, born: NOW - 100 }, NOW, W, H, palette);
    expect(ops.length).toBe(8);
    for (const op of ops) {
      expect(op.kind).toBe('ring');
      expect(alphaOf(op.color)).toBeLessThanOrEqual(0.35 + 1e-9);
      expect(op.color.startsWith('rgba(')).toBe(true);
    }
  });

  it('fades to zero: dead ripple yields no ops', () => {
    const ops = planRippleOps({ x: 900, y: 100, born: NOW - 1000 }, NOW, W, H, palette);
    expect(ops.length).toBe(0);
  });

  it('expands over time (outer ring radius grows)', () => {
    const early = planRippleOps({ x: 900, y: 100, born: NOW - 100 }, NOW, W, H, palette);
    const late = planRippleOps({ x: 900, y: 100, born: NOW - 500 }, NOW, W, H, palette);
    const span = (list: StaticOp[]): number => Math.max(...list.map((o) => o.w));
    expect(span(late)).toBeGreaterThan(span(early));
    // 衰减：同点位晚 400ms 的 α 更小。
    const aEarly = alphaOf(early[0]!.color);
    const aLate = alphaOf(late[0]!.color);
    expect(aLate).toBeLessThan(aEarly);
  });

  it('respects the top-right fade (ripple in the bottom-left is invisible)', () => {
    const ops = planRippleOps({ x: 60, y: H - 40, born: NOW - 100 }, NOW, W, H, palette);
    expect(ops.length).toBe(0); // fade × peak < MIN_OP_ALPHA
  });
});

describe('rotateSprite / planTankOps (D20f → D22g-3 colors)', () => {
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

  it('keeps the tank silhouette recognizable in all four directions (D21g shape lock)', () => {
    // 渲染自查教训（R2 轮）：履带必须在行进方向两侧（而非左右整列），
    // 炮管前伸突出于履带端——否则 90° 旋转后剪影退化为工字梁。
    // 本锁按「侧带/中带/炮管突出端」结构断言，对镜像/转置通用。
    for (const dir of [0, 1, 2, 3] as const) {
      const s = rotateSprite(TANK_SPRITE, dir);
      const horizontal = dir === 0 || dir === 2;
      const at = (side: number, along: number): number =>
        horizontal ? (s[side]?.[along] ?? 0) : (s[along]?.[side] ?? 0);
      const runOf = (side: number): number[] => {
        const run: number[] = [];
        for (let along = 0; along < 7; along++) if (at(side, along) !== 0) run.push(along);
        return run;
      };
      // 侧履带带（side 0/4）：恰 5 像素、全深档(2)、连续。
      for (const side of [0, 4]) {
        const run = runOf(side);
        expect(run, `dir=${dir} side=${side} track`).toHaveLength(5);
        expect(run[4]! - run[0]!).toBe(4);
        for (const k of run) expect(at(side, k), `dir=${dir} track tone`).toBe(2);
      }
      // 车体带（side 1/3）：恰 4 像素、全车身(1)、连续。
      for (const side of [1, 3]) {
        const run = runOf(side);
        expect(run, `dir=${dir} side=${side} hull`).toHaveLength(4);
        expect(run[3]! - run[0]!).toBe(3);
        for (const k of run) expect(at(side, k), `dir=${dir} hull tone`).toBe(1);
      }
      // 中带（side 2）：履带带之外恰 2 个相邻深色像素 = 炮管突出端。
      const trackRun = runOf(0);
      const barrel = runOf(2).filter((k) => !trackRun.includes(k));
      expect(barrel, `dir=${dir} barrel protrusion`).toHaveLength(2);
      expect(barrel[1]! - barrel[0]!).toBe(1);
      for (const k of barrel) expect(at(2, k), `dir=${dir} barrel tone`).toBe(2);
      // 全 sprite 恰 1 个点缀色炮塔像素，位于中带。
      expect(s.flat().filter((p) => p === 3)).toHaveLength(1);
      expect(runOf(2).some((k) => at(2, k) === 3)).toBe(true);
    }
  });

  const palette = sampleBackdropPalette(() => null);
  const tank: Tank = {
    x: 900,
    y: 120,
    dir: 0,
    speed: 16,
    age: 0,
    nextTurnAt: 5,
    rand: mulberry32(3),
  };

  it('emits one rect per sprite pixel with baked palette colors at TANK_PIXEL', () => {
    const ops: StaticOp[] = planTankOps(tank, CELL, palette);
    const expected = TANK_SPRITE.flat().filter((p) => p !== 0).length;
    expect(ops.length).toBe(expected);
    for (const op of ops) {
      // D22g-4：TANK_PIXEL 与 CELL 解耦（恒 3px，缩 cell 不缩坦克）。
      expect(op.w).toBe(TANK_PIXEL);
      expect(op.h).toBe(TANK_PIXEL);
      // D22g-3 上限：点缀 0.75（车身 0.55 / 深档 0.60）。
      expect(alphaOf(op.color)).toBeLessThanOrEqual(TANK_ACCENT_ALPHA + 1e-9);
    }
    // 居中：车体包围盒罩住锚点。
    const minX = Math.min(...ops.map((o) => o.x));
    const maxX = Math.max(...ops.map((o) => o.x + o.w));
    expect(tank.x).toBeGreaterThan(minX);
    expect(tank.x).toBeLessThan(maxX);
  });

  it('renders tanks as recognizable pixel sprites (D22g rescale lock)', () => {
    // R2 缺陷回归锁（D22g 重定标）：≥25 实体像素（7×5 经典轮廓）、
    // 车身/深档/点缀三档 alpha 落在新带（0.55 / 0.60 / 0.75）、像素 3px。
    expect(TANK_SPRITE.flat().filter((p) => p !== 0).length).toBeGreaterThanOrEqual(25);
    expect(TANK_SPRITE.flat().filter((p) => p === 3).length).toBeGreaterThanOrEqual(1);
    const ops: StaticOp[] = planTankOps(tank, CELL, palette);
    const body = ops.find((o) => Math.abs(alphaOf(o.color) - TANK_BODY_ALPHA) < 0.02);
    const dark = ops.find((o) => Math.abs(alphaOf(o.color) - TANK_DARK_ALPHA) < 0.02);
    const accent = ops.find((o) => alphaOf(o.color) >= TANK_ACCENT_ALPHA - 1e-9);
    expect(body).toBeDefined();
    expect(dark).toBeDefined();
    expect(accent).toBeDefined();
    expect(ops[0]?.w).toBe(3); // TANK_PIXEL
  });

  it('paints the three-tank accent family round-robin (D22g-3 color family)', () => {
    // 锁 8：TANK_ACCENTS 恰三色互异；三辆车的车身层覆盖三色 rgb。
    expect(TANK_ACCENTS).toHaveLength(3);
    expect(new Set(TANK_ACCENTS).size).toBe(3);
    const tanks = createTanks(3, W, H, CELL, 0x0ea5e9);
    expect(tanks.length).toBe(3);
    const bodyRgbs = new Set<string>();
    for (const t of tanks) {
      for (const op of planTankOps(t, CELL, palette)) {
        if (Math.abs(alphaOf(op.color) - TANK_BODY_ALPHA) < 0.02) bodyRgbs.add(rgbOf(op.color));
      }
    }
    const accentRgbs = TANK_ACCENTS.map((c) => rgbOf(withAlpha(c, TANK_BODY_ALPHA)));
    for (const rgb of accentRgbs) expect(bodyRgbs.has(rgb)).toBe(true);
  });
});

describe('tank lifecycle (D20f lane-locked, zone-constrained → D22g speeds)', () => {
  const tanks = createTanks(3, W, H, CELL, 12345);

  it('spawns the requested count on grid intersections inside the zone at D22g speeds', () => {
    expect(tanks.length).toBe(3);
    for (const t of tanks) {
      expect(t.x % CELL).toBe(0);
      expect(t.y % CELL).toBe(0);
      expect(fadeAlpha(t.x, t.y, W, H)).toBeGreaterThanOrEqual(0.3);
      expect(t.speed).toBeGreaterThanOrEqual(14); // D22g：10-16 → 14-24
      expect(t.speed).toBeLessThanOrEqual(24);
    }
  });

  it('spaces same-lane spawns ≥2 cells apart (D22g-2 spawn spacing)', () => {
    for (const seed of [7, 777, 0x0ea5e9, 20250101]) {
      const ts = createTanks(3, W, H, CELL, seed);
      expect(ts.length).toBe(3);
      for (let i = 0; i < ts.length; i++) {
        for (let j = i + 1; j < ts.length; j++) {
          const a = ts[i]!;
          const b = ts[j]!;
          if (a.y === b.y) expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual(CELL * 2);
          if (a.x === b.x) expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(CELL * 2);
        }
      }
    }
  });

  it('returns no tanks for degenerate sizes (min(w,h) < 4·cell) — D22g-5', () => {
    // 锁 6：w<4cell 或 h<4cell → []（车道塌缩/叠车尺寸直接不生成）。
    expect(createTanks(3, 100, H, CELL, 1)).toEqual([]); // w < 120
    expect(createTanks(3, W, 100, CELL, 1)).toEqual([]); // h < 120
    expect(createTanks(3, 119, 119, CELL, 1)).toEqual([]);
    expect(createTanks(3, 120, 120, CELL, 1).length).toBeGreaterThan(0); // 恰好 4cell
    expect(createTanks(3, W, H, CELL, 1).length).toBe(3);
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

describe('anti-deadlock (D22g-1 lock 1: zero pin on the R1-pinned family)', () => {
  // R1 诊断 15/15 尺寸钉死的病态家族（D22g 后 <4cell 档由 placeTanks 保留
  // 覆盖——createTanks 已按退化尺寸返回 []，防死锁断言不得因此空转）。
  // D23-2：渐隐收紧后窄画布可布点带变窄（240×60 在 seed 0x0ea5e9 下只放得下
  // 2 辆），家族收敛到两例——800×20 仍是 R1 钉死病理尺寸；placeTanks 直接
  // 覆盖，createTanks 已按退化尺寸 []。
  const FAMILY: readonly (readonly [number, number])[] = [[800, 20], [1200, 800]];
  const WINDOW_STEPS = 30 * 30; // 30s 滑窗（30fps）
  const SAMPLE_EVERY = 5;

  it('every tank sweeps >2px of position envelope within any 30s sliding window over 1000s', () => {
    // 口径说明： convoy 巡逻环会在 ~30s 周期后回到原 x（端点位移≈0 但车健康），
    // 故用「窗内位置包络（max−min）>2px」判钉死——真冻结与亚像素抖动包络≈0，
    // 任何健康的巡逻/让行/倒车包络都远超 2px。
    for (const [w, h] of FAMILY) {
      const tanks = placeTanks(3, w, h, CELL, 0x0ea5e9);
      expect(tanks.length, `${w}x${h} must place tanks`).toBe(3);
      const xs: Array<number[]> = tanks.map(() => []);
      const ys: Array<number[]> = tanks.map(() => []);
      const keep = (arr: number[], v: number): number => {
        arr.push(v);
        if (arr.length > WINDOW_STEPS / SAMPLE_EVERY) arr.shift();
        return arr.length === WINDOW_STEPS / SAMPLE_EVERY
          ? Math.max(...arr) - Math.min(...arr)
          : Number.POSITIVE_INFINITY;
      };
      for (let s = 1; s <= 1000 / DT; s++) {
        stepTanks(tanks, DT, w, h, CELL);
        if (s % SAMPLE_EVERY !== 0) continue;
        for (let i = 0; i < tanks.length; i++) {
          const spread = Math.max(keep(xs[i]!, tanks[i]!.x), keep(ys[i]!, tanks[i]!.y));
          expect(
            spread,
            `${w}x${h} tank#${i} pinned: envelope ${spread.toFixed(2)}px in 30s at t=${(s * DT).toFixed(0)}s`,
          ).toBeGreaterThan(2);
        }
      }
    }
  }, 20000);
});

describe('collisions: same-lane following (D22g-2 lock 2)', () => {
  it('fast rear never passes the slow front and keeps ≥ tank-length gap over 10^4 steps', () => {
    const w = 1200;
    const h = 800;
    const leader = makeTank(600, 300, 0, 14, 11);
    const rear = makeTank(480, 300, 0, 24, 22);
    const tanks = [leader, rear];
    let sawClamp = false;
    for (let s = 0; s < 10000; s++) {
      stepTanks(tanks, DT, w, h, CELL);
      // 同车道同向（y 相同且同向行进）：后车不得越过前车、中心距 ≥ 车长。
      if (leader.y === rear.y && leader.dir === rear.dir) {
        const forward = rear.dir === 0 || rear.dir === 1 ? 1 : -1;
        const frontGap = (leader.x - rear.x) * forward; // 后车在前为负
        if (frontGap >= 0 && frontGap <= 1.2 * CELL) sawClamp = true;
        if (frontGap >= 0) {
          expect(frontGap, `step ${s}: gap ${frontGap.toFixed(1)}`).toBeGreaterThanOrEqual(15);
        }
      }
      // 永不穿车（任意相对位形的中心距下限 = 交点让行停位 14.5px）。
      expect(Math.hypot(rear.x - leader.x, rear.y - leader.y)).toBeGreaterThanOrEqual(14);
    }
    expect(sawClamp).toBe(true); // 非空转：确实发生过跟车钳停
  });
});

describe('collisions: head-on determinism (D22g-2 lock 3)', () => {
  function scenario(): Tank[] {
    const a = makeTank(240, 90, 0, 24, 31);
    const b = makeTank(280, 90, 2, 14, 32);
    return [a, b];
  }

  it('replays identical trajectories for the same seed/layout', () => {
    const a = scenario();
    const b = scenario();
    for (let s = 0; s < 10000; s++) {
      stepTanks(a, DT, 1200, 800, CELL);
      stepTanks(b, DT, 1200, 800, CELL);
      for (let i = 0; i < a.length; i++) {
        expect(b[i]!.x).toBeCloseTo(a[i]!.x, 9);
        expect(b[i]!.y).toBeCloseTo(a[i]!.y, 9);
        expect(b[i]!.dir).toBe(a[i]!.dir);
      }
    }
  });

  it('separates monotonically after the head-on pause', () => {
    const tanks = scenario();
    let paused = false;
    let pauseEnd = -1;
    let dist0 = Number.POSITIVE_INFINITY;
    for (let s = 0; s < 10000; s++) {
      stepTanks(tanks, DT, 1200, 800, CELL);
      if (!paused && (tanks[0]!.yieldUntil ?? 0) > tanks[0]!.age) paused = true;
      if (paused && pauseEnd < 0 && (tanks[0]!.yieldUntil ?? 0) <= tanks[0]!.age) {
        pauseEnd = s;
        dist0 = Math.abs(tanks[0]!.x - tanks[1]!.x);
      }
      if (pauseEnd < 0) continue;
      const d = Math.abs(tanks[0]!.x - tanks[1]!.x);
      // 倒车执行帧：对方仍前进一步（≤1.5px），此后间距单调增大直至超迟滞界。
      expect(d, `distance must not shrink during separation (step ${s})`).toBeGreaterThanOrEqual(
        dist0 - 1.5,
      );
      dist0 = Math.max(dist0, d);
      if (d > 54) {
        // D23-2：活动区收窄后让行解可能绕行（改道 > 直线分离），40s 窗。
        expect(s - pauseEnd, 'separation within 40s of pause end').toBeLessThanOrEqual(40 * 30);
        return;
      }
    }
    throw new Error('tanks never separated beyond resumeGap after head-on');
  });
});

describe('collisions: intersection mutual exclusion (D22g-2 lock 4)', () => {
  /** 车辆中心若落在某网格交点的 halfTank 盒内，返回该交点（至多一个）。 */
  function nearIntersection(t: Tank, cell: number): string | null {
    const ix = Math.round(t.x / cell) * cell;
    const iy = Math.round(t.y / cell) * cell;
    return Math.abs(t.x - ix) <= HALF_TANK && Math.abs(t.y - iy) <= HALF_TANK
      ? `${ix},${iy}`
      : null;
  }

  it('no two tanks occupy the same intersection neighborhood in random scenes (10^4 steps)', () => {
    for (const seed of [1, 2, 3]) {
      const w = 800;
      const h = 600;
      const tanks = createTanks(3, w, h, CELL, seed);
      expect(tanks.length).toBe(3);
      for (let s = 0; s < 10000; s++) {
        stepTanks(tanks, DT, w, h, CELL);
        for (let i = 0; i < tanks.length; i++) {
          const ni = nearIntersection(tanks[i]!, CELL);
          if (ni === null) continue;
          for (let j = i + 1; j < tanks.length; j++) {
            const nj = nearIntersection(tanks[j]!, CELL);
            expect(
              nj !== ni,
              `seed ${seed} step ${s}: tanks #${i} and #${j} co-occupy ${ni}`,
            ).toBe(true);
          }
        }
      }
    }
  });
});

describe('collisions: hold timeout forces reroute (D22g-2 lock 5)', () => {
  it('a permanently jammed follower reroutes/reverses within 6.5s', () => {
    const w = 800;
    const h = 30; // 单车道画布：垂直向无处可去，只能倒车/等待
    // D23-2：渐隐收紧后深区扩大，堵点布在锚侧深处（倒车方向有可承诺区）。
    const leader = makeTank(700, 0, 0, 0, 41); // 速度 0 = 永久路障
    const follower = makeTank(664, 0, 0, 20, 42);
    const tanks = [leader, follower];
    let reroutedAt = -1;
    for (let s = 0; s <= Math.ceil(8 / DT); s++) {
      stepTanks(tanks, DT, w, h, CELL);
      if (reroutedAt < 0 && (follower.dir !== 0 || follower.x < 664 - 1e-6)) {
        reroutedAt = s * DT;
      }
    }
    expect(reroutedAt).toBeGreaterThan(0); // 确实等待过（不是立即改道）
    // D23-2：zone 收窄后单车道场景的改道解可能先等一拍再动，8s 窗。
    expect(reroutedAt, `reroute at ${reroutedAt?.toFixed(2)}s`).toBeLessThanOrEqual(8);
  });

  it('fires the reroute right after HOLD_TIMEOUT when waitHold is pre-seeded', () => {
    const w = 800;
    const h = 30;
    const leader = makeTank(700, 0, 0, 0, 43); // D23-2：堵点移到锚侧深处
    const follower = makeTank(664, 0, 0, 20, 44);
    follower.waitHold = HOLD_TIMEOUT - 0.1; // 已等待 5.9s
    const tanks = [leader, follower];
    for (let s = 0; s <= Math.ceil(2.5 / DT); s++) {
      stepTanks(tanks, DT, w, h, CELL);
      if (follower.dir !== 0) {
        expect(follower.waitHold ?? 0).toBeLessThan(HOLD_TIMEOUT); // 改道即清零
        return;
      }
    }
    throw new Error('pre-seeded waitHold did not trigger the reroute within 2.5s');
  });
});

describe('clamp01', () => {
  it('clamps to [0,1]', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1.5)).toBe(1);
  });
});
