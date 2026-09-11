/**
 * 任务展示态派生层（用户迭代 2026-09-11 精简为 7 态）：底层状态机
 * （types.ts TaskStatus：creating/ready/start/paused/wait_user/completed/
 * cancelled）是调度/重试/依赖校验的运行依据，本模块提供三套展示词表与
 * tone——纯函数、读取时计算、不落盘、不写状态机。
 *
 * 同时是任务展示 tone 与词表的共同家：
 * - `STATUS_LABELS`：任务 7 态精确词表（八轮 DA21 页面化后无直接渲染方，
 *   仅作态键序的规范来源——STATUS_GROUPS 按其键序展开）。
 * - `ATTEMPT_STATUS_LABELS`：尝试（AttemptStatus 六态）词表——尝试行状态与
 *   任务态不同源，不复用任务词表。
 * - `isStartable`/`isTerminal`：开始钮状态判据（docs/44 44.2.2，M3 收拢
 *   tasks/taskListCard、tasks/taskSubtaskItem、任务详情页头三处开始钮判据）。
 * - `DOT_BASE_CLASS`/`DOT_TONE_CLASS`：6px 状态点工具类（D22e 彩点唯一载体，
 *   完整字面量映射表，21.5.1 禁拼接纪律）。
 *
 * @module dsh-eteams/client/taskDisplayStatus
 */

/** Semantic tone — every status color flows through these five buckets. */
export type Tone = 'info' | 'ok' | 'warn' | 'err' | 'muted';

/** 任务 7 态精确词表（用户迭代 2026-09-11 精简：draft/ready/wait 并入
 * ready——「待开始」，wait_decision/failed 并入 wait_user——「待用户」；
 * creating = 面板手动创建占位「创建中」，键序在最前）。 */
export const STATUS_LABELS: Record<string, string> = {
  creating: '创建中',
  ready: '待开始',
  start: '执行中',
  paused: '已挂起',
  wait_user: '待用户',
  completed: '已完成',
  cancelled: '已取消',
};

/** 尝试（AttemptStatus）六态词表（TaskDetailContent 尝试行消费；与任务态不同源）。 */
export const ATTEMPT_STATUS_LABELS: Record<string, string> = {
  pending_accept: '待接取',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  revoked: '已撤销',
  paused: '已挂起',
};

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

/** 展示态桶（组卡汇总与分组语义的归并层）：init/created/waiting/doing/done/
 * error 五桶（cancelled 归 error 桶——异常终态聚合需要「异常优先」语义，
 * 文案独立、颜色中性灰，避免把用户主动取消标成故障）。 */
export type DisplayStatusKey = 'init' | 'created' | 'waiting' | 'doing' | 'done' | 'error';

/** 一条展示态：文案/点色/detail。 */
export interface DisplayStatus {
  key: DisplayStatusKey;
  label: string;
  tone: Tone;
  detail: string;
}

/**
 * 7 态 → 展示态映射表（用户迭代 2026-09-11 精简）：creating→init（面板手动
 * 创建占位，尚未进入执行语义，docs/panelTaskCommission）；ready→created
 * 「待开始」；start→doing；paused→waiting；wait_user→error 桶但 warning 黄
 * （等人介入不是故障）；completed→done；cancelled→error 桶但文案「已取消」、
 * 中性灰（同桶异色）。
 *
 * 无成员不设状态——「需要选择成员」是指派提示不是状态（成员卡槽空槽即
 * 提示面）。detail 只并入 retryCount>0 的重试计数。
 */
const DISPLAY_STATUS_TABLE: Record<string, { key: DisplayStatusKey; label: string; tone: Tone }> = {
  creating: { key: 'init', label: '创建中', tone: 'info' },
  ready: { key: 'created', label: '待开始', tone: 'info' },
  start: { key: 'doing', label: '执行中', tone: 'info' },
  paused: { key: 'waiting', label: '已挂起', tone: 'warn' },
  wait_user: { key: 'error', label: '待用户', tone: 'warn' },
  completed: { key: 'done', label: '已完成', tone: 'ok' },
  cancelled: { key: 'error', label: '已取消', tone: 'muted' },
};

/**
 * 展示态派生。retryCount>0 时 detail 并入重试计数（顶层任务行既有
 * 「重试 n」标记口径）。未知状态（旧快照/词表外）按中性原样渲染，不臆造档位。
 */
export function displayStatusOf(status: string, retryCount = 0): DisplayStatus {
  const entry = DISPLAY_STATUS_TABLE[status];
  if (entry === undefined) {
    return { key: 'init', label: status, tone: 'muted', detail: '' };
  }
  const detail = retryCount > 0 ? `重试 ${retryCount}` : '';
  return { ...entry, detail };
}

