/**
 * 状态域查表层（docs/44 44.2.2）：各状态域收敛为 `META[status]`/`NAV_ITEMS`
 * 查表，渲染位一律查表、禁三元链，未知值落兜底（`?? FALLBACK`）。
 * M1 初版：导航四项（rail 侧栏与路由表共用）；后续模块按 44.2.2 清单继续
 * 扩表（任务十态/构建步骤三态/成员五态…）——已入表：子代理活动两态（M4）、
 * 构建会话四态（M6）。
 *
 * @module dsh-eteams/client/lib/status
 */
import type { BuildSession } from './api';

/** ================================== 类型 ================================== */

/** 面板导航四域 id（与 ui model activeNav 四值对齐——store/models/ui.ts）。 */
export type NavId = 'board' | 'team' | 'roster' | 'tasks';

/** 导航项（44.2.2：id/label/path——rail 按钮消费 id/label，路由表消费 path）。 */
export interface NavItem {
  id: NavId;
  label: string;
  path: string;
}

/** 子代理活动两态（docs/20.4 P4：childId → running/inactive，成员卡活动点）。 */
export type ActivityKey = 'running' | 'inactive';

/** 构建会话四态（docs/19.9.1：键型即 lib/api BuildSession.status）。 */
export type BuildSessionStatus = BuildSession['status'];

/** ================================== 常量与映射表 ================================== */

/**
 * 导航四项（M4.5 IA：看板/团队/角色/任务；用户迭代 2026-09-08 撤除汇报页）。
 * label 即页签名与页头字（零文案变更）；path 为 MemoryRouter 路由（44.2.1，
 * 每表面一棵）。
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'board', label: '看板', path: '/board' },
  { id: 'team', label: '团队', path: '/team' },
  { id: 'roster', label: '角色', path: '/roster' },
  { id: 'tasks', label: '任务', path: '/tasks' },
];

/** 未知导航值兜底（原壳 activeTab 派生的 `? : 'board'` 同源口径）。 */
export const NAV_FALLBACK: NavId = 'board';

/**
 * 角色详情页头副注两态（M2 查表，44.2.2）：领队 / 系统保留——原 membersTab
 * 详情页头的嵌套三元文案收编；键由消费位按 (isLeader, nameLocked) 计算后
 * 查表（三元只算键名，21.5.1 同纪律）。「编辑中」副注随页头简介输入框上线
 * 撤除（用户迭代 2026-09-06）。root 档撤除（用户反馈：与建库播种进
 * roles.profile 的简介同义重复）——主对话注入角色页头只显示库内简介。
 */
export type RosterDetailSubtitleKey = 'leader' | 'protected';
export const ROSTER_DETAIL_SUBTITLE_META: Record<RosterDetailSubtitleKey, string> = {
  leader: '领队 · 手册与头像可编辑，名称为系统保留',
  protected: '系统保留角色 · 名称不可改，其余可编辑',
};

/**
 * 子代理活动点查表（M4，44.2.2）：running/inactive 的点色 + title 双三元收拢
 * ——键由消费位按 activity === 'running' 计算后查表（三元只算键名，21.5.1
 * 同纪律；非 running 一律落 inactive 档，与原三元回落同口径）。点色：running
 * = success 绿 + 光晕（D22f 状态点光晕——green-100 死字面量改 color-mix
 * success 淡环，token 半透明替代路径，button.tsx 先例，亮暗自适应）；
 * inactive = 中性 muted-foreground。
 */
export const ACTIVITY_DOT: Record<ActivityKey, { className: string; title: string }> = {
  running: {
    className:
      'h-[7px] w-[7px] shrink-0 rounded-full bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--success)_15%,transparent)]',
    title: '子代理运行中',
  },
  inactive: {
    className: 'h-[7px] w-[7px] shrink-0 rounded-full bg-muted-foreground',
    title: '子代理已完结',
  },
};

/**
 * 构建会话四态表（M6 迁入，44.2.2）：/eteam 对话卡（pages/buildCard）状态
 * pill 的 label + toneClass——原 buildCard 模块级 CARD_STATUS 原值收编。
 * toneClass 为语义 token 类完整字面量（active→business、待确认→warning、
 * 已入库→success、放弃→muted-foreground，D19c；类名一律完整字面量，
 * 21.5.1 content 扫描纪律）。
 */
export const BUILD_SESSION_META: Record<BuildSessionStatus, { label: string; toneClass: string }> = {
  active: { label: '创建中', toneClass: 'text-business' },
  awaiting_confirmation: { label: '待确认', toneClass: 'text-warning' },
  confirmed: { label: '已入库', toneClass: 'text-success' },
  cancelled: { label: '已放弃', toneClass: 'text-muted-foreground' },
};

/** ================================== 工具函数 ================================== */

/**
 * path → 导航 id：未知路径落兜底 board（原畸形 activeNav 兜底同口径）。
 * M2 起角色域有子路由（/roster/add、/roster/:name）——精确匹配优先，未中
 * 再按「域前缀 + /」归组，子路由页签高亮与拆分前 tab 内视图一致。
 */
export function navIdOfPath(path: string): NavId {
  const exact = NAV_ITEMS.find((item) => item.path === path);
  if (exact !== undefined) return exact.id;
  return NAV_ITEMS.find((item) => path.startsWith(`${item.path}/`))?.id ?? NAV_FALLBACK;
}

/** 导航 id → path：未知 id（store 持久值畸形）落兜底项的路径。 */
export function navPathOfId(id: string): string {
  return (
    NAV_ITEMS.find((item) => item.id === id)?.path ??
    NAV_ITEMS.find((item) => item.id === NAV_FALLBACK)?.path ??
    '/board'
  );
}