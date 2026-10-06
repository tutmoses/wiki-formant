import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

test('the beacon sends one view per path, with the referrer only on the first, and outbound clicks', async () => {
  const dom = new JSDOM('<a id="out" href="https://x.com/radixwiki">x</a><a id="in" href="/b">b</a>', {
    url: 'https://radix.wiki/a?utm_source=x',
    referrer: 'https://t.co/abc',
  });
  const sent = [];
  dom.window.navigator.sendBeacon = (url, body) => sent.push({ url, ...JSON.parse(body) }) > 0;
  for (const key of ['window', 'document', 'location', 'history', 'navigator', 'HTMLAnchorElement', 'addEventListener']) {
    const value = key === 'addEventListener' ? dom.window.addEventListener.bind(dom.window) : dom.window[key];
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const { startBeacon } = await import('wiki-formant/dom');

  startBeacon('/api/view');
  startBeacon('/api/view');
  history.replaceState(null, '', '/a?page=2');
  history.pushState(null, '', '/b');
  document.getElementById('out').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  document.getElementById('in').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  assert.deepEqual(sent, [
    { url: '/api/view', path: '/a', referrer: 'https://t.co/abc', utm: 'x' },
    { url: '/api/view', path: '/b' },
    { url: '/api/view', name: 'Outbound Link: Click', path: '/b', props: { url: 'https://x.com/radixwiki' } },
  ]);
});
