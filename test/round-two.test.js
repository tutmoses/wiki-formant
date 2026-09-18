import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchTsvDdl, searchTsvSql } from 'wiki-formant/search';
import { wantsMarkdown, VARY_ACCEPT } from 'wiki-formant/http';
import { freshnessBanner } from 'wiki-formant/freshness';
import { aiCrawlerRules, AGENT_SURFACE_PATHS } from 'wiki-formant/crawlers';
import { mcpManifest, agentCard, descriptorHandler, serverCardHandler } from 'wiki-formant/well-known';
import { ccBy40, openApiLicense } from 'wiki-formant/license';
import { uniqueHeadingId, injectHeadingIds } from 'wiki-formant/headings';
import { bannerVariant } from 'wiki-formant/text';
import { pageMetadata } from 'wiki-formant/metadata';
import { MCP_PROTOCOL_VERSION } from 'wiki-formant/mcp';

test('the tsvector DDL rebuilds the column in two statements and indexes it in a third', () => {
  const ddl = searchTsvDdl('pages');
  assert.deepEqual(ddl.column[0], 'ALTER TABLE pages DROP COLUMN IF EXISTS search_tsv');
  assert.ok(ddl.column[1].includes(searchTsvSql()));
  assert.equal(ddl.index, 'CREATE INDEX IF NOT EXISTS pages_search_tsv_idx ON pages USING GIN (search_tsv)');
});

test('markdown is asked for by format or by Accept, never by default', () => {
  const req = (url, accept = '') => ({ url, headers: new Headers({ accept }) });
  assert.equal(wantsMarkdown(req('https://w.test/api/wiki/a?format=text')), true);
  assert.equal(wantsMarkdown(req('https://w.test/api/wiki/a', 'text/markdown')), true);
  assert.equal(wantsMarkdown(req('https://w.test/api/wiki/a', 'application/json')), false);
  assert.deepEqual(VARY_ACCEPT, { Vary: 'Accept' });
});

test('a stale page gets an outdated banner block, a fresh one none', () => {
  const now = Date.parse('2026-09-18');
  assert.equal(freshnessBanner({ lastVerifiedAt: '2026-09-01' }, now), null);
  const b = freshnessBanner({ lastVerifiedAt: '2025-01-01' }, now);
  assert.equal(b.type, 'banner');
  assert.equal(b.variant, 'outdated');
  assert.match(b.text, /last verified 2025-01-01/);
});

test('every robots group allows the agent surface without being told', () => {
  const rules = aiCrawlerRules({ allow: '/', disallow: ['/api/'] });
  for (const group of rules) for (const p of AGENT_SURFACE_PATHS) assert.ok([group.allow].flat().includes(p), `${group.userAgent} ${p}`);
});

test('the MCP manifest takes versions and tools from the transport and lists titles', () => {
  const m = mcpManifest({
    name: 'W', registryName: 'test.w/w', version: '1.0.0', description: 'd', url: 'https://w.test',
    tools: [{ name: 't', title: 'T', description: 'x', inputSchema: { type: 'object' }, handler: () => {} }],
    extra: { auth: { reads: 'none' } },
  });
  assert.equal(m.mcp.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(m.mcp.endpoint, 'https://w.test/api/mcp');
  assert.deepEqual(m.tools, [{ name: 't', title: 'T', description: 'x', inputSchema: { type: 'object' } }]);
  assert.deepEqual(m.auth, { reads: 'none' });
});

test('every agent card names its spec, server card and licence the same way', () => {
  const license = ccBy40({ siteName: 'W', siteUrl: 'https://w.test' });
  const card = agentCard({ name: 'W', description: 'd', url: 'https://w.test', version: '1', skills: [], license, licenseScope: 'content' });
  assert.equal(card.apiSpecUrl, 'https://w.test/.well-known/openapi.json');
  assert.equal(card.mcpServerCard, 'https://w.test/api/mcp/server-card');
  assert.deepEqual(card.license, { name: license.name, spdx: 'CC-BY-4.0', url: license.url, scope: 'content' });
  assert.deepEqual(openApiLicense(license), { name: license.name, identifier: 'CC-BY-4.0' });
  const none = agentCard({ name: 'W', description: 'd', url: 'https://w.test', version: '1', skills: [], mcpEndpoint: null });
  assert.equal('mcpServerCard' in none, false);
});

test('descriptor handlers answer with a validator and 304 on a match', async () => {
  const get = descriptorHandler({ a: 1 });
  const first = get(new Request('https://w.test/x'));
  const etag = first.headers.get('etag');
  assert.ok(etag);
  assert.equal(get(new Request('https://w.test/x', { headers: { 'If-None-Match': etag } })).status, 304);
  const card = await serverCardHandler({ name: 'test.w/w', version: '1.0.0' })(new Request('https://w.test/api/mcp/server-card')).json();
  assert.equal(card.name, 'test.w/w');
});

test('heading ids dedupe the same way in the injector and anywhere else', () => {
  const used = new Set(['intro', 'intro-2']);
  assert.equal(uniqueHeadingId('intro', used), 'intro-3');
  assert.equal(uniqueHeadingId('', used), '');
  assert.match(injectHeadingIds('<h2>Intro</h2><h2>Intro</h2>'), /id="intro-2"/);
});

test('an unknown banner variant reads as cleanup', () => {
  assert.equal(bannerVariant('stub'), 'stub');
  assert.equal(bannerVariant('nonsense'), 'cleanup');
  assert.equal(bannerVariant('toString'), 'cleanup');
});

test('one input sets canonical, twin, Open Graph and the Twitter card together', () => {
  const m = pageMetadata({
    title: 'T', description: 'D', url: 'https://w.test/a', type: 'article', image: 'https://w.test/og?t=T',
    siteName: 'W', handle: '@w', markdownTwin: true, article: { section: 'S' },
  });
  assert.deepEqual(m.alternates, { canonical: 'https://w.test/a', types: { 'text/markdown': 'https://w.test/a.md' } });
  assert.equal(m.twitter.title, 'T');
  assert.equal(m.twitter.description, 'D');
  assert.deepEqual(m.twitter.images, ['https://w.test/og?t=T']);
  assert.equal(m.openGraph.section, 'S');
  assert.equal(m.openGraph.images[0].width, 1200);
  const bare = pageMetadata({ title: 'T', url: 'https://w.test/b' });
  assert.equal('images' in bare.openGraph, false);
  assert.deepEqual(bare.alternates, { canonical: 'https://w.test/b' });
  // No url, no canonical: a wrong one is worse than none.
  const unplaced = pageMetadata({ title: 'T' });
  assert.equal('alternates' in unplaced, false);
  assert.equal('url' in unplaced.openGraph, false);
});
