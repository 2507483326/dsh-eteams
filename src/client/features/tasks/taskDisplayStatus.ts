/**
 * 任务展示态派生层（docs/27 §27.9#11 十态收敛 + docs/panelTaskCommission
 * 第 11 态 creating）：底层 11 态状态机
 * （types.ts TaskStatus：creating/draft/ready/wait/start/paused/wait_decision/
 * wait_user/completed/failed/cancelled）是调度/重试/依赖阻断的运行依据，
 * 本模块提供三套展示词表与 tone——纯函数、读取时计算、不落盘、不写状态机。
 *
 * 同时是任务/成员两套展示 tone 与词表的共同家：
 * - `STATUS_LABELS`：任务 11 态精确词表（八轮 DA21 页面化后无直接渲染方，
 *   仅作态键序的规范来源——STATUS_GROUPS 按其键序展开）。
 * - `ATTEMPT_STATUS_LABELS`：尝试（AttemptStatus 六态）词表——尝试行状态与
 *   任务态不同源，不复用任务词表。
 * - `MEMBER_STATUS_LABELS`：成员聚合状态词表（staged/ready/working/paused/
 *   removed；memberStatusOf 聚合口径，任务态词表不再兼管成员状态）。
 * - `memberTone`：成员状态 tone（原 eteamsView 同名函数迁移，值域更新为
 *   新成员五态；旧值 busy/idle/done/failed/error 保留兜底不破老快照）。
 * - `isStartable`/`isTerminal`：开始钮状态判据（docs/44 44.2.2，M3 收拢
 *   tasks/taskListCard、tasks/taskSubtaskItem、任务详情页头三处开始钮判据）。
 * - `DOT_BASE_CLASS`/`DOT_TONE_CLASS`：6px 状态点工具类（D22e 彩点唯一载体，
 *   完整字面量映射表，21.5.1 禁拼接纪律）。
 *
 * @module dsh-eteams/client/taskDisplayStatus
 */

/** Semantic tone — every status color flows through these five buckets. */
export type Tone = 'info' | 'ok' | 'warn' | 'err' | 'muted';

/** 任务 11 态精确词表（docs/27 §27.9#11 + docs/panelTaskCommission 第 11 态
 * creating；二十四轮 DA37 用户拍板「没有什么草稿状态、待指派状态，只有待
 * 开始状态」——draft/ready 两态展示文案合并为「待开始」，词表仅作键序规范
 * 来源；creating = 面板手动创建占位「创建中」，键序在最前——比待开始更早
 * 的态）。 */
