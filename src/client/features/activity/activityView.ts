/**
 * 看板动态派生层（用户 2026-09-14「看板里面的动态改成和任务绑定……另加一个
 * 决策面板」）：纯函数、读取时计算、不落盘——把宿主快照里的原始数据投影成
 * 三个「接口」供看板渲染：
 * - `ActivityRow`：任务绑定的**动态时间线**行（事件流 + 任务标签 + 语义色调）；
 * - `PendingAction`：**决策面板**行（待决策 + 待问答统一成「需要用户处理」的
 *   可点击项，带跳转目标会话）；
 * - `DecidedAction`：**决策面板『已决策』**历史行（已处置升级决策 + 已结束问答
 *   单，用户 2026-09-14「做过决策后决策面板还是 0，历史也要显示」）。
 *
 * 宿主只暴露原始数据（事件自带 taskSubject/tone、问答自带弹窗落点会话），
 * 组合与呈现收口在此；分层纪律：features 只依赖 lib/ 与同级 features，不碰
 * pages（页面组件在 pages/board 消费本模块）。
 *
 * @module dsh-eteams/client/activityView
 */
import type { Tone } from '../tasks/taskDisplayStatus';
import type { TeamSnapshot } from '../../lib/monitor';

/** 语义色调白名单（旧运行时事件缺 tone 时按 info 兜底）。 */
const TONES: readonly Tone[] = ['info', 'ok', 'warn', 'err', 'muted'];

/** 事件色调整形：未知/缺省 → info（不臆造档位）。 */
function asTone(value: string | undefined): Tone {
  return value !== undefined && (TONES as readonly string[]).includes(value)
    ? (value as Tone)
    : 'info';
}

/** 动态时间线一行（任务绑定）。 */
export interface ActivityRow {
  /** 稳定键：`e<seq>`。 */
  key: string;
  at: number;
  actor: string;
  text: string;
  tone: Tone;
  taskId: number | null;
  /** 任务标签主题；null = 该事件无任务或任务已删（标签退化为 #id）。 */
  taskSubject: string | null;
}

/** 决策面板一行（待决策 / 待问答统一接口）。 */
export interface PendingAction {
  /** 稳定键：决策 `d<id>` / 问答 `a<askId>`。 */
  key: string;
  kind: 'decision' | 'ask';
  at: number;
  /** 主标题：决策取任务主题/#id，问答取「<提问者> 的问答（N 问）」。 */
  title: string;
  /** 补充说明：决策取失败原因，问答为空串。 */
  detail: string;
  taskId: number | null;
  taskSubject: string | null;
  /** 跳转目标会话 id（问答=弹窗实际落点；决策=任务主对话）；null=无法定位。 */
  sessionId: string | null;
  /** 落点是否主对话（决策恒 true；问答按宿主记录，未知按否）。 */
  isMainSession: boolean;
}

/**
 * 动态时间线：按时间倒序（新→旧，最新在最上），补任务标签主题与色调。用户
 * 2026-09-14「动态按时间倒序排列，最新的排最上面」：显式按 `at` 降序排序
 * （同毫秒按 `seq` 降序稳定），不依赖宿主快照数组的既有次序。任务的当前
 * 主题优先取事件自带 `taskSubject`，缺失时按 `taskId` 现查快照任务集（旧
 * 运行时兼容）；任务已删 → null。
 */
export function activityRowsOf(team: TeamSnapshot): ActivityRow[] {
  const subjectById = new Map<number, string>(team.tasks.map((t) => [t.taskId, t.subject]));
  return [...team.latestEvents]
    .sort((a, b) => b.at - a.at || b.seq - a.seq)
    .map((e): ActivityRow => ({
      key: `e${e.seq}`,
      at: e.at,
      actor: e.actor,
      text: e.text,
      tone: asTone(e.tone),
      taskId: e.taskId,
      taskSubject:
        e.taskSubject ?? (e.taskId !== null ? (subjectById.get(e.taskId) ?? null) : null),
    }));
}

/**
 * 决策面板：待决策 + 待问答统一成可点击项（按时间升序，最早待处理在前）。
 * - 决策：跳转目标 = 任务主对话（`task.sessionId`，`main_session_id`），
 *   isMain=true；任务已删 → sessionId null（按钮点击兜底提示）。
 * - 问答：跳转目标 = 弹窗实际落点 `deliverySessionId`（v14）；旧行缺列时退
 *   化为该任务主对话、再退提问会话 `askingSessionId`；isMain 按记录透传。
 */
