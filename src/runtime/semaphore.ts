/** FIFO counting semaphore; waiters can be cancelled with an AbortSignal. */
export class Semaphore {
  private available: number;
  private readonly waiters: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  active = 0;
  maxActive = 0;

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) throw new RangeError('permits must be a positive integer');
    this.available = permits;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.available > 0) {
      this.available--;
      this.track();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject,
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
    this.track();
  }

  release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next.resolve();
    else this.available++;
  }

  private track() {
    this.active++;
    if (this.active > this.maxActive) this.maxActive = this.active;
  }
}
