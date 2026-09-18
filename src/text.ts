// text.ts — a block tree as plain prose, for LLM and MCP exports.
//
// The markdown twin in `blocks.ts` is for a reader; this is for a model reading
// the page as evidence. Both wikis had the same `stripHtml`, the same six
// banner labels and the same four leaf bodies, character for character.
//
// As in `blocks.ts`, the dispatch stays with the caller — a `switch` over its
// own block union, where a new type is a compile error until it is handled —
// and only the bodies live here.

import { decodeEntities } from './markdown.js';
import type { CodeTab, LinkGridGroup, ReferenceItem, StatItem } from './blocks.js';

/**
 * HTML to readable text. Links keep their href in parentheses so a model can
 * still follow a citation; block-level tags become newlines; list items get a
 * bullet. Entities are decoded last, after the tags are gone, so a `&lt;` in
 * prose cannot become a tag the strip has already run past.
 */
export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, ' $2 ($1) ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|h[1-6]|li|tr|th|td|div)>/gi, '\n')
      .replace(/<(?:li)>/gi, '- ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The six maintenance-banner variants every wiki here renders. */
export type BannerVariant = 'stub' | 'unsourced' | 'outdated' | 'promotional' | 'cleanup' | 'coi';

/**
 * Display labels for the maintenance banners. Canonical: the prose extractor,
 * the markdown twin and the MDX export all render the same six strings.
 */
export const BANNER_LABELS: Record<BannerVariant, string> = {
  stub: 'Stub',
  unsourced: 'Needs citations',
  outdated: 'May be outdated',
  promotional: 'Written like an advertisement',
  cleanup: 'Needs cleanup',
  coi: 'Conflict of interest',
};

/**
 * The banner variants as an editor's option list, in the order a writer meets
 * them: the two that describe a gap first, then the three that describe a flaw.
 *
 * Derived from `BANNER_LABELS` rather than restated. Both editors had typed the
 * same six `{ value, label }` pairs out by hand, which made four places in the
 * workspace holding the same strings — and an editor whose dropdown disagrees
 * with the renderer's label is a page whose banner changes wording when you
 * open it for editing.
 */
export const BANNER_VARIANTS: ReadonlyArray<{ value: BannerVariant; label: string }> =
  (Object.keys(BANNER_LABELS) as BannerVariant[]).map(value => ({
    value,
    label: BANNER_LABELS[value],
  }));

/** A maintenance notice, inline: `[Notice: Needs citations] …`. */
export function bannerToText(label: string, text?: string | null): string {
  return `[Notice: ${label}]${text ? ' ' + stripHtml(text) : ''}`;
}

/** Each tab under its label, tags stripped — highlighted markup is noise here. */
export function codeTabsToText(tabs: readonly CodeTab[]): string {
  return tabs.map(t => `[${t.label}]\n${t.code}`).join('\n');
}

/** Metric cards, one per line: `99% Uptime`. */
export function statsToText(items: readonly StatItem[]): string {
  return items.map(s => `${s.value}${s.suffix ?? ''} ${s.label}`).join('\n');
}

/**
 * Each group's heading over its links, hrefs in parentheses the way
 * `stripHtml` keeps them.
 *
 * Two of the three wikis extracted nothing from a link grid, or from stats or
 * page lists, so a hub page read to an agent as far emptier than it is. The
 * third had its own three bodies. These are those bodies.
 */
export function linkGridToText(groups: readonly LinkGridGroup[], intro?: string | null): string {
  return [
    ...(intro ? [stripHtml(intro)] : []),
    ...groups.map(g =>
      [
        g.heading,
        ...(g.description ? [stripHtml(g.description)] : []),
        ...g.links.map(l => `- ${l.label} (${l.href})`),
      ].join('\n'),
    ),
  ].join('\n\n');
}

/** A resolved page list: one title per line. */
export function pageListToText(pages: readonly { title: string }[]): string {
  return pages.map(p => p.title).join('\n');
}

/** A numbered reference list, or `''` when there are none. */
export function referencesToText(items: readonly ReferenceItem[]): string {
  if (!items.length) return '';
  const lines = items.map((it, i) => `${i + 1}. ${stripHtml(it.text)}${it.url ? ` (${it.url})` : ''}`);
  return `References:\n${lines.join('\n')}`;
}

/**
 * Every `text` value at any depth of a block tree, in document order.
 *
 * Deliberately NOT the typed extractor above: that walks a switch and formats
 * for reading (labels, bullets, reference numbering), so it can surface text a
 * search index never matched and miss text it did. A snippet claiming to show
 * why a row matched has to read the same bytes the match was made against.
 */
function collectText(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out);
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'text' && typeof value === 'string') out.push(value);
      else collectText(value, out);
    }
  }
  return out;
}

/**
 * The passage that matched `query`, not the opening of the page.
 *
 * Wiki pages open with an infobox far more often than not — 243 of 269 on caper
 * when this was measured — so an opening-line snippet hands nine search rows in
 * ten a flattened metadata table, whatever the query was. Falls back to the
 * opening when the term appears only in the title, which is a real case rather
 * than a failure: title-only hits are how the top tiers match.
 */
export function matchSnippet(blocks: unknown, query: string, opening: () => string, maxLen = 200): string {
  const term = query.trim();
  if (!term) return opening();

  // Collapse tags and non-breaking spaces the way SQL does, so a phrase broken
  // by markup is still one searchable string, then decode what is left: editors
  // store typographic punctuation named, and without this a snippet reads back
  // "docs &middot; Related".
  const text = decodeEntities(collectText(blocks).join(' ').replace(/<[^>]*>|&nbsp;/g, ' '))
    .replace(/\s+/g, ' ') // JS \s covers U+00A0, which SQL has to translate by hand
    .trim();

  const at = text.toLowerCase().indexOf(term.toLowerCase());
  if (at === -1) return opening();

  // Keep about a line of lead-in, cut to a word boundary so it does not open
  // mid-word.
  let start = Math.max(0, at - 60);
  if (start > 0) {
    const boundary = text.indexOf(' ', start);
    if (boundary > -1 && boundary < at) start = boundary + 1;
  }
  const end = Math.min(text.length, start + maxLen);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trimEnd()}${end < text.length ? '…' : ''}`;
}
