/**
 * 团队面板页内跨 tab 共享层（docs/32 32.5.2）：被 ≥2 个 tab 文件引用的
 * 类名常量、tone 徽标族、跨 tab 小组件、领域常量与页面注入样式。符号自
 * eteamsView.tsx 原样搬出（纯移动、零行为变更），按四段分区：
 * 领域常量 / tone 徽标族 / 跨 tab 小组件 / 页面级类名常量与注入样式。
 *
 * @module dsh-eteams/client/pages/teamsView/shared
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Alert } from '../../components/ui/alert';
import { Badge } from '../../components/ui/badge';
import { DOT_BASE_CLASS, DOT_TONE_CLASS, type Tone } from '../../features/tasks/taskDisplayStatus';

/* —— 领域常量 —— */

/** The leader is a member too — default-joined, undeletable (用户定稿模型). */
export const LEADER_NAME = '项目牧羊人';
/** The role-builder persona is a system member as well: undeletable,
 * listed right under the leader (用户反馈：角色构建师不能删除). */
export const ROLE_BUILDER_NAME = '角色构建师';
/** Members the panel never offers a delete button for (host enforces too). */
export const PROTECTED_MEMBERS: readonly string[] = [LEADER_NAME, ROLE_BUILDER_NAME];

/** Sort rank: leader first, role builder second, everyone else after. */
export function memberRank(name: string): number {
  if (name === LEADER_NAME) return 0;
  if (name === ROLE_BUILDER_NAME) return 1;
  return 2;
}

/* —— tone 徽标族 —— */

/**
 * S12：Tone→工具类映射表（完整字面量，content 扫描可检出——禁 `tone-${x}`
 * 拼接，21.5.1 纪律）。语义色走 token 类（D19c；success/warning/business
 * 为附录 A 扩展 token，muted 走中性 token muted-foreground）。
 * S13 的状态徽标（pillClass/dotClass）沿用此表语义，S14 余下区块同。
 * （Tone 类型与成员态映射 memberTone 已迁 taskDisplayStatus——docs/29 B，
 * 经 import 使用。）
 */
export const TONE_CLASS: Record<Tone, string> = {
  info: 'text-business',
  ok: 'text-success',
  warn: 'text-warning',
  err: 'text-destructive',
  muted: 'text-muted-foreground',
};

/** D22e 官网式圆 pill 底座：中性半透明底 + 12px medium 字；状态彩底全撤
 * （五档 tone 只进 6px dot，见 DOT_TONE_CLASS）——底/字统一中性 token
 * （--eteams-pill-bg/--eteams-pill-ink，亮暗由 eteams.css 定值）。 */
export const PILL_BASE_CLASS =
  'inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium';
export const PILL_NEUTRAL_CLASS = 'bg-[color:var(--eteams-pill-bg)] text-[color:var(--eteams-pill-ink)]';
/** PILL_TONE_CLASS（D22e 降噪后）：tone 不再改变 pill 面——五档统一中性
 * pill，tone 语义全部由内嵌彩色 dot 承载（映射表结构保留：Pill 组件按
 * tone 查底 + 查 dot，两组常量拼接完整字面量）。 */
export const PILL_TONE_CLASS: Record<Tone, string> = {
  info: PILL_NEUTRAL_CLASS,
  ok: PILL_NEUTRAL_CLASS,
  warn: PILL_NEUTRAL_CLASS,
  err: PILL_NEUTRAL_CLASS,
  muted: PILL_NEUTRAL_CLASS,
};
/** 原 fns.dot 的类名版：D22e 后 dot 是状态色的唯一载体——DOT_BASE_CLASS/
 * DOT_TONE_CLASS 已迁 taskDisplayStatus（docs/29 B，与展示态/tone 同家），
 * dotClass 经 import 消费。 */
export const pillClass = (tone: Tone): string => cn(PILL_BASE_CLASS, PILL_TONE_CLASS[tone]);
export const dotClass = (tone: Tone): string => cn(DOT_BASE_CLASS, DOT_TONE_CLASS[tone]);

/** 状态徽标（docs/23 S23-3）：shadcn Badge 承底座（边框/过渡/焦点环），
 * 本仓 pill 视觉口径（官网圆 pill / 12px / medium / 内嵌状态点）以
 * className 覆盖层保留——tone 底色表（PILL_TONE_CLASS）经 tailwind-merge
 * 压过 Badge 变体底色。D22e：dot 由组件统一内嵌（中性 pill + 彩点签名），
 * 调用位不再自插 dot span。 */
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }): ReactNode {
  return (
    <Badge variant="secondary" className={pillClass(tone)}>
      <span className={dotClass(tone)} />
      {children}
    </Badge>
  );
}

