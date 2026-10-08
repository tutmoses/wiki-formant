import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DEFAULT_IFRAME_HOSTS, frameSources, contentSecurityPolicy, securityHeaders, BASE_CSP } from 'wiki-formant/headers';
import { createHtmlSanitizer } from 'wiki-formant/sanitize';

test('BUG: a next.config can load the package, which resolves imports the way require does', () => {
  // Every subpath carried only an `import` condition, so `require` threw
  // ERR_PACKAGE_PATH_NOT_EXPORTED and four configs hand-copied these headers.
  const require = createRequire(import.meta.url);
  const { securityHeaders: viaRequire } = require('wiki-formant/headers');
  assert.equal(viaRequire().length, 6);
});

test('BUG: frame-src admits every host the default sanitiser keeps', () => {
  // One origin's hand-kept frame-src lacked bare youtube.com and
  // youtube-nocookie.com, so those embeds survived cleaning and rendered blank.
  const csp = contentSecurityPolicy();
  const frame = csp.split('; ').find(d => d.startsWith('frame-src '));
  for (const host of DEFAULT_IFRAME_HOSTS) assert.ok(frame.includes(`https://${host}`), host);
  const clean = createHtmlSanitizer();
  assert.match(clean('<iframe src="https://youtube.com/embed/x"></iframe>'), /<iframe/);
});

test('a directive a site passes replaces the default, and an empty list drops it', () => {
  const csp = contentSecurityPolicy({ 'connect-src': ["'self'", 'https://*.radixdlt.com'], 'frame-src': [], 'worker-src': ["'self'", 'blob:'] });
  assert.match(csp, /connect-src 'self' https:\/\/\*\.radixdlt\.com/);
  assert.doesNotMatch(csp, /frame-src/);
  assert.match(csp, /worker-src 'self' blob:/);
  assert.match(csp, /^default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'/);
  assert.equal(BASE_CSP['frame-ancestors'][0], "'none'");
});

test('a host list with no hosts frames nothing rather than everything', () => {
  assert.deepEqual(frameSources([]), ["'none'"]);
});

test('the policy rides only where it is passed', () => {
  assert.equal(securityHeaders().find(h => h.key === 'Content-Security-Policy'), undefined);
  assert.equal(securityHeaders(null).length, 6);
  const withCsp = securityHeaders("default-src 'self'");
  assert.equal(withCsp.length, 7);
  assert.deepEqual(withCsp.find(h => h.key === 'Strict-Transport-Security'), { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' });
});
