/**
 * dsh-eteams — host-plane plugin for DeepSeek Harness.
 *
 * M1 (状态与核心工具) ships the full team lifecycle:
 * - durable state (`<workspace>/.eteams/<teamId>/`) with events + snapshots;
 * - captain tools (`eteams_create_team … eteams_mailbox`) and member tools
 *   (`eteams_claim_task … eteams_team_status`) with per-caller identity;
 * - continuable member spawning with persona injection and per-child tool
 *   installation (root-scope member tools since harness 0.1.2), captain tools denied at spawn;
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
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ETeamsConfig } from './config.js';
import type { ETeamsResolvedConfig } from './config.js';
import { PLUGIN_ID, PLUGIN_VERSION, STATE_SCHEMA_VERSION, TOOL_PREFIX } from './version.js';
import { createCaptainTools } from './tools/captainTools.js';
import { createCaptainDispatchTool } from './tools/captainDispatch.js';
import { createAskUserTools } from './tools/askUserTools.js';
import { createMemberTools } from './tools/memberTools.js';
import { installUsageMeter } from './runtime/usage.js';
import { installWebSurface, locateTeam } from './runtime/webui.js';
import { stateRootFor } from './runtime/base.js';
import { leaderHandbookForChild } from './runtime/captainAgent.js';
import { sessionPersonaSection, sessionIdOfScope } from './runtime/sessionPersona.js';
import { rootPromptSection } from './runtime/rootPrompt.js';
import {
  sessionTeamSection,
  consumeSessionTeamBinding,
  isHumanUserTurn,
} from './runtime/sessionTeam.js';
import { CAPTAIN_SECTION_SHORT } from './prompts/system/captain.js';
import { composeCaptainPersona } from './prompts/personas/captain.js';
import { personaDigest } from './prompts/personas/framework.js';
import { ROLE_BUILDER_SECTION } from './prompts/system/roleBuilder.js';
import { registerCommands } from './commands/index.js';

/**
 * Host services this plugin requires at mount time. agentDefaultModel
 * （dsh-agent-default-model 提供）供 spawn 侧会话默认路线 pin
 * （sessionDefaultRouteOf）——cordis 4 下同级插件服务必须显式声明才能从
 * ctx 读取，否则属性访问直接抛「cannot get property … without inject」
 * （实测 2026-09-07：dispatch 在 dispatchCaptainCore 内因此整体失败）。
 */
export const inject = [
  'tools',
  'subagents',
  'agents',
  'systemPrompt',
  'commands',
  'agentDefaultModel',
  // llm（dsh-llm 提供）供 /session-route 反查模型目录显示名（用户迭代
  // 2026-09-08「显示目录模型」：id 是限定串，座位显示的是目录 name）。
  'llm',
  // userQuestions（dsh-user-questions 提供）供 eteams_ask_user 就地弹分支
  // 直调 ctx.userQuestions.ask()（转交分支不依赖它）。
  'userQuestions',
];

/** Config schema consumed by the cordis loader (validated before apply). */
export { ETeamsConfig };

