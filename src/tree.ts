// tree.ts – a wiki's category tree, and what a URL path means against it.
//
// Three wikis declared their tree three ways: radix-wiki's `TAG_HIERARCHY`
// (slug + children, keys and sort inherited down the trail), caper's
// `WIKI_CATEGORIES` (each node naming its full `tagPath`, with a `categoryTrail`
// walk of its own) and acuiq's `WIKI_SECTIONS` (one flat level). Each then
// re-derived the same answers by hand: is this a real category, which metadata
// keys apply here, which article is this page "part of a series on", what sort
// does a listing default to, which paths are back office.
//
// The node holds what every wiki reads; anything only one wiki reads (an XRD
// threshold, a band, an icon set) rides on the node as an extra field, and the
// app folds it from `trail`. Pure: no data access, so a client component and
// the server route read paths through the same parser.

import type { MetadataKeyDefinition } from './taxonomy.js';
import type { ListSort } from './store.js';

export interface WikiNode {
  /** The path segment. A root node with the empty slug stands for the home page. */
  slug: string;
  name: string;
  description?: string;
  /** A glyph or an icon name; the app draws it. */
  icon?: string;
  /**
   * The article that *is* this category's topic, as a full `tagPath/slug`. It
   * need not live in the category. Inherited: the nearest declaration down the
   * trail is the series a page under it belongs to.
   */
  mainArticle?: string;
  /** Inherited: a node beneath a hidden one is back office too. */
  hidden?: boolean;
  /** A listing's default order. Inherited. */
  sort?: ListSort;
  /** Accumulated down the trail, in declaration order. */
  metadataKeys?: readonly MetadataKeyDefinition[];
  /** Slugs under this node in the order a listing should lead with; the rest follow. */
  pages?: readonly string[];
  children?: readonly WikiNode[];
}

export interface Resolved<N extends WikiNode> {
  node: N | null;
  /** Every node from the root to this one. Empty when the path is not in the tree. */
  trail: N[];
  valid: boolean;
  hidden: boolean;
  sort: ListSort;
  mainArticle?: string;
  metadataKeys: MetadataKeyDefinition[];
}

export interface TreePath<N extends WikiNode> {
  path: string;
  node: N;
  hidden: boolean;
  depth: number;
}

export interface TreeOptions {
  /** Keys every page carries whatever its category, such as a quality grade. Listed after the trail's. */
  globalKeys?: readonly MetadataKeyDefinition[];
}

const segmentsOf = (tagPath: string | readonly string[]) =>
  typeof tagPath === 'string' ? tagPath.split('/').filter(Boolean) : tagPath.filter(Boolean);

