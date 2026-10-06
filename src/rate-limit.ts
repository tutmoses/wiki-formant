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
  /**
   * Running dry blocks `blockKey` outright for this long, rather than letting
   * the bucket refill a token at a time. For a caller already established as
   * abusive, the trickle the refill allows is the wrong answer.
   */
  blockMs?: number;
  /**
   * What a block shuts out. Default the bucket's own key; pass the bare
   * address (`rest:1.2.3.4`) to lock a caller out of every endpoint that names
   * the same `blockKey` once it blows one endpoint's budget.
   */
  blockKey?: string;
}

export type RateLimitResult =
  | { ok: true; remaining: number }
  /** `blocked` is true when an earlier block refused the call, rather than this one's bucket. */
  | { ok: false; retryAfterSec: number; blocked?: boolean };

type Bucket = { tokens: number; updatedAt: number };

const buckets = new Map<string, Bucket>();

/** Bounds memory under high-cardinality keying — one bucket per attacker IP. */
const MAX_KEYS = 10_000;

/**
 * Blocks, held as an expiry timestamp rather than a setTimeout: a pending timer
 * keeps a serverless instance's event loop alive for no reason.
 */
const blocks = new Map<string, number>();

/** Seconds left on a block, or 0. An expired block is dropped on the way past. */
function blockedFor(key: string, now: number): number {
  const until = blocks.get(key);
  if (until === undefined) return 0;
  if (now < until) return Math.ceil((until - now) / 1000);
  blocks.delete(key);
  return 0;
}

function block(key: string, until: number, now: number): void {
  if (blocks.size >= MAX_KEYS) {
    for (const [k, expiry] of blocks) if (expiry <= now) blocks.delete(k);
    // Still full of live blocks: the oldest goes, as with buckets.
    if (blocks.size >= MAX_KEYS) {
      const oldest = blocks.keys().next().value;
      if (oldest !== undefined) blocks.delete(oldest);
    }
  }
  blocks.set(key, until);
}

/**
 * Spend one token against `key`.
 *
 * Keys are namespaced by the caller (`"mcp:1.2.3.4"`, `"write:page:17"`), so
 * one map backs every limiter in a process without them colliding.
 *
 * With `blockMs`, a block on `blockKey` is checked before any token is spent,
 * and running the bucket dry starts one; the refusal then states the block's
 * length as its wait.
 */
export function rateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const blockKey = opts.blockKey ?? key;
  if (opts.blockMs) {
    const blockedSec = blockedFor(blockKey, now);
    if (blockedSec) return { ok: false, retryAfterSec: blockedSec, blocked: true };
  }
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
    if (opts.blockMs) {
      block(blockKey, now + opts.blockMs, now);
      return { ok: false, retryAfterSec: Math.ceil(opts.blockMs / 1000) };
    }
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
 * The caller's address, from the header the edge sets.
 *
 * `x-real-ip` first: Vercel sets it to the connecting client and overwrites any
 * inbound copy, so a client cannot choose it. The leftmost `x-forwarded-for`
 * entry is only as trustworthy as every proxy in front of the app — one that
 * appends rather than replaces hands the client the first slot, and with it a
 * fresh bucket and a fresh visitor per request. It stays as the fallback for a
 * host that sets no `x-real-ip`.
 *
 * Falls back to a single shared bucket rather than to per-caller buckets, so an
 * unidentifiable caller is still limited — collectively, but limited. Keying on
 * anything the caller controls (a user agent, say) hands every caller a fresh
 * bucket per value, which turns the limiter off for exactly the traffic it is
 * meant to catch.
 */
export function clientIp(headers: HeaderReader): string {
  return (
    headers.get('x-real-ip')?.trim() ||
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'anon'
  );
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
  blocks.clear();
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
