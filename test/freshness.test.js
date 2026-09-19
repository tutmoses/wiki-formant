import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStale, daysSince, freshnessNotice, DEFAULT_MAX_AGE_DAYS, relativeTime, formatDay, isoDate } from 'wiki-formant/freshness';

const NOW = Date.UTC(2026, 7, 30);
const daysAgo = n => new Date(NOW - n * 86_400_000);

test('a recently verified page is fresh', () => {
  assert.equal(isStale({ lastVerifiedAt: daysAgo(10) }, NOW), false);
});

test('a page past the threshold is stale', () => {
  assert.equal(isStale({ lastVerifiedAt: daysAgo(DEFAULT_MAX_AGE_DAYS + 1) }, NOW), true);
});

test('a page with no dates at all is stale', () => {
  assert.equal(isStale({}, NOW), true);
});

test('updatedAt stands in when lastVerifiedAt is unset', () => {
  assert.equal(isStale({ updatedAt: daysAgo(5) }, NOW), false);
  assert.equal(isStale({ updatedAt: daysAgo(400) }, NOW), true);
});

test('an unparseable date is treated as no date', () => {
  assert.equal(daysSince('not a date', NOW), null);
  assert.equal(isStale({ lastVerifiedAt: 'not a date' }, NOW), true);
});

test('ISO strings and Date objects agree', () => {
  assert.equal(daysSince(daysAgo(7).toISOString(), NOW), 7);
  assert.equal(daysSince(daysAgo(7), NOW), 7);
});

test('the notice is the exact sentence both wikis shipped', () => {
  // Published copy: an ISO date, not a day count, and the closing request.
  assert.equal(
    freshnessNotice({ lastVerifiedAt: new Date(Date.UTC(2026, 2, 15)) }),
    'This page was last verified 2026-03-15 and may be out of date. '
    + 'Please help re-check its facts against current sources and the live ledger.',
  );
  assert.match(freshnessNotice({ updatedAt: daysAgo(400) }), /^This page was not yet verified against sources and may be out of date\./);
});

test('now is a parameter, so two renders of one request agree', () => {
  const page = { lastVerifiedAt: daysAgo(DEFAULT_MAX_AGE_DAYS) };
  assert.equal(isStale(page, NOW), isStale(page, NOW));
});

// ---- display dates ----

const ago = s => NOW - s * 1000;
const DAY = 86_400;

test('compact relative time walks the units', () => {
  const cases = [[5, 'now'], [120, '2m'], [3 * 3600, '3h'], [5 * DAY, '5d'], [45 * DAY, '1mo'], [800 * DAY, '2y']];
  for (const [s, want] of cases) assert.equal(relativeTime(ago(s), NOW), want);
});

test('360 to 364 days is months, never zero years', () => {
  for (let d = 355; d < 365; d++) assert.match(relativeTime(ago(d * DAY), NOW), /^1[12]mo$/);
  assert.equal(relativeTime(ago(365 * DAY), NOW), '1y');
});

test('months and years round to the nearest', () => {
  assert.equal(relativeTime(ago(60 * DAY), NOW), '2mo');
  assert.equal(relativeTime(ago(700 * DAY), NOW), '2y');
});

test('long relative time is day-grained and singular where it should be', () => {
  assert.equal(relativeTime(ago(3600), NOW, { style: 'long' }), 'today');
  assert.equal(relativeTime(ago(DAY), NOW, { style: 'long' }), 'yesterday');
  assert.equal(relativeTime(ago(3 * DAY), NOW, { style: 'long' }), '3 days ago');
  assert.equal(relativeTime(ago(40 * DAY), NOW, { style: 'long' }), '1 month ago');
  assert.equal(relativeTime(ago(350 * DAY), NOW, { style: 'long' }), '11 months ago');
  assert.equal(relativeTime(ago(400 * DAY), NOW, { style: 'long' }), '1 year ago');
});

test('short relative time says ago, and hands over to the date after a cutoff', () => {
  assert.equal(relativeTime(ago(10), NOW, { style: 'short' }), 'just now');
  assert.equal(relativeTime(ago(43 * 60), NOW, { style: 'short' }), '43m ago');
  assert.equal(relativeTime(ago(3 * DAY), NOW, { style: 'short', absoluteAfterDays: 7 }), '3d ago');
  assert.equal(relativeTime(ago(8 * DAY), NOW, { style: 'short', absoluteAfterDays: 7 }), formatDay(ago(8 * DAY)));
});

test('a moment after now reads as now, and every input type agrees', () => {
  assert.equal(relativeTime(NOW + 60_000, NOW), 'now');
  const t = ago(2 * DAY);
  assert.equal(relativeTime(new Date(t), NOW), relativeTime(new Date(t).toISOString(), NOW));
});

test('formatDay is the UTC day whatever the zone', () => {
  // 00:30 UTC is still the previous day in every zone west of Greenwich.
  assert.equal(formatDay('2026-09-19T00:30:00Z'), 'Sep 19, 2026');
  assert.equal(formatDay('2026-09-19T23:30:00Z', { month: 'long' }), 'September 19, 2026');
  assert.equal(isoDate(new Date('2026-09-19T23:30:00Z')), '2026-09-19');
});
