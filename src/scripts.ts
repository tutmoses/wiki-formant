// scripts.ts — what a wiki's seed and sweep scripts share: a client on the
// app's database that rolls back on a throw and expires the wiki's cache tag
// after a write, the store over it, the block builders, and the two writes
// every script makes: a revision over a page it read, and an upsert.
//
// radix-wiki's `seed-utils.mjs` and caper's `wiki-utils.ts` had each written
// these, in different languages, with different halves of the same guards.
// Node-only, like the bins: `pg` is the app's, imported when a client is made.

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { wikiStore, type SaveInput, type WikiPageRow, type WikiStore } from './store.js';
import { bump, type ChangeType } from './versioning.js';
import { validateLinkGroups, validateReferenceItems } from './validation.js';
import type { BannerVariant } from './text.js';

export const uid = (): string => randomUUID();
export const content = (text: string) => ({ id: uid(), type: 'content' as const, text });
/** Always pass `text`: the renderer's default message lives in React, and search indexes only what the row holds. */
export const banner = (variant: BannerVariant, text: string) => ({ id: uid(), type: 'banner' as const, variant, text });
/** A facts panel that leads an article: `table` is the inner `<table>` HTML. */
export const infobox = (table: string) => ({ id: uid(), type: 'infobox' as const, blocks: [content(table)] });

/**
 * Refuse block content whose URL-bearing leaves are mis-shaped, before it
 * reaches the database. `LinkGridView` and `ReferencesView` drop an entry whose
 * URL fails `safeLinkHref` rather than rendering it inert, so a one-field slip
 * (`url` for a link, whose shape is `{ label, href }`) shows as a heading with
 * no pills and nothing reports it. Throws, so `withClient` rolls back.
 */
export function assertLinkShapes(blocks: readonly unknown[], where = 'content'): void {
  const bad: string[] = [];
  const leaf = (b: unknown, path: string) => {
    const block = b as Record<string, unknown> | null;
    if (!block || typeof block !== 'object') return;
    if (block.type === 'linkGrid') {
      for (const [gi, g] of ((block.groups as Record<string, unknown>[]) ?? []).entries()) {
        for (const [li, l] of ((g?.links as Record<string, unknown>[]) ?? []).entries()) {
          if (!validateLinkGroups([{ id: '', heading: '', links: [l] }])) {
            bad.push(`${path}.groups[${gi}].links[${li}] "${l?.label ?? '(no label)'}" has fields {${Object.keys(l ?? {}).sort().join(', ')}} -- LinkGridLink is { label, href }`);
          }
        }
      }
    }
    if (block.type === 'references' && !validateReferenceItems(block.items)) bad.push(`${path}.items -- ReferenceItem is { id, text, url? }`);
  };
  blocks.forEach((b, i) => {
    leaf(b, `[${i}]`);
    const block = b as Record<string, unknown> | null;
    if (block?.type === 'infobox') ((block.blocks as unknown[]) ?? []).forEach((n, j) => leaf(n, `[${i}].blocks[${j}]`));
    if (block?.type === 'columns') {
      ((block.columns as Record<string, unknown>[]) ?? []).forEach((c, ci) =>
        ((c?.blocks as unknown[]) ?? []).forEach((n, j) => leaf(n, `[${i}].columns[${ci}].blocks[${j}]`)),
      );
    }
  });
  if (bad.length) throw new Error(`${where}: ${bad.length} mis-shaped link(s)\n  ${bad.join('\n  ')}`);
}

/** `vercel cache invalidate --tag`, reported either way. */
export function invalidate(tag: string, cwd?: string): void {
  try {
    execFileSync('vercel', ['cache', 'invalidate', '--tag', tag, '--yes'], { stdio: 'ignore', ...(cwd ? { cwd } : {}) });
    console.log(`cache: ${tag} tag invalidated`);
  } catch (e) {
    console.warn(`cache: ${tag} tag NOT invalidated (${(e as Error).message}); run \`vercel cache invalidate --tag ${tag}\``);
  }
}

