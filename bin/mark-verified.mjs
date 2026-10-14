#!/usr/bin/env node
// bin/mark-verified.mjs – stamp last_verified_at on pages a sweep has checked
// against their sources and found current, so `freshnessBanner`
// (`wiki-formant/freshness`) stops calling them outdated. A page that needed an
// edit gets its revision instead; this is for one that did not.
//
// radix-wiki and caper each carried this script against their own table. Run
// it from the app's root, where `pg` is installed and `.env` holds DATABASE_URL.
//
//   npx mark-verified <tagPath> <slug>          one page ('' is a category hub)
//   npx mark-verified --all <tagPath>           every page at or under a tag path
//
//   --table <table>             default pages
//   --scope <column>[=<value>]  only rows where the column is NULL, or equals the value
//   --invalidate <tag>          `vercel cache invalidate --tag` after a write
import { execFileSync } from 'node:child_process';
import { ident, scopeSql } from '../dist/maintenance.js';

const args = process.argv.slice(2);
const arg = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const all = args.includes('--all');
const [tagPath, slug] = args.filter((a, i) => !a.startsWith('--') && !['--table', '--scope', '--invalidate'].includes(args[i - 1]));

if (!tagPath || (!all && slug === undefined)) {
  console.error('usage: mark-verified <tagPath> <slug> | --all <tagPath>  [--table t] [--scope c[=v]] [--invalidate tag]');
  process.exit(2);
}
const table = ident(arg('--table') ?? 'pages', '--table');
const scope = scopeSql(arg('--scope'), 3);

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile('.env');
  } catch {
    // reported below
  }
}
if (!process.env.DATABASE_URL) {
  console.error('no DATABASE_URL in the environment or ./.env');
  process.exit(1);
}

// Imported once the command is known good: `pg` is the app's, not this package's.
const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  const { rowCount } = all
    ? await client.query(
        `UPDATE ${table} SET last_verified_at = now() WHERE (tag_path = $1 OR tag_path LIKE $2) AND ${scope.sql}`,
        [tagPath, `${tagPath}/%`, ...scope.values],
      )
    : await client.query(
        `UPDATE ${table} SET last_verified_at = now() WHERE tag_path = $1 AND slug = $2 AND ${scope.sql}`,
        [tagPath, slug, ...scope.values],
      );
  console.log(`Stamped last_verified_at on ${rowCount} page(s).`);
  const tag = arg('--invalidate');
  if (rowCount && tag) {
    try {
      execFileSync('vercel', ['cache', 'invalidate', '--tag', tag, '--yes'], { stdio: 'ignore' });
      console.log(`cache: ${tag} tag invalidated`);
    } catch (e) {
      console.warn(`cache: ${tag} tag NOT invalidated (${e.message}); run \`vercel cache invalidate --tag ${tag}\``);
    }
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
