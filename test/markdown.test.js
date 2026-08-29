import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown, tableToMarkdown, inlineToMarkdown, frontmatter, markdownDocument } from '../dist/markdown.js';
import { decodeEntities } from '../dist/entities.js';

test('ordered lists number per list', () => {
  // The bug this pins: a single regex with a `$1` backreference inside a
  // replace callback renders every item as the literal `1. $1`.
  const md = htmlToMarkdown('<ol><li>one</li><li>two</li><li>three</li></ol>');
  assert.equal(md, '1. one\n2. two\n3. three');
  assert.ok(!md.includes('$1'));
});

test('two ordered lists each restart at 1', () => {
  const md = htmlToMarkdown('<ol><li>a</li><li>b</li></ol><p>gap</p><ol><li>c</li></ol>');
  assert.match(md, /1\. a\n2\. b/);
  assert.match(md, /1\. c/);
});

test('tables convert before the generic rules eat their markup', () => {
  const md = htmlToMarkdown('<table><tr><th>Point</th><th>Use</th></tr><tr><td>LI04</td><td>Headache</td></tr></table>');
  assert.equal(md, '| Point | Use |\n| --- | --- |\n| LI04 | Headache |');
});

test('a headerless table gets a synthesised header, since GFM has no other form', () => {
  const md = tableToMarkdown('<table><tr><td>a</td><td>b</td></tr></table>');
  assert.equal(md, '|  |  |\n| --- | --- |\n| a | b |');
});

test('pipes inside cells are escaped', () => {
  const md = tableToMarkdown('<table><tr><th>h</th></tr><tr><td>a|b</td></tr></table>');
  assert.match(md, /a\\\|b/);
});

test('ragged rows are padded to the widest', () => {
  const md = tableToMarkdown('<table><tr><th>a</th><th>b</th><th>c</th></tr><tr><td>1</td></tr></table>');
  assert.equal(md.split('\n').at(-1), '| 1 |  |  |');
});

test('inline marks survive inside cells and headings', () => {
  assert.equal(inlineToMarkdown('<strong>bold</strong> and <em>it</em> and <code>c</code>'), '**bold** and _it_ and `c`');
  assert.equal(inlineToMarkdown('<a href="/x">link</a>'), '[link](/x)');
  assert.equal(htmlToMarkdown('<h3>A <em>title</em></h3>'), '### A _title_');
});

test('named entities decode instead of reaching the reader as ampersand soup', () => {
  assert.equal(decodeEntities('a &mdash; b &rsquo;c&rsquo; &nbsp;&alpha;'), 'a — b ’c’  α');
  assert.equal(decodeEntities('&#8212; &#x2014;'), '— —');
  assert.equal(decodeEntities('&notanentity; &amp;'), '&notanentity; &');
});

test('code blocks keep their content undecorated', () => {
  assert.equal(htmlToMarkdown('<pre><code>const a = 1 &amp;&amp; 2;</code></pre>'), '```\nconst a = 1 && 2;\n```');
});

test('blockquotes, rules and headings all survive one pass', () => {
  const md = htmlToMarkdown('<h1>T</h1><p>para</p><blockquote>quoted</blockquote><hr><ul><li>x</li></ul>');
  assert.equal(md, '# T\n\npara\n\n> quoted\n\n---\n\n- x');
});

test('unknown tags are stripped, never printed', () => {
  assert.equal(htmlToMarkdown('<section><span>text</span></section>'), 'text');
});

test('frontmatter escapes quotes and omits absent fields', () => {
  const fm = frontmatter({ title: 'A "quoted" title', url: 'https://x/p' });
  assert.equal(fm, '---\ntitle: "A \\"quoted\\" title"\nurl: "https://x/p"\n---');
});

test('frontmatter carries the freshness stamp agents need', () => {
  const fm = frontmatter({
    title: 'T',
    url: 'https://x/p',
    updated: new Date('2026-08-29T10:00:00Z'),
    lastVerified: '2026-07-01T00:00:00Z',
    license: { spdx: 'CC-BY-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
    extra: { section: 'Method', protocols: 12, empty: '' },
  });
  assert.match(fm, /updated: 2026-08-29/);
  assert.match(fm, /last_verified: 2026-07-01/);
  assert.match(fm, /license: CC-BY-4\.0/);
  assert.match(fm, /section: "Method"/);
  assert.match(fm, /protocols: 12/);
  assert.ok(!fm.includes('empty'), 'blank extras are dropped');
});

test('markdownDocument is frontmatter, one H1, then the body', () => {
  const doc = markdownDocument({ title: 'LI04', url: 'https://x/points/li04' }, '<p>ignored</p>');
  assert.match(doc, /^---\n/);
  assert.match(doc, /\n# LI04\n/);
  assert.ok(doc.endsWith('\n'));
});

test('inline whitespace collapses the way HTML collapses it', () => {
  // Hand-authored HTML is indented. Without collapsing newlines, every wrapped
  // source line reaches the reader with a leading space.
  const md = htmlToMarkdown(`
    <p>
      A point code looks like a catalogue number
      and behaves like a street address.
    </p>
  `);
  assert.equal(md, 'A point code looks like a catalogue number and behaves like a street address.');
  assert.ok(!md.split('\n').some(l => l.startsWith(' ')), 'no line may start with a space');
});

test('indented table cells stay clean', () => {
  const md = htmlToMarkdown(`
    <table>
      <tr><th>Channel</th><th>Code</th></tr>
      <tr>
        <td>Kidney</td>
        <td><code>KD</code></td>
      </tr>
    </table>
  `);
  assert.equal(md, '| Channel | Code |\n| --- | --- |\n| Kidney | `KD` |');
});
