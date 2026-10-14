import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe, DESCRIPTION_LIMIT } from 'wiki-formant/metadata';
import { openingText, plainText } from 'wiki-formant/text';

test('short prose passes through as one clean line', () => {
  assert.equal(describe('<p>The <a href="/x">Radix</a> network,  in   brief.</p>'), 'The Radix network, in brief.');
  assert.equal(describe('Fees &amp; royalties'), 'Fees & royalties');
  assert.equal(describe(null), '');
  assert.equal(describe('   '), '');
});

test('link targets and bare URLs go, and parenthetical prose stays', () => {
  assert.equal(
    describe('[Decentralized science (DeSci)](/wiki/desci/what-is-desci) runs into https://example.com/x trouble.'),
    'Decentralized science (DeSci) runs into trouble.',
  );
  assert.equal(describe('See the docs (https://docs.radixdlt.com) for more.'), 'See the docs for more.');
});

test('long prose keeps whole sentences when they fill half the budget', () => {
  const a = 'A'.repeat(60) + ' ends here.';
  const b = ' ' + 'B'.repeat(60) + ' also ends.';
  const c = ' And a third sentence that cannot fit in what is left.';
  const out = describe(a + b + c);
  assert.equal(out, a + b);
  assert.ok(out.length <= DESCRIPTION_LIMIT);
});

test('otherwise it cuts at a word, marks the cut, and stays within the limit', () => {
  const words = 'word '.repeat(60).trim();
  const out = describe(`Tiny. ${words}`);
  assert.ok(out.endsWith('…'));
  assert.ok(out.length <= DESCRIPTION_LIMIT, `${out.length}`);
  assert.doesNotMatch(out, /wor…$|\s…$/);
  assert.equal(describe('x'.repeat(300), 50).length, 50, 'one unbroken token is cut hard');
  assert.equal(describe('One. Two, three, four, five, six.', 20), 'One. Two, three…');
});

test('openingText is the first content block with prose once headings are out', () => {
  const blocks = [
    { type: 'infobox', blocks: [{ type: 'content', text: '<table><tr><td>Founded</td></tr></table>' }] },
    { type: 'content', text: '<h2>Overview</h2>' },
    { type: 'content', text: '<h2>History</h2><p>It began with <strong>Cerberus</strong> .</p>' },
    { type: 'content', text: '<p>Later.</p>' },
  ];
  assert.equal(openingText(blocks), 'It began with Cerberus.');
  assert.equal(openingText([{ type: 'infobox', blocks: [] }]), '');
  assert.equal(openingText(null), '');
  assert.equal(plainText('a <em>b</em> ( c ) [ d ]'), 'a b (c) [d]');
});