/** D22f 执行链/构建步骤字形三态调色（✔●◌ 字符保留=产品语义，只换色）：
 * done=已完成弱化灰、current=进行中品牌蓝（token 官网化为 sky）、
 * pending=未到站中性字（pill 字色 token）。完整字面量查表（21.5.1）。 */
export const GLYPH_TONE_CLASS: Record<string, string> = {
  done: 'text-muted-foreground',
  current: 'text-primary',
  pending: 'text-[color:var(--eteams-pill-ink)]',
};

/* —— 跨 tab 小组件 —— */

/** 表单/列表错误提示（docs/23 S23-3）：shadcn Alert destructive 的紧凑档
 * （原 styles.formError 的 12px/20 + 上 4 下 8 边距口径）。 */
export function FormErrorNote({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <Alert
      variant="destructive"
      className={cn('mt-1 mb-2 rounded-md px-3 py-2 text-xs leading-5', className)}
    >
      {children}
    </Alert>
  );
}

/** 页签标题（S24-2 新增，官网 h2 签名）：五 tab 内容区顶部的页头行——
 * 20px bold tracking-tight + mb-4；右侧动作位（团队页放「＋ 新增团队」
 * 主按钮 → 创建弹窗）。标题字即 tab 名，不发明副标题。 */
export function PageHeader({ label, children }: { label: string; children?: ReactNode }): ReactNode {
  return (
    <div className="mb-4 flex items-center gap-3">
      <h2 className="m-0 text-xl font-bold tracking-tight text-foreground">{label}</h2>
      {children !== undefined && <span className="flex-1" />}
      {children}
    </div>
  );
}

/* —— 页面级类名常量与注入样式 —— */

/** 边框统一走语义 token --border（D22a 官网 v3：亮 slate-200 #e2e8f0 /
 * 暗 slate-800 #1e293b，token 值已官网化）——原 l1 别名半透明灰（比官网
 * 细线还淡、暗色发灰）的任意值直引全部收敛到这条。 */
export const BORDER_L1_CLASS = 'border-[color:var(--border)]';
/** 次级文字：D22d 官网正文灰阶语义——正文次级 = muted-foreground（官网
 * slate-500 #64748b），原 label-secondary 别名任意值直引收敛到语义 token。 */
export const TEXT2_CLASS = 'text-muted-foreground';
/** 原 styles.muted（meta/弱化档：12px/20 官网小字尺度 / overflow-wrap:anywhere），
 * S12–S14 各批次区块共用的类常量。 */
export const MUTED_CLASS = 'text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]';
/** 原 styles.line（正文次级行：官网 prose-sm 14px/24）。 */
export const LINE_CLASS = `my-1 text-sm leading-6 ${TEXT2_CLASS}`;
/** 原 styles.sectionTitle（卡/区块标题：D22d 官网 h3 档 16px semibold +
 * tracking-tight，去原 11px 的反向加宽 tracking）。 */
export const SECTION_TITLE_CLASS = 'mb-2 text-base font-semibold leading-6 tracking-tight text-foreground';
/** 原 styles.empty（虚线框空态）；边框色吃 S3 桥默认（--border 即原 l2 档）。 */
export const EMPTY_CLASS =
  'rounded-xl border border-dashed px-5 py-9 text-center text-sm leading-6 text-muted-foreground';

/** 面板卡片（原 styles.card → shadcn Card 的覆盖层）：底色回 layer-1 档
（Card 默认 bg-card 是 layer-2）、--border 边框、官网 shadow-sm 阴影档
（D22f：0.03→0.05）；px-4 py-4 = 卡内呼吸感提到 16px（行密度不变）。
eteams-ui 字面量随 Card 根（S5 试点双保险）。 */
export const PANEL_CARD_CLASS = `eteams-ui mb-3 min-w-0 border border-solid bg-background px-4 py-4 shadow-[0_1px_2px_rgba(15,23,42,0.05)] ${BORDER_L1_CLASS}`;

/** shadcn Select 空选项哨兵（Radix SelectItem value 禁空串；映射回 ''/null）。 */
export const SELECT_NONE = '__none__';
/** 原 styles.formRow / styles.formLabel（表单行）：汇报页先用，S14 表单复用。 */
export const FORM_ROW_CLASS = 'mb-2.5 flex flex-col gap-[5px]';
export const FORM_LABEL_CLASS = 'text-xs font-semibold text-muted-foreground';
/** 原 styles.listTitle / styles.listCount（列表页头）：S14 的团队/角色列表头复用；
 * D22d 官网 h3 档 16px semibold + tracking-tight（S23-3 已引入 tracking-tight）。 */
