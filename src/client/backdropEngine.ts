/**
 * 背景板引擎（docs/24-panel-tw-official-v3.md S24-3 / D22g）：面板背景
 * 「右上角格子 + 高地图 → 左下角渐隐 + 微型彩色像素坦克」的全部**纯计算**。
 *
 * 为什么独立成纯模块（D20d）：vitest 是 node 环境无 DOM（21.2.4），canvas/
 * rAF 都不可测——本模块零 DOM 依赖、零副作用、全部确定性（显式 seed），把
 * 「高度场、渐隐、坦克步进/碰撞仲裁、调色板采样、静层绘制指令」做成可单测
 * 的纯函数；`eteamsBackdrop.tsx` 只做 canvas/DPR/rAF/可见性/降运动的薄接线。
 *
 * R3（D22g）四条主线：
 * 1. **防死锁**（诊断 24.1.3-R1，15/15 尺寸实证）：zone 检查从「每帧按当前
 *    位置 + snap 回拉」改「**仅在交点处按目的地交点校验**」——坦克只承诺
 *    「目的地在界内且在活动区」的移动，途中不再回拉，等值线相位不再能钉死；
 *    redirect 探针从「+30px 点」改为「沿候选方向的下一个交点」（必然可达），
 *    四候选全出区时朝锚点轴逐交点回退（fade 沿 +x/−y 单调，必收敛）。
 * 2. **碰撞**（stepTanks）：车道占用仲裁——同车道跟车钳停/迟滞恢复/超时改道、
 *    对头双停后可倒者倒车、交点 ETA 冲突让行 + 占位互斥环。全部确定性。
 * 3. **彩色化 + 重定标**：三色族 accents、alpha 三档重定标、FADE 0.12/0.55、
 *    TANK_PIXEL 与 CELL 解耦、高地图 3 档量化带。
 * 4. **静层指令合并**：网格按线合并、地形按行（再按列）合并、α<0.01 跳过
 *    （诊断 simE：10166 条 @1920×1080/c24 → 预算 ≤400）。
 *
 * R6（docs/25 25.5，D24-1）：鼠标「外扩双环波纹」下架（用户反馈观感差），
 * 改「**格子微光**」热场——指针扫过时格子**本身**微亮再退热（splat/decay/
 * plan 三纯函数，无新增图形元素）。
 *
 * @module dsh-eteams/client/backdropEngine
 */

/** 2D 向量/点（逻辑像素坐标，CSS px）。 */
export interface Vec2 {
  x: number;
  y: number;
}

/** 坦克朝向：0=+x（右）1=+y（下）2=-x（左）3=-y（上）。 */
export type Dir = 0 | 1 | 2 | 3;

/** 方向 → 单位向量。 */
export const DIR_VECTORS: readonly Vec2[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
];

/* —— 渐隐（D20g → D22g 重定标）—— */

/**
 * 渐隐起点：距右上角 d ≤ 0.10 全实（D23-2：0.12→0.10）。
 * 导出供测试/仿真按新参数重算断言值。
 */
export const FADE_NEAR = 0.1;
/** 渐隐终点：d ≥ 0.40 完全透明（D23-2：0.55→0.40——可见区 ≈ FAR²=16%，
 * 「有东西」严格压回页面右上角；D22g 的 0.55 用户仍嫌摊得开）。 */
export const FADE_FAR = 0.4;

/** clamp 到 [0,1]。 */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 平滑阶梯（Hermite）：edge0→edge1 之间 0→1 平滑过渡，版面无硬边。 */
export function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp01((v - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * 右上→左下渐隐系数（D20g）：`d = ((W−x) + y) / (W+H)`——d=0 在右上角、
 * 1 在左下角；alpha = 1 − smoothstep(0.12, 0.55, d)。网格/高地图/坦克统一
 * 乘该系数，保证整张背景板只有右上角「有东西」。
 */
export function fadeAlpha(x: number, y: number, w: number, h: number): number {
  const d = (w - x + y) / (w + h);
  return 1 - smoothstep(FADE_NEAR, FADE_FAR, d);
}

/* —— 确定性随机 —— */

/**
 * mulberry32 PRNG（avatar.tsx 同款结论）：32bit 种子 → [0,1) 确定性序列。
 * 引擎全部随机性都出自显式 seed 的本函数，重放即复现（测试依据）。
 */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* —— 高度场（高地图）—— */

/**
 * 确定性值噪声高度场：格点格值（mulberry32）+ 双线性插值 + 两个倍频程
 * （基频 + 半幅两倍频），输出 [0,1] 的平滑高度，格点对齐 draw 网格。
 *
 * 返回长度 cols*rows 的行主序数组；(cols,rows) 是**格点数**（含边界），
 * 绘制时每格 (cx,cy) 取其左上格点值。
 */
export function createHeightField(cols: number, rows: number, seed: number): Float32Array {
  const out = new Float32Array(cols * rows);
  const rand = mulberry32(seed);
  // 基频晶格（stride 4）+ 细节晶格（stride 2，半幅）——直接在输出分辨率上
  // 以「每 stride 一个随机格点、其余双线性」实现，省一次中间数组。
  const base = new Float32Array(cols * rows);
  const detail = new Float32Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      base[cy * cols + cx] = cy % 4 === 0 && cx % 4 === 0 ? rand() : 0;
      detail[cy * cols + cx] = cy % 2 === 0 && cx % 2 === 0 ? rand() : 0;
    }
  }
  const sample = (lattice: Float32Array, stride: number, cx: number, cy: number): number => {
    const x0 = Math.floor(cx / stride) * stride;
    const y0 = Math.floor(cy / stride) * stride;
    const x1 = Math.min(x0 + stride, cols - 1);
    const y1 = Math.min(y0 + stride, rows - 1);
    const tx = stride === 0 ? 0 : (cx - x0) / stride;
    const ty = stride === 0 ? 0 : (cy - y0) / stride;
    const v00 = lattice[y0 * cols + x0] ?? 0;
    const v01 = lattice[y0 * cols + x1] ?? 0;
    const v10 = lattice[y1 * cols + x0] ?? 0;
    const v11 = lattice[y1 * cols + x1] ?? 0;
    const top = v00 * (1 - tx) + v01 * tx;
    const bottom = v10 * (1 - tx) + v11 * tx;
    return top * (1 - ty) + bottom * ty;
  };
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const b = sample(base, 4, cx, cy);
      const d = sample(detail, 2, cx, cy);
      out[cy * cols + cx] = clamp01(b * 0.7 + d * 0.3);
    }
  }
  return out;
}

/* —— 调色板（D20h 采样 / D21g 定标 / D22g 换自有 token 源）—— */

/**
 * 背景板绘制基底色（**实色，不带 alpha**——D21g：alpha 一律在使用位按
 * 元素语义单次烘焙为最终有效值）。
 */
export interface BackdropPalette {
  /** 中性基底（实色）：网格线 / 高地图低两档 / 坦克履带炮管（亮暗自适应）。 */
  label: string;
  /** 品牌点缀基底（实色）：高地图峰顶 / 坦克 accent 缺省（亮暗自适应）。 */
  brand: string;
  /** 画布级合成透明度（D21g：恒 1.0——有效 alpha 已在指令级单次烘焙）。 */
  compositeAlpha: number;
}

/**
 * 画布级合成透明度（D21g：1.0）。D20e 原值 0.5 的「全局减半」与 palette
 * 预烘焙叠乘后所有元素有效值折半再折半——R2 用户验收后废除。
 */
export const COMPOSITE_ALPHA_CAP = 1;

/* D23-3 水印化定标（= 指令烘焙出的最终屏上值；均远低于正文对比度）：
 * 网格 0.05（D22g 0.07→0.05，「水印」观感）；高地图 3 档量化带 0.03 / 0.06 /
 * 峰顶 accent 0.10×peak（量化是行/列合并的前提——相邻格同带率大增）；
 * 坦克三档 0.55 / 0.60 / 0.75（D22g 不变——坦克引擎保留待回归，D23-4）。 */
