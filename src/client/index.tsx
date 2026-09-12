/**
 * dsh-eteams — client-plane plugin (browser bundle).
 *
 * Loaded through the DSH client bundle loader (`window.__ModuleLoader__`,
 * see scripts/wrap-client.mjs) with `inject: ['slots']`. Registers:
 *
 * 1. the 团队 tab — an entry in the `conversation.view` ring (id `eteams`,
 *    order 100) hosting the M4 activity panel (概览/成员/任务/动态 + 抽屉);
 * 2. the 团队 button — an entry at the right end of the composer tool row
 *    (`conversation.input.right`), opening the tabbed 团队/成员 popup whose
 *    team rows and 新增 shortcuts jump straight to the 团队 tab page; beside
 *    it the 子会话模型徽章 (order 101) — a read-only badge rendering an
 *    addressed subagent session's actual model route, read from the
 *    session-slot standard kit's `modelSelection` projection (用户迭代
 *    2026-09-07；2026-09-09 方案 A 改客户端投影订阅，/session-route 端点
 *    退役；主会话不渲染，模型座位照旧);
 * 3. the hero 团队 button — DOM-injected beside the 标准模式 preset chip on
 *    the not-started screen (no additive slot exists there), clicking into
 *    the 团队 tab page (full-screen 团队页 while the view ring is not
 *    rendered);
 * 4. the ETeams conversation card — folded from `eteams_create_team`
 *    tool events via the `uiConversation` service (dsh 0.1.2 renamed the
 *    former `conversationEvents` service; absent service degrades to
 *    tab+button only).
 *
 * apply() 最先幂等注入 Tailwind 产物样式（`<style data-dsh-eteams-tw>`，
 * tailwind.ts / docs/21 D19a）：先于 diagnostics 与一切槽位注册，保证任何
 * 表面首帧挂载时工具类已在 head。
 *
 * Every surface is individually try/catch-guarded and render-isolated
 * (ClientErrorBoundary), and all client-side errors funnel into the
 * diagnostics channel (console + host `client.log`) so renderer problems
 * are always visible in files, not only in a console nobody opened.
 *
 * @module dsh-eteams/client
 */
import type { Context } from '@deepseek-ai/cordis';
import { installCard } from './pages/eteamsCard';
import { installTaskCard } from './pages/taskCard';
import { EteamBuildCard } from './pages/buildCard';
import { ETEAMS_TAB_LABEL, ETEAMS_VIEW_ID } from './lib/bridge';
import { installClientDiagnostics, recordClientDiag } from './lib/diagnostics';
import { errorMessageOf } from './lib/errors';
import { ETeamsView } from './pages/teamsView/index';
import { installHeroTeamsButton } from './pages/heroTeamsButton';
import { installModelCatalog } from './lib/modelCatalog';
import { installSessionState } from './lib/sessionState';
import { ensureEteamsStyles } from './lib/tailwind';
import { enterTeamsPanel } from './pages/teamsPanel';
import { TeamsButton } from './pages/teamsButton';
import { SessionModelBadge } from './pages/sessionModelBadge';

/** Client services required before apply runs. The runner gates every
 * `ctx.<service>` property read against this declaration — touching an
 * undeclared service throws ("service X is not declared by your plugin"),
 * so this list must name every service the client plane touches:
 * `slots` (all registrations), `uiConversation` (card folding — dsh 0.1.2
 * renamed the former `conversationEvents`; fiber 级硬依赖，服务缺失即永不
 * 激活 → 渲染面 boot 失败), `modelDirectories` (session model catalog,
 * optional — 模型选择与对话一致，用户迭代 2026-09；缺服务的运行时退回静态
 * 选项) and `sessions` (Session Controller 客户端服务，optional —— 子会话
 * 模型徽章的兜底数据源：kit hook 缺席时探测会话绑定上的 modelSelection
 * 持久投影 + subagentAddress 门控，用户迭代 2026-09-09 方案 A；缺服务且
 * 缺 kit 时徽章静默不渲染). */
export const inject = ['slots', 'uiConversation', 'modelDirectories', 'sessions'];

/** Run one registration step; a failure is recorded, never fatal. */
function guard(step: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    recordClientDiag(`apply:${step}`, errorMessageOf(error));
  }
}

