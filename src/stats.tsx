// stats.tsx — a site's own analytics as one page, from `digest` in `wiki-formant/analytics`.
//
// A server component, like `react-server`, but on its own subpath: the daily
// chart is `TimeChart` from `wiki-formant/chart`, which needs the optional
// peer `lightweight-charts`, and a consumer that only wants a facet bar should
// not have to install it. The figures and the chart are `StatsFigures`, the
// one part that holds state.
//
// The page's state is its query: `?days=` picks the window, and `?page=`,
// `?entry=`, `?source=`, `?country=` and `?device=` narrow it. Every row in a
// list is a link that adds its own, and every narrowing a link that drops it.

import type { CSSProperties } from 'react';
import { STATS_FILTERS, type Digest, type StatsFilter } from './analytics.js';
import { StatsFigures } from './stats-figures.js';

export interface StatsProps {
  /** One window's figures, from `digest` in `wiki-formant/analytics`. */
  digest: Digest;
  /** The window the digest covers, in days; `Infinity` for all time. */
  days: number;
  /** What the digest was narrowed to, as `digest` was given it. */
  filter?: StatsFilter;
  /** The windows offered as `?days=` links on the same page. */
  ranges?: readonly number[];
}

/** The windows the stats page offers, in days; `Infinity` is all time. */
export const STATS_RANGES = [1, 7, 30, 90, 365, Infinity] as const;

/** A window as its `?days=` value. */
const daysParam = (n: number) => (Number.isFinite(n) ? String(n) : 'all');

/** A `?days=` value as one of `ranges`, else `fallback`. */
export const statsDays = (param: unknown, ranges: readonly number[] = STATS_RANGES, fallback = 30) =>
  ranges.find(n => daysParam(n) === param) ?? fallback;

/**
 * A stats page's query as the window and the filter, both ready for `digest`
 * and `Stats`: `const q = statsQuery(await searchParams)`. A repeated or empty
 * parameter is ignored.
 */
export function statsQuery(params: Record<string, string | string[] | undefined>, ranges: readonly number[] = STATS_RANGES) {
  const filter: StatsFilter = {};
  for (const k of STATS_FILTERS) {
    const v = params[k];
    if (typeof v === 'string' && v) filter[k] = v.slice(0, 500);
  }
  return { days: statsDays(params.days, ranges), filter };
}

/** The page at a window and a filter, as a query string. */
const href = (days: number, filter: StatsFilter) => {
  const q = new URLSearchParams({ days: daysParam(days) });
  for (const k of STATS_FILTERS) if (filter[k]) q.set(k, filter[k]);
  return `?${q}`;
};

const count = (n: number) => n.toLocaleString('en');
const regions = new Intl.DisplayNames(['en'], { type: 'region' });
const country = (code: string) => {
  try {
    return regions.of(code) ?? code;
  } catch {
    return code;
  }
};
const NAMES: Record<keyof StatsFilter, string> = { page: 'Page', entry: 'Entry page', source: 'Source', country: 'Country', device: 'Device' };
const DAY_MS = 86_400_000;

function StatsList({
  title,
  rows,
  label = v => v,
  to,
}: {
  title: string;
  rows: [string, number][];
  label?: (v: string) => string;
  /** Where a row narrows the page to; a list of events, which no visit filter reaches, has none. */
  to?: (v: string) => string;
}) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map(([, n]) => n));
  return (
    <section className="stats-list">
      <h2>{title}</h2>
      <ol>
        {rows.map(([v, n]) => (
          <li key={v} style={{ '--share': n / max } as CSSProperties}>
            <span>{to ? <a href={to(v)}>{label(v)}</a> : label(v)}</span>
            <span className="stats-count">{count(n)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * A site's own analytics on one page: the headline figures against the window
 * before, whichever of them is chosen per day, and every ranked list the
 * digest carries, each row a link that narrows the page to it. Lists with
 * nothing in them are left out. The chart and the bars are `currentColor`
 * until the importing stylesheet gives them a colour.
 */
export function Stats({ digest: d, days, filter = {}, ranges = STATS_RANGES }: StatsProps) {
  const today = Math.floor(Date.now() / DAY_MS);
  const counted = d.counted_from ? Date.parse(d.counted_from) / DAY_MS : today;
  const narrowed = STATS_FILTERS.filter(k => filter[k]);
  // A rolling window of n days touches n + 1 UTC dates, the first of them in
  // part. All time starts at the first day anything was counted, and a
  // narrowed window at the first day the site counted itself.
  const start = Number.isFinite(days) ? today - days : -Infinity;
  const first = narrowed.length
    ? Math.max(start, counted)
    : Number.isFinite(start) ? start : Math.min(today, ...d.by_day.map(r => Date.parse(r.date) / DAY_MS));
  const rows = <K extends string, M extends string>(list: Array<Record<K, string> & Record<M, number>>, k: K, m: M) =>
    list.map(r => [r[k], r[m]] as [string, number]);
  const to = (k: keyof StatsFilter) => (v: string) => href(days, { ...filter, [k]: v });

  return (
    <div className="stats">
      <nav className="stats-ranges" aria-label="Window">
        {ranges.map(n => (
          <a key={n} href={href(n, filter)} aria-current={n === days ? 'page' : undefined}>
            {n === 1 ? '24 hours' : Number.isFinite(n) ? `${n} days` : 'All time'}
          </a>
        ))}
      </nav>
      {narrowed.length > 0 && (
        <div className="stats-filters">
          <ul aria-label="Narrowed to">
            {narrowed.map(k => (
              <li key={k}>
                <a href={href(days, { ...filter, [k]: undefined })} title="Remove">
                  {NAMES[k]}: {k === 'country' ? country(filter[k]!) : filter[k]} ×
                </a>
              </li>
            ))}
          </ul>
          {start < counted && d.counted_from && (
            <p>Narrowed figures start on {d.counted_from}, the first day this site counted its own visits.</p>
          )}
        </div>
      )}
      <StatsFigures digest={d} first={first} />
      <div className="stats-lists">
        <StatsList title="Pages" rows={rows(d.top_pages, 'page', 'visitors')} to={to('page')} />
        <StatsList title="Entry pages" rows={rows(d.entry_pages, 'page', 'visitors')} to={to('entry')} />
        <StatsList title="Sources" rows={rows(d.top_sources, 'source', 'visitors')} to={to('source')} />
        <StatsList
          title="From X posts"
          rows={rows(d.from_posts, 'page', 'visitors')}
          to={v => href(days, { ...filter, source: 'x', entry: v })}
        />
        <StatsList title="Sibling sites" rows={rows(d.sibling_referrals, 'source', 'visitors')} to={to('source')} />
        <StatsList title="Countries" rows={rows(d.countries, 'country', 'visitors')} label={country} to={to('country')} />
        <StatsList title="Devices" rows={rows(d.devices, 'device', 'visitors')} to={to('device')} />
        <StatsList title="Agent tool calls" rows={rows(d.agent_tool_calls, 'tool', 'events')} />
        <StatsList title="Searches that found nothing" rows={rows(d.gaps, 'query', 'events')} />
      </div>
    </div>
  );
}
