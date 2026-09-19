import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodeTabsView, PageRefsView } from 'wiki-formant/block-views';
import { pageRef } from 'wiki-formant/blocks';

const tabs = [{ label: 'Rust', language: 'rust', code: 'fn f<T>() -> Vec<T> { a < b && c > d }' }];

test('code tabs render their source escaped, in a pre', () => {
  // Source written as HTML lost every `<T>` — and is a script sink when the
  // code is user-authored.
  const html = renderToStaticMarkup(createElement(CodeTabsView, { tabs }));
  assert.match(html, /<pre><code class="language-rust">fn f&lt;T&gt;\(\) -&gt; Vec&lt;T&gt; \{ a &lt; b &amp;&amp; c &gt; d \}<\/code><\/pre>/);
  const script = renderToStaticMarkup(createElement(CodeTabsView, { tabs: [{ label: 'x', code: '<img src=x onerror=alert(1)>' }] }));
  assert.doesNotMatch(script, /<img/);
});

test('highlighted code tabs are written as the markup the server built', () => {
  const marked = [{ label: 'Rust', code: '<pre><code><span class="k">fn</span></code></pre>' }];
  const html = renderToStaticMarkup(createElement(CodeTabsView, { tabs: marked, highlighted: true }));
  assert.match(html, /<span class="k">fn<\/span>/);
});

test('page refs are a list, each age a machine-readable time', () => {
  const now = Date.UTC(2026, 8, 19, 12);
  const ref = pageRef({ title: 'Reading a point code', href: '/wiki/a', updatedAt: new Date(now - 86_400_000) }, now);
  assert.deepEqual(ref, { title: 'Reading a point code', href: '/wiki/a', timeAgo: 'yesterday', updated: '2026-09-18T12:00:00.000Z' });
  const html = renderToStaticMarkup(createElement(PageRefsView, { refs: [ref] }));
  assert.equal(
    html,
    '<ul class="page-refs"><li><a href="/wiki/a" class="page-ref"><span class="page-ref-title">Reading a point code</span><time class="page-ref-time" dateTime="2026-09-18T12:00:00.000Z">yesterday</time></a></li></ul>',
  );
});

test('an empty page list says so only when asked to', () => {
  assert.equal(renderToStaticMarkup(createElement(PageRefsView, { refs: [] })), '');
  assert.equal(renderToStaticMarkup(createElement(PageRefsView, { refs: [], empty: 'No pages yet.' })), '<p class="page-refs-empty">No pages yet.</p>');
});

test('renderItem swaps the row, not the list', () => {
  const html = renderToStaticMarkup(createElement(PageRefsView, { refs: [{ title: 'T', href: '/t' }], renderItem: r => createElement('b', null, r.title) }));
  assert.equal(html, '<ul class="page-refs"><li><b>T</b></li></ul>');
});
