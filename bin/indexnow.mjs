#!/usr/bin/env node
// bin/indexnow.mjs – post an origin's recently changed sitemap rows to IndexNow
// (`wiki-formant/indexnow`). Run from the app's root: the key is the one file in
// `public/` whose name is its own content plus `.txt`. The live copy is checked
// before anything is posted, since an engine refuses every URL until it can
// fetch the key.
//
//   npx indexnow https://radix.wiki              # rows modified in the last 24 hours
//   npx indexnow https://radix.wiki --hours 6
//   npx indexnow https://radix.wiki --all        # every row: a new origin or a new key
import { readdirSync, readFileSync } from 'node:fs';
import { sitemapEntries, changedUrls, submitIndexNow } from '../dist/indexnow.js';

const args = process.argv.slice(2);
const origin = args.find(a => /^https?:\/\//.test(a))?.replace(/\/$/, '');
const hours = Number(args.includes('--hours') ? args[args.indexOf('--hours') + 1] : 24);

if (!origin || !(hours > 0)) {
  console.error('usage: indexnow <origin> [--hours n | --all]');
  process.exit(1);
}

let files = [];
try {
  files = readdirSync('public');
} catch {
  // reported below
}
const key = files
  .map(f => /^([A-Za-z0-9-]{8,128})\.txt$/.exec(f)?.[1])
  .find(k => k && readFileSync(`public/${k}.txt`, 'utf8').trim() === k);
if (!key) {
  console.error('no IndexNow key in ./public: a <key>.txt holding the key');
  process.exit(1);
}

const live = await fetch(`${origin}/${key}.txt`).then(r => (r.ok ? r.text() : ''));
if (live.trim() !== key) {
  console.error(`${origin}/${key}.txt does not serve the key yet; deploy first`);
  process.exit(1);
}

const sitemap = await fetch(`${origin}/sitemap.xml`);
if (!sitemap.ok) {
  console.error(`${origin}/sitemap.xml answered ${sitemap.status}`);
  process.exit(1);
}
const entries = sitemapEntries(await sitemap.text());
const urls = args.includes('--all') ? entries.map(e => e.url) : changedUrls(entries, Date.now() - hours * 3_600_000);
const statuses = await submitIndexNow(key, urls);
console.log(JSON.stringify({ origin, submitted: urls.length, statuses }));
if (!statuses.every(s => s === 200 || s === 202)) process.exit(1);