export const GRID_LINE_ALPHA = 0.05;
/** 高地图低档量化带（height < 0.5）。 */
export const TERRAIN_LOW_ALPHA = 0.03;
/** 高地图中档量化带（0.5 ≤ height < 0.8）。 */
export const TERRAIN_MID_ALPHA = 0.06;
/** 高地图峰顶带系数（height ≥ 0.8：α = 0.10 × peak 内插，peak∈[0,1]）。 */
export const TERRAIN_PEAK_ALPHA = 0.1;
/** 高地图中档阈值（height ≥ 此值进中档带）。 */
export const TERRAIN_MID_THRESHOLD = 0.5;
export const TANK_BODY_ALPHA = 0.55;
export const TANK_DARK_ALPHA = 0.6;
export const TANK_ACCENT_ALPHA = 0.75;

/**
 * 彩色坦克三色族（D22g，诊断 simC 定标）：amber/rose/emerald-500——与
 * slate/sky 的 hue 间距最大化（amber≈38 / rose≈350 / emerald≈160 vs
 * sky≈199），createTanks 按 index 轮询分配。
 */
export const TANK_ACCENTS: readonly string[] = ['#f59e0b', '#f43f5e', '#10b981'];

/**
 * 坦克像素尺寸（D22g）：3px/像素，**与 CELL 解耦**——cell=24 时 cell/10≈2
 * 会把坦克缩成 14×10（诊断 simD），故改为常量；sprite 不变（7×5 → 21×15px）。
 */
export const TANK_PIXEL = 3;

/**
 * 给完整色值叠 alpha：`#rrggbb` → `rgba(r,g,b,a)`；`rgba(r,g,b,a)` → alpha
 * 相乘（宿主变量可能是半透明档，取更透明者）；其余原样返回（不猜格式）。
 * D19c 的「token 色禁 /alpha」是 CSS 修饰禁令；这里是字符串层面的预烘焙，
 * 语义一致（需要半透明就产出专色，不依赖 /alpha 修饰）。
 */
export function withAlpha(color: string, alpha: number): string {
  const a = clamp01(alpha);
  const hex = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (hex !== null) {
    const n = Number.parseInt(hex[1] ?? '000000', 16);
    const r = (n >> 16) & 0xff;
    const g = (n >> 8) & 0xff;
    const b = n & 0xff;
    return `rgba(${r},${g},${b},${round3(a)})`;
  }
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(color);
  if (rgba !== null) {
    const parts = (rgba[1] ?? '').split(',').map((p) => Number.parseFloat(p.trim()));
    if (parts.length >= 3 && parts.every((p) => Number.isFinite(p))) {
      const r = parts[0] ?? 0;
      const g = parts[1] ?? 0;
      const b = parts[2] ?? 0;
      const base = parts.length >= 4 ? (parts[3] ?? 1) : 1;
      return `rgba(${r},${g},${b},${round3(a * base)})`;
    }
  }
  return color;
}

/** 三位小数舍入（rgba 字符串稳定输出，测试可比对）。 */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** 从宿主变量名读色的采样键。D22g：改自有 token `--eteams-backdrop-*`
 * （另一 agent 在 eteams.css 定义：亮 #475569/#0ea5e9、暗 #94a3b8/#38bdf8），
 * 字面兜底同名值（slate-600 / sky-500）。 */
export interface PaletteVarNames {
  /** 主文字色（网格/阴影基底，亮暗自适应）。 */
  readonly label: string;
  /** 品牌点缀色（sky：峰顶 / 坦克缺省点缀，亮暗自适应）。 */
  readonly brand: string;
}

export const DEFAULT_PALETTE_VARS: PaletteVarNames = {
  label: '--eteams-backdrop-label',
  brand: '--eteams-backdrop-accent',
};

/** 采样调色板（D20h；D22g 换源）：`read(name)` 由组件提供（getComputedStyle
 * 包一层），返回 null/undefined/空串即用字面兜底（slate-600 / sky-500）。
 * 本函数纯：同一组输入色产出同一调色板，测试直接喂假 read。基底一律实色
 * （alpha 在使用位单次烘焙）。 */
export function sampleBackdropPalette(read: (name: string) => string | null): BackdropPalette {
  const label = read(DEFAULT_PALETTE_VARS.label)?.trim() || '#475569';
  const brand = read(DEFAULT_PALETTE_VARS.brand)?.trim() || '#0ea5e9';
  return { label, brand, compositeAlpha: COMPOSITE_ALPHA_CAP };
}

/* —— 静层绘制指令（网格 + 高地图，D22g 合并版）—— */

