// maintenance.ts — what the `maintenance-log` and `mark-verified` bins share,
// kept pure so it is tested without a database.
//
// A wiki-sweep routine keeps its memory between runs (the rotation cursor,
// source watermarks, backlog, feedback and run history) in one wiki page's
// `metadata.state`, and that page shows a capped rendering of it. radix-wiki
// and caper each had the script, with the same caps and rules and a different
// table. The rules are here; the table is the bin's arguments.
//
// Every write compacts first. `backlog` holds only open work items, since a
// run diary entry belongs in `runHistory`, which it duplicates, and the
// append-only lists are capped. Uncapped, radix-wiki's log page reached 384 KB
// of content and 710 KB of state, and a revision per run made it over half of
// its revisions table. Two kinds of entry are pinned against the caps because
// a run cannot recreate them: a backlog item flagged for a human, and a
// watermark that banks a verdict on a whole class of site (a bot wall, a 403),
// which is what lets an audit spend no probes on its flag list.
//
// No subpath exports this: the bins and the tests import it from dist.

import { escXml } from './feed.js';

export type SourceListItem = string | { handle?: string; name?: string; url?: string };
export interface SourceEntry {
  lastChecked?: string | null;
  note?: string;
  list?: SourceListItem[];
}
export type BacklogEntry = string | { date?: string; item: string; status?: string };
export type FeedbackEntry = string | { date?: string; note: string };
export interface RunEntry {
  date?: string;
  category?: string;
  summary?: string;
  tweet?: string;
}
export interface LogState {
  mission?: string;
  positioning?: string;
  totalRuns?: number;
  lastRun?: string | null;
  rotation?: { order?: string[]; next?: string };
  sources?: Record<string, SourceEntry>;
  backlog?: BacklogEntry[];
  feedback?: FeedbackEntry[];
  runHistory?: RunEntry[];
  [key: string]: unknown;
}

/** Held in state. */
const MAX = { backlog: 60, runs: 30, feedback: 40, sources: 150 };
/** Shown on the page. What a reader pays is words, and the entries run long. */
const SHOWN = { backlog: 15, runs: 5, feedback: 8, sources: 15 };

/** "run 214 (ecosystem): link audit CLEAN…" is a diary entry, not a work item. */
const JOURNAL = /^run\s+\d+\b/i;
const PINNED = /FLAG FOR A HUMAN/i;
const BANKED = /\bbanked\b|bot[- ]?(wall|block)|\b(403|429|999)\b|cloudflare/i;

const itemOf = (b: BacklogEntry) => (typeof b === 'string' ? b : b.item);
const recency = (a: [string, SourceEntry], b: [string, SourceEntry]) =>
  String(b[1]?.lastChecked ?? '').localeCompare(String(a[1]?.lastChecked ?? ''));

/** Drops what is closed or a diary entry, and caps what is append-only. Newest first. */
export function compact(state: LogState): LogState {
  // Undated items fall back to append order: a later index is newer.
  const open = (state.backlog ?? [])
    .map((b, i) => ({ status: 'open', ...(typeof b === 'string' ? { date: '', item: b } : b), i }))
    .filter(b => b.status === 'open' && b.item && (PINNED.test(b.item) || !JOURNAL.test(b.item)))
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || b.i - a.i);
  const backlog = [...open.filter(b => PINNED.test(b.item)), ...open.filter(b => !PINNED.test(b.item))]
    .slice(0, MAX.backlog)
    .map(({ i: _i, ...b }) => b);

  // Most source keys are one-off verdicts on a single site. Sorting by
  // lastChecked lets the cap age out only probes no run has touched since.
  const entries = Object.entries(state.sources ?? {});
  const banked = ([, v]: [string, SourceEntry]) => BANKED.test(String(v?.note ?? ''));
  const sources = Object.fromEntries(
    [...entries.filter(banked), ...entries.filter(e => !banked(e)).sort(recency).slice(0, MAX.sources)].sort(recency),
  );

  return {
    ...state,
    backlog,
    sources,
    feedback: (state.feedback ?? []).slice(-MAX.feedback),
    runHistory: (state.runHistory ?? []).slice(-MAX.runs),
  };
}

/** New backlog items, deduplicated against what is there, dated today unless they carry a date. */
export function addBacklog(state: LogState, items: readonly BacklogEntry[], today: string): BacklogEntry[] {
  const seen = new Set((state.backlog ?? []).map(itemOf));
  const added: BacklogEntry[] = [];
  for (const raw of items) {
    const item = itemOf(raw);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    added.push({ date: (typeof raw === 'object' && raw.date) || today, item, status: 'open' });
  }
  return added;
}

const esc = (s: unknown) => escXml(String(s ?? ''));
const more = (shown: number, total: number, what: string) =>
  total > shown ? `<p><em>${total - shown} older ${what} held in state.</em></p>` : '';
