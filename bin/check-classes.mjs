#!/usr/bin/env node
// bin/check-classes.mjs — fail on a className token that styles nothing.
//
// The design-system overhaul in c9ede60 deleted `.wrap`, `.link` and friends from
// globals.css and left their call sites behind. A class that resolves to nothing
// is silent: React renders it, the browser ignores it, and the page is subtly
// wrong (a twelve-card pageList laid out `nowrap` and scrolled the whole document
// sideways; `.hidden-mobile` never hid a column on a phone). Seven such tokens
// were live across 28 sites before anyone counted them, so this counts them.
//
// Method: every class selector the build emits — Tailwind's utilities and
// globals.css's components alike — is the ground truth. Any bare token written in
// a className string literal and absent from that set is dead.
//
// It also counts the inverse fault. CLAUDE.md allows one-off modifiers inline but
// bans compositions: 3+ utilities in one className is a component class that was
// never named, and the same cluster then drifts between its copies. Which tokens
// are utilities is derived, not listed — anything the build emits that globals.css
// does not define is Tailwind's.
//
// And the reverse: a selector globals.css defines that nothing the build ships
// references. The shared blocks and chrome render their markup inside
// wiki-formant while each app styles it, so references are read from the build
// output, which holds this repo's code, the package's components and bundled
// libraries alike. A class renamed in the package surfaces here as its old
// selector going unreferenced. HTML stored in a database is not in the build,
// so a selector only stored content uses is reported too.
//
//   npx check-classes                # exit 1 on any dead token
//   npx check-classes --warn         # report and exit 0
//   npx check-classes --compositions # also fail on 3+ inline utilities
//   npx check-classes --unused       # also fail on unreferenced selectors
//
// Run it from the repo root: `.next` and `src` are resolved against cwd.
//
// Needs a build first (npm run build): without one there is nothing to check
// against, and the script says so and exits 0 rather than failing blind.
import fs from 'node:fs';
import path from 'node:path';

const WARN_ONLY = process.argv.includes('--warn');
const STATIC_DIR = '.next/static';
const SRC_DIR = 'src';

const walk = (dir, ext, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
};

const cssFiles = walk(STATIC_DIR, '.css');
if (!cssFiles.length) {
  console.log('check-classes: no built CSS under .next/static — run `npm run build` first. Skipping.');
  process.exit(0);
}

// Every class selector present in the emitted stylesheets, unescaped.
const emitted = new Set();
for (const f of cssFiles) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/\.((?:\\.|[-\w])+)/g)) {
    emitted.add(m[1].replace(/\\/g, ''));
  }
}

// Classes this project defines itself. Everything else the build emitted is a
// Tailwind utility, which is what makes the composition count derivable rather
// than a maintained prefix list. Read from rule preludes only, so a decimal in a
// value or a class named in a comment is not taken for a selector.
const globalsFile = walk(SRC_DIR, '.css').find(f => f.endsWith('globals.css'));
const named = new Set();
if (globalsFile) {
  const css = fs.readFileSync(globalsFile, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, prelude] of css.matchAll(/([^{};]*)\{/g)) {
    if (prelude.trim().startsWith('@')) continue;
    for (const m of prelude.matchAll(/\.((?:\\.|[-\w])+)/g)) {
      const name = m[1].replace(/\\/g, '');
      if (/^[A-Za-z_-]/.test(name)) named.add(name);
    }
  }
}

// Only bare literals: anything interpolated is beyond a static check.
const dead = new Map();
const compositions = [];
for (const f of walk(SRC_DIR, '.tsx')) {
  fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/className=(?:"([^"]*)"|\{'([^']*)')/g)) {
      const raw = (m[1] ?? m[2] ?? '').split(/\s+/);
      let utilities = 0;
      for (const tok of raw) {
        if (!tok || tok.includes('$') || tok.includes('{')) continue;
        const base = tok.replace(/^[a-z-]+:/, '').replace(/^!/, ''); // strip variant, important
        if (emitted.has(tok) || emitted.has(base)) {
          if (!named.has(base)) utilities++;
          continue;
        }
        if (!dead.has(tok)) dead.set(tok, []);
        dead.get(tok).push(`${f}:${i + 1}`);
      }
      if (utilities >= 3) compositions.push({ at: `${f}:${i + 1}`, n: utilities, s: (m[1] ?? m[2]) });
    }
  });
}

const CHECK_COMPOSITIONS = process.argv.includes('--compositions');
const CHECK_UNUSED = process.argv.includes('--unused');

if (compositions.length) {
  const verb = CHECK_COMPOSITIONS ? 'must be named' : 'should be named (advisory)';
  console.error(`check-classes: ${compositions.length} inline composition(s) of 3+ utilities ${verb}:\n`);
  for (const c of compositions.sort((a, b) => b.n - a.n).slice(0, 20)) {
    console.error(`  ${String(c.n).padStart(2)} utils  ${c.at}  ${c.s.slice(0, 72)}`);
  }
  if (compositions.length > 20) console.error(`  … and ${compositions.length - 20} more`);
  console.error('');
}

// Every token in the JavaScript the build ships, server and client. A selector
// is referenced when its name appears whole, or when a prefix of it ending in `-`
// or `_` does, which is how `editorial-banner-${variant}` is written.
const shipped = new Set();
for (const f of [...walk(STATIC_DIR, '.js'), ...walk('.next/server', '.js')]) {
  for (const [tok] of fs.readFileSync(f, 'utf8').matchAll(/[\w-]+/g)) shipped.add(tok);
}
const referenced = name =>
  shipped.has(name) ||
  [...name].some((c, i) => i >= 3 && (c === '-' || c === '_') && shipped.has(name.slice(0, i + 1)));
const unused = [...named].filter(n => !referenced(n)).sort();

if (unused.length) {
  const verb = CHECK_UNUSED ? 'must be deleted' : 'advisory';
  console.error(`check-classes: ${unused.length} selector(s) in ${globalsFile} referenced by nothing the build ships (${verb}):\n`);
  console.error(`  ${unused.join(', ')}\n`);
  console.error('  Class names inside HTML stored in a database do not count, so check stored content before deleting one.\n');
}

const advisoryFailed = (CHECK_COMPOSITIONS && compositions.length > 0) || (CHECK_UNUSED && unused.length > 0);

if (!dead.size) {
  console.log(`check-classes: clean — every className token resolves against ${emitted.size} emitted selectors.`);
  process.exit(advisoryFailed && !WARN_ONLY ? 1 : 0);
}

console.error(`check-classes: ${dead.size} className token(s) style nothing:\n`);
for (const [tok, at] of [...dead].sort((a, b) => b[1].length - a[1].length)) {
  console.error(`  ${tok.padEnd(24)} ${String(at.length).padStart(3)}x  ${at.slice(0, 4).join(', ')}${at.length > 4 ? ', …' : ''}`);
}
// Derived, not hardcoded: this runs in every sibling project and their
// globals.css does not sit at the same path. Found once, above.
console.error(`\nEither define it in ${globalsFile ?? 'your globals.css'} or delete the usage.`);
process.exit(WARN_ONLY ? 0 : 1);
