'use client';

// stats-figures.tsx — the stats page's headline figures and the chart under
// them. Each figure is a button that charts that figure by day, week or month, so the chart
// is not only visitors. Its own module because it holds state; `Stats` stays a
// server component and hands it the digest, which is plain JSON.

import { useMemo, useState, type ReactNode } from 'react';
import type { Digest, DigestDay } from './analytics.js';
import { TimeChart, stepDecimals, type ChartAggregate, type ChartPoint } from './chart.js';

const count = (n: number) => n.toLocaleString('en');
// Whole seconds and percentages, unless an axis tick's step needs more to tell it from the next.
const places = (step?: number) => (step ? stepDecimals(step) : 0);
const duration = (s: number, step?: number) => (s < 60 ? `${s.toFixed(places(step))}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);
const percent = (n: number, step?: number) => `${n.toFixed(places(step))}%`;
interface Delta {
  text: string;
  /** Whether the change is the good way; absent when there is none. */
  better?: boolean;
}

/**
 * The change from the window before: a share of the figure before, or for a
 * rate its difference in points, since a bounce rate up 10% of itself reads
 * as ten points. Unsigned and unmarked at zero, so no change never reads as
 * growth. A lower bounce rate is the better one; every other figure, higher.
 */
function change(now: number | null, before: number | null, { points = false, lowerIsBetter = false } = {}): Delta | null {
  if (now == null || before == null || (!points && !before)) return null;
  const n = Math.round(points ? now - before : (100 * (now - before)) / before);
  const text = `${n > 0 ? '+' : ''}${n}${points ? ' pp' : '%'}`;
  return n ? { text, better: n > 0 !== lowerIsBetter } : { text };
}

interface Figure {
  label: string;
  value: string;
  delta: Delta | null;
  /** The figure on one day; null where the day has nothing to divide by. */
  day: (d: DigestDay) => number | null;
  format?: (n: number, step?: number) => string;
  /** A week or month of a count is its total; of a rate, the mean of its days. */
  aggregate?: ChartAggregate;
}

const figuresOf = ({ previous: p, ...d }: Digest): Figure[] => [
  { label: 'Visitors', value: count(d.visitors), delta: change(d.visitors, p.visitors), day: r => r.visitors },
  { label: 'Agents', value: count(d.agents), delta: change(d.agents, p.agents), day: r => r.agents },
  { label: 'Page views', value: count(d.pageviews), delta: change(d.pageviews, p.pageviews), day: r => r.pageviews },
  {
    label: 'Bounce rate',
    value: d.bounce_rate == null ? '–' : percent(d.bounce_rate),
    delta: change(d.bounce_rate, p.bounce_rate, { points: true, lowerIsBetter: true }),
    day: r => (r.visits ? (100 * r.bounces) / r.visits : null),
    format: percent,
    aggregate: 'mean',
  },
  {
    label: 'Visit length',
    value: d.visit_duration == null ? '–' : duration(d.visit_duration),
    delta: change(d.visit_duration, p.visit_duration),
    day: r => (r.visits ? r.seconds / r.visits : null),
    format: duration,
    aggregate: 'mean',
  },
  ...(d.follow_clicks
    ? [
        {
          label: 'Clicks to X',
          value: count(d.follow_clicks.events),
          delta: change(d.follow_clicks.events, p.follow_clicks),
          day: (r: DigestDay) => r.follow_clicks,
        },
      ]
    : []),
];

const DAY = 86_400;
const EMPTY: DigestDay = { date: '', visitors: 0, pageviews: 0, visits: 0, bounces: 0, seconds: 0, agents: 0, visitors_incl_agents: 0, follow_clicks: 0 };

/**
 * The figures as `.stats-figures button[aria-pressed]`, each with its change
 * as `.stats-delta[data-better]` for a stylesheet to colour, and the pressed one per
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
              {f.delta && (
                <small className="stats-delta" data-better={f.delta.better}>
                  {f.delta.text}
                </small>
              )}
            </strong>
          </button>
        ))}
      </div>
      <TimeChart
        series={series}
        label={figure.label}
        ranges={['all']}
        aggregate={figure.aggregate ?? 'sum'}
        fromZero
        format={figure.format}
        controls={windows}
        className="stats-chart"
      />
    </>
  );
}
