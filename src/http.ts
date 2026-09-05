// http.ts — conditional-GET plumbing for text corpus endpoints.
//
// The three llms depths (llms.txt / llms-index.txt / llms-full.txt) are the
// most-recrawled URLs a wiki serves and the most expensive to render. With a
// corpus-derived ETag a recrawl costs a 304 instead of a full corpus build.
// Without one, every AI crawler pays full price on every pass, forever.

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
): Response | null {
  const headers: Record<string, string> = {
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
  return notModified(request, etag) ?? new Response(text, { headers: descriptorHeaders(etag, opts) });
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
  const stamp = opts.updated
    ? (typeof opts.updated === 'string' ? opts.updated : opts.updated.toISOString()).split('T')[0]
    : '';
  return `- [${opts.title}](${opts.url})${excerpt}${stamp ? ` _(updated ${stamp})_` : ''}`;
}
