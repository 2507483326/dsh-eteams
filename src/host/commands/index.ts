/**
 * dsh-eteams 命令平面注册入口：插件所有斜杠命令经此一个口子注册——
 * apply() 一行调用 {@link registerCommands}，新命令加进本文件即可。
 *
 * @module dsh-eteams/commands
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ETeamsResolvedConfig } from '../config.js';
import { registerEteamCommand } from './eteam.js';

/**
 * Register every plugin slash command. `ctx.inject(['commands'])` 外层
 * try/catch 兜住无 commands 服务的部署（UI-less）：斜杠命令不可用，纯
 * 文本前缀路径仍有效。
 */
export function registerCommands(
  ctx: Context,
  config: ETeamsResolvedConfig,
  log: { info(m: string, ...args: unknown[]): void; warn(m: string, ...args: unknown[]): void },
): void {
  try {
    ctx.inject(['commands'], (commandCtx) => {
      try {
        registerEteamCommand(commandCtx, ctx, config, log);
      } catch (error) {
        log.warn('eteams: /eteam command registration failed: %s', String(error));
      }
    });
  } catch {
    // 无 commands 服务的部署（UI-less）：斜杠命令不可用，纯文本前缀路径仍有效。
  }
}