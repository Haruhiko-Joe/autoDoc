import { access } from "node:fs/promises";

export class Semaphore {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.max === 0 || this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.running--;
    }
  }
}

/**
 * A resettable wake-up signal with a version counter. `wait(since)` resolves
 * immediately if the signal has fired since the `snapshot()`, otherwise it
 * blocks until the next `fire()`.
 */
export class Signal {
  private seq = 0;
  private promise: Promise<void> | null = null;
  private resolve: (() => void) | null = null;

  snapshot(): number {
    return this.seq;
  }

  wait(since?: number): Promise<void> {
    if (since !== undefined && this.seq !== since) return Promise.resolve();
    if (!this.promise) {
      this.promise = new Promise<void>((resolve) => { this.resolve = resolve; });
    }
    return this.promise;
  }

  fire(): void {
    this.seq++;
    this.resolve?.();
    this.resolve = null;
    this.promise = null;
  }
}

export async function withSemaphore<T>(sem: Semaphore, fn: () => Promise<T>): Promise<T> {
  await sem.acquire();
  try {
    return await fn();
  } finally {
    sem.release();
  }
}

export async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[Timeout] ${label} exceeded ${ms / 60_000}min limit`)), ms);
    fn().then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, maxRetries = 3, shouldAbort?: () => boolean): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt >= maxRetries || shouldAbort?.()) throw e;
      const delay = Math.min(2000 * 2 ** attempt, 30_000);
      console.log(`[Arranger] Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${e}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
