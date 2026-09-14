/**
 * /eteam 命令（docs/19.4, D18）：新增成员 · 角色构建师的命令面入口。斜杠
 * 输入本身不会到达模型，handler 把激活消息（`eTeam --add-people …`）显式
 * steer 到接收 agent 上；门禁 + 受理即写盘 + 持续构建子代理受理派发
 * （startBuilderChild）的编排随 handler 走，命令面一次性 UX 文本（busy/
 * 降级 notice）留在本文件。
 *
 * @module dsh-eteams/commands/eteam
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { ETeamsResolvedConfig } from '../config.js';
import {
  deliverNotice,
  resumeOptionsOf,
  type RuntimeContext,
} from '../runtime/base.js';
import {
  hasBuildSessionFile,
  readBuildSession,
  reportBuildProgress,
  cancelBuildSession,
} from '../runtime/roleBuilder.js';
import { rootForWrites } from '../runtime/webui.js';
import { startBuilderChild } from '../runtime/builderPhases.js';
import { annotateBuildSession, appendEngageDiag } from '../runtime/roleBuilder.js';
import { ACTIVATION_PREFIX } from '../prompts/system/roleBuilder.js';

/** The /eteam slash command name (DSH command names are lowercase, docs/19.4). */
export const ADD_PEOPLE_COMMAND = 'eteam';

/** The bare requirement body used when the invocation carries no arguments. */
export const ADD_PEOPLE_BARE_BODY = '我需要创建一个成员 【成员名称】，它的职责是【职责】。';

/**
 * Compose the activation message steered by the /eteam command: normalize a
 * leading `--add-people` (the command hint repeats it), fall back to the
 * bare template body, and prepend the activation marker.
 */
export function buildActivationMessage(rawInput: string): string {
  let rest = rawInput.trim();
  if (rest.startsWith('--add-people')) {
    rest = rest.slice('--add-people'.length).trim();
  }
  return `${ACTIVATION_PREFIX} ${rest === '' ? ADD_PEOPLE_BARE_BODY : rest}`;
}

/**
 * Engage a conversationally blank session with a short plugin notice after
 * the build was accepted (docs/19.16 空会话唤醒，用户反馈 2026-09-04)。
 *
 * 斜杠命令只落 command/run + command/done 两条 log-only 记录——既不是
 * prompt 也不开 turn，宿主的 blank→engaged 相位机（blank 仅由 turn/start
 * 翻转；命令记录、plan/goal 等插件事件都不开 turn）永远不翻：主窗口停在
 * 未开始屏，对话视图渲染不出，/eteam 命令节点与对话内构建卡片不挂载，
 * 卡片的「发送即跳转」无从发生——构建在后台完全隐形地跑，用户只见「子
 * agent 创建了，界面却没进对话」。steer 一条 plugin notice 让 idle driver
 * 立即开 turn：宿主 running 位翻转 → 客户端 blankBit 清零 → 对话视图出现
 * → 命令节点渲染 → 构建卡片挂载并接管落地（20s 窗口自动跳转照常生效）。
 * 开过 turn 的会话不加这一回合——避免每次 /eteam 多出一段应答噪音。
 */
