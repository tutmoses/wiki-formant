// stats.tsx — a site's own analytics as one page, from `digest` in `wiki-formant/analytics`.
//
// A server component, like `react-server`, but on its own subpath: the daily
// chart is `TimeChart` from `wiki-formant/chart`, which needs the optional
// peer `lightweight-charts`, and a consumer that only wants a facet bar should
// not have to install it. The figures and the chart are `StatsFigures`, the
// one part that holds state.
//
// The page's state is its query: `?days=` picks the window, `?agents=apart`
// counts people and agents apart where visitors otherwise count both, and
// `?page=`, `?entry=`, `?source=`, `?country=` and `?device=` narrow it. Every
// row in a list is a link that adds its own, and every narrowing a link that
// drops it. Each is `link`, so a site passing its router's link component
// changes the window or the filter without reloading the page.

import type { CSSProperties, ReactNode } from 'react';
import { STATS_FILTERS, count, type Digest, type StatsFilter } from './analytics.js';
import type { PasskeyGate } from './passkey.js';
import { Anchor, type WikiLinkComponent } from './react-server.js';
import { PasskeyButton, PasskeySignOut, StatsFigures } from './stats-figures.js';

export interface StatsProps {
  /** One window's figures, from `digest` in `wiki-formant/analytics`. */
  digest: Digest;
  /** The window the digest covers, in days; `Infinity` for all time. */
  days: number;
  /** What the digest was narrowed to, as `digest` was given it. */
  filter?: StatsFilter;
  /** Visitors as people and agents, two figures, rather than one that counts both. */
  apart?: boolean;
  /** The windows offered as `?days=` links on the same page. */
  ranges?: readonly number[];
  /** Every link on the page: `next/link`, say, so a window or a filter does not reload it. */
  link?: WikiLinkComponent;
}

/** The windows the stats page offers, in days; `Infinity` is all time. */
const STATS_RANGES = [1, 7, 30, 90, 365, Infinity] as const;

/** A window as its `?days=` value. */
const daysParam = (n: number) => (Number.isFinite(n) ? String(n) : 'all');
/** A window as `TimeChart` names its ranges, since its buttons are where the windows sit. */
const windowLabel = (n: number) => (n === 1 ? '24H' : n === 365 ? '1Y' : Number.isFinite(n) ? `${n}D` : 'All');

/** A `?days=` value as one of `ranges`, else `fallback`. @internal */
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
  return { days: statsDays(params.days, ranges), filter, apart: params.agents === 'apart' };
}