/**
 * 任务/小任务「开始」钮状态判据（docs/44 44.2.2，M3 自 tasks/taskSubtaskItem
 * 行头与任务详情页头收拢）：状态窗口 = ready（用户迭代 2026-09-11：draft/wait
 * 撤销并入 ready，唯一待开始态）。链是否为空（无链 = 行内「需要选择成员」
 * 提示面）是数据判据，调用位与状态判据并列消费。
 */
export function isStartable(status: string): boolean {
  // 用户迭代 2026-09-11：draft/wait 并入 ready，唯一待开始态就是 ready。
  return status === 'ready';
}

/**
 * 主任务（group）「开始」钮状态判据（docs/44 44.2.2，M3 自 tasks/taskListCard
 * 底栏与组详情页头收拢）：非终态一律渲染（completed/cancelled 外——二十七
 * 轮 DA40 判据放宽，用户「还是没看到开始按钮」：终态才收）。结构判据
 * （kind === 'group'、小任务数 > 0）留在调用位，与状态判据并列消费。
 */
export function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'cancelled';
}

/**
 * 主任务（group）「开始」钮状态判据扩位（docs/panelTaskCommission）：
 * 非终态、**非创建中**、**非已完成**——创建中的容器（面板手动建任务占位）
 * 计划未定不可开跑（宿主 startGroupTask 同闸）；completed 是「当前小任务都
 * 完成」的标识（用户迭代 2026-09-11），要再跑得先追加小任务把容器拉回
 * ready。结构判据（kind === 'group'、小任务数 > 0）留在调用位。
 */
export function isGroupStartable(status: string): boolean {
  return !isTerminal(status) && status !== 'creating' && status !== 'completed';
}

/** 组卡汇总 chip（B.2 group 汇总规则）：一条可渲染的汇总（tone/icon/detail）。 */
export interface GroupSummary {
  label: string;
  tone: Tone;
  /** 前缀字形（仅异常桶带 ✕，「✕ n 项异常」；其余空串）。 */
  icon: string;
  /** 首个异常小任务的精确文案。 */
  detail: string;
}

/**
 * 组卡小任务汇总（ready 且存在小任务时调用方才消费）：优先级 error >
 * doing > waiting > created：
 * - 含任一 error 桶小任务（wait_user/cancelled）→「✕ n 项异常」（点色 err；
 *   detail 取首个异常的词表文案）；
 * - 否则含 doing（start）→「n 执行中」（info）；
 * - 否则含 waiting（paused）→「n 已挂起」（warn）；
 * - 全部 done → null（「小任务 n/n 完成」进度行已表达，不加 chip）；
 * - 其余（ready 混合）→ null（用户迭代 2026-09-08「去掉那个圆角的待开始」：
 *   卡底状态 pill 已表达待开始，chip 再画一个重复了——chip 只承担异常/
 *   执行中/挂起这类增量信息）。
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
      return { label: `${errors.length} 项异常`, tone: 'err', icon: '✕', detail: first.label };
    }
  }
  const doing = views.filter((v) => v.key === 'doing');
  if (doing.length > 0) {
    return { label: `${doing.length} 执行中`, tone: 'info', icon: '', detail: '' };
  }
  const waiting = views.filter((v) => v.key === 'waiting');
  if (waiting.length > 0) {
    return { label: `${waiting.length} 已挂起`, tone: 'warn', icon: '', detail: '' };
  }
  return null;
}

/**
 * 顶层状态分组（7 态一列——每态独立成组，组头 label/tone 与行内 pill
 * 同口径）：creating 创建中 info / ready 待开始 info（就绪待派单列）/
 * start 执行中 info / paused 已挂起 warn / wait_user 待用户 warn /
 * completed 已完成 ok / cancelled 已取消 muted。
 *
 * 十一轮 DA24 后任务列表页平铺小卡栅格，不再按状态分区渲染（本表无运行时
 * 渲染方）——保留为 7 态键序的结构化规范（tests/taskDisplayStatus.test.ts
 * 锁定），后续需要按态聚合时复用。
 */
export const STATUS_GROUPS: { id: string; label: string; statuses: string[]; tone: Tone }[] = (
  Object.keys(STATUS_LABELS) as string[]
).map((status) => {
  const view = DISPLAY_STATUS_TABLE[status];
  return {
    id: status,
    label: view?.label ?? status,
    statuses: [status],
    tone: view?.tone ?? ('muted' as Tone),
  };
});
