/**
 * 面板页内跨 tab 共享层 · 类名常量与注入样式（docs/44 M8 自 shared.tsx 拆分，
 * 46 清单）：领域常量、tone 徽标族、页面级类名常量与 ROLE_LIST_CSS 注入
 * 样式表——符号自 shared.tsx 原样搬出（纯移动、零行为变更）。小组件件
 * （Pill/FormErrorNote/PageHeader）拆居同目录 components.tsx；各引用方按需
 * 改导入（类名常量 ← 本文件，组件 ← components.tsx）。
 *
 * @module dsh-eteams/client/pages/shared/styles
 */
import { cn } from '../../lib/cn';
import { DOT_BASE_CLASS, DOT_TONE_CLASS, type Tone } from '../../features/tasks/taskDisplayStatus';

/** ================================== 常量与映射表 ================================== */

/** The leader is a member too — default-joined, undeletable (用户定稿模型). */
export const LEADER_NAME = '团队领队';
/** The role-builder persona is a system member as well: undeletable,
 * listed right under the leader (用户反馈：角色构建师不能删除). */
export const ROLE_BUILDER_NAME = '角色构建师';
/** 主对话注入角色（v12）：保留角色 system——手册(MD)注入主对话 system
 * 提示词，不能加入团队；undeletable，名称锁死。 */
export const ROOT_ROLE_NAME = 'system';
/** Members the panel never offers a delete button for (host enforces too). */
export const PROTECTED_MEMBERS: readonly string[] = [
  LEADER_NAME,
  ROLE_BUILDER_NAME,
  ROOT_ROLE_NAME,
];

/**
 * S12：Tone→工具类映射表（完整字面量，content 扫描可检出——禁 `tone-${x}`
 * 拼接，21.5.1 纪律）。语义色走 token 类（D19c；success/warning/business
 * 为附录 A 扩展 token，muted 走中性 token muted-foreground）。
 * S13 的状态徽标（pillClass/dotClass）沿用此表语义，S14 余下区块同。
 * （Tone 类型与 6px 状态点工具类已迁 taskDisplayStatus——docs/29 B，
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
export const PILL_NEUTRAL_CLASS =
  'bg-[color:var(--eteams-pill-bg)] text-[color:var(--eteams-pill-ink)]';
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

/** 边框统一走语义 token --border（D22a 官网 v3：亮 slate-200 #e2e8f0 /
 * 暗 slate-800 #1e293b，token 值已官网化）——原 l1 别名半透明灰（比官网
 * 细线还淡、暗色发灰）的任意值直引全部收敛到这条。 */
export const BORDER_L1_CLASS = 'border-[color:var(--border)]';
/** DA42：主任务卡底栏 + 小任务行头共用的状态 pill 样式（2px 圆角 + 描边
 * + hover 淡底压平）。 */
export const STATUS_PILL_CLASS = `rounded-[2px] ${BORDER_L1_CLASS} hover:bg-[color:var(--eteams-pill-bg)]`;
/** DA44②：主题原位编辑 Input 统一覆盖层——h-8 对齐 sm 钮簇/卡槽 chip 的
 * 32px 档、min-w-[160px] 防窄行塌缩（flex-wrap 下不足即换行占满整行）。 */
export const INLINE_SUBJECT_INPUT_CLASS = 'h-8 min-w-[160px] flex-1 rounded-md px-2.5 text-sm';
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
export const SECTION_TITLE_CLASS =
  'mb-2 text-base font-semibold leading-6 tracking-tight text-foreground';
/** 原 styles.empty（虚线框空态）；边框色吃 S3 桥默认（--border 即原 l2 档）。 */
export const EMPTY_CLASS =
  'rounded-xl border border-dashed px-5 py-9 text-center text-sm leading-6 text-muted-foreground';

/** 卡片面三要素（M7-11 收编：面板卡/成员卡的边框、底色、官网阴影档三件
 * 同值面——原两处逐字面量合一；圆角/内距等档位差留在各消费位拼接，
 * 拼出的仍是完整字面量（21.5.1）。 */
export const CARD_SURFACE_CLASS = `border border-solid bg-background shadow-[0_1px_2px_rgba(15,23,42,0.05)] ${BORDER_L1_CLASS}`;
/** 任务卡面（M7-11 收编：taskHeaderCard 内联与 taskSubtaskItem
 * SUBTASK_CARD_CLASS 的逐字重复合一——小任务行的 mt-1.5 档位差留消费位）。 */
