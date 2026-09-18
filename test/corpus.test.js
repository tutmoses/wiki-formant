import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceCorpus } from 'wiki-formant/corpus';

const section = (path, n) => ({ path, tagPath: path.split('/')[0], section: 'x'.repeat(n) });
const docs = [section('a/one', 100), section('a/two', 300), section('b/three', 50)];

test('the preflight counts what a slice will actually send', () => {
  const pre = sliceCorpus(docs, { title: 'T', sizeOnly: true });
  assert.equal(pre.characters, 450);
  assert.equal(pre.estimatedTokens, 113);
  assert.deepEqual(pre.branches, [{ path: 'a', pages: 2, chars: 400 }, { path: 'b', pages: 1, chars: 50 }]);
  assert.deepEqual(pre.largestPages[0], { path: 'a/two', chars: 300 });
  assert.equal('document' in pre, false);
});

test('slices are page-aligned and say where to resume', () => {
  const first = sliceCorpus(docs, { title: 'T', maxChars: 150 });
  assert.equal(first.includedPages, 1);
  assert.equal(first.truncated, true);
  assert.equal(first.nextSkip, 1);
  assert.equal(first.omittedPages, 2);
  assert.equal(first.returnedCharacters, 100);
  assert.match(first.document, /^# T\n\n> pages 1-1 of 3/);

  const rest = sliceCorpus(docs, { title: 'T', maxChars: 1000, skip: 1 });
  assert.equal(rest.includedPages, 2);
  assert.equal(rest.truncated, false);
  assert.equal('nextSkip' in rest, false);
});

test('a page larger than the budget is clipped, reported, and skipped past', () => {
  const s = sliceCorpus(docs, { title: 'T', maxChars: 120, skip: 1 });
  assert.equal(s.clippedPage, 'a/two');
  assert.equal(s.truncated, true);
  assert.equal(s.nextSkip, 2);
});

test('clipping the LAST page still reports truncation', () => {
  const s = sliceCorpus([section('a/big', 500)], { title: 'T', maxChars: 100 });
  assert.equal(s.truncated, true);
  assert.equal(s.clippedPage, 'a/big');
  assert.equal('nextSkip' in s, false);
});
