import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corpusEtag, notModified, textHeaders, markdownHeaders, descriptorHeaders, descriptorResponse, cleanSnippet, pageLine } from '../dist/http.js';
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

test('BUG: a route can cap page size below the package maximum', () => {
  // The cap is per-route: a route whose rows are whole pages caps lower than one
  // whose rows are titles. Without `max` the consumer that caps at 50 kept its
  // own clamp, and then disagreed with itself — 50 in the REST route, 100 in the
  // MCP tool beside it, over the same corpus.
  const at = (qs, opts) => parsePagination(new URLSearchParams(qs), opts);
  assert.equal(at('pageSize=80', { max: 50 }).pageSize, 50);
  assert.equal(at('pageSize=80').pageSize, 80);
  assert.equal(at('pageSize=200').pageSize, 100);
  // A default above the cap is the cap, not the default.
  assert.equal(at('', { pageSize: 80, max: 50 }).pageSize, 50);
  // Junk still falls back, and the fallback still respects the cap.
  assert.equal(at('pageSize=banana', { max: 50 }).pageSize, 20);
  assert.equal(at('page=0', { max: 50 }).page, 1);
});

// --- conditional GET, the way real clients send it ---------------------------

const withHeaders = h => new Request('https://x/llms.txt', { headers: h });
const LM = 'Fri, 04 Sep 2026 19:13:04 GMT';

test('If-None-Match matches a list, and weakly', () => {
  const tag = 'W/"abc-1"';
  // A client that holds two revisions sends both. Exact string equality on the
  // whole field value calls this stale and re-renders the corpus.
  assert.equal(notModified(withHeaders({ 'if-none-match': `W/"old-9", ${tag}` }), tag, LM)?.status, 304);
  // A proxy that strips or adds the weak prefix must not cost a full render.
  assert.equal(notModified(withHeaders({ 'if-none-match': '"abc-1"' }), tag, LM)?.status, 304);
  assert.equal(notModified(withHeaders({ 'if-none-match': '*' }), tag, LM)?.status, 304);
  assert.equal(notModified(withHeaders({ 'if-none-match': 'W/"nope"' }), tag, LM), null);
});

test('If-Modified-Since is compared as a date, and ignored beside an ETag', () => {
  const tag = 'W/"abc-1"';
  // Later than the stamp we hold: the client is not behind.
  assert.equal(notModified(withHeaders({ 'if-modified-since': 'Sat, 05 Sep 2026 00:00:00 GMT' }), tag, LM)?.status, 304);
  assert.equal(notModified(withHeaders({ 'if-modified-since': 'Thu, 03 Sep 2026 00:00:00 GMT' }), tag, LM), null);
  // RFC 9110: a present If-None-Match wins outright, even when it does not match.
  assert.equal(
    notModified(withHeaders({ 'if-none-match': 'W/"nope"', 'if-modified-since': LM }), tag, LM),
    null,
  );
});

test('a markdown twin can carry a validator', () => {
  const h = markdownHeaders(LM, { etag: 'W/"page-1"' });
  assert.equal(h.ETag, 'W/"page-1"');
  assert.equal(h['Last-Modified'], LM);
  assert.match(h['Content-Type'], /text\/markdown/);
  // Still optional, for a corpus with no row timestamp to offer.
  assert.equal(markdownHeaders().ETag, undefined);
});

test('a descriptor carries a validator and answers a conditional GET', async () => {
  const card = { name: 'x', version: '1.0.0' };
  const first = descriptorResponse(new Request('https://x/.well-known/agent-card.json'), card);
  const etag = first.headers.get('ETag');
  assert.ok(etag, 'a descriptor must be revalidatable');
  assert.match(first.headers.get('Cache-Control'), /max-age/);
  assert.deepEqual(JSON.parse(await first.text()), card);

  const again = descriptorResponse(
    new Request('https://x/.well-known/agent-card.json', { headers: { 'if-none-match': etag } }),
    card,
  );
  assert.equal(again.status, 304);
  // The tag moves exactly when the document does.
  assert.notEqual(
    descriptorResponse(new Request('https://x/'), { ...card, version: '1.0.1' }).headers.get('ETag'),
    etag,
  );
  assert.match(descriptorHeaders('W/"x"')['Content-Type'], /application\/json/);
});
