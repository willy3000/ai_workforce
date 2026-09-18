import type { Request, RequestHandler } from 'express';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';

/**
 * Admission control.
 *
 * Audit finding S9: nothing stopped a caller from starting many expensive jobs.
 * Iteration and tool-call caps bound a *single* agent run; they say nothing
 * about how many runs a caller may start, which is where the real money and the
 * real resource exhaustion live.
 *
 * Two tiers, because the costs are different by orders of magnitude:
 *  - a general tier protecting the process from request volume;
 *  - a run tier on the handful of endpoints that start model work, where a
 *    single admitted request can cost dollars and minutes.
 *
 * ## Scope
 * This is an in-process fixed-window counter. It is correct for the single-node
 * deployment the repository actually describes and is explicitly *not* a
 * distributed limiter: two API replicas would each allow the full budget. The
 * seam for a shared store (Redis, or a Mongo counter) is `RateLimiter.hit`.
 * Fixed windows also permit a 2x burst across a boundary; that is an accepted
 * trade for not carrying a sliding-window structure per client.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  /** Record a hit; returns the decision and what to tell the caller. */
  hit(key: string, now = Date.now()): { allowed: boolean; remaining: number; retryAfterMs: number } {
    this.sweep(now);

    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.max - 1, retryAfterMs: 0 };
    }

    bucket.count += 1;
    if (bucket.count > this.max) {
      return { allowed: false, remaining: 0, retryAfterMs: bucket.resetAt - now };
    }
    return { allowed: true, remaining: this.max - bucket.count, retryAfterMs: 0 };
  }

  /**
   * Drop expired buckets so an unbounded key space (one per IP) cannot grow into
   * a memory leak. Sweeping on write rather than on a timer keeps the limiter
   * free of process-lifetime state that tests would have to unwind.
   */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  /** Test seam: forget all state. */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Identify the caller.
 *
 * With a shared API key every authenticated request is the same principal, so
 * the client address is the only distinguishing signal available. `trust proxy`
 * is set in `app.ts`, so `req.ip` reflects `X-Forwarded-For` — which is
 * spoofable unless a proxy you control rewrites it. That weakness is inherent to
 * IP-based limiting and goes away when per-user identity arrives; the key
 * function is where it will change.
 */
function clientKey(req: Request): string {
  return req.actor?.kind === 'operator' ? `operator:${req.ip ?? 'unknown'}` : `anon:${req.ip ?? 'unknown'}`;
}

function middlewareFor(limiter: RateLimiter, tier: string, max: number): RequestHandler {
  return (req, res, next) => {
    const decision = limiter.hit(`${tier}:${clientKey(req)}`);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, decision.remaining)));

    if (decision.allowed) return next();

    const retryAfterSeconds = Math.ceil(decision.retryAfterMs / 1000);
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return next(
      new AppError(
        `Rate limit exceeded for ${tier} requests. Retry in ${retryAfterSeconds}s.`,
        429,
        'rate_limited',
        { retryAfterSeconds },
      ),
    );
  };
}

const generalLimiter = new RateLimiter(env.RATE_LIMIT_WINDOW_MS, env.RATE_LIMIT_MAX_REQUESTS);
const runLimiter = new RateLimiter(env.RATE_LIMIT_WINDOW_MS, env.RATE_LIMIT_MAX_RUNS);

/** Applied to every `/api` route. */
export const generalRateLimit = middlewareFor(generalLimiter, 'api', env.RATE_LIMIT_MAX_REQUESTS);

/** Applied to endpoints that start model work: runs, task execution, onboarding. */
export const runRateLimit = middlewareFor(runLimiter, 'run', env.RATE_LIMIT_MAX_RUNS);

/** Test seam. */
export function resetRateLimiters(): void {
  generalLimiter.reset();
  runLimiter.reset();
}
