import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodeTabsView } from 'wiki-formant/block-views';

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
