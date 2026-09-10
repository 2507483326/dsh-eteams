/**
 * 子会话模型徽章（`conversation.input.right` 槽位，与团队按钮同槽并存）。
 *
 * 用户迭代 2026-09-07「子代理会话中显示实际的 provider/model」；2026-09-09
 * 「请调研一下文档，这个功能不是插槽进子agent的对话框中就行？在子agent获取
 * 当前agent的模型ID很难吗」→ 调研后拍板方案 A：改读客户端会话投影。背景：
 * composer 的模型座位对已寻址子代理会话被宿主有意门控（ui-model-selection
 * 按 `subagentAddress`），子会话对话界面因此没有任何模型显示——本徽章在同
 * 槽渲染一条**非交互**只读标签补位。
 *
 * 数据源（2026-09-10 修正）：槽位组件的标准座位 kit。宿主渲染器给每个
 * session 作用域槽位组件下发 `SessionStandardProps` 三员——`sessionId`（
 * 会话 id 直传 prop）、`useSession`（会话快照选择器）、`useProjection`
 * （keyed 投影读取）——PlanChip 读 `useProjection("plan")`、InputBar 门控
 * 读 `useSession((s) => s.subagent)` 都是同款先例。首版误读 `props.session`
 * （框架从不传该 prop），`sessionId` 恒空 → 门控恒 false → 徽章静默不渲染，
 * 此版改正。
 *
 * 路线值 = `modelSelection` **持久投影**（`lib/sessionState.ts` 有契约依据
 * 与完整推理）——宿主从会话日志折叠的 durable 模型选择，`lastUsed` = 最近
 * 一次请求实际消耗的 provider/model，`next` = 下一次请求将用的选择；显示
 * 取 `next ?? lastUsed`（模型座位同款口径）。它重启/冷恢复免疫（投影从
 * 持久日志重建）。kit 的 `useProjection` 与 `ctx.sessions` 兜底探测读到
 * 的是**同一份** per-session 投影 store（官方 model-selection 插件正是把
 * `faceOf("modelSelection")` 包成 useProjection），两路同源。
 *
 * 门控 = `useSession` 快照的 `subagent` 地址非空（InputBar 同款判定；
 * ConversationSnapshot.subagent 与会话控制器的 subagentAddress 同写同撤）。
 * kit hook 缺席的轴（旧装配）落 `lib/sessionState.ts` 的 ctx.sessions 结构
 * 化探测兜底，绝不抛错。未发过请求且无选择的会话无路线值，徽章同样不渲染
 * （「实际」只显示真值，不显示猜测）。
 *
 * 显示名经共享模型目录反查（`lib/modelCatalog.ts` 共享 store，官方模型
 * 座位同源目录）；目录未命中回退 `provider/model` 原值。
 *
 * @module dsh-eteams/client/sessionModelBadge
 */
import { useSyncExternalStore, type ReactNode } from 'react';
import type { CatalogGroup } from '../lib/modelCatalog';
import { sharedCatalogStore } from '../lib/modelCatalog';
import {
  isAddressedSubagentSession,
  modelSelectionStoreOf,
  type ModelSelectionProjectionView,
} from '../lib/sessionState';
import { ClientErrorBoundary } from '../lib/diagnostics';

/** 会话快照里本徽章只关心的员（ConversationSnapshot.subagent 的结构化投影
 * ——null = 普通会话传输，非空对象 = 已寻址子代理会话）。 */
interface SubagentFace {
  readonly address?: unknown;
}

/** 标准座位入参（SessionStandardProps 契约的结构化投影）：框架随每个
 * session 作用域槽位组件下发，owner 不传任何东西——故全部可选，kit hook
 * 缺席的轴落 ctx.sessions 兜底（结构化 typing，不触及宿主未导出的契约名）。 */
interface SessionModelBadgeProps {
  /** 框架解析的会话 id（渲染器注入，不是 owner prop）。 */
  readonly sessionId?: string;
  /** 会话快照选择器 hook（ConversationSnapshot 的结构化读取）。 */
  readonly useSession?: <S>(
    selector: (snapshot: { subagent?: SubagentFace | null } | undefined) => S,
  ) => S;
  /** keyed 投影读取 hook（该键尚无值时返回 undefined）。 */
  readonly useProjection?: (key: string) => unknown;
}

/** 徽章观感对齐主会话模型座位（trigger：28px 高 / 24px 圆角胶囊 /
 * 13px·20px medium / label-secondary 字色）并按用户要求带**背景色**
 * （用户迭代 2026-09-07「也没主会话一样有背景色」）——muted 淡底胶囊。
 * inline-block + truncate 防长 model id 把工具行撑爆。 */
const BADGE_CLASS =
  'inline-block h-7 max-w-[260px] truncate rounded-full bg-muted px-2.5 text-[13px] leading-[28px] font-medium text-muted-foreground';

/** 徽章标题（原生 tooltip；静态串防闪烁——不随路线值变化）。 */
const BADGE_TITLE = '子代理会话实际运行的模型路线';

/** modelSelection 投影键名（dsh-api-session-controller 同名投影）。 */
const MODEL_SELECTION_KEY = 'modelSelection';

/** 空订阅/空值兜底（store 缺席时 useSyncExternalStore 的恒定 noop 源）。 */
const NOOP_SUBSCRIBE = (): (() => void) => () => undefined;
const NOOP_SELECTION: ModelSelectionProjectionView | undefined = undefined;

