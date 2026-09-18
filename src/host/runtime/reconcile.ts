/**
 * 死会话对账（用户 2026-09-18「应用重启后还一直是 执行中，执行中的好像没有
 * 获取状态」）：宿主重启后，库里的在办（`pending_accept` / `running`）attempt
 * 没人吊销——中断观察者（interruption.ts）靠**进程内**会话注册表反查会话，重启
 * 即空；崩溃补记的 `turn/end{interrupted}` 也不会再送达，于是库里只剩残值。
 * 面板读侧兜底（webui.containerStatusOf）只要看到在办尝试就判容器 `start`，
 * 任务卡死在「执行中」，再也不会变。
 *
 * 本模块按宿主权威的**活 agent 集合**对账：**只在启动时**跑一轮 + 启动后几秒内补几轮
 * 快扫（`BOOT_SWEEP_DELAYS_MS`，等 workspaceRegistry 就绪），只扫在办 attempt
 * （走部分索引 idx_attempts_status），其执行会话不在 `ctx.agents.list()` 里即视为
 * 「会话已死」→ `pauseTaskOnDeadSession`（吊销尝试 → 小任务 paused → 容器派生同步
 * → 落 `task.suspended{via:'session.dead'}`）。**宽限期**（默认 60s，按
 * `claimed_time ?? created_time` 起算）避开 spawn / 冷恢复途中的短暂不在册，防误杀。
 *
 * 不做常驻轮询（用户 2026-09-18 拍板）：进程内的「用户点停止 / 回合异常结束」都有
 * `turn/end` 事件、由中断观察者实时处置；本模块只负责重启后没有事件可依的那批残留。
 *
 * 与中断观察者同款：root-scope 装机、失败只节流 warn，绝不外抛（对账绝不
 * 影响会话与装机）；扫描量由库里在办尝试数决定，无在办即零成本。
 *
 * @module dsh-eteams/runtime/reconcile
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ETeamsResolvedConfig } from '../config.js';
import type { TeamState } from '../model/types.js';
import { listInFlightAttempts, readTeamSync, type InFlightAttemptRow } from '../state/store.js';
import { pauseTaskOnDeadSession } from './assignment.js';
import { type RuntimeContext, type RuntimeEnv, type RuntimeLogger } from './base.js';
import { collectRoots } from './workspaces.js';

/**
 * 启动快扫时刻（ms）：apply() 执行的瞬间工作区注册表往往还没就绪，`collectRoots`
 * 返回空 → 装机时那次立即 sweep 会空跑，只能干等（实测重启后最长要等满一整轮）。
 * 故启动后几秒内补几轮，注册表一就绪即生效（用户 2026-09-18「扫描的速度好像有点慢」）。
 *
 * **之后不再有周期扫描**（用户 2026-09-18「那个轮询感觉好像没有必要，去掉吧」）：
 * 进程内的「用户点停止 / 回合异常结束」都有 `turn/end` 事件、由中断观察者
 * （interruption.ts）实时处置；本模块只负责服务重启后**没有事件可依**的那批残留，
 * 启动对账一次即可，无需常驻轮询。
 */
const BOOT_SWEEP_DELAYS_MS = [1_000, 3_000, 6_000, 10_000];
/** 宽限期：在办时长不足此值不判死（给 spawn/冷恢复留窗口；用户 2026-09-18 拍板 60s）。 */
const GRACE_MS = 60_000;

let logger: RuntimeLogger | undefined;
let bootTimers: ReturnType<typeof setTimeout>[] = [];
let lastWarnAt = 0;

function warnThrottled(message: string): void {
  const at = Date.now();
  if (at - lastWarnAt < 60_000) return;
  lastWarnAt = at;
  logger?.warn(message);
}

/** 宿主活 agent 注册表的最小面（inject `agents`，cordis Service）。 */
interface LiveAgentsFace {
  list(): { id: unknown }[];
}

/**
 * 当前活 agent 的会话 id 集合（宿主权威存活信号）：重启后必然为空。方法**带
 * 接收者**调用（cordis 服务方法依赖 `this`）；服务缺失/异常一律当空集合。
 */
