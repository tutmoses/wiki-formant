// text.ts — a block tree as plain prose, for LLM and MCP exports.
//
// The markdown twin in `blocks.ts` is for a reader; this is for a model reading
// the page as evidence. Both wikis had the same `stripHtml`, the same six
// banner labels and the same four leaf bodies, character for character.
//
// As in `blocks.ts`, the dispatch stays with the caller — a `switch` over its
// own block union, where a new type is a compile error until it is handled —
// and only the bodies live here.

import { decodeEntities } from './entities.js';
import type { CodeTab, ReferenceItem } from './blocks.js';

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

/** A maintenance notice, inline: `[Notice: Needs citations] …`. */
export function bannerToText(label: string, text?: string | null): string {
  return `[Notice: ${label}]${text ? ' ' + stripHtml(text) : ''}`;
}

/** Each tab under its label, tags stripped — highlighted markup is noise here. */
export function codeTabsToText(tabs: readonly CodeTab[]): string {
  return tabs.map(t => `[${t.label}]\n${t.code}`).join('\n');
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
export function collectText(node: unknown, out: string[] = []): string[] {
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
