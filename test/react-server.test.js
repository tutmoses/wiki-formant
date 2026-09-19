import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FacetBar, FacetSummary, RelatedPages, Anchor, InfoboxAside, InfoboxFacts } from 'wiki-formant/react-server';

const html = (c, p) => renderToStaticMarkup(createElement(c, p));

test('the facet bar is a labelled navigation landmark', () => {
  const out = html(FacetBar, {
    link: Anchor,
    facets: [{ key: 'basis', label: 'Basis', options: [{ value: 'Classical', href: '/s?basis=Classical', active: false, count: 2 }] }],
    letters: [],
  });
  assert.match(out, /^<nav class="stack tight" aria-label="Filter pages">/);
});

test('the facet summary counts, narrows and clears', () => {
  assert.equal(html(FacetSummary, { shown: 3, total: 3, name: 'Safety' }), '<p class="facet-summary">The following <strong>3</strong> pages are in Safety.</p>');
  assert.equal(html(FacetSummary, { shown: 1, total: 1, name: 'Safety' }), '<p class="facet-summary">The following <strong>1</strong> page is in Safety.</p>');
  assert.equal(
    html(FacetSummary, { shown: 1, total: 3, name: 'Safety', clearHref: '/s' }),
    '<p class="facet-summary">Showing <strong>1</strong> of 3 pages in Safety. <a href="/s" class="facet-summary-clear">Clear filters</a></p>',
  );
  assert.match(html(FacetSummary, { shown: 0, total: 3, name: 'Safety', clearHref: '/s' }), /No pages match these filters\. <a href="\/s"/);
  assert.equal(html(FacetSummary, { shown: 0, total: 0, name: 'Safety' }), '<p class="facet-summary">This section has no pages yet.</p>');
});

test('related pages are a labelled aside over a list, and render nothing when empty', () => {
  assert.equal(html(RelatedPages, { pages: [], heading: 'See also' }), '');
  const out = html(RelatedPages, { pages: [{ href: '/a', title: 'A', detail: 'Classical' }], heading: 'More Classical in Safety', href: '/s?basis=Classical' });
  assert.equal(
    out,
    '<aside class="see-also" aria-labelledby="see-also-heading"><h2 id="see-also-heading" class="see-also-heading"><a href="/s?basis=Classical">More Classical in Safety</a></h2><ul class="see-also-list"><li><a href="/a" class="see-also-item"><span class="see-also-title">A</span><span class="see-also-detail">Classical</span></a></li></ul></aside>',
  );
});

test('infobox facts are a row-headed table; links go to the facet, URLs outward', () => {
  const out = html(InfoboxFacts, {
    rows: [
      { label: 'Basis', value: 'Classical', type: 'select', href: '/wiki/safety?basis=Classical' },
      { label: 'Website', value: 'https://www.example.org/', type: 'url' },
      { label: 'Repo', value: 'github.com/x/y', type: 'text' },
      { label: 'Launched', value: '2021-07-28T00:00:00Z', type: 'date' },
      { label: 'Links', value: 'a.org<br>plain', type: 'text' },
    ],
  });
  assert.match(out, /<th scope="row">Basis<\/th><td><a href="\/wiki\/safety\?basis=Classical">Classical<\/a><\/td>/);
  assert.match(out, /<a href="https:\/\/www.example.org\/" target="_blank" rel="noopener">example.org<\/a>/);
  assert.match(out, /<a href="https:\/\/github.com\/x\/y" target="_blank" rel="noopener">github.com\/x\/y<\/a>/);
  assert.match(out, /<td>2021-07-28<\/td>/);
  assert.match(out, /<a href="https:\/\/a.org"[^>]*>a.org<\/a><br\/>plain/);
});

test('a hostile fact value is text, and a javascript: URL is not a link', () => {
  const out = html(InfoboxFacts, { rows: [
    { label: 'X', value: '"><img src=x onerror=alert(1)>', type: 'text' },
    { label: 'Y', value: 'javascript:alert(1)', type: 'url' },
  ] });
  assert.doesNotMatch(out, /<img/);
  assert.doesNotMatch(out, /href="javascript/);
});

test('the infobox aside is named and carries its series', () => {
  const out = html(InfoboxAside, { label: 'Key facts about A', series: { title: 'Consensus', href: '/c' }, className: 'stack' });
  assert.equal(out, '<aside class="infobox stack" aria-label="Key facts about A"><div class="infobox-series"><span>Part of a series on</span><a href="/c">Consensus</a></div></aside>');
});
