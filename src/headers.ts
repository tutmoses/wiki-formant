// headers.ts — the response headers every origin sends, and the CSP they share.
//
// Four `next.config.ts` files carried the same six headers and four
// hand-written policies, on the stated grounds that the config could not import
// this package. It could not because no subpath had a `default` condition, and
// Next resolves a config's imports the way `require` does; with one, Node 24
// loads the ESM module there unchanged. So the headers live here now, and the
// pairing the sanitiser's comment asked readers to keep by hand — `frame-src`
// against `DEFAULT_IFRAME_HOSTS` — is one list read twice. While it was kept by
// hand, one origin's policy dropped the bare `youtube.com` and
// `youtube-nocookie.com` its sanitiser kept, so those embeds survived cleaning
// and then rendered blank.
//
// Zero imports, so a config pays for nothing it does not use.

/** A header as Next's `headers()` wants it. */
export interface HeaderEntry {
  key: string;
  value: string;
}

/**
 * The embed hosts the editor's iframe, YouTube, tweet and map nodes produce:
 * the sanitiser's default `iframeHosts` and the default `frame-src`, so an
 * embed that clears one clears the other.
 */
export const DEFAULT_IFRAME_HOSTS: readonly string[] = [
  'www.youtube.com', 'youtube.com',
  'www.youtube-nocookie.com', 'youtube-nocookie.com',
  'platform.twitter.com',
  'www.google.com', 'maps.google.com',
  'embed.apple.com', 'maps.apple.com',
];

/** `frame-src` sources for a host list — the one a sanitiser was given. */
export const frameSources = (hosts: readonly string[] = DEFAULT_IFRAME_HOSTS): string[] =>
  hosts.length ? hosts.map(h => `https://${h}`) : ["'none'"];

/** CSP directive names this builder writes, in the order it writes them. */
export type CspDirective =
  | 'default-src' | 'base-uri' | 'object-src' | 'frame-ancestors' | 'form-action'
  | 'script-src' | 'style-src' | 'font-src' | 'img-src' | 'media-src'
  | 'connect-src' | 'frame-src' | 'worker-src' | 'manifest-src';

/**
 * The policy all four origins shared line for line. Everything a site adds is
 * a source list it hands `contentSecurityPolicy`, which replaces the default
 * for that directive rather than appending, so a reader sees the whole list.
 */
export const BASE_CSP: Readonly<Partial<Record<CspDirective, readonly string[]>>> = {
  'default-src': ["'self'"],
  'base-uri': ["'self'"],
  'object-src': ["'none'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'self'"],
  // Next's hydration scripts are inline. A nonce removes this, and a nonce
  // makes every page it covers render per request — caper takes it on its
  // dynamic routes only.
  'script-src': ["'self'", "'unsafe-inline'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'font-src': ["'self'", 'data:'],
  'img-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'frame-src': frameSources(),
};

/**
 * The policy string: `BASE_CSP` with each directive in `directives` replacing
 * its default. An empty list drops the directive.
 */
export function contentSecurityPolicy(
  directives: Partial<Record<CspDirective, readonly string[]>> = {},
): string {
  return Object.entries({ ...BASE_CSP, ...directives })
    .filter(([, sources]) => sources?.length)
    .map(([name, sources]) => `${name} ${sources!.join(' ')}`)
    .join('; ');
}

/**
 * The six headers every route sends, plus the policy when one is given.
 *
 * Pass the policy only where it is enforced — production. Next's dev runtime
 * is inline and `eval`, so every origin here exempts dev, and the switch is the
 * caller's because only the caller knows what dev means for it. An origin that
 * sets its policy per request (a nonce) passes none.
 */
export function securityHeaders(csp?: string | null): HeaderEntry[] {
  return [
    ...(csp ? [{ key: 'Content-Security-Policy', value: csp }] : []),
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    { key: 'X-DNS-Prefetch-Control', value: 'on' },
  ];
}
