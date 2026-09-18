// http.ts — conditional-GET plumbing for text corpus endpoints.
//
// The three llms depths (llms.txt / llms-index.txt / llms-full.txt) are the
// most-recrawled URLs a wiki serves and the most expensive to render. With a
// corpus-derived ETag a recrawl costs a 304 instead of a full corpus build.
// Without one, every AI crawler pays full price on every pass, forever.

import { isoDate } from './html.js';

/** A stable ETag from whatever the corpus revision is (count + newest stamp). */
export function corpusEtag(parts: Array<string | number | Date | null | undefined>): string {
  const seed = parts
    .map(p => (p instanceof Date ? p.toISOString() : String(p ?? '')))
    .join('|');
  // FNV-1a: short, stable across processes, and no dependency. Collisions do
  // not matter here — the seed already carries the count and the newest stamp.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `W/"${hash.toString(36)}-${seed.length.toString(36)}"`;
}

/** Weak comparison per RFC 9110 8.8.3.2: the `W/` prefix never affects a match. */
const bareTag = (tag: string) => tag.trim().replace(/^W\//, '');

/**
 * 304 when the client already holds this revision, else `null` to render.
 *
 * Both validators are matched the way RFC 9110 defines them rather than by
 * string equality, because equality is wrong in the cases that actually occur:
 * a client sends every tag it holds as a list, a proxy adds or strips the weak
 * prefix, and a crawler reformats the date. Each of those took a full render
 * from a response that was already fresh.
 */
export function notModified(
  request: Request,
  etag: string,
  lastModified?: string | null,
  /**
   * The headers the 200 would carry. RFC 9110 15.4.5 requires a 304 to send
   * the Cache-Control and Vary a 200 would have, and a cross-origin client
   * needs the CORS header on it too; without them a revalidated copy loses its
   * freshness and a negotiated URL loses its Vary. The body's own headers
   * (Content-Type, Content-Length) are dropped.
   */
  sent: Record<string, string> = {},
): Response | null {
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(sent).filter(([k]) => !/^content-(type|length)$/i.test(k))),
    ETag: etag,
    ...(lastModified ? { 'Last-Modified': lastModified } : {}),
  };

  const inm = request.headers.get('if-none-match');
  if (inm) {
    const fresh = inm.trim() === '*' || inm.split(',').some(t => bareTag(t) === bareTag(etag));
    // When If-None-Match is present If-Modified-Since must be ignored entirely.
    return fresh ? new Response(null, { status: 304, headers }) : null;
  }

  const ims = request.headers.get('if-modified-since');
  if (!ims || !lastModified) return null;
  const held = Date.parse(ims);
  const current = Date.parse(lastModified);
  if (!Number.isFinite(held) || !Number.isFinite(current)) return null;
  // Second precision: the header carries no sub-second part, so a stamp that
  // rounds down would otherwise read as newer than the copy it was sent for.
  return Math.floor(current / 1000) <= Math.floor(held / 1000)
    ? new Response(null, { status: 304, headers })
    : null;
}

/**
 * A 404 that teaches, for the plain-GET half of an agent surface.
 *
 * The MCP half of every server here answers a wrong identifier by naming the
 * tools that find a right one. The GET half, reached by exactly the agents that
 * guessed a URL, answered the same mistake with `Page not found`, `Not found`,
 * and in one case a 26 KB HTML error page — nothing to retry from. `hints` are
 * merged into the body, so an index URL or a nearest match rides along. A
 * missing page is a hot crawler path, so it is cacheable by default; pass
 * `cacheControl` where the surface has its own edge posture.
 */
export function teachingNotFound(
  message: string,
  hints: Record<string, unknown> = {},
  cacheControl = 'public, max-age=60',
): Response {
  return Response.json({ error: message, ...hints }, {
    status: 404,
    headers: { 'Cache-Control': cacheControl },
  });
}

/**
 * Headers for a plain-text export. `maxAge` is the edge window — a curated
 * corpus can sit on hours, a projection of live data should pass a short one.
 */
