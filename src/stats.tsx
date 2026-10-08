// stats.tsx — a site's own analytics as one page, from `digest` in `wiki-formant/analytics`.
//
// A server component, like `react-server`, but on its own subpath: the daily
// chart is `lightweight-charts`, an optional peer, and a consumer that only
// wants a facet bar should not have to install it.

import type { CSSProperties } from 'react';
import type { Digest } from './analytics.js';
import { StatsChart } from './stats-chart.js';

export interface StatsProps {
  /** One window's figures, from `digest` in `wiki-formant/analytics`. */
  digest: Digest;
  /** The window the digest covers, in days. */
  days: number;
  /** The windows offered as `?days=` links on the same page. */
  ranges?: readonly number[];
}

/** The windows the stats page offers, in days. */
export const STATS_RANGES = [1, 7, 30, 90, 365] as const;

/** A `?days=` value as one of `ranges`, else `fallback`: the page's only input. */
export const statsDays = (param: unknown, ranges: readonly number[] = STATS_RANGES, fallback = 30) =>
  ranges.find(n => String(n) === param) ?? fallback;

const count = (n: number) => n.toLocaleString('en');
const regions = new Intl.DisplayNames(['en'], { type: 'region' });
const country = (code: string) => {
  try {
    return regions.of(code) ?? code;
  } catch {
    return code;
  }
};
const duration = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);
/** Unsigned at zero, so no change never reads as growth. */
const change = (now: number, before: number) => {
  if (!before) return null;
  const pct = Math.round((100 * (now - before)) / before);
  return pct > 0 ? `+${pct}%` : `${pct}%`;
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
 * before, visitors per day, and every ranked list the digest carries. Lists
 * with nothing in them are left out. The chart and the bars are
 * `currentColor` until the importing stylesheet gives them a colour.
 */
export function Stats({ digest: d, days, ranges = STATS_RANGES }: StatsProps) {
  const byDay = new Map(d.by_day.map(r => [r.date, r.visitors]));
  // A rolling window of n days touches n + 1 UTC dates, the first of them in part.
  const now = Date.now();
  const series = Array.from({ length: days + 1 }, (_, i) => {
    const date = new Date(now - (days - i) * 86_400_000).toISOString().slice(0, 10);
    return [date, byDay.get(date) ?? 0] as const;
  });
  const figures: [string, string, string | null][] = [
    ['Visitors', count(d.visitors), change(d.visitors, d.previous_visitors)],
    ['Page views', count(d.pageviews), null],
    ['Bounce rate', d.bounce_rate == null ? '–' : `${d.bounce_rate}%`, null],
    ['Visit length', d.visit_duration == null ? '–' : duration(d.visit_duration), null],
    ['With agents', count(d.visitors_incl_agents), null],
  ];
  if (d.follow_clicks) figures.push(['Clicks to X', count(d.follow_clicks.events), null]);
  const rows = <K extends string, M extends string>(list: Array<Record<K, string> & Record<M, number>>, k: K, m: M) =>
    list.map(r => [r[k], r[m]] as [string, number]);

  return (
    <div className="stats">
      <nav className="stats-ranges" aria-label="Window">
        {ranges.map(n => (
          <a key={n} href={`?days=${n}`} aria-current={n === days ? 'page' : undefined}>
            {n === 1 ? '24 hours' : `${n} days`}
          </a>
        ))}
      </nav>
      <dl className="stats-figures">
        {figures.map(([label, value, delta]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {value}
              {delta && <small>{` ${delta}`}</small>}
            </dd>
          </div>
        ))}
      </dl>
      <StatsChart series={series} />
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
