#!/usr/bin/env node
// bin/check-pages.mjs — what a crawler reads on a rendered page, checked over a
// whole site instead of one URL at a time.
//
// Four defects were found by hand across the three wikis in one September 2026
// sweep, and each had been live for months because nothing looked at a rendered
// page as a document. radix.wiki/contents shipped an h1 and no other heading at
// all, its category names drawn as bare links. acuiq.com's home page went h1,
// h2, h4, skipping a level. Twenty-seven radix.wiki titles ran past the point a
// result truncates them, twenty-six of which no audit had counted because the
// crawl that found the first one reached a quarter of the site. caper.network
// served every wiki article with no site name in its title, and one route with
// the title "Wiki" and nothing else.
//
// None of these are visible in source review, and all four are one regex over
// rendered HTML. The rules themselves live in the package next to the things
// they are about — `outlineIssues` beside the heading injector, `TITLE_BUDGET`
// beside `pageMetadata` — so an app can apply them at render time too. This
// only crawls, and reports.
//
//   npx check-pages --site https://radix.wiki        # exit 1 on any fault
//   npx check-pages --site http://localhost:3000     # against a dev server
//   npx check-pages --site … --limit 200             # default 100
//   npx check-pages --site … --warn                  # report and exit 0
//   npx check-pages --site … --json                  # machine-readable
//
// URLs come from /sitemap.xml, so a route the sitemap omits is not checked —
// which is the right default, since an unlisted route is one nobody asked a
// crawler to read.
import { outlineIssues } from '../dist/headings.js';
import { TITLE_BUDGET, TITLE_LIMIT } from '../dist/metadata.js';

const arg = name => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = name => process.argv.includes(name);

const site = (arg('--site') || '').replace(/\/+$/, '');
const limit = Number(arg('--limit') || 100);
const WARN_ONLY = has('--warn');
const JSON_OUT = has('--json');

if (!site) {
  console.error('check-pages: --site <origin> is required, e.g. --site https://radix.wiki');
  process.exit(2);
}

const UA = 'wiki-formant/check-pages';
const get = async url => {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' } });
  return { status: res.status, body: res.ok ? await res.text() : '' };
};

// The sitemap is the URL list, and a sitemap index is one more fetch deep.
async function sitemapUrls(origin) {
  const seen = [];
  const read = async url => {
    const { status, body } = await get(url);
    if (status !== 200) return;
    const locs = [...body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]);
    if (/<sitemapindex/i.test(body)) {
      for (const child of locs.slice(0, 20)) await read(child);
    } else {
      seen.push(...locs);
    }
  };
  await read(`${origin}/sitemap.xml`);
  return seen;
}

const titleOf = html => {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
};
const descriptionOf = html => {
  const m = html.match(/<meta[^>]+name=["']description["'][^>]*>/i);
  return m ? (m[0].match(/content=["']([\s\S]*?)["']/i)?.[1] ?? '').trim() : null;
};
const decode = s =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'");

const urls = await sitemapUrls(site);
if (!urls.length) {
  console.log(`check-pages: no URLs in ${site}/sitemap.xml — nothing to check. Skipping.`);
  process.exit(0);
}

const checked = urls.slice(0, limit);
const faults = [];
const titles = new Map();

for (const url of checked) {
  let page;
  try {
    page = await get(url);
  } catch (e) {
    faults.push({ url, fault: 'unreachable', detail: e.message });
    continue;
  }
  if (page.status !== 200) {
    // A sitemap is a set of promises about what exists; a broken one is the
    // loudest fault here, so it is reported even though it is not about markup.
    faults.push({ url, fault: 'sitemapDead', detail: String(page.status) });
    continue;
  }

  for (const issue of outlineIssues(page.body)) {
    faults.push({
      url,
      fault: issue.fault,
      detail: issue.fault === 'skippedLevel'
        ? `h${issue.after} → h${issue.level} at "${issue.text?.slice(0, 40)}"`
        : issue.text?.slice(0, 40) ?? '',
    });
  }

  const title = decode(titleOf(page.body));
  if (!title) faults.push({ url, fault: 'noTitle', detail: '' });
  else {
    if (title.length > TITLE_LIMIT) faults.push({ url, fault: 'titleTooLong', detail: `${title.length} chars: ${title}` });
    else if (title.length > TITLE_BUDGET) faults.push({ url, fault: 'titleTight', detail: `${title.length} chars: ${title}` });
    const sharing = titles.get(title);
    if (sharing) sharing.push(url);
    else titles.set(title, [url]);
  }

  if (descriptionOf(page.body) === null) faults.push({ url, fault: 'noDescription', detail: '' });
}

// Reported once per title rather than once per page, or a shared title on forty
// routes drowns everything else.
for (const [title, sharing] of titles) {
  if (sharing.length > 1) {
    faults.push({ url: sharing[0], fault: 'duplicateTitle', detail: `${sharing.length} pages share "${title}"` });
  }
}

// Two faults are reported and never set the exit code. `noSubheading`: a page
// that is one h1 and one table — a leaderboard, a token list — has no second
// section to name, and inventing an h2 to satisfy a checker is the noise this
// is supposed to remove; it is still reported, because the same shape on a
// category index meant 190 words of links with no outline at all.
// `titleTight`: between TITLE_BUDGET and TITLE_LIMIT what a result drops is
// usually the site name, which is a judgement rather than a defect.
const ADVISORY = new Set(['noSubheading', 'titleTight']);
const failing = faults.filter(f => !ADVISORY.has(f.fault));

if (JSON_OUT) {
  console.log(JSON.stringify({ site, checked: checked.length, of: urls.length, failing: failing.length, faults }, null, 2));
} else {
  const byFault = new Map();
  for (const f of faults) byFault.set(f.fault, [...(byFault.get(f.fault) ?? []), f]);
  console.log(`check-pages: ${checked.length} of ${urls.length} sitemap URLs on ${site}\n`);
  if (!faults.length) console.log('  clean — one h1 per page, no skipped levels, every title inside the budget.');
  else if (!failing.length) console.log('  no failures; everything below is advisory.\n');
  for (const [fault, list] of [...byFault].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${fault} (${list.length})${ADVISORY.has(fault) ? '  — advisory, does not fail' : ''}`);
    for (const f of list.slice(0, 12)) console.log(`    ${f.url.replace(site, '') || '/'}${f.detail ? `  ${f.detail}` : ''}`);
    if (list.length > 12) console.log(`    … and ${list.length - 12} more`);
    console.log('');
  }
}

process.exit(failing.length && !WARN_ONLY ? 1 : 0);