/** 矩形填充指令（坐标逻辑 px；color 已带 alpha）。R6 起 kind:'ring' 不再产出。 */
export interface StaticOp {
  kind: 'rect' | 'ring';
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

/** 高地图峰顶阈值：height ≥ 0.8 进 accent 峰顶带（0.13 × peak 内插）。 */
const PEAK_THRESHOLD = 0.8;

/** 指令合并参数（D22g，诊断 simE）：相邻段 α 差 ≤ 此值合并为一条 rect；
 * 最终有效 α < MIN_OP_ALPHA 的指令直接跳过。 */
const MERGE_ALPHA_TOL = 0.015;
const MIN_OP_ALPHA = 0.01;

/** 高地图格子着色：返回 [基底色, 原始 α 系数]（×fade 后即最终有效值）。 */
function terrainShade(height: number, palette: BackdropPalette): [string, number] {
  if (height >= PEAK_THRESHOLD) {
    const peak = (height - PEAK_THRESHOLD) / (1 - PEAK_THRESHOLD);
    return [palette.brand, TERRAIN_PEAK_ALPHA * peak];
  }
  if (height >= TERRAIN_MID_THRESHOLD) return [palette.label, TERRAIN_MID_ALPHA];
  return [palette.label, TERRAIN_LOW_ALPHA];
}

/** 合并中的段：基底色 + α 累加（均值 = Σα/格数，墨量 Σα·面积 守恒）。 */
interface RunAcc {
  base: string;
  x: number;
  y: number;
  w: number;
  h: number;
  sum: number;
  count: number;
  last: number;
}

/**
 * 规划静层（网格线 + 高地图着色），按「地形先、网格后」排序。纯函数。
 *
 * D22g 指令合并（诊断 simE：1920×1080/c24 逐格 10166 条 → 预算 ≤400）：
 * - 地形：同**行**内相邻格（同基底、α 差 ≤0.015）合并为一条 rect，再做一次
 *   同列纵向合并（量化带使相邻格同 α 率大增）；
 * - 网格：同**列/行**的连续段（α 差 ≤0.015）合并为一条 rect（每条格线通常
 *   1 条指令）；
 * - 最终有效 α < 0.01 的指令直接跳过（渐隐尽头的格子零指令）。
 * 合并用段均值上色（Σα·面积 守恒，渐隐外形不变），坐标仍逻辑 px。
 */
export function planStaticLayer(
  w: number,
  h: number,
  cell: number,
  palette: BackdropPalette,
  heights: Float32Array,
): StaticOp[] {
  const ops: StaticOp[] = [];
  const cols = Math.max(1, Math.ceil(w / cell));
  const rows = Math.max(1, Math.ceil(h / cell));
  const flush = (run: RunAcc | null): void => {
    if (run === null) return;
    const a = (run.sum / run.count) * 1;
    if (a < MIN_OP_ALPHA) return;
    ops.push({
      kind: 'rect',
      x: run.x,
      y: run.y,
      w: run.w,
      h: run.h,
      color: withAlpha(run.base, a),
    });
  };

  // —— 地形：按行合并，再按列纵向合并 ——
  const terrain: RunAcc[] = [];
  const flushT = (run: RunAcc | null): void => {
    if (run === null) return;
    const a = run.sum / run.count;
    if (a < MIN_OP_ALPHA) return;
    terrain.push(run);
  };
  for (let cy = 0; cy < rows; cy++) {
    const y = cy * cell;
    const ch = Math.min(cell, h - y);
    let run: RunAcc | null = null;
    for (let cx = 0; cx < cols; cx++) {
      const height = heights[cy * cols + cx] ?? 0;
      const x = cx * cell;
      const cw = Math.min(cell, w - x);
      const fade = fadeAlpha(x + cw / 2, y + ch / 2, w, h);
      const [base, coef] = terrainShade(height, palette);
      const a = coef * fade;
      if (a < MIN_OP_ALPHA) {
        flushT(run);
        run = null;
        continue;
      }
      if (
        run !== null &&
        run.base === base &&
        Math.abs(a - run.last) <= MERGE_ALPHA_TOL
      ) {
        run.w += cw;
        run.sum += a;
        run.count += 1;
        run.last = a;
      } else {
        flushT(run);
        run = { base, x, y, w: cw, h: ch, sum: a, count: 1, last: a };
      }
    }
    flushT(run);
  }
  // 纵向合并：同列同宽同基底、纵向相邻、α 差 ≤ 容差 → 面积加权均值。
  const byCol = new Map<string, RunAcc[]>();
  for (const r of terrain) {
    const key = `${r.x}|${r.w}|${r.base}`;
    const list = byCol.get(key);
    if (list === undefined) byCol.set(key, [r]);
    else list.push(r);
  }
  for (const list of byCol.values()) {
    list.sort((a, b) => a.y - b.y);
    let run: RunAcc | null = null;
    for (const seg of list) {
      const a = seg.sum / seg.count;
      if (run !== null && run.y + run.h === seg.y && Math.abs(a - run.last) <= MERGE_ALPHA_TOL) {
        run.h += seg.h;
        run.sum += seg.sum;
        run.count += seg.count;
        run.last = a;
      } else {
        flush(run);
        run = { ...seg };
      }
    }
    flush(run);
  }

  // —— 网格线：竖线按列合并、横线按行合并（每条格线通常 1 条指令）。 ——
  for (let cx = 0; cx <= cols; cx++) {
    const x = Math.min(cx * cell, w - 1);
    let run: RunAcc | null = null;
    for (let cy = 0; cy < rows; cy++) {
      const y = cy * cell;
      const segH = Math.min(cell, h - y);
      const a = GRID_LINE_ALPHA * fadeAlpha(x, y + cell / 2, w, h);
      if (a < MIN_OP_ALPHA) {
        flush(run);
        run = null;
        continue;
      }
      if (run !== null && run.y + run.h === y && Math.abs(a - run.last) <= MERGE_ALPHA_TOL) {
        run.h += segH;
        run.sum += a;
        run.count += 1;
        run.last = a;
      } else {
        flush(run);
        run = { base: palette.label, x, y, w: 1, h: segH, sum: a, count: 1, last: a };
      }
    }
    flush(run);
  }
  for (let cy = 0; cy <= rows; cy++) {
    const y = Math.min(cy * cell, h - 1);
    let run: RunAcc | null = null;
    for (let cx = 0; cx < cols; cx++) {
      const x = cx * cell;
      const segW = Math.min(cell, w - x);
      const a = GRID_LINE_ALPHA * fadeAlpha(x + cell / 2, y, w, h);
      if (a < MIN_OP_ALPHA) {
        flush(run);
        run = null;
        continue;
      }
      if (run !== null && run.x + run.w === x && Math.abs(a - run.last) <= MERGE_ALPHA_TOL) {
        run.w += segW;
        run.sum += a;
        run.count += 1;
        run.last = a;
      } else {
        flush(run);
        run = { base: palette.label, x, y, w: segW, h: 1, sum: a, count: 1, last: a };
      }
    }
    flush(run);
  }
  return ops;
}

/* —— 鼠标格子微光（docs/25 25.5 D24-1，取代外扩双环波纹）—— */

/**
 * 用户反馈（25.5）：外扩环波纹「太差」。新方案不创建任何新图形——指针扫过
 * 时让**格子本身**微亮，随后慢慢退回原色。引擎侧三件套（全部纯函数）：
 *
 * - `splatHeat`：落点写入热场（指针所在格 + 邻格随距离衰减）；
 * - `decayHeat`：每帧全场指数退热（e 指数，与帧率无关）；
 * - `planHeatOps`：热场 → 叠加填充指令（只输出有热的格子）。
 *
 * 热场是 `Map<cellKey, heat>`，只持有被扫过的格子（面板其余部分零状态），
 * 每帧从 Map 清零项删除——长面板扫一圈也不会积累状态。
 */

/** 单格微光峰值 α（heat=1 时叠加的 alpha；远低于坦克 0.55，水印级之上）。 */
export const HEAT_PEAK_ALPHA = 0.14;
/** 邻格衰减系数：距落点 d 格的热量 = dist^(-d)（d=0 → 1，d=1 → 1/2，…）。 */
export const HEAT_NEIGHBOR_FALLOFF = 0.5;
/** 单帧退热时间常数（秒）：heat *= exp(-dt / TAU)——0.35s 后剩 ~e^-1。 */
export const HEAT_DECAY_TAU = 0.35;
/** 热量低于此值视为熄灭（Map 删除 + 指令跳过）。 */
export const HEAT_OFF_THRESHOLD = 0.012;
/** 单次 splat 半径（格）：十字 4 邻 + 本格（不斜向扩散，痕迹更「格子」）。 */
export const HEAT_SPLAT_RADIUS = 1;

/** 一次指针落点的格子微光记录：指针逻辑 px 坐标与时刻（performance.now 口径）。 */
export interface Ripple {
  x: number;
  y: number;
  /** 出生时刻（performance.now()，ms）。 */
  born: number;
}

/**
 * 热场：cellKey「cx,cy」→ heat ∈ (0,1]。宿主（组件/预览页）持有并跨帧
 * 传递；引擎只做纯变换。
 */
export type HeatField = Map<string, number>;

/** 格坐标 → 热场键。 */
export function heatKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

/**
 * 把一次指针落点写入热场（**纯**——返回新 Map，不改输入）。
 * 指针所在格 (cx,cy) 热量 = 1，正交邻格按 HEAT_NEIGHBOR_FALLOFF^d 递减；
 * 已有热量的格子取 max（连续扫过只增不跳变）。出界格子不写入。
 */
export function splatHeat(
  field: HeatField,
  x: number,
  y: number,
  cell: number,
  w: number,
  h: number,
): HeatField {
  const cols = Math.max(1, Math.ceil(w / cell));
  const rows = Math.max(1, Math.ceil(h / cell));
  const cx = Math.floor(x / cell);
  const cy = Math.floor(y / cell);
  if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return field;
  const next = new Map(field);
  const spots: readonly (readonly [number, number, number])[] = [
    [cx, cy, 1],
    [cx - 1, cy, HEAT_NEIGHBOR_FALLOFF],
    [cx + 1, cy, HEAT_NEIGHBOR_FALLOFF],
    [cx, cy - 1, HEAT_NEIGHBOR_FALLOFF],
    [cx, cy + 1, HEAT_NEIGHBOR_FALLOFF],
  ];
  for (const [sx, sy, heat] of spots) {
    if (sx < 0 || sy < 0 || sx >= cols || sy >= rows) continue;
    const key = heatKey(sx, sy);
    next.set(key, Math.max(next.get(key) ?? 0, heat));
  }
  return next;
}

/**
 * 全场退热一帧（**纯**）：heat = heat × e^(−dt/TAU)，低于熄灭阈值的格子
 * 从 Map 删除。dt ≤ 0 时原样返回。
 */
export function decayHeat(field: HeatField, dt: number): HeatField {
  if (dt <= 0) return field;
  const factor = Math.exp(-dt / HEAT_DECAY_TAU);
  const next = new Map<string, number>();
  for (const [key, heat] of field) {
    const decayed = heat * factor;
    if (decayed >= HEAT_OFF_THRESHOLD) next.set(key, decayed);
  }
  return next;
}

/**
 * 热场 → 叠加填充指令（**纯**）：每个有热的格子一条 rect，色 = palette.brand
 * （与峰顶 accent 同源），α = HEAT_PEAK_ALPHA × heat × fadeAlpha(格心)——
 * 与静层同一右上渐隐源，左下扫过自然无痕迹。返回的指令按 reading order
 * 排列（y 后 x），壳直接 fillRect 即可。
 */
export function planHeatOps(
  field: HeatField,
  cell: number,
  w: number,
  h: number,
  palette: BackdropPalette,
): StaticOp[] {
  if (field.size === 0) return [];
  const ops: StaticOp[] = [];
  for (const [key, heat] of field) {
    if (heat < HEAT_OFF_THRESHOLD) continue;
    const comma = key.indexOf(',');
    const cx = Number.parseInt(key.slice(0, comma), 10);
    const cy = Number.parseInt(key.slice(comma + 1), 10);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
    const x = cx * cell;
    const y = cy * cell;
    const cw = Math.min(cell, w - x);
    const ch = Math.min(cell, h - y);
    if (cw <= 0 || ch <= 0) continue;
    const alpha = HEAT_PEAK_ALPHA * heat * fadeAlpha(x + cw / 2, y + ch / 2, w, h);
    if (alpha < MIN_OP_ALPHA) continue;
    ops.push({ kind: 'rect', x, y, w: cw, h: ch, color: withAlpha(palette.brand, alpha) });
  }
  return ops;
}

/**
 * 画布时间基准（performance.now() 的引擎侧口径）：壳传 now 进纯函数，
 * 仿真/测试可注入假时钟。仅当 performance 全局存在时才有值（node 环境
 * vitest 也带 performance，兜底 0）。
 */
export function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}

