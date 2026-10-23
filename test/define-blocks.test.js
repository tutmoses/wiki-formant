import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coreBlockDefaults } from 'wiki-formant/blocks';
import { defineBlocks } from 'wiki-formant/validation';

const model = defineBlocks({
  defaults: { ...coreBlockDefaults(), timeline: () => ({ type: 'timeline', limit: 25 }) },
  checks: {
    timeline: b => Number.isSafeInteger(b.limit),
    list: (b, core) => core(b) && b.under !== 'private',
  },
});

test('the types are the defaults, the containers set apart', () => {
  assert.ok(model.types.includes('timeline'));
  assert.deepEqual(model.atomicTypes.filter(t => !model.isAtomic(t)), []);
  assert.ok(!model.atomicTypes.includes('columns'));
});

test('a new block carries an id and its default; a copy carries fresh ids', () => {
  const block = model.createBlock('timeline');
  assert.equal(block.type, 'timeline');
  assert.equal(block.limit, 25);
  assert.notEqual(model.duplicateBlock(block).id, block.id);
});

test('its own check decides its own type, and may narrow a core one', () => {
  assert.ok(model.validateBlocks([{ id: 'a', type: 'timeline', limit: 3 }]));
  assert.ok(!model.validateBlocks([{ id: 'a', type: 'timeline', limit: 'x' }]));
  assert.ok(model.validateBlocks([{ id: 'a', type: 'list', source: 'newest', show: 'links', count: 3 }]));
  assert.ok(!model.validateBlocks([{ id: 'a', type: 'list', source: 'newest', show: 'links', under: 'private' }]));
  assert.ok(!model.validateBlocks([{ id: 'a', type: 'unknown' }]));
  assert.match(model.blockIssues([{ id: 'a', type: 'infobox', blocks: [{ id: 'b', type: 'columns', columns: [] }] }])[0].reason, /cannot sit inside/);
});
