// scripts.ts — what a wiki's direct-database scripts share: the client, the
// store over it, the block builders, the shape check and the revision write.
//
// Node-only. A script bypasses the app's write routes, so it bypasses their
// validation and their cache busting too; both are here so no script can skip
// them. radix-wiki's seed-utils.mjs and caper's wiki-utils.ts had each written
// this half, and each had a piece the other lacked: the shape check, the
// write-tracking pool and the rollback on one side, the upsert that records a
// revision only when something changed on the other.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { BannerVariant } from './text.js';
import { bump, type ChangeType } from './versioning.js';
import { wikiStore, type PageMetadata, type WikiPageRow } from './store.js';
import { validateLinkGroups, validateReferenceItems } from './validation.js';

/** The slice of a `pg` client every helper here takes. Prisma fits it with `$queryRawUnsafe`. */
export interface ScriptClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

type Block = { id: string; type: string };

// ---- block builders ---------------------------------------------------------

export const uid = (): string => randomUUID();
export const content = (html: string) => ({ id: uid(), type: 'content' as const, text: html });
/**
 * A notice. Always pass `text`: the variant's standard message lives in the
 * renderer, not the row, so a banner without it is invisible to search.
 */
export const banner = (variant: BannerVariant, text: string) => ({ id: uid(), type: 'banner' as const, variant, text });
/** A facts panel leading an article: `table` is the inner `<table>` HTML. */
export const infobox = (table: string) => ({ id: uid(), type: 'infobox' as const, blocks: [content(table)] });

// ---- the shape check --------------------------------------------------------

/**
 * Throw on a link-grid link or reference list whose URL fields are mis-shaped.
 *
 * The app's validator rejects these, and scripts never reach it. The views drop
 * an entry whose URL fails rather than rendering it inert, so a `{ label, url }`
 * link (the shape is `{ label, href }`) shows as a heading with no pills and
 * nothing reports it. A throw inside `withClient` is a rollback and a failed run.
 */
export function assertLinkShapes(blocks: unknown, where = 'content'): void {
  const bad: string[] = [];
  const leaf = (b: Record<string, any> | null | undefined, path: string): void => {
    if (!b || typeof b !== 'object') return;
    if (b.type === 'linkGrid')
      for (const [gi, g] of ((b.groups as any[]) ?? []).entries())
        for (const [li, l] of ((g?.links as any[]) ?? []).entries())
          if (!validateLinkGroups([{ id: '', heading: '', links: [l] }]))
            bad.push(`${path}.groups[${gi}].links[${li}] "${l?.label ?? '(no label)'}" has fields {${Object.keys(l ?? {}).sort().join(', ')}} -- LinkGridLink is { label, href }`);
    if (b.type === 'references' && !validateReferenceItems(b.items)) bad.push(`${path}.items -- ReferenceItem is { id, text, url? }`);
  };
  ((Array.isArray(blocks) ? blocks : []) as Record<string, any>[]).forEach((b, i) => {
    leaf(b, `[${i}]`);
    if (b?.type === 'infobox') ((b.blocks as any[]) ?? []).forEach((n, j) => leaf(n, `[${i}].blocks[${j}]`));
    if (b?.type === 'columns')
      ((b.columns as any[]) ?? []).forEach((c, ci) => ((c?.blocks as any[]) ?? []).forEach((n, j) => leaf(n, `[${i}].columns[${ci}].blocks[${j}]`)));
  });
  if (bad.length) throw new Error(`${where}: ${bad.length} mis-shaped link(s)\n  ${bad.join('\n  ')}`);
}

// ---- the client and the cache -----------------------------------------------

/**
 * Mark everything cached under `tag` stale on the project `cwd` is linked to.
 * A script's write reaches no route that would bust it, and pages hold a day.
 */
