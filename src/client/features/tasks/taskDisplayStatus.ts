/**
 * 任务展示态派生层（docs/29 B 节）：底层 13 态状态机不动（types.ts TaskStatus
 * + taskMachine 迁移边是调度/重试/依赖阻断的运行依据），本模块把 13 态映射为
 * 用户口径六档 + cancelled 分支——纯函数、读取时计算、不落盘、不写状态机。
 *
 * 同时是任务/成员两套展示 tone 与词表的共同家：
 * - `STATUS_LABELS`：13 态精确词表（原 eteamsView 同名表原值迁移至此——
 *   词表不删不改名不变值；TaskDrawer/attempt 行/成员状态 pill 等精度消费方
 *   经 import 继续使用，B.3 共存策略）。
 * - `memberTone`：成员状态五档 tone（原 eteamsView 同名函数迁移）。
 * - `DOT_BASE_CLASS`/`DOT_TONE_CLASS`：6px 状态点工具类（D22e 彩点唯一载体，
 *   完整字面量映射表，21.5.1 禁拼接纪律；eteamsView 经 import 消费）。
 *
 * @module dsh-eteams/client/taskDisplayStatus
 */

/** Semantic tone — every status color flows through these five buckets. */
export type Tone = 'info' | 'ok' | 'warn' | 'err' | 'muted';

/** 13 态精确词表（E14：同时被成员状态 pill 复用——staged/working 词表不同源，
 * 展示态映射只用于任务渲染位；值与 docs/29 E14 引证的原表逐字一致）。 */
export const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  ready: '待指派',
  assigned: '待接取',
  in_progress: '执行中',
  retrying: '重试中',
  paused: '已挂起',
  awaiting_decision: '待决策',
  needs_user: '待用户',
  suspended: '已暂停',
  blocked: '被阻断',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** 成员状态→Tone（原 eteamsView 同名函数原值迁移：working/busy 执行、
 * ready/idle/done 就绪、paused 挂起、failed/error 故障，其余中性）。 */
export function memberTone(status: string): Tone {
  if (status === 'working' || status === 'busy') return 'info';
  if (status === 'ready' || status === 'idle' || status === 'done') return 'ok';
  if (status === 'paused') return 'warn';
  if (status === 'failed' || status === 'error') return 'err';
  return 'muted';
}

/**
 * D22e 的 6px 状态点（彩点唯一载体）——原 eteamsView 同名常量原值迁移：
 * 执行中 business/sky、成功 success 绿、警告 warning amber、错误 destructive
 * 红、muted 中性灰（token 值已官网化）。完整字面量映射表（21.5.1）。
 */
export const DOT_BASE_CLASS = 'inline-block h-1.5 w-1.5 shrink-0 rounded-full';
export const DOT_TONE_CLASS: Record<Tone, string> = {
  info: 'bg-business',
  ok: 'bg-success',
  warn: 'bg-warning',
  err: 'bg-destructive',
  muted: 'bg-muted-foreground',
};

/** 展示态六档（docs/29 B.1）：cancelled 归 error 桶（异常终态聚合需要「异常
 * 优先」语义），文案独立、颜色中性灰——避免把用户主动取消标成故障。 */
export type DisplayStatusKey = 'init' | 'created' | 'waiting' | 'doing' | 'done' | 'error';

/** 一条展示态：文案/点色/detail（13 态差异小字，B.2 detail 字段）。 */
export interface DisplayStatus {
  key: DisplayStatusKey;
  label: string;
  tone: Tone;
  detail: string;
}

/**
 * 13 态 → 展示态映射表（B.2 逐格对表）：
 * draft→init；ready→created；assigned/blocked/paused/suspended→waiting；
 * in_progress/retrying→doing；completed→done；awaiting_decision/needs_user/
 * failed→error；cancelled→error 桶但文案「已取消」、中性灰（29-M3：同桶异色
 * ——awaiting/needs_user 行内 pill 点色 warning 黄、failed 红、cancelled 灰，
 * 勿走样成「error 桶一律红」）。
 *
 * detail 保留 13 态差异（B.2 detail 字段：文案直取 STATUS_LABELS 词表）——
 * 吞并进同一展示态的操作细节以小字跟在 pill 后（如「进行中 · 重试 2」
 * 「等待执行 · 已挂起」）；1:1 映射态（draft/ready/assigned/in_progress/
 * completed）不重复显示。
 */
const DISPLAY_STATUS_TABLE: Record<string, { key: DisplayStatusKey; label: string; tone: Tone }> = {
  draft: { key: 'init', label: '初始化', tone: 'muted' },
  ready: { key: 'created', label: '已创建', tone: 'info' },
  assigned: { key: 'waiting', label: '等待执行', tone: 'warn' },
  blocked: { key: 'waiting', label: '等待执行', tone: 'warn' },
  paused: { key: 'waiting', label: '等待执行', tone: 'warn' },
  suspended: { key: 'waiting', label: '等待执行', tone: 'warn' },
  in_progress: { key: 'doing', label: '进行中', tone: 'info' },
  retrying: { key: 'doing', label: '进行中', tone: 'info' },
  awaiting_decision: { key: 'error', label: '错误', tone: 'warn' },
  needs_user: { key: 'error', label: '错误', tone: 'warn' },
  completed: { key: 'done', label: '已完成', tone: 'ok' },
  failed: { key: 'error', label: '错误', tone: 'err' },
  cancelled: { key: 'error', label: '已取消', tone: 'muted' },
};

