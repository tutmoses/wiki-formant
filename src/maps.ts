// maps.ts — turn a map URL a human pasted into one an <iframe> will accept.
//
// Both wikis carried the parsing byte-for-byte apart from one `export`
// keyword. It is pure string work over Google and Apple Maps URL shapes. The
// shortener hop at the bottom is the one part that makes a request, and the
// part the two copies did NOT agree on.

export interface MapCoords {
  lat: number;
  lon: number;
  zoom?: number | undefined;
}

/** A plain embed URL for a coordinate pair. */
function mapsEmbedUrl(lat: number, lon: number, zoom = 15): string {
  return `https://maps.google.com/maps?q=${lat},${lon}&z=${zoom}&output=embed`;
}

/**
 * Dig a coordinate pair out of a maps URL. Four shapes in descending
 * specificity: the `@lat,lon,zoom` path segment, a `/search/lat,lon`, the
 * `!3d…!4d…` data blob, and finally an `ll`/`sll` query parameter.
 */
export function extractCoordsFromUrl(url: string): MapCoords | null {
  const coords = url.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*),?(\d+\.?\d*)?z?/);
  if (coords) return { lat: +coords[1]!, lon: +coords[2]!, zoom: coords[3] ? +coords[3] : undefined };

  const search = url.match(/\/search\/(-?\d+\.?\d*),[\s+]*(-?\d+\.?\d*)/);
  if (search) return { lat: +search[1]!, lon: +search[2]! };

  const data = url.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/);
  if (data) return { lat: +data[1]!, lon: +data[2]! };

  try {
    const params = new URL(url).searchParams;
    const ll = params.get('ll') ?? params.get('sll');
    if (ll) {
      const [lat, lon] = ll.split(',').map(Number);
      if (lat !== undefined && lon !== undefined && !isNaN(lat) && !isNaN(lon)) return { lat, lon };
    }
  } catch {
    /* not a valid URL */
  }
  return null;
}

/**
 * An embeddable URL for `url`, or null when it is not a map link this
 * understands. Already-embeddable URLs pass through untouched.
 */
export function toMapEmbedUrl(url: string): string | null {
  if (/google\.[a-z.]+\/maps\/embed/.test(url)) return url;
  if (/embed\.apple\.com\/maps/.test(url)) return url;

  const c = extractCoordsFromUrl(url);
  if (c) return mapsEmbedUrl(c.lat, c.lon, c.zoom);

  if (/google\.[a-z.]+\/maps/.test(url)) {
    const place = url.match(/\/place\/([^/@]+)/);
    if (place) {
      const q = encodeURIComponent(decodeURIComponent(place[1]!).replace(/\+/g, ' '));
      return `https://maps.google.com/maps?q=${q}&output=embed`;
    }
  }

  if (/maps\.apple\.com/.test(url)) {
    try {
      const u = new URL(url);
      const ll = u.searchParams.get('ll') ?? u.searchParams.get('sll');
      const q = u.searchParams.get('q') ?? u.searchParams.get('address');
      const params = new URLSearchParams();
      if (ll) params.set('ll', ll);
      if (q) params.set('q', q);
      return `https://embed.apple.com/maps?${params.toString()}`;
    } catch {
      return null;
    }
  }
  return null;
}

// ---- shortened links ---------------------------------------------------------
//
// A `maps.app.goo.gl` link only resolves through a redirect, which the editor
// cannot read cross-origin, so each wiki runs a route that follows it. One of
// the two copies matched its host as a SUBSTRING — `https://evil.example/?goo.gl`
// passed — then followed every redirect with no timeout and no login: an
// anonymous fetcher for any URL. The other followed one hop, between exact
// host lists, with a timeout, for signed-in members only. That one is below.

const SHORTLINK_HOSTS = new Set(['goo.gl', 'maps.app.goo.gl']);
/** Where a resolved shortlink may legitimately land. */
const RESOLVED_HOST = /(^|\.)(google\.[a-z.]+|apple\.com)$/;

const parse = (url: string, base?: URL): URL | null => {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
};

/** True for the shortener forms only a redirect can resolve. Exact hostnames, never a substring. */
export function isShortMapUrl(url: string): boolean {
  const u = parse(url);
  if (!u || !SHORTLINK_HOSTS.has(u.hostname)) return false;
  return u.hostname === 'maps.app.goo.gl' || u.pathname.startsWith('/maps');
}

/**
 * Follow a shortened maps link ONE hop, server-side, and return where it
 * lands — or null unless both ends are on the allowlists. Never follows a
 * redirect chain: every hop is a request to a host this code did not choose.
 */
export async function resolveShortMapUrl(
  url: string,
  { timeoutMs = 5_000 }: { timeoutMs?: number } = {},
): Promise<string | null> {
  const source = parse(url);
  if (!source || source.protocol !== 'https:' || !isShortMapUrl(url)) return null;
  try {
    const res = await fetch(source, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const location = res.headers.get('location');
    const target = location ? parse(location, source) : null;
    return target && target.protocol === 'https:' && RESOLVED_HOST.test(target.hostname) ? target.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The whole `GET /api/resolve-map?url=…` route. `authorize` is the wiki's own
 * sign-in check: the route makes an outbound request per call, so it belongs
 * behind the same gate as the editor that calls it.
 */
export function resolveMapHandler(opts: {
  authorize: (request: Request) => boolean | Promise<boolean>;
  timeoutMs?: number;
}): (request: Request) => Promise<Response> {
  return async request => {
    if (!(await opts.authorize(request))) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const url = new URL(request.url).searchParams.get('url') ?? '';
    if (!url.startsWith('https:') || !isShortMapUrl(url)) {
      return Response.json({ error: 'Invalid URL' }, { status: 400 });
    }
    const resolved = await resolveShortMapUrl(url, opts);
    return resolved
      ? Response.json({ resolved })
      : Response.json({ error: 'Failed to resolve' }, { status: 502 });
  };
}

/**
 * A pasted map URL as an embeddable one, following a shortener through the
 * wiki's resolve route when the URL cannot be read directly. The editor's map
 * node and embed dialog both take this as their `resolveMapUrl`.
 */
export async function resolveMapUrl(url: string, endpoint = '/api/resolve-map'): Promise<string | null> {
  const direct = toMapEmbedUrl(url);
  if (direct || !isShortMapUrl(url)) return direct;
  try {
    const res = await fetch(`${endpoint}?url=${encodeURIComponent(url)}`);
    const { resolved } = (await res.json()) as { resolved?: string };
    return resolved ? toMapEmbedUrl(resolved) : null;
  } catch {
    return null;
  }
}
