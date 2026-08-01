import { DemoError } from "./errors";

type Entry = { readonly timestamps: number[] };

export class DemoRateLimiter {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly nowMs: () => number = Date.now) {}

  assert(key: string, limit: number, windowMs: number): void {
    const now = this.nowMs();
    const cutoff = now - windowMs;
    const timestamps = (this.entries.get(key)?.timestamps ?? []).filter((timestamp) => timestamp > cutoff);
    if (timestamps.length >= limit) throw new DemoError("DEMO_RATE_LIMITED", "rate limit exceeded", 429);
    timestamps.push(now);
    this.entries.set(key, { timestamps });
  }
}