/** 13 态词表取词（noUncheckedIndexedAccess 下 Record 索引收窄 helper）。 */
const labelOf = (key: string): string => STATUS_LABELS[key] ?? '';

/** detail 词表：仅吞并态保留 13 态精确文案（B.2 detail 字段口径）。 */
const DISPLAY_DETAIL_TABLE: Record<string, string> = {
  blocked: labelOf('blocked'),
  paused: labelOf('paused'),
  suspended: labelOf('suspended'),
  retrying: labelOf('retrying'),
  awaiting_decision: labelOf('awaiting_decision'),
  needs_user: labelOf('needs_user'),
  failed: labelOf('failed'),
};

/**
 * 展示态派生（B.2）。retryCount>0 时 detail 并入重试计数（B.3 顶层任务行
 * 「retryCount 标记并入 detail」；retrying 无计数时回退词表文案「重试中」）。
 * 未知状态（旧快照/词表外）按中性原样渲染，不臆造档位。
 */
export function displayStatusOf(status: string, retryCount = 0): DisplayStatus {
  const entry = DISPLAY_STATUS_TABLE[status];
  if (entry === undefined) {
    return { key: 'init', label: status, tone: 'muted', detail: '' };
  }
  let detail = DISPLAY_DETAIL_TABLE[status] ?? '';
  if (retryCount > 0 && (status === 'retrying' || detail === '')) {
    detail = `重试 ${retryCount}`;
  }
  return { ...entry, detail };
}

/** 组卡汇总 chip（B.2 group 汇总规则）：一条可渲染的汇总（tone/icon/detail）。 */
export interface GroupSummary {
  label: string;
  tone: Tone;
  /** 前缀字形（仅异常桶带 ✕，B.2 「✕ n 项异常」；其余空串）。 */
  icon: string;
  /** 首个异常小任务的 detail（13 态差异小字）。 */
  detail: string;
}

/**
 * 组卡小任务汇总（B.2 规则 2：group.status==='ready' 且存在小任务时叠加；
 * 优先级 error > doing > waiting > created，与 docs/05.9 POISON 传染语义
 * 一致）：
 * - 含任一 error 桶小任务 → 「✕ n 项异常」（点色 err；detail 取首个异常）；
 * - 否则含 doing → 「n 执行中」（info）；
 * - 否则含 waiting → 「n 等待执行」（warn）；
 * - 全部 done → null（现有「小任务 n/n 完成」进度行已表达，不加 chip）；
 * - 其余（含 created/init 混合）→ 「待指派」（中性）。
 * group 的 draft（拆解中）不做汇总——调用方只在 ready 时消费本函数。
 */
export function groupDisplayOf(
  subs: readonly { status: string; retryCount?: number }[],
): GroupSummary | null {
  if (subs.length === 0) return null;
  const views = subs.map((s) => displayStatusOf(s.status, s.retryCount ?? 0));
  const errors = views.filter((v) => v.key === 'error');
  if (errors.length > 0) {
    const first = errors[0];
    if (first !== undefined) {
      return { label: `${errors.length} 项异常`, tone: 'err', icon: '✕', detail: first.detail };
    }
  }
  const doing = views.filter((v) => v.key === 'doing');
  if (doing.length > 0) {
    return { label: `${doing.length} 执行中`, tone: 'info', icon: '', detail: '' };
  }
  const waiting = views.filter((v) => v.key === 'waiting');
  if (waiting.length > 0) {
    return { label: `${waiting.length} 等待执行`, tone: 'warn', icon: '', detail: '' };
  }
  if (views.every((v) => v.key === 'done')) return null;
  return { label: '待指派', tone: 'muted', icon: '', detail: '' };
}

/**
 * 顶层状态分组（docs/29 B.3：收敛为展示态分组——分组边界从 13 态并成六档
 * + cancelled 独立组；行内展示态 pill 与组头同口径，消除「行在『待接取』组
 * 却显示『等待执行』」的错位）。statuses 仍是 13 态值（行过滤键），tone 沿用
 * 既有组语义：等待系黄、执行系蓝、成功绿、失败红、初始化/取消灰。
 */
export const STATUS_GROUPS: { id: string; label: string; statuses: string[]; tone: Tone }[] = [
  { id: 'init', label: '初始化', statuses: ['draft'], tone: 'muted' },
  { id: 'created', label: '已创建', statuses: ['ready'], tone: 'info' },
  {
    id: 'waiting',
    label: '等待执行',
    statuses: ['assigned', 'blocked', 'paused', 'suspended'],
    tone: 'warn',
  },
  { id: 'doing', label: '进行中', statuses: ['in_progress', 'retrying'], tone: 'info' },
  { id: 'done', label: '已完成', statuses: ['completed'], tone: 'ok' },
  {
    id: 'error',
    label: '错误',
    statuses: ['awaiting_decision', 'needs_user', 'failed'],
    tone: 'err',
  },
  { id: 'cancelled', label: '已取消', statuses: ['cancelled'], tone: 'muted' },
];
