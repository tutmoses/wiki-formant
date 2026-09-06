import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashStr, seededRandom } from 'wiki-formant/seeded';
import { corpusRoute, textHeaders } from 'wiki-formant/http';
import { MCP_RATE_LIMIT, MCP_RATE_LIMIT_PER_MIN, MCP_RATE_LIMIT_TEXT } from 'wiki-formant/rate-limit';
import { BANNER_LABELS, BANNER_VARIANTS } from 'wiki-formant/text';
import { registryAuthHandler } from 'wiki-formant/well-known';
import {
  TRANSIENT_CODES,
  describeFailure,
  extractEmbeds,
  extractLinks,
  mapLimit,
  probeUrlFor,
  unverifiableReason,
} from 'wiki-formant/link-check';

// ---- seeded -----------------------------------------------------------------

test('the same string always hashes to the same non-negative number', () => {
  assert.equal(hashStr('Radix DLT'), hashStr('Radix DLT'));
  assert.ok(hashStr('— anything \u{1F600}') >= 0);
  assert.notEqual(hashStr('a'), hashStr('b'));
});

test('a seed of 0 does not stick the generator at 0', () => {
  // Without the `<= 0` correction every call returns the same number and
  // whatever it lays out degenerates to a single point.
  const rand = seededRandom(0);
  const first = [rand(), rand(), rand()];
  assert.equal(new Set(first).size, 3);
  for (const n of first) assert.ok(n > 0 && n < 1);
});

test('a seed larger than the modulus still produces a stream', () => {
  const rand = seededRandom(2147483647 * 3 + 11);
  const runs = [rand(), rand()];
  assert.equal(new Set(runs).size, 2);
});

