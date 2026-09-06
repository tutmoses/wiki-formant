// link-check.ts — the dead-link probe both wikis' sweep scripts had written.
//
// Node-only (fetch, AbortSignal, URL). No framework, no database: what a
// checker does with the verdicts — which pages to walk, what counts as an
// internal path, how to report — stays with the caller, because that is the
// half that is genuinely per-wiki.
//
// EVERY GUARD BELOW WAS PAID FOR BY A FALSE POSITIVE, and the two copies had
// each learned a different half of the lesson. One knew that npmjs.com 403s
// scripted requests, that an expired certificate is not a dead host, and that a
// YouTube /embed/ URL answers 200 for a deleted video. The other knew that a
// connect refusal is usually concurrency rather than death, and that
// serialising per hostname is what fixes it. Neither copy was behind. A sweep
// running either one alone strips good citations for reasons the other repo had
// already written down — which is the entire argument for this file.

import { stripTags } from './html.js';

export interface Probe {
  url: string;
  status: number;
  ok: boolean;
  error?: string;
  code?: string;
  tls?: string;
  note?: string;
  contentType?: string;
  bytes?: number;
}

export interface ProbeOptions {
  /** Ordinary per-attempt budget. */
  timeoutMs?: number;
  /** Second-attempt budget for a host that is merely slow. */
  slowTimeoutMs?: number;
}

const DEFAULTS = { timeoutMs: 12_000, slowTimeoutMs: 40_000 };

/**
 * TLS-verification failures are NOT death.
 *
 * A Let's Encrypt certificate on a DAO's own consultation platform — cited 20
 * times across 7 pages — expired at 13:47 UTC, and every one of those citations
 * started reading as `status: 0, "fetch failed"`, indistinguishable from a
 * vanished host. Behind the interstitial the site answered 200. undici buries
 * the reason in `err.cause`, so it is surfaced and labelled: a run that cannot
 * tell an expired cert from a dead domain will eventually strip good citations
 * over a lapsed renewal.
 */
export const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Codes that flap. A sweep found 16 status-0 rows and 15 were one host, every
 * one answering 200 when probed alone. Carry the code through so a caller can
 * treat these as retryable rather than banking a death.
 */
export const TRANSIENT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
]);

type CausedError = Error & { cause?: { code?: string }; code?: string };

/** A failure as a report row: the message, the code, and the TLS caveat. */
export function describeFailure(err: unknown): Pick<Probe, 'error' | 'code' | 'tls' | 'note'> {
  const e = err as CausedError;
  if (e?.name === 'AbortError') return { error: 'timeout' };
  const code = e?.cause?.code ?? e?.code;
  const error = code ? `${e.message} (${code})` : (e?.message ?? 'fetch failed');
  if (code && TLS_CODES.has(code)) {
    return {
      error,
      code,
      tls: code,
      note: 'TLS verification failed — the host may well be serving fine behind the interstitial; confirm before touching the citation',
    };
  }
  return code ? { error, code } : { error };
}

/**
 * The URL to probe INSTEAD, where the public page lies about its own health.
 *
 * npmjs.com serves 403 to scripted requests whether or not the package exists,
 * which made every package citation a permanent false positive. The registry
 * answers honestly.
 */
export function probeUrlFor(url: string): string {
  const npm = url.match(/^https:\/\/(?:www\.)?npmjs\.com\/package\/(.+?)\/?$/);
  return npm ? `https://registry.npmjs.org/${npm[1]}` : url;
}

// ---- per-host serialisation -------------------------------------------------

const hostQueues = new Map<string, Promise<unknown>>();

/**
 * Run `fn` with at most one request in flight against this hostname.
 *
 * ECONNREFUSED looks deterministic and is not. A delayed retry was tried first
 * and made things worse — 269 to 277 broken, the refusals unchanged and 8 fresh
 * timeouts on hosts that had been fine — because the problem is not timing, it
 * is how many sockets one host is asked for at once. The global pool still runs
 * wide across DIFFERENT hosts; any single host is probed one request at a time,
 * exactly as a hand re-probe does it.
 */
export function perHost<T>(url: string, fn: () => Promise<T>): Promise<T> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return fn();
  }
  const prev = hostQueues.get(host) ?? Promise.resolve();
  // `.then(fn, fn)` so one rejection does not poison the rest of the queue.
  const next = prev.then(fn, fn);
  hostQueues.set(
    host,
    next.catch(() => undefined),
  );
  return next as Promise<T>;
}

async function attempt(url: string, budgetMs: number): Promise<Probe> {
  // One signal for both requests, so the budget covers the HEAD *and* the GET
  // rather than resetting between them. `engines.node` is >= 20, so this needs
  // no controller and no `clearTimeout` in a `finally` that could be forgotten.
  const signal = AbortSignal.timeout(budgetMs);
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal });
    // Some hosts reject HEAD outright; retry with GET before believing a 4xx.
    if (res.status >= 400) {
      res = await fetch(url, { method: 'GET', redirect: 'follow', signal });
    }
    return {
      url,
      status: res.status,
      ok: res.status < 400,
      contentType: (res.headers.get('content-type') || '').split(';')[0]?.trim(),
      bytes: Number(res.headers.get('content-length') || 0),
    };
  } catch (err) {
    return { url, status: 0, ok: false, ...describeFailure(err) };
  }
}