export const TASK_CARD_CLASS = `rounded-[8px] border border-solid bg-background px-3 py-2.5 ${BORDER_L1_CLASS}`;

/** 面板卡片（原 styles.card → shadcn Card 的覆盖层）：底色回 layer-1 档
（Card 默认 bg-card 是 layer-2）、--border 边框、官网 shadow-sm 阴影档
（D22f：0.03→0.05）；px-4 py-4 = 卡内呼吸感提到 16px（行密度不变）。
eteams-ui 字面量随 Card 根（S5 试点双保险）。M7-11：面三要素收编
CARD_SURFACE_CLASS（逐字同值，工具类序不影响级联）。 */
export const PANEL_CARD_CLASS = `eteams-ui mb-3 min-w-0 px-4 py-4 ${CARD_SURFACE_CLASS}`;

/** 看板两个面板卡（决策面板 / 动态时间线）的公共布局类（用户 2026-09-16「看板
 * 决策面板和 动态怎么这么高了，给一个最小高度，然后不能超过屏幕出现外部滚动
 * 条」→「决策面板和 动态 应该出现内部滚动条，避免超出出现外部滚动条」→「三个
 * 面板应该是占满整屏的，和团队这种应该是一样的啊，使用flex布局，限制最小高
 * 度」）：与团队/角色/任务页同款的「整页占满」档——
 * ① `flex-1`：跟日历卡（shrink-0 定高）一起把看板余高吃满，三个面板合起来正好
 *    占满整屏；
 * ② `min-h-[300px]`：两卡共用的下限（余高充裕时两卡按 flex 等分、下限不生效；
 *    余高紧张时先冻在这里）。用户 2026-09-16「决策面板 没有最小高度了」→
 *    「最小高度太小了，至少300px 然后待决策中没有数据时，没有待决策的提示也没
 *    有看见了」：160px 那档在宿主实际字体度量下只够卡身固定件（内距 + 标题 +
 *    页签条），空态行/列表被下压到可视区外 → 看着既没下限、也丢了「暂无待决策」
 *    提示；300px 保证固定件之下仍有空态行与几行列表的位置。改档只动这一个数。
 * ③ 卡内列表区 `min-h-0 flex-1 overflow-y-auto` 承担溢出 → 内部滚动条优先；
 * ④ overflow-hidden：下限之和仍超出余高的极矮面板兜底，裁在卡内不外溢。
 * 前提是「面板根有确定高度」——由 features/layout/scrollportFit 量出宿主滚动
 * 视口可见高写回根元素（宿主视图区在 active 相位按内容增高，没有确定高度时
 * flex-1/min-h-0/自滚全部失效，那才是先前「改了卡内高度还是不行」的根因）。
 * 下限与两卡的其他共性都收在这一个常量里，调档只动这里。 */
export const BOARD_PANEL_CARD_CLASS = `flex flex-1 flex-col overflow-hidden min-h-[300px] ${PANEL_CARD_CLASS}`;

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

/** 团队首字徽章（原 teamsButton 局部常量收编——M7-11 同值异名归一）：对话
 * 选中团队的按钮 chip 面（18×18 圆角方 + 首字），团队列表卡标题复用同一
 * 常量（用户迭代 2026-09-07），两处视觉由构造保证一致。 */
export const TEAM_CHIP_CLASS =
  'inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border border-solid bg-background text-xs font-semibold text-primary';

/** 原 styles.cardGrid（角色卡片栅格，自适应列）——现仅角色列表消费（团队
 * 卡已拆 TEAM_GRID_CLASS、任务卡 TASK_GRID_CLASS，不再共用）：按面板宽度
 * 自适应列数，卡片不拉成长条。用户迭代 2026-09-07「角色列表卡片拉长一点」：
 * 最小 210px → 240px 加宽一档（与团队卡同档）。 */
export const CARD_GRID_CLASS = 'grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3';

/** 任务列表小卡栅格（十二轮 DA25：用户拍板「卡片再大一点」——任务卡比团队
 * 卡再宽一档，最小 260px 自适应列，窄列少宽列多；任务列表专用，不并轨
 * CARD_GRID_CLASS 以免牵动团队/角色列表。用户 2026-09-14「任务卡片变长
 * 一点，目前跳转会话/删除/开始按钮溢出了」：最小 260px → 300px 再宽一档
 * ——底栏三钮（跳转会话/删除/开始）在 260px 档挤爆卡宽，加宽后单行容纳；
 * 看板任务小卡共用同栅格，一并受益）。 */
