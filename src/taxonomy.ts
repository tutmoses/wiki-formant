// taxonomy.ts — the second axis of category browsing.
//
// A `tagPath` puts a page in exactly one place in a tree. The `select`-typed
// metadata it already carries is a cross-cutting axis that is almost always
// stored and never surfaced — the failure this module exists to prevent is a
// 141-page category rendered as one flat grid while the data to split it sits
// unread in a JSON column.
//
// Everything here is derived. Nothing is hand-curated, so nothing can go stale:
// fix a page and it leaves the queue on the next revalidation.
//
// Two consumers proved the mechanism travels — one walks a nested tag tree, the
// other a flat category list — so the tree itself is NOT in this module. Supply
// `getMetadataKeys(tagPath)` and a `href` builder and the rest follows.

/**
 * The known key types, kept open. `'select'` is the only one this module acts
 * on — it is what makes a key a facet — and every other value is opaque here.
 *
 * Enumerating the rest would be the same mistake as a shared block-type list:
 * each project owns its own key set, and one of them already declares `'user'`
 * and `'resource_address'`. The `(string & {})` arm keeps editor completion for
 * the common four while accepting any project's additions.
 */
export type MetadataKeyType = 'text' | 'date' | 'url' | 'select' | (string & {});

/** A metadata key a tag path declares. Only `select` keys become facets. */
export interface MetadataKeyDefinition {
  key: string;
  label: string;
  type: MetadataKeyType;
  options?: string[];
}

/** The minimum a page must be for this module to classify it. */
export interface FacetablePage {
  title: string;
  metadata?: unknown;
}

export interface FacetValue {
  value: string;
  count: number;
}
export interface Facet {
  key: string;
  label: string;
  values: FacetValue[];
}
export type FacetFilters = Record<string, string>;

export interface SharedFacet {
  key: string;
  value: string;
}
export interface RelatedRanking<T> {
  pages: T[];
  sharedFacet: SharedFacet | null;
}

/** State a category URL can carry. `href` receives this and owns the format. */
export interface CategoryState {
  sort?: string;
  filters?: FacetFilters;
  letter?: string;
}

export interface TaxonomyConfig {
  /**
   * The metadata keys a tag path declares, nearest-last or nearest-first — the
   * order only matters for `label` collisions. Host-supplied because one repo
   * resolves it down a nested tree and another down a flat trail.
   */
  getMetadataKeys: (tagPath: string) => MetadataKeyDefinition[];
  /**
   * The category URL contract. Every chip, letter, sort button and infobox row
   * builds through this one function — a sort button that drops the active
   * filters is the tell that a project grew a second one.
   */
  href?: (tagPath: string, state: CategoryState) => string;
  /** Below this a category fits on a screen or two; above it, readers need an index. */
  alphaIndexMinPages?: number;
}

/** Default: `/{tagPath}?sort=…&{facet}=…&letter=…`. Override for a prefixed mount. */
export function defaultHref(tagPath: string, state: CategoryState): string {
  const params = new URLSearchParams();
  if (state.sort) params.set('sort', state.sort);
  for (const [key, value] of Object.entries(state.filters ?? {})) params.set(key, value);
  if (state.letter) params.set('letter', state.letter);
  const query = params.toString();
  return `/${tagPath}${query ? `?${query}` : ''}`;
}

export const DEFAULT_ALPHA_INDEX_MIN_PAGES = 40;

const metaValue = (page: FacetablePage, key: string): string =>
  ((page.metadata as Record<string, string> | null | undefined)?.[key] ?? '').trim();

/** Bucket for titles that don't start with a letter (numerals, `$CAPER`). */
export function firstLetter(title: string): string {
  const ch = title.trim()[0]?.toUpperCase() ?? '';
  return ch >= 'A' && ch <= 'Z' ? ch : '#';
}

/** Adding a filter already active removes it, so every chip is its own off-switch. */
export function toggleFilter(filters: FacetFilters, key: string, value: string): FacetFilters {
  const next = { ...filters };
  if (next[key] === value) delete next[key];
  else next[key] = value;
  return next;
}

export interface Taxonomy {
  /** The select-typed keys a tag path declares — its facetable axes. */
  facetKeys: (tagPath: string) => MetadataKeyDefinition[];
  /** Query params narrowed to facets this tag path actually declares. */
  facetFilters: (
    tagPath: string,
    params: Record<string, string | string[] | undefined>,
  ) => FacetFilters;
  filterPages: <T extends FacetablePage>(pages: T[], filters: FacetFilters, letter?: string) => T[];
  buildFacets: <T extends FacetablePage>(
    tagPath: string,
    pages: T[],
    filters: FacetFilters,
    letter?: string,
  ) => Facet[];
  alphaIndex: <T extends FacetablePage>(pages: T[], filters: FacetFilters) => FacetValue[];
  /** Whether a set has outgrown a grid and needs the A–Z index. */
  needsAlphaIndex: (pageCount: number) => boolean;
  href: (tagPath: string, state: CategoryState) => string;
  rankRelated: <T extends FacetablePage>(
    page: T,
    siblings: T[],
    tagPath: string,
    limit?: number,
  ) => RelatedRanking<T>;
}