export function pendingActionsOf(team: TeamSnapshot): PendingAction[] {
  const taskById = new Map(team.tasks.map((t) => [t.taskId, t]));
  const tasks: PendingAction[] = [];
  for (const d of team.pendingDecisions) {
    const task = taskById.get(d.taskId);
    const subject = task?.subject ?? null;
    tasks.push({
      key: `d${d.id}`,
      kind: 'decision',
      at: d.createdAt,
      title: subject ?? `#${d.taskId}`,
      detail: d.error,
      taskId: d.taskId,
      taskSubject: subject,
      sessionId: task?.sessionId ?? null,
      isMainSession: true,
    });
  }
  for (const a of team.pendingAsks) {
    const mainTaskId = a.mainTaskId ?? null;
    const task = mainTaskId !== null ? taskById.get(mainTaskId) : undefined;
    const subject = task?.subject ?? null;
    tasks.push({
      key: `a${a.askId}`,
      kind: 'ask',
      at: a.createdAt,
      title: `${a.askingName} 的问答（${a.questionCount} 问）`,
      detail: '',
      taskId: mainTaskId,
      taskSubject: subject,
      sessionId: a.deliverySessionId ?? task?.sessionId ?? a.askingSessionId ?? null,
      isMainSession: a.deliveryIsMain ?? false,
    });
  }
  return tasks.sort((x, y) => x.at - y.at);
}

/** 决策面板「已决策」历史一行（已处置决策 / 已结束问答，统一接口）。 */
export interface DecidedAction {
  /** 稳定键：决策 `rd<id>` / 问答 `ra<askId>`。 */
  key: string;
  kind: 'decision' | 'ask';
  /** 处置/作答时刻（缺省回退创建时刻）。 */
  at: number;
  /** 主标题：决策取任务主题/#id，问答取「<提问者> 的问答（N 问）」。 */
  title: string;
  /** 处置结论（决策，含备注）或答案摘要（问答，无答案时给状态文案）。 */
  detail: string;
  /** 语义色调：决策=ok；问答 answered=ok / cancelled、expired=muted。 */
  outcome: 'ok' | 'muted';
  taskId: number | null;
  taskSubject: string | null;
  /** 回顾目标会话（决策=任务主对话；问答=弹窗落点→任务主对话→提问会话）。 */
  sessionId: string | null;
  isMainSession: boolean;
}

/** 决策处置结论 → 中文译名（未知/缺省按「已处理」；有备注时追加）。 */
function decisionOutcomeLabel(choice: string | null, note: string | null): string {
  const label =
    choice === 'reassign'
      ? '已换人重派'
      : choice === 'suspend'
        ? '已挂起'
        : choice === 'notify_user'
          ? '已通知用户'
          : '已处理';
  return note !== null && note !== '' ? `${label} · ${note}` : label;
}

/** 已结束问答单状态 → 文案（answered 正常有答案摘要，不另标）。 */
const ASK_STATUS_LABEL: Record<string, string> = {
  cancelled: '已取消',
  expired: '已超时',
};

/**
 * 决策面板『已决策』历史：已处置升级决策 + 已结束问答单，按处置/作答时刻
 * **降序（最新在前）**，取最近 30 条（宿主已按量下发，此处兜底）。跳转目标
 * 口径与 {@link pendingActionsOf} 一致（决策=任务主对话；问答=弹窗落点→任务
 * 主对话→提问会话）；任务主题按快照现查，已删任务退化为 null。
 */
export function decidedActionsOf(team: TeamSnapshot): DecidedAction[] {
  const taskById = new Map(team.tasks.map((t) => [t.taskId, t]));
  const items: DecidedAction[] = [];
  for (const d of team.resolvedDecisions ?? []) {
    const task = taskById.get(d.taskId);
    const subject = task?.subject ?? null;
    items.push({
      key: `rd${d.id}`,
      kind: 'decision',
      at: d.resolvedAt ?? d.createdAt,
      title: subject ?? `#${d.taskId}`,
      detail: decisionOutcomeLabel(d.choice, d.note),
      outcome: 'ok',
      taskId: d.taskId,
      taskSubject: subject,
      sessionId: task?.sessionId ?? null,
      isMainSession: true,
    });
  }
  for (const a of team.recentAsks ?? []) {
    const mainTaskId = a.mainTaskId ?? null;
    const task = mainTaskId !== null ? taskById.get(mainTaskId) : undefined;
    const subject = task?.subject ?? null;
    items.push({
      key: `ra${a.askId}`,
      kind: 'ask',
      at: a.answeredAt ?? a.createdAt,
      title: `${a.askingName} 的问答（${a.questionCount} 问）`,
      detail: a.answerSummary !== '' ? a.answerSummary : (ASK_STATUS_LABEL[a.status] ?? ''),
      outcome: a.status === 'answered' ? 'ok' : 'muted',
      taskId: mainTaskId,
      taskSubject: subject,
      sessionId: a.deliverySessionId ?? task?.sessionId ?? a.askingSessionId ?? null,
      isMainSession: a.deliveryIsMain ?? false,
    });
  }
  return items.sort((x, y) => y.at - x.at).slice(0, 30);
}
