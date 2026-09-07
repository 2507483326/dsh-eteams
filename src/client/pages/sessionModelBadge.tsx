/**
 * 子会话模型徽章（`conversation.input.right` 槽位，与团队按钮同槽并存）。
 *
 * 用户迭代 2026-09-07「子代理会话中显示实际的 provider/model」：composer 的
 * 模型座位对子代理会话有意不可用（ui-model-selection 按 `subagentAddress`
 * 门控，"model selection is unavailable for addressed subagent sessions"），
 * 子会话对话界面因此没有任何模型显示。本徽章在 eteams 子代理会话（成员/
 * 领队/构建师）的输入栏渲染一条**非交互**只读标签，显示该会话实际运行的
 * provider/model——数据来自宿主 `GET /eteams-api/session-route`（usage 旁路
 * 对 `request/header`/`request/context` 事件的观测值，routeCache 按 sessionId
 * 折叠），5s 轮询自动跟随路线变化。
 *
 * 显示口径：只显示**观测值**——子会话发出首个请求前（或宿主重启后未再发
 * 请求时）无观测，徽章不渲染；非 eteams 子代理会话（用户自己的对话）宿主
 * 返回 subagent:false，徽章同样不渲染（主会话模型座位照旧）。
 *
 * @module dsh-eteams/client/sessionModelBadge
 */
import { useEffect, useState, type ReactNode } from 'react';
import { fetchSessionRoute, type SessionRouteView } from '../lib/api';
import { ClientErrorBoundary } from '../lib/diagnostics';

/** 槽位入参：结构化 session face（teamsButton 同款——structural typing，
 * 不触及宿主未导出的契约名），sessionId 即当前打开的会话。 */
interface SessionModelBadgeProps {
  readonly session?: unknown;
}

/** muted 小字档：与模型座位触发器的低调观感对齐（13px 座位 → 12px 徽章），
 * inline-block + truncate 防长 model id 把工具行撑爆。 */
const BADGE_CLASS =
  'inline-block max-w-[240px] truncate align-middle text-xs leading-[18px] text-muted-foreground';

/** 徽章标题（原生 tooltip；静态串防闪烁——不随路线值变化）。 */
const BADGE_TITLE = '子代理会话实际运行的模型（观测自最近一次请求）';

/**
 * 徽章文本拼装（纯函数，tests/sessionModelBadge.test.ts 逐分支锁定）：
 * kind=member → `{memberName} · {provider}/{model}`；captain → `领队 · …`；
 * builder → `构建师 · …`。非子代理或无观测路线（subagent≠true / route 空）
 * 返回空串——消费位以空串判「不渲染」。
 */
export function sessionModelLabel(view: SessionRouteView): string {
  if (view.subagent !== true) return '';
  const route = view.route;
  if (route === null || route === undefined) return '';
  const who =
    view.kind === 'captain'
      ? '领队'
      : view.kind === 'builder'
        ? '构建师'
        : (view.memberName ?? '');
  const routeText = `${route.provider}/${route.model}`;
  return who !== '' ? `${who} · ${routeText}` : routeText;
}

/** The eteams composer tool-row badge: one session's actual provider/model. */
export function SessionModelBadge(props: SessionModelBadgeProps): ReactNode {
  const sessionId = (props.session as { sessionId?: string } | undefined)?.sessionId;
  // 拉到的标签带上「它属于哪个会话」——切会话的瞬间旧标签不得残留
  //（fetch 在途的一帧里按 sid 不匹配渲染为空，而不是显示上一个会话的值）。
  const [fetched, setFetched] = useState<{ sid: string; label: string }>({
    sid: '',
    label: '',
  });
  // 5s 轮询（页面隐藏暂停；失败静默——徽章只是展示，与 presence 心跳同口径）。
  // 路线可中途变化（切换模型后新请求改写 routeCache），轮询让徽章自动跟随。
  useEffect(() => {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    let alive = true;
    const pull = (): void => {
      if (!alive || document.hidden) return;
      fetchSessionRoute(sessionId)
        .then((view) => {
          if (alive) setFetched({ sid: sessionId, label: sessionModelLabel(view) });
        })
        .catch(() => undefined);
    };
    pull();
    const timer = window.setInterval(pull, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [sessionId]);
  const label = fetched.sid === sessionId ? fetched.label : '';
  if (label === '') return null;
  return (
    <ClientErrorBoundary label="子会话模型徽章">
      {/* 表面根挂 `.eteams-ui`（D19b 作用域硬要求）：工具类经后代选择器生效。 */}
      <span className="eteams-ui" data-eteams="model-badge">
        <span className={BADGE_CLASS} title={BADGE_TITLE}>
          {label}
        </span>
      </span>
    </ClientErrorBoundary>
  );
}
