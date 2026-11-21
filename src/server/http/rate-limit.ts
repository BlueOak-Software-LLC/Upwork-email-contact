import { ApiError } from "@/server/http/errors";

/**
 * Best-effort in-process limiter.
 *
 * Vercel server functions are isolated per region/instance, so this only
 * throttles traffic hitting one warm instance — enough to stop an accidental
 * loop or a runaway script. For a hard guarantee use Upstash Ratelimit
 * (`@upstash/ratelimit`) or a Postgres counter keyed on the sender.
 */
type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const SWEEP_EVERY = 1_000;
let calls = 0;

export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();

  if (++calls % SWEEP_EVERY === 0) sweep(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { remaining: limit - 1, resetAt: now + windowMs };
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    throw ApiError.rateLimited(Math.ceil((bucket.resetAt - now) / 1000));
  }
  return { remaining: limit - bucket.count, resetAt: bucket.resetAt };
}

function sweep(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}
