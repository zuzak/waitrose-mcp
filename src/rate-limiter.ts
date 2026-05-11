import { rateLimitDeniedTotal, rateLimitQueueDepth } from "./metrics.js";

export class DeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeniedError";
  }
}

/**
 * Token-bucket rate limiter for outbound Waitrose API calls.
 *
 * acquire() returns a Promise that resolves when a token is available.
 * Throws DeniedError if the queue is full (caller should surface this
 * as a denied outcome rather than retrying).
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly queue: Array<() => void> = [];
  private draining = false;

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly maxQueue: number,
  ) {
    if (perSecond <= 0) throw new RangeError(`TokenBucket: perSecond must be > 0, got ${perSecond}`);
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.perSecond);
    this.lastRefill = now;
  }

  acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve();
    }

    if (this.queue.length >= this.maxQueue) {
      rateLimitDeniedTotal.inc();
      return Promise.reject(
        new DeniedError(
          `Rate limit queue full (max ${this.maxQueue} pending requests). ` +
            `Increase WAITROSE_RATE_LIMIT_QUEUE_DEPTH to allow more.`,
        ),
      );
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      rateLimitQueueDepth.set(this.queue.length);
      if (!this.draining) this.scheduleDrain();
    });
  }

  private scheduleDrain(): void {
    this.draining = true;
    const msUntilNextToken = Math.max(0, ((1 - this.tokens) / this.perSecond) * 1000);
    setTimeout(() => {
      this.refill();
      while (this.tokens >= 1 && this.queue.length > 0) {
        this.tokens -= 1;
        this.queue.shift()!();
      }
      rateLimitQueueDepth.set(this.queue.length);
      if (this.queue.length > 0) {
        this.scheduleDrain();
      } else {
        this.draining = false;
      }
    }, msUntilNextToken);
  }
}

/** Build a TokenBucket from environment variables with defaults. */
export function rateLimiterFromEnv(): TokenBucket {
  // Clamp to 0.001 minimum: WAITROSE_RATE_LIMIT_PER_SECOND=0 would produce
  // Infinity in scheduleDrain and cause a tight setTimeout loop.
  // The `|| default` fallback guards against non-numeric env var values (NaN).
  const perSecond = Math.max(0.001, parseFloat(process.env.WAITROSE_RATE_LIMIT_PER_SECOND ?? "1") || 1);
  const burst = parseInt(process.env.WAITROSE_RATE_LIMIT_BURST ?? "5", 10) || 5;
  const maxQueue = parseInt(process.env.WAITROSE_RATE_LIMIT_QUEUE_DEPTH ?? "20", 10) || 20;
  return new TokenBucket(perSecond, burst, maxQueue);
}
