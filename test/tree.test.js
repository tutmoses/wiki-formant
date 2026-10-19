import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTree, parseWikiPath, isReservedSlug, wikiPath } from 'wiki-formant/tree';

const tree = createTree([
  { slug: '', name: 'Home', hidden: true },
  {
    slug: 'contents', name: 'Contents', metadataKeys: [{ key: 'status', label: 'Status', type: 'select' }],
    children: [
      { slug: 'tech', name: 'Tech', mainArticle: 'contents/tech/radix-engine', children: [{ slug: 'ops', name: 'Operations', hidden: true }] },
      { slug: 'history', name: 'History', sort: 'recent' },
    ],
  },
  { slug: 'blog', name: 'Blog', sort: 'date', xrd: { create: 50_000 } },
], { globalKeys: [{ key: 'quality', label: 'Quality', type: 'select' }] });

test('resolve inherits keys, sort, series and back office down the trail', () => {
  const r = tree.resolve('contents/tech/ops');
  assert.equal(r.valid, true);
  assert.deepEqual(r.trail.map(n => n.slug), ['contents', 'tech', 'ops']);
  assert.deepEqual(r.metadataKeys.map(k => k.key), ['status', 'quality'], 'trail keys first, global keys last');
  assert.equal(r.mainArticle, 'contents/tech/radix-engine');
  assert.equal(r.hidden, true);
  assert.equal(tree.resolve('contents/history').sort, 'recent');
  assert.equal(tree.resolve('contents').sort, 'title');
  assert.equal(tree.resolve('nope').valid, false);
  assert.equal(tree.resolve('').valid, false, 'the home page is not a category');
  assert.equal(tree.node('blog').xrd.create, 50_000, 'extra fields ride on the node');
  assert.deepEqual(tree.hiddenPaths, ['contents/tech/ops']);
  assert.equal(tree.label('contents/made-up'), 'made up');
  assert.deepEqual(tree.crumbs('contents/made-up').map(c => c.linked), [true, false]);
});

test('parseWikiPath reads home, categories, pages and modes', () => {
  assert.deepEqual(parseWikiPath(tree, []), { type: 'home', tagPath: '', slug: '', mode: null });
  assert.deepEqual(parseWikiPath(tree, ['history']), { type: 'home', tagPath: '', slug: '', mode: 'history' });
  assert.deepEqual(parseWikiPath(tree, ['contents', 'history']), { type: 'category', tagPath: 'contents/history', slug: '', mode: null }, 'a category named like a mode is the category');
  assert.deepEqual(parseWikiPath(tree, ['contents', 'history', 'edit']), { type: 'category', tagPath: 'contents/history', slug: '', mode: 'edit' });
  assert.deepEqual(parseWikiPath(tree, ['contents', 'tech', 'radix-engine', 'history']), { type: 'page', tagPath: 'contents/tech', slug: 'radix-engine', mode: 'history' });
  assert.equal(parseWikiPath(tree, ['nope', 'page']).type, 'invalid');
  assert.equal(parseWikiPath(tree, ['orphan']).type, 'invalid');
  assert.equal(parseWikiPath(tree, ['blog', 'edit'], { modes: ['history'] }).slug, 'edit', 'only the modes passed are modes');
});

test('reserved slugs and page paths', () => {
  assert.equal(isReservedSlug(tree, 'contents', 'tech'), true);
  assert.equal(isReservedSlug(tree, 'contents', 'edit'), true);
  assert.equal(isReservedSlug(tree, 'contents', 'staking'), false);
  assert.equal(wikiPath('', ''), '/');
  assert.equal(wikiPath('contents/tech', ''), '/contents/tech');
  assert.equal(wikiPath('blog', 'hello'), '/blog/hello');
});
