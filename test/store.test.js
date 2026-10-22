import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { wikiStore } from 'wiki-formant/store';
import { searchTsvDdl } from 'wiki-formant/search';

// The tables as `prisma db push` makes them from prisma/wiki.prisma.
const DDL = `
  CREATE TABLE "WikiPage" (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "siteId" text NOT NULL DEFAULT '',
    "tagPath" text NOT NULL DEFAULT '',
    slug text NOT NULL,
    title text NOT NULL,
    content jsonb NOT NULL DEFAULT '[]',
    metadata jsonb NOT NULL DEFAULT '{}',
    version text NOT NULL DEFAULT '1.0.0',
    "authorId" text,
    "lastVerifiedAt" timestamptz(3),
    "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
    "updatedAt" timestamptz(3) NOT NULL DEFAULT now(),
    UNIQUE ("siteId", "tagPath", slug)
  );
  CREATE TABLE "WikiRevision" (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "pageId" text NOT NULL REFERENCES "WikiPage"(id) ON DELETE CASCADE,
    title text NOT NULL,
    content jsonb NOT NULL,
    version text NOT NULL,
    "changeType" text NOT NULL,
    message text,
    "authorId" text,
    "createdAt" timestamptz(3) NOT NULL DEFAULT clock_timestamp()
  );`;

async function db() {
  const pg = new PGlite();
  await pg.exec(DDL);
  const fts = searchTsvDdl('"WikiPage"');
  for (const statement of [...fts.column, fts.index]) await pg.exec(statement);
  const sql = async (query, ...values) => (await pg.query(query, values)).rows;
  return { pg, sql };
}

const para = (id, text) => ({ id, type: 'content', text: `<p>${text}</p>` });

test('a page is created with its first revision, and a save diffs, bumps and records', async () => {
  const { sql } = await db();
  const store = wikiStore({ sql });

  const made = await store.save({ tagPath: 'tech', slug: 'radix-engine', title: 'Radix Engine', content: [para('a', 'Runs blueprints.')], authorId: 'u1' });
  assert.equal(made.created, true);
  assert.equal(made.page.version, '1.0.0');

  const prose = await store.save({ tagPath: 'tech', slug: 'radix-engine', content: [para('a', 'Runs every blueprint.')], authorId: 'u2', message: 'wording' });
  assert.equal(prose.changeType, 'minor');
  assert.equal(prose.page.version, '1.1.0');

  const structure = await store.save({ tagPath: 'tech', slug: 'radix-engine', content: [para('a', 'Runs every blueprint.'), para('b', 'Costs fees.')] });
  assert.equal(structure.changeType, 'major');
  assert.equal(structure.page.version, '2.0.0');

  const meta = await store.save({ tagPath: 'tech', slug: 'radix-engine', metadata: { excerpt: 'The VM.' } });
  assert.equal(meta.changeType, 'none', 'a metadata-only save writes no revision');
  assert.equal(meta.page.version, '2.0.0');
  assert.deepEqual(meta.page.metadata, { excerpt: 'The VM.' });

  const stated = await store.save({ tagPath: 'tech', slug: 'radix-engine', metadata: { excerpt: 'The VM.', state: 1 }, change: 'patch' });
  assert.equal(stated.page.version, '2.0.1', 'a stated change always writes its revision');

  assert.equal((await store.get('tech', 'radix-engine')).revisionCount, 4);
  const history = await store.history(made.page.id);
  assert.deepEqual(history.map(r => r.version), ['2.0.1', '2.0.0', '1.1.0', '1.0.0']);
  assert.equal(history[2].authorId, 'u2');
  assert.equal(history[2].message, 'wording');
  assert.ok(history[2].changes.length > 0, 'what changed is diffed on read');
  assert.equal(history[0].content, undefined, 'entries carry changes, not content');

  assert.equal(history[1].message, '1 block added', 'a save with no message records what the diff found');
  const window = await store.history(made.page.id, { limit: 2 });
  assert.equal(window.length, 2);
  assert.ok(window[1].changes.some(c => c.action === 'added'), 'the oldest shown is diffed against its real predecessor');
});

