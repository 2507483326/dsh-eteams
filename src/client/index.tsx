/**
 * dsh-eteams — client-plane plugin (browser bundle).
 *
 * Loaded through the DSH client bundle loader (`window.__ModuleLoader__`,
 * see scripts/wrap-client.mjs) with `inject: ['slots']`. Registers:
 *
 * 1. the 团队 tab — an entry in the `conversation.view` ring (id `eteams`,
 *    order 100) hosting the M4 activity panel (概览/成员/任务/动态 + 抽屉);
 * 2. the 团队 button — an entry at the right end of the composer tool row
 *    (`conversation.input.right`), opening the team-list popup whose
 *    「新增团队」 item jumps to the 团队 tab;
 * 3. the ETeams conversation card — folded from `eteams_create_team`
 *    tool events via the optional `conversationEvents` service (absent
 *    service degrades to tab+button only).
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
import { TeamsButton } from './teamsButton';

/** Client services required before apply runs. The runner gates every
 * `ctx.<service>` property read against this declaration — touching an
 * undeclared service throws ("service X is not declared by your plugin"),
 * so this list must name every service the client plane touches:
 * `slots` (all registrations) and `conversationEvents` (card folding). */
export const inject = ['slots', 'conversationEvents'];

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
  installClientDiagnostics();

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