export const STATUS_LABELS: Record<string, string> = {
  creating: '创建中',
  draft: '待开始',
  ready: '待开始',
  wait: '待接取',
  start: '执行中',
  paused: '已挂起',
  wait_decision: '待决策',
  wait_user: '待用户',
  completed: '已完成',
  failed: '失败',
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

/** 成员聚合状态词表（memberStatusOf 聚合口径：任一实例行 working 即 working，
 * 其次 paused，无实例行 = staged）。 */
export const MEMBER_STATUS_LABELS: Record<string, string> = {
  staged: '未启动',
  ready: '就绪',
  working: '执行中',
  paused: '已挂起',
  removed: '已移出',
};

/** 成员状态→Tone（working 执行、ready 就绪、paused 挂起、staged/removed
 * 中性；旧快照值 busy/idle/done/failed/error 保留兜底）。 */
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
 * 11 态 → 展示态映射表：creating→init（面板手动创建占位，尚未进入执行
 * 语义，docs/panelTaskCommission）；draft→init；ready→created；wait/paused→waiting；
 * start→doing；completed→done；wait_decision/wait_user/failed→error；
 * cancelled→error 桶但文案「已取消」、中性灰（同桶异色——wait_decision/
 * wait_user 行内点色 warning 黄、failed 红、cancelled 灰）。
 *
 * 二十四轮 DA37（用户拍板「没有什么草稿状态、待指派状态，只有待开始状态」）：
 * draft 与 ready 展示**合并为「待开始」**（同 label 同 tone，桶键保留
 * init/created 不动组卡汇总优先级语义）；无成员不设状态——「需要选择成员」
 * 是指派提示不是状态（成员卡槽空槽即提示面）。
 *
 * 十态已是用户口径的精确粒度，detail 不再做吞并态补字；仅 retryCount>0
 * 并入重试计数。
 */
const DISPLAY_STATUS_TABLE: Record<string, { key: DisplayStatusKey; label: string; tone: Tone }> = {
  creating: { key: 'init', label: '创建中', tone: 'info' },
  draft: { key: 'init', label: '待开始', tone: 'info' },
  ready: { key: 'created', label: '待开始', tone: 'info' },
  wait: { key: 'waiting', label: '待接取', tone: 'warn' },
  paused: { key: 'waiting', label: '已挂起', tone: 'warn' },
  start: { key: 'doing', label: '执行中', tone: 'info' },
  wait_decision: { key: 'error', label: '待决策', tone: 'warn' },
  wait_user: { key: 'error', label: '待用户', tone: 'warn' },
  completed: { key: 'done', label: '已完成', tone: 'ok' },
  failed: { key: 'error', label: '失败', tone: 'err' },
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
 * 行头与任务详情页头收拢）：状态窗口 = ready / draft（三十六轮 DA49——派发核
 * draft 即就绪，待开始语义闭环；draft 与 ready 面板同显「待开始」，旧库导入
 * 的 draft 卡此前不渲染开始钮）。链是否为空（无链 = 行内「需要选择成员」
 * 提示面）是数据判据，调用位与状态判据并列消费——判定结果与收拢前逐位等价。
 */
export function isStartable(status: string): boolean {
  return status === 'ready' || status === 'draft';
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
 * 非终态且**非创建中**——创建中的容器（面板手动建任务占位）计划未定不可
 * 开跑（宿主 startGroupTask 同闸），面板两侧按钮判据收拢于此，与宿主守卫
 * 镜像。结构判据（kind === 'group'、小任务数 > 0）留在调用位。
 */
export function isGroupStartable(status: string): boolean {
  return !isTerminal(status) && status !== 'creating';
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
 * doing > waiting > created，与 POISON 传染语义一致：
 * - 含任一 error 桶小任务（wait_decision/wait_user/failed/cancelled）→
 *   「✕ n 项异常」（点色 err；detail 取首个异常的词表文案）；
 * - 否则含 doing（start）→ 「n 执行中」（info）；
 * - 否则含 waiting（wait/paused）→ 「n 待接取」（warn）；
 * - 全部 done → null（「小任务 n/n 完成」进度行已表达，不加 chip）；
 * - 其余（ready/draft 混合）→ 「待开始」（中性；二十四轮 DA37 文案合并）。
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
      return { label: `${errors.length} 项异常`, tone: 'err', icon: '✕', detail: first.label };
    }
  }
  const doing = views.filter((v) => v.key === 'doing');
  if (doing.length > 0) {
    return { label: `${doing.length} 执行中`, tone: 'info', icon: '', detail: '' };
  }
  const waiting = views.filter((v) => v.key === 'waiting');
  if (waiting.length > 0) {
    return { label: `${waiting.length} 待接取`, tone: 'warn', icon: '', detail: '' };
  }
  if (views.every((v) => v.key === 'done')) return null;
  return { label: '待开始', tone: 'muted', icon: '', detail: '' };
}

/**
 * 顶层状态分组（十态一列——每态独立成组，组头 label/tone 与行内 pill
 * 同口径；二十四轮 DA37 文案合并：draft/ready 同显「待开始」info）：
 * draft 待开始 info / ready 待开始 info（就绪待派单列）/
 * wait 待接取 warn / start 执行中 info / paused 已挂起 warn /
 * wait_decision 待决策 warn / wait_user 待用户 warn / completed 已完成 ok /
 * failed 失败 err / cancelled 已取消 muted。
 *
 * 十一轮 DA24 后任务列表页平铺小卡栅格，不再按状态分区渲染（本表无运行时
 * 渲染方）——保留为十态键序的结构化规范（tests/taskDisplayStatus.test.ts
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