test('a save that lost a race, or opened an old version, writes nothing', async () => {
  const { sql } = await db();
  const store = wikiStore({ sql });
  await store.save({ tagPath: 'tech', slug: 'x', title: 'X', content: [para('a', 'one')] });
  await store.save({ tagPath: 'tech', slug: 'x', content: [para('a', 'two')] });
  await assert.rejects(
    store.save({ tagPath: 'tech', slug: 'x', content: [para('a', 'three')], baseVersion: '1.0.0' }),
    e => e.status === 409 && /v1\.1\.0/.test(e.message),
  );
  assert.equal((await store.get('tech', 'x')).content[0].text, '<p>two</p>');
});

test('restore puts a revision back as a major change of its own', async () => {
  const { sql } = await db();
  const store = wikiStore({ sql });
  const { page } = await store.save({ tagPath: 'tech', slug: 'x', title: 'X', content: [para('a', 'one')] });
  await store.save({ tagPath: 'tech', slug: 'x', content: [para('a', 'two')] });
  const [, first] = await store.history(page.id);
  const restored = await store.restore('tech', 'x', first.id, { authorId: 'u9' });
  assert.equal(restored.page.version, '2.0.0');
  assert.equal(restored.page.content[0].text, '<p>one</p>');
  assert.equal((await store.history(page.id))[0].message, 'Restored to v1.0.0');
});

test('sites never see each other', async () => {
  const { sql } = await db();
  const a = wikiStore({ sql, siteId: 'a' });
  const b = wikiStore({ sql, siteId: 'b' });
  await a.save({ tagPath: 'docs', slug: 'intro', title: 'Intro A', content: [para('a', 'alpha')] });
  await b.save({ tagPath: 'docs', slug: 'intro', title: 'Intro B', content: [para('a', 'beta')] });
  assert.equal((await a.get('docs', 'intro')).title, 'Intro A');
  assert.equal((await b.list('docs')).length, 1);
  assert.equal((await a.search('beta')).total, 0);
  assert.equal((await b.stats()).pages, 1);
});

test('listings drop the hub and the content, and hidden paths arrive only when named', async () => {
  const { sql } = await db();
  const store = wikiStore({ sql, hidden: ['meta'] });
  await store.save({ tagPath: 'docs', slug: '', title: 'Docs', content: [para('h', 'The hub.')] });
  await store.save({ tagPath: 'docs', slug: 'b', title: 'Bravo', content: [para('a', 'Second page.')] });
  await store.save({ tagPath: 'docs', slug: 'a', title: 'Alpha', content: [para('a', 'First page.')] });
  await store.save({ tagPath: 'docs/deep', slug: 'c', title: 'Charlie', content: [para('a', 'Nested.')] });
  await store.save({ tagPath: 'meta', slug: 'log', title: 'Maintenance log', content: [para('a', 'Every page edited.')] });

  const cards = await store.list('docs');
  assert.deepEqual(cards.map(c => c.title), ['Alpha', 'Bravo']);
  assert.equal(cards[0].content, undefined);
  assert.equal(cards[0].snippet, 'First page.');
  assert.deepEqual((await store.subtree('docs')).map(r => r.title), ['Charlie']);
  assert.ok(!(await store.recent()).some(p => p.tagPath === 'meta'));
  assert.equal((await store.recent({ tagPath: 'meta' })).length, 1);
  assert.equal((await store.search('page')).items.some(i => i.tagPath === 'meta'), false, 'hidden prose is not searched');
  assert.equal((await store.search('maintenance')).total, 0, 'an unscoped search leaves hidden paths out');
  assert.equal((await store.search('maintenance', { tagPath: 'meta' })).total, 1, 'a search scoped to one finds it');
  assert.deepEqual((await store.byIds([cards[1].id, cards[0].id])).map(c => c.title), ['Bravo', 'Alpha']);
});

