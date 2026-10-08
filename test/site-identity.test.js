import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteGraphLd, siteRefs, sitePageMetadata, articleLd } from 'wiki-formant/metadata';
import { standardVersionSources } from 'wiki-formant/conformance';

test('the site graph links every node by @id, and pages point at the same ids', () => {
  const g = siteGraphLd({
    name: 'W', url: 'https://w.test/', description: 'd', logo: 'https://w.test/logo.png', sameAs: ['https://x.com/w'],
    searchUrl: 'https://w.test/search?q={search_term_string}',
    api: { description: 'MCP and REST', url: 'https://w.test/api/mcp', documentation: 'https://w.test/llms.txt' },
    organizationExtra: { knowsAbout: ['x'] },
  });
  const [org, site, api] = g['@graph'];
  const refs = siteRefs('https://w.test');
  assert.equal(org['@id'], refs.organization['@id']);
  assert.equal(org.url, 'https://w.test');
  assert.deepEqual(org.logo, { '@type': 'ImageObject', url: 'https://w.test/logo.png' });
  assert.deepEqual(org.knowsAbout, ['x']);
  assert.deepEqual(site.publisher, refs.organization);
  assert.equal(site.potentialAction.target.urlTemplate, 'https://w.test/search?q={search_term_string}');
  assert.equal(api['@type'], 'WebAPI');
  assert.equal(api.name, 'W API');
  assert.deepEqual(api.provider, refs.organization);
});

test('BUG: a trailing slash does not mint a second publisher', () => {
  // One site wrote its publisher four times, and one copy had the URL with a slash.
  assert.deepEqual(siteRefs('https://w.test/'), siteRefs('https://w.test'));
  const a = articleLd({ headline: 'h', url: 'https://w.test/a', image: 'https://w.test/og', publisher: siteRefs('https://w.test/').organization });
  assert.equal(a.publisher['@id'], 'https://w.test/#organization');
});

test('BUG: the site card carries its name, locale and handle on every page', () => {
  // Next drops them from any page that sets its own card; one site passed them
  // by hand at six call sites and never passed the locale.
  const card = sitePageMetadata({ siteName: 'W', handle: '@w' });
  const m = card({ title: 't', url: 'https://w.test/t', image: 'https://w.test/og' });
  assert.equal(m.openGraph.siteName, 'W');
  assert.equal(m.openGraph.locale, 'en_US');
  assert.equal(m.twitter.site, '@w');
  assert.equal(m.openGraph.images[0].width, 1200);
});

test('the standard version sources cover every descriptor and every OpenAPI path', () => {
  const s = standardVersionSources({ base: 'https://w.test', endpoint: 'https://w.test/api/mcp' }, ['/openapi.json', '/api/openapi.json']);
  assert.deepEqual(Object.keys(s).sort(), ['card', 'legacyCard', 'mcpManifest', 'openapi:/api/openapi.json', 'openapi:/openapi.json', 'serverCard']);
  assert.equal(s.serverCard.url, 'https://w.test/api/mcp/server-card');
  assert.equal(s['openapi:/openapi.json'].at({ info: { version: '1.2.0' } }), '1.2.0');
});
