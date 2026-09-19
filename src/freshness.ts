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

import { isoDate } from './html.js';

export { isoDate };

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

/**
 * The sentence the notice carries. Both wikis shipped this string identically,
 * down to the ISO date and the closing request, so it lives here rather than
 * being re-typed either side of the extraction.
 */
export function freshnessNotice(page: FreshnessInput): string {
  const when = page.lastVerifiedAt
    ? `last verified ${isoDate(new Date(page.lastVerifiedAt))}`
    : 'not yet verified against sources';
  return `This page was ${when} and may be out of date. Please help re-check its facts against current sources and the live ledger.`;
}

/**
 * A synthetic `outdated` banner block for a stale page, or null when it is
 * fresh — the shape every wiki's `banner` type already stores, so it drops
 * into the tree the renderer walks. Two wikis carried this function
 * identically. `nowMs` comes from a server component: reading the clock
 * during a client render would let a page near the boundary be stale on the
 * server and fresh in the browser.
 */
export function freshnessBanner(
  page: FreshnessInput,
  nowMs: number,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
): { id: string; type: 'banner'; variant: 'outdated'; text: string } | null {
  if (!isStale(page, nowMs, maxAgeDays)) return null;
  return { id: '__freshness__', type: 'banner', variant: 'outdated', text: freshnessNotice(page) };
}

// ---- dates for display ------------------------------------------------------

type When = Date | string | number;

const toMs = (d: When): number => (typeof d === 'number' ? d : d instanceof Date ? d.getTime() : Date.parse(d));

/**
 * A calendar day for a reader: `Sep 19, 2026`. Always in UTC. A stored
 * timestamp formatted in the server's zone, or the browser's, lands on the
 * previous day for half the world, and the server and the hydrating client
 * disagree about which day it is.
 */
export function formatDay(date: When, options?: Intl.DateTimeFormatOptions): string {
  return new Date(toMs(date)).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
    ...options,
  });
}

/**
 * - `compact`: `now`, `2m`, `3h`, `5d`, `2mo`, `1y` — for dense rows.
 * - `short`: `just now`, `2m ago` … `1y ago`.
 * - `long`: `today`, `yesterday`, `3 days ago`, `1 month ago` — day-grained,
 *   because it suits a page cached for hours, where "3 hours ago" would be
 *   frozen and wrong by the next reader.
 */
export type RelativeTimeStyle = 'compact' | 'short' | 'long';

export interface RelativeTimeOptions {
  style?: RelativeTimeStyle;
  /** From this many whole days on, the date itself (`formatDay`) rather than a distance. */
  absoluteAfterDays?: number;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;

/**
 * How long before `now` a moment was. `now` is the render's time, passed in:
 * a server render that read the clock would hydrate against a later one and
 * the text would disagree. A moment after `now` (clock skew) reads as now.
 *
 * Three copies of this had drifted into three bugs between them: `0y` for a
 * moment 360–364 days old, where twelve 30-day months fell through to a floor
 * of zero years, and `1 months ago`.
 */
export function relativeTime(then: When, now: number, options: RelativeTimeOptions = {}): string {
  const { style = 'compact', absoluteAfterDays } = options;
  const sec = Math.max(0, Math.floor((now - toMs(then)) / 1000));
  const day = Math.floor(sec / 86_400);
  if (absoluteAfterDays !== undefined && day >= absoluteAfterDays) return formatDay(then);

  const months = Math.max(1, Math.floor(day / 30.4375));
  const years = Math.max(1, Math.floor(day / 365.25));

  if (style === 'long') {
    if (day === 0) return 'today';
    if (day === 1) return 'yesterday';
    if (day < 30) return plural(day, 'day');
    return day < 365 ? plural(months, 'month') : plural(years, 'year');
  }

  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const span =
    sec < 60 ? '' : min < 60 ? `${min}m` : hr < 24 ? `${hr}h` : day < 30 ? `${day}d` : day < 365 ? `${months}mo` : `${years}y`;
  if (style === 'compact') return span || 'now';
  return span ? `${span} ago` : 'just now';
}
