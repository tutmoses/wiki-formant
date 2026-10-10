'use client';

// stats-figures.tsx — the stats page's headline figures and the chart under
// them. Each figure is a button that charts that figure per day, so the chart
// is not only visitors. Its own module because it holds state; `Stats` stays a
// server component and hands it the digest, which is plain JSON.

import { useMemo, useState, type ReactNode } from 'react';
import type { Digest, DigestDay } from './analytics.js';
import { TimeChart, type ChartPoint } from './chart.js';

const count = (n: number) => n.toLocaleString('en');
const duration = (s: number) => (s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);
const percent = (n: number) => `${Math.round(n)}%`;
/** Unsigned at zero, so no change never reads as growth. */
const change = (now: number, before: number | null) => {
  if (!before) return null;
  const pct = Math.round((100 * (now - before)) / before);
  return pct > 0 ? `+${pct}%` : `${pct}%`;
};

interface Figure {
  label: string;
  value: string;
  delta?: string | null;
  /** The figure on one day; null where the day has nothing to divide by. */
  day: (d: DigestDay) => number | null;
  format?: (n: number) => string;
}

const figuresOf = (d: Digest): Figure[] => [
  { label: 'Visitors', value: count(d.visitors), delta: change(d.visitors, d.previous_visitors), day: r => r.visitors },
  { label: 'Page views', value: count(d.pageviews), day: r => r.pageviews },
  {
    label: 'Bounce rate',
    value: d.bounce_rate == null ? '–' : percent(d.bounce_rate),
    day: r => (r.visits ? (100 * r.bounces) / r.visits : null),
    format: percent,
  },
  {
    label: 'Visit length',
    value: d.visit_duration == null ? '–' : duration(d.visit_duration),
    day: r => (r.visits ? r.seconds / r.visits : null),
    format: duration,
  },
  { label: 'With agents', value: count(d.visitors_incl_agents), day: r => r.visitors_incl_agents },
  ...(d.follow_clicks ? [{ label: 'Clicks to X', value: count(d.follow_clicks.events), day: (r: DigestDay) => r.follow_clicks }] : []),
];

const DAY = 86_400;
const EMPTY: DigestDay = { date: '', visitors: 0, pageviews: 0, visits: 0, bounces: 0, seconds: 0, visitors_incl_agents: 0, follow_clicks: 0 };

/**
 * The figures as `.stats-figures button[aria-pressed]` and the pressed one per
 * day from `first` (a UTC day number) to today. A count's empty day is a zero;
 * a rate's is left out, since no visits is not a bounce rate of nothing.
 */
export function StatsFigures({ digest, first, windows }: { digest: Digest; first: number; windows: ReactNode }) {
  const figures = useMemo(() => figuresOf(digest), [digest]);
  const [chosen, choose] = useState(0);
  const figure = figures[chosen] ?? figures[0]!;
  const byDay = useMemo(() => new Map(digest.by_day.map(r => [r.date, r])), [digest.by_day]);
  const series = useMemo<ChartPoint[]>(() => {
    const today = Math.floor(Date.now() / 1000 / DAY);
    return Array.from({ length: today - first + 1 }, (_, i) => {
      const time = (first + i) * DAY;
      const value = figure.day(byDay.get(new Date(time * 1000).toISOString().slice(0, 10)) ?? EMPTY);
      return value == null ? null : { time, value };
    }).filter(p => p !== null);
  }, [byDay, first, figure]);

  return (
    <>
      <div className="stats-figures" role="group" aria-label="Chart">
        {figures.map((f, i) => (
          <button key={f.label} type="button" aria-pressed={i === chosen} onClick={() => choose(i)}>
            <span>{f.label}</span>
            <strong>
              {f.value}
              {f.delta && <small>{` ${f.delta}`}</small>}
            </strong>
          </button>
        ))}
      </div>
      <TimeChart
        series={series}
        label={`${figure.label} per day`}
        ranges={['all']}
        aggregate="mean"
        fromZero
        format={figure.format}
        controls={windows}
        className="stats-chart"
      />
    </>
  );
}
