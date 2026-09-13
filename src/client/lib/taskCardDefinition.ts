/**
 * 任务卡片的 Conversation Node 定义（React-free 纯核）——从卡片组件里单独拆出来
 * 有两个理由：① 折叠逻辑（match/start/update/buildViewNode + 结果解析）与 React
 * 解耦，vitest 可直接驱动、不必拉起组件树（本仓先例：lib/taskConversation.ts）；
 * ② 组件侧要 import {@link enterTeamsPanel}（视图层），定义若留在一起会把整棵视图
 * 树拖进单测。
 *
 * 卡片凭据 = 工具结果的**渲染文本**（`任务 #N 已提交（任务单文件夹 …）`）：
 * dsh-tools 契约只把 `output.render` 的文本块写进会话事件（`ToolResultBlock`），
 * 结构化 `output.taskId` 不下发到客户端。故 `update` 先定位 `tool-result` 块，
 * 再扫它**嵌套的 `content`** 文本块取任务号（优先 JSON 载荷，否则容错取 `#N`，
 * 见 {@link parseTaskIdFromResult}）。只认**不带 taskId 的提交**（新建主任务）；
 * 带 taskId 的收口提交由领队/主会话发起，不重复出卡。
 *
 * @module dsh-eteams/client/task-card-definition
 */

/** ================================== 类型 ================================== */

/** Card state folded from the submit-task tool events. */
export interface TaskCardState {
  subject: string;
  taskId: number | null;
  accepted: boolean;
}

/** Structural view of the Session events the definition matches. */
export interface SessionEventLike {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Structural view of one `tool/result` message content block. The model-facing
 * content lives in the NESTED `content`（render 块），不是块自身的 `text`。
 */
export interface ToolResultBlock {
  type: string;
  content?: unknown;
  isError?: boolean;
}

/** Structural view of one nested render content block. */
export interface TextBlock {
  type: string;
  text?: string;
}

/** ================================== 常量与映射表 ================================== */

/** Conversation Node definition: submit-task call/result → card node. */
export const taskCardDefinition = {
  kind: 'eteams-task',
  target: 'chat',
  match(event: SessionEventLike): { id: string; role: 'start' | 'update' } | null {
    if (event.type === 'tool/call' && event.data.name === 'eteams_submit_task') {
      // 只认新建（不带 taskId）的提交；带 taskId 的收口提交不出卡。
      return parseSubmitArgs(event.data.arguments) === undefined
        ? null
        : { id: String(event.data.callId), role: 'start' };
    }
    if (event.type === 'tool/result') {
      const source = (
        event.data.message as { source?: { kind?: string; callId?: unknown } } | undefined
      )?.source;
      if (source?.kind === 'tool') return { id: String(source.callId), role: 'update' };
    }
    return null;
  },
  start(_context: unknown, match: { event: SessionEventLike }): TaskCardState {
    const parsed = parseSubmitArgs(match.event.data.arguments);
    if (parsed === undefined) throw new Error('task card start requires a new-task submit');
    return { subject: parsed.subject, taskId: null, accepted: false };
  },
  update(context: { state: TaskCardState }, match: { event: SessionEventLike }): TaskCardState {
    if (match.event.type !== 'tool/result') return context.state;
    const data = match.event.data as { error?: unknown; message?: { content?: unknown } };
    if (data.error !== undefined) return context.state;
    const content = data.message?.content;
    const errored =
      Array.isArray(content) &&
      (content as ToolResultBlock[]).some((b) => b.type === 'tool-result' && b.isError === true);
    if (errored) return context.state;
    const taskId = parseTaskIdFromResult(content);
    return { ...context.state, accepted: true, taskId: taskId ?? context.state.taskId };
  },
  buildViewNode(context: {
    key: string;
    id: string;
    start?: { event: { seq: number }; location: unknown };
    state?: TaskCardState;
  }): {
    key: string;
    kind: string;
    id: string;
    target: string;
    anchorSeq: number;
    location: unknown;
    visibility: 'visible';
    data: Record<string, unknown>;
  } | null {
    if (context.start === undefined || context.state === undefined) return null;
    if (!context.state.accepted || context.state.taskId === null) return null;
    return {
      key: context.key,
      kind: 'eteams-task',
      id: context.id,
      target: 'chat',
      anchorSeq: anchorSeqOf(context.start),
      location: context.start.location,
      visibility: 'visible',
      data: { taskId: context.state.taskId, subject: context.state.subject },
    };
  },
};

/**
 * 卡片的排序锚点：回合收尾后取「回合末尾 - 0.1」，否则退回建单那次工具调用的
 * seq。理由：chat 会把 `anchorSeq < 最终回复节点 seq` 的节点折进可折叠的「回合
 * 过程块（思考/工具调用）」，卡片就会贴在隐藏的工具调用行上；锚到回合末尾
 * （> 最终回复 seq）即独立落在最终回复旁。回合未收尾时 location 里还没有
 * `turn.end`，此时先锚在工具调用处，收尾后引擎刷新 location 会重算。
 */
function anchorSeqOf(start: { event: { seq: number }; location: unknown }): number {
  const end = (
    start.location as { turn?: { end?: { seq?: unknown } } } | undefined
  )?.turn?.end?.seq;
  return typeof end === 'number' && Number.isFinite(end) ? end - 0.1 : start.event.seq;
}

/** ================================== 工具函数 ================================== */

/** 新建主任务的提交参数：只要 subject；带 taskId（收口提交）返回 undefined。 */
export function parseSubmitArgs(raw: unknown): { subject: string } | undefined {
  try {
    const args =
      typeof raw === 'string'
        ? (JSON.parse(raw) as Record<string, unknown>)
        : (raw as Record<string, unknown>);
    if (args.taskId !== undefined) return undefined;
    if (typeof args.subject === 'string') return { subject: args.subject };
  } catch {
    // unparseable arguments: no card
  }
  return undefined;
}

/** 从一段渲染文本取任务号：JSON 载荷（{taskId}）优先，否则容错取 `#N`。 */
function taskIdFromText(text: string): number | null {
  try {
    const parsed = JSON.parse(text) as { taskId?: unknown };
    if (typeof parsed.taskId === 'number' && Number.isFinite(parsed.taskId)) return parsed.taskId;
    if (
      typeof parsed.taskId === 'string' &&
      parsed.taskId !== '' &&
      Number.isFinite(Number(parsed.taskId))
    ) {
      return Number(parsed.taskId);
    }
  } catch {
    // 不是 JSON 载荷——退回从渲染文本里取 #N（宿主 render：任务 #N 已提交（…））
  }
  const match = /#(\d+)/.exec(text);
  return match === null ? null : Number(match[1]);
}

/**
 * 从 `tool/result` 的 message.content 取主任务号：定位 `tool-result` 块，再扫
 * 它**嵌套的 `content`** 文本块。宿主 render 是中文文本，结构化 output.taskId
 * 不进会话事件，故以渲染文本为准（JSON 命中优先，兼容将来改发 JSON）。
 */
export function parseTaskIdFromResult(blocks: unknown): number | null {
  for (const block of (Array.isArray(blocks) ? blocks : []) as ToolResultBlock[]) {
    if (block.type !== 'tool-result') continue;
    for (const inner of (Array.isArray(block.content) ? block.content : []) as TextBlock[]) {
      if (inner.type !== 'text' || typeof inner.text !== 'string') continue;
      const taskId = taskIdFromText(inner.text);
      if (taskId !== null) return taskId;
    }
  }
  return null;
}