export const LIST_TITLE_CLASS =
  'm-0 min-w-0 flex-1 text-base font-semibold tracking-tight text-foreground';
export const LIST_COUNT_CLASS = 'text-xs text-muted-foreground';

/** 原 styles.chip（依赖小芯片）：S14 角色详情的所属团队芯片复用；底色收敛
 * 语义 token --muted（与原 layer-2 档同值源）。 */
export const CHIP_CLASS = `mr-1 mb-0.5 inline-block rounded-md bg-muted px-2 py-px text-xs text-muted-foreground`;

/** 原 styles.cardGrid（团队/角色卡片栅格，最小 210px 自适应列）——团队与角色
 * 列表共用：按面板宽度自适应列数，窄两列宽三列，卡片不拉成长条
 * （用户迭代 2026-09 八）。 */
export const CARD_GRID_CLASS = 'grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3';
/**
 * 角色/团队列表注入样式表（ROLE_LIST_CSS）消费的主题 token——S12–S14 迁移
 * 后 inline 样式消费面已清空；hover/focus-within/attr 选择器与下面的原生
 * details/summary 样式仍需样式表承载（D22f：展开指示的 [open]/::before 规则
 * 无法用工具类表达，同注入这里）。
 * D22a 官网 v3 色板接管：原先经 --dsw-alias-*（DSW 蓝家族）的取值全部改
 * 消费 .eteams-ui 作用域内的语义 token（亮/暗由 eteams.css 统一定值），
 * 浅暗两态都不刺眼；半透明一律 color-mix()（token 色禁 /alpha 的替代路径，
 * button.tsx 先例）。
 */

/**
 * 角色/团队 list stylesheet（卡片化 + 视觉升级）：hover/抬升/阴影/过渡与删除
 * 按钮的悬停换色内联样式表达不了（且内联底色会压住 :hover——弹窗行的同一
 * 教训），统一走这里；token 直接从主题插值，fallback 已内建。
 */
export const ROLE_LIST_CSS = `
.eteams-role-row{background:var(--background);border:1px solid var(--border);box-shadow:0 1px 2px rgba(15,23,42,0.05);transition:background .15s ease,border-color .15s ease,box-shadow .15s ease}
.eteams-role-row:hover{border-color:color-mix(in srgb,var(--foreground) 18%,transparent);background:var(--muted)}
.eteams-team-card{background:var(--background);border:1px solid var(--border);box-shadow:0 1px 2px rgba(15,23,42,0.05);transition:background .15s ease,border-color .15s ease,box-shadow .15s ease}
.eteams-team-card:hover{border-color:color-mix(in srgb,var(--foreground) 18%,transparent);background:var(--muted)}
/* 成员略缩图动效（用户迭代 2026-09 九）：小号头像负间距叠放；滑过整组时
   间距松开（互相挤开），滑过单个头像时它放大浮到顶层——margin/transform
   过渡驱动，JSX 只挂 .eteams-team-avatars 类。 */
.eteams-team-avatars>*{position:relative;margin-left:-6px;transition:margin-left .18s ease,transform .18s ease}
.eteams-team-avatars>:first-child{margin-left:0}
.eteams-team-avatars:hover>*{margin-left:-2px}
.eteams-team-avatars>*:hover{transform:scale(1.35);z-index:30}
/* 删除钮（用户迭代 2026-09-03）：常驻显形，不再 hover 才出现——小卡片
   一行式布局下按钮固定行尾，可见性即可达性；hover 仅保留自身的描边换色。 */
.eteams-role-del{padding:3px 10px;font-size:12px;border-radius:6px;border:1px solid var(--border);background:var(--background);color:var(--destructive);cursor:pointer;flex-shrink:0;font-family:inherit;line-height:18px;transition:border-color .15s ease,background .15s ease}
.eteams-role-del:hover{border-color:var(--destructive);background:color-mix(in srgb,var(--destructive) 6%,transparent)}
.eteams-role-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eteams-team-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 原生 details/summary（构建工作台 ×2，功能性不动）官网化：去 marker +
   「▸」展开指示随 open 旋转；必须带 .eteams-ui 前缀——style 标签按文档流
   注入但 CSS 本身是全局的，无前缀会漏进宿主页面。 */
.eteams-ui details>summary{cursor:pointer;user-select:none;list-style:none}
.eteams-ui details>summary::-webkit-details-marker{display:none}
.eteams-ui details>summary::before{content:'▸';display:inline-block;margin-right:6px;color:var(--muted-foreground);transition:transform .15s ease}
.eteams-ui details[open]>summary::before{transform:rotate(90deg)}
`;
