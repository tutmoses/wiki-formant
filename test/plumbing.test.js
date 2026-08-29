import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corpusEtag, notModified, textHeaders, markdownHeaders, cleanSnippet, pageLine } from '../dist/http.js';
import { parsePagination, paginatedResponse, toOffset } from '../dist/pagination.js';
import { parseVersion, formatVersion, bump, compareVersions } from '../dist/versioning.js';

test('an ETag is stable for the same corpus revision and moves when it changes', () => {
  const a = corpusEtag([349, new Date('2026-08-29T00:00:00Z')]);
  assert.equal(a, corpusEtag([349, new Date('2026-08-29T00:00:00Z')]));
  assert.notEqual(a, corpusEtag([350, new Date('2026-08-29T00:00:00Z')]));
  assert.match(a, /^W\/"/);
});

test('a matching If-None-Match costs a 304, not a corpus rebuild', () => {
  const etag = corpusEtag([1]);
  const lm = 'Sat, 29 Aug 2026 00:00:00 GMT';
  const hit = notModified(new Request('https://x', { headers: { 'if-none-match': etag } }), etag, lm);
  assert.equal(hit.status, 304);
  assert.equal(hit.headers.get('etag'), etag);
  assert.equal(notModified(new Request('https://x'), etag, lm), null);
  assert.equal(
    notModified(new Request('https://x', { headers: { 'if-none-match': 'W/"stale"' } }), etag, lm),
    null,
  );
});

test('If-Modified-Since is honoured when no ETag was sent', () => {
  const lm = 'Sat, 29 Aug 2026 00:00:00 GMT';
  const res = notModified(new Request('https://x', { headers: { 'if-modified-since': lm } }), 'W/"e"', lm);
  assert.equal(res.status, 304);
});

test('text and markdown exports declare different content types', () => {
  assert.match(textHeaders('W/"e"', 'x')['Content-Type'], /text\/plain/);
  assert.match(markdownHeaders('x')['Content-Type'], /text\/markdown/);
  assert.match(textHeaders('W/"e"', 'x', 60)['Cache-Control'], /s-maxage=60.*stale-while-revalidate=1440/);
});

test('a snippet loses URLs and stays one line', () => {
  assert.equal(cleanSnippet('See (https://x.com/a) the  point https://y.com now'), 'See the point now');
  assert.equal(cleanSnippet('a'.repeat(200)).length, 160);
});

test('a page line links, excerpts and dates', () => {
  assert.equal(
    pageLine({ title: 'LI04', url: 'https://x/p', excerpt: 'Hegu.', updated: new Date('2026-08-29T00:00:00Z') }),
    '- [LI04](https://x/p): Hegu. _(updated 2026-08-29)_',
  );
  assert.equal(pageLine({ title: 'T', url: 'u' }), '- [T](u)');
});

test('pagination clamps both ends and never trusts the query string', () => {
  const p = new URLSearchParams('page=-3&pageSize=9999');
  assert.deepEqual(parsePagination(p), { page: 1, pageSize: 100 });
  assert.deepEqual(parsePagination(new URLSearchParams('page=junk')), { page: 1, pageSize: 20 });
  assert.deepEqual(parsePagination(new URLSearchParams(''), { pageSize: 50 }), { page: 1, pageSize: 50 });
});

test('the paginated response always carries totalPages', () => {
  // Dropping this field is a breaking change to every client that pages.
  const r = paginatedResponse(['a'], 45, 2, 20);
  assert.deepEqual(Object.keys(r).sort(), ['items', 'page', 'pageSize', 'total', 'totalPages']);
  assert.equal(r.totalPages, 3);
});

test('toOffset derives skip/take from the same clamped pair', () => {
  assert.deepEqual(toOffset({ page: 3, pageSize: 20 }), { skip: 40, take: 20 });
});

test('versions parse tolerantly and bump correctly', () => {
  assert.deepEqual(parseVersion(null), { major: 1, minor: 0, patch: 0 });
  assert.deepEqual(parseVersion('2.4'), { major: 2, minor: 4, patch: 0 });
  assert.deepEqual(parseVersion('junk'), { major: 1, minor: 0, patch: 0 });
  assert.equal(formatVersion({ major: 1, minor: 2, patch: 3 }), '1.2.3');
  assert.equal(bump('1.2.3', 'major'), '2.0.0');
  assert.equal(bump('1.2.3', 'minor'), '1.3.0');
  assert.equal(bump('1.2.3', 'patch'), '1.2.4');
  assert.equal(bump('1.2.3', 'none'), '1.2.3');
});

test('versions compare by precedence, not by string', () => {
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
});
