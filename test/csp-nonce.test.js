import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentSecurityPolicy, scriptHash } from 'wiki-formant/headers';

test('a nonce replaces unsafe-inline and carries the inline scripts as hashes', () => {
  const csp = contentSecurityPolicy({}, { nonce: 'abc', inlineScripts: ['x=1'] });
  assert.match(csp, /script-src 'self' 'nonce-abc' 'sha256-/);
  assert.ok(!csp.includes("'unsafe-inline' 'nonce"));
  assert.ok(csp.includes(scriptHash('x=1')));
});

test('without a nonce the policy is unchanged', () => {
  assert.match(contentSecurityPolicy(), /script-src 'self' 'unsafe-inline'/);
});
