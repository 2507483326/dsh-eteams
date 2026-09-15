/**
 * 「待决策」红点的已读账本（用户 2026-09-15「有新的待决策内容时，对话上面的
 * 团队TAB，需要出现红点提示。直到进入面板看到决策，或者决策被回答」）。
 *
 * 宿主只暴露 pending 原始行——decisions 只有 open/resolved、ask_questions 只有
 * pending/answered/expired/cancelled（src/host/model/types.ts、src/host/state/
 * asks.ts），两侧都没有「谁看过」的列，所以「新」只能由客户端自己记账：
 * - 账本键 = `<决策面板行键>@<创建时刻>`。行键本身已全局唯一（决策号自增、
 *   问答号 uuid），再附创建时刻是防「库被重置/换工作区后 id 复用」把新单误判
 *   成已读；
 * - 账本落 localStorage（与 teamsButton 的团队选择同款离线镜像口径）——不落盘
 *   的话刷新一次就会为已经见过的旧单重新亮红点；
 * - 红点判据 =「存在 pending 且不在账本里的行」（跨全部团队，不漏报）；标记已读
 *   只标「面板当下真正展示的那一队」（看板按选中团队取数，见 board/decisionPanel）
 *   ——没看见的不算见过，红点留到用户切队看到为止。
 *
 * 「决策被回答」不需要额外处理：pending 行一旦处置/作答就从快照里消失，
 * {@link unseenPendingKeys} 自然不再计入，红点随之熄灭。
 *
 * @module dsh-eteams/client/features/activity/decisionSeen
 */
import type { TeamSnapshot } from '../../lib/monitor';
import { pendingActionsOf, type PendingAction } from './activityView';

/** 已读账本的 localStorage 键（`eteams:` 前缀与 teamsButton 的离线镜像同族）。 */
const STORAGE_KEY = 'eteams:pending-seen';

/** 账本上限：只留最近 N 条（Set 保持插入序，超出从头部裁）。 */
const MAX_KEYS = 500;

/** 待决策行 → 已读账本键（行键 + 创建时刻，见文件头 id 复用注记）。 */
export function pendingItemKey(action: PendingAction): string {
  return `${action.key}@${action.at}`;
}

/** 若干团队当下 pending 行的账本键（红点判据与面板标记共用同一口径）。 */
export function pendingItemKeys(teams: readonly TeamSnapshot[]): string[] {
  const keys: string[] = [];
  for (const team of teams) {
    for (const action of pendingActionsOf(team)) keys.push(pendingItemKey(action));
  }
  return keys;
}

/** 账本（首次读取时从 localStorage 载入）。 */
let seen: Set<string> | null = null;

/** 账本变化的订阅者（teamTabDot 据此即时收点）。 */
const listeners = new Set<() => void>();

/** 读账本；坏 JSON / 无 localStorage（Node 测试、隐私模式）按空账本。 */
function seenSet(): Set<string> {
  if (seen !== null) return seen;
  const loaded = new Set<string>();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const key of parsed) if (typeof key === 'string') loaded.add(key);
      }
    }
  } catch {
    // 无 localStorage / 坏值：按空账本，本会话内仍按内存生效。
  }
  seen = loaded;
  return seen;
}

/** 写回账本（超出上限丢最旧）。 */
function persist(): void {
  const keys = [...seenSet()];
  const trimmed = keys.length > MAX_KEYS ? keys.slice(keys.length - MAX_KEYS) : keys;
  if (trimmed.length !== keys.length) seen = new Set(trimmed);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // 写失败静默：内存账本本会话内仍生效，重载后退回上一次落盘值。
  }
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // 订阅者异常不影响账本与其余订阅者。
    }
  }
}

/** 未读的 pending 行键（红点判据；空数组 = 无需提示）。 */
export function unseenPendingKeys(teams: readonly TeamSnapshot[]): string[] {
  const known = seenSet();
  return pendingItemKeys(teams).filter((key) => !known.has(key));
}

/** 订阅账本变化（返回退订函数）。 */
export function subscribeDecisionSeen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 面板已展示某队的待决策行 → 全部记已读（用户 2026-09-15「进入面板看到决策」）。
 *
 * 幂等：没有新键就直接返回，不写盘也不通知——DecisionPanel 的 effect 每次快照
 * 都会调一次，而快照对象每秒都是新引用。
 */
export function markPendingDecisionsSeen(team: TeamSnapshot): void {
  const known = seenSet();
  const fresh = pendingItemKeys([team]).filter((key) => !known.has(key));
  if (fresh.length === 0) return;
  for (const key of fresh) known.add(key);
  persist();
  notify();
}

/** 测试专用：清空内存账本（localStorage 由测试自备或缺失）。 */
export function resetDecisionSeenForTests(): void {
  seen = null;
  listeners.clear();
}
