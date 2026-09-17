// dom.ts — the imperative passes a rendered article needs after it is in the DOM.
//
// Not in `react.tsx`, because none of this is React: it runs against an element
// a `dangerouslySetInnerHTML` just filled, and both wikis call it from an effect
// they already had. Keeping it out of the `'use client'` file also means a
// consumer can call it from anywhere it has an element.
//
// Both routines were duplicated. `addCopyButton` was BYTE-IDENTICAL in the two
// BlockRenderers, down to the SVG path data. The Twitter embed was worse: one
// wiki had extracted it to a module, the other wrote the origin allow-list and
// the embed URL out at three separate call sites — a duplicated origin check is
// the kind that goes stale quietly.

// ---- copy buttons -----------------------------------------------------------

const COPY_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

export interface CopyButtonOptions {
  /** Class on the injected button. Style it in your own stylesheet. */
  className?: string;
  label?: string;
  /** How long the tick shows before reverting to the copy glyph, in ms. */
  revertAfter?: number;
}

/**
 * Give every `<pre>` under `root` a copy button, once.
 *
 * Idempotent by inspection rather than by selector: both wikis called this
 * through `pre:not(:has(.code-copy-btn))`, which puts the guard at the call
 * site — where it can be, and was, retyped. Checking inside means a caller
 * that passes a plain `pre` selector still cannot double up, and it drops the
 * `:has()` dependency along the way.
 *
 * Returns the number of buttons added, so a caller can skip work when zero.
 */
export function addCopyButtons(root: ParentNode, options: CopyButtonOptions = {}): number {
  const { className = 'code-copy-btn', label = 'Copy code', revertAfter = 2000 } = options;
  let added = 0;

  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    if (pre.querySelector(`.${className}`)) continue;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = COPY_SVG;
    btn.onclick = () => {
      const code = pre.querySelector('code')?.textContent || pre.textContent || '';
      // A rejected clipboard write (permissions, insecure origin) must not
      // leave an unhandled rejection behind — the button simply does nothing.
      navigator.clipboard.writeText(code).then(
        () => {
          btn.innerHTML = CHECK_SVG;
          setTimeout(() => {
            btn.innerHTML = COPY_SVG;
          }, revertAfter);
        },
        () => {},
      );
    };
    (pre as HTMLElement).style.position = 'relative';
    pre.appendChild(btn);
    added++;
  }

  return added;
}

// ---- twitter embeds ---------------------------------------------------------

/**
 * The one place this origin is written down. It is both the embed host and the
 * allow-list the resize listener checks.
 */
export const TWITTER_ORIGIN = 'https://platform.twitter.com';

/** The embed iframe's src. `dnt=true` opts the embed out of Twitter's tracking. */
export const tweetEmbedSrc = (tweetId: string | number): string =>
  `${TWITTER_ORIGIN}/embed/Tweet.html?id=${tweetId}&dnt=true`;

/**
 * Subscribe to the height the embed posts back once it has laid itself out.
 *
 * The iframe renders at an unknown height and there is no other way to learn
 * it. The caller decides which iframes the height applies to; this only owns
 * the origin check and the message shape. Returns a disposer.
 */
export function onTweetResize(resize: (height: number) => void): () => void {
  const handleMessage = (e: MessageEvent) => {
    if (e.origin !== TWITTER_ORIGIN) return;
    const data = (e.data as Record<string, any> | null | undefined)?.['twttr.embed'];
    if (data?.method !== 'twttr.private.resize') return;
    const height = data.params?.[0]?.height;
    if (height) resize(height);
  };
  window.addEventListener('message', handleMessage);
  return () => window.removeEventListener('message', handleMessage);
}

/**
 * Point every un-hydrated `[data-twitter-embed]` placeholder under `root` at
 * the real embed URL.
 *
 * Stored article HTML carries the placeholder markup; the iframe only gets a
 * live `src` once it is in the document. Marked with `data-init` so a re-render
 * of the same content does not reload every embed on the page.
 */
export function hydrateTweetEmbeds(root: ParentNode): void {
  for (const container of Array.from(
    root.querySelectorAll('[data-twitter-embed]:not([data-init])'),
  )) {
    container.setAttribute('data-init', '');
    const tweetId = container.getAttribute('data-tweet-id');
    if (!tweetId) continue;
    const iframe = container.querySelector('iframe');
    if (iframe) {
      iframe.src = tweetEmbedSrc(tweetId);
      iframe.setAttribute('scrolling', 'no');
    }
  }
}

/** Apply a measured height to every embed iframe under `root`. */
export function sizeTweetEmbeds(root: ParentNode, height: number): void {
  for (const iframe of Array.from(root.querySelectorAll('[data-twitter-embed] iframe'))) {
    (iframe as HTMLIFrameElement).style.height = `${height}px`;
  }
}