test('search ranks title prefix, title, prose, then full text with a headline', async () => {
  const { sql } = await db();
  const store = wikiStore({ sql });
  await store.save({ tagPath: 'docs', slug: 'v', title: 'Validators', content: [para('a', 'Nodes that stake.')] });
  await store.save({ tagPath: 'docs', slug: 'r', title: 'Running validators', content: [para('a', 'How to run one.')] });
  await store.save({ tagPath: 'docs', slug: 's', title: 'Staking', content: [para('a', 'Pick validators carefully.')] });
  await store.save({ tagPath: 'docs', slug: 'u', title: 'Uptime', content: [para('a', 'A validator that misses rounds loses rewards.')] });
  await store.save({ tagPath: '', slug: '', title: 'Home', content: [para('a', 'All about validators.')] });
  await store.save({ tagPath: '', slug: 'about', title: 'About', content: [para('a', 'Who runs validators.')] });

  const { items, total } = await store.search('validators');
  assert.equal(total, 5, 'the home page is never a result; a root-level page is');
  assert.deepEqual(items.map(i => i.slug), ['v', 'r', 'about', 's', 'u']);
  assert.deepEqual(items.map(i => i.score), [0, 1, 2, 2, 3]);
  assert.match(items[4].snippet, /validator that misses rounds/, 'a stem match shows where it matched');
  assert.deepEqual((await store.search('validators', { skip: 1, take: 2 })).items.map(i => i.slug), ['r', 'about']);
  assert.equal((await store.search('   ')).total, 0);
});

test('a written summary can stand in for the opening, and articles carry their bodies', async () => {
  const { sql } = await db();
  const store = wikiStore({ sql, snippet: p => String(p.metadata.description ?? '') });
  await store.save({ tagPath: 'docs', slug: 'a', title: 'Needling', content: [para('a', 'Long body.')], metadata: { description: 'The summary.' } });
  assert.equal((await store.list('docs'))[0].snippet, 'The summary.');
  assert.equal((await store.search('needling')).items[0].snippet, 'The summary.', 'a title-only hit falls back to the summary');
  assert.equal((await store.articles('docs'))[0].content[0].text, '<p>Long body.</p>');
});

test('a rename moves the page and refuses a taken slug', async () => {
  const { sql } = await db();
  const store = wikiStore({ sql });
  await store.save({ tagPath: 'docs', slug: 'a', title: 'A', content: [para('a', 'x')] });
  await store.save({ tagPath: 'docs', slug: 'b', title: 'B', content: [para('a', 'y')] });
  await assert.rejects(store.save({ tagPath: 'docs', slug: 'a', newSlug: 'b' }), e => e.status === 409);
  await store.save({ tagPath: 'docs', slug: 'a', newSlug: 'c' });
  assert.equal(await store.get('docs', 'a'), null);
  assert.equal((await store.get('docs', 'c')).title, 'A');
  assert.equal(await store.remove('docs', 'c'), true);
  assert.equal(await store.remove('docs', 'c'), false);
});

test('a branch lists a path and what is under it with its total, and counts leave the back office out', async () => {
  const { sql } = await db();
  const store = wikiStore({ sql, hidden: ['meta', 'meta/log'] });
  for (const [tagPath, slug] of [['', ''], ['tech', ''], ['tech', 'a'], ['tech/core', 'b'], ['meta', 'm'], ['meta/log', 'l'], ['tech/core', 'c']]) {
    await store.save({ tagPath, slug, title: `${tagPath}/${slug}`, content: [para('x', 'Text.')] });
  }
  const all = await store.branch();
  assert.deepEqual(all.items.map(p => `${p.tagPath}/${p.slug}`).sort(), ['tech/', 'tech/a', 'tech/core/b', 'tech/core/c']);
  assert.equal(all.total, 4);
  assert.ok(Array.isArray(all.items[0].content) && typeof all.items[0].snippet === 'string');

  const paged = await store.branch({ tagPath: 'tech', sort: 'title', limit: 2, offset: 2 });
  assert.equal(paged.total, 4);
  assert.deepEqual(paged.items.map(p => p.slug), ['b', 'c']);

  const named = await store.branch({ tagPath: 'meta' });
  assert.deepEqual(named.items.map(p => p.slug), ['m'], 'a hidden path named is listed, its hidden children are not');

  assert.equal((await store.branch({ since: new Date(Date.now() + 60_000) })).total, 0);
  assert.deepEqual(await store.counts(), [{ tagPath: 'tech', pages: 2 }, { tagPath: 'tech/core', pages: 2 }]);

  const found = await store.search('Text', { content: true, take: 1 });
  assert.ok(Array.isArray(found.items[0].content));
  assert.equal((await store.search('Text', { take: 1 })).items[0].content, undefined);
});

