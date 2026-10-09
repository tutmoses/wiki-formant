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
// all supply in a line. The app declares the four tables in its own schema,
// so `prisma db push` keeps them:
//
//   model View {
//     id        BigInt   @id @default(autoincrement())
//     siteId    String   @default("")
//     path      String
//     source    String?
//     country   String?
//     device    String
//     visitor   String
//     createdAt DateTime @default(now()) @db.Timestamptz(3)
//     @@index([siteId, createdAt])
//   }
//
//   model Event {
//     id        BigInt   @id @default(autoincrement())
//     siteId    String   @default("")
//     name      String
//     path      String?
//     props     Json     @default("{}")
//     visitor   String?
//     createdAt DateTime @default(now()) @db.Timestamptz(3)
//     @@index([siteId, name, createdAt])
//   }
//
//   model Salt {
//     day   String @id
//     value String
//   }
//
//   model ViewDay {
//     siteId     String   @default("")
//     day        DateTime @db.Date
//     visitors   Int
//     pageviews  Int
//     visits     Int
//     bounces    Int
//     seconds    Int
//     pages      Json     @default("{}")
//     entryPages Json     @default("{}")
//     sources    Json     @default("{}")
//     countries  Json     @default("{}")
//     devices    Json     @default("{}")
//     @@id([siteId, day])
//   }
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

/** iPadOS reports itself as a Mac, so its views count as a computer's. */
export const deviceOf = (ua: string): 'phone' | 'tablet' | 'computer' =>
  /iPad|Tablet|Android(?!.*Mobile)/i.test(ua) ? 'tablet' : /Mobi|iPhone|Android/i.test(ua) ? 'phone' : 'computer';

const bareHost = (host: string) => host.toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');

/**
 * Where a visit came from: its `utm_source` when the link carried one, else the
 * referring host, and null for a referrer that is this site or none.
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

/** A browser path as stored: decoded, one leading slash, no trailing one. Null when it will not decode. */
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

/** Count one page view, unless a bot sent it. Never rejects. */
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
    return sql(
      'INSERT INTO "Event" ("siteId", name, path, props, visitor) VALUES ($1, $2, $3, $4::jsonb, $5)',
      site,
      name.slice(0, 64),
      path,
      JSON.stringify(props),
      headers?.get('user-agent') ? await visitorOf(sql, site, headers) : null,
    );
  });
}

/** What a page sends: a view, or with `name` an event. */
export interface Beacon {
  path: string;
  referrer?: string;
  utm?: string;
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
  const path = typeof body?.path === 'string' ? normalisePath(body.path) : null;
  if (!body || !path) return done;
  const key = site ? await site(request, path) : '';
  if (key === null) return done;

