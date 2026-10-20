// wiki-tools.ts – the read half of a wiki's MCP server, over its store and tree.
//
// radix-wiki wrote these seven tools first; caper copied them, kept the names
// and defaults, and added a batch read, a `path` on every row, a size and a miss
// that names the nearest pages. Both then ran them over Prisma queries of their
// own beside the store. miow had none, so a wiki it hosted answered no agent.
// One set now, the union of the two, over `wiki-formant/store`: every wiki that
// lists a page here lists it the way its HTML route does, hidden paths included.
//
// What is the app's: where a page lives (`url`), how blocks read as text,
// what a row adds (`metadata`), and how its corpus reads when it has an
// llms-full.txt to match. Writes stay with each app, because who may write
// is the one thing no two of them agree on.

import { McpToolError, readArgs, withAdjustments, type McpTool } from './mcp.js';
import { listEnvelope } from './pagination.js';
import { CORPUS_BUDGET, sliceCorpus, type CorpusSection } from './corpus.js';
import { isoDate } from './freshness.js';
import { wikiPath, type WikiNode, type WikiTree } from './tree.js';
import type { WikiStore, WikiPageListing, WikiPageRow, PageMetadata } from './store.js';
import type { DiffBlock } from './revisions.js';
import { describe } from './metadata.js';
import { openingText } from './text.js';

type ToolName = 'search_wiki' | 'get_page' | 'get_pages' | 'list_pages' | 'get_categories' | 'get_recent_changes' | 'get_full_corpus' | 'get_page_history';

export interface WikiToolsOptions<B extends DiffBlock> {
  store: WikiStore<B>;
  tree: WikiTree<WikiNode>;
  /** A page's absolute, canonical address. */
  url: (tagPath: string, slug: string) => string;
  /** A page's blocks as plain prose: what `get_page` returns and `chars` counts. */
  text: (blocks: B[]) => string;
  /** The wiki as the descriptions name it: "the Radix Wiki", "this DAO's wiki". */
  noun: string;
  /** The corpus document's heading. */
  corpusTitle: string;
  /** A prefix a pasted page URL may carry before the page's path, such as "/wiki". */
  pathPrefix?: string;
  /** Back-office pages are private here, not merely unlisted: no tool reads one. */
  privateHidden?: boolean;
  /** What `get_page` with `blocks: true` adds for the app's write tool, such as fields it keeps inside metadata. */
  forEdit?: (page: WikiPageRow<B>) => Record<string, unknown>;
  /** Display names by user id, for `get_page_history`. Without it a revision names no author. */
  authors?: (ids: string[]) => Promise<Map<string, string>>;
  /** What a listing row adds from the page's metadata, or null for nothing. */
  metadata?: (tagPath: string, metadata: PageMetadata) => Record<string, unknown> | null;
  /** A category's name as the tree lists it. Defaults to the node's `name`. */
  label?: (node: WikiNode) => string;
  /** The corpus as sections, when the app's llms-full.txt sets their form. Defaults to one per page from the store. */
  corpus?: (tagPath?: string) => Promise<CorpusSection[]>;
  /** What an empty search says. */
  noMatch?: (query: string, tagPath?: string) => string;
  /** A2A skills by tool, beside the defaults. */
  skills?: Partial<Record<ToolName, McpTool['skill']>>;
}

/** A read tool: the package's always say whether they write. */
export type WikiTool = McpTool & Required<Pick<McpTool, 'title' | 'annotations'>>;

const MAX_BATCH_PATHS = 20;
const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

const pathOf = (tagPath: string, slug: string) => wikiPath(tagPath, slug).slice(1);

/** How a single-page tool takes its page. */
const ADDRESS = {
  path: { type: 'string', description: 'The page\'s whole path, e.g. "developers/scrypto/blueprints". Preferred over tagPath + slug.' },
  tagPath: { type: 'string', description: 'Tag path only ("" for a top-level page). Ignored when `path` is set.' },
  slug: { type: 'string', description: 'Page slug. Ignored when `path` is set.' },
} as const;

