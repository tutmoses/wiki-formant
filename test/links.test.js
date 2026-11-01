import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseLinks, fallbackAnchorText } from '../dist/links.js';

test('an external link opens in a new tab with a safe rel', () => {
  const out = normaliseLinks('<a href="https://example.com">x</a>');
  assert.match(out, /target="_blank"/);
  assert.match(out, /rel="noopener"/);
});

test('an internal link navigates in place', () => {
  const out = normaliseLinks('<a href="/wiki/foo">x</a>');
  assert.doesNotMatch(out, /target=/);
});

test('an absolute link back to our own host folds to a relative path', () => {
  const out = normaliseLinks('<a href="https://www.radix.wiki/contents/x">x</a>', { selfHost: 'radix.wiki' });
  assert.match(out, /href="\/contents\/x"/);
  assert.doesNotMatch(out, /target=/);
});

test('the bare self host folds to /', () => {
  const out = normaliseLinks('<a href="https://caper.network">home</a>', { selfHost: 'caper.network' });
  assert.match(out, /href="\/"/);
});

test('a self host is not matched as a substring of another domain', () => {
  const out = normaliseLinks('<a href="https://notradix.wiki/x">x</a>', { selfHost: 'radix.wiki' });
  assert.match(out, /target="_blank"/);
});

test('author-supplied target and rel are re-derived, not trusted', () => {
  const out = normaliseLinks('<a href="/x" target="_blank" rel="nofollow">x</a>');
  assert.doesNotMatch(out, /target=/);
  assert.doesNotMatch(out, /nofollow/);
});

test('a heading permalink anchor is left completely alone', () => {
  const html = '<a class="heading-anchor" href="#s" aria-label="Permalink"></a>';
  assert.equal(normaliseLinks(html), html);
});

test('the first #ref-n gets a cite target, later ones do not', () => {
  const refs = new Set();
  const out = normaliseLinks('<a href="#ref-1">[1]</a><a href="#ref-1">[1]</a>', { citedRefs: refs });
  assert.equal(out.match(/id="cite-1"/g).length, 1);
  assert.deepEqual([...refs], [1]);
});

test('an empty anchor gets a label synthesised from its href', () => {
  // The accessibility fix only one of the two wikis had before this was shared.
  assert.match(normaliseLinks('<a href="/contents/tech/hyperscale"></a>'), />hyperscale</);
  assert.match(normaliseLinks('<a href="https://www.example.com/x"></a>'), />example\.com</);
  assert.match(normaliseLinks('<a href="#notes"></a>'), />notes</);
});

test('fallbackText:false keeps an empty anchor empty', () => {
  assert.match(normaliseLinks('<a href="/x"></a>', { fallbackText: false }), /><\/a>/);
});

test('an anchor with no href is passed through untouched', () => {
  assert.equal(normaliseLinks('<a name="x">y</a>'), '<a name="x">y</a>');
});

test('fallbackAnchorText degrades to the href when it parses as nothing', () => {
  assert.equal(fallbackAnchorText('mailto:'), 'mailto:');
});
