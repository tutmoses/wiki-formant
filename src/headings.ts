// headings.ts — stable ids on a wiki page's headings, and the list a table of
// contents is built from.
//
// Two of the three wikis had already written this out (caper's `injectHeadingIds`,
// radix-wiki's heading branch in `processHtml`), down to byte-identical
// `stripTags` and `getAttr` helpers — caper's file says "ported in spirit from
// radix-wiki" at the top, which is the drift admitting itself. What they had
// drifted on is below.
//
// The slug rule is a parameter, not a decision this module makes. A heading id
// is a live URL: readers link to `#the-shape-of-a-code`, and so does the page's
// own permalink anchor. Unifying two slug rules would silently move every
// existing anchor on whichever wiki lost, so the rule each has shipped is the
// rule it keeps, stated at its call site instead of buried in a helper.
//
// Deduping, by contrast, is not a choice: two headings with the same text
// otherwise mint the same id twice and every link to the second one lands on
// the first. That was already a bug in the copy that lacked it, so this always
// dedupes.

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

const HEADING = /<(h[1-6])([^>]*)>([\s\S]*?)<\/\1>/gi;

const stripTags = (s: string): string =>
  s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();

const getAttr = (attrs: string, name: string): string | null =>
  attrs.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? null;

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
  const used = new Set<string>();
  return html.replace(HEADING, (match, tag: string, attrs: string, content: string) => {
    if (content.includes('heading-anchor')) return match;
    const existing = getAttr(attrs, 'id');
    let id = existing || slug(stripTags(content));
    if (!id) return match;
    if (!existing) {
      const base = id;
      let n = 2;
      while (used.has(id)) id = `${base}-${n++}`;
    }
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
