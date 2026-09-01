/**
 * Process-local async mutexes (docs/09.3): per-team serialization. Locks are
 * keyed promise chains — no cross-process file locking (single-writer
 * assumption, NFR-03). Tails are retained per key (bounded by the number of
 * teams ever seen in this process); a throwing fn never poisons the chain.
 *
 * @module dsh-eteams/state/lock
 */

/** Keyed promise-chain mutex registry. */
export class LockMap {
  private readonly tails = new Map<string, Promise<unknown>>();

  /**
   * Run `fn` while holding the lock for `key`; concurrent callers queue FIFO.
   * @param key - lock key (`team:<root>:<id>`).
   * @param fn - the critical section.
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const gated = previous.then(
      () => undefined,
      () => undefined,
    );
    const release = (async () => {
      await gated;
      return await fn();
    })();
    // Tail settles regardless of fn's outcome so the chain never rejects.
    const tail = release.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    return release;
  }

  /** Test helper: number of tracked lock keys. */
  get size(): number {
    return this.tails.size;
  }
}

/** The process-wide lock registry used by the runtime. */
export const locks = new LockMap();

/** Per-team serialization key (docs/09.3). */
export function teamLockKey(stateRoot: string, teamId: string): string {
  return `team:${stateRoot}:${teamId}`;
}
