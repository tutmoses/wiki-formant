import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rateLimit,
  clientIp,
  clientKey,
  retryMessage,
  resetRateLimits,
} from '../dist/rate-limit.js';

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

test('the address comes from the proxy header, first hop first', () => {
  const h = (map) => ({ get: (k) => map[k] ?? null });
  assert.equal(clientIp(h({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' })), '1.2.3.4');
  assert.equal(clientIp(h({ 'x-real-ip': '5.6.7.8' })), '5.6.7.8');
  assert.equal(clientKey('mcp', h({ 'x-forwarded-for': '1.2.3.4' })), 'mcp:1.2.3.4');
});

test('an unidentifiable caller shares one bucket rather than getting a fresh one', () => {
  const none = { get: () => null };
  assert.equal(clientIp(none), 'anon');
  assert.equal(clientIp({ get: () => '' }), 'anon');
});

test('every surface refuses in the same words', () => {
  assert.equal(retryMessage(12), 'Too many requests. Try again in 12s.');
});
