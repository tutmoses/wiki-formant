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
