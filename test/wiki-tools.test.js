import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { wikiStore } from 'wiki-formant/store';
import { createTree } from 'wiki-formant/tree';
import { createTaxonomy } from 'wiki-formant/taxonomy';
import { categoryView } from 'wiki-formant/category';
import { wikiReadTools } from 'wiki-formant/wiki-tools';
import { searchTsvDdl } from 'wiki-formant/search';

const DDL = `
  CREATE TABLE "WikiPage" (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text, "siteId" text NOT NULL DEFAULT '', "tagPath" text NOT NULL DEFAULT '',
    slug text NOT NULL, title text NOT NULL, content jsonb NOT NULL DEFAULT '[]', metadata jsonb NOT NULL DEFAULT '{}',
    version text NOT NULL DEFAULT '1.0.0', "authorId" text, "lastVerifiedAt" timestamptz(3),
    "createdAt" timestamptz(3) NOT NULL DEFAULT now(), "updatedAt" timestamptz(3) NOT NULL DEFAULT now(),
    UNIQUE ("siteId", "tagPath", slug));
  CREATE TABLE "WikiRevision" (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text, "pageId" text NOT NULL REFERENCES "WikiPage"(id) ON DELETE CASCADE,
    title text NOT NULL, content jsonb NOT NULL, version text NOT NULL, "changeType" text NOT NULL, message text, "authorId" text,
    "createdAt" timestamptz(3) NOT NULL DEFAULT clock_timestamp());`;

const nodes = [
  { slug: 'tech', name: 'Tech', description: 'How it works', children: [
    { slug: 'core', name: 'Core', metadataKeys: [{ key: 'kind', label: 'Kind', type: 'select' }] },
    { slug: 'ops', name: 'Ops', hidden: true },
  ] },
];

async function wiki() {
  const pg = new PGlite();
  await pg.exec(DDL);
  const fts = searchTsvDdl('"WikiPage"');
  for (const statement of [...fts.column, fts.index]) await pg.exec(statement);
  const sql = async (query, ...values) => (await pg.query(query, values)).rows;
  const tree = createTree(nodes);
  const store = wikiStore({ sql, hidden: tree.hiddenPaths });
  const para = text => [{ id: 'p', type: 'content', text: `<p>${text}</p>` }];
  await store.save({ tagPath: 'tech', slug: '', title: 'Tech', content: para('The hub.') });
  await store.save({ tagPath: 'tech', slug: 'engine', title: 'Engine', content: para('Runs blueprints.') });
  for (const [slug, kind] of [['alpha', 'x'], ['beta', 'y'], ['gamma', 'x']]) {
    await store.save({ tagPath: 'tech/core', slug, title: slug[0].toUpperCase() + slug.slice(1), content: para(`About ${slug}.`), metadata: { kind } });
  }
  await store.save({ tagPath: 'tech/ops', slug: 'log', title: 'Log', content: para('Back office.') });
  return { store, tree };
}

const text = blocks => blocks.map(b => b.text.replace(/<[^>]+>/g, '')).join('\n');

const call = async (tools, name, args = {}) => tools.find(t => t.name === name).handler(args, {});

test('a category view counts, narrows by facet and lists each visible section', async () => {
  const { store, tree } = await wiki();
  const taxonomy = createTaxonomy({ getMetadataKeys: p => tree.metadataKeys(p), alphaIndexMinPages: 2 });
  const top = await categoryView({ tree, taxonomy, pages: store }, 'tech', {});
  assert.equal(top.total, 1);
  assert.deepEqual(top.sections.map(s => [s.name, s.total, s.links.map(l => l.href)]), [['Core', 3, ['/tech/core/alpha', '/tech/core/beta', '/tech/core/gamma']]]);

  const core = await categoryView({ tree, taxonomy, pages: store }, 'tech/core', { kind: 'x', sort: 'title' });
  assert.deepEqual(core.pages.map(p => p.slug), ['alpha', 'gamma']);
  assert.equal(core.total, 3);
  assert.equal(core.sortable, true);
  assert.ok(core.clearHref);
  assert.equal(core.facets.length, 1);
});

