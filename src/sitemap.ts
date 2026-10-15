// sitemap.ts — the rows a wiki's tree contributes to its sitemap.
//
// All three wikis list their sections beside their pages, and each dated them
// its own way: one by the newest page beneath, one the same but derived from
// where the pages sit, and one not at all. A section's listing changes when a
// page under it does, so the newest page beneath is its honest date; a section
// with no page under it carries none rather than a fictional one.
//
// What stays with the caller is which sections exist, every URL, and the
// frequency and priority each row carries. The return is structurally Next's
// `MetadataRoute.Sitemap`, so a `sitemap.ts` spreads it as it is.

export type ChangeFrequency = 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';

export interface SitemapRow {
  url: string;
  lastModified?: Date;
  changeFrequency?: ChangeFrequency;
  priority?: number;
}

/** The minimum a page must be to date its sections and earn a row. */
export interface TreePage {
  tagPath: string;
  slug: string;
  updatedAt: Date;
}

export interface TreeSitemapOptions<P extends TreePage> {
  /** Section tag paths to list, in order. A path with no page beneath it is listed undated. */
  sections: Iterable<string>;
  sectionRow: (tagPath: string) => Omit<SitemapRow, 'lastModified'>;
  pageRow: (page: P) => Omit<SitemapRow, 'lastModified'>;
}

/**
 * One row per section, dated by the newest page at or beneath it, then one row
 * per page, dated by its own `updatedAt`.
 *
 * Every URL appears once. An empty-slug page is its section's own article (a
 * category hub): it dates the section and gets no row of its own, since its URL
 * is the section's. A section whose URL a page row already holds is served as
 * that page, so the section's row is dropped.
 */
export function treeSitemap<P extends TreePage>(pages: readonly P[], o: TreeSitemapOptions<P>): SitemapRow[] {
  const pageRows = pages
    .filter(p => p.slug)
    .map((p): SitemapRow => ({ ...o.pageRow(p), lastModified: p.updatedAt }));
  const taken = new Set(pageRows.map(r => r.url));

  const sectionRows: SitemapRow[] = [];
  for (const path of o.sections) {
    const row = o.sectionRow(path);
    if (taken.has(row.url)) continue;
    let newest: Date | undefined;
    for (const p of pages) {
      if ((p.tagPath === path || p.tagPath.startsWith(`${path}/`)) && (!newest || p.updatedAt > newest)) newest = p.updatedAt;
    }
    taken.add(row.url);
    sectionRows.push({ ...row, lastModified: newest });
  }
  return [...sectionRows, ...pageRows];
}

/** Every tag path at or above the given ones, each once: `a/b` yields `a` and `a/b`. */
export function tagPrefixes(tagPaths: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const tagPath of tagPaths) {
    const segments = tagPath.split('/').filter(Boolean);
    for (let depth = 1; depth <= segments.length; depth++) out.add(segments.slice(0, depth).join('/'));
  }
  return [...out];
}
