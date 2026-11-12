// analytics.ts – page views and events, counted in the site's own Postgres.
//
// It replaces a hosted analytics service. A page reports its own view to the
// site's own address (`startBeacon` in `dom.ts`, `<Beacon>` in `react.tsx`), a
// route hands the beacon to `collect`, and server code records events with
// `recordEvent`. `digest` reads it all back as one JSON object, and the
// `analytics-digest` bin prints that object for scripts outside the app.
//
// No cookie is set and no address is kept. A visitor is a hash of the address
// and the browser under a salt that changes every UTC day, and the old salt is
// deleted when the new one is made, so a visitor can be told apart within a day
// and never followed into the next. A visit is a run of one visitor's views
// with no gap over 30 minutes.
//
// The package owns the SQL; the app owns the connection. `Sql` is one function
// that runs a parameterised statement, which Prisma, `pg` and postgres.js can
// all supply in a line. The four tables it needs are Prisma models shipped in
// `prisma/analytics.prisma`, which the `prisma-models` bin copies into the
// app's schema folder, so `prisma db push` keeps them.
//
// `ViewDay` holds days a site counted somewhere else before it counted its
// own, one row a day with each breakdown as `{ value: visitors }`. Nothing
// writes or deletes it: the app loads it once, and `digest` adds the days in a
// window to the views. Summing days agrees with the views, whose visitor is
// one browser on one day. A site with no history leaves it empty.
//
// `siteId` is "" in an app that serves one site. A multi-tenant app passes its
// own site key to every call.
//
// Deferral stays with the caller: `after()` in a route, `event.waitUntil` in a
// proxy. Both are framework calls, and importing one here would cost this
// package its zero-dependency guarantee. Hashing is Web Crypto, so the module
// runs anywhere Node 20, a browser or an edge runtime does.

import { clientIp, clientKey, rateLimit, type HeaderReader, type RateLimitOptions } from './rate-limit.js';
import type { AgentFeedback } from './mcp.js';

/**
 * Runs one statement with `$1, $2…` placeholders and resolves to its rows.
 * Prisma: `(query, ...values) => prisma.$queryRawUnsafe(query, ...values)`.
 */
export type Sql = (query: string, ...values: unknown[]) => Promise<unknown>;

/** Long enough to compare a month with the same month a year before. */
const KEEP_DAYS = 400;
const DAY_MS = 86_400_000;

/** A script that runs a page's JavaScript and says what it is. */
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|prerender|preview/i;

/** iPadOS reports itself as a Mac, so its views count as a computer's. @internal */
export const deviceOf = (ua: string): 'phone' | 'tablet' | 'computer' =>
  /iPad|Tablet|Android(?!.*Mobile)/i.test(ua) ? 'tablet' : /Mobi|iPhone|Android/i.test(ua) ? 'phone' : 'computer';

const bareHost = (host: string) => host.toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');

/**
 * Where a visit came from: its `utm_source` when the link carried one, else the
 * referring host, and null for a referrer that is this site or none.
 *
 * @internal
 */
export function sourceOf(referrer: unknown, utm: unknown, host: string): string | null {
  if (typeof utm === 'string' && utm.trim()) return utm.trim().toLowerCase().slice(0, 100);
  if (typeof referrer !== 'string' || !referrer) return null;
  try {
    const from = bareHost(new URL(referrer).hostname);
    return from && from !== bareHost(host) ? from.slice(0, 200) : null;
  } catch {
    return null;
  }
}