/** The slice of a `pg` client a script uses. */
export interface ScriptClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface WithClientOptions {
  /** The cache tag a write expires. Default `wiki`. */
  tag?: string;
  /** Where the Vercel project is linked. Default the working directory. */
  cwd?: string;
  /** Default `DATABASE_URL`, read from the environment or `./.env`. */
  url?: string;
}

/**
 * Run `fn` against a connected client, then release the client and the pool.
 * A throw rolls back whatever transaction was open and fails the process:
 * every one of these scripts writes to the live database, so a half-applied
 * edit must never be left behind and never look like a success. A run that
 * wrote anything ends by expiring the wiki's cache tag, because a script
 * bypasses the routes that purge the pages they change.
 */
export async function withClient<T>(fn: (client: ScriptClient) => Promise<T>, { tag = 'wiki', cwd, url }: WithClientOptions = {}): Promise<T | undefined> {
  if (!url && !process.env.DATABASE_URL) {
    try {
      process.loadEnvFile('.env');
    } catch {
      // reported below
    }
  }
  const connectionString = url ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('no DATABASE_URL in the environment or ./.env');
  const { default: pg } = (await import('pg' as string)) as { default: { Pool: new (o: object) => { connect(): Promise<PoolClient>; end(): Promise<void> } } };
  type PoolClient = ScriptClient & { release(): void };
  const pool = new pg.Pool({ connectionString, max: 1, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  let wrote = false;
  const query = client.query.bind(client);
  client.query = (text, values) => {
    if (/\b(insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i.test(text)) wrote = true;
    return query(text, values);
  };
  try {
    return await fn(client);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('ERROR:', (e as Error).message);
    process.exitCode = 1;
    return undefined;
  } finally {
    client.release();
    await pool.end();
    if (wrote) invalidate(tag, cwd);
  }
}

type AnyBlock = { id: string; type: string };

/** The app's own store over a script's client, so a script writes exactly what the editor writes. */
export const storeFor = (client: ScriptClient, siteId = ''): WikiStore<AnyBlock> =>
  wikiStore<AnyBlock>({ sql: async (q, ...v) => (await client.query(q, v)).rows, siteId });

/** A page row by path, every column: what `writeRevision` takes. Null when there is none. */
export const readPage = (client: ScriptClient, tagPath: string, slug: string, siteId?: string): Promise<WikiPageRow<AnyBlock> | null> =>
  storeFor(client, siteId).get(tagPath, slug);

export interface RevisionOptions {
  change?: Exclude<ChangeType, 'none'>;
  message?: string | null;
  /** The writer's word that the page's facts were re-checked. */
  verified?: boolean;
  /** Write nothing; return the version the bump would give. */
  dry?: boolean;
  metadata?: Record<string, unknown>;
  authorId?: string | null;
  siteId?: string;
}

/**
 * Write edited blocks back to a page from `readPage` as one revision, through
 * the store: the page and its revision in one statement, the version bumped
 * from the stored one by `change`. The save names the version it read, so an
 * edit landing in between is refused (409) instead of overwritten. Returns the
 * new version.
 */
export async function writeRevision(
  client: ScriptClient,
  page: WikiPageRow<AnyBlock>,
  blocks: AnyBlock[],
  { change = 'minor', message, verified = false, dry = false, metadata, authorId = null, siteId }: RevisionOptions = {},
): Promise<string> {
  if (dry) return bump(page.version, change);
  assertLinkShapes(blocks, page.title);
  const { page: saved } = await storeFor(client, siteId).save({
    tagPath: page.tagPath, slug: page.slug, content: blocks, metadata,
    change, message, verified, authorId, baseVersion: page.version,
  });
  return saved.version;
}

/**
 * Create a page, or replace its title and blocks: a change writes a revision
 * bumped from the page's own version, a re-run that changes nothing writes
 * none, and a stated `change` always records one.
 */
export async function upsertWikiPage(
  client: ScriptClient,
  input: SaveInput<AnyBlock> & { content: AnyBlock[]; siteId?: string },
): Promise<'created' | 'updated'> {
  assertLinkShapes(input.content, `${input.tagPath}/${input.slug}`);
  const { siteId, ...save } = input;
  const { created } = await storeFor(client, siteId).save(save);
  return created ? 'created' : 'updated';
}
