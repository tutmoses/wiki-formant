// store.ts – a wiki's pages and revisions, over the app's own connection.
//
// Three wikis each kept their own copy of this layer, on three schemas that had
// drifted apart: `pages(tag_path, slug)` with cuid ids, `wiki_pages(caper_id,
// tag_path, slug)` with int ids and no version, `WikiPage(section, slug)` with
// no author. Each copy wrote its page and its revision its own way, and two of
// them read the page, diffed it, and wrote it back with nothing to stop a
// second editor's save landing in between and being overwritten.
//
// The tables are now the package's (`prisma/wiki.prisma`, copied by the
// `prisma-models` bin), so the SQL is too. The app supplies one `Sql` function
// and, in a multi-tenant app, the site the store reads and writes. Caching
// stays with the caller, because each framework spells it differently.
//
// A write is one statement: the page update and its revision row are a
// data-modifying CTE guarded on the version the save read, so a save that lost
// a race writes nothing and says so (409) instead of erasing the other edit.

import type { Sql } from './analytics.js';
import type { BlockGroup, DiffBlock } from './revisions.js';
import { computeRevisionDiff } from './revisions.js';
import { bump, type ChangeType } from './versioning.js';
import { withChanges, type HistoryChange } from './history.js';
import { proseSql, escapeLikeTerm, HEADLINE_OPTIONS, FTS_RANK_NORMALIZATION } from './search.js';
import { openingText, matchSnippet } from './text.js';
import { describe } from './metadata.js';
import { decodeEntities } from './markdown.js';
import { HttpError } from './http.js';

export type { Sql };

export type PageMetadata = Record<string, unknown>;

