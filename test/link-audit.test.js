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
