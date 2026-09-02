/**
 * The smart entry into the 团队面板 plus its full-page surface.
 *
 * The host renders the real conversation mode (the 对话/团队 tab ring and the
 * view area) only after the current session has left the pristine blank
 * state — and that phase machine flips exclusively through a real
 * `Session.prompt()` (the sticky promptAttempted flag; slash commands and
 * every other plugin-reachable API leave it untouched, and auto-sending a
 * prompt is off the table). A plugin therefore cannot make the host show its
 * tab ring on the not-started screen. {@link enterTeamsPanel} picks the
 * landing surface instead:
 *
 * 1. the real 团队 tab when it is visible (in-conversation) — the sanctioned
 *    `actions.setView` path;
 * 2. otherwise the full-page 团队页: the whole {@link ETeamsView} on a
 *    plugin-owned fixed layer that fills the app's CONTENT PANE — measured
 *    live from the hero row's ancestor chain, so the page never covers the
 *    host's left rail or top chrome. Own top strip （返回 button, Esc to
 *    leave）; the panel fills the remaining width (block wrapper — the view
 *    root is a fluid flex row, not a fixed-width card). This is what the
 *    hero button（标准模式 neighbor）and the composer popup land on while the
 *    conversation has not started.
 *
 * Pending jump signals (新增团队 / 新增角色 / select-team) are staged BEFORE
 * either surface opens, so the panel consumes them on mount — the same
 * mount-time consumption pattern as openMemberBuilder (docs/19.16).
 *
 * S11 样式迁移（docs/21-client-ui-stack.md 21.6 / D19b/D19c）：全屏页的
 * inline style 迁 Tailwind 类。pane 矩形（left/top/width/height）是实时测量
 * 的动态值，保留 inline style；静态面（层级/布局/底色/顶栏/内容包裹）全部
 * 工具类化。D19b 作用域机制：`important: '.eteams-ui'` 把工具类编译成后代
 * 选择器（`.eteams-ui .utility`）——作用域根自身不承样式，故页面外包一层裸
 * `.eteams-ui` 包裹根（页面挂在 body 下的独立 React 根，自带作用域），固定
 * 定位层作为其后代承载全部工具类。底色沿用原 bg-base 档（shadcn --background
 * 是 layer-1，任意值直引保持视觉）；返回按钮换 shadcn Button（S5 card 先例，
 * 显式 type="button"）。pane 测量、Esc/resize 监听与降级投递逐字保留。
 *
 * @module dsh-eteams/client/teamsPanel
 */
import { useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
// lucide 深层图标导入（dialog.tsx 先例：深层 .mjs 只进用到的图标）。
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left.mjs';
import { activateETeamsTab, stageTeamSignals, teamsTabVisible } from './bridge';
import { Button } from './components/ui/button';
import { ClientErrorBoundary, recordClientDiag } from './diagnostics';
import { ETeamsView } from './eteamsView';
import { HERO_ROW_SELECTOR } from './heroTeamsButton';
import { getApp } from './store/app';

/** Landing options for {@link enterTeamsPanel}: which panel view to open. */
export interface TeamsPanelOptions {
  /** Land on the 团队 tab (its page hosts the 新建团队 form). */
  readonly creator?: boolean;
  /** Open the 新增角色 flow (panel 角色 tab with the build workbench). */
  readonly memberBuilder?: boolean;
  /** Land on the 角色 tab (roster page, no add form). */
  readonly roster?: boolean;
  /** Select this team after landing (teamId). */
  readonly teamId?: string;
}

let overlayRoot: { render: (node: ReactNode) => void; unmount: () => void } | null = null;
let overlayContainer: HTMLDivElement | null = null;

/**
 * Enter the 团队面板: stage the requested signals, then activate the real
 * 团队 tab when the host renders it visibly, else open the full-page
 * 团队页.
 */
export function enterTeamsPanel(opts: TeamsPanelOptions = {}): void {
  stageTeamSignals(opts);
  if (teamsTabVisible()) {
    activateETeamsTab();
    return;
  }
  openTeamsOverlay();
}

/**
 * Open the full-page 团队页 (idempotent while open): the full ETeamsView on
 * a plugin-owned fixed layer inset to the measured content pane, mounted
 * through a lazy React root on `<body>` so it works on the not-started
 * screen where the host view ring does not render. The root is kept for the
 * page lifetime; closing just renders null.
 */
function openTeamsOverlay(): void {
  if (typeof document === 'undefined') return;
  try {
    if (overlayContainer === null) {
      overlayContainer = document.createElement('div');
      overlayContainer.setAttribute('data-eteams', 'overlay-root');
      document.body.appendChild(overlayContainer);
    }
    if (overlayRoot === null) overlayRoot = createRoot(overlayContainer);
    overlayRoot.render(
      <ClientErrorBoundary label="团队页">
        <TeamsOverlay onClose={() => overlayRoot?.render(null)} />
      </ClientErrorBoundary>,
    );
  } catch (error) {
    recordClientDiag('overlay', error instanceof Error ? error.message : String(error));
  }
}

/** A viewport-anchored rectangle in plain numbers (fixed positioning input). */
interface PaneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const windowRect = (): PaneRect => ({
  left: 0,
  top: 0,
  width: window.innerWidth,
  height: window.innerHeight,
});

/**
 * Measure the app's content pane live: walk up from the hero row (the only
 * reliable not-started landmark) to the widest ancestor that is NOT the
 * full-window app shell. That ancestor is the conversation pane — already
 * inset by the host's left rail and top chrome — so the page docks to it
 * without covering either. Falls back to the whole window when no hero row
 * exists or the pane itself spans the window.
 */
function measurePane(): PaneRect {
  const full = windowRect();
  try {
    const row = document.querySelector(HERO_ROW_SELECTOR);
    let el: HTMLElement | null = row instanceof HTMLElement ? row : null;
    let best: PaneRect | null = null;
    while (el !== null) {
      const r = el.getBoundingClientRect();
      const shell =
        r.left <= 1 && r.top <= 1 && r.right >= full.width - 1 && r.bottom >= full.height - 1;
      if (shell) break;
      if (r.width >= 320 && r.height >= 200 && (best === null || r.width > best.width)) {
        best = { left: r.left, top: r.top, width: r.width, height: r.height };
      }
      el = el.parentElement;
    }
    return best ?? full;
  } catch (error) {
    recordClientDiag('overlay-pane', error instanceof Error ? error.message : String(error));
    return full;
  }
}

/**
 * The full-page 团队页: a fixed layer inset to the measured content pane
 * (opaque app background, own top strip) — reads as a page switch, never
 * covers the host's left rail or top chrome, and re-docks on window resize.
 */
function TeamsOverlay({ onClose }: { onClose: () => void }): ReactNode {
  const [pane, setPane] = useState<PaneRect>(measurePane);
  useEffect(() => {
    const onResize = (): void => {
      setPane(measurePane());
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    /* R2-F2（docs/21 21.5.3）：表面根包 Provider——单例 store，多 Provider
    同 store 无害；内嵌 ETeamsView 自带同 store Provider，嵌套无副作用。
    表面根（D19b/S11）：.eteams-ui 作用域根——工具类经后代选择器作用于
    子树，根自身不承工具类样式（页面在 body 下独立 React 根，自带作用域）。 */
    <Provider store={getApp().store}>
      <div className="eteams-ui">
        <div
          role="dialog"
          aria-modal="true"
          aria-label="团队"
          data-eteams="overlay-page"
          /* S24-2（D22f）：整页底改语义 token --background（官网 v3 值：亮
            白 / 暗 slate-900，不再直引 bg-base 别名）。 */
          className="fixed z-[1000] flex flex-col bg-background text-foreground"
          style={{ left: pane.left, top: pane.top, width: pane.width, height: pane.height }}
        >
          {/* 官网顶栏（S24-2）：--border 细线 + 白底条；左标题（官网条内
            14px semibold 签名）+ 右 ghost 返回钮（lucide ArrowLeft）。 */}
          <header className="flex h-11 flex-none items-center justify-between gap-2.5 border-b border-solid border-[color:var(--border)] bg-background px-4">
            <span className="text-sm font-semibold text-foreground">团队</span>
            <Button type="button" variant="ghost" size="sm" className="text-sm" onClick={onClose}>
              <ArrowLeft className="h-3.5 w-3.5" />
              返回
            </Button>
          </header>
          {/* Plain block wrapper: the view root is `height:100%` + flex row and
        has no width of its own — a block parent lets it fill the pane width
        instead of shrink-wrapping to its content (the "定死宽度" artifact).
        overflow hidden keeps tall content scrolling inside the view column —
        never spilling to the document (横向滚动条治理). */}
          <div className="min-h-0 flex-1 overflow-hidden">
            {/* The panel only reads sessionId/inputActions off its slot props; the
          page has neither (no session on the not-started screen), so a minimal
          share is cast in — the panel degrades to the all-teams pool and
          clipboard prefill, both sanctioned fallbacks. */}
            <ETeamsView {...({ sessionId: undefined } as unknown as ConvViewProps)} />
          </div>
        </div>
      </div>
    </Provider>
  );
}
