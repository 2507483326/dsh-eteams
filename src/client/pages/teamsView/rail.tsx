/**
 * 面板侧栏（docs/44 M8 自 index.tsx 拆出，46 清单）：宽栏（官网 docs 侧栏
 * 签名——分组标题 + 连续左细线列表 + 链接自带左边线三态）与窄栏
 * （84px 按钮纵列）两套渲染，由壳按作用域根实测宽度切换（railWide 经
 * props 传入——测量锚点是壳的作用域根元素，测量留驻 index.tsx）。M1 起
 * 导航路由驱动：本组件自消费 useLocation/useNavigate，activeTab 由路径查表
 * 派生（navIdOfPath 与壳同口径的纯函数，读同一棵 MemoryRouter 的 location）。
 * 宽栏筛选框已随用户迭代 2026-09-08 撤除。
 *
 * @module dsh-eteams/client/pages/teamsView/rail
 */
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { NAV_ITEMS, navIdOfPath } from '../../lib/status';
import { BORDER_L1_CLASS } from '../shared/styles';

/** ================================== 类型 ================================== */

/** 侧栏入参：宽/窄档由壳实测作用域根宽度决定（阈值 RAIL_WIDE_MIN_WIDTH 的
 * useLayoutEffect/ResizeObserver 测量留驻壳内——锚点是壳的作用域根元素）。 */
export interface PanelRailProps {
  /** 面板作用域根宽 ≥ 720px 时 true 渲染官网风格宽栏，否则回落 84px 窄栏。 */
  railWide: boolean;
}

/** ================================== 样式类 ================================== */

/** 原 styles.rail（窄栏态：84px / 3px 纵向间距 / 右分隔线 / 上 2 右 12）。
 * docs/22 S22-2：面板宽 ≥720px 时改用官网风格的宽栏 RAIL_WIDE_CLASS，
 * 窄面板回落本类（84px 窄栏原样保留，窄上下文零回归）。 */
const RAIL_CLASS = `flex w-[84px] shrink-0 flex-col gap-[3px] border-r border-solid pr-3 pt-0.5 ${BORDER_L1_CLASS}`;

/** 官网 docs 侧栏风格的宽栏（docs/22 D20c，tailwindcss.cn 实测标记还原）：
 * 208px（官网 15rem 等比收窄的 S24-2 加宽档）+ 右分隔线；列表自带连续左
 * 细线（官网 `border-l border-slate-100`，token 化走 --border）。 */
const RAIL_WIDE_CLASS = `flex w-[208px] shrink-0 flex-col border-r border-solid pr-4 pt-1 ${BORDER_L1_CLASS}`;
/** 宽栏导航列表（官网 ul：`space-y-2 border-l` 的 token 版）。 */
const RAIL_LIST_CLASS = `space-y-2 border-l border-solid ${BORDER_L1_CLASS}`;

/** 宽栏导航链接三态（官网 a 的签名交互，docs/22 22.1.3）：自带 1px 左边线
 * 压在列表线上（`-ml-px`），常态透明、hover 亮线 + 文字加深、**激活 = sky
 * 文字 + 同色左线（border-current）+ semibold**；全部完整字面量（21.5.1
 * content 扫描纪律）。
 * D22f 官网字面量方案：hover 线取官网原味 `border-slate-400`（中灰在浅暗
 * 两态底上都可见）；hover 文字官方是加深到 slate-900，但 slate-900 字面量
 * 在暗色面板（slate-900 底）会隐形——文字加深走 token hover:text-foreground
 * （亮=官网同效，暗=slate-200 随主题翻档）。 */
const RAIL_LINK_BASE_CLASS =
  'block border-0 border-l border-solid bg-transparent py-[3px] pl-4 -ml-px text-left text-sm leading-6 [font-family:inherit] transition-colors';
const RAIL_LINK_IDLE_CLASS =
  'border-transparent text-muted-foreground hover:border-slate-400 hover:text-foreground';
const RAIL_LINK_ACTIVE_CLASS = 'border-current font-semibold text-primary';

/** ================================== 常量与映射表 ================================== */

