// freshness.ts — the on-chain-native extension of verifiability.
//
// A page is "fresh" if its facts were verified recently. Crypto facts decay
// fast, so a page not re-checked within `maxAgeDays` earns a synthetic notice
// at the top of the article until an editor (or a maintenance sweep) re-checks
// it and stamps `lastVerifiedAt`.
//
// `now` is a parameter rather than a `Date.now()` call inside the function.
// This runs during SSR, and a render that reads the clock is a render that can
// disagree with the one the server just sent.

export interface FreshnessInput {
  lastVerifiedAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

export const DEFAULT_MAX_AGE_DAYS = 180;

const DAY_MS = 86_400_000;

/** Whole days between `date` and `now`, or null when there is no usable date. */
export function daysSince(date: Date | string | null | undefined, now: number): number | null {
  if (!date) return null;
  const t = date instanceof Date ? date.getTime() : Date.parse(date);
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / DAY_MS);
}

/**
 * Stale when the page has never been verified, or was verified longer ago than
 * `maxAgeDays`. Falls back to `updatedAt` when `lastVerifiedAt` is unset: an
 * edit is a weaker signal than a verification, but it is a signal.
 */
export function isStale(page: FreshnessInput, now: number, maxAgeDays = DEFAULT_MAX_AGE_DAYS): boolean {
  const age = daysSince(page.lastVerifiedAt ?? page.updatedAt, now);
  return age === null || age > maxAgeDays;
}

/** The wording the banner carries, which depends on why the page is stale. */
export function freshnessMessage(page: FreshnessInput, now: number): string {
  const age = daysSince(page.lastVerifiedAt, now);
  return age === null ? 'not yet verified against sources' : `last verified ${age} days ago`;
}
