import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectHeadingIds, headingsFrom, slugifyHeading } from '../dist/headings.js';

test('every heading gets an id and a permalink anchor', () => {
  const out = injectHeadingIds('<h2>The shape of a code</h2><p>x</p><h3>Points off the channels</h3>');
  assert.match(out, /<h2 id="the-shape-of-a-code">/);
  assert.match(out, /<h3 id="points-off-the-channels">/);
  assert.equal(out.match(/heading-anchor/g).length, 2);
});

test('an authored id is kept, so a published anchor cannot move', () => {
  const out = injectHeadingIds('<h2 id="legacy-anchor">Renamed since</h2>');
  assert.match(out, /id="legacy-anchor"/);
  assert.doesNotMatch(out, /id="renamed-since"/);
});

test('repeated heading text dedupes instead of minting one id twice', () => {
  // The bug this fixes: without deduping, every link to the second "Notes"
  // lands on the first.
  const out = injectHeadingIds('<h2>Notes</h2><h2>Notes</h2><h2>Notes</h2>');
  assert.deepEqual(headingsFrom(out).map(h => h.id), ['notes', 'notes-2', 'notes-3']);
});

test('running twice is a no-op — an anchored heading is left alone', () => {
  const once = injectHeadingIds('<h2>Two readings, one field</h2>');
  assert.equal(injectHeadingIds(once), once);
});

test('the slug rule is injectable, because ids are published URLs', () => {
  const out = injectHeadingIds('<h2>A very long heading indeed</h2>', {
    slug: t => t.toLowerCase().replace(/\s+/g, '-').slice(0, 6),
  });
  assert.match(out, /id="a-very"/);
});

test('markup inside a heading does not reach the id or the label', () => {
  const out = injectHeadingIds('<h2>Where <em>AcuiQ</em> &amp; WHO differ</h2>');
  assert.deepEqual(headingsFrom(out), [
    { id: 'where-acuiq-who-differ', text: 'Where AcuiQ & WHO differ', level: 2 },
  ]);
});

test('the anchor carries no text, so it cannot leak into a TOC label', () => {
  const out = injectHeadingIds('<h2>Reading a row</h2>');
  assert.equal(headingsFrom(out)[0].text, 'Reading a row');
});

test('a heading with no sluggable text is left untouched', () => {
  assert.equal(injectHeadingIds('<h2>!!!</h2>'), '<h2>!!!</h2>');
  assert.deepEqual(headingsFrom('<h2>Unanchored</h2>'), []);
});

test('slugifyHeading strips punctuation and collapses separators', () => {
  assert.equal(slugifyHeading('  The 412 “outside” — a note  '), 'the-412-outside-a-note');
});
