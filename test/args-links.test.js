import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readArgs, withAdjustments } from 'wiki-formant/mcp';
import { collectBlockLinks } from 'wiki-formant/link-check';

test('readArgs clamps, parses, and records only what it overrode', () => {
  const r = readArgs({ limit: -4, page: '3', size: 'lots', q: '  cerberus ', tags: ['a', 7, 'b'], on: 'true' });
  assert.equal(r.num('limit', 12, 1, 50), 1);
  assert.equal(r.num('page', 1, 1, 100), 3);
  assert.equal(r.num('size', 20, 1, 50), 20);
  assert.equal(r.num('absent', 5, 1, 9), 5);
  assert.equal(r.str('q'), 'cerberus');
  assert.deepEqual(r.list('tags'), ['a', 'b']);
  assert.equal(r.bool('on'), false);
  assert.deepEqual(r.adjustments.map(a => [a.param, a.reason]), [
    ['limit', 'must be a whole number between 1 and 50'],
    ['page', 'parsed numeric string'],
    ['size', 'not a number'],
  ]);
  assert.deepEqual(withAdjustments(readArgs({}), { ok: true }), { ok: true });
  assert.equal(withAdjustments(r, { ok: true }).adjustments.length, 3);
});

test('every core link-bearing field is read, decoded, and split', () => {
  const tree = [
    { id: '1', type: 'content', text: '<p><a href="https://api.test/x?a=1&amp;b=2">x</a> <a href="/">home</a> <a href="/docs/#top">d</a> <a href="#frag">f</a><iframe src="https://www.youtube.com/embed/v"></iframe></p>' },
    { id: '2', type: 'infobox', blocks: [{ id: '3', type: 'references', items: [{ id: 'r', text: 'See <a href="/cited/">it</a>', url: 'https://doi.test/1' }] }] },
    { id: '4', type: 'columns', columns: [{ id: 'c', blocks: [{ id: '5', type: 'linkGrid', groups: [{ id: 'g', heading: 'h', links: [{ label: 'l', href: '/grid' }] }] }] }] },
  ];
  const links = collectBlockLinks(tree);
  assert.deepEqual(links.external, ['https://api.test/x?a=1&b=2', 'https://doi.test/1']);
  assert.deepEqual(links.internal, ['/', '/docs', '/cited', '/grid']);
  assert.deepEqual(links.embeds, [{ kind: 'iframe', url: 'https://www.youtube.com/embed/v' }]);
});
