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

/** 徽章观感对齐主会话模型座位（trigger：28px 高 / 24px 圆角胶囊 /
 * 13px·20px medium / label-secondary 字色）并按用户要求带**背景色**
 * （用户迭代 2026-09-07「也没主会话一样有背景色」）——muted 淡底胶囊。
 * inline-block + truncate 防长 model id 把工具行撑爆。 */
const BADGE_CLASS =
  'inline-block h-7 max-w-[260px] truncate rounded-full bg-muted px-2.5 text-[13px] leading-[28px] font-medium text-muted-foreground';

/** 徽章标题（原生 tooltip；静态串防闪烁——不随路线值变化）。 */
const BADGE_TITLE = '子代理会话实际运行的模型路线';

/**
 * 徽章文本拼装（纯函数，tests/sessionModelBadge.test.ts 逐分支锁定）：
 * 显示目录模型名（用户迭代 2026-09-08「去掉领队 ·，显示目录模型」——模型
 * id 本身可能是限定串如 z-ai/glm-5.3-free，主会话座位显示的是目录项
 * name）；目录未命中回退 `provider/model` 原值。非子代理或无观测路线返回
 * 空串——消费位以空串判「不渲染」。
 */
export function sessionModelLabel(view: SessionRouteView): string {
  if (view.subagent !== true) return '';
  const route = view.route;
  if (route === null || route === undefined) return '';
  const label = view.modelLabel;
  if (label !== null && label !== undefined && label !== '') return label;
  return `${route.provider}/${route.model}`;
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