export function createTaxonomy(config: TaxonomyConfig): Taxonomy {
  const href = config.href ?? defaultHref;
  const minPages = config.alphaIndexMinPages ?? DEFAULT_ALPHA_INDEX_MIN_PAGES;

  const facetKeys = (tagPath: string): MetadataKeyDefinition[] =>
    config.getMetadataKeys(tagPath).filter(k => k.type === 'select');

  const matches = (page: FacetablePage, filters: FacetFilters, letter?: string): boolean => {
    if (letter && firstLetter(page.title) !== letter) return false;
    return Object.entries(filters).every(([key, value]) => metaValue(page, key) === value);
  };

  const filterPages = <T extends FacetablePage>(
    pages: T[],
    filters: FacetFilters,
    letter?: string,
  ): T[] => {
    if (!Object.keys(filters).length && !letter) return pages;
    return pages.filter(p => matches(p, filters, letter));
  };

  return {
    facetKeys,
    href,
    filterPages,

    needsAlphaIndex: (pageCount: number) => pageCount >= minPages,

    facetFilters(tagPath, params) {
      const filters: FacetFilters = {};
      for (const key of facetKeys(tagPath)) {
        const value = params[key.key];
        if (typeof value === 'string' && value) filters[key.key] = value;
      }
      return filters;
    },

    /**
     * Facet values with counts. Each facet is counted over the set narrowed by
     * every *other* active filter, so its own options stay switchable rather
     * than collapsing to the one already chosen.
     *
     * Values are read from the data, never from the declared `options`: a key
     * that declares four and holds seven would otherwise hide three behind a
     * bar claiming to cover everything. Render what is there and the drift
     * becomes visible instead of silent.
     */
    buildFacets(tagPath, pages, filters, letter) {
      return facetKeys(tagPath).flatMap(key => {
        const others = Object.fromEntries(
          Object.entries(filters).filter(([k]) => k !== key.key),
        );
        const counts = new Map<string, number>();
        for (const page of filterPages(pages, others, letter)) {
          const value = metaValue(page, key.key);
          if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
        }
        // A single-valued facet is no choice, so it stays hidden — unless it is
        // the active one. An infobox row can set a filter the chips never
        // offered, and without its chip the reader lands on a narrowed list
        // with no way to widen it.
        if (counts.size < 2 && !(key.key in filters)) return [];
        const values = [...counts]
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
        return [{ key: key.key, label: key.label.replace(/:$/, ''), values }];
      });
    },

    /** A–Z buckets present in the set, `#` last. */
    alphaIndex(pages, filters) {
      const counts = new Map<string, number>();
      for (const page of filterPages(pages, filters)) {
        const letter = firstLetter(page.title);
        counts.set(letter, (counts.get(letter) ?? 0) + 1);
      }
      return [...counts]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) =>
          a.value === '#' ? 1 : b.value === '#' ? -1 : a.value.localeCompare(b.value),
        );
    },

    /**
     * Siblings ranked by how many facet values they share with the page — a
     * real relatedness signal. The behaviour this replaces (`pages.slice(0, 5)`
     * under a *See also* heading) showed every page in a 141-page category the
     * same five links. Ties keep the incoming order, so the tail degrades to
     * the category's own sort rather than to nothing.
     *
     * The shared facet comes back as `{key, value}` rather than a label so the
     * heading above the five can be the link into the whole filtered set, not
     * a sentence explaining what "related" meant.
     */
    rankRelated(page, siblings, tagPath, limit = 5) {
      const keys = facetKeys(tagPath);
      if (!keys.length) return { pages: siblings.slice(0, limit), sharedFacet: null };

      const score = (other: FacetablePage) =>
        keys.reduce(
          (n, k) =>
            n +
            (metaValue(page, k.key) && metaValue(other, k.key) === metaValue(page, k.key) ? 1 : 0),
          0,
        );
      const ranked = siblings
        .map((p, i) => ({ p, score: score(p), i }))
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .slice(0, limit);

      // Name the narrowest axis the page ACTUALLY SHARES with something in the
      // list — a `category` with 15 options says more than a `status` with 4, so
      // headline the narrower one, but only among the axes that are shared.
      //
      // Picking the narrowest axis the *page* carries, without checking whether
      // any returned sibling matches on it, produces a heading that links to a
      // set the list below it is not in: "More Classical pages in Nomenclature"
      // over five pages that are not Classical. The heading is the link into the
      // filtered set, so it has to name a filter that contains them.
      const matched = ranked.filter(r => r.score > 0);
      const narrowest = keys
        .filter(
          k =>
            metaValue(page, k.key) &&
            matched.some(r => metaValue(r.p, k.key) === metaValue(page, k.key)),
        )
        .sort((a, b) => (b.options?.length ?? 0) - (a.options?.length ?? 0))[0];
      const value = narrowest ? metaValue(page, narrowest.key) : '';
      return {
        pages: ranked.map(r => r.p),
        sharedFacet: narrowest && value ? { key: narrowest.key, value } : null,
      };
    },
  };
}
