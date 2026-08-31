import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TWITTER_ORIGIN,
  tweetEmbedSrc,
  onTweetResize,
  addCopyButtons,
} from '../dist/dom.js';

// ---- tweet embeds -----------------------------------------------------------

test('the embed opts out of tracking', () => {
  assert.equal(tweetEmbedSrc('123'), `${TWITTER_ORIGIN}/embed/Tweet.html?id=123&dnt=true`);
  assert.match(tweetEmbedSrc(456), /dnt=true$/);
});

/** A window just large enough to deliver messages to the listener under test. */
function fakeWindow() {
  let handler = null;
  globalThis.window = {
    addEventListener: (_type, fn) => {
      handler = fn;
    },
    removeEventListener: () => {
      handler = null;
    },
  };
  return {
    send: event => handler?.(event),
    get listening() {
      return handler !== null;
    },
  };
}

const resizeEvent = (height, origin = TWITTER_ORIGIN) => ({
  origin,
  data: { 'twttr.embed': { method: 'twttr.private.resize', params: [{ height }] } },
});

test('a resize from another origin is ignored', () => {
  const win = fakeWindow();
  const seen = [];
  onTweetResize(h => seen.push(h));
  // This is the check that was written out at four separate call sites. Any
  // page can postMessage; only the embed host may size the embed.
  win.send(resizeEvent(500, 'https://evil.example'));
  assert.deepEqual(seen, []);
  win.send(resizeEvent(500));
  assert.deepEqual(seen, [500]);
});

test('only the resize message counts, and only with a height', () => {
  const win = fakeWindow();
  const seen = [];
  onTweetResize(h => seen.push(h));
  win.send({ origin: TWITTER_ORIGIN, data: null });
  win.send({ origin: TWITTER_ORIGIN, data: {} });
  win.send({ origin: TWITTER_ORIGIN, data: { 'twttr.embed': { method: 'twttr.private.other' } } });
  win.send(resizeEvent(0));
  win.send(resizeEvent(undefined));
  assert.deepEqual(seen, []);
});

test('the disposer unsubscribes', () => {
  const win = fakeWindow();
  const off = onTweetResize(() => {});
  assert.equal(win.listening, true);
  off();
  assert.equal(win.listening, false);
});

// ---- copy buttons -----------------------------------------------------------

/**
 * The smallest DOM these functions actually touch. Enough to pin the
 * idempotence guard, which MOVED in the lift: both wikis had it at the call
 * site as `pre:not(:has(.code-copy-btn))`, where it can be — and was — retyped.
 */
function fakeArticle(preCount) {
  const pres = Array.from({ length: preCount }, () => {
    const children = [];
    return {
      children,
      style: {},
      textContent: 'code',
      appendChild: el => children.push(el),
      querySelector: sel =>
        children.find(c => sel === `.${c.className}`) ?? (sel === 'code' ? null : null),
    };
  });
  globalThis.document = {
    createElement: () => ({
      className: '',
      innerHTML: '',
      setAttribute() {},
      set onclick(_fn) {},
    }),
  };
  return { pres, querySelectorAll: () => pres };
}

test('every pre gets a button, once', () => {
  const article = fakeArticle(3);
  assert.equal(addCopyButtons(article), 3);
  // The second pass is the one that mattered: a re-render of the same content
  // must not stack a second button on every block.
  assert.equal(addCopyButtons(article), 0);
  for (const pre of article.pres) assert.equal(pre.children.length, 1);
});

test('a custom class name is what the guard looks for', () => {
  const article = fakeArticle(1);
  addCopyButtons(article, { className: 'copy' });
  assert.equal(addCopyButtons(article, { className: 'copy' }), 0);
  // A different class is a different button, so it is added.
  assert.equal(addCopyButtons(article, { className: 'other' }), 1);
});
