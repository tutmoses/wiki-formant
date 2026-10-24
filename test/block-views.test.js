import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BannerView, CodeTabsView, ColumnsView, EventsView, LocationsView, PageRefsView, ReferencesView } from 'wiki-formant/block-views';
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

test('inactive code tabs are hidden by attribute, not by a utility class', () => {
  const two = [...tabs, { label: 'TS', code: 'let x' }];
  const out = renderToStaticMarkup(createElement(CodeTabsView, { tabs: two }));
  assert.match(out, /<div class="code-tabs-panel"><pre>/);
  assert.match(out, /<div class="code-tabs-panel" hidden=""><pre>/);
  assert.doesNotMatch(out, /class="(block|hidden)"/);
});

test('columns carry gap and alignment as data, for base.css', () => {
  const out = renderToStaticMarkup(createElement(ColumnsView, { columns: [{ id: 'a', blocks: [] }], align: 'end', render: () => null }));
  assert.equal(out, '<div class="columns-layout" data-gap="md" data-align="end"><div class="column-view"></div></div>');
});

test('a notice links its label to the policy it enforces, when the wiki names one', () => {
  const linked = renderToStaticMarkup(createElement(BannerView, { variant: 'unsourced', message: 'Add sources.', policy: '/policy/verifiability' }));
  assert.match(linked, /<strong><a href="\/policy\/verifiability">Needs citations<\/a>\.<\/strong> Add sources\./);
  const bare = renderToStaticMarkup(createElement(BannerView, { variant: 'nonsense', message: 'Tidy up.' }));
  assert.match(bare, /<strong>Needs cleanup\.<\/strong> Tidy up\./);
});

test('two references blocks given their ids label each section with its own heading', () => {
  const items = [{ text: 'A source', url: 'https://a.org' }];
  const page = renderToStaticMarkup(createElement('div', null,
    createElement(ReferencesView, { id: 'r1', items }),
    createElement(ReferencesView, { id: 'r2', items, title: 'Further reading' })));
  assert.match(page, /aria-labelledby="references-r1"><h2 id="references-r1">References/);
  assert.match(page, /aria-labelledby="references-r2"><h2 id="references-r2">Further reading/);
  assert.match(renderToStaticMarkup(createElement(ReferencesView, { items })), /<h2 id="references-heading">/);
});

test('events render under the headings that hold any, the dates in a time', () => {
  const items = [{ id: 'a', date: '2026-11-12', end: '2026-11-18', text: 'Show, <em>London</em>' }, { id: 'b', date: '2027', text: 'Fair' }];
  const html = renderToStaticMarkup(createElement(EventsView, { items, day: '2026-11-14' }));
  assert.match(html, /^<section class="events"><h2>Upcoming<\/h2><ol class="event-list"><li><time dateTime="2026-11-12">12 – 18 Nov 2026<\/time><span><span>Show, <em>London<\/em><\/span><small class="event-now">Now on<\/small><\/span><\/li><li><time dateTime="2027">2027<\/time>/);
  assert.doesNotMatch(html, /Past/);
  const later = renderToStaticMarkup(createElement(EventsView, { items, day: '2028-01-01', past: 'Earlier' }));
  assert.match(later, /<h2>Earlier<\/h2>/);
  assert.doesNotMatch(later, /Upcoming|Now on/);
});

test('a place is drawn with its address linked to its map and its hours, the open state left to the browser', () => {
  const html = renderToStaticMarkup(createElement(LocationsView, { heading: 'Visit', map: true, items: [{ id: 'p', name: 'Shop', address: '1 High St\nLondon', phone: '+44 20 7232 3010', hours: [{ days: ['mon'], opens: '09:00', closes: '17:00' }] }] }));
  assert.match(html, /<section class="locations"><h2>Visit<\/h2><ul class="places"><li class="place"><h3>Shop<\/h3><address><a href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=1%20High%20St%2C%20London">1 High St\nLondon<\/a><\/address>/);
  assert.match(html, /<th scope="row">Mon<\/th><td>9am–5pm<\/td>/);
  assert.doesNotMatch(html, /place-state|aria-current/);
  assert.match(html, /<a href="tel:\+442072323010">/);
  assert.match(html, /<iframe class="place-map" src="https:\/\/maps\.google\.com\/maps\?q=1%20High%20St%2C%20London&amp;z=15&amp;output=embed"/);
});