export function invalidate(tag: string, cwd = process.cwd()): void {
  try {
    execFileSync('vercel', ['cache', 'invalidate', '--tag', tag, '--yes'], { cwd, stdio: 'ignore' });
    console.log(`cache: ${tag} tag invalidated`);
  } catch (e) {
    console.warn(`cache: ${tag} tag NOT invalidated (${(e as Error).message}); run \`vercel cache invalidate --tag ${tag}\` from ${cwd}`);
  }
}

/**
 * Run `fn` on a connected client, then release it and its pool. A throw rolls
 * back the open transaction and fails the process: every script writes to the
 * live database, and a half-applied edit must never pass for a success. A run
 * that wrote anything ends by invalidating `tag`.
 */
export async function withClient<T>(
  fn: (client: ScriptClient) => Promise<T>,
  { tag = 'wiki', cwd = process.cwd() }: { tag?: string; cwd?: string } = {},
): Promise<T | undefined> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, ssl: { rejectUnauthorized: false } });
  const conn = await pool.connect();
  let wrote = false;
  const client: ScriptClient = {
    query: (text, values) => {
      // Anywhere in the text: the store's writes are data-modifying CTEs.
      if (/\b(insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i.test(text)) wrote = true;
      return conn.query(text, values);
    },
  };
  try {
    return await fn(client);
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {});
    console.error('ERROR:', (e as Error).message);
    process.exitCode = 1;
    return undefined;
  } finally {
    conn.release();
    await pool.end();
    // A run that throws part-way may have committed earlier writes.
    if (wrote) invalidate(tag, cwd);
  }
}

// ---- reads and writes through the app's store ---------------------------------

/** The app's own store over a script's client, so a script writes what the editor writes. */
export const storeFor = (client: ScriptClient, siteId = '') =>
  wikiStore<Block>({ sql: async (q, ...v) => (await client.query(q, v)).rows as never, siteId });

/** A page row by path, every column: what `writeRevision` takes. Null when there is none. */
export const readPage = (client: ScriptClient, tagPath: string, slug: string, siteId = '') => storeFor(client, siteId).get(tagPath, slug);

export interface RevisionOptions {
  /** The bump, and the revision's change type. Default minor. */
  change?: Exclude<ChangeType, 'none'>;
  message?: string;
  /** Stamp `lastVerifiedAt`: the edit re-checked the page's facts. */
  verified?: boolean;
  /** Write nothing; return the version it would have been. */
  dry?: boolean;
  metadata?: PageMetadata;
  authorId?: string | null;
}

/**
 * Write edited blocks back to a page row from `readPage` as one revision. The
 * save names the version it read, so an edit landing in between is refused
 * (409) rather than overwritten. Returns the new version.
 */
export async function writeRevision(
  client: ScriptClient,
  page: Pick<WikiPageRow, 'tagPath' | 'slug' | 'title' | 'version' | 'siteId'>,
  blocks: Block[],
  { change = 'minor', message, verified = false, dry = false, metadata, authorId = null }: RevisionOptions = {},
): Promise<string> {
  if (dry) return bump(page.version, change);
  assertLinkShapes(blocks, page.title);
  const { page: saved } = await storeFor(client, page.siteId).save({
    tagPath: page.tagPath, slug: page.slug, content: blocks, metadata,
    change, message, verified, authorId, baseVersion: page.version,
  });
  return saved.version;
}

/**
 * Create a page or update it in place, keyed by site, tag path and slug. A
 * change to its title or blocks writes a revision; a re-run that changes
 * nothing writes none. `change` records that bump instead of the diff's, and
 * always writes one.
 */
export async function upsertWikiPage(
  client: ScriptClient,
  input: {
    tagPath: string;
    slug: string;
    title: string;
    content: Block[];
    metadata?: PageMetadata;
    message?: string;
    change?: Exclude<ChangeType, 'none'>;
    authorId?: string | null;
    siteId?: string;
  },
): Promise<'created' | 'updated'> {
  const { siteId = '', ...save } = input;
  assertLinkShapes(save.content, `${save.tagPath}/${save.slug}`);
  const { created } = await storeFor(client, siteId).save(save);
  return created ? 'created' : 'updated';
}
