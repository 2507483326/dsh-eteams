/**
 * The 团队 button in the composer tool row (`conversation.input.right`).
 *
 * The popup lists the session's teams plus the member-building entry
 * (D18-1): 「＋ 新增成员」 prefills the `eTeam --add-people` command into the
 * composer draft (never auto-send) and jumps to the panel. When the slot's
 * `inputActions` kit is unavailable it degrades to clipboard copy.
 *
 * @module dsh-eteams/client/teamsButton
 */
import { useState } from 'react';
import { Button, Menu, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives';
import { activateETeamsTab } from './bridge';
import { ClientErrorBoundary } from './diagnostics';
import { ADD_PEOPLE_TEMPLATE, prefillComposer } from './addPeople';

/**
 * Owner share of the input-region slots (`InputZone`): the conversation
 * snapshot, the live input state, and the session-slot standard kit's
 * draft actions when the runtime injects them. Types stay structural to
 * avoid reaching into non-exported contract names.
 */
interface TeamsButtonProps {
  readonly session?: unknown;
  readonly input?: unknown;
  readonly inputActions?: { setDraft: (text: string) => void };
}

/**
 * The eteams composer tool-row entry: a 「团队」 button with a team-list popup.
 */
export function TeamsButton(props: TeamsButtonProps): React.ReactNode {
  const [open, setOpen] = useState(false);

  return (
    <ClientErrorBoundary label="团队按钮">
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
            { id: 'eteams-add-member', label: '＋ 新增成员' },
          ]}
          onSelect={(id) => {
            setOpen(false);
            if (id === 'eteams-add-team') {
              activateETeamsTab();
              return;
            }
            if (id === 'eteams-add-member') {
              // D18-1：命令进输入框（覆盖前确认），退化为复制；均不自动发送。
              const outcome = prefillComposer(props.inputActions);
              if (outcome === 'copied') {
                void writeClipboard(ADD_PEOPLE_TEMPLATE).catch(() => undefined);
              }
              activateETeamsTab();
            }
          }}
          onClose={() => setOpen(false)}
          anchor={
            <Button variant="ghost" size="sm" aria-label="团队" onClick={() => setOpen((v) => !v)}>
              团队
            </Button>
          }
        />
      </div>
    </ClientErrorBoundary>
  );
}
