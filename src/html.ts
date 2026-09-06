// html.ts — the small string helpers several modules had each written for
// themselves. Internal: no subpath, not in the root barrel.
//
// Every one of these existed two, three or four times in this package, which is
// the same fault it was extracted to fix — the module headers in `headings.ts`
// and `text.ts` both record having inherited a copy from a sibling repo, and
// then the extraction kept the copy.

/**
 * Tags out, the two entities that survive a strip decoded, whitespace trimmed.
 *
 * The `&nbsp;`/`&amp;` pass is not decoration: an anchor whose text is only a
 * non-breaking space is an empty anchor, and without decoding it reads as
 * non-empty and keeps its blank label.
 */
export const stripTags = (s: string): string =>
  s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();

/** Read one double-quoted attribute out of a tag's attribute string. */
export const getAttr = (attrs: string, name: string): string | null =>
  attrs.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? null;

/** Drop every occurrence of one attribute from a tag's attribute string. */
export const removeAttr = (attrs: string, name: string): string =>
  attrs.replace(new RegExp(`\\s${name}\\s*=\\s*"[^"]*"`, 'gi'), '');

/** `YYYY-MM-DD`, from either a Date or a string that already starts with one. */
export const isoDate = (d: Date | string): string =>
  (typeof d === 'string' ? d : d.toISOString()).split('T')[0]!;

/** Join class names, dropping the falsy ones. The package depends on no `cn`. */
export const cx = (...parts: (string | false | undefined)[]): string =>
  parts.filter(Boolean).join(' ');
