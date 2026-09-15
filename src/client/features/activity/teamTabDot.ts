/**
 * 团队 TAB 未读点（用户 2026-09-15「有新的待决策内容时，对话上面的团队TAB，需要
 * 出现红点提示。直到进入面板看到决策，或者决策被回答」）。
 *
 * 2026-09-15 同日追加视觉迭代（用户「红点太丑了，变成小绿点吧，小一点，样式
 * 优化仔细设计一下」）：点从 7px 纯红改 6px 小绿点（浅暗两档，详见 DOT_CSS
 * 注记）——只动外观，判据与三个驱动信号一字未动。
 *
 * 宿主渲染的视图标签环只认 `{id,label}`（`ViewTab` / `conversation.view` 槽位
 * 注册项只有 id/order/label/priority，label 还只能是字符串或字符串 thunk），
 * 没有徽标/未读点席位——所以照 heroTeamsButton 的既有先例走 DOM 注入：在宿主
 * 渲染的团队 tab 按钮里补一枚绝对定位的未读点 span。判据（哪些待决策算「新」）
 * 落在 features/activity/decisionSeen 的已读账本，本模块只管把点画对。
 *
 * 注入纪律（宿主 ConversationRoot.module.css 实测）：
 * - 宿主 tab 按钮 `.tab` 自带 `position:relative`，未读点直接以按钮为定位基准；
 *   真遇到 static 才兜底补一条 inline style（宿主换版自愈）；
 * - 该按钮的 `::after` 已被选中态下划线占用，未读点必须是真实子元素，不能用伪元素；
 * - 未读点 span 不带文本（按钮 textContent 仍是「团队」），bridge 的
 *   {@link findETeamsTabButton} 按 textContent 精确匹配标签，不受影响；
 * - 显隐走 `hidden` 属性、不摘节点：React 每秒级重渲染不碰这个非受管子节点，
 *   观察器只在节点真被换掉（会话切换重挂标签环）时补回。
 *
 * 驱动三个信号，缺一都会有「点不及时」的窗口：
 * 1. MutationObserver —— 标签环随会话进程挂载/卸载（照 heroTeamsButton）；
 * 2. dva store 订阅 —— 快照轮询到新的 pending 行；
 * 3. 已读账本订阅 —— 进入面板标记已读后即时收点，不必等下一次轮询。
 *
 * @module dsh-eteams/client/features/activity/teamTabDot
 */
import { findETeamsTabButton } from '../../lib/bridge';
import { recordClientDiag } from '../../lib/diagnostics';
import { errorMessageOf } from '../../lib/errors';
import type { TeamSnapshot } from '../../lib/monitor';
import { getApp } from '../../store/app';
import { subscribeDecisionSeen, unseenPendingKeys } from './decisionSeen';

/** ================================== 样式类 ================================== */

/** 未读点徽标：绝对定位在标签右上角（宿主 tab 无横向内边距，故右移 5px 落在
 * 标签环 36px 的间隙里，不压字）；`[hidden]` 显式隐藏（position:absolute 会
 * 块化元素，靠 UA 的 [hidden] 规则不够稳）；pointer-events:none 保证点击仍
 * 落在宿主按钮上。
 *
 * 2026-09-15 用户「红点太丑了，变成小绿点吧，小一点，样式优化仔细设计一下」：
 * 原为 7px 纯红（red-500）实心圆，改小绿点，三处口径——
 * - 尺寸 7px → 6px（用户「小一点」；偏移取整像素，`top:0` + `right:-5px` 让
 *   6px 圆的两轴边缘都不落半像素，小圆不糊边）；
 * - 色值两档直引 `body[data-ds-dark-theme]`（宿主 chrome 不在 `.eteams-ui`
 *   作用域内、拿不到本仓 token，只能照 styles/eteams.css 的 --success 两档
 *   逐档直引）：浅色 green-600、暗色 green-400——暗色下不再是刺眼的亮红，
 *   且与面板里的成功色同源；
 * - 1.5px 外环取主题底（浅色白 / 暗色 slate-900）作「挖底色」：宿主 tab 的
 *   悬停/选中底色是带色 pills，实心圆压上去会糊成一团，留一圈底色边缘让小
 *   圆在任意底上都干净。 */
const DOT_CSS = `
.eteams-tab-dot{position:absolute;top:0;right:-5px;width:6px;height:6px;border-radius:9999px;background:#16a34a;box-shadow:0 0 0 1.5px #ffffff;pointer-events:none}
.eteams-tab-dot[hidden]{display:none}
body[data-ds-dark-theme] .eteams-tab-dot{background:#4ade80;box-shadow:0 0 0 1.5px #0f172a}
`;

/** ================================== 常量与映射表 ================================== */