export async function steerEngageNotice(
  ctx: Context,
  agent: Agent,
  stateRoot: string,
  log: { info(m: string, ...args: unknown[]): void; warn(m: string, ...args: unknown[]): void },
): Promise<string> {
  const diag = (entry: Record<string, unknown>): void => {
    appendEngageDiag(stateRoot, entry);
  };
  try {
    // 空白桌面会话在首条 prompt 之前**没有活 agent**(注册表里查不到,
    // 0.1.2 实测 engage-result: agent-session-missing)——先用 agents.resume
    // 把活 agent 物化出来(askUser 离线投递同款冷恢复;句柄不 dispose,
    // 锚定会话),再投递 engage 通知。
    const id = String((agent as { id?: unknown }).id ?? '');
    let live =
      (ctx.agents?.get?.(id as never) as Agent | undefined) ?? undefined;
    let resumed = false;
    if (live === undefined) {
      const resume = (ctx.agents as {
        resume?: (o: {
          resumeSessionId: SessionId;
          signal?: AbortSignal;
          agentOptions?: { provider?: string; model?: string; reasoningEffort?: string };
          setup?: (agentCtx: unknown) => void | Promise<void>;
        }) => Promise<{ agent: Agent }>;
      }).resume;
      if (typeof resume !== 'function') {
        diag({ step: 'no-resume-capability', id });
        return 'no-resume-capability';
      }
      const handle = await resume(
        await resumeOptionsOf(ctx, id as unknown as SessionId, new AbortController().signal),
      );
      live = handle.agent;
      resumed = true;
    }
    const face = live as unknown as {
      id?: unknown;
      session?: { events?: ReadonlyArray<{ type?: unknown }> };
      followup?: unknown;
      send?: unknown;
      steer?: unknown;
    };
    // 空白判定与宿主 sessionBlank 同口径：无 turn/start 事件 = 会话从未开
    // 过回合（Session.events 只读快照，同步可读）。
    const engaged = face.session?.events?.some((event) => event.type === 'turn/start') ?? false;
    if (engaged) {
      diag({ step: 'engaged', id, resumed });
      return 'engaged';
    }
    const primitive =
      typeof face.followup === 'function'
        ? 'followup'
        : typeof face.send === 'function'
          ? 'send'
          : typeof face.steer === 'function'
            ? 'steer'
            : 'none';
    // 零 token engage（0.1.2 agent/pre-step 契约）：在活 agent 上注册一次性
    // pre-step 监听,engage 消息领取后被 {kind:'reject'} 拒收——回合开启并
    // 关闭、不开步骤、**不调模型**（零 token）,turn/start 照常提交,
    // sessionListMetadata.blank 照常清除 → 对话视图出现。一次性后放行后续
    // step（不影响用户真实消息）。
    const ENGAGE_MARKER = '（成员构建请求已受理';
    const liveCtx = (live as unknown as {
      ctx?: {
        on?: (
          ev: string,
          cb: (payload: unknown, next: () => unknown) => unknown,
        ) => (() => void) | void;
      };
    }).ctx;
    let rejected = false;
    if (typeof liveCtx?.on === 'function') {
      liveCtx.on('agent/pre-step', (payload: unknown, next: () => unknown) => {
        if (rejected) return next();
        rejected = true;
        const messages =
          (payload as { messages?: Array<{ content?: Array<{ text?: string }> }> }).messages ?? [];
        const texts = messages.map((m) => (m.content ?? []).map((b) => b.text ?? '').join(' '));
        diag({ step: 'pre-step', claimed: texts.length });
        if (!texts.some((t) => t.includes(ENGAGE_MARKER))) return next();
        diag({ step: 'pre-step-rejected' });
        return { kind: 'reject' };
      });
    }
    // engage 通知以用户身份注入（harness 子代理初始 prompt 同款 source）：
    // 0.1.2 桌面壳的转场看 sessionListMetadata——lastPromptAt 只认
    // source.kind==='user' 的消息，plugin 来源的 notice 永远不清 blankBit、
    // 对话视图不出现（2026-09-08 用户实测「卡在探索未至之境」）。内容精简:
    // 它被 pre-step 拒收,不会真正进入对话（零 token）。
    deliverNotice(
      live,
      createUserMessage({
        content: [
          {
            type: 'text',
            text: '（成员构建请求已受理——角色构建师在后台进行中，进度见构建卡片。本会话无须创建成员或调用构建工具；如无其他待办，一句话确认即可。）',
          },
        ],
        source: { kind: 'user' },
      }),
    );
    log.info('eteams: /eteam steered an engage notice onto a blank session');
    // 诊断落独立日志（桌面宿主 logger 不落盘;构建 note 有子代理报告写竞态）:
    // agent 对象的方法清单 + 所用原语,engage 投递问题的权威证据。
    diag({
      step: 'delivered',
      id,
      primitive,
      resumed,
      inventory: {
        followup: typeof face.followup,
        send: typeof face.send,
        steer: typeof face.steer,
        session: typeof face.session,
      },
    });
    return `primitive=${primitive}${resumed ? '+resumed' : ''}`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn('eteams: engage steer failed (build continues in background): %s', reason);
    diag({ step: 'error', error: reason });
    return 'error:' + reason;
  }
}

/**
 * Build the /eteam command definition. Slash input never reaches the model
 * on its own, so the handler explicitly steers the activation message onto
 * the receiving agent — an idle driver starts a turn immediately.
 */
