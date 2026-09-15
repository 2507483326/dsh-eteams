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
 * 2026-09-15 用户迭代「都在一行，按照 #任务ID  对话名称  详情 显示」：决策
 * 面板行由「标题 + 副行」两行收成**一行三列**，投影随之下沉为列镜像——
 * `taskId`（`#id` 列）、`conversationName`（对话名称列：主对话 / 提问代理名）、
 * `detail`（详情列，原 title 与 detail 两段以「 · 」拼好），页面只管渲染。
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

/**
 * 决策面板一行（待决策 / 待问答统一接口）：**列镜像**——面板一行三列
 * （`#id` · 对话名称 · 详情），投影直接给出三列的值，页面不再自行拼装
 * （用户 2026-09-15「都在一行，按照 #任务ID  对话名称  详情 显示」）。
 */
export interface PendingAction {
  /** 稳定键：决策 `d<id>` / 问答 `a<askId>`。 */
  key: string;
  kind: 'decision' | 'ask';
  at: number;
  /** `#id` 列：问答取绑定的大任务号，决策取本任务号；null = 无绑定任务
   * （旧快照缺 mainTaskId / 任务已删）。 */
  taskId: number | null;
  taskSubject: string | null;
  /** 对话名称列：弹窗落点会话——主对话 → 「主对话」，落点退回提问子会话时
   * 显示提问代理名（用户 2026-09-15「不是主对话对话名称显示对应的代理名
   * 称」）；决策恒「主对话」。 */
  conversationName: string;
  /** 详情列：问答=「<提问者> 的问答（N 问）」；决策=任务主题（有失败原因时
   * 以「 · 」追加）。 */
  detail: string;
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
export function activityRowsOf(team: TeamSnapshot | undefined): ActivityRow[] {
  // 无团队（看板在尚未建队时照常渲染，用户 2026-09-15「看板，团队为空时，
  // 还是显示原来的东西，不需要还没有团队提示」）→ 空时间线。
  if (team === undefined) return [];
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

/** 对话名称列的主对话档（非主对话档 = 提问代理名，见 conversationNameOf）。 */
const MAIN_CONVERSATION = '主对话';

/**
 * 对话名称列取值：落点为主对话 → 「主对话」；否则为提问代理名——弹窗退回的
 * 是提问子代理自己的会话，那个会话正是该代理的对话。
 */
function conversationNameOf(isMainSession: boolean, askingName: string): string {
  return isMainSession ? MAIN_CONVERSATION : askingName;
}

/** 详情列拼装：各段去空后以「 · 」连接（空段不留分隔符，全空 → 空串）。 */
function detailTextOf(parts: readonly (string | null | undefined)[]): string {
  return parts
    .map((part) => (part ?? '').trim())
    .filter((part) => part !== '')
    .join(' · ');
}

/**
 * 决策面板：待决策 + 待问答统一成可点击项（按时间升序，最早待处理在前）。
 * - 决策：`#id` = 本任务号；对话名称恒「主对话」；详情 = 任务主题 · 失败原因；
 *   跳转目标 = 任务主对话（`task.sessionId`，`main_session_id`），任务已删 →
 *   sessionId null（按钮点击兜底提示）。
 * - 问答：`#id` = 绑定的大任务号；对话名称按弹窗落点（主对话 / 提问代理名）；
 *   详情 = 「<提问者> 的问答（N 问）」；跳转目标 = 弹窗实际落点
 *   `deliverySessionId`（v14），旧行缺列时退化为该任务主对话、再退提问会话
 *   `askingSessionId`。
 */
export function pendingActionsOf(team: TeamSnapshot | undefined): PendingAction[] {
  if (team === undefined) return [];
  const taskById = new Map(team.tasks.map((t) => [t.taskId, t]));
  const tasks: PendingAction[] = [];
  for (const d of team.pendingDecisions) {
    const task = taskById.get(d.taskId);
    const subject = task?.subject ?? null;
    tasks.push({
      key: `d${d.id}`,
      kind: 'decision',
      at: d.createdAt,
      taskId: d.taskId,
      taskSubject: subject,
      conversationName: MAIN_CONVERSATION,
      detail: detailTextOf([subject, d.error]),
      sessionId: task?.sessionId ?? null,
      isMainSession: true,
    });
  }
  for (const a of team.pendingAsks) {
    const mainTaskId = a.mainTaskId ?? null;
    const task = mainTaskId !== null ? taskById.get(mainTaskId) : undefined;
    const subject = task?.subject ?? null;
    const isMainSession = a.deliveryIsMain ?? false;
    tasks.push({
      key: `a${a.askId}`,
      kind: 'ask',
      at: a.createdAt,
      taskId: mainTaskId,
      taskSubject: subject,
      conversationName: conversationNameOf(isMainSession, a.askingName),
      detail: `${a.askingName} 的问答（${a.questionCount} 问）`,
      sessionId: a.deliverySessionId ?? task?.sessionId ?? a.askingSessionId ?? null,
      isMainSession,
    });
  }
  return tasks.sort((x, y) => x.at - y.at);
}

/** 决策面板「已决策」历史一行（已处置决策 / 已结束问答，统一接口）：与
 * {@link PendingAction} 同款**列镜像**（`#id` · 对话名称 · 详情）。 */
export interface DecidedAction {
  /** 稳定键：决策 `rd<id>` / 问答 `ra<askId>`。 */
  key: string;
  kind: 'decision' | 'ask';
  /** 处置/作答时刻（缺省回退创建时刻）。 */
  at: number;
  /** `#id` 列：问答取绑定的大任务号，决策取本任务号；null = 无绑定任务。 */
  taskId: number | null;
  taskSubject: string | null;
  /** 对话名称列（口径同 {@link PendingAction}；决策恒「主对话」）。 */
  conversationName: string;
  /** 详情列：决策=任务主题 · 处置结论（含备注）；问答=「<提问者> 的问答
   * （N 问）」· 答案摘要（无答案时给状态文案）。 */
  detail: string;
  /** 语义色调：决策=ok；问答 answered=ok / cancelled、expired=muted。 */
  outcome: 'ok' | 'muted';
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
export function decidedActionsOf(team: TeamSnapshot | undefined): DecidedAction[] {
  if (team === undefined) return [];
  const taskById = new Map(team.tasks.map((t) => [t.taskId, t]));
  const items: DecidedAction[] = [];
  for (const d of team.resolvedDecisions ?? []) {
    const task = taskById.get(d.taskId);
    const subject = task?.subject ?? null;
    items.push({
      key: `rd${d.id}`,
      kind: 'decision',
      at: d.resolvedAt ?? d.createdAt,
      taskId: d.taskId,
      taskSubject: subject,
      conversationName: MAIN_CONVERSATION,
      detail: detailTextOf([subject, decisionOutcomeLabel(d.choice, d.note)]),
      outcome: 'ok',
      sessionId: task?.sessionId ?? null,
      isMainSession: true,
    });
  }
  for (const a of team.recentAsks ?? []) {
    const mainTaskId = a.mainTaskId ?? null;
    const task = mainTaskId !== null ? taskById.get(mainTaskId) : undefined;
    const subject = task?.subject ?? null;
    const isMainSession = a.deliveryIsMain ?? false;
    items.push({
      key: `ra${a.askId}`,
      kind: 'ask',
      at: a.answeredAt ?? a.createdAt,
      taskId: mainTaskId,
      taskSubject: subject,
      conversationName: conversationNameOf(isMainSession, a.askingName),
      detail: detailTextOf([
        `${a.askingName} 的问答（${a.questionCount} 问）`,
        a.answerSummary !== '' ? a.answerSummary : (ASK_STATUS_LABEL[a.status] ?? ''),
      ]),
      outcome: a.status === 'answered' ? 'ok' : 'muted',
      sessionId: a.deliverySessionId ?? task?.sessionId ?? a.askingSessionId ?? null,
      isMainSession,
    });
  }
  return items.sort((x, y) => y.at - x.at).slice(0, 30);
}
