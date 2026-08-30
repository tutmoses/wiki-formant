// links.ts — internal vs. external link normalisation for wiki content.
//
// The editor stores whatever href an author types. At render time a wiki has to
// draw the line between *internal* links (relative paths, in-page anchors, and
// absolute links back to its own host) and *external* ones: externals open in a
// new tab with a safe rel, internals navigate in place, and CSS keys off the
// same distinction to tint one and badge the other.
//
// Both wikis had written this out — caper's `normaliseLinks`, radix-wiki's
// anchor branch in `processHtml` — down to identical `getAttr` and `removeAttr`
// helpers and the same `#ref-n` -> `id="cite-n"` citation wiring. caper's file
// said "ported from radix-wiki" at the top, which is the drift admitting itself.
//
// What they drifted on: only radix-wiki synthesised a label for an anchor with
// no visible text. That is an accessibility fix, not a preference, so it is the
// default here and caper gains it by adopting this module.

/** Read one double-quoted attribute out of a tag's attribute string. */
const getAttr = (attrs: string, name: string): string | null =>
  attrs.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? null;

/** Drop every occurrence of one attribute from a tag's attribute string. */
const removeAttr = (attrs: string, name: string): string =>
  attrs.replace(new RegExp(`\\s${name}\\s*=\\s*"[^"]*"`, 'gi'), '');

const stripTags = (s: string): string => s.replace(/<[^>]*>/g, '').trim();

/**
 * A readable label for an anchor whose text is empty, derived from its href.
 * Without one, crawlers and screen readers meet a link with nothing in it.
 */
export function fallbackAnchorText(href: string): string {
  if (href.startsWith('#')) return href.slice(1).replace(/-/g, ' ') || 'section';
  if (href.startsWith('/')) {
    const last = href.split('/').filter(Boolean).pop();
    return last ? last.replace(/-/g, ' ') : 'page';
  }
  try {
    return new URL(href).hostname.replace(/^www\./, '') || href;
  } catch {
    return href;
  }
}

export interface NormaliseLinkOptions {
  /**
   * This wiki's own origin. An absolute link back to it is really internal, so
   * it is folded to a relative path and navigates in place instead of opening a
   * new tab. Matched case-insensitively, with or without a `www.` prefix.
   * e.g. `'radix.wiki'` or `'caper.network'`.
   */
  selfHost?: string;
  /**
   * Shared across one document so a `#ref-n` citation can be given a
   * `id="cite-n"` target exactly once — the reference list renders a `^`
   * back-link to it. Pass the same Set for every block of a page.
   */
  citedRefs?: Set<number>;
  /**
   * Give an empty anchor a synthesised label. On by default; pass `false` to
   * keep an empty anchor empty.
   */
  fallbackText?: boolean;
}

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

function selfHostPattern(host: string): RegExp {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^https?://(?:www\\.)?${escaped}(/[^\\s"]*)?$`, 'i');
}

function normaliseAnchor(attrs: string, inner: string, opts: NormaliseLinkOptions, self: RegExp | null): string {
  // Injected heading permalink anchors carry their glyph via CSS. Leave them
  // alone — in particular the empty-text synthesis below must not fill them,
  // or the label leaks into the heading's textContent and out into a TOC.
  if (/\bheading-anchor\b/.test(attrs)) return `<a${attrs}>${inner}</a>`;

  const rawHref = getAttr(attrs, 'href');
  if (rawHref == null) return `<a${attrs}>${inner}</a>`;

  const href = self ? rawHref.replace(self, (_m, path: string) => path || '/') : rawHref;
  const isInternal = href.startsWith('/') || href.startsWith('#');

  // Drop any author-supplied target/rel; both are re-derived from the link kind.
  let rest = removeAttr(removeAttr(removeAttr(attrs, 'href'), 'rel'), 'target');

  const refMatch = opts.citedRefs ? href.match(/^#ref-(\d+)$/) : null;
  if (refMatch && !/\bid\s*=/.test(rest)) {
    const n = Number(refMatch[1]);
    if (!opts.citedRefs!.has(n)) {
      opts.citedRefs!.add(n);
      rest = ` id="cite-${n}"${rest}`;
    }
  }

  const safeInner =
    opts.fallbackText === false || stripTags(inner) ? inner : fallbackAnchorText(href);

  return isInternal
    ? `<a href="${href}"${rest}>${safeInner}</a>`
    : `<a href="${href}"${rest} target="_blank" rel="noopener">${safeInner}</a>`;
}

/**
 * Tag every anchor in `html` as internal or external. Attribute-order agnostic;
 * nested `<a>` is not handled, being invalid HTML anyway.
 */
export function normaliseLinks(html: string, options: NormaliseLinkOptions = {}): string {
  if (!html.trim()) return html;
  const self = options.selfHost ? selfHostPattern(options.selfHost) : null;
  return html.replace(ANCHOR, (_m, attrs: string, inner: string) =>
    normaliseAnchor(attrs, inner, options, self),
  );
}
