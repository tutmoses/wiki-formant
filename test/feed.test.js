import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absolutise, cdata, clampWords, escXml, renderFeed, renderItem } from '../dist/feed.js';

const item = (over = {}) => ({
  title: 'A & B',
  url: 'https://example.com/a',
  description: 'why',
  date: new Date('2026-03-01T00:00:00Z'),
  ...over,
});

test('the five XML metacharacters escape, the apostrophe numerically', () => {
  // `&apos;` is an XML entity that older readers parsing the feed as HTML do not
  // carry in their entity table. All three copies used the numeric reference and
  // all three explained why in the same words.
  assert.equal(escXml(`<a href="x">A & B's</a>`), '&lt;a href=&quot;x&quot;&gt;A &amp; B&#39;s&lt;/a&gt;');
});

test('BUG: a literal ]]> cannot close the CDATA section early', () => {
  // It would end the section mid-body and corrupt every item after it, not only
  // the one that contained it.
  const out = cdata('<p>if (a[b[c]]>d) {}</p>');
  assert.ok(out.startsWith('<![CDATA['));
  assert.ok(out.endsWith(']]>'));
  assert.equal(out.slice(9, -3).includes(']]>'), false);
});

test('a description is clamped on a word boundary', () => {
  assert.equal(clampWords('short', 20), 'short');
  const out = clampWords('the quick brown fox jumps over the lazy dog', 20);
  assert.equal(out, 'the quick brown fox');
  assert.equal(out.endsWith(' '), false);
  // Trailing punctuation left by the cut is dropped.
  assert.equal(clampWords('one two three, four five', 15), 'one two three');
});

test('internal links are absolutised, external and anchor targets are not', () => {
  const html = '<a href="/wiki/x">x</a> <img src="/i.png"> <a href="//cdn/x">c</a> <a href="#top">t</a> <a href="https://o/y">y</a>';
  const out = absolutise(html, 'https://example.com');
  assert.ok(out.includes('href="https://example.com/wiki/x"'));
  assert.ok(out.includes('src="https://example.com/i.png"'));
  assert.ok(out.includes('href="//cdn/x"'));
  assert.ok(out.includes('href="#top"'));
  assert.ok(out.includes('href="https://o/y"'));
});

test('optional item parts appear only when supplied', () => {
  const bare = renderItem(item());
  assert.equal(bare.includes('<enclosure'), false);
  assert.equal(bare.includes('content:encoded'), false);
  assert.equal(bare.includes('<category>'), false);
  assert.ok(bare.includes('<guid isPermaLink="true">https://example.com/a</guid>'));
  assert.ok(bare.includes('<title>A &amp; B</title>'));

  const full = renderItem(item({ image: 'https://e/i.png', html: '<p>hi</p>', categories: ['One', 'Two'] }));
  assert.ok(full.includes('<enclosure url="https://e/i.png" type="image/png" />'));
  assert.ok(full.includes('<content:encoded><![CDATA[<p>hi</p>]]></content:encoded>'));
  assert.equal((full.match(/<category>/g) ?? []).length, 2);
});

const channel = { title: 'F', link: 'https://e', description: 'd', self: 'https://e/f.xml' };

test('BUG: lastBuildDate comes from the newest item, not the clock', () => {
  // One copy stamped `new Date()` on every request, so every poller was told the
  // feed had changed when it had not — the recrawl the ETag helpers exist to stop.
  const out = renderFeed(channel, [
    item({ date: new Date('2026-03-01T00:00:00Z') }),
    item({ url: 'https://example.com/b', date: new Date('2026-05-04T00:00:00Z') }),
  ]);
  assert.ok(out.includes('<lastBuildDate>Mon, 04 May 2026 00:00:00 GMT</lastBuildDate>'));
  // Twice over the same input is byte-identical, which is the whole point.
  assert.equal(out, renderFeed(channel, [
    item({ date: new Date('2026-03-01T00:00:00Z') }),
    item({ url: 'https://example.com/b', date: new Date('2026-05-04T00:00:00Z') }),
  ]));
});

test('an empty feed has no build date rather than a fictional one', () => {
  const out = renderFeed(channel, []);
  assert.equal(out.includes('<lastBuildDate>'), false);
  assert.ok(out.includes('<atom:link href="https://e/f.xml" rel="self"'));
});

test('the channel carries its licence when it has one', () => {
  assert.equal(renderFeed(channel, []).includes('<copyright>'), false);
  const out = renderFeed({ ...channel, copyright: 'CC BY 4.0 & friends' }, []);
  assert.ok(out.includes('<copyright>CC BY 4.0 &amp; friends</copyright>'));
});

test('a channel may date itself by a rule only it can express', () => {
  // One consumer dates from the later of each item's published and updated
  // stamps, so an edit to an old article still moves the feed. That is stronger
  // than "the newest item" and not derivable from the items alone.
  const out = renderFeed({ ...channel, lastBuild: new Date('2026-09-09T00:00:00Z') }, [
    item({ date: new Date('2026-03-01T00:00:00Z') }),
  ]);
  assert.ok(out.includes('<lastBuildDate>Wed, 09 Sep 2026 00:00:00 GMT</lastBuildDate>'));
});
