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
// One import, node:crypto for a script's hash, so a config pays for nothing
// else. `withWikiDefaults` is here for the same reason: next.config.ts is its
// only caller.

import { createHash } from 'node:crypto';

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

/** `frame-src` sources for a host list — the one a sanitiser was given. @internal */
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
 *
 * @internal
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

/** A `script-src` source admitting exactly this inline script body. */
export const scriptHash = (body: string): string =>
  `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;

/**
 * The policy string: `BASE_CSP` with each directive in `directives` replacing
 * its default. An empty list drops the directive.
 *
 * A `nonce` swaps `script-src` for the strict form, `'self'`, the nonce and a
 * hash of each of `inlineScripts`, with no `'unsafe-inline'`. The hashes admit
 * a static boot script without the layout reading the nonce, which would make
 * every route render per request; hashing here means a package bump that
 * changes the script moves its hash too, where a hand-copied one went stale
 * and blanked every nonce route. Without a nonce the baseline stands.
 */
export function contentSecurityPolicy(
  directives: Partial<Record<CspDirective, readonly string[]>> = {},
  { nonce = null, inlineScripts = [] }: { nonce?: string | null; inlineScripts?: readonly string[] } = {},
): string {
  const strict = nonce ? { 'script-src': ["'self'", `'nonce-${nonce}'`, ...inlineScripts.map(scriptHash)] } : {};
  return Object.entries({ ...BASE_CSP, ...directives, ...strict })
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

/** The parts of a Next config `withWikiDefaults` fills in. */
interface WikiNextConfig {
  distDir?: string;
  experimental?: object;
  images?: object;
  headers?: () => Promise<unknown[]> | unknown[];
}

/**
 * An app's Next config with the settings every app here wrote out the same way:
 *
 * - `distDir` from `STUDIO_DIST_DIR`, set only by radix-studio's renders, which
 *   boot a second dev server beside the running one, and Next allows one per
 *   distDir.
 * - `turbopackFileSystemCacheForBuild: false`. Next 16.3 turns Turbopack's
 *   build cache on and Vercel restores it from the last deployment; caper
 *   shipped a stylesheet two commits stale that way in October 2026.
 * - AVIF before WebP from the image optimiser.
 * - `securityHeaders` on every route, with `csp` enforced in production only:
 *   Next's dev runtime is inline and `eval`. An origin that sets its policy
 *   per request (a nonce) passes none.
 *
 * Anything the app sets wins, and its own `headers()` follow these. Pass
 * `NextConfig` as `T` so the object is typed as Next's own config.
 */
export function withWikiDefaults<T extends WikiNextConfig>(config: T, { csp }: { csp?: string } = {}): T {
  return {
    ...(process.env.STUDIO_DIST_DIR ? { distDir: process.env.STUDIO_DIST_DIR } : {}),
    ...config,
    experimental: { turbopackFileSystemCacheForBuild: false, ...config.experimental },
    images: { formats: ['image/avif', 'image/webp'], ...config.images },
    async headers() {
      return [
        { source: '/:path*', headers: securityHeaders(process.env.NODE_ENV === 'production' ? csp : null) },
        ...((await config.headers?.()) ?? []),
      ];
    },
  };
}
