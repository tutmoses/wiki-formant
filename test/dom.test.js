import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  TWITTER_ORIGIN,
  tweetEmbedSrc,
  onTweetResize,
  addCopyButtons,
  sortTables,
} from 'wiki-formant/dom';

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

// ---- sortable tables --------------------------------------------------------

/**
 * A real DOM, unlike the fakes above. This pass reads `tHead`, `tBodies`,
 * `rows`, `cells`, `colSpan` and `:not([data-sort-init])`, and a hand-rolled
 * stand-in for those would be testing the stand-in.
 */
function article(html) {
  const { window } = new JSDOM(`<body>${html}</body>`);
  globalThis.document = window.document;
  return window.document.body;
}

const grid = (headers, rows) =>
  `<table><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>` +
  rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('') +
  '</table>';

/** Build a one-column table, activate it, and hand back the table. */
function oneColumn(values, header = 'Column') {
  const root = article(grid([header], values.map(v => [v])));
  sortTables(root);
  return root.querySelector('table');
}

const press = (table, col = 0, headRow = 0) =>
  table.rows[headRow].cells[col].querySelector('button').click();
const column = (table, col = 0, from = 1) =>
  Array.from(table.rows).slice(from).map(r => r.cells[col].textContent.trim());

test('text sorts A–Z, then Z–A, then back to the order the author wrote', () => {
  const table = oneColumn(['Cerberus', 'Alpha', 'Babylon']);
  press(table);
  assert.deepEqual(column(table), ['Alpha', 'Babylon', 'Cerberus']);
  press(table);
  assert.deepEqual(column(table), ['Cerberus', 'Babylon', 'Alpha']);
  // The third press is the one worth having: a table's authored order is often
  // chronological or ranked, and without this it takes a reload to get back.
  press(table);
  assert.deepEqual(column(table), ['Cerberus', 'Alpha', 'Babylon']);
  assert.equal(table.rows[0].cells[0].getAttribute('aria-sort'), 'none');
});

test('a number column sorts largest first, through prefixes, commas and suffixes', () => {
  const table = oneColumn(['$1,200', '142M XRD', '~$3,500', '−0.4', '+137%']);
  press(table);
  assert.deepEqual(column(table), ['142M XRD', '~$3,500', '$1,200', '+137%', '−0.4']);
});

test('a date column sorts chronologically, newest first, across written forms', () => {
  const table = oneColumn(['June 2024', '4 Jun 2026', '2025-03-01', 'January 7, 2025']);
  press(table);
  assert.deepEqual(column(table), ['4 Jun 2026', '2025-03-01', 'January 7, 2025', 'June 2024']);
});

test('a version is not a number, so the column sorts as text', () => {
  // 1.18.4 would parse as 1.18 and land under 1.9. Falling through to the
  // numeric collator puts 1.9 first, which is what a reader expects.
  const table = oneColumn(['1.18.4', '2.0.1', '1.9.0'], 'Version');
  press(table);
  assert.deepEqual(column(table), ['1.9.0', '1.18.4', '2.0.1']);
});

test('one unparseable value makes the whole column text', () => {
  const table = oneColumn(['10', '9', 'Pending']);
  press(table);
  // Sorted as text — and so ascending first, not descending.
  assert.deepEqual(column(table), ['9', '10', 'Pending']);
  assert.equal(table.rows[0].cells[0].getAttribute('aria-sort'), 'ascending');
});

test('an empty cell sorts last in both directions', () => {
  const table = oneColumn(['3', '—', '1', 'n/a', '2']);
  press(table);
  assert.deepEqual(column(table), ['3', '2', '1', '—', 'n/a']);
  press(table);
  assert.deepEqual(column(table), ['1', '2', '3', '—', 'n/a']);
});

test('sorting a second column clears the first', () => {
  const root = article(grid(['Name', 'Rank'], [['b', '2'], ['a', '1']]));
  sortTables(root);
  const table = root.querySelector('table');
  press(table, 0);
  press(table, 1);
  assert.equal(table.rows[0].cells[0].getAttribute('aria-sort'), 'none');
  assert.equal(table.rows[0].cells[1].getAttribute('aria-sort'), 'descending');
});

test("a <thead>'s last row is the one that labels the columns", () => {
  const root = article(
    '<table><thead><tr><th>Validators</th></tr><tr><th>Name</th></tr></thead>' +
      '<tbody><tr><td>b</td></tr><tr><td>a</td></tr></tbody></table>',
  );
  sortTables(root);
  const table = root.querySelector('table');
  assert.equal(table.rows[0].cells[0].querySelector('button'), null);
  press(table, 0, 1);
  assert.deepEqual(column(table, 0, 2), ['a', 'b']);
});

test('the editor wraps a header in a <p>, which the button takes over', () => {
  const root = article('<table><tr><th><p>Name</p></th></tr><tr><td>b</td></tr><tr><td>a</td></tr></table>');
  sortTables(root);
  const th = root.querySelector('th');
  assert.equal(th.children.length, 1);
  assert.equal(th.firstElementChild.tagName, 'BUTTON');
  assert.equal(th.textContent.trim(), 'Name');
  assert.equal(th.scope, 'col');
});

test('a header that is already a link is left alone', () => {
  const root = article(
    '<table><tr><th><a href="/x">Name</a></th><th>Rank</th></tr>' +
      '<tr><td>b</td><td>2</td></tr><tr><td>a</td><td>1</td></tr></table>',
  );
  sortTables(root);
  const table = root.querySelector('table');
  // A button around the link would fire both on one press.
  assert.equal(table.rows[0].cells[0].querySelector('button'), null);
  assert.equal(table.rows[0].cells[0].querySelector('a').getAttribute('href'), '/x');
  assert.ok(table.rows[0].cells[1].querySelector('button'));
});

test('a label/value table, a merged cell and a single row are all left alone', () => {
  const root = article(
    // An infobox: every row is a label and a value, so no row labels a column.
    '<table><tr><th>Ledger</th><td>Radix</td></tr><tr><th>Launched</th><td>2021</td></tr></table>' +
      // Moving a row under a merged cell would break the grid.
      '<table><tr><th>Name</th><th>Note</th></tr><tr><td colspan="2">b</td></tr><tr><td>a</td><td>x</td></tr></table>' +
      // Nothing to sort.
      grid(['Name'], [['only']]),
  );
  sortTables(root);
  assert.equal(root.querySelectorAll('button').length, 0);
  // Every table is still marked, so a second pass does not re-examine them.
  for (const table of root.querySelectorAll('table')) assert.ok(table.hasAttribute('data-sort-init'));
});

test('a second pass adds no second button', () => {
  const root = article(grid(['Name'], [['b'], ['a']]));
  sortTables(root);
  sortTables(root);
  assert.equal(root.querySelectorAll('th button').length, 1);
  // And the one button still sorts, rather than having been re-bound twice.
  press(root.querySelector('table'));
  assert.deepEqual(column(root.querySelector('table')), ['a', 'b']);
});

test("the button class is the caller's to name", () => {
  const root = article(grid(['Name'], [['b'], ['a']]));
  sortTables(root, { className: 'th-sort' });
  assert.equal(root.querySelector('th button').className, 'th-sort');
});
