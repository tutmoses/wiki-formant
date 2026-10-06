import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rateLimit,
  clientIp,
  clientKey,
  retryMessage,
  rateLimitHeaders,
  withRateLimit,
  resetRateLimits,
} from 'wiki-formant/rate-limit';

const opts = { capacity: 3, refillPerSec: 1 };

test('a bucket spends down to its capacity and then refuses', () => {
  resetRateLimits();
  for (let i = 0; i < 3; i++) assert.equal(rateLimit('k', opts).ok, true);
  const refused = rateLimit('k', opts);
  assert.equal(refused.ok, false);
  assert.ok(refused.retryAfterSec >= 1);
});

test('keys are independent, so one caller cannot spend the budget of another', () => {
  resetRateLimits();
  for (let i = 0; i < 3; i++) rateLimit('a', opts);
  assert.equal(rateLimit('a', opts).ok, false);
  assert.equal(rateLimit('b', opts).ok, true);
});

test('remaining counts down and never goes negative', () => {
  resetRateLimits();
  assert.equal(rateLimit('r', opts).remaining, 2);
  assert.equal(rateLimit('r', opts).remaining, 1);
  assert.equal(rateLimit('r', opts).remaining, 0);
  assert.equal(rateLimit('r', opts).ok, false);
});

test('a refused call does not consume the token it was refused', () => {
  resetRateLimits();
  const one = { capacity: 1, refillPerSec: 0.0001 };
  assert.equal(rateLimit('slow', one).ok, true);
  const first = rateLimit('slow', one);
  const second = rateLimit('slow', one);
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  // Without this, every refused call would push the retry window further out
  // and a client honouring Retry-After would still arrive early.
  assert.equal(first.retryAfterSec, second.retryAfterSec);
});

test('the address is the platform-set header first, then the first forwarded hop', () => {
  const h = (map) => ({ get: (k) => map[k] ?? null });
  assert.equal(clientIp(h({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' })), '1.2.3.4');
  assert.equal(clientIp(h({ 'x-real-ip': '5.6.7.8' })), '5.6.7.8');
  // A client can prepend to x-forwarded-for behind a proxy that appends; it
  // cannot set x-real-ip on Vercel, so that one wins.
  assert.equal(clientIp(h({ 'x-real-ip': '5.6.7.8', 'x-forwarded-for': '6.6.6.6, 5.6.7.8' })), '5.6.7.8');
  assert.equal(clientIp(h({ 'x-real-ip': ' ', 'x-forwarded-for': '1.2.3.4' })), '1.2.3.4');
  assert.equal(clientKey('mcp', h({ 'x-forwarded-for': '1.2.3.4' })), 'mcp:1.2.3.4');
});

test('blowing a budget with blockMs blocks the block key, across buckets, for the block', () => {
  resetRateLimits();
  const limit = { capacity: 1, refillPerSec: 100, blockMs: 30_000, blockKey: 'rest:9.9.9.9' };
  assert.equal(rateLimit('rest:/a:9.9.9.9', limit).ok, true);
  const tripped = rateLimit('rest:/a:9.9.9.9', limit);
  assert.deepEqual(tripped, { ok: false, retryAfterSec: 30 });
  // Another endpoint naming the same block key is shut too, before any token is spent.
  const other = rateLimit('rest:/b:9.9.9.9', { ...limit, capacity: 100 });
  assert.equal(other.ok, false);
  assert.equal(other.blocked, true);
  assert.ok(other.retryAfterSec > 0 && other.retryAfterSec <= 30);
  // A different caller is untouched.
  assert.equal(rateLimit('rest:/a:1.1.1.1', { ...limit, blockKey: 'rest:1.1.1.1' }).ok, true);
});

test('a block expires, and without blockMs a dry bucket only waits for its next token', async () => {
  resetRateLimits();
  const limit = { capacity: 1, refillPerSec: 1000, blockMs: 20 };
  rateLimit('k', limit);
  assert.equal(rateLimit('k', limit).ok, false);
  assert.equal(rateLimit('k', limit).blocked, true);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(rateLimit('k', limit).ok, true);

  resetRateLimits();
  rateLimit('j', { capacity: 1, refillPerSec: 1 });
  assert.deepEqual(rateLimit('j', { capacity: 1, refillPerSec: 1 }), { ok: false, retryAfterSec: 1 });
});

test('an unidentifiable caller shares one bucket rather than getting a fresh one', () => {
  const none = { get: () => null };
  assert.equal(clientIp(none), 'anon');
  assert.equal(clientIp({ get: () => '' }), 'anon');
});

test('every surface refuses in the same words', () => {
  assert.equal(retryMessage(12), 'Too many requests. Try again in 12s.');
});

test('a successful call reports its own headroom, so the 429 is not the first signal', () => {
  resetRateLimits();
  const opts = { capacity: 60, refillPerSec: 1 };
  const first = rateLimitHeaders(rateLimit('h:1', opts), opts);
  assert.equal(first['RateLimit-Limit'], '60');
  assert.equal(first['RateLimit-Remaining'], '59');
  assert.equal(first['RateLimit-Reset'], '1');

  const spent = { ok: false, retryAfterSec: 7 };
  const over = rateLimitHeaders(spent, opts);
  assert.equal(over['RateLimit-Remaining'], '0');
  assert.equal(over['RateLimit-Reset'], '7');
});

test('withRateLimit sets them on a response already built', () => {
  resetRateLimits();
  const opts = { capacity: 10, refillPerSec: 1 };
  const res = withRateLimit(new Response('ok'), rateLimit('h:2', opts), opts);
  assert.equal(res.headers.get('RateLimit-Limit'), '10');
  assert.equal(res.headers.get('RateLimit-Remaining'), '9');
});