type Rowable<B> = Pick<WikiPageListing, 'id' | 'title' | 'tagPath' | 'slug' | 'snippet' | 'metadata' | 'updatedAt' | 'lastVerifiedAt'> & { content?: B[] };

/** Whether a tag path is closed to these tools: a back office the wiki keeps private. */
const offFor = <B extends DiffBlock>(o: Pick<WikiToolsOptions<B>, 'store' | 'privateHidden'>) => (tagPath?: string) =>
  !!tagPath && !!o.privateHidden && o.store.isHidden(tagPath);

/** The row every listing returns: search, list, recent changes, and the app's own `?q=` twin. */
const rowFor = <B extends DiffBlock>(o: Pick<WikiToolsOptions<B>, 'url' | 'text' | 'metadata'>) => (p: Rowable<B>) => {
  const meta = o.metadata?.(p.tagPath, (p.metadata ?? {}) as PageMetadata);
  return {
    id: p.id,
    title: p.title,
    path: pathOf(p.tagPath, p.slug),
    url: o.url(p.tagPath, p.slug),
    tagPath: p.tagPath,
    slug: p.slug,
    ...(p.content ? { chars: o.text(p.content).length } : {}),
    snippet: p.snippet,
    updatedAt: isoDate(p.updatedAt),
    ...(p.lastVerifiedAt ? { lastVerified: isoDate(p.lastVerifiedAt) } : {}),
    ...(meta ? { metadata: meta } : {}),
  };
};

export type WikiRow = ReturnType<ReturnType<typeof rowFor>>;

/**
 * A page of ranked search rows, as `search_wiki` returns them. An app's plain
 * GET `?q=` and its search page call this too, so the three stay row for row
 * the same.
 */
export async function searchWiki<B extends DiffBlock>(
  o: Pick<WikiToolsOptions<B>, 'store' | 'privateHidden' | 'url' | 'text' | 'metadata'>,
  query: string,
  { tagPath, page = 1, size = 20 }: { tagPath?: string; page?: number; size?: number } = {},
): Promise<{ items: WikiRow[]; total: number }> {
  if (offFor(o)(tagPath)) return { items: [], total: 0 };
  const { items, total } = await o.store.search(query, { tagPath, skip: (page - 1) * size, take: size, content: true });
  return { items: items.map(rowFor(o)), total };
}

