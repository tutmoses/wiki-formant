import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceQueues } from 'wiki-formant/queues';
import { citation } from 'wiki-formant/react-server';

const NOW = Date.UTC(2026, 9, 22);
const page = (id, tagPath, slug, content, extra = {}) => ({
  id, title: id, tagPath, slug, content, metadata: {}, updatedAt: new Date(NOW - 86_400_000), lastVerifiedAt: null, ...extra,
});
const href = p => `/${[p.tagPath, p.slug].filter(Boolean).join('/')}`;

test('the queues read links in, links out, age and required facts in one pass', () => {
  const pages = [
    page('a', 'guides', 'a', [{ type: 'content', text: '<p><a href="/guides/b">b</a> <a href="https://x.org">x</a></p>' }]),
    page('b', 'guides', 'b', [{ type: 'content', text: '<p>no links</p>' }], { updatedAt: new Date(NOW - 400 * 86_400_000) }),
    page('c', 'guides', 'c', [{ type: 'list', pages: ['a'] }], { metadata: { status: 'Done' } }),
  ];
  const queues = maintenanceQueues(pages, { href, nowMs: NOW, required: () => [{ key: 'status', label: 'Status:' }], listedIds: c => c.flatMap(b => b.pages ?? []) });
  const by = Object.fromEntries(queues.map(q => [q.key, q.items.map(i => i.title)]));
  assert.deepEqual(by.outdated, ['b']);
  assert.deepEqual(by.orphaned, ['c']);
  assert.deepEqual(by.unsourced, ['b', 'c']);
  assert.deepEqual(by.incomplete, ['a', 'b']);
  assert.match(queues.find(q => q.key === 'incomplete').items[0].detail, /^missing Status$/);
});

test('a wiki that names how to stamp a page says so, and empty queues are dropped', () => {
  const fresh = [page('a', 'g', 'a', [{ type: 'content', text: '<a href="/g/b">b</a> <a href="https://x.org">x</a>' }], { lastVerifiedAt: new Date(NOW - 86_400_000) }),
    page('b', 'g', 'b', [{ type: 'content', text: '<a href="/g/a">a</a> <a href="https://y.org">y</a>' }], { updatedAt: new Date(NOW - 900 * 86_400_000) })];
  const queues = maintenanceQueues(fresh, { href, nowMs: NOW, verify: 'tick Facts checked in the editor' });
  assert.deepEqual(queues.map(q => q.key), ['outdated']);
  assert.match(queues[0].description, /then tick Facts checked in the editor\.$/);
});

test('a citation names the publisher, title, day and address', () => {
  assert.equal(citation({ publisher: 'AcuiQ', title: 'Point codes', date: '2026-10-02T12:00:00Z', url: 'https://acuiq.com/wiki/x' }), 'AcuiQ. "Point codes." October 2, 2026. https://acuiq.com/wiki/x');
});
