/**
 * 背景板画布（docs/25 S25-1 / D23；前承 docs/24 S24-3 / D22g）：
 * backdropEngine 纯计算的 canvas 薄壳——本组件只做接线，不含任何视觉算法：
 *
 * - 静层（网格 + 高地图）按引擎指令序列画进**离屏 canvas**，仅 resize /
 *   换主题重绘（D20e 性能护栏）；
 * - **水印化（D23-3）**：网格 α 0.05 / 高地图 0.03–0.10——远看是纹理、
 *   不与正文争读；
 * - **渐隐收紧（D23-2）**：FADE 0.10/0.40——可见区 ≈16%，「有东西」严格
 *   压回页面右上角，左下大片留白；
 * - **格子细腻化（D23-1）**：cellFor(w) 宽 <600 → 12，否则 14（D22g 的
 *   24/20 用户仍嫌大）；
 * - **坦克暂时下架（D23-4）**：TANK_COUNT=0——引擎坦克代码全量保留
 *   （含其全部测试锁），改回常量即恢复；
 * - **鼠标波纹（D23-5）**：pointermove 挂画布父元素（canvas 自身保持
 *   pointer-events-none 不吃交互），节流（≥90ms 且位移 ≥24px）落点；
 *   有活波纹才跑 rAF（30fps），全部消亡即停帧；reduced-motion / 页面
 *   隐藏时不生成波纹；
 * - DPR 封顶 2（D20e）；画布级合成透明度 = COMPOSITE_ALPHA_CAP（恒 1.0）；
 * - **壳自愈（D22g-6 保留）**：① MO palette 相等短路 + 150ms 防抖；② rAF
 *   重排到 hidden 检查之后；③ 1s 看门狗（lastRender > 2500ms：context lost
 *   即 replan，否则强制推帧）——波纹常驻期之外 loop 空闲，看门狗照常兜底；
 * - `pointer-events-none` + `aria-hidden`：不吃交互、不进无障碍树——
 *   背景板是纯装饰（D20e「不喧宾夺主」的 DOM 层保证）；
 * - 主题采样（D22g-7）：从作用域根元素 getComputedStyle 读
 *   `--eteams-backdrop-label` / `--eteams-backdrop-accent`。
 *
 * 堆叠契约（eteamsView 接线，S22-4）：作用域根 inline `position:relative`
 * 承载本画布（内联 absolute/inset，D25：宿主内工具类定位失效的根因修复），
 * SHELL_CLASS 加 `relative`——两个定位元素按 DOM 序 painting，壳自然盖在
 * 画布上。
 *
 * @module dsh-eteams/client/eteamsBackdrop
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { recordClientDiag } from './diagnostics';
import {
  COMPOSITE_ALPHA_CAP,
  createHeightField,
  createTanks,
  planRippleOps,
  planStaticLayer,
  rippleDead,
  sampleBackdropPalette,
  stepTanks,
  nowMs,
  type BackdropPalette,
  type Ripple,
  type StaticOp,
  type Tank,
} from './backdropEngine';

/**
 * 坦克数量（docs/25 D23-4：暂时下架 = 0；引擎与测试锁全量保留，改回 3 即恢复）。
 */
const TANK_COUNT = 0;
/** 网格尺寸（D23-1）：面板宽 <600 → 12，否则 14（D22g 24/20 仍嫌大）。 */
function cellFor(w: number): number {
  return w > 0 && w < 600 ? 12 : 14;
}
/** 动层目标帧率（D20e：30fps 足够「缓慢移动」观感，省电）。 */
const FRAME_MIN_MS = 1000 / 30;
/** DPR 封顶（D20e）。 */
const DPR_CAP = 2;
/** 背景板确定性种子：全场景（高度场/坦克）同源，重放即复现。
 * docs/23 D21e：纯种子位保留一期 0x0ea5e9 数值（sky-500 致敬位）——
 * 只影响噪声/坦克布点随机序列，与绘制颜色无关（颜色采样见 D21e 改源）。 */
