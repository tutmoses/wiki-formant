import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeSummary, classifyChanges, computeRevisionDiff, diffBlocks, extractBlocks } from '../dist/revisions.js';

const containers = (b) =>
  b.type === 'infobox' ? [{ path: 'blocks', blocks: b.blocks }]
  : b.type === 'columns' ? b.columns.map((c, i) => ({ path: `columns.${i}.blocks`, blocks: c.blocks }))
  : null;

const text = (id, t) => ({ id, type: 'content', text: t });
const opts = { containers };

test('paths address a block the way a reviewing UI anchors on it', () => {
  const tree = [
    text('a', 'one'),
    { id: 'c', type: 'columns', columns: [{ id: 'l', blocks: [text('b', 'two')] }] },
    { id: 'i', type: 'infobox', blocks: [text('d', 'three')] },
  ];
  assert.deepEqual(extractBlocks(tree, containers).map(x => x.path), [
    'root.0', 'root.1', 'root.1.columns.0.blocks.0', 'root.2', 'root.2.blocks.0',
  ]);
});

test('a block that moved is one move, not a removal plus an addition', () => {
  const before = [text('a', 'one'), text('b', 'two')];
  const after = [text('b', 'two'), text('a', 'one')];
  const changes = diffBlocks(before, after, opts);
  assert.equal(changes.length, 2);
  assert.ok(changes.every(c => c.action === 'moved'));
  assert.deepEqual(changes[0].attributes.position, { from: 'root.0', to: 'root.1' });
});

test('additions, removals and edits are told apart', () => {
  const changes = diffBlocks([text('a', 'one'), text('b', 'two')], [text('a', 'ONE'), text('c', 'three')], opts);
  const by = (action) => changes.filter(c => c.action === action);
  assert.equal(by('modified').length, 1);
  assert.deepEqual(by('modified')[0].attributes.text, { from: 'one', to: 'ONE' });
  assert.deepEqual(by('removed').map(c => c.id), ['b']);
  assert.deepEqual(by('added').map(c => c.id), ['c']);
});

test('BUG: a container is not "modified" every time its children move', () => {
  // `blocks` and `columns` are walked as their own entries. Comparing them as
  // attributes too would report the infobox itself as edited whenever anything
  // inside it changed, and bump a prose edit to a structural one.
  const before = [{ id: 'i', type: 'infobox', blocks: [text('a', 'one')] }];
  const after = [{ id: 'i', type: 'infobox', blocks: [text('a', 'two')] }];
  const changes = diffBlocks(before, after, opts);
  assert.deepEqual(changes.map(c => c.id), ['a']);
  assert.equal(changes[0].action, 'modified');
});

test('leafDiff is asked about every side of a change', () => {
  const leafDiff = (from, to) =>
    (from ?? to).type === 'content' ? { from: from?.text ?? '', to: to?.text ?? '' } : undefined;
  const changes = diffBlocks([text('a', 'one'), text('b', 'gone')], [text('a', 'two'), text('c', 'new')], { containers, leafDiff });
  const find = (id) => changes.find(c => c.id === id);
  assert.deepEqual(find('a').leafDiff, { from: 'one', to: 'two' });
  assert.deepEqual(find('b').leafDiff, { from: 'gone', to: '' });
  assert.deepEqual(find('c').leafDiff, { from: '', to: 'new' });
});

test('with no leafDiff supplied, nothing is recorded', () => {
  const changes = diffBlocks([text('a', 'one')], [text('a', 'two')], opts);
  assert.equal(changes[0].leafDiff, undefined);
});

test('structure is major, prose is minor, a page flag alone is patch', () => {
  const modified = [{ id: 'a', action: 'modified', type: 'content', path: 'root.0' }];
  const added = [{ id: 'a', action: 'added', type: 'content', path: 'root.0' }];
  assert.equal(classifyChanges([], false), 'none');
  assert.equal(classifyChanges(added, false), 'major');
  assert.equal(classifyChanges(modified, false), 'minor');
  assert.equal(classifyChanges([], true), 'minor');
  assert.equal(classifyChanges([], false, true), 'patch');
});

test('the summary counts and pluralises each action', () => {
  const change = (id, action) => ({ id, action, type: 'content', path: 'root.0' });
  assert.equal(changeSummary({ changes: [], titleChanged: false }), 'no changes');
  assert.equal(
    changeSummary({
      changes: [change('a', 'added'), change('b', 'added'), change('c', 'moved')],
      titleChanged: true,
    }),
    'title updated, 2 blocks added, 1 block reordered',
  );
  assert.equal(
    changeSummary({ changes: [], titleChanged: false, metaChanged: true, metaLabel: 'notice' }),
    'notice updated',
  );
});

test('the version comes back bumped by the class of change', () => {
  const diff = computeRevisionDiff({
    currentVersion: '1.4.2',
    oldContent: [text('a', 'one')],
    newContent: [text('a', 'two')],
    oldTitle: 'T', newTitle: 'T',
    containers,
  });
  assert.equal(diff.changeType, 'minor');
  assert.deepEqual(diff.version, { major: 1, minor: 5, patch: 0 });
  assert.equal(diff.summary, '1 block modified');

  const structural = computeRevisionDiff({
    currentVersion: '1.4.2',
    oldContent: [text('a', 'one')],
    newContent: [text('a', 'one'), text('b', 'two')],
    oldTitle: 'T', newTitle: 'T',
    containers,
  });
  assert.equal(structural.changeType, 'major');
  assert.deepEqual(structural.version, { major: 2, minor: 0, patch: 0 });
});

test('a null version still bumps, because a page always has one', () => {
  const diff = computeRevisionDiff({
    currentVersion: null,
    oldContent: [], newContent: [],
    oldTitle: 'a', newTitle: 'b',
    containers,
  });
  assert.deepEqual(diff.version, { major: 1, minor: 1, patch: 0 });
});

test('BUG: a container nested inside another is still exempt from attribute diffing', () => {
  // The exempt keys are derived per block pair, not once from the top level. A
  // columns block that only ever appears inside an infobox would otherwise have
  // its `columns` key compared as an attribute, and be reported as edited every
  // time anything inside one of its columns changed.
  const nested = (t) => [{
    id: 'i', type: 'infobox', blocks: [
      { id: 'c', type: 'columns', columns: [{ id: 'l', blocks: [text('a', t)] }] },
    ],
  }];
  const changes = diffBlocks(nested('one'), nested('two'), opts);
  assert.deepEqual(changes.map(c => c.id), ['a']);
  assert.equal(changes[0].path, 'root.0.blocks.0.columns.0.blocks.0');
});
