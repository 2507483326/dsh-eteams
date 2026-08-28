/**
 * dsh-eteams — host-plane plugin for DeepSeek Harness.
 *
 * M0 (工程脚手架) ships the plugin skeleton:
 * - configuration schema (cordis.patch.yml `config:` block → `ETeamsConfig`);
 * - one smoke tool `eteams_ping` proving the `tools` inject and the caller
 *   identity seam (`exec.agent`) work end to end;
 * - the client bundle (see `./client` entry) adds the 团队 tab and the
 *   composer 团队 button.
 *
 * Later milestones (M1+) add the team lifecycle tools, member runtime, task
 * chains, mailboxes, and HTTP surfaces — see docs/15-development-plan.md.
 *
 * Installation (bundle): `dsh plugin --profile <name> add dsh-eteams`
 * (or a local path). The bundle patch mounts this plugin row into the host
 * composition, so every session of the profile can drive ETeams.
 *
 * @module dsh-eteams
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ETeamsConfig } from './config.js';
import type { ETeamsResolvedConfig } from './config.js';
import { PLUGIN_ID, PLUGIN_VERSION, STATE_SCHEMA_VERSION, TOOL_PREFIX } from './version.js';

/** Host services this plugin requires at mount time. */
export const inject = ['tools'];

/** Config schema consumed by the cordis loader (validated before apply). */
export { ETeamsConfig };

/** Best-effort human label for the calling agent (M0 diagnostics only). */
function callerLabel(agent: Agent | undefined): string {
  if (agent === undefined) return 'unknown';
  const probe = agent as unknown as { name?: unknown; sessionId?: unknown };
  if (typeof probe.name === 'string' && probe.name !== '') return probe.name;
  if (typeof probe.sessionId === 'string' && probe.sessionId !== '') return probe.sessionId;
  return 'agent';
}

/**
 * Mount the eteams plugin onto the host context.
 *
 * @param ctx - host plugin context (cordis).
 * @param config - resolved patch config (defaults applied by the loader).
 */
export function apply(ctx: Context, config: ETeamsResolvedConfig): void {
  const log = ctx.logger('eteams');
  log.info(
    'eteams: mounting (version=%s, stateDir=%s, workRoot=%s, maxMembers=%d, memberProvider=%s)',
    PLUGIN_VERSION,
    config.stateDir,
    config.workRoot,
    config.maxMembers,
    config.memberProvider,
  );

  const ping = defineTool({
    name: `${TOOL_PREFIX}ping`,
    description:
      'Check that the dsh-eteams plugin is installed and reachable. Returns the plugin version, the active configuration, and the calling agent identity. Safe to call anytime; it changes no state.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          plugin: { type: 'string', description: 'Plugin identity.' },
          version: { type: 'string', description: 'Plugin version.' },
          stateSchemaVersion: { type: 'integer', description: 'On-disk state schema version this build reads/writes.' },
          caller: { type: 'string', description: 'Calling agent label (name or session id), or "unknown" when agentless.' },
          stateDir: { type: 'string', description: 'Configured state directory under the session workspace.' },
          workRoot: { type: 'string', description: 'Configured per-team working directory root.' },
          maxMembers: { type: 'integer', description: 'Configured member cap per team.' },
          maxRetries: { type: 'integer', description: 'Configured same-member auto-retry budget.' },
          memberProvider: { type: 'string', description: 'Configured member spawn provider.' },
        },
        additionalProperties: false,
      },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (_args, exec) => {
      const value = {
        plugin: PLUGIN_ID,
        version: PLUGIN_VERSION,
        stateSchemaVersion: STATE_SCHEMA_VERSION,
        caller: callerLabel(exec.agent),
        stateDir: config.stateDir,
        workRoot: config.workRoot,
        maxMembers: config.maxMembers,
        maxRetries: config.maxRetries,
        memberProvider: config.memberProvider,
      };
      log.info('eteams: ping from %s', value.caller);
      return value;
    },
  });

  ctx.tools.register(ping);
  log.info('eteams: ready — tool eteams_ping registered');
}