/** Offline verification surface (verify script / integration tests). */
export { createCaptainTools } from './tools/captainTools.js';
export { createCaptainDispatchTool } from './tools/captainDispatch.js';
export { createAskUserTools } from './tools/askUserTools.js';
export { createMemberTools } from './tools/memberTools.js';
// eteams_approve_plan 已随审批环节重构下线（docs/35 §5#1），导出面随之撤销。
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
  // 1b) 对话任务转交（docs/26 用户迭代 2026-09-03）：主会话把交给团队的
  // 任务转给一次性领队子代理主持。同一根作用域注册（子代理对 eteams_*
  // 可见的前提）；成员与领队子代理在 spawn 时 deny。
  ctx.tools.register(createCaptainDispatchTool(config, ctx));
  // 1c) 子代理用户问答（用户迭代 2026-09-08）：eteams_ask_user / eteams_ask_answer。
  // 根作用域注册且不进任何 deny 列表——领队子代理与成员都可见（问答自动
  // 路由：用户在提问会话就地弹，不在则转交主会话弹出）。
  for (const tool of createAskUserTools(config, ctx)) {
    ctx.tools.register(tool);
  }
  log.info('eteams: captain tools registered');

  // 2) Member tools: harness 0.1.2 起 registerContinuableSetup（per-child
  //    工具装配钩子）被宿主移除——成员工具改随根作用域注册，子代理对它们
  //    的可见性由各 spawn 的 toolFilter deny 收口（领队子代理
  //    CAPTAIN_CHILD_DENIED_TOOLS、构建器 builderToolFilter、成员默认全见）。
  //    成员身份授权不变：工具执行体经 resolveCaller 按任务副本行解析，
  //    非成员调用一律拒绝。
  for (const tool of createMemberTools(config, ctx)) {
    ctx.tools.register(tool);
  }
  log.info('eteams: member tools registered');

  // 2b) Usage meter（docs/28.2.3 方案 A / E18 同型先例）：root-scope firehose
  //     监听 session/event 采集 assistant/message 的 usage，写
  //     <workspace>/.eteams/usage.jsonl；冷恢复靠 session/created 对账 +
  //     ctx.sessions.list() 装机补折。失败不外抛（计量绝不影响会话）。
  try {
    installUsageMeter(ctx, config);
    log.info('eteams: usage meter installed');
  } catch (error) {
    log.warn('eteams: usage meter install failed (calendar stays empty): %s', String(error));
  }

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

  // 3b2) Session persona takeover (docs/13.8.2, dynamic): when the panel
  // selects a member for a session, that session's agent speaks as the
  // member. Dual-channel registration — the assembling scope IS the agent
  // (`assembleContextFor` passes `scope: agent`) and a session agent's id IS
  // its sessionId, so the band reaches exactly that session's agent; every
  // other agent assembles `''`, which contributes nothing. The store lives in
  // runtime/sessionPersona.ts and is fed by the /eteams-api/session-persona
  // routes — no conversation message involved.
  //
  // Channel 1 — system-prompt SECTION (order 107): verified live in the
  // desktop harness (the session agent's system prompt carries the band).
  try {
    ctx.systemPrompt.section({
      name: 'eteams-session-persona',
      order: 107,
      text: (context) => sessionPersonaSection(sessionIdOfScope(context.scope)),
    });
    log.info('eteams: session persona section registered');
  } catch (error) {
    log.warn('eteams: session persona section registration failed: %s', String(error));
  }
  // Channel 2 — runtime CONTEXT via ctx.inject (order 900, reads last = the
  // freshest slot in the per-turn "Current runtime context…" snapshot).
  // Persisted sessions show `header.system` EMPTY while that snapshot message
  // carries plugin context contributions (sandbox:policy et al., registered by
  // dsh-sandbox-policy through `ctx.inject(['systemPrompt'], (scope) =>
  // scope.systemPrompt.context(...))` — the canonical cross-plugin pattern).
  // Duplicating the band across both channels is deliberate: whichever channel
  // a given composition renders, the takeover survives.
  try {
    type SystemPromptScope = {
      systemPrompt: {
        context(contribution: {
          name: string;
          order: number;
          text: (context: { scope?: unknown }) => string;
        }): unknown;
      };
    };
    (
      ctx as unknown as {
        inject(deps: string[], fn: (scope: SystemPromptScope) => void): void;
      }
    ).inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.context({
        name: 'eteams-session-persona',
        order: 900, // late in the snapshot: reads last, i.e. freshest
        text: (context) => sessionPersonaSection(sessionIdOfScope(context.scope)),
      });
      log.info('eteams: session persona context registered');
    });
  } catch (error) {
    log.warn('eteams: session persona context registration failed: %s', String(error));
  }

  // 3b3) Session team binding (docs/26, dynamic): the composer's 团队 button
  // binds the conversation to a team via /eteams-api/session-team; this
  // session's prompt gains a 团队绑定 band carrying the conversation-task
  // workflow. Same dual-channel pattern as 3b2 (scope IS the session agent).
  // The band reads the LIVE team snapshot per assembly (locateTeam), so
  // 批准/阶段变化即时反映，无需重绑。
  const teamBand = (context: { scope?: unknown }): string =>
    sessionTeamSection(
      sessionIdOfScope(context.scope),
      (teamId) => locateTeam(ctx, config, teamId)?.team,
    );
  try {
    ctx.systemPrompt.section({
      name: 'eteams-session-team',
      order: 108,
      text: teamBand,
    });
    log.info('eteams: session team section registered');
  } catch (error) {
    log.warn('eteams: session team section registration failed: %s', String(error));
  }
  try {
    type SystemPromptScope = {
      systemPrompt: {
        context(contribution: {
          name: string;
          order: number;
          text: (context: { scope?: unknown }) => string;
        }): unknown;
      };
    };
    (
      ctx as unknown as {
        inject(deps: string[], fn: (scope: SystemPromptScope) => void): void;
      }
    ).inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.context({
        name: 'eteams-session-team',
        order: 901,
        text: teamBand,
      });
      log.info('eteams: session team context registered');
    });
  } catch (error) {
    log.warn('eteams: session team context registration failed: %s', String(error));
  }

  // 3b3-2) 一次性消费（用户迭代 2026-09-07「发送后清空选择」）：user/message
  // 到达即把绑定转为本回合凭证（sessionTeam.ts）——消费这条消息的 band 与
  // 派发身份照常生效，下一条真人消息起回到普通对话。客户端在提交瞬间只清
  // 按钮面不删宿主绑定（那条消息的 band/身份还得靠它，见 sessionTeam 模块
  // 头）。只认真人输入（source.kind === 'user'，isHumanUserTurn）：插件注入
  // 的 user 消息（唤醒/邮件/steer）与 agent.inject 合成上下文（文件通知等）
  // 同样走这个事件，若一并消费会把消费回合中途的凭证误撤——dispatch 等
  // 工具随即报「当前会话不在任何 eteams 团队中」。失败不外抛（监听绝不影
  // 响会话，usage.ts 同纪律）。
  try {
    ctx.on(
      'session/event',
      (session: { id?: unknown }, event: { type?: unknown; data?: unknown }): void => {
        try {
          if (event?.type !== 'user/message') return;
          if (!isHumanUserTurn(event.data)) return;
          consumeSessionTeamBinding(String(session?.id ?? ''));
        } catch {
          // 消费失败静默：绑定留在原地，下一条消息再消费。
        }
      },
    );
    log.info('eteams: session team one-shot consumer registered');
  } catch (error) {
    log.warn('eteams: session team consumer registration failed: %s', String(error));
  }

  // 3b3-3) 领队手册插槽（用户迭代 2026-09-08「让真实的 {{}} 渲染出来」）：
  // 领队子代理的 persona 段只含 {{eteams_leader_handbook}} 引用，本插槽按
  // 装配作用域解析领队子代理 → 领队行缓存 md（bakeLeaderHandbook 派发前烘
  // 焙，角色库后续修改不影响）。宿主对插槽替换值**不做二次扫描**，md 里的
  // 真实 {{占位}} 原样进入系统提示。provider 对每个 agent 的每次装配都会
  // 求值：非领队子代理快速返回空串，且全程吞错（空串最多让手册段为空，
  // 绝不让装配失败）。
  try {
    ctx.systemPrompt.variable('eteams_leader_handbook', (context: { scope?: unknown }) => {
      try {
        return leaderHandbookForChild(config, sessionIdOfScope(context.scope) ?? '');
      } catch {
        return '';
      }
    });
    log.info('eteams: leader handbook prompt variable registered');
  } catch (error) {
    log.warn('eteams: leader handbook variable registration failed: %s', String(error));
  }

  // 3b4) 主对话注入（v12 用户迭代「system 角色」，dynamic）：角色库中
  // is_root 保留角色「system」的手册(MD)注入主对话窗口的 system 提示词。
  // 主对话判定与子代理过滤（领队/成员/构建器）在 runtime/rootPrompt.ts；
  // MD 默认空 → '' 空段贡献语义（不注入）。每次装配现读 roles 表——面板
  // 保存即热生效，无需重启。只走 system section 单通道（用户拍板 2026-09-08
  // 「不走上下文了，只走 system 本体」——不复制 3b2/3b3 的 context 快照
  // 通道，MD 只进 system 提示词本体）。
  try {
    ctx.systemPrompt.section({
      name: 'eteams-root-md',
      order: 109,
      text: (context) => rootPromptSection(config, context.scope),
    });
    log.info('eteams: root md section registered');
  } catch (error) {
    log.warn('eteams: root md section registration failed: %s', String(error));
  }

  // 3c) /eteam slash command (docs/19.4, D18): 命令平面统一注册口——/eteam
  // 的定义与 handler 在 commands/eteam.ts，注册壳（含无 commands 服务部署
  // 的降级）在 commands/index.ts。
  registerCommands(ctx, config, log);

  // 4) Captain persona digest (D13 override file support).
  const persona = composeCaptainPersona(stateRootFor(config, process.cwd()));
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
