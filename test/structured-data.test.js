import { test } from 'node:test';
import assert from 'node:assert/strict';
import { articleLd, collectionLd, citationsFromReferences } from 'wiki-formant/metadata';

const site = { '@id': 'https://example.org/#organization' };

test('an article always carries its image, canonical entity and ISO dates', () => {
  const ld = articleLd({
    headline: 'Reading a point code',
    url: 'https://example.org/wiki/a',
    image: 'https://example.org/og.png',
    published: '2026-09-01',
    modified: new Date('2026-09-19T08:00:00Z'),
    publisher: site,
  });
  assert.equal(ld['@context'], 'https://schema.org');
  assert.equal(ld['@type'], 'Article');
  assert.equal(ld.image, 'https://example.org/og.png');
  assert.deepEqual(ld.mainEntityOfPage, { '@type': 'WebPage', '@id': 'https://example.org/wiki/a' });
  assert.equal(ld.datePublished, '2026-09-01T00:00:00.000Z');
  assert.equal(ld.dateModified, '2026-09-19T08:00:00.000Z');
  assert.equal(ld.inLanguage, 'en');
  assert.equal('citation' in ld, false);
  assert.equal('author' in ld, false);
});

test('extra is spread last, so a wiki can add what only it states', () => {
  const ld = articleLd({ type: 'TechArticle', headline: 'h', url: 'u', image: 'i', publisher: site, extra: { wordCount: 12 } });
  assert.equal(ld['@type'], 'TechArticle');
  assert.equal(ld.wordCount, 12);
});

test('a collection lists its items and counts every one past the cap', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ name: `P${i}`, url: `https://example.org/p${i}` }));
  const ld = collectionLd({ name: 'Safety', url: 'https://example.org/wiki/safety', items, max: 3 });
  assert.equal(ld.mainEntity.numberOfItems, 5);
  assert.equal(ld.mainEntity.itemListElement.length, 3);
  assert.deepEqual(ld.mainEntity.itemListElement[0], { '@type': 'ListItem', position: 1, name: 'P0', url: 'https://example.org/p0' });
});

test('citations are read off references: tags out, entities decoded, empties dropped', () => {
  const out = citationsFromReferences([
    { text: '<em>Deadman</em> &amp; Al-Khafaji,  A Manual', url: 'https://doi.org/x' },
    { text: '<br>' },
    { text: 'Unlinked' },
  ]);
  assert.deepEqual(out, [
    { '@type': 'CreativeWork', name: 'Deadman & Al-Khafaji, A Manual', url: 'https://doi.org/x' },
    { '@type': 'CreativeWork', name: 'Unlinked' },
  ]);
});