test('the same seed replays the same sequence', () => {
  const a = seededRandom(hashStr('Hyperscale'));
  const b = seededRandom(hashStr('Hyperscale'));
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

// ---- conditional GET --------------------------------------------------------

const validators = { etag: 'W/"abc-1"', lastModified: 'Wed, 02 Sep 2026 10:00:00 GMT' };

test('corpusRoute does not build the body on a 304', async () => {
  let built = 0;
  const handler = corpusRoute(
    () => validators,
    () => {
      built++;
      return 'the whole corpus';
    },
  );

  const fresh = await handler(new Request('https://x.test/llms.txt'));
  assert.equal(fresh.status, 200);
  assert.equal(built, 1);

  const cached = await handler(
    new Request('https://x.test/llms.txt', { headers: { 'if-none-match': validators.etag } }),
  );
  assert.equal(cached.status, 304);
  // The whole point: a recrawl costs a 304, not a corpus render.
  assert.equal(built, 1);
});

test('corpusRoute serves both validators on the 200', async () => {
  const res = await corpusRoute(() => validators, () => 'body')(new Request('https://x.test/llms.txt'));
  assert.equal(res.headers.get('ETag'), validators.etag);
  assert.equal(res.headers.get('Last-Modified'), validators.lastModified);
  assert.match(res.headers.get('Content-Type'), /text\/plain/);
});

test('corpusRoute takes a header builder for twins that are not text/plain', async () => {
  const res = await corpusRoute(
    () => validators,
    () => '# md',
    (etag, lastModified) => ({ ...textHeaders(etag, lastModified), 'Content-Type': 'text/markdown' }),
  )(new Request('https://x.test/page.md'));
  assert.equal(res.headers.get('Content-Type'), 'text/markdown');
});

// ---- the MCP budget ---------------------------------------------------------

test('the stated limit and the enforced budget are the same number', () => {
  assert.equal(MCP_RATE_LIMIT.capacity, MCP_RATE_LIMIT_PER_MIN);
  assert.equal(MCP_RATE_LIMIT.refillPerSec, MCP_RATE_LIMIT_PER_MIN / 60);
  assert.ok(MCP_RATE_LIMIT_TEXT.includes(String(MCP_RATE_LIMIT_PER_MIN)));
});

// ---- banner variants --------------------------------------------------------

test('the editor list and the renderer labels cannot disagree', () => {
  assert.equal(BANNER_VARIANTS.length, Object.keys(BANNER_LABELS).length);
  for (const { value, label } of BANNER_VARIANTS) assert.equal(label, BANNER_LABELS[value]);
});

// ---- registry auth ----------------------------------------------------------

test('an unset key is a 404, never a malformed record', async () => {
  assert.equal(registryAuthHandler(undefined, undefined)().status, 404);
});

test('a configured key serves the MCPv1 record uncached', async () => {
  const res = registryAuthHandler('pubkeybase64', undefined)();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(await res.text(), 'v=MCPv1; k=ed25519; p=pubkeybase64\n');
});

test('a P-384 key declares its own type', async () => {
  const res = registryAuthHandler('k', 'p384')();
  assert.match(await res.text(), /k=p384;/);
});

// ---- link check -------------------------------------------------------------

test('an npm package page is probed at the registry, not the 403ing website', () => {
  assert.equal(
    probeUrlFor('https://www.npmjs.com/package/@radixdlt/radix-dapp-toolkit'),
    'https://registry.npmjs.org/@radixdlt/radix-dapp-toolkit',
  );
  assert.equal(probeUrlFor('https://example.test/x'), 'https://example.test/x');
});

test('an expired certificate is reported as TLS, not as a dead host', () => {
  const err = Object.assign(new Error('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } });
  const out = describeFailure(err);
  assert.equal(out.tls, 'CERT_HAS_EXPIRED');
  assert.match(out.note, /confirm before touching the citation/);
});

test('a connect refusal carries its code so a caller can retry it', () => {
  const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const out = describeFailure(err);
  assert.equal(out.code, 'ECONNREFUSED');
  assert.ok(TRANSIENT_CODES.has(out.code));
  assert.equal(out.tls, undefined);
});

test('an abort is a timeout, not a failure message', () => {
  const err = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  assert.deepEqual(describeFailure(err), { error: 'timeout' });
});

test('links and embeds are pulled out of a fragment separately', () => {
  const html =
    '<p><a href="/wiki/a" class="link">Alpha</a> and <a href="https://b.test">B<em>e</em>ta</a></p>' +
    '<iframe src="https://youtube.com/embed/xyz"></iframe><img src="/img/a.png" alt="">';
  assert.deepEqual(extractLinks(html), [
    { href: '/wiki/a', text: 'Alpha' },
    { href: 'https://b.test', text: 'Beta' },
  ]);
  assert.deepEqual(extractEmbeds(html), [
    { kind: 'iframe', url: 'https://youtube.com/embed/xyz' },
    { kind: 'img', url: '/img/a.png' },
  ]);
});

test('a widget-shell host is unverifiable rather than healthy', () => {
  const hosts = new Map([['widgets.example.test', 'loader shell — 200 says nothing']]);
  assert.match(unverifiableReason('https://widgets.example.test/w?id=1', hosts), /loader shell/);
  // Subdomains count; unrelated hosts do not.
  assert.ok(unverifiableReason('https://cdn.widgets.example.test/w', hosts));
  assert.equal(unverifiableReason('https://other.test/w', hosts), null);
  assert.equal(unverifiableReason('not a url', hosts), null);
});

test('mapLimit preserves input order under a ceiling', async () => {
  const items = [30, 10, 20, 5, 1];
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit(items, 2, async n => {
    peak = Math.max(peak, ++inFlight);
    await new Promise(r => setTimeout(r, n));
    inFlight--;
    return n * 2;
  });
  assert.deepEqual(out, [60, 20, 40, 10, 2]);
  assert.ok(peak <= 2, `ran ${peak} at once`);
});

test('mapLimit on an empty list resolves rather than hanging', async () => {
  assert.deepEqual(await mapLimit([], 4, async x => x), []);
});
