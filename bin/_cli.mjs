// bin/_cli.mjs – what the bins share: reading a flag, and a client on the app's
// database. Five bins had each written the `.env` fallback and the `pg.Client`
// setup, and four the flag reader.

const argv = process.argv.slice(2);

/** The value after `name`, or undefined. */
export const arg = name => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** Every value after each `name`, for a flag given more than once. */
export const all = name => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));

/**
 * A connected `pg.Client` on DATABASE_URL, read from the environment first and
 * `./.env` second, so a bin runs from the app's root, where `pg` is installed.
 * `direct` prefers DIRECT_URL and moves DATABASE_URL from the transaction
 * pooler on 6543 to the session one on 5432: DDL hangs on the first. Throws
 * when no URL is set.
 */
export async function connect({ direct = false, ...options } = {}) {
  const url = () => (direct ? process.env.DIRECT_URL || process.env.DATABASE_URL?.replace(':6543', ':5432').replace(/\?.*$/, '') : process.env.DATABASE_URL);
  if (!url()) {
    try {
      process.loadEnvFile('.env');
    } catch {
      // reported below
    }
  }
  const connectionString = url();
  if (!connectionString) throw new Error(`no ${direct ? 'DIRECT_URL or DATABASE_URL' : 'DATABASE_URL'} in the environment or ./.env`);
  // Imported once a URL is known: `pg` is the app's, not this package's.
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString, ...options });
  await client.connect();
  return client;
}

export { invalidate } from '../dist/scripts.js';
