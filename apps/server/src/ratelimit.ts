import { DisdkError } from '@disdk/protocol';

interface Bucket {
  hits: number[];
}

/**
 * Sliding-window limiter.
 *
 * The sponsor pays a network fee for every transaction it issues, and rent when
 * it creates a token account, so an unbounded issue endpoint is a way to drain
 * the fee payer. These limits are the cheap half of that defence; the other
 * half is the per-session issue cap in `@disdk/verify`.
 */
export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #limit: number;
  readonly #windowMs: number;

  // Written out rather than as constructor parameter properties, which Node's
  // type-stripping loader cannot handle.
  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  check(key: string): void {
    const now = Date.now();
    const bucket = this.#buckets.get(key) ?? { hits: [] };
    bucket.hits = bucket.hits.filter((time) => now - time < this.#windowMs);

    if (bucket.hits.length >= this.#limit) {
      const retryIn = Math.ceil((this.#windowMs - (now - (bucket.hits[0] as number))) / 1000);
      throw new DisdkError(
        'RATE_LIMITED',
        `Too many attempts. Try again in ${retryIn}s.`,
        true,
      );
    }

    bucket.hits.push(now);
    this.#buckets.set(key, bucket);
  }

  sweep(): void {
    const now = Date.now();
    for (const [key, bucket] of this.#buckets) {
      if (bucket.hits.every((time) => now - time >= this.#windowMs)) {
        this.#buckets.delete(key);
      }
    }
  }
}
