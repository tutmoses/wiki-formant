import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readArgs, withAdjustments } from 'wiki-formant/mcp';
import { collectBlockLinks } from 'wiki-formant/link-check';

test('readArgs clamps, parses, and records only what it overrode', () => {
  const r = readArgs({ limit: -4, page: '3', size: 'lots', half: '2.5', age: 35.5, q: '  cerberus ', tags: ['a', 7, 'b'], on: 'true' });
  assert.equal(r.num('limit', 12, 1, 50), 1);
  assert.equal(r.num('page', 1, 1, 100), 3);
  assert.equal(r.num('size', 20, 1, 50), 20);
  assert.equal(r.num('half', 1, 1, 9), 2);
  assert.equal(r.num('absent', 5, 1, 9), 5);
  assert.equal(r.decimal('age', null, 0, 130), 35.5);
  assert.equal(r.decimal('none', null, 0, 130), null);
  assert.equal(r.str('q'), 'cerberus');
  assert.deepEqual(r.list('tags'), ['a', 'b']);
  assert.equal(r.bool('on'), false);
  // A numeric string used as sent is not an override, so it is not reported.
  assert.deepEqual(r.adjustments.map(a => [a.param, a.used, a.reason]), [
    ['limit', 1, 'must be a whole number between 1 and 50'],
    ['size', 20, 'not a number'],
    ['half', 2, 'must be a whole number between 1 and 9'],
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
