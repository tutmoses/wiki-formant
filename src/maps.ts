// maps.ts — turn a map URL a human pasted into one an <iframe> will accept.
//
// Both wikis carried this byte-for-byte apart from one `export` keyword. It is
// pure string work over Google and Apple Maps URL shapes, with no framework or
// database in it, which is why neither copy had a reason to diverge.

export interface MapCoords {
  lat: number;
  lon: number;
  zoom?: number | undefined;
}

/** A plain embed URL for a coordinate pair. */
export function mapsEmbedUrl(lat: number, lon: number, zoom = 15): string {
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
    const ll = new URL(url).searchParams.get('ll') ?? new URL(url).searchParams.get('sll');
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

/** True for the shortener forms that only a redirect can resolve. */
export const isShortMapUrl = (url: string): boolean =>
  /maps\.app\.goo\.gl|goo\.gl\/maps/.test(url);
