#!/usr/bin/env node
// bin/analytics-digest.mjs – print one site's `digest` (`wiki-formant/analytics`)
// as JSON, for a script that reads traffic from outside the app.
//
// Run from the app's root, where `pg` is installed and `.env` holds
// DATABASE_URL (read from the environment first). The SQL is the package's, so
// a report reads the figures the app's own pages read.
//
//   npx analytics-digest --days 7
//   npx analytics-digest --days 30 --handle radixwiki --siblings caper.network,acuiq.com
//   npx analytics-digest --days 7 --site <id>             # a multi-tenant app's site
//   npx analytics-digest --days 7 --gap "Symptom Miss:term"   # adds to the search gaps
import pg from 'pg';
import { digest, SEARCH_GAPS } from '../dist/analytics.js';

const args = process.argv.slice(2);
const arg = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const all = name => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile('.env');
  } catch {
    // reported below
  }
}
if (!process.env.DATABASE_URL) {
  console.log(JSON.stringify({ error: 'no DATABASE_URL in the environment or ./.env' }));
  process.exit(0);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  const sql = (query, ...values) => client.query(query, values).then(r => r.rows);
  const result = await digest(sql, {
    site: arg('--site') ?? '',
    days: Number(arg('--days') ?? 7),
    handle: arg('--handle'),
    siblings: arg('--siblings')?.split(',').filter(Boolean) ?? [],
    gaps: [
      SEARCH_GAPS,
      ...all('--gap').map(g => {
        const [event, prop] = g.split(':');
        return { event, prop };
      }),
    ],
  });
  console.log(JSON.stringify(result));
} catch (e) {
  console.log(JSON.stringify({ error: e.message }));
} finally {
  await client.end().catch(() => {});
}