/** A browser path as stored: decoded, one leading slash, no trailing one. Null when it will not decode. @internal */
export function normalisePath(path: string): string | null {
  try {
    const p = decodeURIComponent(path.split(/[?#]/)[0]!.slice(0, 500));
    return `/${p.replace(/^\/+|\/+$/g, '')}`;
  } catch {
    return null;
  }
}

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

const salts = new WeakMap<Sql, { day: string; value: string }>();

/** Today's salt. Whoever makes it also deletes yesterday's, and rows past keeping. */
async function todaysSalt(sql: Sql): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const cached = salts.get(sql);
  if (cached?.day === day) return cached.value;

  const made = (await sql(
    'INSERT INTO "Salt" (day, value) VALUES ($1, $2) ON CONFLICT (day) DO NOTHING RETURNING day',
    day,
    hex(crypto.getRandomValues(new Uint8Array(32))),
  )) as unknown[];
  if (made.length) {
    const cutoff = new Date(Date.now() - KEEP_DAYS * DAY_MS);
    await sql('DELETE FROM "Salt" WHERE day < $1', day);
    await sql('DELETE FROM "View" WHERE "createdAt" < $1', cutoff);
    await sql('DELETE FROM "Event" WHERE "createdAt" < $1', cutoff);
  }
  const [row] = (await sql('SELECT value FROM "Salt" WHERE day = $1', day)) as { value: string }[];
  salts.set(sql, { day, value: row!.value });
  return row!.value;
}

async function visitorOf(sql: Sql, site: string, headers: HeaderReader): Promise<string> {
  const text = [await todaysSalt(sql), site, clientIp(headers), headers.get('user-agent') ?? ''].join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hex(new Uint8Array(digest)).slice(0, 32);
}

/** Analytics must not be able to fail a response, so a failed write is logged and dropped. */
const quietly = (task: () => Promise<unknown>): Promise<void> =>
  task().then(
    () => undefined,
    (e: Error) => console.error(`analytics: ${e.message}`),
  );

export interface ViewInput {
  /** The beacon request's headers: the address, browser, host and country come from them. */
  headers: HeaderReader;
  path: string;
  referrer?: unknown;
  /** The page URL's `utm_source`. */
  utm?: unknown;
  site?: string;
}

/** Count one page view, unless a bot sent it. Never rejects. @internal */
export function recordView(sql: Sql, { headers, path, referrer, utm, site = '' }: ViewInput): Promise<void> {
  const ua = headers.get('user-agent') ?? '';
  const page = normalisePath(path);
  if (!ua || BOT.test(ua) || page === null) return Promise.resolve();
  return quietly(async () =>
    sql(
      'INSERT INTO "View" ("siteId", path, source, country, device, visitor) VALUES ($1, $2, $3, $4, $5, $6)',
      site,
      page,
      sourceOf(referrer, utm, headers.get('host') ?? ''),
      headers.get('x-vercel-ip-country')?.slice(0, 2) || null,
      deviceOf(ua),
      await visitorOf(sql, site, headers),
    ),
  );
}

/**
 * Mark a visitor's latest unengaged view of `path` in the last half hour as
 * engaged: the beacon's second word on a view, sent once its reader engaged
 * (`startBeacon`). Never rejects. @internal
 */
export function recordEngaged(sql: Sql, { headers, path, site = '' }: Omit<ViewInput, 'referrer' | 'utm'>): Promise<void> {
  const page = normalisePath(path);
  if (page === null) return Promise.resolve();
  return quietly(async () =>
    sql(
      `UPDATE "View" SET engaged = true WHERE id = (
        SELECT id FROM "View" WHERE "siteId" = $1 AND visitor = $2 AND path = $3 AND NOT engaged AND "createdAt" > now() - interval '30 minutes'
        ORDER BY id DESC LIMIT 1)`,
      site,
      await visitorOf(sql, site, headers),
      page,
    ),
  );
}

export interface EventInput {
  name: string;
  props?: Record<string, string | number>;
  /** The page it happened on, as a URL or a path. */
  url?: string;
  /** The request of whoever caused it, so the event joins their visitor. Omit for an event no visitor caused. */
  headers?: HeaderReader;
  site?: string;
}

/** Record one named event. Never rejects. */
export function recordEvent(sql: Sql, { name, props = {}, url, headers, site = '' }: EventInput): Promise<void> {
  return quietly(async () => {
    let path: string | null = null;
    if (url) path = normalisePath(new URL(url, 'http://x').pathname);
    // An agent's country is where its requests came from, so the stats page's countries can count it.
    const country = headers?.get('x-vercel-ip-country')?.slice(0, 2);
    return sql(
      'INSERT INTO "Event" ("siteId", name, path, props, visitor) VALUES ($1, $2, $3, $4::jsonb, $5)',
      site,
      name.slice(0, 64),
      path,
      JSON.stringify(country ? { ...props, country } : props),
      headers?.get('user-agent') ? await visitorOf(sql, site, headers) : null,
    );
  });
}

/** What a page sends: a view, with `engaged` its reader's engagement, or with `name` an event. */
export interface Beacon {
  path: string;
  referrer?: string;
  utm?: string;
  engaged?: boolean;
  name?: string;
  props?: Record<string, string | number>;
}

/** A browser-sent event's props: eight at most, each value a short string or a number. */
function beaconProps(props: unknown): Record<string, string | number> {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return {};
  return Object.fromEntries(
    Object.entries(props)
      .filter(([, v]) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))
      .slice(0, 8)
      .map(([k, v]) => [k.slice(0, 40), typeof v === 'string' ? v.slice(0, 300) : v]),
  );
}

export interface CollectOptions {
  sql: Sql;
  /** `after` in a Next route: the write runs once the 204 has gone. */
  defer: (task: () => Promise<unknown>) => void;
  /** The site a beacon counts toward, or null to drop it. A single-site app omits it. */
  site?: (request: Request, path: string) => string | null | Promise<string | null>;
  rateLimit?: RateLimitOptions;
}

// A person reads a few pages a minute. This leaves room for a fast reader and
// stops one address filling a site's figures.
const BEACONS: RateLimitOptions = { capacity: 30, refillPerSec: 0.5 };

/**
 * The whole beacon route: `export const POST = (r: Request) => collect(r, { sql, defer: after })`.
 * Answers 204 whatever happens, before anything is written, so a reader never waits on it.
 */
export async function collect(request: Request, { sql, defer, site, rateLimit: limit = BEACONS }: CollectOptions): Promise<Response> {
  const done = new Response(null, { status: 204 });
  const { headers } = request;
  if (BOT.test(headers.get('user-agent') ?? '') || !rateLimit(clientKey('beacon', headers), limit).ok) return done;

  const body = (await request.json().catch(() => null)) as Partial<Beacon> | null;
  const raw = typeof body?.path === 'string' ? body.path : null;
  const path = raw === null ? null : normalisePath(raw);
  if (!body || raw === null || !path) return done;
  const key = site ? await site(request, path) : '';
  if (key === null) return done;

  // The recorders normalise what they are given, so they get the path as sent:
  // decoded twice, `/100%25-off` was dropped and `/what%3Fnow` cut to `/what`.
  defer(() =>
    typeof body.name === 'string' && body.name
      ? recordEvent(sql, { name: body.name, props: beaconProps(body.props), url: raw, headers, site: key })
      : body.engaged === true
        ? recordEngaged(sql, { headers, path: raw, site: key })
        : recordView(sql, { headers, path: raw, referrer: body.referrer, utm: body.utm, site: key }),
  );
  return done;
}

export interface Gap {
  event: string;
  /** The prop holding the reader's words. */
  prop: string;
  /** Props the event must carry, e.g. `{ results: '0' }`. */
  where?: Record<string, string>;
}

/** Searches that found nothing, a person's or an agent's (`searchQueryProps` events). */
export const SEARCH_GAPS: Gap = { event: 'Search Query', prop: 'q', where: { results: '0' } };

/** The surface an agent's `search_wiki` call files its query under. */
export const MCP_SURFACE = 'mcp';

/** What a stats page can be narrowed to: one value each, every one applied. */
export const STATS_FILTERS = ['page', 'entry', 'source', 'country', 'device'] as const;
export type StatsFilter = Partial<Record<(typeof STATS_FILTERS)[number], string>>;

/** A count as a stats page prints it. Here, not in the `'use client'` figures, because
 * `Stats` calls it on the server, where a client module's export is only a reference. */
export const count = (n: number) => n.toLocaleString('en');

/**
 * A referrer that sent this many visitors in the window, not one of whom read a
 * second page, is a crawler naming a site it never came from: aocr.org sent
 * radix.wiki 319 one-page visitors in a month while Google's bounced four in five.
 */
const BOT_VISITORS = 20;
const BOT_SOURCE = '(bot)';

/** A visit's source: its first view's, or `(bot)` where that source is among `bots`. */
const visitSource = (s: string) => {
  const first = '(array_agg(source ORDER BY at, id))[1]';
  return `CASE WHEN ${first} IN (SELECT source FROM bots${s}) THEN '${BOT_SOURCE}' ELSE ${first} END`;
};

/**
 * Each filter as a test on one visit in the window suffixed `s`. A page,
 * country or device is any of the visit's views; an entry page or a source is
 * its first. `(none)` is no source.
 */
const VISIT_TEST: Record<keyof StatsFilter, (value: string, s: string) => string> = {
  page: v => `bool_or(path = ${v})`,
  entry: v => `(array_agg(path ORDER BY at, id))[1] = ${v}`,
  source: (v, s) => `coalesce(${visitSource(s)}, '(none)') = ${v}`,
  country: v => `bool_or(country = ${v})`,
  device: v => `bool_or(device = ${v})`,
};

/**
 * Each filter as a test on one agent: its reads in the window are its visit,
 * the first its entry page, and its country the one its requests came from.
 * No request of an agent's carries a source or a device, so neither passes one.
 */
const AGENT_TEST: Record<keyof StatsFilter, (value: string) => string> = {
  page: v => `bool_or(path = ${v})`,
  entry: v => `(array_agg(path ORDER BY at))[1] = ${v}`,
  source: () => 'false',
  country: v => `bool_or(country = ${v})`,
  device: () => 'false',
};

export interface DigestOptions {
  site?: string;
  /** How far back, in whole days from now; `Infinity` for all time. */
  days: number;
  /** The site's own X handle: `follow_clicks` counts clicks on links to it. */
  handle?: string;
  /** Hosts of sibling sites: `sibling_referrals` counts the visits they sent. */
  siblings?: string[];
  gaps?: Gap[];
  /**
   * The site's own agents, left out of `agents`, `top_agents`,
   * `agent_tool_calls`, the searches and the gaps, matched inside the user agent. The default is the
   * conformance suites (`<repo>-mcp-test`) and the studio's own tools.
   */
  ownAgents?: string[];
  /**
   * Narrows every figure to the visits that pass, and the events to their
   * visitors; an agent passes as `AGENT_TEST` has it. `ViewDay` keeps no
   * visits, so a narrowed digest leaves it out and starts at `counted_from`,
   * and has no `previous_visitors`.
   */
  filter?: StatsFilter;
}

type Ranked<K extends string, M extends string> = Array<Record<K, string> & Record<M, number>>;

/**
 * An agent's name from its event: the roster's label, else what its user agent
 * calls itself, `compatible; X` or the first product token.
 */
const AGENT_NAME = `coalesce(props->>'bot', substring(props->>'ua' from 'compatible; ?([^/;) ]+)'), nullif(split_part(split_part(props->>'ua', '/', 1), ' ', 1), ''), '(unknown)')`;

/** One UTC day of the figures a digest totals; a visit falls on the day it began. */
export interface DigestDay {
  date: string;
  visitors: number;
  /** Visitors who engaged with a page they viewed (`startBeacon`). */
  engaged: number;
  pageviews: number;
  visits: number;
  /** Visits that bounced (`Digest.bounce_rate`); an archived day has none. */
  bounces: number;
  agents: number;
  /** Clicks on links to the site's X handle; zero without a handle. */
  follow_clicks: number;
}

export interface Digest {
  visitors: number;
  /**
   * Visitors who engaged with a page they viewed: had it in a visible tab for
   * fifteen seconds, or gave it input (`startBeacon`). A crawler that runs
   * scripts renders a page and goes, so these are people. `ViewDay` keeps no
   * engagement, so an archived day adds nothing, and the window before is
   * compared only where engagement was counted from its first day.
   */
  engaged: number;
  pageviews: number;
  /** Runs of one visitor's views with no gap over 30 minutes. */
  visits: number;
  /**
   * Percent of visits that bounced: saw one page and never engaged with it,
   * the complement of `engaged`. Over the site's own visits, since `ViewDay`
   * keeps no engagement; null with none. Compared with the window before as
   * `engaged` is.
   */
  bounce_rate: number | null;
  /**
   * Agents, counted as visitors are: an AI crawler, an MCP client, or anything
   * else reading the machine surface (`trackAiBot`), one per address and user
   * agent a day, the site's own left out. They run no page script, so they are
   * never among `visitors`, and the ranked lists count people alone.
   */
  agents: number;
  /**
   * The headline figures over the same number of days before, narrowed alike.
   * A figure is null where that window reaches back past `counted_from` and
   * the archive cannot stand in for it: event figures always, all of them
   * when filtered.
   */
  previous: Record<
    'visitors' | 'engaged' | 'pageviews' | 'visits' | 'bounce_rate' | 'agents' | 'follow_clicks',
    number | null
  >;
  /** The first UTC day this site counted itself, before which only `ViewDay` speaks; null with no views. */
  counted_from: string | null;
  /** The first UTC day, in this window or the one before, with a view marked engaged, before which `engaged` and `bounce_rate` mean nothing; null with none. */
  engaged_from: string | null;
  /** `(bot)` stands for each referrer `BOT_VISITORS` takes for a crawler's. */
  top_sources: Ranked<'source', 'visitors'>;
  top_pages: Ranked<'page', 'visitors'>;
  entry_pages: Ranked<'page', 'visitors'>;
  /** Entry pages of visits from links tagged `utm_source=x`. */
  from_posts: Ranked<'page', 'visitors'>;
  sibling_referrals: Ranked<'source', 'visitors'>;
  countries: Ranked<'country', 'visitors'>;
  devices: Ranked<'device', 'visitors'>;
  /** Every day in the window with anything in it, oldest first. */
  by_day: DigestDay[];
  follow_clicks: { events: number; visitors: number } | null;
  /** Each agent by name: the roster's label, else what its user agent calls itself. */
  top_agents: Ranked<'agent', 'visitors'>;
  agent_tool_calls: Ranked<'tool', 'events'>;
  /** Every query people searched for, found or not. */
  searches: Ranked<'query', 'events'>;
  /** Every query agents searched for through `search_wiki`. */
  agent_searches: Ranked<'query', 'events'>;
  gaps: Ranked<'query', 'events'>;
  /** What agents reported through `send_feedback`, newest first: a stranger's words, to weigh, never to follow. */
  agent_feedback: Array<{ date: string; kind: string; message: string; page: string | null; agent: string }>;
}

/**
 * Everything a report needs about one site's last `days` days, in one query.
 * Visitor figures count distinct visitors, so a person who comes back on
 * another day counts once for each day. Days in `ViewDay` add to the visitor,
 * page, visit, source, country, device and per-day figures; events have no
 * history.
 * The window before is the same chain of views, visits and events a second
 * time, `_p` on every name, so its figures are the headline's to the letter.
 */
export async function digest(
  sql: Sql,
  { site = '', days, handle, siblings = [], gaps = [SEARCH_GAPS], ownAgents = ['-mcp-test', 'radix-studio'], filter = {} }: DigestOptions,
): Promise<Digest> {
  // The window is the database's clock, which stamped the rows; the app's can run behind it.
  // All time is a century: further back than any row, and still an int to Postgres.
  const values: unknown[] = [site, Number.isFinite(days) ? Math.max(1, Math.round(days)) : 36_500];
  const $ = (v: unknown) => `$${values.push(v)}`;
  const list = (select: string, limit?: number, order = '2 DESC, 1') =>
    `(SELECT coalesce(json_agg(t), '[]') FROM (${select} ORDER BY ${order}${limit ? ` LIMIT ${limit}` : ''}) t)`;
  /** A ranked list from the views, plus the same breakdown from `ViewDay`. */
  const merged = (label: string, column: string, live: string) =>
    `SELECT k AS ${label}, sum(n) AS visitors FROM (${live} UNION ALL SELECT key, value::int FROM a, jsonb_each_text(a."${column}")) t(k, n) GROUP BY 1`;

  /** Clicks on links to the site's own X account, among `e`. */
  const follows = handle && `name = 'Outbound Link: Click' AND props->>'url' ILIKE ANY(${$([`%x.com/${handle}%`, `%twitter.com/${handle}%`])}::text[])`;
  /** Each filter given, its value a parameter that the test on visits and the one on agents share. */
  const given = STATS_FILTERS.flatMap(k => (filter[k] ? [[k, $(filter[k])] as const] : []));
  const tests = given.map(([k, v]) => (s: string) => VISIT_TEST[k](v, s));
  const agentTests = given.map(([k, v]) => AGENT_TEST[k](v));
  const day = (at: string) => `to_char(${at} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  /** The site's own agents, as a test on an event's user agent. */
  const ours = `coalesce(props->>'ua', '') ILIKE ANY(${$(ownAgents.map(a => `%${a}%`))}::text[])`;

  /**
   * The queries in one kind of event, most asked first. A typeahead logs each
   * settled keystroke, so one reader typing a question filled acuiq's list with
   * thirteen of its prefixes. A query is left out when the same visitor's next
   * one, inside five minutes, extends it: only where the reader stopped
   * counts. So is a single character. `unless` drops events whose props hold it.
   */
  const queries = (g: Gap, unless?: Record<string, string>) => {
    const prop = $(g.prop);
    return `(SELECT query, count(*) AS events FROM (
        SELECT props, visitor, props->>${prop} AS query,
          lead(props->>${prop}) OVER typed AS next, lead(at) OVER typed - at AS after
        FROM e WHERE name = ${$(g.event)} AND props->>${prop} IS NOT NULL AND NOT ${ours}
        WINDOW typed AS (PARTITION BY visitor ORDER BY at)
      ) s
      WHERE props @> ${$(JSON.stringify(g.where ?? {}))}::jsonb AND char_length(query) > 1
        ${unless ? `AND NOT props @> ${$(JSON.stringify(unless))}::jsonb` : ''}
        AND NOT coalesce(visitor IS NOT NULL AND after <= interval '5 minutes' AND char_length(next) > char_length(query) AND starts_with(next, query), false)
      GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 15)`;
  };
  const searches = { event: SEARCH_GAPS.event, prop: SEARCH_GAPS.prop };
  const json = (select: string) => `(SELECT coalesce(json_agg(t), '[]') FROM ${select} t)`;

  /**
   * One window's views, visits, events and archived days as CTEs whose names
   * end in `s`: this window with `back` 0, the one before it with 1.
   */
  const chain = (s: string, back: 0 | 1) => {
    const ago = (k: number) => `now() - make_interval(days => ${k} * $2::int)`;
    const dayAgo = (k: number) => `(now() AT TIME ZONE 'UTC' - make_interval(days => ${k} * $2::int))::date`;
    const at = `"createdAt" >= ${ago(back + 1)}${back ? ` AND "createdAt" < ${ago(back)}` : ''}`;
    return `viewed${s} AS (
      SELECT id, path, source, country, device, visitor, engaged, "createdAt" AS at FROM "View" WHERE "siteId" = $1 AND ${at}
    ), marked${s} AS (
      SELECT *, CASE WHEN at - lag(at) OVER (PARTITION BY visitor ORDER BY at, id) <= interval '30 minutes' THEN 0 ELSE 1 END AS starts FROM viewed${s}
    ), numbered${s} AS (
      SELECT *, sum(starts) OVER (PARTITION BY visitor ORDER BY at, id) AS visit FROM marked${s}
    ), bots${s} AS (
      SELECT source FROM (SELECT visitor, (array_agg(source ORDER BY at, id))[1] AS source, count(*) AS views FROM numbered${s} GROUP BY visitor, visit) f
      WHERE source IS NOT NULL GROUP BY 1 HAVING count(DISTINCT visitor) >= ${BOT_VISITORS} AND max(views) = 1
    ), visits${s} AS (
      SELECT visitor, visit, min(at) AS at, count(*) = 1 AND NOT bool_or(engaged) AS bounced,
        (array_agg(path ORDER BY at, id))[1] AS entry, ${visitSource(s)} AS source
      FROM numbered${s} GROUP BY visitor, visit${tests.length ? ` HAVING ${tests.map(t => t(s)).join(' AND ')}` : ''}
    ), v${s} AS (
      ${tests.length ? `SELECT n.id, n.path, n.source, n.country, n.device, n.visitor, n.engaged, n.at FROM numbered${s} n JOIN visits${s} USING (visitor, visit)` : `SELECT * FROM viewed${s}`}
    ), read${s} AS (
      SELECT visitor, "createdAt" AS at, path, props->>'country' AS country, ${AGENT_NAME} AS agent FROM "Event"
      WHERE "siteId" = $1 AND ${at} AND name IN ('AI Bot Visit', 'MCP Call') AND visitor IS NOT NULL AND NOT ${ours}
    ), ag${s} AS (
      SELECT * FROM read${s}${agentTests.length ? ` WHERE visitor IN (SELECT visitor FROM read${s} GROUP BY 1 HAVING ${agentTests.join(' AND ')})` : ''}
    ), e${s} AS (
      SELECT name, props, visitor, "createdAt" AS at FROM "Event" WHERE "siteId" = $1 AND ${at}
      ${tests.length ? `AND (visitor IN (SELECT visitor FROM v${s}) OR visitor IN (SELECT visitor FROM ag${s}))` : ''}
    ), a${s} AS (
      SELECT * FROM "ViewDay" WHERE "siteId" = $1 AND day >= ${dayAgo(back + 1)}${back ? ` AND day < ${dayAgo(back)}` : ''}${tests.length ? ' AND false' : ''}
    ), archived${s} AS (
      SELECT coalesce(sum(visitors), 0) AS visitors, coalesce(sum(pageviews), 0) AS pageviews, coalesce(sum(visits), 0) AS visits FROM a${s}
    )`;
  };
  /**
   * A figure engagement decides. The window before has it only where
   * engagement was counted from its first day: its first engaged view is on the day of its first view.
   */
  const engagement = (s: string, figure: string) => {
    if (!s) return figure;
    const first = (where: string) => `(SELECT ${day('min(at)')} FROM viewed${s}${where})`;
    return `CASE WHEN ${first(' WHERE engaged')} = ${first('')} THEN ${figure} END`;
  };
  /** One window's headline figures, as `json_build_object` arguments. */
  const headline = (s: string) => `'visitors', (SELECT count(DISTINCT visitor) FROM v${s}) + (SELECT visitors FROM archived${s}),
      'engaged', ${engagement(s, `(SELECT count(DISTINCT visitor) FROM v${s} WHERE engaged)`)},
      'pageviews', (SELECT count(*) FROM v${s}) + (SELECT pageviews FROM archived${s}),
      'visits', (SELECT count(*) FROM visits${s}) + (SELECT visits FROM archived${s}),
      'bounce_rate', ${engagement(s, `(SELECT round(100.0 * count(*) FILTER (WHERE bounced) / nullif(count(*), 0)) FROM visits${s})`)},
      'agents', (SELECT count(DISTINCT visitor) FROM ag${s})`;

  const [row] = (await sql(
    `WITH ${chain('', 0)}, ${chain('_p', 1)}, src AS (
      SELECT coalesce(source, '(none)') AS source, count(DISTINCT visitor) AS visitors FROM visits GROUP BY 1
      UNION ALL SELECT key, value::int FROM a, jsonb_each_text(a.sources)
    )
    SELECT json_build_object(
      ${headline('')},
      'previous', json_build_object(${headline('_p')}, 'follow_clicks', ${follows ? `(SELECT count(*) FROM e_p WHERE ${follows})` : 'NULL'}),
      'counted_from', (SELECT ${day('min("createdAt")')} FROM "View" WHERE "siteId" = $1),
      'engaged_from', (SELECT ${day('min(at)')} FROM (SELECT at FROM viewed_p WHERE engaged UNION ALL SELECT at FROM viewed WHERE engaged) t),
      'top_sources', ${list('SELECT source, sum(visitors) AS visitors FROM src GROUP BY 1', 6)},
      'top_pages', ${list(
        merged('page', 'pages', 'SELECT path, count(DISTINCT visitor) FROM v GROUP BY 1'),
        6,
      )},
      'entry_pages', ${list(merged('page', 'entryPages', 'SELECT entry, count(DISTINCT visitor) FROM visits GROUP BY 1'), 6)},
      'from_posts', ${list(`SELECT entry AS page, count(DISTINCT visitor) AS visitors FROM visits WHERE source = 'x' GROUP BY 1`, 15)},
      'sibling_referrals', ${list(`SELECT source, sum(visitors) AS visitors FROM src WHERE source = ANY(${$(siblings)}::text[]) GROUP BY 1`, 6)},
      'countries', ${list(merged('country', 'countries', 'SELECT country, count(DISTINCT visitor) FROM v WHERE country IS NOT NULL GROUP BY 1'), 10)},
      'devices', ${list(merged('device', 'devices', 'SELECT device, count(DISTINCT visitor) FROM v GROUP BY 1'))},
      'by_day', ${list(
        `SELECT date, sum(visitors) AS visitors, sum(engaged) AS engaged, sum(pageviews) AS pageviews, sum(visits) AS visits, sum(bounces) AS bounces,
          sum(agents) AS agents, sum(follows) AS follow_clicks FROM (
          SELECT ${day('at')}, count(DISTINCT visitor), count(DISTINCT visitor) FILTER (WHERE engaged), count(*), 0, 0, 0, 0 FROM v GROUP BY 1
          UNION ALL SELECT ${day('at')}, 0, 0, 0, count(*), count(*) FILTER (WHERE bounced), 0, 0 FROM visits GROUP BY 1
          UNION ALL SELECT ${day('at')}, 0, 0, 0, 0, 0, count(DISTINCT visitor), 0 FROM ag GROUP BY 1
          ${follows ? `UNION ALL SELECT ${day('at')}, 0, 0, 0, 0, 0, 0, count(*) FROM e WHERE ${follows} GROUP BY 1` : ''}
          UNION ALL SELECT to_char(day, 'YYYY-MM-DD'), visitors, 0, pageviews, visits, 0, 0, 0 FROM a
        ) t(date, visitors, engaged, pageviews, visits, bounces, agents, follows) GROUP BY 1`,
        undefined,
        '1',
      )},
      'follow_clicks', ${
        follows ? `(SELECT json_build_object('events', count(*), 'visitors', count(DISTINCT visitor)) FROM e WHERE ${follows})` : 'NULL'
      },
      'top_agents', ${list('SELECT agent, count(DISTINCT visitor) AS visitors FROM ag GROUP BY 1', 10)},
      'agent_tool_calls', ${list(
        `SELECT coalesce(props->>'tool', '(none)') AS tool, count(*) AS events FROM e
         WHERE name = 'MCP Call' AND props->>'method' = 'tools/call' AND NOT ${ours}
         GROUP BY 1`,
        10,
      )},
      'agent_feedback', ${list(
        `SELECT ${day('at')} AS date, props->>'kind' AS kind, props->>'message' AS message, props->>'page' AS page, ${AGENT_NAME} AS agent
         FROM e WHERE name = 'Agent Feedback' AND NOT ${ours}`,
        20,
        'at DESC',
      )},
      'searches', ${json(queries(searches, { surface: MCP_SURFACE }))},
      'agent_searches', ${json(queries({ ...searches, where: { surface: MCP_SURFACE } }))},
      'gaps', ${gaps.length ? json(`(${gaps.map(g => queries(g)).join(' UNION ALL ')})`) : `'[]'::json`}
    ) AS digest`,
    ...values,
  )) as { digest: Digest }[];
  const d = row!.digest;
  // Before the site counted itself only ViewDay speaks, and it holds no
  // events and no visits a filter could pick out.
  const before = new Date(Date.now() - 2 * (values[1] as number) * 86_400_000).toISOString().slice(0, 10);
  if (d.counted_from && before < d.counted_from) {
    const p = d.previous;
    if (tests.length) for (const k of Object.keys(p) as (keyof typeof p)[]) p[k] = null;
    else p.agents = p.follow_clicks = p.engaged = p.bounce_rate = null;
  }
  return d;
}

/**
 * Props for an "MCP Call" event, read out of the JSON-RPC envelope.
 *
 * The body is untrusted and may be a batch, a notification, or malformed
 * entirely, so every extraction is defensive and the result is always a
 * complete props object. A batch is attributed to its first member – the
 * alternative is one event per member, which would make a fan-out look like
 * traffic it is not.
 */
export function mcpCallProps(
  request: { headers: HeaderReader; url: string },
  body: unknown,
  server?: string,
): Record<string, string> {
  const first = (Array.isArray(body) ? body[0] : body) as
    | { method?: unknown; params?: { name?: unknown } }
    | undefined;
  const method = typeof first?.method === 'string' ? first.method : 'unknown';
  const tool = typeof first?.params?.name === 'string' ? first.params.name : undefined;
  const ua = (request.headers.get('user-agent') || 'unknown').slice(0, 80);
  return { ...(server ? { server } : {}), method, ...(tool ? { tool } : {}), ua };
}

export interface SearchQueryInput {
  /** The settled query the typeahead debounce actually dispatched. */
  query: string;
  /** How many rows came back. Zero is the interesting case. */
  results: number;
  /** Which search box, when a site has more than one. */
  surface?: string;
}

/**
 * Props for a "Search Query" event – the human-side twin of `mcpCallProps`.
 *
 * A wiki instruments its agent surface and then counts every question an agent
 * asks while recording none of the questions a person asks. The queries that
 * return nothing are the valuable ones: they name a gap in the corpus in the
 * reader's own words, which is otherwise only ever guessed at.
 *
 * Returns `null` for a query with no content, so an empty field cannot fire an
 * event. The text is untrusted, so it is collapsed, lowercased for aggregation
 * and truncated – the same 64-character bound search itself applies, which
 * keeps the prop and the query that produced it the same string.
 *
 * @internal
 */
export function searchQueryProps({
  query,
  results,
  surface,
}: SearchQueryInput): Record<string, string> | null {
  const q = (query ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 64);
  if (!q) return null;
  return {
    q,
    // A string, so `{ results: '0' }` is the filter that yields the gap list.
    results: String(Math.max(0, Math.trunc(results) || 0)),
    ...(surface ? { surface } : {}),
  };
}

// ---- the app binding --------------------------------------------------------

export interface TrackerOptions {
  sql: Sql;
  /** `after` in Next: the write runs once the response has gone. */
  defer: (task: () => Promise<unknown>) => void;
  /**
   * Whether anything is recorded. Default: only on a Vercel production
   * deployment, because dev and previews write to production's database.
   */
  enabled?: boolean;
  /** Where an event with no page of its own is filed: a search with no referer. Default `/`. */
  siteUrl?: string;
}

/** Headers in hand, or a reader for them run inside the deferred write: Next's `headers`. */
export type HeaderSource = HeaderReader | (() => HeaderReader | Promise<HeaderReader>);

export interface Tracker {
  /**
   * Record one event. `headers` are the request of whoever caused it, so the
   * event joins their visitor, an agent's included; omit them for an event no
   * visitor caused. Never rejects, and the caller defers it: `event.waitUntil`
   * in a proxy, `after` in a route.
   */
  trackEvent(name: string, url: string, props: Record<string, string | number>, headers?: HeaderReader): Promise<void>;
  /**
   * An "MCP Call" event, deferred. The signature is `McpServerConfig.onCall`'s
   * plus a server name, so a one-server site passes it as `onCall` as it is.
   */
  trackMcpCall(request: Request, body: unknown, server?: string): void;
  /**
   * A "Search Query" event, deferred, filed against the page the reader
   * searched from. A function for `headers` is called inside the deferred
   * write, and a failure there drops the event rather than the response.
   */
  trackSearch(headers: HeaderSource, query: string, results: number, surface?: string): void;
  /**
   * An "Agent Feedback" event, deferred: `feedbackTool`'s recorder, passed as
   * it is. The digest lists them under `agent_feedback`.
   */
  trackFeedback(report: AgentFeedback, request?: Request): void;
  /**
   * The beacon route: `export const POST = tracker.viewRoute()`. `site` is
   * `collect`'s resolver, for an app that serves many sites or drops a path.
   */
  viewRoute(opts?: Pick<CollectOptions, 'site' | 'rateLimit'>): (request: Request) => Promise<Response>;
}

/**
 * Everything an app's `track.ts` had written around the functions above: the
 * production gate, the deferral and the three named events. Four apps carried
 * it, two with a search signature of their own.
 *
 * The tracker holds `sql`, so the module that builds it imports the app's
 * database client. A proxy must keep reaching it through a dynamic import
 * inside `waitUntil`, never a static one, or every request the proxy sees
 * loads Prisma — `trackAiBot` (`wiki-formant/crawlers`) is that call:
 *
 *   trackAiBot(request, event, () => import('@/lib/track'));
 */
export function createTracker({
  sql,
  defer,
  enabled = typeof process !== 'undefined' && process.env.VERCEL_ENV === 'production',
  siteUrl = '/',
}: TrackerOptions): Tracker {
  const trackEvent: Tracker['trackEvent'] = (name, url, props, headers) =>
    enabled ? recordEvent(sql, { name, url, props, headers }) : Promise.resolve();

  return {
    trackEvent,
    trackMcpCall(request, body, server) {
      if (!enabled) return;
      const props = mcpCallProps(request, body, server);
      const { url, headers } = request;
      defer(() => trackEvent('MCP Call', url, props, headers));
    },
    trackSearch(source, query, results, surface) {
      if (!enabled) return;
      const props = searchQueryProps({ query, results, surface });
      if (!props) return;
      defer(async () => {
        try {
          const headers = typeof source === 'function' ? await source() : source;
          const ua = (headers.get('user-agent') || 'unknown').slice(0, 80);
          await trackEvent('Search Query', headers.get('referer') || siteUrl, { ...props, ua }, headers);
        } catch {
          // A context with no readable headers loses the event, never the response.
        }
      });
    },
    trackFeedback(report, request) {
      if (!enabled) return;
      const ua = (request?.headers.get('user-agent') || 'unknown').slice(0, 80);
      defer(() => trackEvent('Agent Feedback', request?.url ?? siteUrl, { ...report, ua }, request?.headers));
    },
    viewRoute(opts = {}) {
      return async request =>
        enabled ? collect(request, { sql, defer, ...opts }) : new Response(null, { status: 204 });
    },
  };
}
