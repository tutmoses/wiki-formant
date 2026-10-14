// db.ts — the pool settings every app here hands to `pg`, and the config its prisma.config.ts hands the Prisma CLI.
//
// Four Prisma client modules carried the same block, comment and all. It is a
// value, not a client: the app still owns `new pg.Pool(...)`, the adapter and
// the globalThis cache, so this imports nothing.

/** The options `new pg.Pool()` takes, for the fields set here. */
export interface PgPoolConfig {
  connectionString: string | undefined;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

/**
 * Pool options sized by which Supabase pooler the URL names, because the
 * ceiling belongs to the pooler and not to the app. Port 6543 is the
 * TRANSACTION pooler, which exists to hold many short-lived clients; anything
 * else is treated as the SESSION pooler on 5432, capped at 15 clients per
 * project and shared with a build's workers, so three each is what fits.
 *
 * `pg` reports an exhausted pool as "timeout exceeded when trying to connect",
 * which reads as a network fault and is not one: connecting takes well under a
 * second, while an acquire queued behind busy clients waits the full
 * `connectionTimeoutMillis`. `max: 1` was serial, and three everywhere rendered
 * a page that fans out more than three queries in thirty seconds.
 */
export function pgPoolConfig(url: string | undefined): PgPoolConfig {
  return {
    connectionString: url,
    max: (url ?? '').includes(':6543') ? 10 : 3,
    idleTimeoutMillis: 20_000,
    // The acquire timeout, despite the message it fails with.
    connectionTimeoutMillis: 30_000,
  };
}

/**
 * What every app's prisma.config.ts hands `defineConfig`, from the folder the
 * file sits in: `defineConfig(prismaConfig(import.meta.dirname))`. Four apps
 * carried the file, three of them byte for byte.
 *
 * Read only by the Prisma CLI, never by the app, so the URL prefers DIRECT_URL:
 * every CLI operation that connects (db push, migrate diff, studio) needs a
 * session connection, and Supabase's transaction pooler on 6543, which
 * DATABASE_URL names, hangs on them rather than failing. A placeholder stands
 * in where neither is set, as on a Vercel build: `prisma generate` reads the
 * schema and never connects, and anything that does connect fails loudly.
 *
 * `schema` is a folder of .prisma files (`prisma-models` writes beside the
 * app's own) or a single file. Paths resolve against `root`, so the CLI works
 * from a subdirectory.
 */
export function prismaConfig(root: string, schema = 'prisma/schema') {
  try {
    process.loadEnvFile(`${root}/.env`);
  } catch {
    // A Vercel build has no .env and needs none.
  }
  return {
    schema: `${root}/${schema}`,
    migrations: { path: `${root}/prisma/migrations` },
    datasource: {
      url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
    },
  };
}