const table = (head: string[], rows: string[]) =>
  `<table><tbody><tr>${head.map(h => `<td><strong>${h}</strong></td>`).join('')}</tr>` +
  (rows.join('') || `<tr>${head.map(() => '<td>–</td>').join('')}</tr>`) +
  '</tbody></table>';

/** The page's content blocks, re-rendered from state on every write. `routine` names who keeps it. */
export function render(state: LogState, routine: string, newId: () => string = () => crypto.randomUUID()) {
  const rot = state.rotation ?? {};
  const backlog = state.backlog ?? [];
  const feedback = state.feedback ?? [];
  const sources = Object.entries(state.sources ?? {}).sort(recency);
  const block = (text: string) => ({ id: newId(), type: 'content' as const, text });

  const label = (x: SourceListItem) => (typeof x === 'string' ? x : (x.handle ?? x.name ?? x.url ?? ''));
  const sourceRows = sources.slice(0, SHOWN.sources).map(([key, v]) => {
    const watch = (v.list ?? []).map(label).filter(Boolean);
    const watching = watch.length ? ` — watching: ${esc(watch.slice(0, 8).join(', '))}${watch.length > 8 ? '…' : ''}` : '';
    return `<tr><td>${esc(key)}</td><td>${esc(v.lastChecked || '–')}</td><td>${esc(v.note)}${watching}</td></tr>`;
  });
  const runRows = (state.runHistory ?? []).slice(-SHOWN.runs).reverse().map(r => {
    const tweet = r.tweet && /^https?:\/\//.test(r.tweet) ? `<a href="${esc(r.tweet)}">link</a>` : esc(r.tweet);
    return `<tr><td>${esc(r.date)}</td><td>${esc(r.category)}</td><td>${esc(r.summary)}</td><td>${tweet}</td></tr>`;
  });

  return [
    block(
      `<p><em>Auto-maintained by the <code>${esc(routine)}</code> routine. Each run records what was swept, ` +
        'advances the category rotation, logs ecosystem signals, and tracks community reception. ' +
        'Do not hand-edit the state block – the routine overwrites it.</em></p>' +
        (state.mission ? `<p><strong>Mission:</strong> ${esc(state.mission)}</p>` : '') +
        (state.positioning ? `<p><strong>Positioning:</strong> ${esc(state.positioning)}</p>` : ''),
    ),
    block(
      '<h2>Current status</h2><table><tbody>' +
        `<tr><td><strong>Next category in rotation</strong></td><td>${esc(rot.next || '–')}</td></tr>` +
        `<tr><td><strong>Rotation order</strong></td><td>${esc((rot.order ?? []).join(' → '))}</td></tr>` +
        `<tr><td><strong>Last run</strong></td><td>${esc(state.lastRun || '–')}</td></tr>` +
        `<tr><td><strong>Total runs</strong></td><td>${esc(state.totalRuns ?? 0)}</td></tr>` +
        '</tbody></table>',
    ),
    block(
      `<h2>Signal watermarks</h2>${table(['Source', 'Last checked', 'Note'], sourceRows)}` +
        more(SHOWN.sources, sources.length, 'watermarks'),
    ),
    block(
      '<h2>Open backlog</h2>' +
        (backlog.length
          ? `<ul>${backlog.slice(0, SHOWN.backlog).map(b => `<li>${esc(itemOf(b))}</li>`).join('')}</ul>` +
            more(SHOWN.backlog, backlog.length, 'open items')
          : '<p><em>Empty.</em></p>'),
    ),
    block(
      '<h2>Community feedback &amp; reception</h2>' +
        (feedback.length
          ? `<ul>${feedback
              .slice(-SHOWN.feedback)
              .reverse()
              .map(f => `<li>${esc(typeof f === 'string' ? f : `${f.date ?? ''} – ${f.note}`)}</li>`)
              .join('')}</ul>` + more(SHOWN.feedback, feedback.length, 'entries')
          : '<p><em>Nothing logged yet.</em></p>'),
    ),
    block(`<h2>Recent runs</h2>${table(['Date', 'Category', 'Summary', 'Tweet'], runRows)}`),
  ];
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** A table or column name from the command line, quoted, or a thrown usage error. */
export function ident(name: string | undefined, what: string): string {
  if (!name || !IDENT.test(name)) throw new Error(`${what} must be a lower-case SQL identifier, got ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/**
 * `--scope column` limits a bin to rows whose column is NULL, `--scope
 * column=value` to rows where it equals the value: caper's platform pages
 * have no caper, and its company pages share their tag paths.
 */
export function scopeSql(scope: string | undefined, param: number): { sql: string; values: unknown[] } {
  if (!scope) return { sql: 'TRUE', values: [] };
  const [column, value] = scope.split('=');
  return value === undefined
    ? { sql: `${ident(column, '--scope')} IS NULL`, values: [] }
    : { sql: `${ident(column, '--scope')} = $${param}`, values: [value] };
}
