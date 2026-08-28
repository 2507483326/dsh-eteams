/**
 * The ETeams conversation card (docs/13.2): folds from the
 * `eteams_create_team` tool call/result pair in the session log via the
 * client-runtime Conversation Node mechanism, then renders live progress
 * from the polled activity snapshots (matching by teamId from the tool
 * result, falling back to the team name).
 *
 * @module dsh-eteams/client/card
 */
import { type ReactNode } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { Avatar } from './avatar';
import { activateETeamsTab } from './bridge';
import { ClientErrorBoundary } from './diagnostics';
import { useActivityState, type TeamSnapshot } from './monitor';

/** Card state folded from the create-team tool events. */
interface CardState {
  name: string;
  goal: string;
  teamId: string | null;
  accepted: boolean;
}

/** Structural view of the Session events the definition matches. */
interface SessionEventLike {
  type: string;
  data: Record<string, unknown>;
}

/** Structural view of a tool-result content block. */
interface ToolResultBlock {
  type: string;
  text?: string;
  isError?: boolean;
}

function parseCreateArgs(raw: unknown): { name: string; goal: string } | undefined {
  try {
    const args =
      typeof raw === 'string'
        ? (JSON.parse(raw) as Record<string, unknown>)
        : (raw as Record<string, unknown>);
    if (typeof args.name === 'string' && typeof args.goal === 'string')
      return { name: args.name, goal: args.goal };
  } catch {
    // unparseable arguments: no card
  }
  return undefined;
}

function parseTeamIdFromResult(blocks: unknown): string | null {
  for (const block of (Array.isArray(blocks) ? blocks : []) as ToolResultBlock[]) {
    if (block.type !== 'tool-result' || typeof block.text !== 'string') continue;
    try {
      const parsed = JSON.parse(block.text) as { teamId?: unknown };
      if (typeof parsed.teamId === 'string') return parsed.teamId;
    } catch {
      // not our JSON payload
    }
  }
  return null;
}

/** Conversation Node definition: create-tool call/result → card node. */
const eteamsCardDefinition = {
  kind: 'eteams',
  target: 'chat',
  match(event: SessionEventLike): { id: string; role: 'start' | 'update' } | null {
    if (event.type === 'tool/call' && event.data.name === 'eteams_create_team') {
      return parseCreateArgs(event.data.arguments) === undefined
        ? null
        : { id: String(event.data.callId), role: 'start' };
    }
    if (event.type === 'tool/result') {
      const source = (
        event.data.message as { source?: { kind?: string; callId?: unknown } } | undefined
      )?.source;
      if (source?.kind === 'tool') return { id: String(source.callId), role: 'update' };
    }
    return null;
  },
  start(_context: unknown, match: { event: SessionEventLike }): CardState {
    const parsed = parseCreateArgs(match.event.data.arguments);
    if (parsed === undefined) throw new Error('eteams card start requires valid create arguments');
    return { ...parsed, teamId: null, accepted: false };
  },
  update(context: { state: CardState }, match: { event: SessionEventLike }): CardState {
    if (match.event.type !== 'tool/result') return context.state;
    const data = match.event.data as { error?: unknown; message?: { content?: unknown } };
    if (data.error !== undefined) return context.state;
    const content = data.message?.content;
    const errored =
      Array.isArray(content) &&
      (content as ToolResultBlock[]).some((b) => b.type === 'tool-result' && b.isError === true);
    if (errored) return context.state;
    const teamId = parseTeamIdFromResult(content);
    return { ...context.state, accepted: true, teamId: teamId ?? context.state.teamId };
  },
  buildViewNode(context: {
    key: string;
    id: string;
    start?: { event: { seq: number }; location: unknown };
    state?: CardState;
  }): {
    key: string;
    kind: string;
    id: string;
    target: string;
    anchorSeq: number;
    location: unknown;
    visibility: 'visible';
    data: Record<string, unknown>;
  } | null {
    if (context.start === undefined || context.state === undefined) return null;
    if (!context.state.accepted) return null;
    return {
      key: context.key,
      kind: 'eteams',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: {
        teamId: context.state.teamId,
        teamName: context.state.name,
        goal: context.state.goal,
      },
    };
  },
};

