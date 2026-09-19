// headings.ts — stable ids on a wiki page's headings, and the list a table of
// contents is built from.
//
// The slug rule is a parameter, not a decision this module makes. A heading id
// is a live URL: readers link to `#the-shape-of-a-code`, and so does the page's
// own permalink anchor. Unifying two slug rules would silently move every
// existing anchor on whichever wiki lost, so the rule each has shipped is the
// rule it keeps, stated at its call site instead of buried in a helper.
//
// Deduping, by contrast, is not a choice: two headings with the same text
// otherwise mint the same id twice and every link to the second one lands on
// the first, so this always dedupes. The unit is the DOCUMENT, not the call: a
// block wiki calls the injector once per block, and all three consumers did
// that with a fresh set each time, so a "Notes" in two blocks shipped two
// `id="notes"`. One `used` set per page is what makes the dedupe hold.

import { getAttr, stripTags } from './html.js';

/** A heading found in a page's HTML, in document order. */
export interface Heading {
  id: string;
  text: string;
  /** 1 for `<h1>`, 2 for `<h2>`, and so on. */
  level: number;
}

/** The default slug rule: lowercase words joined by hyphens. */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * `base`, or `base-2`, `base-3`… — the first one `used` does not hold. Records
 * nothing: the caller adds the id it keeps. Shared with the editor's heading
 * decoration, so the id a heading shows while it is being written is the id it
 * is published under.
 */
export function uniqueHeadingId(base: string, used: ReadonlySet<string>): string {
  if (!base) return base;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

const HEADING = /<(h[1-6])([^>]*)>([\s\S]*?)<\/\1>/gi;


export interface HeadingIdOptions {
  /**
   * How heading text becomes an id. Defaults to `slugifyHeading`. Pass the rule
   * your wiki has already published ids under — see the note at the top of this
   * file about why this is not standardised.
   */
  slug?: (text: string) => string;
  /**
   * Emitted after the heading text so a reader can link to the section. Return
   * `''` for no anchor. The default is deliberately empty of text — its glyph
   * comes from CSS, so it never leaks into a heading's `textContent` and out
   * into a TOC label.
   */
  anchor?: (id: string) => string;
  /**
   * Ids already taken on this page, added to as headings are decorated. Pass
   * ONE set across every fragment of a document — each content block of a page,
   * seeded with any id the page template renders itself — or two fragments with
   * the same heading text mint the same id. Omitted, dedupe covers this call only.
   */
  used?: Set<string>;
}

const defaultAnchor = (id: string): string =>
  `<a class="heading-anchor" href="#${id}" aria-label="Permalink to this section" tabindex="-1"></a>`;

/**
 * Give every heading in `html` an id and a permalink anchor. Headings that
 * already carry an id keep it, and a heading already carrying an anchor is left
 * alone, so this is safe to run twice over the same string.
 */
export function injectHeadingIds(html: string, options: HeadingIdOptions = {}): string {
  if (!html.trim()) return html;
  const slug = options.slug ?? slugifyHeading;
  const anchor = options.anchor ?? defaultAnchor;
  const used = options.used ?? new Set<string>();
  return html.replace(HEADING, (match, tag: string, attrs: string, content: string) => {
    const existing = getAttr(attrs, 'id');
    // Already decorated, by an earlier pass or by whoever stored it: left as it
    // is, but its id is still taken, or the next fragment could mint it again.
    if (content.includes('heading-anchor')) {
      if (existing) used.add(existing);
      return match;
    }
    const id = existing || uniqueHeadingId(slug(stripTags(content)), used);
    if (!id) return match;
    used.add(id);
    return `<${tag}${existing ? attrs : `${attrs} id="${id}"`}>${content}${anchor(id)}</${tag}>`;
  });
}

/**
 * The headings in `html` that carry an id, in document order — the list an "on
 * this page" rail renders. Run it over the output of `injectHeadingIds` and
 * every heading is in it.
 *
 * Reading the string rather than the rendered DOM is only possible where the
 * body IS a string at render time. A wiki whose content streams in as blocks
 * after mount has to query the DOM instead, which is why two of the three
 * consumers use only the injector above.
 */
export function headingsFrom(html: string): Heading[] {
  const out: Heading[] = [];
  for (const [, tag, attrs, content] of html.matchAll(HEADING)) {
    const id = getAttr(attrs ?? '', 'id');
    const text = stripTags(content ?? '');
    if (id && text) out.push({ id, text, level: Number(tag![1]) });
  }
  return out;
}