export const TASK_GRID_CLASS = 'grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3';

/** 任务列表小卡布局类（十四轮 DA27 卡内纵向排布：头行/信息行/文件夹行/底栏
 * ——底色/边框/悬停由 .eteams-task-card 样式表接管，见 ROLE_LIST_CSS）。
 * 对话内任务卡（pages/taskCard）复用同一布局类，两处卡面同构（2026-09-15
 * 用户「对话里面的任务卡片完全按照任务列表中的任务卡片样式来」）。 */
export const TASK_LIST_CARD_CLASS = 'flex min-w-0 flex-col gap-2 rounded-xl p-3.5';

/** 团队列表小卡栅格（用户迭代 2026-09-07：团队卡加宽一档——最小 240px 自
 * 适应列，窄列少宽列多；角色列表维持 210px 原档、任务卡 260px 仍宽一档）。
 * 专用常量不并轨 CARD_GRID_CLASS，改动不牵动角色列表（同 TASK_GRID_CLASS
 * 不并轨的纪律）。 */
export const TEAM_GRID_CLASS = 'grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3';
/**
 * 角色/团队/任务列表注入样式表（ROLE_LIST_CSS）消费的主题 token——S12–S14
 * 迁移后 inline 样式消费面已清空；hover/focus-within/attr 选择器仍需样式表
 * 承载（D22f：伪类规则无法用工具类表达，同注入这里）。任务主列表小卡
 * （十一轮 DA24）复用团队卡同款底色/边框/悬停（.eteams-task-card 别名选择
 * 器并轨）。原生 details/summary 样式已随展开面迁移 shadcn Accordion 删除
 * （docs/43 一对一检索核对，2026-09-05）。
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
.eteams-task-card,.eteams-team-card{background:var(--background);border:1px solid var(--border);box-shadow:0 1px 2px rgba(15,23,42,0.05);transition:background .15s ease,border-color .15s ease,box-shadow .15s ease}
.eteams-task-card:hover,.eteams-team-card:hover{border-color:color-mix(in srgb,var(--foreground) 18%,transparent);background:var(--muted)}
/* 成员略缩图动效（用户迭代 2026-09 九）：小号头像负间距叠放；滑过整组时
   间距松开（互相挤开），滑过单个头像时它放大浮到顶层——margin/transform
   过渡驱动，JSX 只挂 .eteams-team-avatars 类。 */
.eteams-team-avatars>*{position:relative;margin-left:-6px;transition:margin-left .18s ease,transform .18s ease}
.eteams-team-avatars>:first-child{margin-left:0}
.eteams-team-avatars:hover>*{margin-left:-2px}
.eteams-team-avatars>*:hover{transform:scale(1.35);z-index:30}
/* 删除钮：已迁 shadcn Button（outline sm + destructive 文字，使用位
   roster/rosterPage（原 membersTab）——docs/43 扫描整改）；类规则随迁删除。 */
.eteams-role-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eteams-team-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 原生 details/summary 样式（构建工作台展开指示）已随展开面迁移 shadcn
   Accordion/Collapsible 删除——全仓已无 <details> 消费位（docs/43 一对一
   检索核对）。 */
`;

/** ================================== 工具函数 ================================== */

/** Sort rank: 主对话注入角色 system first（用户迭代 2026-09-08「把 system
 * 排到第一个去」），leader second, role builder third, everyone else after. */
export function memberRank(name: string): number {
  if (name === ROOT_ROLE_NAME) return 0;
  if (name === LEADER_NAME) return 1;
  if (name === ROLE_BUILDER_NAME) return 2;
  return 3;
}

/** tone 徽标族的类名组装（模块级纯函数，调用时点在渲染期）：pillClass 拼
 * 底座 + tone 表，dotClass 拼 dot 底座 + tone 色表——Pill 组件消费。 */
export const pillClass = (tone: Tone): string => cn(PILL_BASE_CLASS, PILL_TONE_CLASS[tone]);
/** 原 fns.dot 的类名版：D22e 后 dot 是状态色的唯一载体——DOT_BASE_CLASS/
 * DOT_TONE_CLASS 已迁 taskDisplayStatus（docs/29 B，与展示态/tone 同家），
 * dotClass 经 import 消费。 */
export const dotClass = (tone: Tone): string => cn(DOT_BASE_CLASS, DOT_TONE_CLASS[tone]);