/** The page at a window, a filter and a count of agents, as a query string. */
const href = (days: number, filter: StatsFilter, apart: boolean) => {
  const q = new URLSearchParams({ days: daysParam(days) });
  if (apart) q.set('agents', 'apart');
  for (const k of STATS_FILTERS) if (filter[k]) q.set(k, filter[k]);
  return `?${q}`;
};

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
  link: Link,
}: {
  title: string;
  rows: [string, number][];
  label?: (v: string) => string;
  /** Where a row narrows the page to; a list of events, which no visit filter reaches, has none. */
  to?: (v: string) => string;
  link: WikiLinkComponent;
}) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map(([, n]) => n));
  return (
    <section className="stats-list">
      <h2>{title}</h2>
      <ol>
        {rows.map(([v, n]) => (
          <li key={v} style={{ '--share': n / max } as CSSProperties}>
            <span>{to ? <Link href={to(v)}>{label(v)}</Link> : label(v)}</span>
            <span className="stats-count">{count(n)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * A site's own analytics on one page: the headline figures against the window
 * before, visitors counting agents unless `apart`, whichever of them is chosen per day, and every ranked list the
 * digest carries, each row a link that narrows the page to it. Lists with
 * nothing in them are left out. The chart and the bars are `currentColor`
 * until the importing stylesheet gives them a colour.
 */
export function Stats({ digest: d, days, filter = {}, apart = false, ranges = STATS_RANGES, link: Link = Anchor }: StatsProps) {
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
  const at = (f: StatsFilter, n = days, a = apart) => href(n, f, a);
  const to = (k: keyof StatsFilter) => (v: string) => at({ ...filter, [k]: v });

  // Each window is another digest, so a link rather than a button, pinned
  // with the chart's own controls, and so is the switch that counts agents apart.
  const controls = (
    <>
      <div role="group" aria-label="Window">
        {ranges.map(n => (
          <Link key={n} href={at(filter, n)} aria-current={n === days ? 'page' : undefined}>
            {windowLabel(n)}
          </Link>
        ))}
      </div>
      <div>
        {/* On while visitors count agents too, off while people and agents are counted apart: a robot's head in currentColor. */}
        <Link href={at(filter, days, !apart)} role="switch" aria-checked={!apart} aria-label="Agents counted among visitors" title="Agents counted among visitors">
          <svg className="chart-icon" viewBox="0 0 12 12" aria-hidden>
            <path d="M6 1.5v2M1 6.5v2M11 6.5v2" stroke="currentColor" />
            <rect x="2.5" y="3.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" />
            <circle cx="4.75" cy="7" r="0.9" fill="currentColor" />
            <circle cx="7.25" cy="7" r="0.9" fill="currentColor" />
          </svg>
        </Link>
      </div>
    </>
  );

  return (
    <div className="stats">
      {narrowed.length > 0 && (
        <div className="stats-filters">
          <ul aria-label="Narrowed to">
            {narrowed.map(k => (
              <li key={k}>
                <Link href={at({ ...filter, [k]: undefined })} title="Remove">
                  {NAMES[k]}: {k === 'country' ? country(filter[k]!) : filter[k]} ×
                </Link>
              </li>
            ))}
          </ul>
          {start < counted && d.counted_from && (
            <p>Narrowed figures start on {d.counted_from}, the first day this site counted its own visits.</p>
          )}
        </div>
      )}
      <StatsFigures digest={d} first={first} apart={apart} controls={controls} />
      <div className="stats-lists">
        <StatsList link={Link} title="Pages" rows={rows(d.top_pages, 'page', 'visitors')} to={to('page')} />
        <StatsList link={Link} title="Entry pages" rows={rows(d.entry_pages, 'page', 'visitors')} to={to('entry')} />
        <StatsList link={Link} title="Sources" rows={rows(d.top_sources, 'source', 'visitors')} to={to('source')} />
        <StatsList
          link={Link}
          title="From X posts"
          rows={rows(d.from_posts, 'page', 'visitors')}
          to={v => at({ ...filter, source: 'x', entry: v })}
        />
        <StatsList link={Link} title="Sibling sites" rows={rows(d.sibling_referrals, 'source', 'visitors')} to={to('source')} />
        <StatsList link={Link} title="Countries" rows={rows(d.countries, 'country', 'visitors')} label={country} to={to('country')} />
        <StatsList link={Link} title="Devices" rows={rows(d.devices, 'device', 'visitors')} to={to('device')} />
        <StatsList link={Link} title="Agents" rows={rows(d.top_agents, 'agent', 'visitors')} />
        <StatsList link={Link} title="Agent tool calls" rows={rows(d.agent_tool_calls, 'tool', 'events')} />
        <StatsList link={Link} title="Searches that found nothing" rows={rows(d.gaps, 'query', 'events')} />
      </div>
    </div>
  );
}

export interface StatsGateProps {
  gate: PasskeyGate;
  /** The gate's cookie from the request: `(await cookies()).get(gate.cookie)?.value`. */
  session: string | undefined;
  /** `?invite=` from the link, when there is one. */
  invite?: string | undefined;
  /** The site's host, named in the prompt. */
  host: string;
  /** The route that serves `gate.route` as POST and `gate.signOut` as DELETE. */
  endpoint?: string;
  /** What a signed-in reader sees, rendered only for one. */
  children: () => ReactNode | Promise<ReactNode>;
  classNames?: { text?: string; actions?: string; button?: string; error?: string };
}

/**
 * A stats page's door: `children` and a sign-out button for a signed-in
 * reader, else a line saying what the passkey prompt will do and the button
 * that does it. With an invite it saves a passkey; otherwise it signs in.
 * Three apps wrote this branch and its sentences.
 */
export async function StatsGate({ gate, session, invite, host, endpoint = '/api/passkey', children, classNames: c = {} }: StatsGateProps) {
  if (!invite && (await gate.signedIn(session))) {
    return (
      <>
        {await children()}
        <div className={c.actions}>
          <PasskeySignOut endpoint={endpoint} className={c.button} />
        </div>
      </>
    );
  }
  return (
    <>
      <p className={c.text}>
        {invite ? `Save a passkey on this device to open ${host}'s stats.` : 'Sign in with a passkey saved for this site.'}
      </p>
      <div className={c.actions}>
        <PasskeyButton endpoint={endpoint} invite={invite} className={c.button} errorClassName={c.error} />
      </div>
    </>
  );
}
