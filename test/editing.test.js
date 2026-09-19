import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SortHeader, BlockActions } from 'wiki-formant/react';
import { ToolbarButton, toolbarActions, TOOLBAR_ACTIONS } from 'wiki-formant/editor';

const html = (c, p) => renderToStaticMarkup(createElement(c, p));
const noop = () => {};

test('a sort header is a column header holding a real button', () => {
  const out = html(SortHeader, {
    sortKey: 'date', active: true, direction: 'desc', onSort: noop, 'aria-sort': 'descending',
    className: 'w-36', children: 'Date',
  });
  assert.equal(out, '<th scope="col" class="w-36" aria-sort="descending"><button type="button" class="sort-header">Date</button></th>');
  assert.match(html(SortHeader, { sortKey: 'x', active: false, direction: 'asc', onSort: noop, 'aria-sort': 'none', label: 'Pair', children: '⇅' }), /title="Pair" aria-label="Pair"/);
});

test('block actions name every button and disable the moves at the ends', () => {
  const ops = { move: noop, duplicate: noop, remove: noop };
  const icons = { up: '↑', down: '↓', duplicate: '⧉', remove: '×' };
  const first = html(BlockActions, { index: 0, total: 2, ops, icons, blockLabel: 'Table' });
  assert.match(first, /aria-label="Move Table up" disabled=""/);
  assert.doesNotMatch(first, /aria-label="Move Table down" disabled/);
  assert.match(first, /aria-label="Duplicate Table"/);
  assert.match(first, /aria-label="Delete Table"/);
  const last = html(BlockActions, { index: 1, total: 2, ops, icons: { up: '↑', down: '↓', remove: '×' } });
  assert.match(last, /aria-label="Move down" disabled=""/);
  assert.doesNotMatch(last, /Duplicate/);
});

test('toolbar buttons say what they are and whether they are on', () => {
  assert.equal(
    html(ToolbarButton, { label: 'Code block', pressed: true, onPress: noop, className: 'b', children: 'x' }),
    '<button type="button" title="Code block" aria-label="Code block" aria-pressed="true" class="b">x</button>',
  );
});

test('toolbar actions come back in the caller\'s order, and every one is labelled and runnable', () => {
  assert.deepEqual(toolbarActions(['table', 'bold', 'link']).map(a => a.key), ['table', 'bold', 'link']);
  for (const a of TOOLBAR_ACTIONS) {
    assert.ok(a.label && a.label !== a.key, a.key);
    assert.ok(a.run || a.withUrl, a.key);
  }
  assert.notEqual(TOOLBAR_ACTIONS.find(a => a.key === 'code').label, TOOLBAR_ACTIONS.find(a => a.key === 'codeBlock').label);
});