// ---- tab groups -------------------------------------------------------------

export interface TabGroupClassNames {
  list?: string;
  panels?: string;
  button?: string;
  panel?: string;
  /** Added to the open button and its panel. */
  active?: string;
}

/**
 * Turn stored `[data-tabs]` markup into a working tab group.
 *
 * The editor stores tabs as nested `[data-tab-item]` divs, which is the right
 * thing to persist — it survives a markdown twin, a plain-HTML render and a
 * reader with JavaScript off, which all show every tab's content in order.
 * Making one of them pressable is a reader-side job, and it belongs beside the
 * other passes rather than inside a component: it is the same shape as the copy
 * buttons, and the second wiki to render tabs would otherwise write it again.
 *
 * Idempotent via `data-tabs-init`, so a re-render does not rebuild the group and
 * silently reset it to the first tab.
 */
export function activateTabGroups(root: ParentNode, classNames: TabGroupClassNames = {}): void {
  const {
    list = 'tabs-list',
    panels = 'tabs-panels',
    button = 'tab-button',
    panel = 'tab-panel',
    active = 'active',
  } = classNames;

  for (const group of Array.from(root.querySelectorAll('[data-tabs]:not([data-tabs-init])'))) {
    const items = group.querySelectorAll('[data-tab-item]');
    if (!items.length) continue;
    group.setAttribute('data-tabs-init', '');

    const tabList = document.createElement('div');
    tabList.className = list;
    tabList.setAttribute('role', 'tablist');
    const tabPanels = document.createElement('div');
    tabPanels.className = panels;

    items.forEach((item, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = i === 0 ? `${button} ${active}` : button;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(i === 0));
      btn.textContent = item.getAttribute('data-tab-title') || `Tab ${i + 1}`;
      btn.onclick = () => {
        for (const b of Array.from(tabList.children)) {
          b.classList.remove(active);
          b.setAttribute('aria-selected', 'false');
        }
        for (const p of Array.from(tabPanels.children)) p.classList.remove(active);
        btn.classList.add(active);
        btn.setAttribute('aria-selected', 'true');
        tabPanels.children[i]?.classList.add(active);
      };
      tabList.appendChild(btn);

      const body = document.createElement('div');
      body.className = i === 0 ? `${panel} ${active}` : panel;
      body.setAttribute('role', 'tabpanel');
      body.innerHTML = item.innerHTML;
      tabPanels.appendChild(body);
    });

    group.innerHTML = '';
    group.appendChild(tabList);
    group.appendChild(tabPanels);
  }
}

// ---- sortable tables --------------------------------------------------------

type SortKey = number | string | null;
type Direction = 'ascending' | 'descending';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthIndex = (name: string) => MONTHS.findIndex(m => m.startsWith(name.toLowerCase()));

// A dash, a question mark or "n/a" means the cell has no value. It sorts last
// in both directions, so it never lands above real values.
const BLANK = /^(?:[-–—?]|n\/?a|tb[ad])?$/i;

const DAY_FIRST = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/i;
const MONTH_FIRST = /^([a-z]{3,9})\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{4})/i;

/** The time a cell starts with, as ms. Accepts ISO dates, "4 Jun 2026", "June 4, 2026", "June 2026" and a bare year. */
function parseDate(s: string): number | null {
  const iso = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?(?:[ T](\d{2}):(\d{2}))?)?(?![\d,.])/.exec(s);
  if (iso) return Date.UTC(+iso[1]!, +(iso[2] ?? 1) - 1, +(iso[3] ?? 1), +(iso[4] ?? 0), +(iso[5] ?? 0));
  const d = DAY_FIRST.exec(s);
  if (d && monthIndex(d[2]!) >= 0) return Date.UTC(+d[3]!, monthIndex(d[2]!), +d[1]!, +(d[4] ?? 0), +(d[5] ?? 0), +(d[6] ?? 0));
  const m = MONTH_FIRST.exec(s);
  if (m && monthIndex(m[1]!) >= 0) return Date.UTC(+m[3]!, monthIndex(m[1]!), +(m[2] ?? 1));
  return null;
}

const MULTIPLIER: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12,
  kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 2 ** 10, mib: 2 ** 20, gib: 2 ** 30, tib: 2 ** 40,
};

