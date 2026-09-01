/**
 * 背景板引擎（docs/22-panel-tw-docs-style.md S22-3 / D20d）：面板背景
 * 「右上角格子 + 高地图 → 左下角渐隐 + 微型像素坦克」的全部**纯计算**。
 *
 * 为什么独立成纯模块（D20d）：vitest 是 node 环境无 DOM（21.2.4），canvas/
 * rAF 都不可测——本模块零 DOM 依赖、零副作用、全部确定性（显式 seed），把
 * 「高度场、渐隐、坦克步进、调色板采样、静层绘制指令」做成可单测的纯函数；
 * `eteamsBackdrop.tsx` 只做 canvas/DPR/rAF/可见性/降运动的薄接线（S22-4）。
 *
 * 「不喧宾夺主」的硬指标落在本模块的常量与 alpha 计算里（D20e/D20f/D20g）：
 * 网格线 alpha ≤ 0.05（对齐官网 bg-grid-slate-900/[0.04]）、高地图 ≤ 0.07、
 * 坦克 ≤ 3 辆且每像素 alpha ≤ 0.4、活动区约束在渐隐 ≥ 0.3 的右上区域。
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

/* —— 渐隐（D20g）—— */

/** 渐隐起点：距右上角 d ≤ 0.08 全实；0.08→0.85 平滑衰减到 0（左下角 d=1）。 */
const FADE_NEAR = 0.08;
/** 渐隐终点：d ≥ 0.85 完全透明（左下大片区域零噪声，正文零干扰）。 */
const FADE_FAR = 0.85;

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
 * 1 在左下角；alpha = 1 − smoothstep(0.08, 0.85, d)。网格/高地图/坦克统一
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

/* —— 调色板（D20h 采样 / D21g 定标）—— */

/**
 * 背景板绘制基底色（**实色，不带 alpha**——D21g：alpha 一律在使用位按
 * 元素语义单次烘焙为最终有效值；一期「palette 预烘焙 × 使用位再乘 ×
 * 画布 0.5」的三重叠乘是网格/坦克不可见的根因，实测网格有效 alpha 低至
 * ~0.001，低于感知阈值）。
 */
export interface BackdropPalette {
  /** 中性基底（实色）：网格线 / 高地图阴影 / 坦克车身与深档（亮暗自适应）。 */
  label: string;
  /** 品牌点缀基底（实色，DSW 蓝）：峰顶 / 坦克点缀像素（亮暗自适应）。 */
  brand: string;
  /** 画布级合成透明度（D21g：恒 1.0——有效 alpha 已在指令级单次烘焙，
   *  不再做全局减半；保留字段供组件显式接线与测试断言）。 */
  compositeAlpha: number;
}

/**
 * 画布级合成透明度（D21g：1.0）。D20e 原值 0.5 的「全局减半」与 palette
 * 预烘焙叠乘后所有元素有效值折半再折半——R2 用户验收（网格不可见/坦克
 * 弱成点）后废除；「不喧宾夺主」改由下方各元素有效 alpha 上限保证。
 */
export const COMPOSITE_ALPHA_CAP = 1;

/* D21g 有效 alpha 定标（= 指令烘焙出的最终屏上值；均远低于正文对比度）：
 * 网格 0.07（官网 bg-grid 0.04 档 + 宿主中性色较浅的补偿，可见下限之上）；
 * 高地图 0.11 × height（线性——用户要看得见色斑，原 height² 过度压暗）；
 * 峰顶 DSW 蓝 0.13 × peak；坦克车身 0.45 / 深档 0.55 / DSW 蓝点缀 0.62
 * （微小 sprite 上仍属低调，但可辨识为像素坦克——R2 验收反馈定标）。 */
export const GRID_LINE_ALPHA = 0.07;
export const TERRAIN_SHADE_ALPHA = 0.11;
export const TERRAIN_PEAK_ALPHA = 0.13;
export const TANK_BODY_ALPHA = 0.45;
export const TANK_DARK_ALPHA = 0.55;
export const TANK_ACCENT_ALPHA = 0.62;

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

/** 从宿主变量名读色的采样键（D20h；docs/23 D21e：brand 改 DSW 蓝源）。缺省
 * 一律落字面兜底（DSW 蓝 deepseek-500 / slate 族）。 */
export interface PaletteVarNames {
  /** 主文字色（网格/阴影基底，亮暗自适应）。 */
  readonly label: string;
  /** 品牌点缀色（DSW 蓝：宿主 button-info-fill，亮暗自适应）。 */
  readonly brand: string;
}

