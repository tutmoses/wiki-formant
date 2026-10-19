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

  const { items, total } = await store.search('validators');
  assert.equal(total, 4);
  assert.deepEqual(items.map(i => i.slug), ['v', 'r', 's', 'u']);
  assert.deepEqual(items.map(i => i.score), [0, 1, 2, 3]);
  assert.match(items[3].snippet, /validator that misses rounds/, 'a stem match shows where it matched');
  assert.deepEqual((await store.search('validators', { skip: 1, take: 2 })).items.map(i => i.slug), ['r', 's']);
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
