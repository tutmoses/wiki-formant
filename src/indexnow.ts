// indexnow.ts — telling the IndexNow engines (Bing, Yandex, Seznam, Naver, Yep)
// which pages changed, rather than waiting for them to recrawl.
//
// The `indexnow` bin reads an origin's live sitemap, keeps the rows whose
// `lastModified` falls inside the window, and posts them. It runs on the machine
// that runs the sweeps, not as a cron on the host: a submission costs the origin
// one cached sitemap fetch and no function time. The sitemap is the one place
// every writer shows up — the editor, the MCP write tools, and the sweep scripts
// that write to the database without passing through the app — so reading it
// covers all of them with no hook in any.
//
// The key is not a secret. An engine verifies a submission by fetching
// `/<key>.txt` from the origin, so the key is public by design, and the file in
// each app's `public/` is the only copy.

import { decodeEntities } from './markdown.js';

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

/** The protocol's cap on the URLs in one POST. */
export const INDEXNOW_BATCH = 10_000;

export interface IndexNowEntry {
  url: string;
  lastModified?: string;
}

/** The `<loc>` and `<lastmod>` of every `<url>` in a sitemap. */
export function sitemapEntries(xml: string): IndexNowEntry[] {
  const entries: IndexNowEntry[] = [];
  for (const [, body = ''] of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>([\s\S]*?)<\/loc>/.exec(body)?.[1];
    if (!loc) continue;
    const lastmod = /<lastmod>([\s\S]*?)<\/lastmod>/.exec(body)?.[1];
    const url = decodeEntities(loc.trim());
    entries.push(lastmod ? { url, lastModified: lastmod.trim() } : { url });
  }
  return entries;
}

/**
 * Every entry of the sitemap at `url`, following a sitemap index one level down
 * to at most 20 children. The `indexnow` and `check-pages` bins each parsed
 * sitemaps, and only one of them read an index. Throws when `url` itself does
 * not answer 200; a child that fails is skipped.
 */
export async function readSitemap(url: string, fetchImpl: typeof fetch = fetch): Promise<IndexNowEntry[]> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const xml = await res.text();
  if (!/<sitemapindex/i.test(xml)) return sitemapEntries(xml);
  const children = [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)].slice(0, 20).map(m => decodeEntities(m[1]!.trim()));
  const entries: IndexNowEntry[] = [];
  for (const child of children) entries.push(...(await readSitemap(child, fetchImpl).catch(() => [])));
  return entries;
}

/**
 * The URLs modified at or after `since`. An entry with no `lastModified` is
 * left out: nothing says it changed, and the protocol asks for changed pages
 * only. A full submission (`--all`) is how those reach an engine.
 */
export function changedUrls(entries: IndexNowEntry[], since: number): string[] {
  return entries
    .filter(e => e.lastModified !== undefined && new Date(e.lastModified).getTime() >= since)
    .map(e => e.url);
}

/**
 * POST `urls` in batches of `INDEXNOW_BATCH` and return each batch's status.
 * 200 is accepted and 202 accepted pending the key check; 403 means the key
 * file is missing or disagrees, 422 that a URL is off the host. Every URL must
 * share the first one's host, which a sitemap built from one origin does.
 */
export async function submitIndexNow(
  key: string,
  urls: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<number[]> {
  const first = urls[0];
  if (!first) return [];
  const host = new URL(first).host;
  const statuses: number[] = [];
  for (let i = 0; i < urls.length; i += INDEXNOW_BATCH) {
    const res = await fetchImpl(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host, key, urlList: urls.slice(i, i + INDEXNOW_BATCH) }),
    });
    statuses.push(res.status);
  }
  return statuses;
}