/** 波纹是否已消亡（兼容旧签名：born 距今 ≥ HEAT_DECAY_TAU×3 秒）。
 * @deprecated R6 后壳改用 decayHeat 的 Map 自清理；保留供旧测试/预览过渡。 */
export function rippleDead(ripple: Ripple, now: number): boolean {
  return (now - ripple.born) / 1000 >= HEAT_DECAY_TAU * 3;
}

/**
 * 规划一条波纹的绘制指令：R6 起外扩环已下架（用户反馈观感差），微光由
 * splatHeat/decayHeat/planHeatOps 三件套承担。恒返回 []（兼容旧调用）。
 *
 * @deprecated 改用 planHeatOps。
 */
export function planRippleOps(
  ripple: Ripple,
  now: number,
  w: number,
  h: number,
  palette: BackdropPalette,
): StaticOp[] {
  void ripple;
  void now;
  void w;
  void h;
  void palette;
  return [];
}

/* —— 像素坦克（D20f → D22g 彩色化；D23-4 坦克暂时下架，引擎保留）—— */

/** sprite 像素语义：0 空 / 1 车身(accent) / 2 深档(履带·炮管) / 3 炮塔点缀(accent)。 */
export type SpritePixel = 0 | 1 | 2 | 3;

/**
 * 坦克 sprite（7×5，朝 +x 右；D21g R2 重画）：履带在**行进方向两侧**、
 * 中部车体、炮管沿中轴前伸突出于履带端，炮塔中心 1px accent 点缀。
 * 25 个实体像素；「微小」由 TANK_PIXEL=3（全车 21×15px）与有效 alpha
 * 0.55–0.75（D22g）保证。形状由测试四向剪影锁死。
 */
export const TANK_SPRITE: readonly (readonly SpritePixel[])[] = [
  [2, 2, 2, 2, 2, 0, 0],
  [0, 1, 1, 1, 1, 0, 0],
  [1, 1, 1, 3, 1, 2, 2],
  [0, 1, 1, 1, 1, 0, 0],
  [2, 2, 2, 2, 2, 0, 0],
];

/** 按 dir 变换 sprite（0 原样 / 1 顺时针 / 2 水平镜像 / 3 逆时针）。 */
export function rotateSprite(
  sprite: readonly (readonly SpritePixel[])[],
  dir: Dir,
): readonly (readonly SpritePixel[])[] {
  if (dir === 0) return sprite;
  const rows = sprite.length;
  const cols = sprite[0]?.length ?? 0;
  const at = (r: number, c: number): SpritePixel => sprite[r]?.[c] ?? 0;
  if (dir === 2) {
    // 水平镜像（朝 -x）
    return Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) => at(r, cols - 1 - c)),
    );
  }
  // dir 1：顺时针（+x → +y）；dir 3：逆时针（+x → -y）
  const cw = dir === 1;
  return Array.from({ length: cols }, (_, c) =>
    Array.from({ length: rows }, (_, r) => (cw ? at(rows - 1 - r, c) : at(r, cols - 1 - c))),
  );
}

/** 坦克沿行进方向的半长（sprite 长边 7px × TANK_PIXEL / 2）——碰撞间距基准。 */
export const HALF_TANK = (7 * TANK_PIXEL) / 2;

/**
 * 坦克实例（引擎内部状态；rng 闭包随实例走，重放同 seed 即同轨迹）。
 * 碰撞仲裁内部状态字段全部可选（向后兼容测试/仿真手工构造），随 seed
 * 确定性演化。
 */
export interface Tank {
  /** 车体中心（逻辑 px，恒在网格线上：x、y 至少一个为 cell 整数倍）。 */
  x: number;
  y: number;
  dir: Dir;
  /** px/s，14–24（D22g：感知速度上调，原 10–16）。 */
  speed: number;
  /** 已存活秒数（转向计时/让行截止的时钟）。 */
  age: number;
  /** 下一次允许随机转向的 age（4–9s 一转，D20f）。 */
  nextTurnAt: number;
  /** 实例随机源（确定性）。 */
  rand: () => number;
  /** 彩色 accent（D22g：createTanks 按 index 轮询 TANK_ACCENTS；手工构造
   * 可省略——planTankOps 回落 palette.brand）。 */
  accent?: string;
  /* —— 碰撞仲裁内部状态（D22g，可选）—— */
  /** 跟车持续等待累计秒（被钳停期间累加，自由行驶清零；≥6s 强制改道）。 */
  waitHold?: number;
  /** 对头双停/让行的截止 age（未到则本帧禁动）。 */
  yieldUntil?: number;
  /** 对头双停到期后执行倒车的标记（仲裁期决策，apply 期执行）。 */
  pendingReverse?: boolean;
}

/** 坦克活动区下限（D20f/D22g 保持）：目的地交点渐隐低于此值不可承诺。 */
export const TANK_ZONE_ALPHA = 0.3;

/* —— 碰撞仲裁参数（D22g）—— */
/** 跟车最小中心距（×cell）：1.2·cell。 */
const STOP_DIST_FACTOR = 1.2;
/** 跟车恢复迟滞（×cell）：1.8·cell。 */
const RESUME_GAP_FACTOR = 1.8;
/** 跟车等待超时（s）：强制改道/倒车。 */
export const HOLD_TIMEOUT = 6;
/** 对头双停时长（s）。 */
export const HEAD_ON_PAUSE = 0.4;
/** 对头判定中心距（px）。 */
export const HEAD_ON_DIST = 48;
/** 交点冲突预警窗（s）：双方 ETA 都小于此值才仲裁。 */
export const ETA_WINDOW = 2;
/** 交点 stop line：距交点中心 HALF_TANK + 4。 */
export const STOP_LINE_PAD = HALF_TANK + 4;
/** 交点占位互斥半径：其他坦克距交点 < 此值时禁止进入（> STOP_LINE_PAD，
 * 依次驶入者彼此间距 ≥ STOP_LINE_PAD，测试 ④ 的 halfTank 互斥有裕量）。 */
