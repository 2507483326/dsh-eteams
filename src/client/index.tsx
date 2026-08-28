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
 * @module dsh-eteams/client
 */
import type { Context } from '@deepseek-ai/cordis';
import { installCard } from './card';
import { ETEAMS_TAB_LABEL, ETEAMS_VIEW_ID } from './bridge';
import { ETeamsView } from './eteamsView';
import { TeamsButton } from './teamsButton';

/** Client services required before apply runs. */
export const inject = ['slots'];

/**
 * Mount the eteams client registrations onto the client root context.
 *
 * @param ctx - client root context (cordis).
 */
export function apply(ctx: Context): void {
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
  );

  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: `${ETEAMS_VIEW_ID}-button`,
        order: 100,
      },
      TeamsButton,
    ),
  );

  installCard(ctx);
}
