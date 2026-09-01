// feed.ts — an RSS 2.0 channel, assembled.
//
// Three repos, four feeds, and the same 47 of 64 significant lines in each —
// including, verbatim in two of them, the four-line comment explaining why the
// apostrophe uses a numeric reference rather than `&apos;`. That comment
// travelling by copy-paste is what made this worth lifting.
//
// The union, because each copy had something the others lacked: one had
// `content:encoded`, `<enclosure>`, `<category>` and a word-boundary clamp; two
// had a `lastBuildDate` derived from the newest item, where the third stamped
// `new Date()` on every request — a validator that changes when nothing has,
// which is the same waste the ETag helpers exist to avoid.
//
// What stays with the caller is the channel's identity and the block walk that
// turns a page into HTML. Every project owns its own type set.

// Numeric reference for the apostrophe: `&apos;` is an XML entity that older
// readers parsing the feed as HTML do not carry in their entity table.
const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escXml = (s: string): string => s.replace(/[&<>"']/g, c => XML_ESCAPES[c] ?? c);

/**
 * `content:encoded` carries raw HTML, so it travels inside CDATA. A literal
 * `]]>` in the body would close the section early and corrupt every item after
 * it — not just the one that contained it.
 */
export const cdata = (html: string): string => `<![CDATA[${html.replace(/]]>/g, ']]&gt;')}]]>`;

/**
 * Aggregators hard-truncate a description around 150 characters. Trimming on a
 * word boundary first means the cut lands between words rather than inside one.
 */
export function clampWords(s: string, max = 150): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:–-]$/, '');
}

/**
 * Relative hrefs and srcs are meaningless once an item is syndicated, so every
 * internal link is absolutised on the way out. Protocol-relative and anchor-only
 * targets are left alone.
 */
export function absolutise(html: string, baseUrl: string): string {
  return html.replace(
    /\s(href|src)="\/(?!\/)([^"]*)"/gi,
    (_m, attr: string, path: string) => ` ${attr}="${baseUrl}/${path}"`,
  );
}

export interface FeedItem {
  title: string;
  url: string;
  description: string;
  date: Date;
  /** Becomes an `<enclosure>`. */
  image?: string;
  /** Becomes `content:encoded`. Full-text RSS is what lets a feed be mirrored. */
  html?: string;
  categories?: string[];
}

export function renderItem(item: FeedItem): string {
  return [
    '    <item>',
    `      <title>${escXml(item.title)}</title>`,
    `      <link>${escXml(item.url)}</link>`,
    `      <guid isPermaLink="true">${escXml(item.url)}</guid>`,
    `      <description>${escXml(item.description)}</description>`,
    ...(item.categories ?? []).map(c => `      <category>${escXml(c)}</category>`),
    `      <pubDate>${item.date.toUTCString()}</pubDate>`,
    ...(item.image ? [`      <enclosure url="${escXml(item.image)}" type="image/png" />`] : []),
    ...(item.html ? [`      <content:encoded>${cdata(item.html)}</content:encoded>`] : []),
    '    </item>',
  ].join('\n');
}

export interface FeedChannel {
  title: string;
  link: string;
  description: string;
  /** The feed's own URL, for `atom:link rel="self"`. */
  self: string;
  language?: string;
  /** Channel-level licence, so the grant travels with the feed. */
  copyright?: string;
  /**
   * Overrides the derived build date. One consumer dates its channel from the
   * later of each item's published and updated stamps, so an edit to an old
   * article still moves the feed — a stronger rule than "the newest item", and
   * one only that consumer's row shape can express.
   */
  lastBuild?: Date | null;
}

/**
 * `lastBuildDate` comes from the newest item, not from the clock.
 *
 * A feed whose build date moves on every request tells every poller it changed
 * when it did not, which is exactly the recrawl the conditional-GET helpers
 * exist to prevent. An empty feed has no build date rather than a fictional one.
 */
export function renderFeed(channel: FeedChannel, items: readonly FeedItem[]): string {
  const newest =
    channel.lastBuild ??
    items.reduce<Date | null>((max, item) => (!max || item.date > max ? item.date : max), null);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
    '  <channel>',
    `    <title>${escXml(channel.title)}</title>`,
    `    <link>${escXml(channel.link)}</link>`,
    `    <description>${escXml(channel.description)}</description>`,
    `    <language>${escXml(channel.language ?? 'en')}</language>`,
    ...(channel.copyright ? [`    <copyright>${escXml(channel.copyright)}</copyright>`] : []),
    `    <atom:link href="${escXml(channel.self)}" rel="self" type="application/rss+xml" />`,
    ...(newest ? [`    <lastBuildDate>${newest.toUTCString()}</lastBuildDate>`] : []),
    ...items.map(renderItem),
    '  </channel>',
    '</rss>',
  ].join('\n');
}

export const FEED_HEADERS: Record<string, string> = {
  'Content-Type': 'application/rss+xml; charset=utf-8',
  'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
};