test('the read tools search, read, batch, list, count and slice over the store', async () => {
  const { store, tree } = await wiki();
  const tools = wikiReadTools({ store, tree, text, url: (t, s) => `https://w.test/${[t, s].filter(Boolean).join('/')}`, noun: 'the test wiki', corpusTitle: 'Test Wiki', pathPrefix: '/wiki' });
  assert.deepEqual(tools.map(t => t.name), ['search_wiki', 'get_page', 'get_pages', 'list_pages', 'get_categories', 'get_recent_changes', 'get_full_corpus', 'get_page_history']);

  const found = await call(tools, 'search_wiki', { query: 'blueprints' });
  assert.equal(found.pages[0].path, 'tech/engine');
  assert.equal(found.pages[0].chars, 'Runs blueprints.'.length);

  const page = await call(tools, 'get_page', { path: 'https://w.test/wiki/tech/engine' });
  assert.equal(page.content, 'Runs blueprints.');
  assert.equal(page.version, '1.0.0');
  assert.equal((await call(tools, 'get_page', { path: 'tech' })).title, 'Tech', 'a category path reads its hub');
  assert.equal((await call(tools, 'get_page', { path: 'tech/ops/log' })).title, 'Log', 'an unlisted page still reads by path');
  await assert.rejects(call(tools, 'get_page', { path: 'tech/engin' }), e => Array.isArray(e.details.didYouMean));

  const batch = await call(tools, 'get_pages', { paths: ['tech/engine', 'tech/nope'] });
  assert.equal(batch.returned, 1);
  assert.deepEqual(batch.missing, ['tech/nope']);

  const listed = await call(tools, 'list_pages', { tagPath: 'tech', sort: 'title' });
  assert.deepEqual(listed.pages.map(p => p.path), ['tech/core/alpha', 'tech/core/beta', 'tech/engine', 'tech/core/gamma', 'tech']);
  assert.equal(listed.total, 5);

  const cats = await call(tools, 'get_categories');
  assert.equal(cats.totalPages, 5);
  assert.deepEqual(cats.categories.map(c => [c.path, c.pageCount, c.pageCountDeep, c.children.map(k => k.path)]), [['tech', 2, 5, ['tech/core']]]);

  const recent = await call(tools, 'get_recent_changes', { limit: 2 });
  assert.equal(recent.truncated, true);
  const corpus = await call(tools, 'get_full_corpus', { sizeOnly: true });
  assert.equal(corpus.totalPages, 5);

  const closed = wikiReadTools({ store, tree, text, url: () => '', noun: 'x', corpusTitle: 'x', privateHidden: true });
  await assert.rejects(call(closed, 'get_page', { path: 'tech/ops/log' }));
  assert.equal((await call(closed, 'list_pages', { tagPath: 'tech/ops' })).total, 0);
});

test('a category link carries its sort only when it is not the default, and a letter is read in either case', async () => {
  const { store, tree } = await wiki();
  const taxonomy = createTaxonomy({ getMetadataKeys: p => tree.metadataKeys(p), alphaIndexMinPages: 2 });
  const lettered = await categoryView({ tree, taxonomy, pages: store }, 'tech/core', { letter: 'a' });
  assert.equal(lettered.letter, 'A');
  assert.equal(lettered.clearHref, '/tech/core');
  const plain = await categoryView({ tree, taxonomy, pages: store }, 'tech/core', {});
  assert.ok(plain.facets[0].options.every(v => !v.href.includes('sort=')), 'title is this category\'s default');
  const recent = await categoryView({ tree, taxonomy, pages: store }, 'tech/core', { sort: 'recent' });
  assert.ok(recent.facets[0].options.every(v => v.href.includes('sort=recent')));
  assert.equal(recent.sortHref('title'), '/tech/core');
});

