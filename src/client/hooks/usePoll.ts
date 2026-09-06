/**
 * 轮询 hook（docs/44 M7-8，46 清单）：壳 index 的活动点 3s 轮询与角色构建
 * 会话 1.5s 轮询原是两份同款「挂载即拉一次 + setInterval 重拉 + 卸载清理」
 * effect，收口到这里避免漂移。buildCard 的 fetchBuildState 轮询是
 * setTimeout 重试链（1500/800 扑空 75 次重试）——语义不同，**不并**本件
 * （46 清单明示）。
 *
 * pull 以 `isCurrent` 回调收参：异步回包先 `isCurrent()` 判定本轮询代是否
 * 仍存活（卸载或依赖变化即失效），与迁移前逐效应 `alive` 旗号同语义——
 * 防陈旧团队的活动快照回写。deps 携带 pull 身份（useCallback 包裹的调用
 * 方语义不变）与间隔。
 *
 * @module dsh-eteams/client/usePoll
 */
import { useEffect } from 'react';

/** 轮询单拉：isCurrent() = 本轮询代仍存活（未卸载、deps 未变）。 */
export type PollPull = (isCurrent: () => boolean) => void;

/** 挂载/依赖变化即拉一次，然后每 intervalMs 毫秒重拉；卸载/重启清 interval。 */
export function usePoll(pull: PollPull, intervalMs: number): void {
  useEffect(() => {
    let alive = true;
    const isCurrent = (): boolean => alive;
    pull(isCurrent);
    const h = setInterval(() => pull(isCurrent), intervalMs);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [pull, intervalMs]);
}
