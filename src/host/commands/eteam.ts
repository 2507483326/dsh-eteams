/**
 * /eteam 命令（docs/19.4, D18）：新增成员 · 角色构建师的命令面入口。斜杠
 * 输入本身不会到达模型，handler 把激活消息（`eTeam --add-people …`）显式
 * steer 到接收 agent 上；门禁 + 受理即写盘 + 一次性阶段派发的编排随
 * handler 走，命令面一次性 UX 文本（busy/降级 notice）留在本文件。
 *
 * @module dsh-eteams/commands/eteam
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { Context } from '@deepseek-ai/cordis';
import type { ETeamsResolvedConfig } from '../config.js';
import type { RuntimeContext } from '../runtime/base.js';
import {
  hasBuildSessionFile,
  readBuildSession,
  reportBuildProgress,
  cancelBuildSession,
} from '../runtime/roleBuilder.js';
import { rootForWrites } from '../runtime/webui.js';
import { spawnBuildPhase } from '../runtime/builderPhases.js';
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
export function steerEngageNotice(
  agent: Agent,
  log: { info(m: string, ...args: unknown[]): void; warn(m: string, ...args: unknown[]): void },
): void {
  try {
    // 空白判定与宿主 sessionBlank 同口径：无 turn/start 事件 = 会话从未开
    // 过回合（Session.events 只读快照，同步可读）。
    const engaged = agent.session.events.some((event) => event.type === 'turn/start');
    if (engaged) return;
    agent.steer(
      createUserMessage({
        content: [
          {
            type: 'text',
            text: '成员构建请求已受理——角色构建师已在后台开工，进度见对话内构建卡片与团队面板的新增工作台。本会话无需处理这条请求：不要创建成员，也不要调用构建相关工具；如无其他待办，用一句话确认即可。',
          },
        ],
        source: {
          kind: 'plugin',
          plugin: 'dsh-eteams',
          form: 'notice',
          summary: '成员构建已受理——本会话无需操作',
        },
      }),
    );
    log.info('eteams: /eteam steered an engage notice onto a blank session');
  } catch (error) {
    log.warn(
      'eteams: engage steer failed (build continues in background): %s',
      error instanceof Error ? error.message : String(error),
    );
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
      // 门禁 + 一次性阶段派发（docs/19.16）：已有构建进行中则不派发；
      // 否则派发阶段 A 一次性代理（开会话 → 查重 → 发布意图访谈后自然
      // 结束）——没有任何可续聊的持久子代理被留下。受理即写盘（卡片
      // 首轮轮询即命中），commandId 写入会话供对话内卡片按构建归属。
      // 派发失败退回 steer 主会话，保证流程永不哑火。
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
        // 状态读不到时不拦：照常派发（阶段代理的 newBuild 会开新局）。
      }
      try {
        const subagents = (ctx as unknown as RuntimeContext).subagents;
        if (subagents?.start === undefined) {
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
        spawnBuildPhase({
          ctx: { subagents },
          config,
          parent: agent,
          stateRoot,
          kind: 'start',
          logger: log,
          onSpawnFailure: () => {
            // 派发被拒 → 回滚成 cancelled，别让无子代理的 active 会话
            // 卡住下一次 /eteam 的门禁。
            void cancelBuildSession(stateRoot, '构建派发失败——请重新发起 /eteam').catch(
              () => undefined,
            );
          },
        });
        // 空会话唤醒（docs/19.16）：受理后若会话从未开过 turn（空白会话上
        // 斜杠命令只落 log-only 记录，主窗口仍停在未开始屏），steer 一条
        // notice 让 idle driver 立即开 turn——对话视图出现后命令节点与构建
        // 卡片才挂载，卡片的「发送即跳转」才接管落地。
        steerEngageNotice(agent, log);
        return {
          kind: 'success' as const,
          text: '成员构建已受理——创建卡片与新增页已显示构建状态，意图访谈将在其上出现。',
        };
      } catch {
        // 受理已落盘的场合一并回滚（pre-write 成功但同步段炸了）。
        if (root !== null) {
          void cancelBuildSession(root, '构建派发失败——请重新发起 /eteam').catch(
            () => undefined,
          );
        }
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