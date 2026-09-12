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

/**
 * The headroom headers a *successful* response owes the caller.
 *
 * `rateLimit` has always returned `remaining`, and every consumer threw it away
 * — so an agent could discover its budget only by exceeding it, and the 429 was
 * the first and only signal. The conformance suite proved the cost: with no
 * header to read it blind-sleeps five seconds on a 429 and hopes.
 *
 * The de-facto `RateLimit-Limit` / `-Remaining` / `-Reset` triple, in seconds.
 * `Retry-After` stays the 429's own header; these are for the 200s before it.
 */
export function rateLimitHeaders(
  result: RateLimitResult,
  opts: RateLimitOptions,
): Record<string, string> {
  const remaining = result.ok ? result.remaining : 0;
  return {
    'RateLimit-Limit': String(opts.capacity),
    'RateLimit-Remaining': String(remaining),
    // When the bucket is full there is nothing to wait for, so report 0 rather
    // than the time it would take to refill from full, which is not a wait.
    'RateLimit-Reset': String(
      result.ok
        ? Math.ceil((opts.capacity - remaining) / opts.refillPerSec)
        : result.retryAfterSec,
    ),
  };
}

/** `rateLimitHeaders` applied to a response you already have. */
export function withRateLimit<T extends Response>(
  res: T,
  result: RateLimitResult,
  opts: RateLimitOptions,
): T {
  for (const [k, v] of Object.entries(rateLimitHeaders(result, opts))) res.headers.set(k, v);
  return res;
}

/** Test seam: the bucket map is module state and outlives a single test. */
export function resetRateLimits(): void {
  buckets.clear();
}

// ---- the MCP budget ---------------------------------------------------------

/**
 * The one MCP rate-limit number, for every surface that states one.
 *
 * `.well-known/mcp.json`, the OpenAPI spec, agents.md, llms.txt and the
 * `initialize` instructions all quote this, so the endpoint enforces exactly
 * what the documents claim. It is a cross-surface contract, which is why it
 * lives here rather than three times over. A second copy is how a number
 * becomes impossible to change safely: nobody can tell a considered difference
 * from a stale one.
 *
 * A surface with a genuine reason to differ passes its own `RateLimitOptions`.
 * What it must not do is restate this one.
 */
export const MCP_RATE_LIMIT_PER_MIN = 60;

export const MCP_RATE_LIMIT_TEXT = `${MCP_RATE_LIMIT_PER_MIN} requests per minute per IP`;

/** The budget as `mcpResponse` takes it, so a route states it once. */
export const MCP_RATE_LIMIT: RateLimitOptions = {
  capacity: MCP_RATE_LIMIT_PER_MIN,
  refillPerSec: MCP_RATE_LIMIT_PER_MIN / 60,
};