export const BLOCK_RADIUS = HALF_TANK + 5;
/** 深区回退探针步数上限（每步一个交点；超限反向兜底）。 */
const WALK_LIMIT = 1000;

/** 坦克步进单帧 dt 上限（组件层还会做帧率限制；双保险防跳帧瞬移）。 */
const MAX_DT = 0.1;

/** dt 规整：clamp 到 [0, 0.1]（跳帧防瞬移）。 */
function clampDt(dt: number): number {
  return clamp01(dt) > MAX_DT ? MAX_DT : Math.max(dt, 0);
}

/** 活动区锚点（右上偏内）：redirect 朝它选轴/回退。 */
function zoneAnchor(w: number, h: number): Vec2 {
  return { x: w * 0.78, y: h * 0.2 };
}

/** 就近吸附到网格线坐标（车道 = cell 整数倍），出界则夹回最近车道。 */
function snapLane(v: number, cell: number, max: number): number {
  const lane = Math.round(v / cell) * cell;
  const laneCount = Math.floor(max / cell);
  const clampedLane = Math.min(Math.max(lane, 0), laneCount * cell);
  return Math.min(clampedLane, Math.max(0, max));
}

/**
 * 单帧移动意图（**纯**——不变异 tank、不消耗 rand）。
 * D22g 防死锁核心：target 恒 clamp 到车道边界（消末车道 dip），中途不做
 * 任何 snap 回拉；zone/边界校验全部推迟到交点处（apply 层）。
 */
export interface TankMove {
  fromX: number;
  fromY: number;
  /** 本帧落点（仲裁可改写；apply 写回）。 */
  toX: number;
  toY: number;
  /** 本帧行进方向。 */
  dir: Dir;
  /** 行进轴向坐标（dir 水平 → x，否则 y）。 */
  along: number;
  /** 行进符号（+1/-1）。 */
  moving: 1 | -1;
  /** 本帧计划位移（dt clamp 后 × speed）。 */
  distance: number;
  /** 目的地交点（轴向坐标，已 clamp 到车道边界）。 */
  target: number;
  /** 未仲裁前的轴向落点。 */
  arrival: number;
  /** 是否到达/越过目的地交点（apply 层在此做吸附+转向+zone 校验）。 */
  crossed: boolean;
  /** 仲裁冻结（对头双停/让行/倒车帧）——apply 跳过到达逻辑。 */
  frozen: boolean;
  /** 仲裁要求强制改道（等待超时）——apply 层执行。 */
  forcedReroute: boolean;
}

/** 沿 dir 的车道轴向边界（laneCount·cell，D22g：末车道保护消 dip）。 */
function laneMax(dir: Dir, w: number, h: number, cell: number): number {
  return (dir % 2 === 0 ? Math.floor(w / cell) : Math.floor(h / cell)) * cell;
}

/**
 * 计算一辆坦克的单帧移动意图（纯函数；不改 tank、不消耗 rand）。
 * `w`/`h` 用于车道边界 clamp：目标交点 ≤ floor(max/cell)·cell（D22g 末车道
 * 保护——h 非 cell 整数倍时不再 dip 进格线死区）。
 */
export function intendTankMove(
  tank: Tank,
  dt: number,
  w: number,
  h: number,
  cell: number,
): TankMove {
  const step = clampDt(dt);
  const dir = tank.dir;
  const v = DIR_VECTORS[dir]!;
  const moving: 1 | -1 = v.x + v.y > 0 ? 1 : -1;
  const horizontal = dir % 2 === 0;
  const along = horizontal ? tank.x : tank.y;
  const distance = tank.speed * step;
  const max = laneMax(dir, w, h, cell);
  let target =
    moving > 0 ? (Math.floor(along / cell) + 1) * cell : (Math.ceil(along / cell) - 1) * cell;
  target = Math.min(Math.max(target, 0), max);
  const arrival = along + moving * distance;
  const crossed = moving > 0 ? arrival >= target : arrival <= target;
  const newAlong = crossed ? target : arrival;
  const toX = horizontal ? newAlong : tank.x;
  const toY = horizontal ? tank.y : newAlong;
  return {
    fromX: tank.x,
    fromY: tank.y,
    toX,
    toY,
    dir,
    along,
    moving,
    distance,
    target,
    arrival,
    crossed,
    frozen: false,
    forcedReroute: false,
  };
}

/** 下一交点坐标（出界返回 null）。 */
function nextIntersectionPoint(
  x: number,
  y: number,
  dir: Dir,
  w: number,
  h: number,
  cell: number,
): Vec2 | null {
  const v = DIR_VECTORS[dir]!;
  const nx = x + v.x * cell;
  const ny = y + v.y * cell;
  if (nx < 0 || nx > laneMax(0, w, h, cell) || ny < 0 || ny > laneMax(1, w, h, cell)) return null;
  return { x: nx, y: ny };
}

/** 沿 dir 的**紧邻**目的地交点是否在活动区（fade ≥ 0.3）且在车道界内。 */
function dirInZoneDest(
  x: number,
  y: number,
  dir: Dir,
  w: number,
  h: number,
  cell: number,
): boolean {
  const dest = nextIntersectionPoint(x, y, dir, w, h, cell);
  return dest !== null && fadeAlpha(dest.x, dest.y, w, h) >= TANK_ZONE_ALPHA;
}

/**
 * 沿 dir 能否「走出深区」：目的地在界内但出活动区时，沿同方向逐交点探到
 * 入区为止（fade 沿 +x/−y 单调 ⇒ 只有朝锚方向可能成立，探针 = 当前交点 +
 * k·cell·方向向量，必然可达；WALK_LIMIT 上限防意外）。
 */
function dirWalkable(
  x: number,
  y: number,
  dir: Dir,
  w: number,
  h: number,
  cell: number,
): boolean {
  const v = DIR_VECTORS[dir]!;
  for (let k = 1; k <= WALK_LIMIT; k++) {
    const px = x + v.x * cell * k;
    const py = y + v.y * cell * k;
    if (px < 0 || px > laneMax(0, w, h, cell) || py < 0 || py > laneMax(1, w, h, cell)) {
      return false;
    }
    if (fadeAlpha(px, py, w, h) >= TANK_ZONE_ALPHA) return true;
  }
  return false;
}

/** 可承诺 = 目的地在区，或（深区回退模式）沿此方向探得到出口。 */
function dirEnterable(
  x: number,
  y: number,
  dir: Dir,
  w: number,
  h: number,
  cell: number,
): boolean {
  return dirInZoneDest(x, y, dir, w, h, cell) || dirWalkable(x, y, dir, w, h, cell);
}

/**
 * 车流否决：dir 的目的地车道段上是否有**对向**坦克在 HEAD_ON_DIST 内。
 * 用于一切转向选择（redirect / 随机转向 / 强制改道）：不把车导向一条
 * 近距离有对向车的车道——否则在 ≤48px 的短车道上，对头双停-倒车-闸口
 * 再导向会形成永久互撞循环（R3 仿真 800×40 实测 900s 零位移）。
 * 确定性：只读他车当前坐标与 dir，不消耗 rand。
 */
function headOnBlocked(
  x: number,
  y: number,
  dir: Dir,
  w: number,
  h: number,
  cell: number,
  self: Tank,
  others: readonly Tank[],
): boolean {
  if (others.length === 0) return false;
  const dest = nextIntersectionPoint(x, y, dir, w, h, cell);
  if (dest === null) return false;
  const horizontal = dir % 2 === 0;
  for (const o of others) {
    if (o === self) continue;
    const sameLane = horizontal
      ? Math.abs(o.y - dest.y) < 1e-6
      : Math.abs(o.x - dest.x) < 1e-6;
    if (!sameLane) continue;
    if ((o.dir + 2) % 4 !== dir) continue; // 只否决对向
    const along = horizontal ? o.x : o.y;
    const destAlong = horizontal ? dest.x : dest.y;
    if (Math.abs(along - destAlong) < HEAD_ON_DIST) return true;
  }
  return false;
}

