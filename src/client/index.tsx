/**
 * dsh-eteams — client-plane plugin (browser bundle).
 *
 * Loaded through the DSH client bundle loader (`window.__ModuleLoader__`,
 * see scripts/wrap-client.mjs) with `inject: ['slots']`. Registers:
 *
 * 1. the 团队 tab — an entry in the `conversation.view` ring (id `eteams`,
 *    order 100), rendered one-at-a-time beside 对话/轨迹;
 * 2. the 团队 button — an entry at the right end of the composer tool row
 *    (`conversation.input.right`), opening the team-list popup whose v1
 *    「新增团队」 item jumps to the 团队 tab.
 *
 * @module dsh-eteams/client
 */
import type { Context } from '@deepseek-ai/cordis';
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
}
