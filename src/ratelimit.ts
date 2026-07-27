/**
 * Sliding-window rate limiter.
 *
 * Waits rather than throwing when the window is full — a search that takes an
 * extra two seconds is far better than one that fails. Reports usage so the
 * activity widget can show remaining headroom.
 *
 * Two consumers: Perplexity's own quota and Jina Reader's 20 RPM free tier.
 * Each gets its own instance; they must not share state.
 */

/**
 * The limiters in play, passed around as one bag so a caller that only needs
 * one does not have to know which others exist.
 */
export interface RateLimiters {
  perplexity?: RateLimiter;
  jina?: RateLimiter;
}

export interface RateLimitInfo {
  used: number;
  max: number;
  oldestTimestamp: number | null;
  windowMs: number;
}

export interface RateLimiterOptions {
  maxRequests: number;
  windowMs: number;
  /** Test seam. */
  now?: () => number;
  /** Test seam; must resolve after `ms` and honour the signal. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onUpdate?: (info: RateLimitInfo) => void;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted while waiting for rate limit"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Aborted while waiting for rate limit"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class RateLimiter {
  private readonly timestamps: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly onUpdate?: (info: RateLimitInfo) => void;
  /** Serializes waiters so N concurrent callers don't all decide to go at once. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions) {
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    if (options.onUpdate) this.onUpdate = options.onUpdate;
  }

  private prune(at: number): void {
    const cutoff = at - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }
  }

  info(): RateLimitInfo {
    this.prune(this.now());
    return {
      used: this.timestamps.length,
      max: this.maxRequests,
      oldestTimestamp: this.timestamps.length > 0 ? this.timestamps[0]! : null,
      windowMs: this.windowMs,
    };
  }

  /** Blocks until a slot is free, then records the request. */
  async acquire(signal?: AbortSignal): Promise<void> {
    const run = this.queue.then(() => this.acquireOne(signal));
    // Keep the chain alive even when a waiter rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  private async acquireOne(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const at = this.now();
      this.prune(at);
      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(at);
        this.onUpdate?.(this.info());
        return;
      }
      const oldest = this.timestamps[0]!;
      const waitMs = Math.max(1, oldest + this.windowMs - at);
      this.onUpdate?.(this.info());
      await this.sleep(waitMs, signal);
    }
  }
}
