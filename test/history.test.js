import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { historyChanges, textDiff, withChanges } from 'wiki-formant/history';
import { blockLocation } from 'wiki-formant/revisions';
import { RevisionChanges } from 'wiki-formant/react-server';

const text = (id, t) => ({ id, type: 'content', text: t });

test('a text diff strips the markup and says nothing when only the markup changed', () => {
  assert.equal(textDiff('<p>Same words</p>', '<p><strong>Same</strong> words</p>'), undefined);
  assert.deepEqual(textDiff('<p>The cat sat.</p>', '<p>The dog sat.</p>'), [[0, 'The '], [-1, 'cat'], [1, 'dog'], [0, ' sat.']]);
});

test('a rewritten sentence reads as words struck and added, not shared letters', () => {
  const parts = textDiff('Rolling back was refused.', 'The rollback proposal failed.');
  assert.ok(parts.length <= 3, JSON.stringify(parts));
  assert.ok(parts.every(([, t]) => t.length > 2), JSON.stringify(parts));
});

test('kept text is clipped to its ends; struck and added text is not', () => {
  const kept = 'x'.repeat(100);
  const [first, added] = textDiff(kept, `${kept} and more`);
  assert.equal(first[1], `${'x'.repeat(30)}…${'x'.repeat(30)}`);
  assert.deepEqual(added, [1, ' and more']);
});

test('a container is not listed, and the leaf inside it is', () => {
  const before = [{ id: 'i', type: 'infobox', blocks: [text('a', 'one')] }];
  const after = [{ id: 'i', type: 'infobox', blocks: [text('a', 'two')] }];
  const changes = historyChanges(before, after);
  assert.deepEqual(changes.map(c => [c.action, c.id, c.path]), [['modified', 'a', 'root.0.blocks.0']]);
  assert.deepEqual(changes[0].leafDiff, [[-1, 'one'], [1, 'two']]);
});

test('an added or removed prose block carries its whole text; other blocks carry none', () => {
  const added = historyChanges([], [text('a', 'New section'), { id: 's', type: 'stats', items: [] }]);
  assert.deepEqual(added.map(c => [c.id, c.leafDiff]), [['a', [[1, 'New section']]], ['s', undefined]]);
  const removed = historyChanges([text('a', 'Gone')], []);
  assert.deepEqual(removed[0].leafDiff, [[-1, 'Gone']]);
});

test('a block whose type changed is not diffed as prose', () => {
  const changes = historyChanges([text('a', 'one')], [{ id: 'a', type: 'banner', text: 'one', variant: 'info' }]);
  assert.equal(changes[0].leafDiff, undefined);
});

test('leafText reaches a prose field the core model does not name', () => {
  const quote = (id, body) => ({ id, type: 'testimonial', body });
  const changes = historyChanges([quote('q', 'fine')], [quote('q', 'great')], {
    leafText: b => (b.type === 'testimonial' ? b.body : undefined),
  });
  assert.deepEqual(changes[0].leafDiff, [[-1, 'fine'], [1, 'great']]);
});

test('each revision is diffed against the one after it, and loses its content', () => {
  const revisions = [
    { id: 3, content: [text('a', 'draft')] },
    { id: 2, content: [text('a', 'review')] },
    { id: 1, content: [text('a', 'outline')] },
  ];
  const out = withChanges(revisions);
  assert.deepEqual(out.map(r => [r.id, 'content' in r, r.changes[0].action]), [
    [3, false, 'modified'], [2, false, 'modified'], [1, false, 'added'],
  ]);
  assert.deepEqual(out[0].changes[0].leafDiff, [[-1, 'review'], [1, 'draft']]);
});

test('a path reads as positions counted from one', () => {
  assert.equal(blockLocation('root.0'), 'Block 1');
  assert.equal(blockLocation('root.1.columns.0.blocks.2'), 'Block 2 → Column 1 → Block 3');
  assert.equal(blockLocation('root.3.blocks.0'), 'Block 4 → Block 1');
});

test('the change list marks struck and added text for what it is', () => {
  const html = renderToStaticMarkup(createElement(RevisionChanges, {
    changes: historyChanges([text('a', 'The cat sat.')], [text('a', 'The dog sat.')]),
    label: t => (t === 'content' ? 'Text' : t),
  }));
  assert.equal(html,
    '<ul class="revision-changes"><li class="revision-change" data-action="modified">'
    + '<span class="revision-change-action">Modified</span> – Text at Block 1'
    + '<p class="revision-diff"><span>The </span><del>cat</del><ins>dog</ins><span> sat.</span></p></li></ul>');
  assert.equal(renderToStaticMarkup(createElement(RevisionChanges, { changes: [] })), '');
});
