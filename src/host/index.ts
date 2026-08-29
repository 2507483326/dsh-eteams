/**
 * dsh-eteams — host-plane plugin for DeepSeek Harness.
 *
 * M1 (状态与核心工具) ships the full team lifecycle:
 * - durable state (`<workspace>/.eteams/<teamId>/`) with events + snapshots;
 * - captain tools (`eteams_create_team … eteams_mailbox`) and member tools
 *   (`eteams_claim_task … eteams_team_status`) with per-caller identity;
 * - continuable member spawning with persona injection and per-child tool
 *   installation (`registerContinuableSetup`), captain tools denied at spawn;
 * - execution chains (D11) with deviation notes, attempt tokens, 完成即续派
 *   notifications, and immediate same-member retry (M1; backoff in M2);
 * - task work documents under `<workspace>/teams/<team-slug>/` (D12).
 *
 * M0 pieces kept: configuration schema, `eteams_ping`, the client bundle
 * (团队 tab + composer button).
 *
 * Installation: `dsh plugin --profile <name> add C:\eTeam` (live link).
 *
 * @module dsh-eteams
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ETeamsConfig } from './config.js';
import type { ETeamsResolvedConfig } from './config.js';
import { PLUGIN_ID, PLUGIN_VERSION, STATE_SCHEMA_VERSION, TOOL_PREFIX } from './version.js';
import { createCaptainTools } from './tools/captainTools.js';
import { createMemberTools } from './tools/memberTools.js';
import { installMemberRuntime, MEMBER_DENIED_TOOLS } from './runtime/members.js';
import { installWebSurface, rootForWrites } from './runtime/webui.js';
import type { RuntimeContext } from './runtime/base.js';
import { readBuildSession, setBuildAgentId } from './runtime/roleBuilder.js';
import { CAPTAIN_SECTION_SHORT } from './prompts/captain.js';
import { composeCaptainPersona } from './prompts/persona.js';
import { personaDigest } from './prompts/persona.js';
import {
  buildActivationMessage,
  ROLE_BUILDER_CHILD_PERSONA,
  ROLE_BUILDER_SECTION,
} from './prompts/roleBuilder.js';

/** Host services this plugin requires at mount time. */
export const inject = ['tools', 'subagents', 'agents', 'systemPrompt', 'commands'];

/** Config schema consumed by the cordis loader (validated before apply). */
export { ETeamsConfig };

/** Offline verification surface (verify script / integration tests). */
export { createCaptainTools } from './tools/captainTools.js';
export { createMemberTools } from './tools/memberTools.js';
export { approvePlan } from './runtime/teamOps.js';
export {
  assignTask,
  advanceTask,
  claimTask,
  completeTask,
  failTask,
} from './runtime/assignment.js';