export function createTree<N extends WikiNode>(nodes: readonly N[], opts: TreeOptions = {}) {
  const globalKeys = [...(opts.globalKeys ?? [])];
  const cache = new Map<string, Resolved<N>>();

  function resolve(tagPath: string | readonly string[]): Resolved<N> {
    const segments = segmentsOf(tagPath);
    const key = segments.join('/');
    const hit = cache.get(key);
    if (hit) return hit;
    const trail: N[] = [];
    const metadataKeys: MetadataKeyDefinition[] = [];
    let level: readonly WikiNode[] = nodes;
    let sort: ListSort = 'title';
    let mainArticle: string | undefined;
    let hidden = false;
    for (const segment of segments) {
      const node = level.find(n => n.slug === segment) as N | undefined;
      if (!node) {
        const missing: Resolved<N> = { node: null, trail: [], valid: false, hidden: false, sort: 'title', metadataKeys: [] };
        cache.set(key, missing);
        return missing;
      }
      trail.push(node);
      if (node.metadataKeys) metadataKeys.push(...node.metadataKeys);
      if (node.sort) sort = node.sort;
      if (node.mainArticle) mainArticle = node.mainArticle;
      hidden ||= !!node.hidden;
      level = node.children ?? [];
    }
    metadataKeys.push(...globalKeys);
    const resolved: Resolved<N> = { node: trail.at(-1) ?? null, trail, valid: trail.length > 0, hidden, sort, mainArticle, metadataKeys };
    cache.set(key, resolved);
    return resolved;
  }

  /** Every path in the tree, depth first, parents before children. */
  function paths(level: readonly WikiNode[] = nodes, parent = '', inherited = false, depth = 0): TreePath<N>[] {
    return level.flatMap(node => {
      const path = parent ? `${parent}/${node.slug}` : node.slug;
      const hidden = inherited || !!node.hidden;
      return [{ path, node: node as N, hidden, depth }, ...paths(node.children ?? [], path, hidden, depth + 1)];
    });
  }

  const all = paths();

  return {
    nodes,
    resolve,
    paths: () => all,
    /** Back-office paths, which a listing leaves out unless it names one. Pass to `wikiStore({ hidden })`. */
    hiddenPaths: all.filter(p => p.hidden && p.path).map(p => p.path),
    isValid: (tagPath: string | readonly string[]) => resolve(tagPath).valid,
    node: (tagPath: string | readonly string[]) => resolve(tagPath).node,
    metadataKeys: (tagPath: string | readonly string[]) => resolve(tagPath).metadataKeys,
    /** A category's name, or its last segment unslugged when the tree does not know it. */
    label: (tagPath: string | readonly string[]) =>
      resolve(tagPath).node?.name ?? (segmentsOf(tagPath).at(-1) ?? '').replace(/-/g, ' '),
    /**
     * One crumb per segment, so the trail can never be shorter than the URL. A
     * segment the tree knows is a link to its category; one it does not is text.
     */
    crumbs: (tagPath: string | readonly string[]) => {
      const segments = segmentsOf(tagPath);
      return segments.map((segment, i) => {
        const path = segments.slice(0, i + 1).join('/');
        const node = resolve(path).node;
        return { path, label: node?.name ?? segment.replace(/-/g, ' '), linked: !!node };
      });
    },
  };
}

export type WikiTree<N extends WikiNode = WikiNode> = ReturnType<typeof createTree<N>>;

/** The views a page or a category has beside itself, each a final path segment. */
export const WIKI_MODES = ['edit', 'history'] as const;
export type WikiMode = (typeof WIKI_MODES)[number];

export interface ParsedWikiPath<M extends string = WikiMode> {
  type: 'home' | 'category' | 'page' | 'invalid';
  tagPath: string;
  slug: string;
  mode: M | null;
}

/**
 * What a path means: the home page, a category (its hub article is the empty
 * slug), a page, or nothing, each optionally in one of `modes`. A path that is
 * itself a category wins over a mode suffix, so a category named `history` is
 * still reachable; `/<category>/edit` edits the category's hub.
 *
 * Static routes are the app's: check them before calling this.
 */
export function parseWikiPath<M extends string = WikiMode>(
  tree: Pick<WikiTree, 'isValid'>,
  segments: readonly string[] = [],
  { modes = WIKI_MODES as unknown as readonly M[] }: { modes?: readonly M[] } = {},
): ParsedWikiPath<M> {
  const parts = segments.filter(Boolean);
  const last = parts.at(-1) as M | undefined;
  const mode = last && modes.includes(last) && !tree.isValid(parts) ? last : null;
  const path = mode ? parts.slice(0, -1) : parts;
  const invalid: ParsedWikiPath<M> = { type: 'invalid', tagPath: '', slug: '', mode: null };
  if (!path.length) return { type: 'home', tagPath: '', slug: '', mode };
  if (tree.isValid(path)) return { type: 'category', tagPath: path.join('/'), slug: '', mode };
  if (path.length < 2 || !tree.isValid(path.slice(0, -1))) return invalid;
  return { type: 'page', tagPath: path.slice(0, -1).join('/'), slug: path.at(-1)!, mode };
}

/**
 * A slug no page in `tagPath` can hold, because `parseWikiPath` reads that URL
 * as something else: a mode, or a child category. Creating a page treats it as
 * taken.
 */
export function isReservedSlug(tree: Pick<WikiTree, 'isValid'>, tagPath: string, slug: string, modes: readonly string[] = WIKI_MODES): boolean {
  return modes.includes(slug) || tree.isValid([...segmentsOf(tagPath), slug]);
}

/** A page's path: the category for its hub, `/` for the home page. */
export function wikiPath(tagPath: string, slug: string): string {
  return `/${[tagPath, slug].filter(Boolean).join('/')}`;
}
