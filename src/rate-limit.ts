// rate-limit.ts — the token bucket every agent surface in the workspace was
// carrying its own copy of.
//
// In-memory, so it survives across requests within one serverless instance and
// resets on a cold start. That is the right bar for the anonymous read surfaces
// this guards: it bounds a script without needing a Redis round-trip on the hot
// path. Swap for a shared store only when multi-instance sharing actually
// matters.
//
// Framework binding stays with the caller. Turning a verdict into a 429, and
// getting at the request headers in the first place, is four lines of whatever
// framework you are in — and importing one here would cost this package its
// zero-dependency guarantee.

export interface RateLimitOptions {
  /** Bucket capacity: the peak burst a caller may spend at once. */
  capacity: number;
  /** Tokens added per second: the sustained rate. */
  refillPerSec: number;
}

export type RateLimitResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterSec: number };

type Bucket = { tokens: number; updatedAt: number };

const buckets = new Map<string, Bucket>();

/** Bounds memory under high-cardinality keying — one bucket per attacker IP. */
const MAX_KEYS = 10_000;

/**
 * Spend one token against `key`.
 *
 * Keys are namespaced by the caller (`"mcp:1.2.3.4"`, `"write:page:17"`), so
 * one map backs every limiter in a process without them colliding.
 */
export function rateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing && buckets.size >= MAX_KEYS) {
    // Map iteration is insertion-ordered, so this evicts the oldest key.
    const oldest = buckets.keys().next().value;
    if (oldest !== undefined) buckets.delete(oldest);
  }

  const bucket: Bucket = existing ?? { tokens: opts.capacity, updatedAt: now };
  const elapsedSec = (now - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(opts.capacity, bucket.tokens + elapsedSec * opts.refillPerSec);
  bucket.updatedAt = now;
  buckets.set(key, bucket);

  if (bucket.tokens < 1) {
    return { ok: false, retryAfterSec: Math.ceil((1 - bucket.tokens) / opts.refillPerSec) };
  }

  bucket.tokens -= 1;
  return { ok: true, remaining: Math.floor(bucket.tokens) };
}

/** Anything with a header getter: a `Request`'s headers, or Next's `headers()`. */
export interface HeaderReader {
  get(name: string): string | null | undefined;
}

/**
 * The caller's address, from the proxy header the edge sets.
 *
 * Falls back to a single shared bucket rather than to per-caller buckets, so an
 * unidentifiable caller is still limited — collectively, but limited. Keying on
 * anything the caller controls (a user agent, say) hands every caller a fresh
 * bucket per value, which turns the limiter off for exactly the traffic it is
 * meant to catch.
 */
export function clientIp(headers: HeaderReader): string {
  const forwarded = headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || headers.get('x-real-ip')?.trim() || 'anon';
}

/** `prefix:ip` — the key `rateLimit` expects for a per-IP gate. */
export function clientKey(prefix: string, headers: HeaderReader): string {
  return `${prefix}:${clientIp(headers)}`;
}

/** The message a 429 body carries, so every surface refuses in the same words. */
export function retryMessage(retryAfterSec: number): string {
  return `Too many requests. Try again in ${retryAfterSec}s.`;
}

/**
 * The 429 a plain JSON route owes a caller over budget.
 *
 * Web-standard `Response`, so it returns unchanged from a Next route handler.
 * The three surfaces here each kept their own near-identical `limitRoute`; the
 * bucket had been lifted but the refusal it produces had not, so the wording,
 * the `Retry-After` and the cacheability were three separate decisions. An MCP
 * endpoint wants `mcpRateLimited` from `wiki-formant/mcp` instead — that one
 * has to be a JSON-RPC envelope.
 */
export function rateLimitedResponse(retryAfterSec: number): Response {
  return Response.json(
    { error: retryMessage(retryAfterSec), retryAfterSec },
    {
      status: 429,
      headers: { 'Retry-After': String(retryAfterSec), 'Cache-Control': 'no-store' },
    },
  );
}

/** Test seam: the bucket map is module state and outlives a single test. */
export function resetRateLimits(): void {
  buckets.clear();
}
