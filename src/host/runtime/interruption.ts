/**
 * 中断观察者（用户迭代 2026-09-11）：把「成员回合被中断」翻译成任务挂起。
 *
 * 根因：手动停止子代理发生在宿主侧，插件看不到操作本身；宿主以
 * `turn/end{reason:{kind:'aborted'}}` 收尾被中断的回合（进程崩溃补记为
 * `{kind:'interrupted'}`）。此前 eteams 的 firehose 只消费 usage 相关事件，
 * 中断后任务的在办尝试永远停在 pending_accept/running、任务卡在 ready/start——
 * 面板显示不出「已挂起」、点「开始」也无从续跑。
 *
 * 与 usage 计量同款 root-scope firehose（`ctx.on('session/event')`）：只认在册
 * 成员会话（usage 的 memberSessions 登记表）——领队/构建器会话不在册，天然不
 * 触发；命中即按会话 id 反查副本行，把该任务挂起（见
 * {@link pauseTaskOnInterrupt}）。监听器同步段只做过滤，落库串行走锁；任何
 * 异常吞掉，绝不影响会话本身。
 *
 * @module dsh-eteams/runtime/interruption
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { ETeamsResolvedConfig } from '../config.js';
import { pauseTaskOnInterrupt } from './assignment.js';
import { type RuntimeContext, type RuntimeEnv, type RuntimeLogger } from './base.js';
import { lookupMemberSession } from './usage.js';

let logger: RuntimeLogger | undefined;
let lastWarnAt = 0;

function warnThrottled(message: string): void {
  const at = Date.now();
  if (at - lastWarnAt < 60_000) return;
  lastWarnAt = at;
  logger?.warn(message);
}

/**
 * 该事件是否表示一个「被中断的回合」：`turn/end` 且结束原因是被取消（手动停止）
 * 或崩溃补记。纯判据，导出供测试锁定事件契约。
 */
export function isInterruptionEvent(event: SessionEvent): boolean {
  if (event.type !== 'turn/end') return false;
  const kind = event.data.reason.kind;
  return kind === 'aborted' || kind === 'interrupted';
}

/** Install the interruption watcher (root-scope firehose, index.ts apply). */
export function installInterruptionWatcher(ctx: Context, config: ETeamsResolvedConfig): void {
  logger = (ctx as unknown as { logger: RuntimeLogger }).logger;
  ctx.on('session/event', (session, event) => {
    try {
      if (!isInterruptionEvent(event as SessionEvent)) return;
      const sessionId = String((session as Session).id);
      const member = lookupMemberSession(sessionId);
      // 只处理成员副本行会话（领队/构建器不在册）。
      if (member === undefined) return;
      const env: RuntimeEnv = {
        ctx: ctx as unknown as RuntimeContext,
        config,
        workspace: (session as Session).header?.cwd ?? process.cwd(),
      };
      const reason = (event as SessionEvent & { type: 'turn/end' }).data.reason.kind;
      void pauseTaskOnInterrupt(env, member.teamId, sessionId, reason).catch((error) =>
        warnThrottled(`eteams interruption: 挂起任务失败：${String(error)}`),
      );
    } catch (error) {
      warnThrottled(`eteams interruption: 监听器异常（不影响会话）：${String(error)}`);
    }
  });
}
