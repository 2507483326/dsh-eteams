/**
 * 背景板画布（docs/22-panel-tw-docs-style.md S22-4 / D20d）：backdropEngine
 * 纯计算的 canvas 薄壳——本组件只做接线，不含任何视觉算法：
 *
 * - 静层（网格 + 高地图）按 S22-3 指令序列画进**离屏 canvas**，仅
 *   resize / 换主题重绘（D20e 性能护栏：动画帧只画 ≤3 个坦克 sprite）；
 * - 动层 30fps（rAF + 帧间隔门槛），`document.hidden` 即暂停，
 *   `prefers-reduced-motion: reduce` 降为单帧静图（坦克停在初始位）；
 * - DPR 封顶 2（D20e）；画布级合成透明度 = COMPOSITE_ALPHA_CAP（D21g：
 *   恒 1.0——一期 0.5 全局减半与 palette 预烘焙、使用位系数三重叠乘后
 *   网格有效 alpha ~0.001 不可见，R2 验收后废除；「不喧宾夺主」改由
 *   引擎内各元素有效 alpha 定标保证，见 backdropEngine D21g 常量）；
 * - `pointer-events-none` + `aria-hidden`：不吃交互、不进无障碍树——
 *   背景板是纯装饰（D20e「不喧宾夺主」的 DOM 层保证）；
 * - 主题采样（D20h）：从作用域根元素 getComputedStyle 读 `--dsw-alias-*`，
 *   MutationObserver 监听 body 的 `data-ds-dark-theme` / `style` 翻转即重采样。
 *
 * 堆叠契约（eteamsView 接线，S22-4）：作用域根 inline `position:relative`
 * 承载本画布（absolute inset-0），SHELL_CLASS 加 `relative`——两个定位元素
 * 按 DOM 序 painting，壳自然盖在画布上。
 *
 * @module dsh-eteams/client/eteamsBackdrop
 */
import { useEffect, useRef, type ReactNode } from 'react';
import {
  COMPOSITE_ALPHA_CAP,
  createHeightField,
  createTanks,
  planStaticLayer,
  planTankOps,
  sampleBackdropPalette,
  stepTank,
  type BackdropPalette,
  type StaticOp,
  type Tank,
} from './backdropEngine';

/** 坦克数量上限（D20e：≤3）。 */
const TANK_COUNT = 3;
/** 网格尺寸（逻辑 px；官网 bg-grid 64px 的紧凑档，面板画布小一档）。 */
const CELL = 30;
/** 动层目标帧率（D20e：30fps 足够「缓慢移动」观感，省电）。 */
const FRAME_MIN_MS = 1000 / 30;
/** DPR 封顶（D20e）。 */
const DPR_CAP = 2;
/** 背景板确定性种子：全场景（高度场/坦克）同源，重放即复现。
 * docs/23 D21e：纯种子位保留一期 0x0ea5e9 数值（sky-500 致敬位）——
 * 只影响噪声/坦克布点随机序列，与绘制颜色无关（颜色采样见 D21e 改源）。 */
const BACKDROP_SEED = 0x0ea5e9;

/**
 * 面板背景板：零交互、零语义的装饰画布，渲染在面板内容之下。
 * 尺寸/主题/降运动全部自管理，调用方无需传任何 props。
 */