const BACKDROP_SEED = 0x0ea5e9;
/** 主题防抖（D22g-6）：palette 变化后 150ms 尾随合并再重绘静层。 */
const THEME_DEBOUNCE_MS = 150;
/** 看门狗周期 / 静止判定阈值（D22g-6）：可见态 lastRender 超 2500ms 即自愈。 */
const WATCHDOG_INTERVAL_MS = 1000;
const WATCHDOG_STALL_MS = 2500;

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
    let cell = 14;
    let palette: BackdropPalette = sampleBackdropPalette(() => null);
    let staticOps: StaticOp[] = [];
    let tanks: Tank[] = [];
    let ripples: Ripple[] = [];
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
      const heights = createHeightField(Math.ceil(w / cell), Math.ceil(h / cell), BACKDROP_SEED);
      staticOps = planStaticLayer(w, h, cell, palette, heights);
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
      tanks = createTanks(TANK_COUNT, w, h, cell, BACKDROP_SEED);
      drawFrame(true);
    };

    /** 画一帧：离屏静层 + 活波纹（坦克 D23-4 下架后动层只剩波纹）。 */
    const drawFrame = (force: boolean): void => {
      const now = nowMs();
      if (!force && now - lastRender < FRAME_MIN_MS) return;
      lastRender = now;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (offscreen !== null) ctx.drawImage(offscreen, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const ripple of ripples) {
        for (const op of planRippleOps(ripple, now, w, h, palette)) {
          ctx.fillStyle = op.color;
          ctx.fillRect(op.x, op.y, op.w, op.h);
        }
      }
    };

    const loop = (t: number): void => {
      if (disposed) return;
      if (hidden) return; // 页面隐藏：不推进物理也不重绘、不累积 rAF（D22g-6）
      raf = requestAnimationFrame(loop);
      const dt = lastT === 0 ? 0 : Math.min((t - lastT) / 1000, 0.1);
      lastT = t;
      stepTanks(tanks, dt, w, h, cell);
      // 波纹消亡即清理；全空（且无坦克）→ 停帧省电（D23-5 按需循环）。
      if (ripples.length > 0) {
        const now = nowMs();
        ripples = ripples.filter((r) => !rippleDead(r, now));
        if (ripples.length === 0 && tanks.length === 0) {
          cancelAnimationFrame(raf);
          raf = 0;
          drawFrame(false);
          return;
        }
      }
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

    // 尺寸：画布跟随作用域根（resize 由 RO 实测其盒）。**定位必须内联**：
    // D25 诊断——宿主内 absolute/inset-0 工具类未生效（画布落回 UA 内联块
    // 300×150 = 用户看到的「左侧一小块」；预览页 gen.css 作用域正常故无法
    // 复现）。内联样式免疫宿主 CSS 上下文，class 仅作语义标记。
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      const nextW = rect?.width ?? canvas.clientWidth;
      const nextH = rect?.height ?? canvas.clientHeight;
      if (nextW <= 0 || nextH <= 0) return;
      const nextDpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      const nextCell = cellFor(nextW);
      if (
        Math.abs(nextW - w) < 0.5 &&
        Math.abs(nextH - h) < 0.5 &&
        nextDpr === dpr &&
        nextCell === cell
      ) {
        return;
      }
      w = nextW;
      h = nextH;
      dpr = nextDpr;
      cell = nextCell;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      replan();
    });
    ro.observe(canvas.parentElement ?? canvas);
    // 一次性几何诊断（recordClientDiag）：RO 首回调后画布/父盒尺寸——若宿主
    // 内再次出现「左侧一小块」，日志直接给出三者实测，定位问题不再靠猜。
    const diagTimer = setTimeout(() => {
      const parent = canvas.parentElement;
      recordClientDiag(
        'backdrop-geom',
        `canvas=${canvas.clientWidth}x${canvas.clientHeight} ` +
          `attr=${canvas.getAttribute('style') ?? ''} ` +
          `parent=${parent?.clientWidth ?? -1}x${parent?.clientHeight ?? -1}`,
      );
    }, 2000);

    // 主题（D20h → D22g-6）：palette 相等即短路（宿主 style 抖动零成本）；
    // 真变化 150ms 尾随防抖合并后重绘静层。
    let themeTimer: ReturnType<typeof setTimeout> | null = null;
    const mo = new MutationObserver(() => {
      const next = sampleBackdropPalette(readVar);
      if (next.label === palette.label && next.brand === palette.brand) return;
      palette = next;
      if (themeTimer !== null) clearTimeout(themeTimer);
      themeTimer = setTimeout(() => {
        themeTimer = null;
        if (disposed) return;
        renderStatic();
        drawFrame(true);
      }, THEME_DEBOUNCE_MS);
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

    // 鼠标波纹（D23-5）：监听挂画布**父元素**（canvas 自身 pointer-events-none
    // 不吃交互，事件天然穿到内容层——这里收的是面板内任意位置的扫过）。节流：
    // 距上次落点 ≥90ms 且位移 ≥24px 才落一粒（快速扫过 ~10 粒、悬停不动 0 粒）。
    // reduced-motion / 页面隐藏时不生成（静板）。落点即按需启动 rAF 循环。
    const RIPPLE_MIN_INTERVAL_MS = 90;
    const RIPPLE_MIN_DIST_PX = 24;
    let lastRippleAt = 0;
    let lastRippleX = -1e9;
    let lastRippleY = -1e9;
    const parentEl = canvas.parentElement ?? canvas;
    const onPointerMove = (event: PointerEvent): void => {
      if (disposed || hidden || reduced) return;
      if (event.pointerType === 'touch') return;
      const now = nowMs();
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const dist = Math.hypot(x - lastRippleX, y - lastRippleY);
      if (now - lastRippleAt < RIPPLE_MIN_INTERVAL_MS || dist < RIPPLE_MIN_DIST_PX) return;
      lastRippleAt = now;
      lastRippleX = x;
      lastRippleY = y;
      ripples.push({ x, y, born: now });
      if (ripples.length > 12) ripples = ripples.slice(-12); // 极端快扫兜底
      if (raf === 0 && !disposed) {
        lastT = 0;
        raf = requestAnimationFrame(loop);
      }
    };
    parentEl.addEventListener('pointermove', onPointerMove);

    // 看门狗（D22g-6 / R4 兜底）：可见且未降运动而 lastRender 静止超阈值，
    // 先辨上下文丢失（丢则全量 replan 重建），否则强制推帧（lastT=0 ⇒ 下帧
    // dt=0，物理无跳变）。**空闲豁免**：波纹/坦克皆空且静层已画过（动层无
    // 内容）时停帧是 D23-5 的设计态，不算 stall——只对「动层非空却静止」
    // 或「静层尚未画过」自愈。
    const watchdog = setInterval(() => {
      if (disposed || hidden || reduced) return;
      if (ripples.length === 0 && tanks.length === 0 && offscreen !== null) return;
      if (performance.now() - lastRender <= WATCHDOG_STALL_MS) return;
      if (ctx.isContextLost()) replan();
      else {
        lastT = 0;
        drawFrame(true);
      }
    }, WATCHDOG_INTERVAL_MS);

    syncLoop();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearInterval(watchdog);
      clearTimeout(diagTimer);
      if (themeTimer !== null) clearTimeout(themeTimer);
      ro.disconnect();
      mo.disconnect();
      reducedMq?.removeEventListener('change', onReduced);
      document.removeEventListener('visibilitychange', onVisibility);
      parentEl.removeEventListener('pointermove', onPointerMove);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-eteams="backdrop"
      className="pointer-events-none eteams-backdrop-canvas"
      style={{
        position: 'absolute',
        inset: '0',
        width: '100%',
        height: '100%',
        opacity: COMPOSITE_ALPHA_CAP,
      }}
    />
  );
}
