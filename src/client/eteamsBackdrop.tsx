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
 * - **可视区锚定（D27，用户迭代「角色详情背景变化」）**：画布改挂 0 高
 *   sticky 条（top:0）内、位图按**可视高度**（面板根高与最近滚动/裁剪祖先
 *   高取 min）规划。根因：宿主 active 相位 `.wSkVaW_viewArea{flex:1 0 auto;
 *   min-height:auto}` 随内容生长——长手册把面板根从 720px 拉到 2600px+，
 *   旧 `absolute/inset-0` 画布跟着拉长，RO 实测新尺寸后整幅重排（高度场/
 *   渐隐全部按新盒重算），进出角色详情即见背景「变形/漂移」；锚定后位图
 *   尺寸恒等于主页面（同宽同高同 cell ⇒ 同种子逐像素一致），sticky 保证长
 *   页滚动时水印钉在可视区右上（与主页面观感一致）；
 * - **鼠标格子微光（D24-1，取代外扩环波纹）**：pointermove 挂作用域根
 *   （canvas 自身保持 pointer-events-none 不吃交互），节流（≥90ms 且位移
 *   ≥24px）向热场 splat——格子本身微亮再指数退热，无新增图形元素；热场空
 *   即停帧；reduced-motion / 页面隐藏时不生成；
 * - DPR 封顶 2（D20e）；画布级合成透明度 = COMPOSITE_ALPHA_CAP（恒 1.0）；
 * - **壳自愈（D22g-6 保留）**：① MO palette 相等短路 + 150ms 防抖；② rAF
 *   重排到 hidden 检查之后；③ 1s 看门狗（lastRender > 2500ms：context lost
 *   即 replan，否则强制推帧）——波纹常驻期之外 loop 空闲，看门狗照常兜底；
 * - `pointer-events-none` + `aria-hidden`：不吃交互、不进无障碍树——
 *   背景板是纯装饰（D20e「不喧宾夺主」的 DOM 层保证）；
 * - 主题采样（D22g-7）：从作用域根元素 getComputedStyle 读
 *   `--eteams-backdrop-label` / `--eteams-backdrop-accent`。
 *
 * 堆叠契约（eteamsView 接线，S22-4）：作用域根 inline `position:relative` 承载
 * 本画布（画布内联 absolute 挂 0 高 sticky 条下——D25：宿主内工具类定位失效
 * 的根因修复，定位必须内联），SHELL_CLASS 加 `relative`——sticky 条与壳都是
 * 定位元素、按 DOM 序 painting，壳自然盖在画布上。
 *
 * @module dsh-eteams/client/eteamsBackdrop
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { recordClientDiag } from './diagnostics';
import {
  COMPOSITE_ALPHA_CAP,
  createHeightField,
  createTanks,
  decayHeat,
  planHeatOps,
  planStaticLayer,
  sampleBackdropPalette,
  splatHeat,
  stepTanks,
  nowMs,
  type BackdropPalette,
  type HeatField,
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
    let heat: HeatField = new Map();
    let offscreen: HTMLCanvasElement | null = null;
    let lastT = 0;
    let lastRender = 0;
    let hidden = typeof document !== 'undefined' && document.hidden;
    let reduced =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;

    // 作用域根与滚动宿主（D27）：画布的直接父元素是 0 高 sticky 条，变量
    // 采样 / 事件监听 / 尺寸测量都要落到真正的面板根（.eteams-ui）；可视
    // 高度取「面板根高」与「最近滚动/裁剪祖先高」的较小者——宿主 active
    // 相位下面板根会随内容生长（角色详情长手册），只有滚动宿主（host
    // scrollBody / overlay 裁剪层）代表真正可见的区域。
    const scopeEl =
      canvas.closest<HTMLElement>('.eteams-ui') ?? canvas.parentElement ?? document.body;
    const findScrollHost = (el: HTMLElement): HTMLElement | null => {
      let cur: HTMLElement | null = el.parentElement;
      while (cur !== null) {
        const oy = getComputedStyle(cur).overflowY;
        if (oy === 'auto' || oy === 'scroll' || oy === 'hidden') return cur;
        cur = cur.parentElement;
      }
      return null;
    };
    const scrollHost = findScrollHost(scopeEl);

    /** D20h：从作用域根采样宿主变量，缺省落官网兜底。 */
    const readVar = (name: string): string | null => {
      const v = getComputedStyle(scopeEl).getPropertyValue(name);
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

    /** 全量重规划：调色板 → 静层 → 坦克（同 seed 确定性重建）。热键随 cell
     * 变化失效（D24-1：resize 即清空热场，退热中的微光随重绘自然消失）。 */
    const replan = (): void => {
      palette = sampleBackdropPalette(readVar);
      renderStatic();
      tanks = createTanks(TANK_COUNT, w, h, cell, BACKDROP_SEED);
      heat = new Map();
      drawFrame(true);
    };

    /** 画一帧：离屏静层 + 格子微光叠加（坦克 D23-4 下架后动层只剩热场）。 */
    const drawFrame = (force: boolean): void => {
      const now = nowMs();
      if (!force && now - lastRender < FRAME_MIN_MS) return;
      lastRender = now;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (offscreen !== null) ctx.drawImage(offscreen, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const op of planHeatOps(heat, cell, w, h, palette)) {
        ctx.fillStyle = op.color;
        ctx.fillRect(op.x, op.y, op.w, op.h);
      }
    };

    const loop = (t: number): void => {
      if (disposed) return;
      if (hidden) return; // 页面隐藏：不推进物理也不重绘、不累积 rAF（D22g-6）
      raf = requestAnimationFrame(loop);
      const dt = lastT === 0 ? 0 : Math.min((t - lastT) / 1000, 0.1);
      lastT = t;
      stepTanks(tanks, dt, w, h, cell);
      heat = decayHeat(heat, dt);
      // 热场熄灭（且无坦克）→ 停帧省电（D24-1 按需循环）。
      if (heat.size === 0 && tanks.length === 0) {
        cancelAnimationFrame(raf);
        raf = 0;
        drawFrame(false);
        return;
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

    // 尺寸（D27 重构）：位图按**可视区**规划——宽取作用域根，高 = min(作用
    // 域根高, 滚动宿主可视高)（无滚动宿主时兜底文档可视高）。**定位必须内
    // 联**：D25 诊断——宿主内工具类定位未生效（画布落回 UA 内联块 300×150 =
    // 用户看到的「左侧一小块」；预览页 gen.css 作用域正常故无法复现）。内联
    // 样式免疫宿主 CSS 上下文，class 仅作语义标记。RO 同时盯作用域根（宽/
    // 内容高）与滚动宿主（可视高）：进出角色详情只把根拉高、不改 min 结果
    // → 尺寸守卫短路，位图零重排——背景与主页面逐像素一致（D27 验收口径）。
    const measure = (): void => {
      const nextW = scopeEl.clientWidth;
      const rootH = scopeEl.clientHeight;
      const hostH =
        scrollHost !== null
          ? scrollHost.clientHeight
          : typeof document !== 'undefined'
            ? document.documentElement.clientHeight
            : rootH;
      const nextH = Math.min(rootH, hostH);
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
      canvas.style.height = `${h}px`; // sticky 条 0 高，CSS 高度不能再吃 100%
      replan();
    };
    const ro = new ResizeObserver(() => measure());
    measure(); // 同步首测（挂载帧内即定尺寸，RO 首回调幂等短路）
    ro.observe(scopeEl);
    if (scrollHost !== null) ro.observe(scrollHost);
    // 一次性几何诊断（recordClientDiag）：RO 后画布/根/滚动宿主实测——若宿
    // 主内再次出现「左侧一小块」或背景漂移，日志直接给出三者，定位不靠猜。
    const diagTimer = setTimeout(() => {
      recordClientDiag(
        'backdrop-geom',
        `canvas=${canvas.clientWidth}x${canvas.clientHeight} ` +
          `attr=${canvas.getAttribute('style') ?? ''} ` +
          `root=${scopeEl.clientWidth}x${scopeEl.clientHeight} ` +
          `scroll=${scrollHost === null ? 'none' : `${scrollHost.clientWidth}x${scrollHost.clientHeight}`}`,
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

    // 鼠标格子微光（D24-1）：监听挂**作用域根**（canvas 自身 pointer-events-
    // none 不吃交互，事件天然穿到内容层——这里收的是面板内任意位置的扫过；
    // D27 起直接父元素是 0 高 sticky 条，不能当事件面）。
    // 节流：距上次落点 ≥90ms 且位移 ≥24px 才 splat 一粒（快速扫过 ~10 粒、
    // 悬停不动 0 粒）。reduced-motion / 页面隐藏时不生成（静板）。落点即按需
    // 启动 rAF 循环；replan 后 cell 可能变化，热场按新 cell 键重建前直接清空。
    const HEAT_MIN_INTERVAL_MS = 90;
    const HEAT_MIN_DIST_PX = 24;
    let lastHeatAt = 0;
    let lastHeatX = -1e9;
    let lastHeatY = -1e9;
    const onPointerMove = (event: PointerEvent): void => {
      if (disposed || hidden || reduced) return;
      if (event.pointerType === 'touch') return;
      const now = nowMs();
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const dist = Math.hypot(x - lastHeatX, y - lastHeatY);
      if (now - lastHeatAt < HEAT_MIN_INTERVAL_MS || dist < HEAT_MIN_DIST_PX) return;
      lastHeatAt = now;
      lastHeatX = x;
      lastHeatY = y;
      heat = splatHeat(heat, x, y, cell, w, h);
      if (raf === 0 && !disposed) {
        lastT = 0;
        raf = requestAnimationFrame(loop);
      }
    };
    scopeEl.addEventListener('pointermove', onPointerMove);

    // 看门狗（D22g-6 / R4 兜底）：可见且未降运动而 lastRender 静止超阈值，
    // 先辨上下文丢失（丢则全量 replan 重建），否则强制推帧（lastT=0 ⇒ 下帧
    // dt=0，物理无跳变）。**空闲豁免**：热场空且静层已画过（动层无内容）时
    // 停帧是 D24-1 的设计态，不算 stall——只对「动层非空却静止」或「静层
    // 尚未画过」自愈。
    const watchdog = setInterval(() => {
      if (disposed || hidden || reduced) return;
      if (heat.size === 0 && tanks.length === 0 && offscreen !== null) return;
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
      scopeEl.removeEventListener('pointermove', onPointerMove);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      data-eteams="backdrop-pin"
      // 0 高 sticky 条（D27）：占位为零不挤内容；画布 absolute 挂其下并随
      // 滚动钉在可视区顶部——长页（角色详情）滚动时水印保持主页面「右上角」
      // 观感，不再随内容拉长/重排。
      style={{ position: 'sticky', top: 0, height: 0 }}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        data-eteams="backdrop"
        className="pointer-events-none eteams-backdrop-canvas"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          opacity: COMPOSITE_ALPHA_CAP,
        }}
      />
    </div>
  );
}
