// category.ts – a category page as radix-wiki browses one, from the tree, the
// taxonomy and the store.
//
// radix-wiki assembled this inside its route and miow copied it line for line:
// the count, a sort that only shows once the set needs an A–Z index, the facets
// its `select` keys give, a letter that exists, and a card per section listing
// what it holds. acuiq2 kept a subset that had drifted (no sort, no cards). The
// view is the app's; the arithmetic is here.

import type { ListSort, WikiPageRef } from './store.js';
import type { Taxonomy, FacetablePage, FacetFilters, FacetControlGroup, Control } from './taxonomy.js';
import { wikiPath, type WikiNode, type WikiTree } from './tree.js';

/** What the view reads pages through: the store, or the app's cached and decorated wrappers over it. */
export interface CategoryReader<P> {
  list: (tagPath: string, opts: { sort: ListSort; limit: number }) => Promise<P[]>;
  subtree: (tagPath: string) => Promise<WikiPageRef[]>;
}

export interface CategoryOptions {
  /** A page's address. Defaults to `wikiPath`; a wiki mounted under a prefix adds it. */
  href?: (tagPath: string, slug: string) => string;
  /** How many of a section's own pages its card lists. */
  cardPages?: number;
  /** The most pages one category reads. */
  limit?: number;
}

export interface CategorySection {
  name: string;
  href: string;
  description?: string;
  /** Pages in the section's whole branch. */
  total: number;
  /** Its own pages, in that listing's order, then its sections, so neither half of a mixed one hides. */
  links: { title: string; href: string }[];
}

export type CategoryQuery = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * A category's pages narrowed by its facets and an A–Z letter, sorted A–Z or
 * newest first (by a `date` key where the category declares one), and a card
 * per visible child. A set small enough to need no index offers no sort: it is
 * A–Z.
 */
export async function categoryView<P extends FacetablePage & { tagPath: string; slug: string }>(
  { tree, taxonomy, pages: reader }: { tree: WikiTree<WikiNode>; taxonomy: Taxonomy; pages: CategoryReader<P> },
  tagPath: string,
  query: CategoryQuery,
  { href = wikiPath, cardPages = 6, limit = 2000 }: CategoryOptions = {},
) {
  const resolved = tree.resolve(tagPath);
  const order = (path: string, sort: 'title' | 'recent'): ListSort =>
    sort === 'recent' && tree.metadataKeys(path).some(k => k.key === 'date' && k.type === 'date') ? 'date' : sort;
  const fallback = (path: string): 'title' | 'recent' => (tree.resolve(path).sort === 'title' ? 'title' : 'recent');
  const asked = one(query.sort);
  const requested = asked === 'title' || asked === 'recent' ? asked : fallback(tagPath);
  const fetched = await reader.list(tagPath, { sort: order(tagPath, requested), limit });
  const sort = taxonomy.needsAlphaIndex(fetched.length) ? requested : 'title';
  const all = sort === requested ? fetched : await reader.list(tagPath, { sort: order(tagPath, sort), limit });

  const filters: FacetFilters = taxonomy.facetFilters(tagPath, query);
  const letter = taxonomy.resolveLetter(all, filters, one(query.letter)?.toUpperCase());
  const sortable = taxonomy.needsAlphaIndex(all.length);
  // A link carries the sort only when it is not the category's own, so the bare
  // category and its default are one address, not two.
  const state = { sort: sortable && sort !== fallback(tagPath) ? sort : undefined, filters, letter };

  const children = (resolved.node?.children ?? []).filter(c => !c.hidden);
  const refs = children.length ? await reader.subtree(tagPath) : [];
  const sections: CategorySection[] = await Promise.all(
    children.map(async child => {
      const path = `${tagPath}/${child.slug}`;
      const direct = await reader.list(path, { sort: order(path, fallback(path)), limit: cardPages });
      return {
        name: child.name,
        href: href(path, ''),
        description: child.description,
        total: refs.filter(r => r.tagPath === path || r.tagPath.startsWith(`${path}/`)).length,
        links: [
          ...direct.slice(0, cardPages).map(p => ({ title: p.title, href: href(p.tagPath, p.slug) })),
          ...(child.children ?? []).filter(g => !g.hidden).map(g => ({ title: g.name, href: href(`${path}/${g.slug}`, '') })),
        ],
      };
    }),
  );

  const facets: FacetControlGroup[] = taxonomy.facetControls(tagPath, all, state);
  const letters: Control[] = taxonomy.alphaControls(tagPath, all, state);
  return {
    sort,
    filters,
    letter,
    total: all.length,
    pages: taxonomy.filterPages(all, filters, letter),
    /** Every page before narrowing, for what describes the category as a whole (its JSON-LD). */
    all,
    facets,
    letters,
    sortable,
    clearHref: Object.keys(filters).length || letter ? taxonomy.href(tagPath, { sort: state.sort }) : undefined,
    sortHref: (to: 'title' | 'recent') => taxonomy.href(tagPath, { ...state, sort: to === fallback(tagPath) ? undefined : to }),
    sections,
  };
}