export function liveAgentIds(ctx: unknown): Set<string> {
  const agents = (ctx as { agents?: LiveAgentsFace }).agents;
  try {
    const list = agents?.list?.();
    if (!Array.isArray(list)) return new Set();
    return new Set(list.map((a) => String(a.id)));
  } catch {
    return new Set();
  }
}

/** 在办尝试的执行会话 id（副本行 id 优先，旧数据退按名兜底）——空串 = 未起会话。 */
function sessionIdOfAttempt(team: TeamState, row: InFlightAttemptRow): string {
  const byId =
    row.taskMemberId !== null
      ? team.taskMembers.find((r) => r.id === row.taskMemberId)
      : undefined;
  const holder = byId ?? team.taskMembers.find((r) => r.name === row.member);
  return holder?.sessionId ?? '';
}

/** One reconciliation pass（导出供测试直接驱动；返回本轮挂起的小任务数）。 */
export async function reconcileDeadSessions(
  ctx: Context,
  config: ETeamsResolvedConfig,
  options: { graceMs?: number; now?: number } = {},
): Promise<number> {
  const live = liveAgentIds(ctx);
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? GRACE_MS;
  let paused = 0;
  for (const { root, workspacePath } of collectRoots(ctx, config)) {
    let rows: InFlightAttemptRow[];
    try {
      rows = listInFlightAttempts(root);
    } catch (error) {
      warnThrottled(`eteams reconcile: 读取在办尝试失败（跳过本轮）：${String(error)}`);
      continue;
    }
    if (rows.length === 0) continue;
    const byTeam = new Map<number, InFlightAttemptRow[]>();
    for (const row of rows) {
      const bucket = byTeam.get(row.teamId);
      if (bucket === undefined) byTeam.set(row.teamId, [row]);
      else bucket.push(row);
    }
    const env: RuntimeEnv = {
      ctx: ctx as unknown as RuntimeContext,
      config,
      workspace: workspacePath,
    };
    for (const [teamId, attempts] of byTeam) {
      const team = readTeamSync(root, teamId);
      if (team === undefined) continue;
      for (const row of attempts) {
        // 宽限期：刚派出/冷恢复在途的会话可能还没在册，不判死。
        if (now - row.since < graceMs) continue;
        const sessionId = sessionIdOfAttempt(team, row);
        // 会话仍活着（含驻留 idle 的子代理）→ 真有工作在办，不动。
        if (sessionId !== '' && live.has(sessionId)) continue;
        try {
          const hit = await pauseTaskOnDeadSession(env, teamId, row.taskId);
          if (hit !== undefined) paused += 1;
        } catch (error) {
          warnThrottled(`eteams reconcile: 挂起任务失败：${String(error)}`);
        }
      }
    }
  }
  return paused;
}

/** Install the dead-session reconciler (root-scope, index.ts apply, 启动一次). */
export function installDeadSessionReconciler(ctx: Context, config: ETeamsResolvedConfig): void {
  logger = (ctx as unknown as { logger: RuntimeLogger }).logger;
  clearBootTimers();
  const run = (): void => {
    void reconcileDeadSessions(ctx, config).catch((error) =>
      warnThrottled(`eteams reconcile: 对账失败（不影响会话）：${String(error)}`),
    );
  };
  // 启动立即跑一轮（重启前的会话全不在册）；此时 workspaceRegistry 往往未就绪 →
  // collectRoots 返回空、本轮 no-op，故紧接着补几轮快扫（见 BOOT_SWEEP_DELAYS_MS），
  // 注册表一就绪即生效。此后不再排期——进程内的中断由中断观察者按事件处置。
  run();
  for (const delay of BOOT_SWEEP_DELAYS_MS) {
    const handle = setTimeout(run, delay);
    // 绝不影响宿主退出：宿主进程不因这些 timer 被拖着不走。
    (handle as { unref?: () => void }).unref?.();
    bootTimers.push(handle);
  }
}

function clearBootTimers(): void {
  for (const handle of bootTimers) clearTimeout(handle);
  bootTimers = [];
}

/** Tests-only：停启动快扫 timer、清模块级 logger 与节流窗口（vitest 隔离）。 */
export function resetReconcilerForTests(): void {
  clearBootTimers();
  logger = undefined;
  lastWarnAt = 0;
}