/** A page as stored. */
export interface WikiPageRow<B = unknown> {
  id: string;
  siteId: string;
  tagPath: string;
  slug: string;
  title: string;
  content: B[];
  metadata: PageMetadata;
  version: string;
  authorId: string | null;
  lastVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A page as a listing carries it: one line of the article instead of the
 * article. A category of 200 cards otherwise ships 200 block arrays to the
 * browser.
 */
export type WikiPageListing = Omit<WikiPageRow, 'content'> & { snippet: string };

export interface WikiPageRef {
  tagPath: string;
  slug: string;
  title: string;
}

export interface WikiRevisionRow<B = unknown> {
  id: string;
  pageId: string;
  title: string;
  content: B[];
  version: string;
  changeType: string;
  message: string | null;
  authorId: string | null;
  createdAt: Date;
}

export type WikiRevisionEntry = Omit<WikiRevisionRow, 'content'> & { changes: HistoryChange[] };

export type ListSort = 'title' | 'recent' | 'date';

export interface WikiStoreOptions<B extends DiffBlock> {
  sql: Sql;
  /** The site every read and write is scoped to. "" in an app that serves one wiki. */
  siteId?: string;
  /**
   * Tag paths a listing leaves out unless it names them: a wiki's back office,
   * such as the maintenance log a routine rewrites every few hours. A hidden
   * page keeps its URL, its twin and its history; it never arrives unasked.
   */
  hidden?: readonly string[];
  /** The block tree's containers, for diffs. Defaults to the core model's (`coreBlockGroups`). */
  containers?: (block: B) => BlockGroup<B>[] | null;
  /**
   * A listing's line for a page when nothing better is found: a search hit
   * whose match is in the title alone, and every card. Defaults to the
   * article's opening; a wiki that keeps a written summary in metadata says so.
   */
  snippet?: (page: Pick<WikiPageRow<B>, 'content' | 'metadata'>) => string;
}

export interface SaveInput<B> {
  tagPath: string;
  slug: string;
  title?: string;
  content?: B[];
  /** Replaces the page's metadata whole. Omit to keep it. */
  metadata?: PageMetadata;
  authorId?: string | null;
  /** The history's line for this save. Defaults to what the diff found ("1 block modified"). */
  message?: string | null;
  /**
   * The version the writer opened. A save that finds the page has moved on is
   * refused with 409 rather than quietly overwriting the edit in between.
   */
  baseVersion?: string;
  /**
   * The bump to record instead of the one the diff picks, for a writer that
   * knows. Stated, it always writes a revision, even for a save the diff finds
   * empty: a routine recording a reading in metadata wants it in the history.
   */
  change?: Exclude<ChangeType, 'none'>;
  /** The writer's word that the page's facts were checked: stamps `lastVerifiedAt`. */
  verified?: boolean;
  /** Moves the page to another slug in the same tag path. */
  newSlug?: string;
}

export interface SaveResult<B> {
  page: WikiPageRow<B>;
  created: boolean;
  /** `none` when the save changed nothing a revision records, so none was written. */
  changeType: ChangeType;
  summary: string;
}

const PAGE = '"WikiPage"';
const REVISION = '"WikiRevision"';
const COLUMNS = `id, "siteId", "tagPath", slug, title, content, metadata, version, "authorId", "lastVerifiedAt", "createdAt", "updatedAt"`;
const REVISION_COLUMNS = `id, "pageId", title, content, version, "changeType", message, "authorId", "createdAt"`;
const REVISION_COUNT = `(SELECT count(*)::int FROM ${REVISION} r WHERE r."pageId" = p.id) AS "revisionCount"`;
const INITIAL_VERSION = '1.0.0';

/** A row as a listing carries it, for an app that runs a listing query of its own. */
export function toListing<R extends { content?: unknown }>(row: R): Omit<R, 'content'> & { snippet: string } {
  const { content, ...rest } = row;
  return { ...rest, snippet: describe(openingText(content)) };
}


const conflict = (message: string) => new HttpError(409, message);
const SLUG_TAKEN = 'A page with that slug already exists in this category';

/** Re-order rows to match an id list, dropping ids that no longer resolve. */
export function orderByIds<T extends { id: string }>(rows: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(rows.map(row => [row.id, row]));
  return ids.map(id => byId.get(id)).filter((row): row is T => row !== undefined);
}

export function wikiStore<B extends DiffBlock = DiffBlock>(o: WikiStoreOptions<B>) {
  const site = o.siteId ?? '';
  const opening = o.snippet ?? ((page: Pick<WikiPageRow<B>, 'content'>) => describe(openingText(page.content)));
  const listing = (row: WikiPageRow): WikiPageListing => {
    const { content: _, ...rest } = row;
    return { ...rest, snippet: opening(row as WikiPageRow<B>) };
  };
  const hidden = [...(o.hidden ?? [])];
  const rows = async <T>(query: string, ...values: unknown[]) => (await o.sql(query, ...values)) as T[];
  const one = async <T>(query: string, ...values: unknown[]) => (await rows<T>(query, ...values))[0] ?? null;

  /**
   * `isHidden` in SQL, over a table aliased `p`, `param` holding the list: a
   * path under a hidden one is back office too, whether or not the tree names it.
   */
  const hiddenSql = (param: string) => `EXISTS (SELECT 1 FROM unnest(${param}::text[]) h WHERE p."tagPath" = h OR starts_with(p."tagPath", h || '/'))`;

  const isHidden = (tagPath: string) => hidden.some(h => tagPath === h || tagPath.startsWith(`${h}/`));

  /** A page with how many revisions it has, which every article's foot states. */
  const get = (tagPath: string, slug: string) =>
    one<WikiPageRow<B> & { revisionCount: number }>(`SELECT ${COLUMNS}, ${REVISION_COUNT} FROM ${PAGE} p WHERE "siteId" = $1 AND "tagPath" = $2 AND slug = $3`, site, tagPath, slug);

  const getById = (id: string) =>
    one<WikiPageRow<B> & { revisionCount: number }>(`SELECT ${COLUMNS}, ${REVISION_COUNT} FROM ${PAGE} p WHERE "siteId" = $1 AND id = $2`, site, id);

  const ORDER: Record<ListSort, string> = {
    title: 'title ASC',
    recent: '"updatedAt" DESC',
    // A post or an event is as recent as the day it is about.
    date: `NULLIF(metadata->>'date', '') DESC NULLS LAST, "updatedAt" DESC`,
  };

  /** A category's pages, its hub article (the empty slug) excepted: the hub heads the page, it is not a card in it. */
  const list = async (tagPath: string, { sort = 'title', limit = 200, offset = 0 }: { sort?: ListSort; limit?: number; offset?: number } = {}) =>
    (await rows<WikiPageRow>(
      `SELECT ${COLUMNS} FROM ${PAGE} WHERE "siteId" = $1 AND "tagPath" = $2 AND slug <> '' ORDER BY ${ORDER[sort]} LIMIT $3::int OFFSET $4::int`,
      site, tagPath, limit, offset,
    )).map(listing);

  /** A category's pages with their content, for a listing that reads the bodies (a reading time, a word count). */
  const articles = (tagPath: string, { sort = 'title', limit = 200, offset = 0 }: { sort?: ListSort; limit?: number; offset?: number } = {}) =>
    rows<WikiPageRow<B>>(
      `SELECT ${COLUMNS} FROM ${PAGE} WHERE "siteId" = $1 AND "tagPath" = $2 AND slug <> '' ORDER BY ${ORDER[sort]} LIMIT $3::int OFFSET $4::int`,
      site, tagPath, limit, offset,
    );

  /** Every page under a category, by title: the card that lists a subcategory's articles. */
  const subtree = (tagPath: string) =>
    rows<WikiPageRef>(
      `SELECT "tagPath", slug, title FROM ${PAGE} p
        WHERE "siteId" = $1 AND "tagPath" LIKE $2 AND slug <> '' AND NOT ${hiddenSql('$3')}
        ORDER BY title ASC`,
      site, `${escapeLikeTerm(tagPath)}/%`, hidden,
    );

  /**
   * The newest pages. One that names a path gets that path, hidden or not; one
   * that names none is asking what changed on the wiki, and the answer is
   * article space.
   */
  const recent = async ({ tagPath, limit = 10 }: { tagPath?: string; limit?: number } = {}) =>
    (await (tagPath !== undefined
      ? rows<WikiPageRow>(`SELECT ${COLUMNS} FROM ${PAGE} WHERE "siteId" = $1 AND "tagPath" = $2 ORDER BY "updatedAt" DESC LIMIT $3::int`, site, tagPath, limit)
      : rows<WikiPageRow>(`SELECT ${COLUMNS} FROM ${PAGE} p WHERE "siteId" = $1 AND NOT ${hiddenSql('$2')} ORDER BY "updatedAt" DESC LIMIT $3::int`, site, hidden, limit)
    )).map(listing);

  const byIds = async (ids: readonly string[]) =>
    ids.length
      ? orderByIds((await rows<WikiPageRow>(`SELECT ${COLUMNS} FROM ${PAGE} WHERE "siteId" = $1 AND id = ANY($2::text[])`, site, [...ids])).map(listing), ids)
      : [];

  /** Every page without its content: the sitemap, llms.txt and a site's page list. */
  const refs = () =>
    rows<Omit<WikiPageRow, 'content'>>(`SELECT id, "siteId", "tagPath", slug, title, metadata, version, "authorId", "lastVerifiedAt", "createdAt", "updatedAt" FROM ${PAGE} WHERE "siteId" = $1 ORDER BY "tagPath", slug`, site);

  /** Every page with its content, for a corpus export. Hidden paths are left out. */
  const corpus = () =>
    rows<WikiPageRow<B>>(`SELECT ${COLUMNS} FROM ${PAGE} p WHERE "siteId" = $1 AND NOT ${hiddenSql('$2')} ORDER BY "tagPath", slug`, site, hidden);

  /**
   * A branch for an agent walking the wiki: the path named and everything
   * under it, with the total a pager needs. Naming a path gets it even when it
   * is hidden, and never a hidden path beneath it; naming none gets article
   * space, the home page excepted. `since` keeps what changed from then on.
   */
  const branch = async ({ tagPath, sort = 'recent', limit = 20, offset = 0, since }: { tagPath?: string; sort?: ListSort; limit?: number; offset?: number; since?: Date } = {}) => {
    const where = `"siteId" = $1
        AND ($2::text IS NULL OR "tagPath" = $2 OR starts_with("tagPath", $2 || '/'))
        AND (("tagPath" = $2) IS TRUE OR NOT ${hiddenSql('$3')})
        AND NOT ("tagPath" = '' AND slug = '')
        AND ($4::timestamptz IS NULL OR "updatedAt" >= $4)`;
    const values = [site, tagPath || null, hidden, since ?? null];
    const [found, count] = await Promise.all([
      rows<WikiPageRow<B>>(`SELECT ${COLUMNS} FROM ${PAGE} p WHERE ${where} ORDER BY ${ORDER[sort]} LIMIT $5::int OFFSET $6::int`, ...values, limit, offset),
      one<{ total: number }>(`SELECT count(*)::int AS total FROM ${PAGE} p WHERE ${where}`, ...values),
    ]);
    return { items: found.map(row => ({ ...listing(row), content: row.content })), total: count?.total ?? 0 };
  };

  /** How many pages each tag path holds, back office and the home page left out: a category tree's counts. */
  const counts = () =>
    rows<{ tagPath: string; pages: number }>(
      `SELECT "tagPath", count(*)::int AS pages FROM ${PAGE} p
        WHERE "siteId" = $1 AND NOT ("tagPath" = '' AND slug = '') AND NOT ${hiddenSql('$2')}
        GROUP BY "tagPath" ORDER BY "tagPath"`,
      site, hidden,
    );

  const stats = async () => {
    const row = await one<{ pages: number; updated: Date | null }>(`SELECT count(*)::int AS pages, max("updatedAt") AS updated FROM ${PAGE} WHERE "siteId" = $1`, site);
    return { pages: row?.pages ?? 0, updated: row?.updated ?? null };
  };

  /**
   * Ranked search over titles and prose, in four tiers:
   *
   *   0  title starts with the term
   *   1  title contains it
   *   2  prose contains it, literally
   *   3  full-text match on `search_tsv`: stems, stopwords dropped, ranked
   *
   * The literal tiers keep identifiers, tickers and version strings working,
   * which the english dictionary folds or splits; tier 3 is reached only by a
   * query they could not answer, so it adds recall without displacing anything.
   * Hidden paths are left out unless `tagPath` names one: a maintenance log
   * quotes every edit and would head every body match. The home
   * page is never a result. A tier-3 row's snippet is Postgres' own headline,
   * because a stem match has no literal substring to window on.
   */
  const search = async (
    query: string,
    { tagPath = null, skip = 0, take = 25, content: withContent = false }: { tagPath?: string | null; skip?: number; take?: number; content?: boolean } = {},
  ) => {
    const term = escapeLikeTerm(query);
    if (!term) return { items: [] as (WikiPageListing & { score: number; content?: B[] })[], total: 0 };
    const prose = proseSql('p.content');
    const found = await rows<WikiPageRow & { tier: number; total: number; headline: string | null }>(
      `WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq),
       matched AS (
         SELECT p.*, q.tsq,
                CASE WHEN p.title ILIKE $2 THEN 0
                     WHEN p.title ILIKE $3 THEN 1
                     WHEN NOT ${hiddenSql('$4')} AND ${prose} ILIKE $3 THEN 2
                     ELSE 3 END AS tier,
                ts_rank_cd(p.search_tsv, q.tsq, ${FTS_RANK_NORMALIZATION}) AS fts
           FROM ${PAGE} p CROSS JOIN q
          WHERE p."siteId" = $5 AND NOT (p."tagPath" = '' AND p.slug = '')
            AND ($6::text IS NOT NULL OR NOT ${hiddenSql('$4')})
            AND ($6::text IS NULL OR p."tagPath" = $6)
            AND (p.title ILIKE $3
                 OR (NOT ${hiddenSql('$4')}
                     AND (${prose} ILIKE $3 OR (q.tsq IS NOT NULL AND p.search_tsv @@ q.tsq))))
       ),
       paged AS (
         SELECT * FROM matched
          ORDER BY tier, CASE WHEN tier = 0 THEN title END, CASE WHEN tier = 3 THEN fts END DESC, "updatedAt" DESC
          LIMIT $7::int OFFSET $8::int
       )
       -- The count is joined to the page rather than windowed over it, so a
       -- page past the end still carries the total, on one row of nulls.
       SELECT ${COLUMNS}, tier, total,
              CASE WHEN tier = 3 THEN ts_headline('english', ${proseSql()}, tsq, '${HEADLINE_OPTIONS}') END AS headline
         FROM (SELECT count(*)::int AS total FROM matched) t LEFT JOIN paged ON true
        ORDER BY tier, CASE WHEN tier = 0 THEN title END, CASE WHEN tier = 3 THEN fts END DESC, "updatedAt" DESC`,
      query.trim(), `${term}%`, `%${term}%`, hidden, site, tagPath, take, skip,
    );
    const items = found.filter(hit => hit.id !== null).map(({ tier, total: _, headline, content, ...row }) => ({
      ...row,
      ...(withContent ? { content: content as B[] } : {}),
      score: tier,
      snippet: (headline ? decodeEntities(headline).replace(/\s+/g, ' ').trim() : '')
        || matchSnippet(content, query, () => opening({ content: content as B[], metadata: row.metadata })),
    }));
    return { items, total: found[0]?.total ?? 0 };
  };

  /** A revision query's guard: `$1`, its page, is this site's. Another site's page id finds nothing. */
  const OWN_PAGE = `"pageId" IN (SELECT id FROM ${PAGE} WHERE id = $1 AND "siteId" = $2)`;

  /**
   * A page's revisions, newest first, each with what changed against the one
   * before it. `limit` counts what is returned; one more is read so the oldest
   * shown is diffed against its real predecessor, not against nothing.
   */
  const history = async (pageId: string, { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {}) => {
    const revisions = await rows<WikiRevisionRow<B>>(
      `SELECT ${REVISION_COLUMNS} FROM ${REVISION} WHERE "pageId" = $1 AND ${OWN_PAGE} ORDER BY "createdAt" DESC, id DESC LIMIT $3::int OFFSET $4::int`,
      pageId, site, limit + 1, offset,
    );
    const entries = withChanges(revisions, { containers: o.containers }) as WikiRevisionEntry[];
    return revisions.length > limit ? entries.slice(0, limit) : entries;
  };

  const revision = (pageId: string, revisionId: string) =>
    one<WikiRevisionRow<B>>(`SELECT ${REVISION_COLUMNS} FROM ${REVISION} WHERE "pageId" = $1 AND ${OWN_PAGE} AND id = $3`, pageId, site, revisionId);

  const create = async (input: SaveInput<B>): Promise<SaveResult<B>> => {
    if (input.title === undefined || input.content === undefined) throw new HttpError(400, 'A new page needs a title and content');
    const page = await one<WikiPageRow<B>>(
      `WITH up AS (
         INSERT INTO ${PAGE} ("siteId", "tagPath", slug, title, content, metadata, version, "authorId", "lastVerifiedAt")
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, CASE WHEN $9::boolean THEN now() END)
         ON CONFLICT ("siteId", "tagPath", slug) DO NOTHING
         RETURNING ${COLUMNS}
       ), rev AS (
         INSERT INTO ${REVISION} ("pageId", title, content, version, "changeType", message, "authorId")
         SELECT id, title, content, version, 'major', $10::text, "authorId" FROM up
       )
       SELECT * FROM up`,
      site, input.tagPath, input.slug, input.title, JSON.stringify(input.content), JSON.stringify(input.metadata ?? {}),
      INITIAL_VERSION, input.authorId ?? null, input.verified === true, input.message ?? 'Initial version',
    );
    if (!page) throw conflict('A page at that path was created while this one was being written');
    return { page, created: true, changeType: 'major', summary: 'page created' };
  };

  /**
   * Create or update a page, writing a revision whenever its title or blocks
   * changed. The bump is the diff's (`major` for structure, `minor` for prose)
   * unless `change` overrides it; a metadata-only save with no `change` moves no
   * version and writes no revision, the way an infobox fix has always behaved.
   */
  const save = async (input: SaveInput<B>): Promise<SaveResult<B>> => {
    const existing = await get(input.tagPath, input.slug);
    if (!existing && input.baseVersion !== undefined) {
      throw conflict(`This page was deleted since it was opened at v${input.baseVersion}. Saving now would create it again; reload to decide.`);
    }
    if (!existing) return create(input);
    if (input.baseVersion !== undefined && input.baseVersion !== existing.version) {
      throw conflict(`This page changed since it was opened: it is at v${existing.version} now, not v${input.baseVersion}. Reload it and apply the edit again.`);
    }
    const slug = input.newSlug && input.newSlug !== existing.slug ? input.newSlug : existing.slug;
    const slugTaken = async () => slug !== existing.slug && (await get(existing.tagPath, slug)) !== null;
    if (await slugTaken()) throw conflict(SLUG_TAKEN);

    const title = input.title ?? existing.title;
    const content = input.content ?? existing.content;
    const diff = computeRevisionDiff<B>({
      currentVersion: existing.version,
      oldContent: existing.content,
      newContent: content,
      oldTitle: existing.title,
      newTitle: title,
      containers: o.containers,
    });
    const changeType: ChangeType = input.change ?? diff.changeType;
    const version = changeType === 'none' ? existing.version : bump(existing.version, changeType);

    const page = await one<WikiPageRow<B>>(
      `WITH up AS (
         UPDATE ${PAGE} SET title = $3, slug = $4, content = $5::jsonb, metadata = COALESCE($6::jsonb, metadata),
                version = $7, "updatedAt" = now(),
                "lastVerifiedAt" = CASE WHEN $8::boolean THEN now() ELSE "lastVerifiedAt" END
          WHERE id = $1 AND version = $2
          RETURNING ${COLUMNS}
       ), rev AS (
         INSERT INTO ${REVISION} ("pageId", title, content, version, "changeType", message, "authorId")
         SELECT id, title, content, version, $9::text, $10::text, $11::text FROM up WHERE $9::text <> 'none'
       )
       SELECT * FROM up`,
      existing.id, existing.version, title, slug, JSON.stringify(content),
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
      version, input.verified === true, changeType, input.message ?? diff.summary, input.authorId ?? null,
    ).catch(async err => {
      // A page that took the slug after the check above fails the unique index.
      // Asked again rather than read off the error, whose shape is the driver's.
      if (await slugTaken()) throw conflict(SLUG_TAKEN);
      throw err;
    });
    if (!page) throw conflict('This page was saved by someone else while this edit was being written. Reload it and apply the edit again.');
    return { page, created: false, changeType, summary: diff.summary };
  };

  /** Put a page back as a revision had it, as a major change of its own. */
  const restore = async (tagPath: string, slug: string, revisionId: string, by: { authorId?: string | null } = {}) => {
    const page = await get(tagPath, slug);
    if (!page) throw new HttpError(404, 'Page not found');
    const rev = await revision(page.id, revisionId);
    if (!rev) throw new HttpError(404, 'Revision not found');
    return save({
      tagPath, slug, title: rev.title, content: rev.content, authorId: by.authorId,
      change: 'major', message: `Restored to v${rev.version}`, baseVersion: page.version,
    });
  };

  /** Deletes a page and its history. True when there was one to delete. */
  const remove = async (tagPath: string, slug: string) =>
    (await rows<{ id: string }>(`DELETE FROM ${PAGE} WHERE "siteId" = $1 AND "tagPath" = $2 AND slug = $3 RETURNING id`, site, tagPath, slug)).length > 0;

  /** Stamps a page's facts as checked without editing it. */
  const verify = async (tagPath: string, slug: string) =>
    (await rows<{ id: string }>(`UPDATE ${PAGE} SET "lastVerifiedAt" = now() WHERE "siteId" = $1 AND "tagPath" = $2 AND slug = $3 RETURNING id`, site, tagPath, slug)).length > 0;

  return {
    siteId: site, hidden, isHidden,
    get, getById, list, articles, subtree, recent, byIds, refs, corpus, branch, counts, stats, search,
    history, revision, save, restore, remove, verify,
  };
}

export type WikiStore<B extends DiffBlock = DiffBlock> = ReturnType<typeof wikiStore<B>>;