export function textHeaders(
  etag: string,
  lastModified: string,
  maxAge = 3600,
): Record<string, string> {
  return {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 24}`,
    ETag: etag,
    'Last-Modified': lastModified,
  };
}

/**
 * Headers for a markdown twin. Separate from `textHeaders` because the twin is
 * addressed per page and carries its own `Last-Modified`, and because a client
 * that asked for `.md` should not be handed `text/plain`.
 *
 * `lastModified` is optional because not every corpus has a row timestamp to
 * offer, and a twin that stamps the epoch is worse than one that stamps
 * nothing. `extra` carries whatever the mount needs on top — an `X-Robots-Tag`
 * where the twin is a second public URL with no canonical of its own.
 *
 * Pass `etag`. The twin is the single most recrawled URL a page has, and a
 * response with no validator is a full render on every pass forever — the same
 * arithmetic that justifies the corpus ETag, applied per page. Three wikis
 * shipped twins with neither validator and only 304'd where a proxy happened to
 * synthesise one; that is why it is spelled out here rather than left optional
 * in spirit.
 */
export function markdownHeaders(
  lastModified?: string | null,
  opts: { maxAge?: number; etag?: string; extra?: Record<string, string> } = {},
): Record<string, string> {
  const maxAge = opts.maxAge ?? 3600;
  return {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Cache-Control': `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 24}`,
    ...(opts.etag ? { ETag: opts.etag } : {}),
    ...(lastModified ? { 'Last-Modified': lastModified } : {}),
    ...opts.extra,
  };
}

/**
 * Whether a request to a URL that serves both JSON and markdown asked for the
 * markdown: `?format=text`, or an Accept naming text/markdown or text/plain.
 * The `.md` suffix is the caller's to add — it lives in the path, not here.
 *
 * Both branches of such a route must send `VARY_ACCEPT`. Two wikis answered
 * one URL in two formats under `public, s-maxage` with no Vary, so a shared
 * cache could hand the markdown to the next JSON client, or the reverse.
 */
export function wantsMarkdown(request: { url: string; headers: { get(name: string): string | null } }): boolean {
  return (
    new URL(request.url).searchParams.get('format') === 'text' ||
    /text\/(markdown|plain)/.test(request.headers.get('accept') ?? '')
  );
}

/** The header every response from a content-negotiated URL carries. */
export const VARY_ACCEPT = { Vary: 'Accept' } as const;

/**
 * Headers for a JSON descriptor — an agent card, an OpenAPI document, a
 * registry manifest. These are the documents a client refetches most and the
 * ones that had no validator at all: served as `Cache-Control: public` with no
 * `max-age`, a caller falls back to heuristic freshness and can never
 * revalidate, so a corrected card takes an unbounded time to reach anyone.
 */
export function descriptorHeaders(
  etag: string,
  opts: { maxAge?: number; extra?: Record<string, string> } = {},
): Record<string, string> {
  const maxAge = opts.maxAge ?? 86400;
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': `public, max-age=300, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 7}`,
    ETag: etag,
    ...opts.extra,
  };
}

/**
 * A JSON descriptor served with a validator, answering a conditional GET.
 *
 * The body is its own ETag source, so the tag moves exactly when the document
 * does and never otherwise. Every descriptor route in this workspace was a
 * hand-rolled `NextResponse.json` with a Cache-Control and no validator at all,
 * which is why a corrected agent card took an unbounded time to reach anyone.
 */
export function descriptorResponse(
  request: Request,
  body: unknown,
  opts: { maxAge?: number; extra?: Record<string, string> } = {},
): Response {
  const text = JSON.stringify(body);
  const etag = corpusEtag([text]);
  const sent = descriptorHeaders(etag, opts);
  return notModified(request, etag, null, sent) ?? new Response(text, { headers: sent });
}

/** Strip URLs and collapse whitespace so an excerpt stays one readable line. */
export function cleanSnippet(text: string, max = 160): string {
  return text
    .replace(/\(https?:\/\/[^)]*\)/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

/** One markdown bullet: linked title, excerpt, and the date an agent diffs on. */
export function pageLine(opts: {
  title: string;
  url: string;
  excerpt?: string;
  updated?: Date | string | null;
}): string {
  const excerpt = opts.excerpt ? `: ${cleanSnippet(opts.excerpt)}` : '';
  const stamp = opts.updated ? isoDate(opts.updated) : '';
  return `- [${opts.title}](${opts.url})${excerpt}${stamp ? ` _(updated ${stamp})_` : ''}`;
}

// ---- route factories --------------------------------------------------------

/** The pair every corpus endpoint computes before it decides to render. */
export interface CorpusValidators {
  etag: string;
  lastModified: string;
}

/**
 * A GET handler serving `build()` under corpus validators — or a 304 instead.
 *
 * The build is not called on a 304, which is the whole point: these are the
 * most-recrawled and most expensive URLs a wiki serves, and rendering a corpus
 * to discard it is the cost this exists to avoid.
 *
 * `validators` is a thunk rather than a value because it is a query. The depth
 * or scope it closes over belongs in the seed — three depths sharing one ETag
 * is legal (a tag is scoped to its URI) and still wrong in the case that
 * matters: an edit to one depth's own preamble moves no page row, so the tag
 * would not move and the stale document would be served until something else
 * in the corpus changed.
 */
export function corpusRoute(
  validators: () => Promise<CorpusValidators> | CorpusValidators,
  build: () => Promise<string> | string,
  headers: (etag: string, lastModified: string) => Record<string, string> = textHeaders,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const { etag, lastModified } = await validators();
    const sent = headers(etag, lastModified);
    return notModified(request, etag, lastModified, sent) ?? new Response(await build(), { headers: sent });
  };
}
