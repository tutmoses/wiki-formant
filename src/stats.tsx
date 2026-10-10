// stats.tsx — a site's own analytics as one page, from `digest` in `wiki-formant/analytics`.
//
// A server component, like `react-server`, but on its own subpath: the daily
// chart is `TimeChart` from `wiki-formant/chart`, which needs the optional
// peer `lightweight-charts`, and a consumer that only wants a facet bar should
// not have to install it. The figures and the chart are `StatsFigures`, the
// one part that holds state.

import type { CSSProperties } from 'react';
import type { Digest } from './analytics.js';
import { StatsFigures } from './stats-figures.js';

export interface StatsProps {
  /** One window's figures, from `digest` in `wiki-formant/analytics`. */
  digest: Digest;
  /** The window the digest covers, in days; `Infinity` for all time. */
  days: number;
  /** The windows offered as `?days=` links on the same page. */
  ranges?: readonly number[];
}

/** The windows the stats page offers, in days; `Infinity` is all time. */
export const STATS_RANGES = [1, 7, 30, 90, 365, Infinity] as const;

/** A window as its `?days=` value. */
const daysParam = (n: number) => (Number.isFinite(n) ? String(n) : 'all');

/** A `?days=` value as one of `ranges`, else `fallback`: the page's only input. */
export const statsDays = (param: unknown, ranges: readonly number[] = STATS_RANGES, fallback = 30) =>
  ranges.find(n => daysParam(n) === param) ?? fallback;

const count = (n: number) => n.toLocaleString('en');
const regions = new Intl.DisplayNames(['en'], { type: 'region' });
const country = (code: string) => {
  try {
    return regions.of(code) ?? code;
  } catch {
    return code;
  }
};

function StatsList({ title, rows, label = v => v }: { title: string; rows: [string, number][]; label?: (v: string) => string }) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map(([, n]) => n));
  return (
    <section className="stats-list">
      <h2>{title}</h2>
      <ol>
        {rows.map(([v, n]) => (
          <li key={v} style={{ '--share': n / max } as CSSProperties}>
            <span>{label(v)}</span>
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
 * digest carries. Lists with nothing in them are left out. The chart and the
 * bars are `currentColor` until the importing stylesheet gives them a colour.
 */
export function Stats({ digest: d, days, ranges = STATS_RANGES }: StatsProps) {
  // A rolling window of n days touches n + 1 UTC dates, the first of them in
  // part. All time starts at the first day anything was counted.
  const today = Math.floor(Date.now() / 86_400_000);
  const first = Number.isFinite(days) ? today - days : Math.min(today, ...d.by_day.map(r => Date.parse(r.date) / 86_400_000));
  const rows = <K extends string, M extends string>(list: Array<Record<K, string> & Record<M, number>>, k: K, m: M) =>
    list.map(r => [r[k], r[m]] as [string, number]);

  return (
    <div className="stats">
      <nav className="stats-ranges" aria-label="Window">
        {ranges.map(n => (
          <a key={n} href={`?days=${daysParam(n)}`} aria-current={n === days ? 'page' : undefined}>
            {n === 1 ? '24 hours' : Number.isFinite(n) ? `${n} days` : 'All time'}
          </a>
        ))}
      </nav>
      <StatsFigures digest={d} first={first} />
      <div className="stats-lists">
        <StatsList title="Pages" rows={rows(d.top_pages, 'page', 'visitors')} />
        <StatsList title="Entry pages" rows={rows(d.entry_pages, 'page', 'visitors')} />
        <StatsList title="Sources" rows={rows(d.top_sources, 'source', 'visitors')} />
        <StatsList title="From X posts" rows={rows(d.from_posts, 'page', 'visitors')} />
        <StatsList title="Sibling sites" rows={rows(d.sibling_referrals, 'source', 'visitors')} />
        <StatsList title="Countries" rows={rows(d.countries, 'country', 'visitors')} label={country} />
        <StatsList title="Devices" rows={rows(d.devices, 'device', 'visitors')} />
        <StatsList title="Agent tool calls" rows={rows(d.agent_tool_calls, 'tool', 'events')} />
        <StatsList title="Searches that found nothing" rows={rows(d.gaps, 'query', 'events')} />
      </div>
    </div>
  );
}
