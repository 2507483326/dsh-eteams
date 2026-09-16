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
 * 1. the real 团队 tab when it is **usable**（会话已开始且标签环真能用，
 *    {@link teamsTabUsable}）——the sanctioned `actions.setView` path;
 * 2. otherwise the full-page 团队页: the whole {@link ETeamsView} on a
 *    plugin-owned fixed layer that fills the app's CONTENT PANE — measured
 *    live from the hero row's ancestor chain, so the page never covers the
 *    host's left rail or top chrome. Own top strip （返回 button, Esc to
 *    leave）; the panel fills the remaining width (block wrapper — the view
 *    root is a fluid flex row, not a fixed-width card). This is what the
 *    hero button（标准模式 neighbor）and the composer popup land on while the
 *    conversation has not started.
 *
 * 未开始屏（hero 行在）一律走 2：用户 2026-09-16 报「点击对话框上面的 标准模式
 * 旁边的 团队」表现为「没反应」——hero 屏上宿主标签环也能通过 offsetParent
 * 可见性探测，点它会把面板挂进用户看不见的会话视图面；改由 {@link teamsTabUsable}
 * 把关后，这块屏上的入口必定落我们自己的覆盖层（并带落点路径，见
 * lib/bridge 的 pendingLandingPath）。
 *
 * 层级（用户反馈 2026-09：设置弹窗被拦）：页面用 z-[500]——压过宿主内容层
 * （conversation/hero 均 z-auto），但低于宿主模态层（dsh-client-ui-primitives
 * Modal.module.css `.root` z-index:1000，宿主左下角设置弹窗即此档）：宿主
 * 弹窗开在整页团队页之上，遮罩顺带压暗页面（标准模态表现）。宿主浮层
 * （Menu/Tooltip/HoverCard z-100）虽低于页面，但页面打开时内容窗格已被盖住、
 * 窗格内宿主浮层无从触发；左栏（页面不覆盖）的浮层几何上不与页面重叠。
 * 宿主层级台账：内容 z-auto < 浮层 100 < 模态 1000 < toast/onboarding 1100
 * （primitives 各 module.css 实测）。
 *
 * Pending jump signals (新增角色 / 新增团队 / select-team) are staged BEFORE
 * either surface opens, so the panel consumes them on mount — the same
 * mount-time consumption pattern as openMemberBuilder (docs/19.16). The landing
 * page itself no longer rides on those one-shot flags: {@link stageTeamSignals}
 * also stages the entry's target path and the panel's MemoryRouter consumes it
 * at mount（用户 2026-09-16「点击对话框上面的 标准模式 旁边的 团队，应该跳面板
 * 页面」——先前落点只走一次性标记，被别的已挂载表面先消费就退化成「恢复上次
 * 页签」，整页团队页因此落在别的页签）。
 * （新增团队只走「落团队页」信号、不自开新增弹窗——用户反馈 2026-09：一进
 * 团队页就弹新增弹窗很突兀，创建入口收敛为团队页头右上角的「＋ 新增团队」
 * 按钮。用户 2026-09-15「点新增团队没有跳到对应的团队卡片」补齐该导航信号；
 * 2026-09-16 起同一条落点由路由直接消费，见 lib/bridge 的 pendingLandingPath。）
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
 * M6 结构性改造（docs/44 44.3，行为零变更）：44.3 横幅分区；覆盖层视图的
 * 静态面类名收编 OVERLAY_PAGE_CLASS/OVERLAY_HEADER_CLASS（样式类区，逐字
 * 面量）——覆盖层视图无状态切换三元可查表（TeamsOverlay 为纯静态 chrome +
 * ETeamsView 出口，见验收记录），pane 矩形动态 inline style 原样保留；
 * z-[500] 层级与 portal 行为不动。
 *
 * @module dsh-eteams/client/teamsPanel
 */
import { useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
// lucide 深层图标导入（dialog.tsx 先例：深层 .mjs 只进用到的图标）。
import {
  CLOSE_TEAMS_PAGE_EVENT,
  activateETeamsTab,
  stageTeamSignals,
  teamsTabUsable,
} from '../lib/bridge';
import { errorMessageOf } from '../lib/errors';
import { BackButton } from '../components/backButton';
import { ClientErrorBoundary, recordClientDiag } from '../lib/diagnostics';
import { ETeamsView } from '../pages/teamsView/index';
import { HERO_ROW_SELECTOR } from './heroTeamsButton';
import { getApp } from '../store/app';

/** ================================== 类型 ================================== */

/** Landing options for {@link enterTeamsPanel}: which panel view to open. */
export interface TeamsPanelOptions {
  /** Open the 新增角色 flow (panel 角色 tab with the build workbench). */
  readonly memberBuilder?: boolean;
  /** Land on the 角色 tab (roster page, no add form). */
  readonly roster?: boolean;
  /** Land on the 团队 tab (team card grid, no add form). */
  readonly team?: boolean;
  /** Select this team after landing (teamId). */
  readonly teamId?: string;
  /** Land on the Tasks page for this task（/tasks/:taskId）. */
  readonly taskId?: number;
}

/** A viewport-anchored rectangle in plain numbers (fixed positioning input). */
interface PaneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** ================================== 样式类 ================================== */

/* 整页覆盖层的静态面（S11 迁移 + M6 收编，逐字面量）：固定层（z-[500] 层级
   见文件头台账）与官网顶栏（--border 细线 + 白底条）。pane 矩形是实时测量
   的动态值，保留 inline style 不入类。 */
const OVERLAY_PAGE_CLASS = 'fixed z-[500] flex flex-col bg-background text-foreground';
const OVERLAY_HEADER_CLASS =
  'flex h-11 flex-none items-center justify-between gap-2.5 border-b border-solid border-[color:var(--border)] bg-background px-4';

/** ================================== 工具函数 ================================== */

let overlayRoot: { render: (node: ReactNode) => void; unmount: () => void } | null = null;
let overlayContainer: HTMLDivElement | null = null;

/**
 * Enter the 团队面板: stage the requested signals, then activate the real
 * 团队 tab when the host renders it **usably**, else open the full-page
 * 团队页.
 *
 * 判据是 {@link teamsTabUsable}（未开始屏一律不算可用）而不是裸的 tab 可见性
 * 探针：用户 2026-09-16「点击对话框上面的 标准模式 旁边的 团队」实测「没反应」
 * ——hero 屏上宿主那圈标签环通过了 offsetParent 探测（指针点不到/挂在别处会话面
 * 里也算「有 offsetParent」），点击落进了看不见的宿主视图区，面板等于没出现。
 * 未开始屏一律落我们自己的整页团队页（z-[500] 覆盖层，必定可见）。
 */
export function enterTeamsPanel(opts: TeamsPanelOptions = {}): void {
  stageTeamSignals(opts);
  const heroRowPresent =
    typeof document !== 'undefined' && document.querySelector(HERO_ROW_SELECTOR) !== null;
  if (teamsTabUsable(heroRowPresent)) {
    recordClientDiag('panel-entry', `hero=${heroRowPresent} action=tab`);
    activateETeamsTab();
    return;
  }
  recordClientDiag('panel-entry', `hero=${heroRowPresent} action=overlay`);
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
    // 错误规范化收口 errorMessageOf（M7-5，诊断面两处同口径）。
    recordClientDiag('overlay', errorMessageOf(error));
  }
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
    // 错误规范化收口 errorMessageOf（M7-5）。
    recordClientDiag('overlay-pane', errorMessageOf(error));
    return full;
  }
}

/** ================================== 主组件 ================================== */

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
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  // 页内关页信号（用户迭代 2026-09-09「填充后隐藏弹窗」）：本页即「弹窗」
  // 形态（role=dialog，盖住对话输入框）——「新增角色→填充」把命令落进
  // 输入框后广播 CLOSE_TEAMS_PAGE_EVENT（rosterAddPage 经 lib/bridge 发出，
  // 下引 lib 无环），这里收信号就地关页，用户直接看到输入框。信号未发时
  // 本监听零输出，Esc/返回钮路径不受影响。
  useEffect(() => {
    const onSignal = (): void => onClose();
    window.addEventListener(CLOSE_TEAMS_PAGE_EVENT, onSignal);
    return () => {
      window.removeEventListener(CLOSE_TEAMS_PAGE_EVENT, onSignal);
    };
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
            白 / 暗 slate-900，不再直引 bg-base 别名）。z-[500] 层级与 pane
            矩形 inline style 见文件头/M6 注记（OVERLAY_PAGE_CLASS）。 */
          className={OVERLAY_PAGE_CLASS}
          style={{ left: pane.left, top: pane.top, width: pane.width, height: pane.height }}
        >
          {/* 官网顶栏（S24-2）：--border 细线 + 白底条；左标题（官网条内
            14px semibold 签名）+ 最右返回钮（用户迭代 2026-09-08：页面返回
            统一收口 components/backButton 图标钮——原 ghost 文案钮撤文字，
            位置保持顶栏右端不变）。 */}
          <header className={OVERLAY_HEADER_CLASS}>
            <span className="text-sm font-semibold text-foreground">团队</span>
            <BackButton onClick={onClose} />
          </header>
          {/* Plain block wrapper: the view root is `height:100%` + flex row and
        has no width of its own — a block parent lets it fill the pane width
        instead of shrink-wrapping to its content (the "定死宽度" artifact).
        overflow hidden keeps tall content scrolling inside the view column —
        never spilling to the document (横向滚动条治理). */}
          <div className="min-h-0 flex-1 overflow-hidden">
            {/* The panel only reads sessionId/inputActions off its slot props; the
          page has neither (no session on the not-started screen), so a minimal
          share is cast in. Prefill still lands: prefillComposer falls back to
          the capture bridge (TeamsButton registers the session kit's
          inputActions on mount) and writes the canonical template straight
          into the machine draft via the official setDraft — sendable on plain
          enter（未开始 hero 的锁定 composer 不响应合成事件，claim 舞蹈在此
          不可用，见 addPeople）.
          sessionId 保持 undefined：本页所有「有会话才成立」的门控（团队页
          canCreate、任务页本会话分区与「已挂任务」闸、成功收页）都以它为表面
          代理。「添加任务」的新对话工作区不走这里——由 openTaskConversation
          在缺来源会话时回落宿主当前会话（用户 2026-09-15：覆盖层补 sessionId
          会让新对话被整页盖住、看不见跳转）。 */}
            <ETeamsView {...({ sessionId: undefined } as unknown as ConvViewProps)} />
          </div>
        </div>
      </div>
    </Provider>
  );
}