/** Best-effort human label for the calling agent (diagnostics only). */
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

  // 1) Captain tool face (root scope; members get toolFilter.deny at spawn).
  for (const tool of createCaptainTools(config, ctx)) {
    ctx.tools.register(tool);
  }
  log.info('eteams: captain tools registered');

  // 2) Member runtime: per-child tool installation + route bookkeeping.
  installMemberRuntime(
    ctx as unknown as {
      logger: { info(m: string): void; warn(m: string): void };
      subagents?: { registerContinuableSetup(c: (childCtx: Context) => () => void): () => void };
    },
    config,
    (childCtx, _env) => {
      for (const tool of createMemberTools(config, childCtx as Context)) {
        (childCtx as unknown as { tools: { register(t: unknown): unknown } }).tools.register(tool);
      }
    },
  );
  log.info('eteams: member runtime installed');

  // 3) Captain standing prompt (compact section, tools guidance band).
  try {
    ctx.systemPrompt.section({
      name: 'eteams-captain',
      order: 105,
      text: CAPTAIN_SECTION_SHORT,
    });
    log.info('eteams: system prompt section registered');
  } catch (error) {
    log.warn('eteams: systemPrompt section registration failed: %s', String(error));
  }

  // 3b) Role Builder standing section (docs/19.8.1, D18): conversational
  // member building — the `eTeam --add-people` prefix makes the session
  // agent BE the 角色构建师 for that turn (no captain relay, no subagent).
  try {
    ctx.systemPrompt.section({
      name: 'eteams-role-builder',
      order: 106,
      text: ROLE_BUILDER_SECTION,
    });
    log.info('eteams: role builder section registered');
  } catch (error) {
    log.warn('eteams: role builder section registration failed: %s', String(error));
  }

  // 3c) /eteam slash command (docs/19.4, D18): the command-plane entry for
  // member building. Slash input never reaches the model on its own, so the
  // handler explicitly steers the activation message (`eTeam --add-people …`)
  // onto the receiving agent — an idle driver starts a turn immediately.
  try {
    ctx.inject(['commands'], (commandCtx) => {
      try {
        const eteamCommand: CommandDefinition = {
          name: 'eteam',
          description: '新增成员 · 角色构建师',
          input: {
            hint: '--add-people 我需要创建一个成员 【成员名称】，它的职责是【职责】。',
            images: false,
          },
          handler: ({ agent, rawInput }) => {
            // 门禁 + 派发（docs/19.16）：命令处理器只做两件事——① 已有构建
            // 进行中（active/awaiting）则不派发，让用户先处理现有构建；
            // ② 直接把激活消息投给可续聊的后台子代理（角色构建师）。会话
            // 不在这里预开——卡片在子代理首次播报（newBuild 开会话）后出现；
            // childId 先记入旁路文件 rolebuilder-agent.json，子代理首播报
            // 开会话时由宿主合并（docs/19.16）。启动失败退回 steer 主会话。
            void (async () => {
              let root: string | null = null;
              try {
                root = rootForWrites(ctx, config);
                const current = readBuildSession(root);
                if (
                  current !== null &&
                  (current.status === 'active' || current.status === 'awaiting_confirmation')
                ) {
                  agent.steer(
                    createUserMessage({
                      content: [
                        {
                          type: 'text',
                          text: `已有成员构建在进行中（${current.draft?.name || '未命名'} · ${current.step}）。请到面板完成或放弃该构建后再发起新的 /eteam。`,
                        },
                      ],
                      source: {
                        kind: 'plugin',
                        plugin: 'dsh-eteams',
                        form: 'notice',
                        summary: '已有构建进行中——未派发新构建',
                      },
                    }),
                  );
                  return;
                }
              } catch {
                // 状态读不到时不拦：照常派发（子代理首播报的 newBuild 会开新局）。
              }
              try {
                const subagents = (ctx as unknown as RuntimeContext).subagents;
                if (subagents?.startContinuable === undefined) {
                  throw new Error('subagents 服务不可用');
                }
                const start = await subagents.startContinuable({
                  provider: config.memberProvider,
                  label: 'eteams-rolebuilder',
                  request: {
                    prompt: [{ type: 'text', text: buildActivationMessage(rawInput) }],
                    parent: agent,
                    persona: ROLE_BUILDER_CHILD_PERSONA,
                    toolFilter: {
                      deny: MEMBER_DENIED_TOOLS.filter(
                        (tool) =>
                          tool !== 'eteams_build_report' &&
                          tool !== 'eteams_member_list' &&
                          tool !== 'eteams_member_save',
                      ),
                    },
                  },
                });
                if (root !== null) {
                  await setBuildAgentId(root, {
                    agentId: String(start.childId),
                    parentSessionId: String(agent.id),
                  });
                }
              } catch {
                agent.steer(
                  createUserMessage({
                    content: [{ type: 'text', text: buildActivationMessage(rawInput) }],
                    // Plugin-sourced notice: the conversation folds this user-role
                    // message into a compact context row (not a chat bubble) while
                    // the model still receives the full activation text (docs/19.9.5).
                    source: {
                      kind: 'plugin',
                      plugin: 'dsh-eteams',
                      form: 'notice',
                      summary: '成员创建请求已提交——构建卡片与面板实时显示进度',
                    },
                  }),
                );
              }
            })();
            return {
              kind: 'success' as const,
              text: '成员构建已派给后台代理——卡片将在其首次播报时出现。',
            };
          },
        };
        commandCtx.commands.register(eteamCommand);
        log.info('eteams: /eteam command registered');
      } catch (error) {
        log.warn('eteams: /eteam command registration failed: %s', String(error));
      }
    });
  } catch {
    // 无 commands 服务的部署（UI-less）：斜杠命令不可用，纯文本前缀路径仍有效。
  }

  // 4) Captain persona digest (D13 override file support).
  const persona = composeCaptainPersona(process.cwd(), config.stateDir);
  log.info('eteams: captain persona ready (%s)', personaDigest(persona, '领队').slice(0, 60));

  // 5) M0 smoke tool.
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
          stateSchemaVersion: {
            type: 'integer',
            description: 'On-disk state schema version this build reads/writes.',
          },
          caller: {
            type: 'string',
            description: 'Calling agent label (name or session id), or "unknown" when agentless.',
          },
          stateDir: {
            type: 'string',
            description: 'Configured state directory under the session workspace.',
          },
          workRoot: { type: 'string', description: 'Configured per-team working directory root.' },
          maxMembers: { type: 'integer', description: 'Configured member cap per team.' },
          maxRetries: { type: 'integer', description: 'Configured same-member auto-retry budget.' },
          memberProvider: { type: 'string', description: 'Configured member spawn provider.' },
        },
        additionalProperties: false,
      },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: JSON.stringify(value, null, 2) },
      ],
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

  // 6) M4 web surface: panel state routes (lazy — webless profiles skip).
  try {
    const bound = installWebSurface(ctx, config);
    if (bound) {
      log.info('eteams: web routes bound under /plugins/dsh-eteams');
    } else {
      // Sibling services (webServer/workspaceRegistry) may bind after us.
      const rebind = (name: string): void => {
        if (
          name === 'webServer' ||
          name === 'httpServer' ||
          name === 'workspaceRegistry' ||
          name === 'workspace'
        ) {
          if (installWebSurface(ctx, config))
            log.info('eteams: web routes bound (late service %s)', name);
        }
      };
      (ctx as unknown as { on: (event: string, cb: (name: string) => void) => void }).on(
        'internal/service',
        rebind,
      );
      log.info('eteams: web routes deferred (web services not yet bound)');
    }
  } catch (error) {
    log.warn(
      'eteams: web surface registration failed (panel falls back to empty state): %s',
      String(error),
    );
  }
}