/**
 * 交点处重选方向（redirect，D22g 新语义）：在四个「当前交点 + cell·方向」
 * 候选交点里选第一个可承诺者——先挑**紧邻目的地在活动区**的（优先朝锚点
 * 轴，主轴 = 距锚更远的轴），全无再挑「沿向可走出深区」的（逐交点回退，
 * fade 沿 +x/−y 单调必收敛，上限 WALK_LIMIT）；仍无则反向兜底。
 * 两档都先经 headOnBlocked 车流否决（不导向近距离对向车道；全被否决时
 * 退回未否决语义，对头仲裁兜底）。
 * 确定性：不依赖 rand。in-zone 出生即永不进入第二档（朝锚候选必在区）。
 */
function chooseDirAtIntersection(
  tank: Tank,
  w: number,
  h: number,
  cell: number,
  others: readonly Tank[] = [],
): Dir {
  const anchor = zoneAnchor(w, h);
  const dx = anchor.x - tank.x;
  const dy = anchor.y - tank.y;
  const horizontalFirst = Math.abs(dx) >= Math.abs(dy);
  const towardPrimary: Dir = horizontalFirst ? (dx >= 0 ? 0 : 2) : dy >= 0 ? 1 : 3;
  const towardSecondary: Dir = horizontalFirst ? (dy >= 0 ? 1 : 3) : dx >= 0 ? 0 : 2;
  const awayPrimary = ((towardPrimary + 2) % 4) as Dir;
  const awaySecondary = ((towardSecondary + 2) % 4) as Dir;
  const order: Dir[] = [towardPrimary, towardSecondary, awayPrimary, awaySecondary];
  const blocked = (dir: Dir): boolean => headOnBlocked(tank.x, tank.y, dir, w, h, cell, tank, others);
  for (const dir of order) {
    if (dirInZoneDest(tank.x, tank.y, dir, w, h, cell) && !blocked(dir)) return dir;
  }
  for (const dir of order) {
    if (dirWalkable(tank.x, tank.y, dir, w, h, cell) && !blocked(dir)) return dir;
  }
  for (const dir of order) {
    if (dirInZoneDest(tank.x, tank.y, dir, w, h, cell)) return dir;
  }
  for (const dir of order) {
    if (dirWalkable(tank.x, tank.y, dir, w, h, cell)) return dir;
  }
  return ((tank.dir + 2) % 4) as Dir;
}

/**
 * 应用一份（可能经仲裁调整的）移动意图到坦克：写回位置；到达交点时吸附、
 * 尝试随机转向、并做 D22g 的交点校验——当前 dir 的**目的地交点**不可承诺
 * （出界/出活动区且探不到出口）立即 redirect。途中绝不回拉。
 * others = 同帧车组（stepTanks 传入；stepTank 单车路径缺省空 → 车流否决
 * 自然失效）。转向选择全部经 headOnBlocked 车流否决。
 * 消耗 tank.rand（确定性）。
 */
function applyTankMove(
  tank: Tank,
  m: TankMove,
  w: number,
  h: number,
  cell: number,
  others: readonly Tank[] = [],
): void {
  tank.x = m.toX;
  tank.y = m.toY;
  if (m.forcedReroute) {
    // 等待超时强制改道：在交点试垂直转向，否则可倒则倒（目的地须可承诺
    // 且无近距离对向车）。
    const atIntersection =
      Math.abs(m.toX / cell - Math.round(m.toX / cell)) < 1e-6 &&
      Math.abs(m.toY / cell - Math.round(m.toY / cell)) < 1e-6;
    const free = (d: Dir): boolean =>
      dirEnterable(tank.x, tank.y, d, w, h, cell) &&
      !headOnBlocked(tank.x, tank.y, d, w, h, cell, tank, others);
    let done = false;
    if (atIntersection) {
      for (const turn of [1, 3] as const) {
        const d = ((tank.dir + turn) % 4) as Dir;
        if (free(d)) {
          tank.dir = d;
          done = true;
          break;
        }
      }
    }
    if (!done) {
      const back = ((tank.dir + 2) % 4) as Dir;
      if (free(back)) tank.dir = back;
    }
    tank.waitHold = 0;
    tank.nextTurnAt = tank.age + 4 + tank.rand() * 5;
    return;
  }
  if (m.frozen) return; // 对头双停/让行帧：位置不变，不做到达逻辑
  if (!m.crossed) return; // 途中：目的地已在前一交点承诺过，无需再校验
  // —— 到达交点：吸附 + 随机转向（保持 D20f 观感；转向以「紧邻目的地在
  // 活动区且无近距离对向车」为准）——
  tank.x = snapLane(tank.x, cell, w);
  tank.y = snapLane(tank.y, cell, h);
  if (tank.age >= tank.nextTurnAt && tank.rand() < 0.65) {
    const turn = tank.rand() < 0.5 ? 1 : 3;
    const next = ((tank.dir + turn) % 4) as Dir;
    if (
      dirInZoneDest(tank.x, tank.y, next, w, h, cell) &&
      !headOnBlocked(tank.x, tank.y, next, w, h, cell, tank, others)
    ) {
      tank.dir = next;
      tank.nextTurnAt = tank.age + 4 + tank.rand() * 5;
    } else {
      tank.nextTurnAt = tank.age + 1 + tank.rand() * 2; // 此路不通，稍后再试
    }
  }
  // —— 交点校验（D22g）：直行目的地不可承诺 → redirect（替代旧「每帧位置
  // 检查 + snap 回拉」，等值线相位不再能钉死坦克）。 ——
  if (!dirEnterable(tank.x, tank.y, tank.dir, w, h, cell)) {
    tank.dir = chooseDirAtIntersection(tank, w, h, cell, others);
    tank.nextTurnAt = tank.age + 4 + tank.rand() * 5;
  }
}

/**
 * 步进一辆坦克（单坦克兼容路径，D22g 保留）。语义：交点语义 + 目的地校验，
 * 无碰撞仲裁（多坦克请用 stepTanks）。dt 被 clamp 到 ≤0.1s。
 */
export function stepTank(tank: Tank, dt: number, w: number, h: number, cell: number): void {
  const m = intendTankMove(tank, dt, w, h, cell);
  tank.age += clampDt(dt);
  applyTankMove(tank, m, w, h, cell);
}

/** 两车中心距的平方（仲裁用，避免开方）。 */
function dist2(a: Tank, b: Tank): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * 同车道对向两车是否**正在接近**（+向车沿轴坐标 ≤ −向车沿轴坐标）。
 * 背向而行 = 倒车分离已完成或从未逼近，不触发对头仲裁——冻结期内位置
 * 不变，若无此判据，倒车执行后下帧立刻再触发并选回同一倒车者，方向以
 * 0.8s 周期永久翻转（零位移活锁，R3 仿真 800×40 实测 900s）。
 */
function approaching(ma: TankMove, mb: TankMove, horizontal: boolean): boolean {
  const plus = ma.moving > 0 ? ma : mb;
  const minus = ma.moving > 0 ? mb : ma;
  const pPlus = horizontal ? plus.fromX : plus.fromY;
  const pMinus = horizontal ? minus.fromX : minus.fromY;
  return pPlus <= pMinus;
}

