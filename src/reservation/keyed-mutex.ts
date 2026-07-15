/**
 * Per-key in-process async mutex.
 *
 * Serializes overlapping asynchronous operations for the same key inside one
 * Node process. This is an OPTIMIZATION that prevents wasted duplicate work and
 * interleaving; it is never the cross-process safety guarantee. The durable
 * record version (CAS) and the filesystem lock remain authoritative.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Chain this operation after any currently-queued work for the key.
    const nextTail = previous.then(() => gate);
    this.tails.set(key, nextTail);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      // Best-effort cleanup: drop the map entry only if we are the tail so the
      // map does not grow without bound. A newer waiter replaces the tail.
      if (this.tails.get(key) === nextTail) {
        this.tails.delete(key);
      }
    }
  }
}
