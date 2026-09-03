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
 *    team rows and 新增 shortcuts jump straight to the 团队 tab page;
 * 3. the hero 团队 button — DOM-injected beside the 标准模式 preset chip on
 *    the not-started screen (no additive slot exists there), clicking into
 *    the 团队 tab page (full-screen 团队页 while the view ring is not
 *    rendered);
 * 4. the ETeams conversation card — folded from `eteams_create_team`
 *    tool events via the optional `conversationEvents` service (absent
 *    service degrades to tab+button only).
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
import { installCard } from './card';
import { EteamBuildCard } from './buildCard';
import { ETEAMS_TAB_LABEL, ETEAMS_VIEW_ID } from './bridge';
import { installClientDiagnostics, recordClientDiag } from './diagnostics';
import { ETeamsView } from './eteamsView';
import { installHeroTeamsButton } from './heroTeamsButton';
import { installModelCatalog } from './modelCatalog';
import { ensureEteamsStyles } from './tailwind';
import { enterTeamsPanel } from './teamsPanel';
import { TeamsButton } from './teamsButton';

/** Client services required before apply runs. The runner gates every
 * `ctx.<service>` property read against this declaration — touching an
 * undeclared service throws ("service X is not declared by your plugin"),
 * so this list must name every service the client plane touches:
 * `slots` (all registrations), `conversationEvents` (card folding, optional)
 * and `modelDirectories` (session model catalog, optional — 模型选择与对话
 * 一致，用户迭代 2026-09；缺服务的运行时退回静态选项). */
export const inject = ['slots', 'conversationEvents', 'modelDirectories'];

/** Run one registration step; a failure is recorded, never fatal. */
function guard(step: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    recordClientDiag(`apply:${step}`, error instanceof Error ? error.message : String(error));
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
    ctx.slots.inject('conversation.input.right', () =>
      ctx.slots.register(
        {
          name: 'conversation.input.right',
          id: `${ETEAMS_VIEW_ID}-button`,
          order: 100,
        },
        TeamsButton,
      ),
    ),
  );

  guard('conversation.card', () => installCard(ctx));

  // 会话未开始的新会话屏（hero）没有可供插件入驻的 additive 槽位——
  // hero 行两个席位都是 single 且已被宿主占用——因此走 DOM 注入：
  // 在「标准模式」旁补一枚团队按钮（heroTeamsButton 模块头有完整推理）。
  // 落点 = 团队 tab 页（新增团队弹窗随即自开）；对话未开始时宿主渲染不出
  // 标签环，enterTeamsPanel 会改落整页团队页（teamsPanel 模块头有推理）。
  guard('hero.teams-button', () =>
    installHeroTeamsButton(() => enterTeamsPanel({ creator: true })),
  );

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