/**
 * 从投影视图取显示路线：`next ?? lastUsed`（模型座位同款），两段任一为空
 * 即无效——返回 null = 无真值，徽章不渲染。
 */
export function badgeRouteOf(
  view: ModelSelectionProjectionView | undefined,
): { provider: string; model: string } | null {
  const route = view?.next ?? view?.lastUsed ?? null;
  if (route === null || typeof route !== 'object') return null;
  const provider = route.provider;
  const model = route.model;
  if (typeof provider !== 'string' || typeof model !== 'string') return null;
  if (provider === '' || model === '') return null;
  return { provider, model };
}

/**
 * 徽章文本拼装（纯函数，tests/sessionModelBadge.test.ts 逐分支锁定）：
 * 目录显示名优先（用户迭代 2026-09-08「显示目录模型」——模型 id 本身可能
 * 是限定串如 z-ai/glm-5.3-free，主会话模型座位显示的是目录项 name）；目录
 * 未命中回退 `provider/model` 原值。
 */
export function sessionBadgeLabel(
  route: { provider: string; model: string } | null,
  groups: readonly CatalogGroup[] | undefined,
): string {
  if (route === null) return '';
  const group = groups?.find((g) => g.id === route.provider);
  const model = group?.models.find((m) => m.id === route.model);
  if (model !== undefined && model.name !== '') return model.name;
  return `${route.provider}/${route.model}`;
}

/**
 * kit 门控判定（纯函数，tests 逐分支锁定）：会话快照的 subagent 面非空
 * 即「已寻址子代理会话」（InputBar 同款），null/undefined = 普通会话。
 */
export function kitGateOf(subagent: SubagentFace | null | undefined): boolean {
  return subagent !== null && subagent !== undefined;
}

/** The eteams composer tool-row badge: one subagent session's actual model route. */
export function SessionModelBadge(props: SessionModelBadgeProps): ReactNode {
  const sid = typeof props.sessionId === 'string' ? props.sessionId : '';
  // 标准 kit hook 先取到局部变量再调用（成员名不以 use 开头，hook 判定
  // 不受影响；是否在场均恒定——props 随组件 mounting 固定，hook 顺序稳定）。
  const sessionHook = typeof props.useSession === 'function' ? props.useSession : undefined;
  const projectionHook =
    typeof props.useProjection === 'function' ? props.useProjection : undefined;
  // 门控（kit 轴）：会话快照 subagent 非空 = 已寻址子代理会话（undefined =
  // kit hook 缺席 → 落兜底）。
  const kitSubagent = sessionHook?.((snapshot) => snapshot?.subagent ?? null);
  // 路线值（kit 轴）：modelSelection 持久投影——与 ctx.sessions 兜底探测同
  // 源（官方 model-selection 插件就是把同一份 faceOf 包成 useProjection）。
  const kitSelection = projectionHook?.(MODEL_SELECTION_KEY) as
    | ModelSelectionProjectionView
    | undefined;
  // 兜底 store 只在 kit 投影轴缺席时接入（两路同 store，重复订阅无谓）；
  // useSyncExternalStore 必须无条件调用——store 缺席落恒定 noop 源，hook
  // 顺序保持稳定。faceOf 每渲染调用——底层是同一份 snapshot 缓存，subscribe
  // 换引用只触发一次重订阅。
  const fallbackStore = projectionHook === undefined ? modelSelectionStoreOf(sid) : null;
  const fallbackSelection = useSyncExternalStore(
    fallbackStore?.subscribe ?? NOOP_SUBSCRIBE,
    fallbackStore?.getSnapshot ?? (() => NOOP_SELECTION),
  );
  // 共享模型目录（resolver 构造即后台加载，目录名反查只读）。
  const catalogStore = sharedCatalogStore();
  const catalog = useSyncExternalStore(
    catalogStore?.subscribe ?? NOOP_SUBSCRIBE,
    catalogStore?.getSnapshot ?? (() => undefined),
  );
  // 逐轴择源：kit hook 在场用 kit 判定/读值，缺席该轴落 ctx.sessions 兜底。
  const gated =
    sessionHook === undefined ? isAddressedSubagentSession(sid) : kitGateOf(kitSubagent);
  const selection = projectionHook === undefined ? fallbackSelection : kitSelection;
  const route = gated ? badgeRouteOf(selection) : null;
  const label = sessionBadgeLabel(route, catalog?.value?.groups);
  if (label === '') return null;
  return (
    <ClientErrorBoundary label="子会话模型徽章">
      {/* 表面根挂 `.eteams-ui`（D19b 作用域硬要求）：工具类经后代选择器生效
      ——故根元素的布局只能走 inline style（作用域类对根自身不生效，实测
      复刻：inline 根的基线 strut 在胶囊下方多出 7px，flex 行 items-center
      居中 35px 根 → 胶囊比同排 28px 按钮高 3.5px；teamsButton 根同款处理
      同因）。inline-flex 后胶囊成 flex item，与按钮逐像素同心（实测
      deltaCy=0）。 */}
      <span
        className="eteams-ui"
        data-eteams="model-badge"
        style={{ display: 'inline-flex', alignItems: 'center' }}
      >
        <span className={BADGE_CLASS} title={BADGE_TITLE}>
          {label}
        </span>
      </span>
    </ClientErrorBoundary>
  );
}
