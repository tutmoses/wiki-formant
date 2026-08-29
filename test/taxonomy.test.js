import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaxonomy, firstLetter, toggleFilter, defaultHref } from '../dist/taxonomy.js';

const KEYS = {
  ecosystem: [
    { key: 'category', label: 'Category:', type: 'select', options: ['DeFi', 'Gaming', 'NFT'] },
    { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Paused'] },
    { key: 'website', label: 'Website', type: 'url' },
  ],
  flat: [],
};
const tx = createTaxonomy({ getMetadataKeys: p => KEYS[p] ?? [] });

const page = (title, metadata) => ({ title, metadata });
const PAGES = [
  page('Alpha', { category: 'DeFi', status: 'Active' }),
  page('Beta', { category: 'DeFi', status: 'Paused' }),
  page('Gamma', { category: 'Gaming', status: 'Active' }),
  page('$Delta', { category: 'Gaming', status: 'Active' }),
  page('Epsilon', {}),
];

test('facetKeys keeps only select-typed keys', () => {
  assert.deepEqual(tx.facetKeys('ecosystem').map(k => k.key), ['category', 'status']);
  assert.deepEqual(tx.facetKeys('flat'), []);
});

test('facetFilters ignores params the tag path does not declare', () => {
  const f = tx.facetFilters('ecosystem', { category: 'DeFi', bogus: 'x', status: '' });
  assert.deepEqual(f, { category: 'DeFi' });
});

test('facet values are read from the data, not the declared options', () => {
  const pages = [page('A', { category: 'Undeclared' }), page('B', { category: 'AlsoNew' })];
  const [facet] = tx.buildFacets('ecosystem', pages, {});
  assert.deepEqual(facet.values.map(v => v.value).sort(), ['AlsoNew', 'Undeclared']);
});

test('each facet is counted over the set narrowed by every OTHER filter', () => {
  // With category=DeFi active, `status` must still offer both of DeFi's values,
  // and `category` must still offer Gaming — or the reader cannot switch.
  const facets = tx.buildFacets('ecosystem', PAGES, { category: 'DeFi' });
  const byKey = Object.fromEntries(facets.map(f => [f.key, f.values.map(v => v.value)]));
  assert.deepEqual(byKey.status.sort(), ['Active', 'Paused']);
  assert.ok(byKey.category.includes('Gaming'), 'category must stay switchable');
});

test('a single-valued facet hides — unless it is the active one', () => {
  const pages = [page('A', { category: 'DeFi', status: 'Active' }), page('B', { category: 'DeFi', status: 'Paused' })];
  assert.equal(tx.buildFacets('ecosystem', pages, {}).find(f => f.key === 'category'), undefined);
  // Active: it must stay visible, or an infobox row can strand the reader in a
  // narrowed list with nothing to press to widen it.
  const active = tx.buildFacets('ecosystem', pages, { category: 'DeFi' });
  assert.ok(active.some(f => f.key === 'category'));
});

test('label loses a trailing colon', () => {
  const [facet] = tx.buildFacets('ecosystem', PAGES, {});
  assert.equal(facet.label, 'Category');
});

test('alphaIndex buckets non-letters under # and sorts it last', () => {
  const idx = tx.alphaIndex(PAGES, {});
  assert.equal(idx.at(-1).value, '#');
  assert.deepEqual(idx.map(v => v.value), ['A', 'B', 'E', 'G', '#']);
  assert.equal(firstLetter('$Delta'), '#');
  assert.equal(firstLetter('  beta'), 'B');
});

test('filterPages narrows by letter as well as by facet', () => {
  assert.equal(tx.filterPages(PAGES, {}, 'A').length, 1);
  assert.equal(tx.filterPages(PAGES, { status: 'Active' }, 'G').length, 1);
  assert.equal(tx.filterPages(PAGES, {}).length, PAGES.length, 'no filters returns the same set');
});

test('needsAlphaIndex trips at the configured threshold', () => {
  assert.equal(tx.needsAlphaIndex(39), false);
  assert.equal(tx.needsAlphaIndex(40), true);
  const small = createTaxonomy({ getMetadataKeys: () => [], alphaIndexMinPages: 5 });
  assert.equal(small.needsAlphaIndex(5), true);
});

test('rankRelated ranks by shared facets and names the narrowest axis', () => {
  const subject = page('Alpha', { category: 'Gaming', status: 'Active' });
  const siblings = [
    page('Far', { category: 'DeFi', status: 'Paused' }),
    page('Near', { category: 'Gaming', status: 'Active' }),
    page('Mid', { category: 'Gaming', status: 'Paused' }),
  ];
  const { pages, sharedFacet } = tx.rankRelated(subject, siblings, 'ecosystem', 3);
  assert.deepEqual(pages.map(p => p.title), ['Near', 'Mid', 'Far']);
  // `category` declares 3 options, `status` 2 — headline the narrower axis.
  assert.deepEqual(sharedFacet, { key: 'category', value: 'Gaming' });
});

test('rankRelated degrades to a slice when the tag path declares no facets', () => {
  const { pages, sharedFacet } = tx.rankRelated(PAGES[0], PAGES, 'flat', 2);
  assert.equal(pages.length, 2);
  assert.equal(sharedFacet, null);
});

test('toggleFilter is its own off-switch', () => {
  assert.deepEqual(toggleFilter({}, 'a', '1'), { a: '1' });
  assert.deepEqual(toggleFilter({ a: '1' }, 'a', '1'), {});
  assert.deepEqual(toggleFilter({ a: '1' }, 'a', '2'), { a: '2' });
});

test('one href helper carries sort, filters and letter together', () => {
  // The drift this prevents: a sort button built by hand that drops the
  // active filters, which is the tell that a project grew a second helper.
  assert.equal(defaultHref('ecosystem', {}), '/ecosystem');
  assert.equal(
    defaultHref('ecosystem', { sort: 'newest', filters: { category: 'DeFi' }, letter: 'A' }),
    '/ecosystem?sort=newest&category=DeFi&letter=A',
  );
  const mounted = createTaxonomy({
    getMetadataKeys: () => [],
    href: (p, s) => `/wiki/${p}${s.letter ? `?letter=${s.letter}` : ''}`,
  });
  assert.equal(mounted.href('kb', { letter: 'B' }), '/wiki/kb?letter=B');
});

test('the named axis is one the related pages actually share', () => {
  // The heading built from sharedFacet IS the link into the filtered set, so
  // naming an axis the listed pages do not match sends the reader to a page
  // that excludes every one of them.
  const subject = page('Subject', { category: 'Gaming', status: 'Active' });
  const siblings = [page('Sibling', { category: 'DeFi', status: 'Active' })];
  const { sharedFacet } = tx.rankRelated(subject, siblings, 'ecosystem', 5);
  // `category` is narrower (3 options vs 2) but is NOT shared; `status` is.
  assert.deepEqual(sharedFacet, { key: 'status', value: 'Active' });
});

test('no shared axis means no heading link', () => {
  const subject = page('Subject', { category: 'Gaming', status: 'Active' });
  const siblings = [page('Sibling', { category: 'DeFi', status: 'Paused' })];
  const { pages, sharedFacet } = tx.rankRelated(subject, siblings, 'ecosystem', 5);
  assert.equal(pages.length, 1, 'siblings are still listed');
  assert.equal(sharedFacet, null, 'but nothing is claimed about why');
});
