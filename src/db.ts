// db.ts — the pool settings every app here hands to `pg`.
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
