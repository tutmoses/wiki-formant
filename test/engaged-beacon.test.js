import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// Its own file: the beacon starts once per page load, so it needs a module of its own.
test('a view is engaged after fifteen visible seconds in all, and a view left before then never is', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const dom = new JSDOM('', { url: 'https://radix.wiki/a', pretendToBeVisual: true });
  const sent = [];
  dom.window.navigator.sendBeacon = (_url, body) => sent.push(JSON.parse(body)) > 0;
  for (const key of ['window', 'document', 'location', 'history', 'navigator', 'HTMLAnchorElement', 'addEventListener']) {
    const value = key === 'addEventListener' ? dom.window.addEventListener.bind(dom.window) : dom.window[key];
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const show = visible => {
    Object.defineProperty(document, 'visibilityState', { value: visible ? 'visible' : 'hidden', configurable: true });
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
  };
  const { startBeacon } = await import('wiki-formant/dom');

  startBeacon();
  mock.timers.tick(10_000);
  history.pushState(null, '', '/b');
  mock.timers.tick(10_000);
  show(false);
  mock.timers.tick(60_000);
  show(true);
  mock.timers.tick(4_999);
  assert.deepEqual(sent, [{ path: '/a', referrer: '' }, { path: '/b' }]);
  mock.timers.tick(1);
  mock.timers.tick(60_000);
  assert.deepEqual(sent, [{ path: '/a', referrer: '' }, { path: '/b' }, { path: '/b', engaged: true }]);
  mock.timers.reset();
});