/** 窄栏按钮 active 两态查表（M1 三元收编——类值全部表内完整字面量，消费位
 * 三元只算键名；docs/23 D21b：active 底改品牌淡底 token（business-tint 淡底
 * 对）、字=brand 主色 token；S24-2 补非激活钮 hover 态（官网侧栏 hover 底
 * 语义，token --muted）。 */
const RAIL_BTN_STATE_CLASS: Record<'active' | 'idle', string> = {
  active: 'bg-business-tint font-semibold text-primary',
  idle: 'bg-transparent font-medium text-muted-foreground hover:bg-muted',
};

/** 宽栏导航链接 active 两态查表（M1 三元收编，官网三态——base/idle/active
 * 三常量表组装，同 RAIL_BTN_STATE_CLASS 的映射表口径）。 */
const RAIL_LINK_STATE_CLASS: Record<'active' | 'idle', string> = {
  active: RAIL_LINK_ACTIVE_CLASS,
  idle: RAIL_LINK_IDLE_CLASS,
};

/** 宽栏阈值（docs/22 S22-2）：面板作用域根宽 ≥ 此值用官网风格宽栏，
 * 否则回落 84px 窄栏。宿主 conversation.view 视图区与整页团队页宽度差异大，
 * Tailwind v3 无容器查询（v4 才内置），以作用域根实测为准。
 * 测量锚点是壳的作用域根元素——实测（useLayoutEffect/ResizeObserver）留驻
 * index.tsx，本表导出供壳消费（单一档位源）。 */
export const RAIL_WIDE_MIN_WIDTH = 720;

/** ================================== 工具函数 ================================== */

/** 窄栏侧栏按钮类名（原 fns.railBtn）：底座类 + active 两态查表组装。 */
const railBtnClass = (active: boolean): string =>
  cn(
    'block w-full cursor-pointer rounded-[8px] border-none px-2.5 py-[7px] text-left text-xs leading-[1.55] [letter-spacing:0.2px]',
    RAIL_BTN_STATE_CLASS[active ? 'active' : 'idle'],
  );

/** 宽栏导航链接类名（官网三态查表；同 railBtnClass 的映射表口径）。 */
const railLinkClass = (active: boolean): string =>
  cn(RAIL_LINK_BASE_CLASS, RAIL_LINK_STATE_CLASS[active ? 'active' : 'idle'], 'cursor-pointer');

/** ================================== 主组件 ================================== */

/**
 * 宽/窄两套侧栏（自 index.tsx 原样搬出，零行为变更）：railWide 档位由壳
 * 实测传入；筛选词/导航高亮/点击跳转的语义与迁移前逐位一致——activeTab
 * 由本组件经 useLocation 查表派生（与壳的 activeTab 同源同值），点击仍走
 * useNavigate（location 为唯一导航驱动源，见 routes.tsx）。
 */
export function PanelRail({ railWide }: PanelRailProps): ReactNode {
  const location = useLocation();
  const navigate = useNavigate();
  // M1：导航五项收编 lib/status.ts NAV_ITEMS（rail 与路由表共用，44.2.2）；
  // activeTab 由 location 查表派生（navIdOfPath 未知值兜底 board——原畸形
  // activeNav 兜底同口径）。
  const activeTab = navIdOfPath(location.pathname);
  return railWide ? (
    /* docs/22 S22-2 宽栏：官网 docs 侧栏签名——连续左细线列表 + 链接自带左
       边线三态（激活 = sky 文字 + 同色左线 + semibold）；分组标题已随用户
       迭代 2026-09-15 撤除，宽栏筛选框已随用户迭代 2026-09-08 撤除。 */
    <div className={RAIL_WIDE_CLASS}>
      <div className={RAIL_LIST_CLASS}>
        {NAV_ITEMS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={railLinkClass(activeTab === t.id)}
            onClick={() => navigate(t.path)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  ) : (
    <div className={RAIL_CLASS}>
      {NAV_ITEMS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={railBtnClass(activeTab === t.id)}
          onClick={() => navigate(t.path)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}