/** 未读点 span 的 data-eteams 标记值（幂等注入的锚）。 */
const DOT_FLAG = 'tab-dot';

/** 未读点 class（样式表按它落样式）。 */
const DOT_CLASS = 'eteams-tab-dot';

/** 一次性样式标签的 id。 */
const STYLE_ID = 'eteams-tab-dot-style';

/** ================================== 模块状态 ================================== */

let installed = false;
/** 当前挂点的未读点元素（宿主换按钮后随之失效）。 */
let dot: HTMLElement | null = null;
/** 当前显隐状态（只在变化时写 DOM，避免观察器自激）。 */
let dotVisible = false;
/** 上次派生用的快照引用（见 {@link shouldShowDot} 的备忘）。 */
let lastTeams: readonly TeamSnapshot[] | null = null;
/** 上次派生结果（快照未变时直接复用）。 */
let lastUnseen = false;

/** ================================== 工具函数 ================================== */

/** 注入样式表（一次性；与 heroTeamsButton 同款）。 */
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return;
  const tag = document.createElement('style');
  tag.id = STYLE_ID;
  tag.textContent = DOT_CSS;
  document.head.appendChild(tag);
}

/**
 * 未读点元素（缺则注入到该按钮）：幂等，返回既有节点。宿主按钮自带
 * position:relative 时不动它，实测 static 才补一条 inline style 作兜底。
 * 导出供宿主换版/单测直接调用。
 */
export function ensureTeamTabDot(button: HTMLElement): HTMLElement {
  const existing = button.querySelector<HTMLElement>(`[data-eteams="${DOT_FLAG}"]`);
  if (existing !== null) return existing;
  if (typeof getComputedStyle === 'function' && getComputedStyle(button).position === 'static') {
    button.style.position = 'relative';
  }
  const span = document.createElement('span');
  span.className = DOT_CLASS;
  span.setAttribute('data-eteams', DOT_FLAG);
  span.setAttribute('aria-hidden', 'true');
  span.hidden = true;
  button.appendChild(span);
  return span;
}

/** 未读点显隐（只在状态真变化时写 DOM）。 */
export function setTeamTabDotVisible(target: HTMLElement | null, on: boolean): void {
  if (target === null) return;
  target.hidden = !on;
}

/**
 * 待决策未读点该不该亮：存在 pending 且未读的行（跨全部团队，见 decisionSeen）。
 *
 * 备忘到快照数组引用上：`activity/set` 每秒整包替换 teams、引用只在快照更新时
 * 变，而 MutationObserver 在流式渲染时每秒触发数十次 DOM 回调——引用相等即复用
 * 上次结果，把 pendingActionsOf 的派生挡在热点之外。账本变化（标记已读）不经过
 * 快照，由 installTeamTabDot 里的 subscribeDecisionSeen 显式失效。
 */
function shouldShowDot(): boolean {
  const teams = getApp().store.getState().activity.teams;
  if (teams !== lastTeams) {
    lastTeams = teams;
    lastUnseen = unseenPendingKeys(teams).length > 0;
  }
  return lastUnseen;
}

/** 对账一次：找宿主团队 tab → 补点 → 按未读状态显隐。 */
function syncTeamTabDot(): void {
  const button = findETeamsTabButton();
  const next = button === undefined ? null : ensureTeamTabDot(button);
  if (next !== dot) {
    // 宿主换了节点（会话切换重挂标签环）：旧点随旧按钮消亡，状态清零重算。
    dot = next;
    dotVisible = false;
  }
  if (dot === null) return;
  const on = shouldShowDot();
  if (dotVisible === on) return;
  setTeamTabDotVisible(dot, on);
  dotVisible = on;
}

/**
 * 安装团队 tab 未读点（每页一次；`apply()` 里调用）。非浏览器环境与重复调用为
 * no-op，任何失败只记录不致命（诊断落 client.log）。
 */
export function installTeamTabDot(): void {
  if (installed || typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return;
  }
  installed = true;
  try {
    ensureStyle();
    const scan = (): void => {
      try {
        syncTeamTabDot();
      } catch (error) {
        recordClientDiag('team-tab-dot-scan', errorMessageOf(error));
      }
    };
    const root = document.body ?? document.documentElement;
    const observer = new MutationObserver(scan);
    observer.observe(root, { childList: true, subtree: true });
    getApp().store.subscribe(scan);
    subscribeDecisionSeen(() => {
      // 账本变化不经快照：先让 shouldShowDot 的备忘失效，再对账（进入面板
      // 标记已读后点即刻熄灭，不必等下一次轮询）。
      lastTeams = null;
      scan();
    });
    scan();
  } catch (error) {
    recordClientDiag('team-tab-dot', errorMessageOf(error));
  }
}
