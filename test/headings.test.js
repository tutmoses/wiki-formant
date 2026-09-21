import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectHeadingIds, headingsFrom, slugifyHeading, headingOutline, outlineIssues } from 'wiki-formant/headings';

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

test('one used set across fragments dedupes a whole page, not one block', () => {
  // The bug this pins: every consumer ran the injector once per block with a
  // fresh set, so a heading repeated in two blocks shipped two identical ids.
  const used = new Set(['page-title']);
  const a = injectHeadingIds('<h2>Notes</h2><h2>Page title</h2>', { used });
  const b = injectHeadingIds('<h2>Notes</h2>', { used });
  assert.match(a, /id="notes"/);
  assert.match(a, /id="page-title-2"/);
  assert.match(b, /id="notes-2"/);
  assert.deepEqual(headingsFrom(a + b).map(h => h.id), ['notes', 'page-title-2', 'notes-2']);
});

test('an already-decorated heading still reserves its id', () => {
  const used = new Set();
  const stored = injectHeadingIds('<h2>Notes</h2>');
  injectHeadingIds(stored, { used });
  assert.match(injectHeadingIds('<h2>Notes</h2>', { used }), /id="notes-2"/);
});

// --- the outline an audit reads, and what is wrong with it ---

test('the outline counts headings with no id, which the rail list drops', () => {
  const html = '<h1>Contents</h1><h2 id="tech">Tech</h2>';
  assert.deepEqual(headingOutline(html).map(h => [h.level, h.id]), [[1, ''], [2, 'tech']]);
  assert.deepEqual(headingsFrom(html).map(h => h.id), ['tech']);
});

test('one h1 and nothing under it — radix.wiki/contents before the fix', () => {
  assert.deepEqual(outlineIssues('<h1>&#128218; Contents</h1><div><a href="/x">Tech</a></div>').map(i => i.fault),
    ['noSubheading']);
});

test('a skipped level is reported with the pair that skipped — acuiq.com home', () => {
  const issues = outlineIssues('<h1>Points</h1><h2>Common symptoms</h2><h4>Cited</h4>');
  assert.deepEqual(issues.map(i => i.fault), ['skippedLevel']);
  assert.equal(issues[0].after, 2);
  assert.equal(issues[0].level, 4);
  assert.equal(issues[0].text, 'Cited');
});

test('no h1, and a page with no headings at all says it once', () => {
  assert.deepEqual(outlineIssues('<h2>Sections</h2><h3>A</h3>').map(i => i.fault), ['noH1']);
  assert.deepEqual(outlineIssues('<p>nothing</p>').map(i => i.fault), ['noH1']);
});

test('a second h1 is named, so the fix knows which one to demote', () => {
  const issues = outlineIssues('<h1>Page</h1><h2>A</h2><h1>Sneaky</h1>');
  assert.deepEqual(issues.map(i => i.fault), ['multipleH1']);
  assert.equal(issues[0].text, 'Sneaky');
});

test('a legal outline is clean, including one that climbs back up', () => {
  assert.deepEqual(outlineIssues('<h1>P</h1><h2>A</h2><h3>a1</h3><h2>B</h2><h3>b1</h3><h4>b1a</h4>'), []);
});

test('140 cards at the right level under the wrong parent is not a fault here', () => {
  // radix.wiki/ecosystem: legal levels, false nesting. Stated in the doc
  // comment and asserted, so a later rule change cannot claim otherwise
  // without this test failing.
  assert.deepEqual(outlineIssues('<h1>Ecosystem</h1><h2>How a status is decided</h2><h3>A</h3><h3>B</h3>'), []);
});
