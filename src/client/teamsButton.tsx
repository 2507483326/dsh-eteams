/**
 * The 团队 button in the composer tool row (`conversation.input.right`).
 *
 * Clicking opens a popup listing the session's teams. v1 scope (user
 * requirement): the list contains exactly one action — 「新增团队」 — which
 * jumps to the 团队 tab via the activation bridge. The real team list and the
 * creation flow arrive with M1/M4.
 *
 * @module dsh-eteams/client/teamsButton
 */
import { useState } from 'react';
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import { activateETeamsTab } from './bridge';

/**
 * Owner share of the input-region slots (`InputZone`): the conversation
 * snapshot and the live input state. M0's button reads neither, so the prop
 * type stays structural to avoid reaching into non-exported contract names.
 */
interface TeamsButtonProps {
  readonly session?: unknown;
  readonly input?: unknown;
}

/**
 * The eteams composer tool-row entry: a 「团队」 button with a team-list popup.
 */
export function TeamsButton(_props: TeamsButtonProps): React.ReactNode {
  const [open, setOpen] = useState(false);

  return (
    // The literal attribute marks eteams-owned DOM for the activation bridge.
    <div style={{ display: 'inline-flex', alignItems: 'center' }} data-eteams="button">
      <Menu
        open={open}
        align="end"
        side="bottom"
        portal
        items={[
          { type: 'label', id: 'eteams-title', text: '团队' },
          { type: 'separator', id: 'eteams-sep' },
          { id: 'eteams-add-team', label: '＋ 新增团队' },
        ]}
        onSelect={(id) => {
          if (id !== 'eteams-add-team') return;
          setOpen(false);
          activateETeamsTab();
        }}
        onClose={() => setOpen(false)}
        anchor={
          <Button variant="ghost" size="sm" aria-label="团队" onClick={() => setOpen((v) => !v)}>
            团队
          </Button>
        }
      />
    </div>
  );
}
