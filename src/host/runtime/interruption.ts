/**
 * 中断观察者（用户迭代 2026-09-11）：把「成员/领队回合被中断」翻译成任务挂起。
 *
 * 根因：手动停止子代理发生在宿主侧，插件看不到操作本身；宿主以
 * `turn/end{reason:{kind:'aborted'}}` 收尾被中断的回合（进程崩溃补记为
 * `{kind:'interrupted'}`）。此前 eteams 的 firehose 只消费 usage 相关事件，
 * 中断后任务的在办尝试永远停在 pending_accept/running、任务卡在 ready/start——
 * 面板显示不出「已挂起」、点「开始」也无从续跑。
 *
 * 与 usage 计量同款 root-scope firehose（`ctx.on('session/event')`），按会话 id
 * 分两路：在册成员会话（usage 的 memberSessions 登记表）→ 按副本行反查小任务
 * 挂起（见 {@link pauseTaskOnInterrupt}）；在册领队子代理（captainChildRegistry）
 * → 按中断类型分流到 {@link handleCaptainInterrupt}（用户迭代 2026-09-14：主动
 * 停止挂起主任务，异常中断不挂起、只留备注交主会话判读）。构建器子代理不在此列，
 * 不触发。监听器同步段只做过滤，落库串行走锁；任何异常吞掉，绝不影响会话本身。
 *
 * @module dsh-eteams/runtime/interruption
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { ETeamsResolvedConfig } from '../config.js';
import { handleCaptainInterrupt, pauseTaskOnInterrupt } from './assignment.js';
import { type RuntimeContext, type RuntimeEnv, type RuntimeLogger } from './base.js';
import { captainChildTaskOf, captainChildTeamOf } from './captainChildRegistry.js';
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

/** 中断会话的挂起目标：成员副本行（挂小任务）/ 领队子代理（挂大任务）。 */
export type InterruptionTarget =
  | { kind: 'member'; teamId: string }
  | { kind: 'captain'; teamId: number; taskId: number };

/**
 * 把被中断的会话 id 解析成挂起目标（纯判据，导出供测试锁定路由契约）：
 * 成员副本行会话（memberSessions）→ 挂该小任务；领队子代理
 * （captainChildRegistry）→ 挂其锚定的大任务（用户迭代 2026-09-14）；构建器等
 * 其它会话 → undefined（不触发）。
 */
export function resolveInterruptionTarget(sessionId: string): InterruptionTarget | undefined {
  const member = lookupMemberSession(sessionId);
  if (member !== undefined) return { kind: 'member', teamId: member.teamId };
  const teamId = captainChildTeamOf(sessionId);
  const taskId = captainChildTaskOf(sessionId);
  if (teamId === undefined || taskId === undefined) return undefined;
  const parsedTeam = Number(teamId);
  const parsedTask = Number(taskId);
  if (!Number.isFinite(parsedTeam) || !Number.isFinite(parsedTask)) return undefined;
  return { kind: 'captain', teamId: parsedTeam, taskId: parsedTask };
}

/** Install the interruption watcher (root-scope firehose, index.ts apply). */
export function installInterruptionWatcher(ctx: Context, config: ETeamsResolvedConfig): void {
  logger = (ctx as unknown as { logger: RuntimeLogger }).logger;
  ctx.on('session/event', (session, event) => {
    try {
      if (!isInterruptionEvent(event as SessionEvent)) return;
      const sessionId = String((session as Session).id);
      // 成员副本行会话 → 挂小任务；领队子代理 → 挂其锚定的大任务（用户迭代
      // 2026-09-14：此前领队不在册、直接 return，主任务卡在「执行中」，再派发
      // 会重新唤醒领队导致状态对不上）；其余（构建器等）不触发。
      const target = resolveInterruptionTarget(sessionId);
      if (target === undefined) return;
      const env: RuntimeEnv = {
        ctx: ctx as unknown as RuntimeContext,
        config,
        workspace: (session as Session).header?.cwd ?? process.cwd(),
      };
      const reason = (event as SessionEvent & { type: 'turn/end' }).data.reason.kind;
      if (target.kind === 'member') {
        void pauseTaskOnInterrupt(env, target.teamId, sessionId, reason).catch((error) =>
          warnThrottled(`eteams interruption: 挂起任务失败：${String(error)}`),
        );
        return;
      }
      void handleCaptainInterrupt(env, target.teamId, target.taskId, reason).catch((error) =>
        warnThrottled(`eteams interruption: 处置领队中断失败：${String(error)}`),
      );
    } catch (error) {
      warnThrottled(`eteams interruption: 监听器异常（不影响会话）：${String(error)}`);
    }
  });
}