test('a path under a hidden one is hidden from every listing, named in the tree or not', async () => {
  const { sql } = await db();
  const store = wikiStore({ sql, hidden: ['ops'] });
  await store.save({ tagPath: 'ops/runs/2026', slug: 'log', title: 'Run log', content: [para('a', 'Sweep notes.')] });
  await store.save({ tagPath: 'tech', slug: 'notes', title: 'Notes', content: [para('a', 'Public notes.')] });
  assert.deepEqual((await store.search('notes')).items.map(p => p.slug), ['notes']);
  assert.deepEqual((await store.recent()).map(p => p.slug), ['notes']);
  assert.deepEqual((await store.corpus()).map(p => p.slug), ['notes']);
  assert.equal(store.isHidden('ops/runs/2026'), true);
  assert.deepEqual((await store.search('run', { tagPath: 'ops/runs/2026' })).items.map(p => p.slug), ['log']);
});

test('a save opened on a page deleted since is a conflict, not a re-creation', async () => {
  const { sql } = await db();
  const store = wikiStore({ sql });
  const { page } = await store.save({ tagPath: 'docs', slug: 'gone', title: 'Gone', content: [para('a', 'x')] });
  await store.remove('docs', 'gone');
  await assert.rejects(
    store.save({ tagPath: 'docs', slug: 'gone', content: [para('a', 'y')], baseVersion: page.version }),
    e => e.status === 409 && /deleted/.test(e.message),
  );
  assert.equal(await store.get('docs', 'gone'), null);
});

test('a slug taken between the check and the write is a 409, not the index error', async () => {
  const { pg, sql } = await db();
  // Another writer claims the slug after the store checked it was free.
  const racing = async (query, ...values) => {
    if (/UPDATE "WikiPage" SET title/.test(query)) {
      await pg.query(`INSERT INTO "WikiPage" ("tagPath", slug, title) VALUES ('docs', 'b', 'Theirs')`);
    }
    return sql(query, ...values);
  };
  const store = wikiStore({ sql: racing });
  await store.save({ tagPath: 'docs', slug: 'a', title: 'A', content: [para('a', 'x')] });
  await assert.rejects(store.save({ tagPath: 'docs', slug: 'a', newSlug: 'b' }), e => e.status === 409);
  assert.equal((await store.get('docs', 'a')).title, 'A');
});

test('a search paged past the end still reports the total', async () => {
  const { sql } = await db();
  const store = wikiStore({ sql });
  await store.save({ tagPath: 'docs', slug: 'v', title: 'Validators', content: [para('a', 'x')] });
  await store.save({ tagPath: 'docs', slug: 'r', title: 'Running validators', content: [para('a', 'y')] });
  assert.deepEqual(await store.search('validators', { skip: 10 }), { items: [], total: 2 });
  assert.deepEqual(await store.search('nothing-here'), { items: [], total: 0 });
});

test("a revision is read only through its own site's page", async () => {
  const { sql } = await db();
  const a = wikiStore({ sql, siteId: 'a' });
  const b = wikiStore({ sql, siteId: 'b' });
  const { page } = await a.save({ tagPath: 'docs', slug: 'x', title: 'X', content: [para('a', 'one')] });
  const [rev] = await a.history(page.id);
  assert.equal((await a.revision(page.id, rev.id)).id, rev.id);
  assert.deepEqual(await b.history(page.id), []);
  assert.equal(await b.revision(page.id, rev.id), null);
});
