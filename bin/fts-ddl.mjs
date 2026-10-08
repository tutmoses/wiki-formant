#!/usr/bin/env node
// bin/fts-ddl.mjs – (re)build a table's `search_tsv` generated column and its
// GIN index, from the same expression `wiki-formant/search` queries.
//
// Run from the app's root, where `pg` is installed and `.env` holds the
// database URL. Two wikis carried this script with nothing between them but
// the table name.
//
//   npx fts-ddl pages
//   npx fts-ddl wiki_pages
//
// The column is rebuilt every run rather than skipped when it exists: a skip
// is blind to a changed EXPRESSION, and Postgres normalises the stored one, so
// comparing it to the string can only produce false rebuilds. DROP+ADD in one
// transaction means no reader sees the table without it. Run this BEFORE
// declaring the column in schema.prisma, never after:
//
//   1. `prisma db push` drops the column if it is not declared
//      (`Unsupported("tsvector")?`), and drops the index if
//      `@@index([searchTsv], type: Gin)` is not declared either.
//   2. Push must never create the column: Prisma emits a plain
//      `ADD COLUMN search_tsv tsvector` with no generation expression, which
//      stays empty forever and fails silently.
//   3. With both declared, push still wants `ALTER COLUMN "search_tsv" DROP
//      DEFAULT`, and Postgres refuses it (42601, "is a generated column"). That
//      error is the expected outcome, not a problem to fix.
//
// Connection: DIRECT_URL (the session pooler on 5432) when set, else
// DATABASE_URL moved from 6543 to 5432. Both run DDL; the session port is the
// one that never hangs on a long statement.
import pg from 'pg';
import { searchTsvDdl } from '../dist/search.js';

const table = process.argv[2];
if (!table || !/^[a-z_][a-z0-9_]*$/.test(table)) {
  console.error('usage: npx fts-ddl <table>');
  process.exit(1);
}

if (!process.env.DIRECT_URL && !process.env.DATABASE_URL) {
  try {
    process.loadEnvFile('.env');
  } catch {
    // reported below
  }
}
const url = process.env.DIRECT_URL || process.env.DATABASE_URL?.replace(':6543', ':5432');
if (!url) {
  console.error('no DIRECT_URL or DATABASE_URL in the environment or ./.env');
  process.exit(1);
}

// A bad route hangs rather than erroring without a connect timeout.
const client = new pg.Client({
  connectionString: url.replace(/\?.*$/, ''),
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});
await client.connect();
const q = s => client.query(s).then(r => r.rows);
try {
  const ddl = searchTsvDdl(table);
  await q('BEGIN');
  for (const statement of ddl.column) await q(statement);
  await q('COMMIT');
  console.log('rebuilt generated column search_tsv');
  await q(ddl.index);
  console.log('GIN index present');
  console.table(await q(`select column_name, data_type, is_generated from information_schema.columns
    where table_name='${table}' and column_name='search_tsv'`));
  console.table(await q(`select count(*)::int rows, count(*) filter (where search_tsv is null)::int null_tsv from ${table}`));
  console.table(await q(`select pg_size_pretty(pg_relation_size('${table}_search_tsv_idx')) index_size`));
} catch (e) {
  await q('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