test('get_page with blocks returns what an edit starts from, rows carry the id, and history reads by path', async () => {
  const { store, tree } = await wiki();
  const tools = wikiReadTools({
    store, tree, text, url: () => '', noun: 'x', corpusTitle: 'x',
    forEdit: p => ({ kind: p.metadata.kind ?? null }),
    authors: async ids => new Map(ids.map(id => [id, `name of ${id}`])),
  });
  assert.ok(tools.some(t => t.name === 'get_page_history'));
  const schema = tools.find(t => t.name === 'search_wiki').inputSchema.properties.pageSize;
  assert.deepEqual([schema.minimum, schema.maximum], [1, 50]);

  const row = (await call(tools, 'list_pages', { tagPath: 'tech/core', sort: 'title' })).pages[0];
  const stored = await store.get('tech/core', 'alpha');
  assert.equal(row.id, stored.id);

  const prose = await call(tools, 'get_page', { path: 'tech/core/alpha' });
  assert.equal(prose.content, 'About alpha.');
  const edit = await call(tools, 'get_page', { path: 'tech/core/alpha', blocks: true });
  assert.deepEqual(edit.content, stored.content);
  assert.deepEqual(edit.metadata, { kind: 'x' });
  assert.equal(edit.id, stored.id);
  assert.equal(edit.version, stored.version);
  assert.equal(edit.kind, 'x');

  await store.save({ tagPath: 'tech/core', slug: 'alpha', content: [{ id: 'p', type: 'content', text: '<p>About alpha, revised.</p>' }], authorId: 'u1', baseVersion: edit.version });
  const history = await call(tools, 'get_page_history', { path: 'tech/core/alpha', limit: 1 });
  assert.equal(history.revisions.length, 1);
  assert.equal(history.currentVersion, history.revisions[0].version);
  assert.equal(history.revisions[0].author, 'name of u1');
  assert.ok(history.revisions[0].changes.length);
  assert.equal(history.revisions[0].pageId, undefined);
  assert.equal((await call(tools, 'get_page_history', { path: 'tech' })).revisions.length, 1, 'a category path reads its hub');
  await assert.rejects(call(tools, 'get_page_history', { path: 'tech/core/alfa' }), e => Array.isArray(e.details.didYouMean));
});

test('page text reads lists through the app resolver, as its twin does; blocks stay as stored', async () => {
  const { store, tree } = await wiki();
  const list = [{ id: 'l', type: 'recentPages', limit: 2 }];
  await store.save({ tagPath: 'tech', slug: 'index', title: 'Index', content: list });
  // The app's resolver fills the list; its text prints what was filled in.
  const resolve = async blocks => blocks.map(b => (b.type === 'recentPages' ? { ...b, resolvedPages: [{ title: 'Alpha' }, { title: 'Beta' }] } : b));
  const listText = blocks => blocks.map(b => (b.type === 'recentPages' ? (b.resolvedPages ?? []).map(p => `- ${p.title}`).join('\n') || '(live list)' : text([b]))).join('\n');
  const tools = wikiReadTools({ store, tree, text: listText, resolve, url: () => '', noun: 'x', corpusTitle: 'x' });

  assert.equal((await call(tools, 'get_page', { path: 'tech/index' })).content, '- Alpha\n- Beta');
  assert.equal((await call(tools, 'get_pages', { paths: ['tech/index'] })).pages[0].content, '- Alpha\n- Beta');
  assert.deepEqual((await call(tools, 'get_page', { path: 'tech/index', blocks: true })).content, list);
  assert.match((await call(tools, 'get_full_corpus', { tagPath: 'tech' })).document, /- Alpha\n- Beta/);

  const unresolved = wikiReadTools({ store, tree, text: listText, url: () => '', noun: 'x', corpusTitle: 'x' });
  assert.equal((await call(unresolved, 'get_page', { path: 'tech/index' })).content, '(live list)');
});
