import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagPrefixes, treeSitemap } from 'wiki-formant/sitemap';

const d = s => new Date(`2026-10-${s}T00:00:00Z`);
const opts = (sections) => ({
  sections,
  sectionRow: path => ({ url: `/${path}`, priority: 0.8 }),
  pageRow: p => ({ url: `/${p.tagPath}/${p.slug}`, priority: 0.6 }),
});

test('a section is dated by the newest page at or beneath it, and an empty one carries no date', () => {
  const rows = treeSitemap([
    { tagPath: 'a', slug: 'x', updatedAt: d('01') },
    { tagPath: 'a/b', slug: 'y', updatedAt: d('05') },
    { tagPath: 'ab', slug: 'z', updatedAt: d('09') },
  ], opts(['a', 'a/b', 'c']));
  assert.deepEqual(rows.slice(0, 3), [
    { url: '/a', priority: 0.8, lastModified: d('05') },
    { url: '/a/b', priority: 0.8, lastModified: d('05') },
    { url: '/c', priority: 0.8, lastModified: undefined },
  ]);
  assert.deepEqual(rows.slice(3).map(r => [r.url, r.lastModified]), [['/a/x', d('01')], ['/a/b/y', d('05')], ['/ab/z', d('09')]]);
});

test('a hub article dates its section and gets no row of its own', () => {
  const rows = treeSitemap([{ tagPath: 'a', slug: '', updatedAt: d('07') }], opts(['a']));
  assert.deepEqual(rows, [{ url: '/a', priority: 0.8, lastModified: d('07') }]);
});

test('a section whose URL a page holds is served as that page', () => {
  const rows = treeSitemap([
    { tagPath: 'a', slug: 'b', updatedAt: d('02') },
    { tagPath: 'a/b', slug: 'c', updatedAt: d('08') },
  ], opts(['a', 'a/b', 'a']));
  assert.deepEqual(rows.map(r => r.url), ['/a', '/a/b', '/a/b/c']);
  assert.deepEqual(rows[1], { url: '/a/b', priority: 0.6, lastModified: d('02') });
});

test('tag prefixes list every ancestor once', () => {
  assert.deepEqual(tagPrefixes(['a/b/c', 'a/d', '', 'a/b']), ['a', 'a/b', 'a/b/c', 'a/d']);
});
