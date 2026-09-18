import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHtmlSanitizer, sanitizeCoreLeaf } from 'wiki-formant/sanitize';
import { jsonLdScript } from 'wiki-formant/react-server';

const clean = createHtmlSanitizer();

test('script, handlers and hostile URLs are dropped', () => {
  assert.equal(clean('<p>hi<script>alert(1)</script></p>'), '<p>hi</p>');
  assert.equal(clean('<img src="x.png" onerror="alert(1)">'), '<img src="x.png" />');
  assert.equal(clean('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(clean('<p style="position:fixed;color:red">x</p>'), '<p style="color:red">x</p>');
  assert.equal(clean('<p style="background:url(//evil)">x</p>'), '<p>x</p>');
});

test('what the editor nodes store survives', () => {
  // Empty attributes serialise bare (`data-tabs`), which is the same attribute.
  const tabs = '<div data-tabs="" data-active-tab="0"><div data-tab-item="" data-tab-title="Rust"><p>x</p></div></div>';
  assert.equal(clean(tabs), tabs.replaceAll('=""', ''));
  const tweet = '<div data-twitter-embed="" data-tweet-id="1" data-url="https://x.com/a/status/1" class="twitter-embed"></div>';
  assert.equal(clean(tweet), tweet.replaceAll('=""', ''));
  assert.match(clean('<table class="tiptap-table"><tbody><tr><td class="p-2" colspan="2">x</td></tr></tbody></table>'), /<td class="p-2" colspan="2">/);
  assert.match(clean('<h2 id="intro">Intro</h2>'), /id="intro"/);
});

test('inline SVG keeps its presentational subset and its camelCase', () => {
  const svg = '<svg viewBox="0 0 10 10"><linearGradient id="g"></linearGradient><rect width="5" height="5" fill="red"></rect></svg>';
  assert.equal(clean(svg), svg.replace(' id="g"', ''));
  assert.equal(clean('<svg><foreignObject><p>x</p></foreignObject></svg>'), '<svg><p>x</p></svg>');
  assert.equal(createHtmlSanitizer({ svg: false })('<svg><rect></rect></svg>'), '');
});

test('iframes are held to the host list', () => {
  assert.match(clean('<iframe src="https://www.youtube.com/embed/abc"></iframe>'), /youtube/);
  assert.equal(clean('<iframe src="https://evil.example/"></iframe>'), '<iframe></iframe>');
  const own = createHtmlSanitizer({ iframeHosts: ['evil.example'] });
  assert.match(own('<iframe src="https://evil.example/"></iframe>'), /evil\.example/);
});

test('extra attributes merge with the defaults rather than replacing them', () => {
  const wide = createHtmlSanitizer({ attributes: { span: ['aria-hidden'] } });
  assert.equal(wide('<span id="k" aria-hidden="true">x</span>'), '<span id="k" aria-hidden="true">x</span>');
});

test('classes pass by name only, so utilities cannot build an overlay', () => {
  assert.equal(clean('<div class="fixed inset-0 z-50">fake prompt</div>'), '<div>fake prompt</div>');
  assert.equal(clean('<a href="/x" class="link evil">x</a>'), '<a href="/x" class="link">x</a>');
  assert.equal(clean('<pre><code class="language-rust">fn</code></pre>'), '<pre><code class="language-rust">fn</code></pre>');
  const own = createHtmlSanitizer({ classes: { span: ['citation-needed'] }, attributes: { span: ['class'] } });
  assert.equal(own('<span class="citation-needed fixed">x</span>'), '<span class="citation-needed">x</span>');
});

test('what the editor inserts keeps its classes and its inline image', () => {
  assert.equal(clean('<img src="data:image/png;base64,AAAA" class="rounded-lg max-w-full">'), '<img src="data:image/png;base64,AAAA" class="rounded-lg max-w-full" />');
  assert.equal(clean('<a href="data:text/html,x">x</a>'), '<a>x</a>');
  const own = createHtmlSanitizer({ tags: ['image'], attributes: { image: ['href'] }, schemesByTag: { image: ['data'] } });
  assert.match(own('<svg><image href="data:image/png;base64,AAAA"></image></svg>'), /data:image/);
  assert.equal(own('<svg><image href="https://evil.example/x.png"></image></svg>'), '<svg><image></image></svg>');
});

test('the core leaves are cleaned field by field, and other blocks pass through', () => {
  const bad = '<b onclick="x()">b</b>';
  assert.equal(sanitizeCoreLeaf({ type: 'content', text: bad }, clean).text, '<b>b</b>');
  assert.equal(sanitizeCoreLeaf({ type: 'codeTabs', tabs: [{ label: 'a', code: bad }] }, clean).tabs[0].code, '<b>b</b>');
  assert.equal(sanitizeCoreLeaf({ type: 'linkGrid', groups: [{ heading: 'h', description: bad, links: [] }] }, clean).groups[0].description, '<b>b</b>');
  assert.equal(sanitizeCoreLeaf({ type: 'references', items: [{ id: '1', text: bad }] }, clean).items[0].text, '<b>b</b>');
  const own = { type: 'tipJar', message: bad };
  assert.equal(sanitizeCoreLeaf(own, clean), own);
});

test('a JSON-LD payload cannot close its own script tag', () => {
  const out = jsonLdScript({ name: '</script><script>alert(1)</script>' });
  assert.equal(out.includes('<'), false);
  assert.equal(JSON.parse(out).name, '</script><script>alert(1)</script>');
});