const PHASE_LABELS: Record<string, string> = {
  staged: '草案',
  running: '运行中',
  paused: '已暂停',
  halted: '已停止',
  completed: '已完成',
  archived: '已归档',
};

function findTeam(
  state: { teams: TeamSnapshot[] },
  data: { teamId: string | null; teamName: string },
): TeamSnapshot | undefined {
  if (data.teamId !== null) return state.teams.find((t) => t.teamId === data.teamId);
  return state.teams.find((t) => t.name === data.teamName);
}

/** The in-transcript card renderer (live via polled snapshots). */
export function ETeamsCard({ node }: { node: { data: unknown } }): ReactNode {
  const state = useActivityState();
  const data = node.data as { teamId: string | null; teamName: string; goal?: string };
  const team = findTeam(state, data);
  return (
    <ClientErrorBoundary label="团队卡片">
      <div
        style={{
          border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))',
          borderRadius: 12,
          padding: '12px 16px',
          margin: '8px 0',
          maxWidth: 560,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong>🐳 {data.teamName}</strong>
          <span
            style={{
              fontSize: 11,
              padding: '1px 8px',
              borderRadius: 999,
              border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
            }}
          >
            {team !== undefined ? (PHASE_LABELS[team.phase] ?? team.phase) : '连接中…'}
          </span>
          {team !== undefined && team.pendingDecisions.length > 0 && (
            <span
              style={{
                fontSize: 11,
                padding: '1px 8px',
                borderRadius: 999,
                border: '1px solid #c78a1d66',
                color: '#c78a1d',
              }}
            >
              △ {team.pendingDecisions.length}
            </span>
          )}
        </div>
        {team !== undefined ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', margin: '8px 0 4px' }}>
              {team.members.slice(0, 8).map((m) => (
                <span key={m.name} style={{ marginRight: -6 }} title={`${m.name} · ${m.status}`}>
                  <Avatar name={m.name} size={26} />
                </span>
              ))}
              <span style={{ fontSize: 12, opacity: 0.65, marginLeft: 12 }}>
                {team.members.length} 名成员
              </span>
            </div>
            <div
              style={{
                height: 5,
                borderRadius: 999,
                background: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${team.progress.total === 0 ? 0 : (team.progress.completed / team.progress.total) * 100}%`,
                  background: 'var(--dsw-alias-accent, #4b7bec)',
                }}
              />
            </div>
            <div style={{ fontSize: 12, opacity: 0.65, margin: '6px 0' }}>
              {team.progress.completed}/{team.progress.total} 完成
              {team.latestEvents.at(-1) !== undefined ? ` · ${team.latestEvents.at(-1)!.text}` : ''}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12, opacity: 0.65, margin: '6px 0' }}>{data.goal ?? ''}</div>
        )}
        <button
          type="button"
          onClick={() => {
            activateETeamsTab();
          }}
          style={{
            padding: '3px 12px',
            fontSize: 12,
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
            background: 'none',
            color: 'inherit',
            cursor: 'pointer',
          }}
        >
          打开面板
        </button>
      </div>
    </ClientErrorBoundary>
  );
}

/**
 * Register the card definition and its chat-node renderer seat. The
 * `conversationEvents` service is optional: when the running client runtime
 * does not provide it, only the card degrades — tab and button stay up.
 * @param ctx - client root context (cordis).
 */
export function installCard(ctx: Context): void {
  const events = (
    ctx as unknown as { conversationEvents?: { register: (d: unknown) => () => void } }
  ).conversationEvents;
  if (typeof events?.register !== 'function') return;
  events.register(eteamsCardDefinition);
  (
    ctx as unknown as {
      slots: {
        inject: (n: string, f: () => unknown) => void;
        register: (d: Record<string, unknown>, c: unknown) => unknown;
      };
    }
  ).slots.inject('conversation.chat.node', () =>
    (
      ctx as unknown as { slots: { register: (d: Record<string, unknown>, c: unknown) => unknown } }
    ).slots.register({ name: 'conversation.chat.node', key: 'eteams' }, ETeamsCard),
  );
}