// The number a cell starts with: "~$3,500", "+137%", "−0.4", "142M XRD",
// "14.00 million", "3.4 MB". A version string like "1.18.4" is not a number, so a column
// of versions falls through to the natural text order, where 1.9 comes before 1.10.
const NUMBER = /^[~≈<>≤≥]?\s*([+\-−]?)\s*[#$€£¥]?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)(?![.\d])(?:\s*(%|(?:thousand|million|billion|trillion|[kmgt]i?b|bn|[kmbt])(?![a-z])))?/i;

function parseNumber(s: string): number | null {
  const n = NUMBER.exec(s);
  if (!n) return null;
  const value = parseFloat(n[2]!.replace(/,/g, '')) * (MULTIPLIER[n[3]?.toLowerCase() ?? ''] ?? 1);
  return n[1] && n[1] !== '+' ? -value : value;
}

/**
 * The column's sort keys. A column is dates if every filled cell starts with a
 * date, numbers if every one starts with a number, and text otherwise. One
 * stray value makes the whole column text, which is better than sorting it half
 * by one rule and half by another.
 */
function columnKeys(cells: string[]): SortKey[] {
  const blank = cells.map(c => BLANK.test(c));
  for (const parse of [parseDate, parseNumber]) {
    const keys = cells.map((c, i) => (blank[i] ? null : parse(c)));
    if (keys.every((k, i) => k !== null || blank[i])) return keys;
  }
  return cells.map((c, i) => (blank[i] ? null : c));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compare(a: SortKey, b: SortKey, direction: Direction): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const order = typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b));
  return direction === 'ascending' ? order : -order;
}

/**
 * The row whose cells label the columns: the last row of a `<thead>`, or the
 * first row when every cell in it is a `<th>`. The editor writes the second
 * form. An infobox's label/value table has neither form, so it is left alone.
 */
function headerRow(table: HTMLTableElement): HTMLTableRowElement | undefined {
  const head = table.tHead?.rows;
  if (head?.length) return head[head.length - 1];
  const first = table.rows[0];
  return first && Array.from(first.cells).every(c => c.tagName === 'TH') ? first : undefined;
}

export interface SortTablesOptions {
  /** Class on the injected header button. Style it in your own stylesheet. */
  className?: string;
}

/**
 * Make every column-headed table under `root` sortable by its headers, once.
 *
 * Pressing a header sorts by that column. Text sorts A–Z first and numbers and
 * dates largest first, the same as a React table sorted by `useTableSort`. A
 * second press reverses the order and a third restores the author's order,
 * which is often meaningful (chronological, or ranked) and otherwise could only
 * be recovered by a reload.
 *
 * Tables stored in article HTML arrive as a string a `dangerouslySetInnerHTML`
 * wrote, so React never sees their rows and cannot sort them — which is why
 * this is a DOM pass beside `addCopyButtons` rather than a component. The
 * markup it writes, `aria-sort` on the cell and a button inside it, is the
 * markup a React sortable header should write too, so both kinds of table draw
 * their arrows from one stylesheet rule.
 *
 * Skipped: tables with merged cells, where moving a row would break the grid;
 * tables with fewer than two rows to sort; and rows that span several `<tbody>`s.
 */
export function sortTables(root: ParentNode, options: SortTablesOptions = {}): void {
  const { className = 'sort-header' } = options;

  for (const table of Array.from(root.querySelectorAll<HTMLTableElement>('table:not([data-sort-init])'))) {
    table.setAttribute('data-sort-init', '');
    const head = headerRow(table);
    if (!head) continue;
    const rows = Array.from(table.tBodies).flatMap(b => Array.from(b.rows)).filter(r => r !== head);
    const body = rows[0]?.parentElement;
    if (!body || rows.length < 2 || rows.some(r => r.parentElement !== body)) continue;
    if (Array.from(table.querySelectorAll<HTMLTableCellElement>('th, td')).some(c => c.colSpan > 1 || c.rowSpan > 1)) continue;

    const headers = Array.from(head.cells);
    const sortBy = (col: number, th: HTMLTableCellElement) => {
      const keys = columnKeys(rows.map(r => r.cells[col]?.textContent?.trim() ?? ''));
      const first: Direction = typeof keys.find(k => k !== null) === 'string' ? 'ascending' : 'descending';
      const current = th.getAttribute('aria-sort');
      const next = current === first ? (first === 'ascending' ? 'descending' : 'ascending') : current === 'none' ? first : null;
      for (const h of headers) if (h.hasAttribute('aria-sort')) h.setAttribute('aria-sort', 'none');
      if (next) th.setAttribute('aria-sort', next);
      const order = next
        ? rows.map((row, i) => ({ row, key: keys[i] ?? null })).sort((a, b) => compare(a.key, b.key, next)).map(x => x.row)
        : rows;
      body.append(...order);
    };

    headers.forEach((th, col) => {
      // A header with no label has nothing to press, and a link inside a
      // button would fire both.
      if (!th.textContent?.trim() || th.querySelector('a, button')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      // The editor wraps every cell's text in a <p>, which a button cannot hold.
      const label = th.children.length === 1 && th.firstElementChild?.tagName === 'P' ? th.firstElementChild : th;
      button.append(...Array.from(label.childNodes));
      button.onclick = () => sortBy(col, th);
      th.replaceChildren(button);
      th.scope ||= 'col';
      th.setAttribute('aria-sort', 'none');
    });
  }
}
