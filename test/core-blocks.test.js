import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coreBlockGroups, coreBlockShape, leafBlocks, mapBlockTree, mapBlockTreeAsync, renderBlockTree } from 'wiki-formant/blocks';
import { computeRevisionDiff } from 'wiki-formant/revisions';
import { linkGridToText, pageListToText, statsToText } from 'wiki-formant/text';

const leaf = (id, text) => ({ id, type: 'content', text });
const tree = [
  leaf('a', 'one'),
  { id: 'c', type: 'columns', columns: [{ id: 'l', blocks: [leaf('b', 'two')] }, { id: 'r', blocks: [leaf('d', 'three')] }] },
  { id: 'i', type: 'infobox', blocks: [leaf('e', 'four')] },
];
const shape = coreBlockShape();

test('the core groups address columns and infobox children by path', () => {
  assert.deepEqual(coreBlockGroups(tree[1]).map(g => g.path), ['columns.0.blocks', 'columns.1.blocks']);
  assert.deepEqual(coreBlockGroups(tree[2]).map(g => g.path), ['blocks']);
  assert.equal(coreBlockGroups(tree[0]), null);
  // A column saved without `blocks` reads as empty rather than throwing.
  assert.deepEqual(coreBlockGroups({ id: 'x', type: 'columns', columns: [{ id: 'y' }] })[0].blocks, []);
});

test('a transform through the core shape keeps the tree shape and the column ids', () => {
  const upper = mapBlockTree(tree, b => ({ ...b, text: b.text.toUpperCase() }), shape);
  assert.equal(upper[1].columns[1].id, 'r');
  assert.equal(upper[1].columns[1].blocks[0].text, 'THREE');
  assert.equal(upper[2].blocks[0].text, 'FOUR');
});

test('leaves come out in document order', () => {
  assert.deepEqual(leafBlocks(tree, shape.containers).map(b => b.id), ['a', 'b', 'd', 'e']);
  assert.equal(renderBlockTree(tree, { atomic: b => b.text, containers: shape.containers }), 'one\n\ntwo\n\nthree\n\nfour');
});

test('a revision diff walks the core containers without being told how', () => {
  const next = structuredClone(tree);
  next[1].columns[1].blocks[0].text = 'THREE';
  const diff = computeRevisionDiff({ currentVersion: '1.0.0', oldContent: tree, newContent: next, oldTitle: 't', newTitle: 't' });
  assert.deepEqual(diff.changes.map(c => c.path), ['root.1.columns.1.blocks.0']);
});

test('stats, link grids and page lists have prose bodies', () => {
  assert.equal(statsToText([{ value: 99, suffix: '%', label: 'Uptime' }, { value: '1M', label: 'TVL' }]), '99% Uptime\n1M TVL');
  assert.equal(
    linkGridToText([{ heading: 'Docs', description: '<p>Start <b>here</b></p>', links: [{ label: 'Guide', href: '/guide' }] }], 'Intro'),
    'Intro\n\nDocs\nStart here\n- Guide (/guide)',
  );
  assert.equal(pageListToText([{ title: 'A' }, { title: 'B' }]), 'A\nB');
});

test('every walk reaches a container nested inside another', () => {
  const nested = [{ id: 'i', type: 'infobox', blocks: [{ id: 'c', type: 'columns', columns: [{ id: 'l', blocks: [leaf('x', 'deep')] }] }] }];
  const seen = [];
  const out = mapBlockTree(nested, b => { seen.push(b.type); return { ...b, text: 'DEEP' }; }, shape);
  assert.deepEqual(seen, ['content']);
  assert.equal(out[0].blocks[0].columns[0].blocks[0].text, 'DEEP');
  assert.equal(renderBlockTree(nested, { atomic: b => b.text ?? '', containers: shape.containers }), 'deep');
});

test('the async walk recurses too', async () => {
  const nested = [{ id: 'i', type: 'infobox', blocks: [{ id: 'c', type: 'columns', columns: [{ id: 'l', blocks: [leaf('x', 'deep')] }] }] }];
  const out = await mapBlockTreeAsync(nested, async b => ({ ...b, text: b.text.toUpperCase() }), shape);
  assert.equal(out[0].blocks[0].columns[0].blocks[0].text, 'DEEP');
});

// ---- the core leaf helpers --------------------------------------------------

import { coreAtomicText, coreAtomicToMarkdown, coreBlockDefaults } from 'wiki-formant/blocks';
import { coreAtomicValidator, blockLimit, MAX_BLOCK_ROWS } from 'wiki-formant/validation';
import { pgPoolConfig } from 'wiki-formant/db';

const pages = [{ title: 'Alpha', href: '/wiki/a' }, { title: 'Beta', href: 'https://elsewhere.test/b' }];