export function EteamsBackdrop(): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    let disposed = false;
    let raf = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let palette: BackdropPalette = sampleBackdropPalette(() => null);
    let staticOps: StaticOp[] = [];
    let tanks: Tank[] = [];
    let offscreen: HTMLCanvasElement | null = null;
    let lastT = 0;
    let lastRender = 0;
    let hidden = typeof document !== 'undefined' && document.hidden;
    let reduced =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;

    /** D20h：从作用域根（画布父元素）采样宿主变量，缺省落官网兜底。 */
    const readVar = (name: string): string | null => {
      const el = canvas.parentElement ?? document.body;
      const v = getComputedStyle(el).getPropertyValue(name);
      return v.trim() === '' ? null : v;
    };

    /** 重绘静层到离屏 canvas（仅 resize/换主题时调用）。 */
    const renderStatic = (): void => {
      if (w <= 0 || h <= 0) return;
      const heights = createHeightField(Math.ceil(w / CELL), Math.ceil(h / CELL), BACKDROP_SEED);
      staticOps = planStaticLayer(w, h, CELL, palette, heights);
      if (offscreen === null) offscreen = document.createElement('canvas');
      offscreen.width = Math.max(1, Math.round(w * dpr));
      offscreen.height = Math.max(1, Math.round(h * dpr));
      const octx = offscreen.getContext('2d');
      if (octx === null) return;
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx.clearRect(0, 0, w, h);
      for (const op of staticOps) {
        octx.fillStyle = op.color;
        octx.fillRect(op.x, op.y, op.w, op.h);
      }
    };

    /** 全量重规划：调色板 → 静层 → 坦克（同 seed 确定性重建）。 */
    const replan = (): void => {
      palette = sampleBackdropPalette(readVar);
      renderStatic();
      tanks = createTanks(TANK_COUNT, w, h, CELL, BACKDROP_SEED);
      drawFrame(true);
    };

    /** 画一帧：离屏静层 + 坦克 sprite。force=true 忽略帧间隔门槛。 */
    const drawFrame = (force: boolean): void => {
      const now = performance.now();
      if (!force && now - lastRender < FRAME_MIN_MS) return;
      lastRender = now;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (offscreen !== null) ctx.drawImage(offscreen, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const tank of tanks) {
        for (const op of planTankOps(tank, CELL, palette)) {
          ctx.fillStyle = op.color;
          ctx.fillRect(op.x, op.y, op.w, op.h);
        }
      }
    };

    const loop = (t: number): void => {
      if (disposed) return;
      raf = requestAnimationFrame(loop);
      if (hidden) return; // 页面隐藏：不推进物理也不重绘（D20e）
      const dt = lastT === 0 ? 0 : Math.min((t - lastT) / 1000, 0.1);
      lastT = t;
      for (const tank of tanks) stepTank(tank, dt, w, h, CELL);
      drawFrame(false);
    };

    /** 依据 reduced/hidden 状态启停主循环。 */
    const syncLoop = (): void => {
      cancelAnimationFrame(raf);
      lastT = 0;
      if (disposed || hidden) return;
      if (reduced) {
        drawFrame(true); // 降运动：单帧静图（坦克停在当前位）
        return;
      }
      raf = requestAnimationFrame(loop);
    };

    // 尺寸：画布 absolute inset-0 跟随作用域根，ResizeObserver 实测其盒。
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      const nextW = rect?.width ?? canvas.clientWidth;
      const nextH = rect?.height ?? canvas.clientHeight;
      if (nextW <= 0 || nextH <= 0) return;
      const nextDpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      if (Math.abs(nextW - w) < 0.5 && Math.abs(nextH - h) < 0.5 && nextDpr === dpr) return;
      w = nextW;
      h = nextH;
      dpr = nextDpr;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      replan();
    });
    ro.observe(canvas);

    // 主题（D20h）：body 的暗色标记或 inline 变量翻转 → 重采样重绘静层。
    const mo = new MutationObserver(() => {
      palette = sampleBackdropPalette(readVar);
      renderStatic();
      drawFrame(true);
    });
    if (typeof document !== 'undefined') {
      mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] });
    }

    // 降运动：媒体查询即时响应（用户改系统设置不重载也生效）。
    const reducedMq =
      typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const onReduced = (): void => {
      reduced = reducedMq?.matches ?? false;
      syncLoop();
    };
    reducedMq?.addEventListener('change', onReduced);

    const onVisibility = (): void => {
      hidden = document.hidden;
      syncLoop();
    };
    document.addEventListener('visibilitychange', onVisibility);

    syncLoop();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      reducedMq?.removeEventListener('change', onReduced);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{ opacity: COMPOSITE_ALPHA_CAP }}
    />
  );
}