  defer(() =>
    typeof body.name === 'string' && body.name
      ? recordEvent(sql, { name: body.name, props: beaconProps(body.props), url: path, headers, site: key })
      : recordView(sql, { headers, path, referrer: body.referrer, utm: body.utm, site: key }),
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

/** Searches in a wiki's own search box that found nothing (`searchQueryProps` events). */
export const SEARCH_GAPS: Gap = { event: 'Search Query', prop: 'q', where: { results: '0', surface: 'wiki' } };

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
   * MCP callers left out of `agent_tool_calls`, matched inside the user agent.
   * The default is the conformance suites (`<repo>-mcp-test`) and the studio's own tools.
   */
  ownAgents?: string[];
}

type Ranked<K extends string, M extends string> = Array<Record<K, string> & Record<M, number>>;

export interface Digest {
  visitors: number;
  pageviews: number;
  /** Percent of visits that saw one page; null with no visits. */
  bounce_rate: number | null;
  /** Mean seconds from a visit's first view to its last; null with no visits. */
  visit_duration: number | null;
  /** Visitors plus every agent that sent an event, such as an MCP call. */
  visitors_incl_agents: number;
  /** Visitors in the same number of days before. */
  previous_visitors: number;
  top_sources: Ranked<'source', 'visitors'>;
  top_pages: Ranked<'page', 'visitors'>;
  entry_pages: Ranked<'page', 'visitors'>;
  /** Entry pages of visits from links tagged `utm_source=x`. */
  from_posts: Ranked<'page', 'visitors'>;
  sibling_referrals: Ranked<'source', 'visitors'>;
  countries: Ranked<'country', 'visitors'>;
  devices: Ranked<'device', 'visitors'>;
  by_day: Ranked<'date', 'visitors'>;
  follow_clicks: { events: number; visitors: number } | null;
  agent_tool_calls: Ranked<'tool', 'events'>;
  gaps: Ranked<'query', 'events'>;
}

/**
 * Everything a report needs about one site's last `days` days, in one query.
 * Visitor figures count distinct visitors, so a person who comes back on
 * another day counts once for each day. Days in `ViewDay` add to the visitor,
 * page, source, country, device and per-day figures; events have no history.
 */
export async function digest(
  sql: Sql,
  { site = '', days, handle, siblings = [], gaps = [SEARCH_GAPS], ownAgents = ['-mcp-test', 'radix-studio'] }: DigestOptions,
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

  const gapSelects = gaps.map(g => {
    const prop = $(g.prop);
    return `(SELECT props->>${prop} AS query, count(*) AS events FROM e
      WHERE name = ${$(g.event)} AND props @> ${$(JSON.stringify(g.where ?? {}))}::jsonb AND props->>${prop} IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 15)`;
  });

  const [row] = (await sql(
    `WITH v AS (
      SELECT id, path, source, country, device, visitor, "createdAt" AS at FROM "View"
      WHERE "siteId" = $1 AND "createdAt" >= now() - make_interval(days => $2::int)
    ), marked AS (
      SELECT *, CASE WHEN at - lag(at) OVER (PARTITION BY visitor ORDER BY at, id) <= interval '30 minutes' THEN 0 ELSE 1 END AS starts FROM v
    ), numbered AS (
      SELECT *, sum(starts) OVER (PARTITION BY visitor ORDER BY at, id) AS visit FROM marked
    ), visits AS (
      SELECT visitor, count(*) AS views, extract(epoch FROM max(at) - min(at)) AS seconds,
        (array_agg(path ORDER BY at, id))[1] AS entry, (array_agg(source ORDER BY at, id))[1] AS source
      FROM numbered GROUP BY visitor, visit
    ), e AS (
      SELECT name, props, visitor FROM "Event" WHERE "siteId" = $1 AND "createdAt" >= now() - make_interval(days => $2::int)
    ), a AS (
      SELECT * FROM "ViewDay" WHERE "siteId" = $1 AND day >= (now() AT TIME ZONE 'UTC' - make_interval(days => $2::int))::date
    ), sessions AS (
      SELECT sum(bounces) AS bounces, sum(visits) AS visits, sum(seconds) AS seconds FROM (
        SELECT count(*) FILTER (WHERE views = 1), count(*), coalesce(sum(seconds), 0) FROM visits
        UNION ALL SELECT coalesce(sum(bounces), 0), coalesce(sum(visits), 0), coalesce(sum(seconds), 0) FROM a
      ) s(bounces, visits, seconds)
    ), src AS (
      SELECT coalesce(source, '(none)') AS source, count(DISTINCT visitor) AS visitors FROM visits GROUP BY 1
      UNION ALL SELECT key, value::int FROM a, jsonb_each_text(a.sources)
    ), archived AS (
      SELECT coalesce(sum(visitors), 0) AS visitors, coalesce(sum(pageviews), 0) AS pageviews FROM a
    )
    SELECT json_build_object(
      'visitors', (SELECT count(DISTINCT visitor) FROM v) + (SELECT visitors FROM archived),
      'pageviews', (SELECT count(*) FROM v) + (SELECT pageviews FROM archived),
      'bounce_rate', (SELECT round(100.0 * bounces / nullif(visits, 0)) FROM sessions),
      'visit_duration', (SELECT round(seconds / nullif(visits, 0)) FROM sessions),
      'visitors_incl_agents', (SELECT count(DISTINCT visitor) FROM (SELECT visitor FROM v UNION SELECT visitor FROM e) u) + (SELECT visitors FROM archived),
      'previous_visitors', (SELECT count(DISTINCT visitor) FROM "View"
        WHERE "siteId" = $1 AND "createdAt" >= now() - make_interval(days => 2 * $2::int) AND "createdAt" < now() - make_interval(days => $2::int))
        + (SELECT coalesce(sum(visitors), 0) FROM "ViewDay" WHERE "siteId" = $1
          AND day >= (now() AT TIME ZONE 'UTC' - make_interval(days => 2 * $2::int))::date
          AND day < (now() AT TIME ZONE 'UTC' - make_interval(days => $2::int))::date),
      'top_sources', ${list('SELECT source, sum(visitors) AS visitors FROM src GROUP BY 1', 6)},
      'top_pages', ${list(merged('page', 'pages', 'SELECT path, count(DISTINCT visitor) FROM v GROUP BY 1'), 6)},
      'entry_pages', ${list(merged('page', 'entryPages', 'SELECT entry, count(DISTINCT visitor) FROM visits GROUP BY 1'), 6)},
      'from_posts', ${list(`SELECT entry AS page, count(DISTINCT visitor) AS visitors FROM visits WHERE source = 'x' GROUP BY 1`, 15)},
      'sibling_referrals', ${list(`SELECT source, sum(visitors) AS visitors FROM src WHERE source = ANY(${$(siblings)}::text[]) GROUP BY 1`, 6)},
      'countries', ${list(merged('country', 'countries', 'SELECT country, count(DISTINCT visitor) FROM v WHERE country IS NOT NULL GROUP BY 1'), 10)},
      'devices', ${list(merged('device', 'devices', 'SELECT device, count(DISTINCT visitor) FROM v GROUP BY 1'))},
      'by_day', ${list(
        `SELECT date, sum(n) AS visitors FROM (
          SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), count(DISTINCT visitor) FROM v GROUP BY 1
          UNION ALL SELECT to_char(day, 'YYYY-MM-DD'), visitors FROM a
        ) t(date, n) GROUP BY 1`,
        undefined,
        '1',
      )},
      'follow_clicks', ${
        handle
          ? `(SELECT json_build_object('events', count(*), 'visitors', count(DISTINCT visitor)) FROM e
              WHERE name = 'Outbound Link: Click' AND props->>'url' ILIKE ANY(${$([`%x.com/${handle}%`, `%twitter.com/${handle}%`])}::text[]))`
          : 'NULL'
      },
      'agent_tool_calls', ${list(
        `SELECT coalesce(props->>'tool', '(none)') AS tool, count(*) AS events FROM e
         WHERE name = 'MCP Call' AND props->>'method' = 'tools/call'
           AND NOT coalesce(props->>'ua', '') ILIKE ANY(${$(ownAgents.map(a => `%${a}%`))}::text[])
         GROUP BY 1`,
        10,
      )},
      'gaps', ${gapSelects.length ? `(SELECT coalesce(json_agg(t), '[]') FROM (${gapSelects.join(' UNION ALL ')}) t)` : `'[]'::json`}
    ) AS digest`,
    ...values,
  )) as { digest: Digest }[];
  return row!.digest;
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
          await trackEvent('Search Query', headers.get('referer') || siteUrl, props, headers);
        } catch {
          // A context with no readable headers loses the event, never the response.
        }
      });
    },
    viewRoute(opts = {}) {
      return async request =>
        enabled ? collect(request, { sql, defer, ...opts }) : new Response(null, { status: 204 });
    },
  };
}