export function createEteamCommand(
  ctx: Context,
  config: ETeamsResolvedConfig,
  log: { info(m: string, ...args: unknown[]): void; warn(m: string, ...args: unknown[]): void },
): CommandDefinition {
  return {
    name: ADD_PEOPLE_COMMAND,
    description: '新增成员 · 角色构建师',
    input: {
      hint: `--add-people ${ADD_PEOPLE_BARE_BODY}`,
      images: false,
    },
    handler: async ({ agent, rawInput, commandId }) => {
      // 门禁 + 持续构建子代理受理派发（docs/19.16）：已有构建进行中则不
      // 派发；否则 startBuilderChild（startContinuable 建立唯一构建子代理
      // ——受理回合做查重/发布访谈/弹窗/起草，后续环节由宿主 followup
      // 续聊同一子代理，不再起第二个）。受理即写盘（卡片首轮轮询即命中），
      // commandId 写入会话供对话内卡片按构建归属。派发失败退回 steer 主
      // 会话，保证流程永不哑火。
      let root: string | null = null;
      const diag = (step: string, extra: Record<string, unknown> = {}): void => {
        appendEngageDiag(root ?? rootForWrites(ctx, config), { step, ...extra });
      };
      diag('handler-enter');
      try {
        root = rootForWrites(ctx, config);
        diag('gate-read', { root });
        const current = readBuildSession(root);
        if (
          current !== null &&
          (current.status === 'active' || current.status === 'awaiting_confirmation')
        ) {
          diag('gate-blocked-active-build');
          deliverNotice(
            agent,
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
          return {
            kind: 'success' as const,
            text: '已有成员构建在进行中——未派发新构建，详见上方提示。',
          };
        }
        if (current === null && hasBuildSessionFile(root)) {
          // 会话文件在但读不出（瞬时 IO 竞态）——按忙处理，宁拒不漏放。
          return {
            kind: 'success' as const,
            text: '构建状态正在写入，请稍候 1-2 秒重发 /eteam。',
          };
        }
      } catch {
        // 状态读不到时不拦：照常派发（受理写入 newBuild=true 会开新局）。
      }
      try {
        const subagents = (ctx as unknown as RuntimeContext).subagents;
        if (subagents?.startContinuable === undefined) {
          throw new Error('subagents 服务不可用');
        }
        const stateRoot = root ?? rootForWrites(ctx, config);
        // 立即受理（docs/19.16 用户迭代）：派发前先把受理会话写上磁盘
        // ——卡片/新增页首轮轮询即命中、自动跳转立刻发生；request 用
        // 用户原文，子代理从磁盘读到的就是新需求（不再继承旧会话）。
        await reportBuildProgress(stateRoot, {
          newBuild: true,
          step: '收到需求',
          stepsDone: ['收到需求'],
          request: buildActivationMessage(rawInput),
          note: '构建请求已受理——角色构建师启动中',
          ...(commandId !== undefined ? { commandId } : {}),
        });
        diag('accepted');
        startBuilderChild({
          ctx: { subagents },
          config,
          parent: agent,
          stateRoot,
          logger: log,
          onSpawnFailure: (error) => {
            // 派发被拒 → 回滚成 cancelled，别让无子代理的 active 会话
            // 卡住下一次 /eteam 的门禁。真实原因进 note——桌面宿主的
            // logger.warn 不落盘，卡片是用户唯一能看到失败的表面。
            const reason = error instanceof Error ? error.message : String(error);
            void cancelBuildSession(
              stateRoot,
              `构建派发失败——请重新发起 /eteam（原因：${reason}）`,
            ).catch(() => undefined);
          },
        });
        // 空会话唤醒（docs/19.16）：受理后若会话从未开过 turn（空白会话上
        // 斜杠命令只落 log-only 记录，主窗口仍停在未开始屏），steer 一条
        // notice 让 idle driver 立即开 turn——对话视图出现后命令节点与构建
        // 卡片才挂载，卡片的「发送即跳转」才接管落地。
        diag('child-dispatched');
        const engage = await steerEngageNotice(ctx, agent, stateRoot, log);
        diag('engage-result', { result: engage });
        annotateBuildSession(stateRoot, `engage=${engage}`);
        return {
          kind: 'success' as const,
          text: '成员构建已受理——创建卡片与新增页已显示构建状态，意图访谈将在其上出现。',
        };
      } catch (error) {
        // 受理已落盘的场合一并回滚（pre-write 成功但同步段炸了）。真实原因
        // 进 note——桌面宿主的 logger.warn 不落盘，卡片是可见的失败表面。
        if (root !== null) {
          const reason = error instanceof Error ? error.message : String(error);
          void cancelBuildSession(
            root,
            `构建派发失败——请重新发起 /eteam（原因：${reason}）`,
          ).catch(() => undefined);
        }
        deliverNotice(
          agent,
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
        return { kind: 'success' as const, text: '成员创建请求已转交主会话处理。' };
      }
    },
  };
}

/**
 * Register the /eteam command onto the commands scope（commands/index.ts 的
 * inject 回调调用；commandCtx 由 cordis inject(['commands']) 推断给出）。
 */
export function registerEteamCommand(
  commandCtx: { commands: { register(c: CommandDefinition): unknown } },
  ctx: Context,
  config: ETeamsResolvedConfig,
  log: { info(m: string, ...args: unknown[]): void; warn(m: string, ...args: unknown[]): void },
): void {
  commandCtx.commands.register(createEteamCommand(ctx, config, log));
  log.info('eteams: /eteam command registered');
}