export const DEFAULT_PALETTE_VARS: PaletteVarNames = {
  label: '--dsw-alias-label-secondary',
  brand: '--dsw-alias-button-info-fill',
};

/** 采样调色板（D20h；docs/23 D21e/D21g）：`read(name)` 由组件提供
 * （getComputedStyle 包一层），返回 null/undefined/空串即用字面兜底
 * （DSW 蓝 deepseek-500 / slate 族）。本函数纯：同一组输入色产出同一
 * 调色板，测试直接喂假 read。基底一律实色（alpha 在使用位单次烘焙）。 */
export function sampleBackdropPalette(read: (name: string) => string | null): BackdropPalette {
  const label = read(DEFAULT_PALETTE_VARS.label)?.trim() || '#475569';
  const brand = read(DEFAULT_PALETTE_VARS.brand)?.trim() || '#4176e6';
  return { label, brand, compositeAlpha: COMPOSITE_ALPHA_CAP };
}

/* —— 静层绘制指令（网格 + 高地图）—— */

/** 矩形填充指令（坐标逻辑 px；color 已带 alpha）。 */
export interface StaticOp {
  kind: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

/** 高地图峰顶阈值：高度 ≥ 0.8 的格子叠 DSW 蓝点缀（D21e）。 */
const PEAK_THRESHOLD = 0.8;

/**
 * 规划静层（网格线 + 高地图着色），按「地形先、网格后」排序。纯函数：
 * 同一输入产出同一指令序列（测试断言值域/边界/alpha 上限），S22-4 的组件
 * 只负责在（离屏）canvas 上执行并缓存，resize/换主题才重规划。
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
  // 高地图：每格按高度着色（低处淡 → 峰顶 DSW 蓝），再乘渐隐；
  // 末行/末列格子裁齐画布边界（画布宽高未必是 cell 整数倍）。
  // D21g：alpha 在此单次烘焙为最终有效值（线性 height——原 height² 过度
  // 压暗，用户验收反馈「高地图看不见」）。
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const height = heights[cy * cols + cx] ?? 0;
      const x = cx * cell;
      const y = cy * cell;
      const cw = Math.min(cell, w - x);
      const ch = Math.min(cell, h - y);
      const fade = fadeAlpha(x + cw / 2, y + ch / 2, w, h);
      if (fade <= 0.004) continue; // 渐隐尽头的格子一个指令都不产生
      if (height >= PEAK_THRESHOLD) {
        const peakAlpha = (height - PEAK_THRESHOLD) / (1 - PEAK_THRESHOLD);
        ops.push({
          kind: 'rect',
          x,
          y,
          w: cw,
          h: ch,
          color: withAlpha(palette.brand, peakAlpha * TERRAIN_PEAK_ALPHA * fade),
        });
      } else {
        ops.push({
          kind: 'rect',
          x,
          y,
          w: cw,
          h: ch,
          color: withAlpha(palette.label, height * TERRAIN_SHADE_ALPHA * fade),
        });
      }
    }
  }
  // 网格线：逐格分段（每段独立乘渐隐），1px 压在格子边界上。
  // D21g：GRID_LINE_ALPHA 即最终有效 alpha（一次烘焙，无画布减半层）。
  for (let cx = 0; cx <= cols; cx++) {
    const x = Math.min(cx * cell, w - 1);
    for (let cy = 0; cy < rows; cy++) {
      const fade = fadeAlpha(x, cy * cell + cell / 2, w, h);
      if (fade <= 0.004) continue;
      ops.push({
        kind: 'rect',
        x,
        y: cy * cell,
        w: 1,
        h: Math.min(cell, h - cy * cell),
        color: withAlpha(palette.label, GRID_LINE_ALPHA * fade),
      });
    }
  }
  for (let cy = 0; cy <= rows; cy++) {
    const y = Math.min(cy * cell, h - 1);
    for (let cx = 0; cx < cols; cx++) {
      const fade = fadeAlpha(cx * cell + cell / 2, y, w, h);
      if (fade <= 0.004) continue;
      ops.push({
        kind: 'rect',
        x: cx * cell,
        y,
        w: Math.min(cell, w - cx * cell),
        h: 1,
        color: withAlpha(palette.label, GRID_LINE_ALPHA * fade),
      });
    }
  }
  return ops;
}

/* —— 像素坦克（D20f）—— */

/** sprite 像素语义：0 空 / 1 车身 / 2 深档（履带·炮管）/ 3 DSW 蓝点缀（D21e）。 */
export type SpritePixel = 0 | 1 | 2 | 3;

/**
 * 坦克 sprite（7×5，朝 +x 右；D21g R2 重画·渲染自查修正版）：履带在
 * **行进方向两侧**（朝右 = 上下两行，各 5px、止于车体前端），中部三行
 * 车体，炮管沿中轴伸至 5–6 列（**突出于履带前端**——旋转任意方向都保持
 * 「两侧履带 + 中央车体 + 前伸炮管」的可辨识轮廓；首版把履带画成左右
 * 整列，dir 旋转后退化成工字梁，Node 光栅化 ASCII 自查发现）。炮塔中心
 * 1px DSW 蓝点缀。25 个实体像素；「微小」由 3px/像素（全车 21×15px）与
 * 有效 alpha 0.45–0.62（D21g）保证。
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

/** 坦克实例（引擎内部状态；rng 闭包随实例走，重放同 seed 即同轨迹）。 */
export interface Tank {
  /** 车体中心（逻辑 px，恒在网格线上：x、y 至少一个为 cell 整数倍）。 */
  x: number;
  y: number;
  dir: Dir;
  /** px/s，10–16（D20f）。 */
  speed: number;
  /** 已存活秒数（转向计时的时钟）。 */
  age: number;
  /** 下一次允许随机转向的 age（4–9s 一转，D20f）。 */
  nextTurnAt: number;
  /** 实例随机源（确定性）。 */
  rand: () => number;
}

/** 坦克活动区下限（D20f）：所在位置渐隐系数低于此值立即掉头回区。 */
const TANK_ZONE_ALPHA = 0.3;

/** 坦克步进单帧 dt 上限（组件层还会做帧率限制；双保险防跳帧瞬移）。 */
const MAX_DT = 0.1;

/** 活动区锚点（右上偏内）：掉头时朝它选轴。 */
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

/** 在 (x,y) 处按 dir 选一条「仍在活动区内」的车道；无路可走则反向。 */
function redirect(tank: Tank, w: number, h: number, cell: number): void {
  const anchor = zoneAnchor(w, h);
  const dx = anchor.x - tank.x;
  const dy = anchor.y - tank.y;
  // 只在横/纵两轴里选：优先距锚更远的轴；该轴走不动（已在锚同车道且方向
  // 无处可去）时换另一轴；两轴都到锚附近则随机横纵。
  const horizontalFirst = Math.abs(dx) >= Math.abs(dy);
  const order: Dir[] =
    horizontalFirst
      ? [dx >= 0 ? 0 : 2, dy >= 0 ? 1 : 3]
      : [dy >= 0 ? 1 : 3, dx >= 0 ? 0 : 2];
  for (const dir of order) {
    const v = DIR_VECTORS[dir]!;
    const probeX = tank.x + v.x * cell;
    const probeY = tank.y + v.y * cell;
    const inside = probeX >= 0 && probeX <= w && probeY >= 0 && probeY <= h;
    if (inside && fadeAlpha(probeX, probeY, w, h) >= TANK_ZONE_ALPHA) {
      tank.dir = dir;
      tank.nextTurnAt = tank.age + 4 + tank.rand() * 5;
      return;
    }
  }
  tank.dir = ((tank.dir + 2) % 4) as Dir;
  tank.nextTurnAt = tank.age + 4 + tank.rand() * 5;
}

/**
 * 步进一辆坦克（原地变异）。位置恒保持在网格线上：直行时固定车道坐标只动
 * 轴向坐标，过交点才可能转向（且吸附交点）；出界/溜出活动区（渐隐 < 0.3）
 * 立即 redirect 朝右上锚点回区。dt 被 clamp 到 ≤0.1s（跳帧防瞬移）。
 */
export function stepTank(tank: Tank, dt: number, w: number, h: number, cell: number): void {
  const step = clamp01(dt) > MAX_DT ? MAX_DT : Math.max(dt, 0);
  tank.age += step;
  const v = DIR_VECTORS[tank.dir]!;
  const distance = tank.speed * step;
  // 轴向移动 + 交点检测：目标交点 = 当前车道坐标沿 dir 的下一个 cell 整数倍。
  const along = tank.dir % 2 === 0 ? tank.x : tank.y;
  const moving = v.x + v.y > 0 ? 1 : -1;
  let target: number;
  if (moving > 0) {
    target = Math.floor(along / cell + 1) * cell; // 下一个交点
    if (target === along) target = along + cell;
  } else {
    target = Math.ceil(along / cell - 1) * cell; // 上一个交点
    if (target === along) target = along - cell;
  }
  const arrival = along + moving * distance;
  const crossed = moving > 0 ? arrival >= target : arrival <= target;
  const newAlong = crossed ? target : arrival;
  if (tank.dir % 2 === 0) tank.x = newAlong;
  else tank.y = newAlong;

  if (crossed) {
    // 吸附交点（另一轴本来就锁在车道上）。
    tank.x = snapLane(tank.x, cell, w);
    tank.y = snapLane(tank.y, cell, h);
    const wantTurn = tank.age >= tank.nextTurnAt && tank.rand() < 0.65;
    if (wantTurn) {
      // 只转 90°（横↔纵），保持「沿网格线行驶」的观感。
      const turn = tank.rand() < 0.5 ? 1 : 3;
      const next = ((tank.dir + turn) % 4) as Dir;
      const nv = DIR_VECTORS[next]!;
      const probeX = tank.x + nv.x * cell;
      const probeY = tank.y + nv.y * cell;
      const inside = probeX >= 0 && probeX <= w && probeY >= 0 && probeY <= h;
      if (inside && fadeAlpha(probeX, probeY, w, h) >= TANK_ZONE_ALPHA) {
        tank.dir = next;
        tank.nextTurnAt = tank.age + 4 + tank.rand() * 5;
      } else {
        tank.nextTurnAt = tank.age + 1 + tank.rand() * 2; // 此路不通，稍后再试
      }
    }
  }

  // 出界或溜出渐隐 ≥0.3 的活动区：立即回区（D20f 硬约束）。
  const outside =
    tank.x < 0 || tank.x > w || tank.y < 0 || tank.y > h;
  if (outside || fadeAlpha(tank.x, tank.y, w, h) < TANK_ZONE_ALPHA) {
    tank.x = snapLane(tank.x, cell, w);
    tank.y = snapLane(tank.y, cell, h);
    redirect(tank, w, h, cell);
  }
}

/**
 * 生成 count 辆坦克：随机分布在活动区（渐隐 ≥ TANK_ZONE_ALPHA）的网格交点
 * 上，速度/转向相位各自独立；全部确定性（同 seed 同布局同轨迹）。
 * 最多尝试 200 次落点，极端窄画布（活动区退化）允许少配额返回。
 */
export function createTanks(count: number, w: number, h: number, cell: number, seed: number): Tank[] {
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const tanks: Tank[] = [];
  const anchor = zoneAnchor(w, h);
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const x = snapLane(rand() * w, cell, w);
      const y = snapLane(rand() * h, cell, h);
      if (fadeAlpha(x, y, w, h) < TANK_ZONE_ALPHA) continue;
      // 与已有坦克保持一格间距，避免出生叠影。
      if (tanks.some((t) => Math.abs(t.x - x) < cell && Math.abs(t.y - y) < cell)) continue;
      tanks.push({
        x,
        y,
        dir: (Math.floor(rand() * 4) % 4) as Dir,
        speed: 10 + rand() * 6,
        age: rand() * 9,
        nextTurnAt: 4 + rand() * 5,
        rand: mulberry32((seed + i * 7919) | 0),
      });
      break;
    }
    void anchor;
  }
  return tanks;
}

/**
 * 规划一辆坦克的绘制指令：以车体中心为锚、按 dir 旋转 sprite，每个实体
 * 像素一条 rect。D21g：alpha 按语义单次烘焙为最终有效值（车身 0.45 /
 * 深档 0.55 / DSW 蓝点缀 0.62）；像素尺寸 cell/10（cell=30 → 3px/像素，
 * 全车 21×15px——比一期 2px/像素大半档，保证像素轮廓可辨识）。
 */
export function planTankOps(
  tank: Tank,
  cell: number,
  palette: BackdropPalette,
): StaticOp[] {
  const sprite = rotateSprite(TANK_SPRITE, tank.dir);
  const rows = sprite.length;
  const cols = sprite[0]?.length ?? 0;
  const px = Math.min(3, Math.max(2, Math.round(cell / 10)));
  const originX = tank.x - (cols * px) / 2;
  const originY = tank.y - (rows * px) / 2;
  const colorOf = (p: SpritePixel): string =>
    p === 1
      ? withAlpha(palette.label, TANK_BODY_ALPHA)
      : p === 2
        ? withAlpha(palette.label, TANK_DARK_ALPHA)
        : withAlpha(palette.brand, TANK_ACCENT_ALPHA);
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