/**
 * 步进一组坦克（D22g 碰撞仲裁路径）：先对全体 intendTankMove，再做两两仲裁
 * （n ≤ 6，O(n²)），最后逐车 apply。仲裁规则（全部确定性、不消耗 rand）：
 * 1. **同车道跟车**：同车道同向、间距 < stopDist=1.2·cell → 后车钳到前车尾
 *    stop line；恢复 gap ≥ resumeGap=1.8·cell（迟滞）；等待 ≥ 6s 强制改道。
 * 2. **同车道对头**：反向、间距 < 48px → 双停 headOnPause=0.4s，然后「倒车
 *    可行」者里距锚点远者倒车（等距取下标小者）；倒车后同向必解。
 * 3. **交点冲突**：目标同一交点、异轴、双方 ETA < 2s → (ETA, index) 字典序
 *    小者先走，大者停在 stop line（HALF_TANK+4）；若停车位出区而对方停位
 *    在区（zone 停让优先）则让行互换。另有占位互斥：任何坦克距交点 <
 *    BLOCK_RADIUS 时，其他 ETA < 2s 的瞄准者一律停在 stop line（保证任意
 *    时刻至多一辆坦克在一个交点的 halfTank 邻域内）。
 * 4. 停让不破活动区：stop line 落点出区时让行互换（不因礼让出区）。
 */
export function stepTanks(tanks: Tank[], dt: number, w: number, h: number, cell: number): void {
  const step = clampDt(dt);
  const n = tanks.length;
  if (n === 0) return;
  for (const t of tanks) t.age += step;
  const moves = tanks.map((t) => intendTankMove(t, step, w, h, cell));
  const stopDist = STOP_DIST_FACTOR * cell;
  const resumeGap = RESUME_GAP_FACTOR * cell;

  // —— 两两仲裁（i < j 固定顺序 ⇒ 级联确定性）——
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = tanks[i]!;
      const b = tanks[j]!;
      const ma = moves[i]!;
      const mb = moves[j]!;
      if (a.dir % 2 === b.dir % 2) {
        // 同轴：判定是否同车道（车道坐标相同——横轴比 y、纵轴比 x，用仲裁
        // 前位置即可：车道坐标本帧不变）。
        const horizontal = a.dir % 2 === 0;
        const sameLine = horizontal
          ? Math.abs(a.y - b.y) < 1e-6
          : Math.abs(a.x - b.x) < 1e-6;
        if (!sameLine) continue;
        const aAlong = horizontal ? ma.toX : ma.toY;
        const bAlong = horizontal ? mb.toX : mb.toY;
        const sameDir = ma.moving === mb.moving;
        if (sameDir) {
          // —— 跟车：沿行进方向在前者为主车 ——
          const frontIsA = ma.moving > 0 ? aAlong >= bAlong : aAlong <= bAlong;
          const frontM = frontIsA ? ma : mb;
          const rear = frontIsA ? b : a;
          const rearM = frontIsA ? mb : ma;
          const frontAlong = horizontal ? frontM.toX : frontM.toY;
          const stopLine = frontAlong - rearM.moving * stopDist;
          const rearCur = horizontal ? rearM.toX : rearM.toY;
          const gap = (frontAlong - rearCur) * rearM.moving;
          const holding = (rear.waitHold ?? 0) > 0 ? resumeGap : stopDist;
          if (gap < holding) {
            // 只防越过：钳停不把后车往后拽（保持已有仲裁结果的单调性）。
            const clamped =
              rearM.moving > 0
                ? Math.min(rearCur, Math.max(rearM.along, stopLine))
                : Math.max(rearCur, Math.min(rearM.along, stopLine));
            if (horizontal) rearM.toX = clamped;
            else rearM.toY = clamped;
            rearM.crossed = rearM.moving > 0 ? clamped >= rearM.target : clamped <= rearM.target;
            rear.waitHold = (rear.waitHold ?? 0) + step;
            if ((rear.waitHold ?? 0) >= HOLD_TIMEOUT && !rearM.frozen) rearM.forcedReroute = true;
          } else {
            rear.waitHold = 0; // 迟滞恢复
          }
        } else {
          // —— 对头：间距 < 48px 且**正在接近** → 双停 headOnPause=0.4s 后
          //    倒车可行者（距锚远者优先，等距取下标小者）倒车。
          //    「接近中」判据（沿车道轴，+向车位置 p₊ < −向车位置 p₋）是
          //    防活锁关键：倒车执行后两车背向而行（p₊ > p₋），若不设此判据，
          //    冻结期内位置不变 → 下帧立刻再触发 → 倒车者被再选回 → 方向
          //    以 0.8s 周期永久翻转、零位移（R3 仿真实测）。
          if (dist2(a, b) >= HEAD_ON_DIST * HEAD_ON_DIST) continue;
          const paused = (a.yieldUntil ?? 0) > a.age || (b.yieldUntil ?? 0) > b.age;
          if (paused) {
            ma.frozen = true;
            mb.frozen = true;
            continue;
          }
          if (a.pendingReverse === true || b.pendingReverse === true) {
            const rev = a.pendingReverse === true ? a : b;
            const revM = a.pendingReverse === true ? ma : mb;
            rev.dir = ((rev.dir + 2) % 4) as Dir;
            rev.pendingReverse = false;
            revM.frozen = true; // 倒车帧不动，下帧按新方向背向而行
            continue;
          }
          if (!approaching(ma, mb, horizontal)) continue; // 背向而行：无需仲裁
          // 全新遭遇：布双停（两车本帧回到原地、禁动）+ 选倒车者。
          ma.frozen = true;
          mb.frozen = true;
          ma.toX = ma.fromX;
          ma.toY = ma.fromY;
          mb.toX = mb.fromX;
          mb.toY = mb.fromY;
          ma.crossed = false;
          mb.crossed = false;
          a.yieldUntil = a.age + HEAD_ON_PAUSE;
          b.yieldUntil = b.age + HEAD_ON_PAUSE;
          const anchor = zoneAnchor(w, h);
          const da = (a.x - anchor.x) ** 2 + (a.y - anchor.y) ** 2;
          const db = (b.x - anchor.x) ** 2 + (b.y - anchor.y) ** 2;
          const first = da > db || (da === db && i < j) ? a : b;
          const second = first === a ? b : a;
          const firstBack = ((first.dir + 2) % 4) as Dir;
          const firstBackOk = dirEnterable(first.x, first.y, firstBack, w, h, cell);
          const secondBack = ((second.dir + 2) % 4) as Dir;
          const secondBackOk = dirEnterable(second.x, second.y, secondBack, w, h, cell);
          const rev = firstBackOk ? first : secondBackOk ? second : first;
          rev.pendingReverse = true;
        }
        continue;
      }
      // —— 异轴：交点冲突（同一目标交点 或 对方占位邻域）——
      resolveCrossing(a, ma, i, b, mb, j, w, h);
    }
  }

  // —— apply：写回 + 到达逻辑（rand 只在这里消耗，确定性）——
  for (let i = 0; i < n; i++) applyTankMove(tanks[i]!, moves[i]!, w, h, cell, tanks);
}

/** 坦克对「瞄准中的交点」的意图（目标交点坐标 + ETA；无则 null）。 */
interface CrossingIntent {
  ix: number;
  iy: number;
  eta: number;
}

/**
 * 瞄准意图：本帧会到达（crossed）或 ETA < ETA_WINDOW 的目标交点。
 * 目标交点 = 车道与本轴目标坐标的交点；target === along（被边界钳住）不算
 * 瞄准（apply 层会 redirect）。冻结/强制改道中的车不参与瞄准仲裁。
 */
function crossingIntent(tank: Tank, m: TankMove): CrossingIntent | null {
  if (m.frozen || m.forcedReroute) return null;
  if (m.target === m.along) return null;
  const remaining = (m.target - m.arrival) * m.moving;
  const eta = m.crossed ? 0 : remaining / Math.max(tank.speed, 1e-6);
  if (eta > ETA_WINDOW) return null;
  return {
    ix: m.dir % 2 === 0 ? m.target : tank.x,
    iy: m.dir % 2 === 0 ? tank.y : m.target,
    eta,
  };
}

