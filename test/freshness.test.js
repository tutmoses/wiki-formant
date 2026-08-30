import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStale, daysSince, freshnessNotice, DEFAULT_MAX_AGE_DAYS } from '../dist/freshness.js';

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
