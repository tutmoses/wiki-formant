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

/** 304 when the client already holds this revision, else `null` to render. */
export function notModified(request: Request, etag: string, lastModified: string): Response | null {
  const inm = request.headers.get('if-none-match');
  const ims = request.headers.get('if-modified-since');
  const fresh = inm ? inm === etag : Boolean(ims && ims === lastModified);
  if (!fresh) return null;
  return new Response(null, { status: 304, headers: { ETag: etag, 'Last-Modified': lastModified } });
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
 */
export function markdownHeaders(
  lastModified?: string | null,
  opts: { maxAge?: number; extra?: Record<string, string> } = {},
): Record<string, string> {
  const maxAge = opts.maxAge ?? 3600;
  return {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Cache-Control': `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 24}`,
    ...(lastModified ? { 'Last-Modified': lastModified } : {}),
    ...opts.extra,
  };
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