export function wikiReadTools<B extends DiffBlock>(o: WikiToolsOptions<B>): WikiTool[] {
  const { store, tree, noun } = o;
  const off = offFor(o);
  const summary = rowFor(o);

  /** "tag/path/slug", from the path itself or a pasted URL of it. */
  const target = (input: string) => {
    let clean = input.trim().replace(/^https?:\/\/[^/]+/, '');
    if (o.pathPrefix && (clean === o.pathPrefix || clean.startsWith(`${o.pathPrefix}/`))) clean = clean.slice(o.pathPrefix.length);
    const parts = clean.split(/[?#]/)[0]!.split('/').filter(Boolean);
    const slug = parts.pop();
    return slug ? { tagPath: parts.join('/'), slug } : null;
  };

  /** The article at a path, else the hub of the category the whole path is. The article wins where both exist. */
  const read = async (t: { tagPath: string; slug: string }) => {
    const page = (await store.get(t.tagPath, t.slug)) ?? (await store.get(pathOf(t.tagPath, t.slug), ''));
    return page && !off(page.tagPath) ? page : null;
  };

  /** The page a call names by `path` or `tagPath` + `slug`; a miss names the nearest pages, so a wrong guess is fixed in one retry. */
  const named = async (r: ReturnType<typeof readArgs>) => {
    const raw = r.str('path');
    const t = raw ? target(raw) : { tagPath: r.str('tagPath'), slug: r.str('slug') };
    if (!t?.slug) throw new McpToolError('Pass either `path` ("tag/path/slug") or `slug` (with optional `tagPath`).');
    const page = await read(t);
    if (page) return page;
    const near = await store.search(t.slug.replace(/-/g, ' '), { take: 5 });
    throw new McpToolError(`No page at path "${pathOf(t.tagPath, t.slug)}".`, {
      didYouMean: near.items.filter(p => !off(p.tagPath)).map(p => ({ path: pathOf(p.tagPath, p.slug), title: p.title })),
      hint: 'Paths are exact. Use search_wiki for a keyword, or list_pages with the tagPath to enumerate the branch.',
    });
  };

  const full = (page: NonNullable<Awaited<ReturnType<typeof read>>>) => ({
    ...summary({ ...page, snippet: describe(openingText(page.content)) }),
    version: page.version,
    content: o.text(page.content),
  });

  const sections = async (tagPath?: string): Promise<CorpusSection[]> => {
    if (o.corpus) return o.corpus(tagPath);
    const pages = (await store.corpus())
      .filter(p => !(p.tagPath === '' && p.slug === '') && (!tagPath || p.tagPath === tagPath || p.tagPath.startsWith(`${tagPath}/`)))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return pages.map(p => {
      const path = pathOf(p.tagPath, p.slug);
      return { path, tagPath: p.tagPath, section: `## ${p.title}\n\nPath: ${path}\nURL: ${o.url(p.tagPath, p.slug)}\nUpdated: ${isoDate(p.updatedAt)}\n\n${o.text(p.content)}` };
    });
  };

  const tools: (WikiTool & { name: ToolName })[] = [
    {
      name: 'search_wiki',
      title: 'Search the wiki',
      annotations: READ,
      skill: { id: 'search', tags: ['search', 'wiki'] },
      description:
        `Keyword search across ${noun}: the first call when you know what you are looking for but not where it lives. ` +
        'Matches titles and body prose, ranked in four tiers: titles starting with the term, titles containing it, literal body hits, then English full-text hits by relevance, which stem words and drop stopwords. ' +
        'Not semantic: one distinctive word beats a sentence. ' +
        'Each row carries a `path`, its size in `chars` and a snippet windowed on the match. Feed the paths to get_pages in one call rather than looping get_page. ' +
        'Narrow with tagPath when a term is common. Defaults: page 1, pageSize 20 (max 50); keep paging while `hasMore` is true.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term, matched against page titles and body text' },
          tagPath: { type: 'string', description: 'Only pages at this tag path, e.g. a path from get_categories' },
          page: { type: 'number', description: '1-based page number (default 1)', minimum: 1 },
          pageSize: { type: 'number', description: 'Results per page (default 20, max 50)', minimum: 1, maximum: 50 },
        },
        required: ['query'],
      },
      handler: async args => {
        const r = readArgs(args);
        const query = r.str('query');
        const tagPath = r.str('tagPath') || undefined;
        const page = r.num('page', 1, 1, 100_000);
        const size = r.num('pageSize', 20, 1, 50);
        if (!query) throw new McpToolError('`query` is empty. Pass a keyword to search for, or call list_pages to enumerate a branch instead.');
        const { items, total } = await searchWiki(o, query, { tagPath, page, size });
        return withAdjustments(r, {
          query,
          ...listEnvelope(
            items, total, page, size,
            o.noMatch?.(query, tagPath)
              ?? `Nothing matches "${query}"${tagPath ? ` under "${tagPath}"` : ''}. Search is keyword, not semantic: try one distinctive word${tagPath ? ', or drop the tagPath filter' : ''}, or call get_categories to see what ${noun} covers.`,
          ),
        });
      },
    },
    {
      name: 'get_page',
      title: 'Read a page',
      annotations: READ,
      skill: { id: 'read', tags: ['read', 'content', 'article'] },
      description:
        `One page of ${noun} in full: its text, version, update date and metadata. ` +
        'Address it by `path` ("tag/path/slug", exactly the `path` or `url` a listing returns), or by `tagPath` + `slug`; a category\'s own path reads its hub article. Not a title. ' +
        'For 2 to 20 pages call get_pages, one round trip rather than N. A miss names the nearest pages, so a wrong guess is fixed in one retry. ' +
        'A page\'s URL with `.md` appended is its markdown. ' +
        'With `blocks: true`, `content` is the stored block array, ids and all, beside the page `id` and its whole `metadata`: read a page this way before editing it, and send its `version` back as the edit\'s baseVersion.',
      inputSchema: {
        type: 'object',
        properties: {
          ...ADDRESS,
          blocks: { type: 'boolean', description: 'Return the stored blocks rather than prose, for an edit' },
        },
        requireOneOf: ['path', 'slug'],
      },
      handler: async args => {
        const r = readArgs(args);
        const page = await named(r);
        if (!r.bool('blocks')) return withAdjustments(r, full(page));
        return withAdjustments(r, { ...full(page), id: page.id, content: page.content, metadata: page.metadata, ...o.forEdit?.(page) });
      },
    },
    {
      name: 'get_pages',
      title: `Read up to ${MAX_BATCH_PATHS} pages`,
      annotations: READ,
      description:
        `Batch read: 1 to ${MAX_BATCH_PATHS} pages of ${noun} in full in one call, which is how to read search or listing results. ` +
        'Pass `paths` as the listings return them. Paths that do not exist come back in `missing` rather than failing the call, ' +
        `anything past ${MAX_BATCH_PATHS} in \`remaining\`, and pages past \`maxChars\` (default 250000) in \`omitted\` with their sizes.`,
      inputSchema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: `Page paths, 1 to ${MAX_BATCH_PATHS} per call` },
          maxChars: { type: 'number', description: 'Total characters across the pages returned (default 250000, max 1000000)', minimum: 1_000, maximum: 1_000_000 },
        },
        required: ['paths'],
      },
      handler: async args => {
        const r = readArgs(args);
        const maxChars = r.num('maxChars', 250_000, 1_000, 1_000_000);
        const requested = [...new Set(r.list('paths').map(s => String(s).trim()).filter(Boolean))];
        if (!requested.length) throw new McpToolError('`paths` is empty. Pass at least one page path.', { hint: 'search_wiki and list_pages return a `path` for every result.' });
        const taken = requested.slice(0, MAX_BATCH_PATHS);
        const remaining = requested.slice(MAX_BATCH_PATHS);
        if (remaining.length) r.note({ param: 'paths', requested: requested.length, used: taken.length, reason: `max ${MAX_BATCH_PATHS} paths per call; the rest are listed in \`remaining\`` });
        const found = await Promise.all(taken.map(async input => {
          const t = target(input);
          return { input, page: t && (await read(t)) };
        }));
        const pages: object[] = [];
        const missing: string[] = [];
        const omitted: { path: string; chars: number }[] = [];
        let used = 0;
        for (const { input, page } of found) {
          if (!page) { missing.push(input); continue; }
          const row = full(page);
          // At least one page always comes back, so one oversized page can still be read.
          if (pages.length && used + row.content.length > maxChars) { omitted.push({ path: row.path, chars: row.content.length }); continue; }
          used += row.content.length;
          pages.push(row);
        }
        return withAdjustments(r, {
          requested: requested.length,
          returned: pages.length,
          characters: used,
          maxChars,
          pages,
          ...(missing.length ? { missing, missingHint: 'Not found. Re-check the path with search_wiki or list_pages.' } : {}),
          ...(omitted.length ? { omitted, omittedHint: 'Skipped to stay inside maxChars. Ask for these on their own or raise maxChars.' } : {}),
          ...(remaining.length ? { remaining } : {}),
        });
      },
    },
    {
      name: 'list_pages',
      title: 'List pages',
      annotations: READ,
      skill: { id: 'list', tags: ['list', 'browse', 'categories'] },
      description:
        `Browse ${noun} by tag path rather than by keyword: every page under a branch, newest first by default. ` +
        '`tagPath` matches the branch and everything beneath it; omit it to walk the whole wiki. Sort by title for an A–Z pass. ' +
        'Same rows as search_wiki, with `totalPages`, `hasMore` and `nextPage`. Defaults: page 1, pageSize 20 (max 100).',
      inputSchema: {
        type: 'object',
        properties: {
          tagPath: { type: 'string', description: 'The branch to list, e.g. a path from get_categories. Includes its descendants.' },
          sort: { type: 'string', enum: ['title', 'updatedAt'], description: 'Sort order (default "updatedAt", newest first)' },
          page: { type: 'number', description: '1-based page number (default 1)', minimum: 1 },
          pageSize: { type: 'number', description: 'Results per page (default 20, max 100)', minimum: 1, maximum: 100 },
        },
      },
      handler: async args => {
        const r = readArgs(args);
        const tagPath = r.str('tagPath') || undefined;
        const page = r.num('page', 1, 1, 100_000);
        const size = r.num('pageSize', 20, 1, 100);
        const sort = r.str('sort') === 'title' ? 'title' : 'recent';
        const { items, total } = off(tagPath) ? { items: [], total: 0 } : await store.branch({ tagPath, sort, limit: size, offset: (page - 1) * size });
        return withAdjustments(r, {
          ...(tagPath ? { tagPath } : {}),
          ...listEnvelope(
            items.map(summary), total, page, size,
            tagPath ? `No pages at tagPath "${tagPath}". Call get_categories for the tag paths that exist.` : `${noun} has no pages yet.`,
          ),
        });
      },
    },
    {
      name: 'get_categories',
      title: 'List categories',
      annotations: READ,
      description:
        `The category tree of ${noun}, the cheapest way to orient before searching. ` +
        'Each node carries its `path` (a tagPath list_pages and search_wiki take), name, description, `pageCount` (pages filed at that path) and `pageCountDeep` (with every descendant). ' +
        '`tagPaths` lists every tag path that holds pages, including any the tree does not name.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const rows = await store.counts();
        const exact = (path: string) => rows.find(c => c.tagPath === path)?.pages ?? 0;
        const deep = (path: string) => rows.filter(c => c.tagPath === path || c.tagPath.startsWith(`${path}/`)).reduce((n, c) => n + c.pages, 0);
        const build = (nodes: readonly WikiNode[], parent: string): object[] =>
          nodes.filter(n => !n.hidden && n.slug).map(n => {
            const path = parent ? `${parent}/${n.slug}` : n.slug;
            const children = n.children?.length ? build(n.children, path) : [];
            return {
              path,
              name: o.label?.(n) ?? n.name,
              ...(n.description ? { description: n.description } : {}),
              pageCount: exact(path),
              pageCountDeep: deep(path),
              ...(children.length ? { children } : {}),
            };
          });
        return {
          totalPages: rows.reduce((n, c) => n + c.pages, 0),
          categories: build(tree.nodes, ''),
          tagPaths: [...rows].sort((a, b) => b.pages - a.pages).map(c => ({ path: c.tagPath, pageCount: c.pages })),
        };
      },
    },
    {
      name: 'get_recent_changes',
      title: 'Recent changes',
      annotations: READ,
      description:
        `Pages of ${noun} edited within the last N days, newest first: what to poll when you are watching the wiki rather than reading it. ` +
        'Same rows as list_pages. Defaults: days 7 (max 30), limit 20 (max 50). `truncated: true` means the limit cut the list; raise it, or page through list_pages.',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Look back this many days (default 7, max 30)', minimum: 1, maximum: 30 },
          limit: { type: 'number', description: 'Most pages returned (default 20, max 50)', minimum: 1, maximum: 50 },
        },
      },
      handler: async args => {
        const r = readArgs(args);
        const days = r.num('days', 7, 1, 30);
        const limit = r.num('limit', 20, 1, 50);
        // N × 24h back, not N calendar days: a DST change would move the window by an hour.
        const since = new Date(Date.now() - days * 86_400_000);
        const { items, total } = await store.branch({ sort: 'recent', limit, since });
        return withAdjustments(r, {
          days,
          since: since.toISOString(),
          limit,
          total,
          count: items.length,
          truncated: total > items.length,
          pages: items.map(summary),
        });
      },
    },
    {
      name: 'get_full_corpus',
      title: 'Whole corpus',
      annotations: READ,
      description:
        `The whole of ${noun} as one text document, for bulk ingestion. ` +
        'Preflight first: sizeOnly=true returns the character count, a token estimate, the per-branch breakdown and the largest pages. ' +
        `Then pull it with \`maxChars\` (default ${CORPUS_BUDGET.default}, max ${CORPUS_BUDGET.max}), or one branch at a time with \`tagPath\`. ` +
        'Truncation is page-aligned: `truncated`, `omittedPages` and `nextSkip` say where to resume (pass skip=nextSkip). For a handful of pages get_pages is cheaper.',
      inputSchema: {
        type: 'object',
        properties: {
          sizeOnly: { type: 'boolean', description: 'Sizes and breakdowns only, no document. Do this before the first real pull.' },
          tagPath: { type: 'string', description: 'One branch and its descendants. Omit for everything.' },
          maxChars: { type: 'number', description: `Character budget for \`document\` (default ${CORPUS_BUDGET.default}, max ${CORPUS_BUDGET.max})`, minimum: CORPUS_BUDGET.min, maximum: CORPUS_BUDGET.max },
          skip: { type: 'number', description: 'Resume from this page index: the `nextSkip` of the previous truncated call (default 0)', minimum: 0 },
        },
      },
      handler: async args => {
        const r = readArgs(args);
        const tagPath = r.str('tagPath') || undefined;
        const slice = sliceCorpus(off(tagPath) ? [] : await sections(tagPath), {
          title: o.corpusTitle,
          sizeOnly: r.bool('sizeOnly'),
          maxChars: r.num('maxChars', CORPUS_BUDGET.default, CORPUS_BUDGET.min, CORPUS_BUDGET.max),
          skip: r.num('skip', 0, 0, 1_000_000),
          hint: 'Pull with maxChars, or one branch at a time with tagPath. get_pages is cheaper for a handful of pages.',
        });
        return withAdjustments(r, { scope: o.corpusTitle, ...(tagPath ? { tagPath } : {}), ...slice });
      },
    },
    {
      name: 'get_page_history',
      title: 'Page history',
      annotations: READ,
      description:
        `A page's revisions in ${noun}, newest first: each one's \`id\`, version, change type, message, date and the blocks it changed. ` +
        'Address the page as get_page does. A revision `id` is what a restore takes, where this server has one. Defaults: limit 20 (max 100).',
      inputSchema: {
        type: 'object',
        properties: {
          ...ADDRESS,
          limit: { type: 'number', description: 'Most revisions returned (default 20, max 100)', minimum: 1, maximum: 100 },
        },
        requireOneOf: ['path', 'slug'],
      },
      handler: async args => {
        const r = readArgs(args);
        const page = await named(r);
        const revisions = await store.history(page.id, { limit: r.num('limit', 20, 1, 100) });
        const names = o.authors && await o.authors([...new Set(revisions.flatMap(v => v.authorId ? [v.authorId] : []))]);
        return withAdjustments(r, {
          path: pathOf(page.tagPath, page.slug),
          url: o.url(page.tagPath, page.slug),
          currentVersion: page.version,
          revisions: revisions.map(({ pageId: _, authorId, ...v }) => ({ ...v, ...(names ? { author: (authorId && names.get(authorId)) || null } : {}) })),
        });
      },
    },
  ];

  return tools.map(t => (o.skills?.[t.name] ? { ...t, skill: o.skills[t.name] } : t));
}
