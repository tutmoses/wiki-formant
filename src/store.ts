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
  /** The block tree's containers, for diffs. Defaults to the core model's. */
  containers?: (block: B) => BlockGroup<B>[] | null;
}

export interface SaveInput<B> {
  tagPath: string;
  slug: string;
  title?: string;
  content?: B[];
  /** Replaces the page's metadata whole. Omit to keep it. */
  metadata?: PageMetadata;
  authorId?: string | null;
  message?: string | null;
  /**
   * The version the writer opened. A save that finds the page has moved on is
   * refused with 409 rather than quietly overwriting the edit in between.
   */
  baseVersion?: string;
  /** The bump to record instead of the one the diff picks, for a script that knows. */
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
const INITIAL_VERSION = '1.0.0';

const listing = (row: WikiPageRow): WikiPageListing => {
  const { content, ...rest } = row;
  return { ...rest, snippet: describe(openingText(content)) };
};

const conflict = (message: string) => new HttpError(409, message);

/** Re-order rows to match an id list, dropping ids that no longer resolve. */
export function orderByIds<T extends { id: string }>(rows: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(rows.map(row => [row.id, row]));
  return ids.map(id => byId.get(id)).filter((row): row is T => row !== undefined);
}

export function wikiStore<B extends DiffBlock = DiffBlock>(o: WikiStoreOptions<B>) {
  const site = o.siteId ?? '';
  const hidden = [...(o.hidden ?? [])];
  const rows = async <T>(query: string, ...values: unknown[]) => (await o.sql(query, ...values)) as T[];
  const one = async <T>(query: string, ...values: unknown[]) => (await rows<T>(query, ...values))[0] ?? null;

  const isHidden = (tagPath: string) => hidden.some(h => tagPath === h || tagPath.startsWith(`${h}/`));

  const get = (tagPath: string, slug: string) =>
    one<WikiPageRow<B>>(`SELECT ${COLUMNS} FROM ${PAGE} WHERE "siteId" = $1 AND "tagPath" = $2 AND slug = $3`, site, tagPath, slug);

  const getById = (id: string) =>
    one<WikiPageRow<B>>(`SELECT ${COLUMNS} FROM ${PAGE} WHERE "siteId" = $1 AND id = $2`, site, id);

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

  /** Every page under a category, by title: the card that lists a subcategory's articles. */
  const subtree = (tagPath: string) =>
    rows<WikiPageRef>(
      `SELECT "tagPath", slug, title FROM ${PAGE}
        WHERE "siteId" = $1 AND "tagPath" LIKE $2 AND slug <> '' AND NOT ("tagPath" = ANY($3::text[]))
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
      : rows<WikiPageRow>(`SELECT ${COLUMNS} FROM ${PAGE} WHERE "siteId" = $1 AND NOT ("tagPath" = ANY($2::text[])) ORDER BY "updatedAt" DESC LIMIT $3::int`, site, hidden, limit)
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
    rows<WikiPageRow<B>>(`SELECT ${COLUMNS} FROM ${PAGE} WHERE "siteId" = $1 AND NOT ("tagPath" = ANY($2::text[])) ORDER BY "tagPath", slug`, site, hidden);

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
  const search = async (query: string, { tagPath = null, skip = 0, take = 25 }: { tagPath?: string | null; skip?: number; take?: number } = {}) => {
    const term = escapeLikeTerm(query);
    if (!term) return { items: [] as (WikiPageListing & { score: number })[], total: 0 };
    const prose = proseSql('p.content');
    const found = await rows<WikiPageRow & { tier: number; total: number; headline: string | null }>(
      `WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq),
       matched AS (
         SELECT p.*, q.tsq,
                CASE WHEN p.title ILIKE $2 THEN 0
                     WHEN p.title ILIKE $3 THEN 1
                     WHEN NOT (p."tagPath" = ANY($4::text[])) AND ${prose} ILIKE $3 THEN 2
                     ELSE 3 END AS tier,
                ts_rank_cd(p.search_tsv, q.tsq, ${FTS_RANK_NORMALIZATION}) AS fts
           FROM ${PAGE} p CROSS JOIN q
          WHERE p."siteId" = $5 AND p."tagPath" <> ''
            AND ($6::text IS NOT NULL OR NOT (p."tagPath" = ANY($4::text[])))
            AND ($6::text IS NULL OR p."tagPath" = $6)
            AND (p.title ILIKE $3
                 OR (NOT (p."tagPath" = ANY($4::text[]))
                     AND (${prose} ILIKE $3 OR (q.tsq IS NOT NULL AND p.search_tsv @@ q.tsq))))
       ),
       paged AS (
         SELECT *, count(*) OVER ()::int AS total FROM matched
          ORDER BY tier, CASE WHEN tier = 0 THEN title END, CASE WHEN tier = 3 THEN fts END DESC, "updatedAt" DESC
          LIMIT $7::int OFFSET $8::int
       )
       SELECT ${COLUMNS}, tier, total,
              CASE WHEN tier = 3 THEN ts_headline('english', ${proseSql()}, tsq, '${HEADLINE_OPTIONS}') END AS headline
         FROM paged
        ORDER BY tier, CASE WHEN tier = 0 THEN title END, CASE WHEN tier = 3 THEN fts END DESC, "updatedAt" DESC`,
      query.trim(), `${term}%`, `%${term}%`, hidden, site, tagPath, take, skip,
    );
    const items = found.map(({ tier, total: _, headline, content, ...row }) => ({
      ...row,
      score: tier,
      snippet: (headline ? decodeEntities(headline).trim() : '')
        || matchSnippet(content, query, () => describe(openingText(content))),
    }));
    return { items, total: found[0]?.total ?? 0 };
  };

  /**
   * A page's revisions, newest first, each with what changed against the one
   * before it. `limit` counts what is returned; one more is read so the oldest
   * shown is diffed against its real predecessor, not against nothing.
   */
  const history = async (pageId: string, { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {}) => {
    const revisions = await rows<WikiRevisionRow<B>>(
      `SELECT ${REVISION_COLUMNS} FROM ${REVISION} WHERE "pageId" = $1 ORDER BY "createdAt" DESC, id DESC LIMIT $2::int OFFSET $3::int`,
      pageId, limit + 1, offset,
    );
    const entries = withChanges(revisions, { containers: o.containers }) as WikiRevisionEntry[];
    return revisions.length > limit ? entries.slice(0, limit) : entries;
  };

  const revision = (pageId: string, revisionId: string) =>
    one<WikiRevisionRow<B>>(`SELECT ${REVISION_COLUMNS} FROM ${REVISION} WHERE "pageId" = $1 AND id = $2`, pageId, revisionId);

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
   * unless `change` overrides it; a metadata-only save moves no version and
   * writes no revision, the way an infobox fix has always behaved.
   */
  const save = async (input: SaveInput<B>): Promise<SaveResult<B>> => {
    const existing = await get(input.tagPath, input.slug);
    if (!existing) return create(input);
    if (input.baseVersion !== undefined && input.baseVersion !== existing.version) {
      throw conflict(`This page changed since it was opened: it is at v${existing.version} now, not v${input.baseVersion}. Reload it and apply the edit again.`);
    }
    const slug = input.newSlug && input.newSlug !== existing.slug ? input.newSlug : existing.slug;
    if (slug !== existing.slug && (await get(existing.tagPath, slug))) throw conflict('A page with that slug already exists in this category');

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
    const changeType: ChangeType = diff.changeType === 'none' ? 'none' : (input.change ?? diff.changeType);
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
      version, input.verified === true, changeType, input.message ?? null, input.authorId ?? null,
    );
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
    get, getById, list, subtree, recent, byIds, refs, corpus, stats, search,
    history, revision, save, restore, remove, verify,
  };
}

export type WikiStore<B extends DiffBlock = DiffBlock> = ReturnType<typeof wikiStore<B>>;