/**
 * Mount the eteams client registrations onto the client root context.
 *
 * @param ctx - client root context (cordis).
 */
export function apply(ctx: Context): void {
  // 最先注入 Tailwind 产物样式（D19a / 21.5.2）：先于 diagnostics 与一切
  // 槽位注册，让任何表面首帧挂载时工具类已在 head。guard 包裹：注入失败
  // 只记录不致命——表面退化为无 Tailwind 样式，注册路径完全不受影响
  // （recordClientDiag 自含，先于 installClientDiagnostics 调用也能落日志）。
  guard('tailwind-styles', () => ensureEteamsStyles());

  installClientDiagnostics();

  // 模型目录（用户迭代 2026-09：模型选择与对话一致）：暂存 client root ctx，
  // modelDirectories 服务由 ui-model-selection 插件挂载（同一 inject 列表），
  // 惰性读取——这里只暂存引用，绝不在此刻访问服务属性。
  guard('model-catalog', () => installModelCatalog(ctx));

  // 会话状态读取面（用户迭代 2026-09-09 方案 A：徽章改读会话持久投影）：
  // 同款暂存——sessions 服务（Session Controller）属性全部惰性读取。
  guard('session-state', () => installSessionState(ctx));

  guard('conversation.view', () =>
    ctx.slots.inject('conversation.view', () =>
      ctx.slots.register(
        {
          name: 'conversation.view',
          id: ETEAMS_VIEW_ID,
          order: 100,
          label: ETEAMS_TAB_LABEL,
        },
        ETeamsView,
      ),
    ),
  );

  guard('conversation.input.right', () =>
    ctx.slots.inject('conversation.input.right', () => {
      // 两个占位一次注入（iterable effect：事务性安装、逆序卸载）。
      const unregisterButton = ctx.slots.register(
        {
          name: 'conversation.input.right',
          id: `${ETEAMS_VIEW_ID}-button`,
          order: 100,
        },
        TeamsButton,
      );
      // 子会话模型徽章（用户迭代 2026-09-07「子代理会话中显示实际的
      // provider/model」）：order 101 排在团队按钮后；标准座位 kit
      // （sessionId/useSession/useProjection）读会话持久投影，仅在已寻址
      // 子代理会话渲染（composer 模型座位的互补位）。
      const unregisterModelBadge = ctx.slots.register(
        {
          name: 'conversation.input.right',
          id: `${ETEAMS_VIEW_ID}-model-badge`,
          order: 101,
        },
        SessionModelBadge,
      );
      return [unregisterButton, unregisterModelBadge];
    }),
  );

  guard('conversation.card', () => installCard(ctx));

  // 任务卡片（用户迭代 2026-09-12「任务创建好后，主会话应该有一个卡片让用户
  // 跳转到任务页面」）：主会话 eteams_submit_task 建主任务后在会话里折出一张
  // 带「打开任务」按钮的卡片——与团队卡片同一 Conversation Node 机制。
  guard('conversation.task-card', () => installTaskCard(ctx));

  // 会话未开始的新会话屏（hero）没有可供插件入驻的 additive 槽位——
  // hero 行两个席位都是 single 且已被宿主占用——因此走 DOM 注入：
  // 在「标准模式」旁补一枚团队按钮（heroTeamsButton 模块头有完整推理）。
  // 落点 = 团队 tab 页（创建走页头「＋ 新增团队」按钮，不再自开弹窗——
  // 用户反馈 2026-09）；对话未开始时宿主渲染不出标签环，enterTeamsPanel
  // 会改落整页团队页（teamsPanel 模块头有推理）。
  guard('hero.teams-button', () => installHeroTeamsButton(() => enterTeamsPanel()));

  guard('conversation.chat.commandview', () =>
    ctx.slots.inject('conversation.chat.commandview', () =>
      ctx.slots.register(
        // keyed entry：/eteam 命令节点渲染为「成员创建中」卡片，
        // 替换通用命令卡片（docs/19.9.5）。
        { name: 'conversation.chat.commandview', key: 'eteam' },
        EteamBuildCard,
      ),
    ),
  );
}
