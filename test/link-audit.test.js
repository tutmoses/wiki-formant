import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditLinks } from 'wiki-formant/link-check';

test('auditLinks probes each url once and checks internals against the live set', async () => {
  const probed = [];
  const probe = async url => (probed.push(url), { url, status: url.includes('dead') ? 404 : 200, ok: !url.includes('dead') });
  const page = (path, html, metadata) => ({ path, content: [{ id: '1', type: 'content', text: html }], metadata });
  const audit = await auditLinks(
    [
      page('/a', '<a href="https://dead.test/">x</a><a href="/b/history">h</a><a href="/gone">g</a><a href="/app/x">r</a><img src="https://img.test/p.png">'),
      page('/b', '<a href="https://dead.test/">x</a><a href="/a?sort=new">q</a>', { website: 'ok.test' }),
    ],
    { livePaths: new Set(['/a', '/b']), probe, internal: p => !p.startsWith('/app') },
  );
  assert.deepEqual(probed.sort(), ['https://dead.test/', 'https://ok.test']);
  assert.equal(audit.externalChecked, 2);
  assert.deepEqual(audit.brokenExternal.map(b => [b.url, b.pages]), [['https://dead.test/', ['/a', '/b']]]);
  assert.deepEqual(audit.brokenInternal, [{ url: '/gone', pages: ['/a'] }]);
  assert.deepEqual([...audit.skipped.keys()], ['/app/x']);
  assert.deepEqual(audit.embeds.get('https://img.test/p.png'), { kind: 'img', pages: ['/a'] });
});

test('verdictOf: only a dead link is broken; a wall, a lapsed certificate or no answer is unverifiable', async () => {
  const { verdictOf } = await import('wiki-formant/link-check');
  assert.deepEqual(verdictOf({ url: 'u', status: 200, ok: true }), { kind: 'alive' });
  assert.deepEqual(verdictOf({ url: 'u', status: 404, ok: false }), { kind: 'dead', status: 404 });
  assert.deepEqual(verdictOf({ url: 'u', status: 403, ok: false, walled: true }), { kind: 'walled', status: 403 });
  assert.deepEqual(verdictOf({ url: 'u', status: 0, ok: false, tls: 'CERT_HAS_EXPIRED', code: 'CERT_HAS_EXPIRED' }), { kind: 'tls', code: 'CERT_HAS_EXPIRED' });
  assert.deepEqual(verdictOf({ url: 'u', status: 0, ok: false, error: 'timeout' }), { kind: 'unreachable', error: 'timeout' });
  assert.deepEqual(verdictOf({ url: 'u', status: 0, ok: false, error: 'x', code: 'ENOTFOUND' }), { kind: 'dead', status: 0 });

  const probe = async url => ({ url, status: url.includes('wall') ? 429 : 0, ok: false, ...(url.includes('wall') ? { walled: true } : { error: 'timeout' }) });
  const audit = await auditLinks(
    [{ path: '/a', content: [{ id: '1', type: 'content', text: '<a href="https://wall.test/">w</a><a href="https://slow.test/">s</a>' }] }],
    { livePaths: new Set(['/a']), probe },
  );
  assert.deepEqual(audit.brokenExternal, []);
  assert.deepEqual(audit.unverifiableExternal.map(b => b.verdict.kind).sort(), ['unreachable', 'walled']);
});