/** 瞄准者 stop line 落点（交点前 STOP_LINE_PAD，车道坐标不变）。 */
function stopLinePoint(m: TankMove, it: CrossingIntent): Vec2 {
  return m.dir % 2 === 0
    ? { x: it.ix - m.moving * STOP_LINE_PAD, y: m.fromY }
    : { x: m.fromX, y: it.iy - m.moving * STOP_LINE_PAD };
}

/** 把瞄准者钳到 stop line（只防越过，不往后拽），并重算 crossed。 */
function clampToStopLine(m: TankMove, stop: Vec2): void {
  if (m.dir % 2 === 0) {
    const clamped =
      m.moving > 0 ? Math.min(m.toX, Math.max(m.along, stop.x)) : Math.max(m.toX, Math.min(m.along, stop.x));
    m.toX = clamped;
    m.crossed = m.moving > 0 ? clamped >= m.target : clamped <= m.target;
  } else {
    const clamped =
      m.moving > 0 ? Math.min(m.toY, Math.max(m.along, stop.y)) : Math.max(m.toY, Math.min(m.along, stop.y));
    m.toY = clamped;
    m.crossed = m.moving > 0 ? clamped >= m.target : clamped <= m.target;
  }
}

/**
 * 交点冲突仲裁（异轴对，见 stepTanks 注释 3/4）。确定性：不消耗 rand。
 * ①互瞄同一交点（双方 ETA < ETA_WINDOW）：(ETA, index) 字典序小者先走；
 *   大者钳到 stop line——但若大者 stop line 落点出活动区而小者停位在区
 *   （zone 停让优先，不因礼让出区），让行互换（仍恰一车入交点）。
 * ②占位互斥：一方瞄准 I（ETA < ETA_WINDOW）而任一方距 I < BLOCK_RADIUS
 *   （≥ STOP_LINE_PAD，依次驶入者彼此间距 ≥ STOP_LINE_PAD）→ 瞄准者钳到
 *   stop line——覆盖「占位者未瞄准 I / 已越过 I 尚未让出 halfTank 邻域」
 *   的所有情形，保证任意时刻至多一辆坦克在一个交点的 halfTank 邻域内。
 */
function resolveCrossing(a: Tank, ma: TankMove, ai: number, b: Tank, mb: TankMove, bi: number, w: number, h: number): void {
  const ia = crossingIntent(a, ma);
  const ib = crossingIntent(b, mb);
  if (ia !== null && ib !== null && ia.ix === ib.ix && ia.iy === ib.iy) {
    // —— ①互瞄同一交点 ——
    const aWins = ia.eta < ib.eta || (ia.eta === ib.eta && ai < bi);
    const winM = aWins ? ma : mb;
    const losM = aWins ? mb : ma;
    const winIt = aWins ? ia : ib;
    const losIt = aWins ? ib : ia;
    const winStop = stopLinePoint(winM, winIt);
    const losStop = stopLinePoint(losM, losIt);
    const flip =
      fadeAlpha(losStop.x, losStop.y, w, h) < TANK_ZONE_ALPHA &&
      fadeAlpha(winStop.x, winStop.y, w, h) >= TANK_ZONE_ALPHA;
    clampToStopLine(flip ? winM : losM, flip ? winStop : losStop);
    return;
  }
  // —— ②占位互斥（用对方本帧落点判占位）——
  if (ia !== null) {
    const bo = { x: mb.toX, y: mb.toY };
    if (Math.abs(bo.x - ia.ix) < BLOCK_RADIUS && Math.abs(bo.y - ia.iy) < BLOCK_RADIUS) {
      clampToStopLine(ma, stopLinePoint(ma, ia));
    }
  }
  if (ib !== null) {
    const ao = { x: ma.toX, y: ma.toY };
    if (Math.abs(ao.x - ib.ix) < BLOCK_RADIUS && Math.abs(ao.y - ib.iy) < BLOCK_RADIUS) {
      clampToStopLine(mb, stopLinePoint(mb, ib));
    }
  }
}

/**
 * 生成 count 辆坦克：随机分布在活动区（渐隐 ≥ TANK_ZONE_ALPHA）的网格交点
 * 上，速度/转向相位各自独立；全部确定性（同 seed 同布局同轨迹）。
 * D22g：①退化尺寸（w/h < 4·cell，车道网塌缩）直接返回 []；
 * ②出生间距精确化——同车道 ≥ 2 格，或两轴都异道（取代旧 Chebyshev<cell）；
 * ③签名扩 accents（彩色族按 index 轮询，缺省 TANK_ACCENTS）。
 */
export function createTanks(
  count: number,
  w: number,
  h: number,
  cell: number,
  seed: number,
  accents: readonly string[] = TANK_ACCENTS,
): Tank[] {
  if (w < cell * 4 || h < cell * 4) return [];
  return placeTanks(count, w, h, cell, seed, accents);
}

/**
 * 布点（无退化尺寸护栏）：createTanks 的落点本体，独立导出供测试/仿真在
 * 病理窄画布（如 800×20 单车道）上构造真实车流验证防钉死。确定性同源。
 */
export function placeTanks(
  count: number,
  w: number,
  h: number,
  cell: number,
  seed: number,
  accents: readonly string[] = TANK_ACCENTS,
): Tank[] {
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const tanks: Tank[] = [];
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const x = snapLane(rand() * w, cell, w);
      const y = snapLane(rand() * h, cell, h);
      if (fadeAlpha(x, y, w, h) < TANK_ZONE_ALPHA) continue;
      // 出生间距（D22g 精确判定）：同车道 ≥2 格，或两轴都异道。
      const spaced = tanks.every((t) =>
        t.y === y ? Math.abs(t.x - x) >= cell * 2 : t.x === x ? Math.abs(t.y - y) >= cell * 2 : true,
      );
      if (!spaced) continue;
      tanks.push({
        x,
        y,
        dir: (Math.floor(rand() * 4) % 4) as Dir,
        speed: 14 + rand() * 10,
        age: rand() * 9,
        nextTurnAt: 4 + rand() * 5,
        rand: mulberry32((seed + i * 7919) | 0),
        accent: accents[i % accents.length],
      });
      break;
    }
  }
  return tanks;
}

/**
 * 规划一辆坦克的绘制指令：以车体中心为锚、按 dir 旋转 sprite，每个实体
 * 像素一条 rect。D22g：车身 = accent（TANK_BODY_ALPHA 0.55）、履带炮管 =
 * label（TANK_DARK_ALPHA 0.60）、炮塔点缀 = accent（TANK_ACCENT_ALPHA 0.75）；
 * 像素尺寸恒 TANK_PIXEL=3（与 CELL 解耦）。
 */
export function planTankOps(
  tank: Tank,
  cell: number,
  palette: BackdropPalette,
): StaticOp[] {
  void cell; // D22g：像素尺寸与 CELL 解耦（保留签名兼容）
  const sprite = rotateSprite(TANK_SPRITE, tank.dir);
  const rows = sprite.length;
  const cols = sprite[0]?.length ?? 0;
  const px = TANK_PIXEL;
  const accent = tank.accent ?? palette.brand;
  const originX = tank.x - (cols * px) / 2;
  const originY = tank.y - (rows * px) / 2;
  const colorOf = (p: SpritePixel): string =>
    p === 1
      ? withAlpha(accent, TANK_BODY_ALPHA)
      : p === 2
        ? withAlpha(palette.label, TANK_DARK_ALPHA)
        : withAlpha(accent, TANK_ACCENT_ALPHA);
  const ops: StaticOp[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const pixel = sprite[r]?.[c] ?? 0;
      if (pixel === 0) continue;
      ops.push({
        kind: 'rect',
        x: Math.round(originX + c * px),
        y: Math.round(originY + r * px),
        w: px,
        h: px,
        color: colorOf(pixel),
      });
    }
  }
  return ops;
}