test('coreAtomicText reads every core leaf, and an unresolved list as nothing', () => {
  assert.equal(coreAtomicText({ type: 'content', text: '<p>Hi &amp; bye</p>' }), 'Hi & bye');
  assert.equal(coreAtomicText({ type: 'banner', variant: 'stub' }), '[Notice: Stub]');
  assert.equal(coreAtomicText({ type: 'banner', variant: 'mystery', text: 'x' }), '[Notice: mystery] x');
  assert.equal(coreAtomicText({ type: 'pageList', resolvedPages: pages }), 'Alpha\nBeta');
  assert.equal(coreAtomicText({ type: 'recentPages' }), '');
  assert.equal(coreAtomicText({ type: 'codeTabs', tabs: [{ label: 'Rust', code: 'Vec<u8>' }] }), '[Rust]\nVec<u8>');
});

test('coreAtomicToMarkdown makes site-relative page links absolute and keeps a stored title', () => {
  const opts = { siteUrl: 'https://site.test' };
  assert.equal(
    coreAtomicToMarkdown({ type: 'recentPages', resolvedPages: pages }, opts),
    '- [Alpha](https://site.test/wiki/a)\n- [Beta](https://elsewhere.test/b)',
  );
  assert.equal(coreAtomicToMarkdown({ type: 'pageList' }, opts), '');
  const items = [{ text: 'A source', url: 'https://s.test' }];
  assert.match(coreAtomicToMarkdown({ type: 'references', items }, opts), /^### References\n/);
  assert.match(coreAtomicToMarkdown({ type: 'references', items }, { ...opts, referencesTitle: 'Sources' }), /^### Sources\n/);
  assert.match(coreAtomicToMarkdown({ type: 'references', title: 'Reading', items }, { ...opts, referencesTitle: 'Sources' }), /^### Reading\n/);
  assert.equal(coreAtomicToMarkdown({ type: 'banner', variant: 'unsourced' }, opts), '> **[Needs citations]**');
  assert.equal(coreAtomicToMarkdown({ type: 'content', text: '<p>One</p>' }, opts), 'One');
});

test('coreBlockDefaults makes fresh ids per insert and takes a wiki own labels', () => {
  let n = 0;
  const d = coreBlockDefaults({ newId: () => `id${n++}`, referencesTitle: 'Sources', codeTabs: [{ label: 'SQL', language: 'sql' }] });
  assert.deepEqual(d.columns().columns.map(c => c.id), ['id0', 'id1']);
  assert.deepEqual(d.codeTabs(), { type: 'codeTabs', tabs: [{ label: 'SQL', language: 'sql', code: '' }] });
  assert.equal(d.references().title, 'Sources');
  assert.deepEqual(d.stats().items.map(i => i.label), ['Customers', 'Revenue', 'Uptime']);
  assert.notEqual(d.stats().items[0].id, d.stats().items[0].id);
  assert.deepEqual(coreBlockDefaults().codeTabs().tabs.map(t => t.language), ['rust', 'typescript']);
  assert.deepEqual(d.banner(), { type: 'banner', variant: 'stub' });
});

test('coreAtomicValidator caps rows, checks ids the wiki way, and rejects a non-core type', () => {
  const ok = coreAtomicValidator();
  assert.equal(ok({ type: 'recentPages', limit: 5 }), true);
  assert.equal(ok({ type: 'recentPages', limit: 2.5 }), false);
  assert.equal(ok({ type: 'recentPages', limit: MAX_BLOCK_ROWS + 1 }), false);
  assert.equal(ok({ type: 'recentPages', limit: 5, tagPath: 3 }), false);
  assert.equal(ok({ type: 'pageList', pageIds: ['clx1', 'method/needling'] }), true);
  assert.equal(ok({ type: 'pageList', pageIds: Array.from({ length: 101 }, (_, i) => String(i)) }), false);
  assert.equal(ok({ type: 'assetPrice' }), false);
  const digits = coreAtomicValidator({ pageId: id => /^\d{1,9}$/.test(id) });
  assert.equal(digits({ type: 'pageList', pageIds: ['12'] }), true);
  assert.equal(digits({ type: 'pageList', pageIds: ['1.5'] }), false);
  assert.equal(ok({ type: 'linkGrid', groups: [{ id: 'g', heading: 'H', links: [{ label: 'x', href: 'javascript:alert(1)' }] }] }), false);
  assert.equal(blockLimit(2.7, 5), 2);
  assert.equal(blockLimit('x', 5), 5);
  assert.equal(blockLimit(1e9, 5), MAX_BLOCK_ROWS);
});

test('pgPoolConfig sizes the pool by the pooler the URL names', () => {
  assert.equal(pgPoolConfig('postgres://u@h:6543/db').max, 10);
  assert.equal(pgPoolConfig('postgres://u@h:5432/db').max, 3);
  assert.deepEqual(pgPoolConfig(undefined), {
    connectionString: undefined,
    max: 3,
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 30000,
  });
});
