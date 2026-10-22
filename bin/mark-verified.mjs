#!/usr/bin/env node
// bin/mark-verified.mjs – stamp lastVerifiedAt on pages a sweep has checked
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
//   --site <siteId>             the wiki the pages belong to, default "" (a one-wiki app)
//   --invalidate <tag>          `vercel cache invalidate --tag` after a write
import { arg, connect, invalidate } from './_cli.mjs';

const args = process.argv.slice(2);
const all = args.includes('--all');
const [tagPath, slug] = args.filter((a, i) => !a.startsWith('--') && !['--site', '--invalidate'].includes(args[i - 1]));

if (!tagPath || (!all && slug === undefined)) {
  console.error('usage: mark-verified <tagPath> <slug> | --all <tagPath>  [--site id] [--invalidate tag]');
  process.exit(2);
}
const site = arg('--site') ?? '';

let client;
try {
  client = await connect();
  const { rowCount } = all
    ? await client.query(
        // starts_with, not LIKE: a `_` or `%` in the path would match other branches.
        `UPDATE "WikiPage" SET "lastVerifiedAt" = now() WHERE "siteId" = $3 AND ("tagPath" = $1 OR starts_with("tagPath", $2))`,
        [tagPath, `${tagPath}/`, site],
      )
    : await client.query(
        `UPDATE "WikiPage" SET "lastVerifiedAt" = now() WHERE "siteId" = $3 AND "tagPath" = $1 AND slug = $2`,
        [tagPath, slug, site],
      );
  console.log(`Stamped lastVerifiedAt on ${rowCount} page(s).`);
  const tag = arg('--invalidate');
  if (rowCount && tag) await invalidate(tag);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