/**
 * Probe one URL, honestly.
 *
 * A timeout is not a death and neither is a dropped connection: slow replays —
 * web.archive.org above all, which a sweep leans on to rescue dying citations —
 * exceed the ordinary budget and land as status 0. So a status-0 result with a
 * transient code earns one more attempt on the longer budget before it is
 * reported. A 404 does not: it is an answer.
 */
export async function probeUrl(url: string, opts: ProbeOptions = {}): Promise<Probe> {
  const { timeoutMs, slowTimeoutMs } = { ...DEFAULTS, ...opts };
  const target = probeUrlFor(url);

  const first = await perHost(target, () => attempt(target, timeoutMs));
  const retryable = !first.ok && first.status === 0 && (!first.code || TRANSIENT_CODES.has(first.code));
  if (!retryable) return { ...first, url };

  const second = await perHost(target, () => attempt(target, slowTimeoutMs));
  return { ...second, url };
}

// ---- YouTube ----------------------------------------------------------------

export const YOUTUBE_EMBED = /^https?:\/\/(?:www\.)?(?:youtube-nocookie\.com|youtube\.com)\/embed\/([\w-]+)/;

/**
 * The same video cited as a LINK rather than an iframe. `youtu.be/<id>` 303s and
 * `youtube.com/watch?v=<id>` 200s for deleted and private videos alike, so an
 * anchor carrying a dead video is invisible to a status check — 55 of them went
 * unprobed corpus-wide until one sweep resolved them and found 7 unwatchable.
 */
export const YOUTUBE_WATCH =
  /^https?:\/\/(?:(?:www\.)?youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{6,})/;

/**
 * A YouTube `/embed/<id>` URL answers 200 for private, deleted and
 * playback-restricted videos alike, so HEADing it can never spot a dead hero
 * video. oEmbed can:
 *
 *   200 → public and embeddable | 404 → deleted | 401/403 → private or embedding off
 */
export async function probeYouTube(
  videoId: string,
  opts: ProbeOptions = {},
): Promise<{ status: number; ok: boolean; reason?: string; error?: string }> {
  const { timeoutMs } = { ...DEFAULTS, ...opts };
  const oembed = `https://www.youtube.com/oembed?url=https%3A//www.youtube.com/watch%3Fv%3D${videoId}&format=json`;
  try {
    const res = await fetch(oembed, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { status: 404, ok: false, reason: 'deleted' };
    if (res.status === 401 || res.status === 403) {
      return { status: res.status, ok: false, reason: 'restricted (private or embedding disabled)' };
    }
    return { status: res.status, ok: res.status < 400 };
  } catch (err) {
    return { status: 0, ok: false, ...describeFailure(err) };
  }
}

/** An external anchor, with a video treated as a video. */
export async function probeExternal(url: string, opts: ProbeOptions = {}): Promise<Probe & { videoId?: string }> {
  const yt = url.match(YOUTUBE_WATCH);
  if (yt?.[1]) return { url, videoId: yt[1], ...(await probeYouTube(yt[1], opts)) };
  return probeUrl(url, opts);
}

// ---- unverifiable hosts -----------------------------------------------------

/**
 * Hosts that answer 200 with a JavaScript loader shell regardless of whether
 * the deck / store / dataset behind the query string still exists. A status
 * check on these is meaningless, so a caller should report them as unverifiable
 * rather than healthy — a green row is worse than an unknown one, because
 * nobody looks at it again.
 */
export function unverifiableReason(
  url: string,
  hosts: ReadonlyMap<string, string>,
): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  for (const [h, reason] of hosts) {
    if (host === h || host.endsWith(`.${h}`)) return reason;
  }
  return null;
}

// ---- extraction -------------------------------------------------------------

const LINK_RE = /<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
const EMBED_RE = /<(iframe|img)\b[^>]*?\ssrc="([^"]*)"/gi;

/** Every anchor in a fragment, as `{ href, text }`. */
export function extractLinks(html: string): Array<{ href: string; text: string }> {
  const out: Array<{ href: string; text: string }> = [];
  for (const m of html.matchAll(LINK_RE)) {
    if (m[1]) out.push({ href: m[1], text: stripTags(m[2] ?? '') });
  }
  return out;
}

/** Every `<iframe>` and `<img>` source in a fragment. */
export function extractEmbeds(html: string): Array<{ kind: string; url: string }> {
  const out: Array<{ kind: string; url: string }> = [];
  for (const m of html.matchAll(EMBED_RE)) {
    if (m[1] && m[2]) out.push({ kind: m[1].toLowerCase(), url: m[2] });
  }
  return out;
}

// ---- concurrency ------------------------------------------------------------

/** `Promise.all` with a ceiling, preserving input order in the results. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}
